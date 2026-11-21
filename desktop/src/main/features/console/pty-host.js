// The console's pseudo-terminals (V2, WP17). This file runs in its own
// utility process (utilityProcess.fork in console-sessions.js), never in the
// main process: a crash in node-pty's native code ends this process only.
// The runAsNode fuse does not apply to a utility process.
//
// Messages from main (process.parentPort):
//   {t:'spawn', id, file, args, cwd, env, cols, rows}
//   {t:'input', id, data}   {t:'resize', id, cols, rows}   {t:'kill', id}
//   {t:'pause', id}         {t:'resume', id}
// Messages to main:
//   {t:'spawned', id, pid}  {t:'data', id, data}  {t:'exit', id, code, signal}
//   {t:'proc', id, name}    {t:'error', id, message}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
// In a packaged app node-pty is unpacked (electron-builder asarUnpack). On
// Windows load it from app.asar.unpacked itself: its conout worker path only
// understands node_modules.asar. Elsewhere load it through the asar path:
// node-pty turns its spawn-helper path into app.asar.unpacked itself, and
// would double the suffix if it already had it.
const PTY_PATH = path.join(APP_ROOT, 'node_modules', 'node-pty');
const PTY_DIR = process.platform === 'win32' ? PTY_PATH.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked') : PTY_PATH;
const require = createRequire(path.join(APP_ROOT, 'package.json'));

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);

/** node-pty 1.1.0 ships spawn-helper without the execute bit; from source, fix it (a packaged app gets it from build/after-pack.cjs). */
function fixSpawnHelper() {
  if (process.platform === 'win32' || /app\.asar(?=[\\/])/.test(PTY_DIR)) return;
  const helper = path.join(PTY_DIR, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  try {
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755);
  } catch {
    // No prebuild here (a local build of node-pty): nothing to fix.
  }
}

let pty = null;
let loadError = null;
try {
  fixSpawnHelper();
  pty = require(PTY_DIR);
} catch (err) {
  loadError = err;
}

/** id → {term, buf, timer, lastProc} */
const sessions = new Map();
const FLUSH_MS = 6;
const MAX_CHUNK = 64 * 1024;

function flush(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = null;
  if (!s.buf) return;
  const data = s.buf;
  s.buf = '';
  send({ t: 'data', id, data });
  reportProc(id);
}

function reportProc(id) {
  const s = sessions.get(id);
  if (!s) return;
  let name = '';
  try {
    name = s.term.process || '';
  } catch {
    name = '';
  }
  if (name !== s.lastProc) {
    s.lastProc = name;
    send({ t: 'proc', id, name });
  }
}

function spawn(msg) {
  const { id } = msg;
  if (!pty) {
    send({ t: 'error', id, message: `The terminal could not load: ${loadError?.message ?? 'unknown error'}` });
    send({ t: 'exit', id, code: -1, signal: 0 });
    return;
  }
  let term;
  try {
    const opts = {
      name: 'xterm-256color',
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: msg.env,
    };
    if (process.platform === 'win32') {
      opts.useConpty = true;
      opts.useConptyDll = true;
    }
    term = pty.spawn(msg.file, msg.args, opts);
  } catch (err) {
    send({ t: 'error', id, message: `Could not start ${msg.file}: ${err?.message ?? err}` });
    send({ t: 'exit', id, code: -1, signal: 0 });
    return;
  }
  const s = { term, buf: '', timer: null, lastProc: null };
  sessions.set(id, s);
  term.onData((data) => {
    s.buf += data;
    if (s.buf.length >= MAX_CHUNK) flush(id);
    else if (!s.timer) s.timer = setTimeout(() => flush(id), FLUSH_MS);
  });
  term.onExit(({ exitCode, signal }) => {
    flush(id);
    sessions.delete(id);
    send({ t: 'exit', id, code: exitCode, signal: signal ?? 0 });
  });
  send({ t: 'spawned', id, pid: term.pid });
  reportProc(id);
}

// The foreground process changes without output too (a silent `sleep 30`).
setInterval(() => {
  for (const id of sessions.keys()) reportProc(id);
}, 1000).unref?.();

port.on('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'spawn') {
    spawn(msg);
    return;
  }
  const s = sessions.get(msg.id);
  if (!s) return;
  try {
    switch (msg.t) {
      case 'input':
        s.term.write(msg.data);
        break;
      case 'resize':
        s.term.resize(msg.cols, msg.rows);
        break;
      case 'kill':
        s.term.kill();
        break;
      case 'pause':
        s.term.pause();
        break;
      case 'resume':
        s.term.resume();
        break;
      default:
        break;
    }
  } catch (err) {
    send({ t: 'error', id: msg.id, message: String(err?.message ?? err) });
  }
});
