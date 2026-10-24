// decode-worker.js — a module Worker that owns FrameSources (and so the VideoDecoders) for a
// Player on the main thread. Decoded frames are TRANSFERRED to the main thread as they come out;
// the main thread acknowledges what it consumed so the worker never decodes more than the
// lookahead ahead. The clock, the audio and the drawing stay on the main thread.
import { Clip } from './clip.js';
import { FrameSource } from './frame-source.js';
import { BufferSource, RangeSource } from './loader.js';

const clips = new Map();     // clipId -> Clip
const sources = new Map();   // id -> { fs, gen, outstanding, lookahead, clipId }

class PumpedSource extends FrameSource {
  _onOutput(frame) { super._onOutput(frame); this.onframe?.(); }
}

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function pump(id) {
  const s = sources.get(id);
  if (!s) return;
  while (s.fs.queued > 0 && s.outstanding < s.lookahead) {
    const it = s.fs.shift();
    s.outstanding++;
    post({ type: 'frame', id, gen: s.gen, p: it.p, index: it.index, frame: it.frame, nextP: s.fs.nextP }, [it.frame]);
  }
  if (s.fs.ended && s.fs.queued === 0) post({ type: 'state', id, gen: s.gen, nextP: s.fs.nextP, ended: true });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'open': {
        const src = m.source.kind === 'buffer' ? new BufferSource(m.source.bytes) : new RangeSource(m.source.url, m.source.size, { windowBytes: m.source.windowBytes, budgetBytes: m.source.budgetBytes });
        clips.set(m.clipId, new Clip(m.index, src, { name: m.name, url: m.source.url ?? null }));
        break;
      }
      case 'closeClip': clips.get(m.clipId)?.close(); clips.delete(m.clipId); break;
      case 'create': {
        const clip = clips.get(m.clipId);
        if (!clip) throw new Error(`worker: clip ${m.clipId} is not open`);
        const fs = new PumpedSource(clip, { lookahead: m.lookahead });
        const s = { fs, gen: 0, outstanding: 0, lookahead: m.lookahead, clipId: m.clipId };
        fs.onframe = () => pump(m.id);
        fs.onerror = (err) => post({ type: 'error', id: m.id, gen: s.gen, message: err?.message || String(err) });
        sources.set(m.id, s);
        break;
      }
      case 'start': {
        const s = sources.get(m.id); if (!s) break;
        s.gen = m.gen; s.outstanding = 0;
        s.fs.start(m.opts);
        pump(m.id);
        break;
      }
      case 'consumed': { const s = sources.get(m.id); if (!s) break; s.outstanding = Math.max(0, s.outstanding - m.n); pump(m.id); break; }
      case 'loopResume': { const s = sources.get(m.id); if (!s) break; const pass = s.fs.setLoopResume(m.index); post({ type: 'loopResume', id: m.id, gen: s.gen, token: m.token, pass }); break; }
      case 'close': { const s = sources.get(m.id); if (!s) break; s.fs.close(); sources.delete(m.id); break; }
      default: throw new Error(`worker: unknown message ${m.type}`);
    }
  } catch (err) {
    post({ type: 'error', id: m.id, gen: m.gen ?? -1, message: err?.message || String(err) });
  }
};
