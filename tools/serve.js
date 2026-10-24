#!/usr/bin/env node
// Static server for the demo and the tests. Answers byte ranges (206 / Accept-Ranges), which the
// player's range loader needs, and the right MIME types for the containers it reads.
// WebCodecs needs a secure context: `localhost` counts, a LAN IP over http does not.
//
//   node tools/serve.js [port]                              → http://localhost:8080/demo/
//   node tools/serve.js 8443 --cert cert.pem --key key.pem  → https://<lan-ip>:8443/demo/
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? (opt('--cert') ? 8443 : 8080));
const tls = opt('--cert') ? { cert: readFileSync(opt('--cert')), key: readFileSync(opt('--key')) } : null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav', '.opus': 'audio/ogg', '.png': 'image/png' };

export const handler = (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const headers = { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = tls ? httpsServer(tls, handler) : httpServer(handler);
  server.listen(port, '0.0.0.0', () => {
    const scheme = tls ? 'https' : 'http';
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`${scheme}://localhost:${port}/demo/`);
    for (const ip of ips) console.log(`${scheme}://${ip}:${port}/demo/${tls ? '' : '   (no WebCodecs from other devices over http)'}`);
  });
}
