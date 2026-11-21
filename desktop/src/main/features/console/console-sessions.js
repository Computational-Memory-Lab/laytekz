// The console's sessions (V2, WP17): one shell per tab, run by the pty host
// (pty-host.js) in a utility process that starts with the first tab. Main
// keeps each tab's recent output, so a page that attaches later (the panel
// popped out, or the window re-created) replays it, and forwards output to
// the one console page that is attached, with flow control: the shell is
// paused while that page is more than HIGH_WATER characters behind.
//
// No Electron import at the top: `fork` (utilityProcess.fork) is injected.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultShell, homeDir, runningCommands, shellEnv } from './shell-env.js';

const PTY_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-host.js');
const REPLAY_LIMIT = 512 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const MAX_SESSIONS = 20;

const clampInt = (v, min, max, fallback) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback);

/**
 * deps = {
 *   fork(modulePath, args, opts): UtilityProcess,
 *   settings(): {shell, ...},          // shell-env.js readSettings
 *   send(channel, ...args): void,      // to the attached console page, if any
 *   log?(text): void,
 * }
 */
export function createSessions(deps) {
  const log = deps.log ?? ((text) => console.warn(`Laytekz console: ${text}`));
  /** id → {id, title, shellName, process, exited, code, replay: string[], replayLen, unacked, paused} */
  const sessions = new Map();
  let host = null;
  let nextId = 1;
  let stopped = false;

  function ensureHost() {
    if (host) return host;
    const child = deps.fork(PTY_HOST, [], { serviceName: 'Laytekz Console', stdio: 'ignore' });
    host = child;
    child.on('message', (msg) => onHostMessage(msg));
    child.on('exit', (code) => {
      if (host !== child) return;
      host = null;
      // Every shell lived in that process: their tabs end.
      for (const s of sessions.values()) {
        if (s.exited) continue;
        s.exited = true;
        s.code = null;
        const note = stopped ? '' : `\r\n[The console stopped unexpectedly (code ${code}). Close this tab and open a new one.]\r\n`;
        if (note) remember(s, note);
        deps.send('console:data', s.id, note);
        deps.send('console:exit', s.id, null);
      }
      if (!stopped) log(`the pty host exited with code ${code}`);
    });
    return child;
  }

  function post(msg) {
    if (!host) return;
    try {
      host.postMessage(msg);
    } catch (err) {
      log(`could not reach the pty host: ${err?.message ?? err}`);
    }
  }

  function remember(s, data) {
    if (!data) return;
    s.replay.push(data);
    s.replayLen += data.length;
    while (s.replayLen > REPLAY_LIMIT && s.replay.length > 1) s.replayLen -= s.replay.shift().length;
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const s = sessions.get(msg.id);
    if (!s) return;
    switch (msg.t) {
      case 'data':
        remember(s, msg.data);
        if (deps.attached()) {
          s.unacked += msg.data.length;
          if (!s.paused && s.unacked > HIGH_WATER) {
            s.paused = true;
            post({ t: 'pause', id: s.id });
          }
        }
        deps.send('console:data', s.id, msg.data);
        break;
      case 'proc':
        s.process = msg.name || null;
        // Galley: V2 (WP25): an agent tab keeps the agent's name.
        s.title = s.spec ? s.spec.title : (s.process ? s.process.replace(/^-/, '') : s.shellName);
        deps.send('console:title', s.id, s.title);
        break;
      case 'exit':
        s.exited = true;
        s.code = msg.code;
        s.process = null;
        {
          // Galley: V2 (WP25): an agent tab says how to start the agent again.
          const note = s.spec?.exitNote
            ? `\r\n[${s.spec.exitNote}]\r\n`
            : `\r\n[Process exited${Number.isInteger(msg.code) ? ` with code ${msg.code}` : ''}. Close the tab, or press Enter to start a new shell in it.]\r\n`;
          remember(s, note);
          deps.send('console:data', s.id, note);
        }
        deps.send('console:exit', s.id, msg.code);
        break;
      case 'error':
        remember(s, `\r\n[${msg.message}]\r\n`);
        deps.send('console:data', s.id, `\r\n[${msg.message}]\r\n`);
        break;
      default:
        break;
    }
  }

  function spawnInto(s, cols, rows) {
    // Galley: V2 (WP25): an agent tab runs its own process (agents.js builds
    // the spec, with the token in its env only); every other tab a shell.
    if (s.spec) {
      s.shellName = '';
      s.title = s.spec.title;
      s.process = null;
      s.exited = false;
      s.code = undefined;
      s.unacked = 0;
      s.paused = false;
      ensureHost();
      post({ t: 'spawn', id: s.id, file: s.spec.file, args: s.spec.args, cwd: s.spec.cwd, env: s.spec.env, cols, rows });
      return;
    }
    const { file, args, name } = defaultShell({ setting: deps.settings().shell });
    s.shellName = name;
    s.title = name;
    s.process = null;
    s.exited = false;
    s.code = undefined;
    s.unacked = 0;
    s.paused = false;
    ensureHost();
    post({ t: 'spawn', id: s.id, file, args, cwd: homeDir(), env: shellEnv(process.env), cols, rows });
  }

  /** A new tab with a new shell. Returns its summary, or null at the tab limit. */
  function create({ cols, rows, spec = null } = {}) {
    if (stopped) return null;
    const live = [...sessions.values()].filter((s) => !s.exited).length;
    if (live >= MAX_SESSIONS) return null;
    const id = `t${nextId++}`;
    // Galley: V2 (WP25): `spec` = {kind, file, args, cwd, env, title, exitNote} for an agent tab.
    const s = { id, title: '', shellName: '', process: null, exited: false, code: undefined, replay: [], replayLen: 0, unacked: 0, paused: false, cols: 80, rows: 24, spec: spec ? Object.freeze({ ...spec }) : null };
    s.cols = clampInt(cols, 2, 1000, 80);
    s.rows = clampInt(rows, 1, 500, 24);
    sessions.set(id, s);
    spawnInto(s, s.cols, s.rows);
    return summary(s);
  }

  /** Starts a new shell in a tab whose process exited. */
  function restart(id) {
    const s = sessions.get(id);
    if (!s || !s.exited || stopped) return false;
    s.replay = [];
    s.replayLen = 0;
    spawnInto(s, s.cols, s.rows);
    return true;
  }

  function summary(s) {
    return { id: s.id, title: s.title || s.shellName, exited: s.exited, kind: s.spec?.kind ?? null }; // Galley: V2 (WP25): kind
  }

  function list() {
    return [...sessions.values()].map(summary);
  }

  /** The output kept for a tab, for a page that attaches now. */
  function replay(id) {
    const s = sessions.get(id);
    return s ? s.replay.join('') : null;
  }

  function input(id, data) {
    const s = sessions.get(id);
    if (!s || s.exited || typeof data !== 'string' || !data) return false;
    post({ t: 'input', id, data: data.slice(0, 1024 * 1024) });
    return true;
  }

  function resize(id, cols, rows) {
    const s = sessions.get(id);
    if (!s) return false;
    s.cols = clampInt(cols, 2, 1000, s.cols);
    s.rows = clampInt(rows, 1, 500, s.rows);
    if (!s.exited) post({ t: 'resize', id, cols: s.cols, rows: s.rows });
    return true;
  }

  function ack(id, chars) {
    const s = sessions.get(id);
    if (!s || !Number.isFinite(chars) || chars <= 0) return;
    s.unacked = Math.max(0, s.unacked - chars);
    if (s.paused && s.unacked < LOW_WATER) {
      s.paused = false;
      post({ t: 'resume', id });
    }
  }

  /** The attached page went away (or a new one attached): nothing is owed any more. */
  function resetFlow() {
    for (const s of sessions.values()) {
      s.unacked = 0;
      if (s.paused) {
        s.paused = false;
        post({ t: 'resume', id: s.id });
      }
    }
  }

  /** Closes a tab, ending its shell. */
  function close(id) {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    if (!s.exited) post({ t: 'kill', id });
    return true;
  }

  /** The commands running in the tabs' foreground (the quit question). */
  function running() {
    return runningCommands([...sessions.values()]);
  }

  /** Ends every shell and the pty host. */
  function stopAll() {
    for (const id of [...sessions.keys()]) close(id);
    if (host) {
      const child = host;
      host = null;
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, 300).unref?.();
    }
  }

  function stop() {
    stopped = true;
    stopAll();
  }

  return Object.freeze({
    create, restart, list, replay, input, resize, ack, resetFlow, close, running, stopAll, stop,
    get count() { return sessions.size; },
    get hostRunning() { return !!host; },
  });
}
