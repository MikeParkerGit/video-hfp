// node tools/run-page.mjs <demo-path-with-query> [--gpu] [--timeout 60] [--gesture-required]
// Open one demo page in Playwright's chromium headless shell over raw CDP (served from this
// repo on localhost, audio MUTED), wait for `window.__probe.done`, print the object as JSON.
// For the probe pages: demo/bridge-probe.html?file=real.mp4, demo/compat.html, demo/gesture-probe.html --gesture-required
// (--gesture-required keeps Chromium's autoplay policy, so play() on audio before a gesture is refused as in a real page).
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { handler } from './serve.js';

function findHeadlessShell() {
  if (process.env.HEADLESS_SHELL) return process.env.HEADLESS_SHELL;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, `${homedir()}/Library/Caches/ms-playwright`, `${homedir()}/.cache/ms-playwright`, process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/ms-playwright`].filter(Boolean);
  const names = ['chrome-headless-shell', 'headless_shell', 'chrome-headless-shell.exe'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const d of dirs) for (const sub of readdirSync(path.join(root, d))) for (const n of names) { const f = path.join(root, d, sub, n); if (existsSync(f)) return f; }
  }
  throw new Error('no chromium headless shell found: npx playwright install chromium-headless-shell, or set HEADLESS_SHELL');
}
const args = process.argv.slice(2);
const page = args.find((a) => !a.startsWith('--'));
if (!page) { console.error('usage: node tools/run-page.mjs demo/bridge-probe.html?file=real.mp4 [--gpu] [--timeout 60]'); process.exit(2); }
const timeoutS = Number(args[args.indexOf('--timeout') + 1]) || 60;
const GPU = args.includes('--gpu') ? ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] : [];
const AUTOPLAY = args.includes('--gesture-required') ? ['--autoplay-policy=user-gesture-required'] : ['--autoplay-policy=no-user-gesture-required'];
const SANDBOX = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const profile = mkdtempSync(path.join(tmpdir(), 'mvp-page-'));
const chrome = spawn(findHeadlessShell(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', ...AUTOPLAY, '--mute-audio', '--window-size=1200,1400', ...GPU, ...SANDBOX, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
  chrome.on('exit', (c) => reject(new Error(`headless shell exited ${c}\n${buf}`)));
  setTimeout(() => reject(new Error(`no DevTools line\n${buf}`)), 15000);
});
const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text); return m.result?.result?.value; };

let result = null, exit = 0;
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/${page}` });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) { result = await evaluate('JSON.stringify(window.__probe || null)').then((s) => s && JSON.parse(s)); if (result?.done) break; await sleep(250); }
  if (!result?.done) { result = { timeout: true, partial: result, errors }; exit = 1; }
  else if (result.error) exit = 1;
  if (errors.length) result.pageErrors = errors;
  console.log(JSON.stringify(result, null, 1));
} finally {
  ws.close(); chrome.kill();
  await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 5000); });
  for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  server.close();
}
process.exit(exit);
