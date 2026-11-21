// The local .bib links (V2, WP41, feature 8), without Electron: reading the
// file, watching it, and pushing it to the server's library link 1 s after
// the last change. index.js wires this to the menu, dialogs and the window
// session (ShellCtx.sessionFetch); the tests drive it in plain Node.
//
// A record is one local file linked to one library link of one project on
// one server: {server, projectId, branch, linkId, file, bibFile, hash?,
// pushedAt?}. The list lives in settings.json (features.bibwatch.links), so
// the watched files are kept per server and per project; only the records of
// the server in use are watched, because the window session reaches no other.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEBOUNCE_MS = 1000;
/** The server's limit for a pushed file (WP35: PUT …/content, 20 MB). */
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_LINKS = 50;

const PROJECT_ID_RE = /^[a-z0-9]{4,20}$/;
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

export const recordKey = (r) => `${r.server}|${r.projectId}|${r.linkId}`;

/** A stored record, checked; null when it is not one. */
export function checkRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const { server, projectId, branch, linkId, file, bibFile } = r;
  if (typeof server !== 'string' || !/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(server) || server.endsWith('/')) return null;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (typeof linkId !== 'string' || !LINK_ID_RE.test(linkId)) return null;
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.includes('..')) return null;
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096) return null;
  if (typeof bibFile !== 'string' || !bibFile || bibFile.length > 512) return null;
  const out = { server, projectId, branch, linkId, file, bibFile };
  if (typeof r.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash)) out.hash = r.hash;
  if (typeof r.pushedAt === 'string' && r.pushedAt.length <= 40) out.pushedAt = r.pushedAt;
  return out;
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** {ok: true, content, hash} or {ok: false, error}: the file as UTF-8 text, at most 20 MB. */
export function readBib(file, { readFile = fs.readFileSync, stat = fs.statSync } = {}) {
  let size;
  try {
    size = stat(file).size;
  } catch {
    return { ok: false, error: `${path.basename(file)} is not there any more. Laytekz uploads it again when it comes back.`, missing: true };
  }
  if (size > MAX_BYTES) return { ok: false, error: `${path.basename(file)} is larger than 20 MB, so it cannot be uploaded.` };
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(readFile(file));
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, error: `${path.basename(file)} is not UTF-8 text. Save it as UTF-8 and Laytekz uploads it.` };
    return { ok: false, error: `${path.basename(file)} could not be read.` };
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { ok: true, content, hash: sha256(content) };
}

/**
 * A project file name for a local file: its own name when that is a plain
 * .bib name, else '' (the server then picks one, such as library.bib).
 */
export function projectBibName(file) {
  const base = path.basename(String(file ?? ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.bib$/i.test(base)) return '';
  return base.replace(/\.bib$/i, '.bib');
}

/**
 * Watches one file through its folder (editors often save by writing a new
 * file and renaming it over the old one, which a watch on the file itself
 * loses) and calls onChange once, debounceMs after the last change.
 */
export function watchFile(file, onChange, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const watch = opts.watch ?? fs.watch;
  const onError = opts.onError ?? (() => {});
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer = null;
  let watcher = null;
  let stopped = false;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, debounceMs);
  };
  try {
    watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (stopped) return;
      if (!name || String(name) === base) fire();
    });
    watcher.on?.('error', (err) => onError(err));
  } catch (err) {
    onError(err);
  }
  return {
    get watching() { return !!watcher; },
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
  };
}

/** The sentence for a failed push, from the server's answer. */
export function pushError(status, body) {
  if (status === 0) return 'The server could not be reached. Laytekz tries again at the next change.';
  if (status === 401) return 'Sign in to Laytekz to keep this file in sync.';
  if (status === 403) return typeof body?.error === 'string' ? body.error : 'You can no longer change this project.';
  if (status === 413) return 'The file is larger than 20 MB, so the server refused it.';
  if (typeof body?.error === 'string' && body.error.length < 300) return body.error;
  return `The server answered ${status}.`;
}

/**
 * The set of linked files. deps = {
 *   load(): unknown[], save(records),          // settings.json
 *   push(record, content) → Promise<{status, body}>,   // PUT …/content (status 0: no answer)
 *   remove(record) → Promise<{status, body}>,  // DELETE the library link
 *   server(): string | null,                   // the server in use
 *   changed?(): void,                          // a status or the list changed
 *   watch?, debounceMs?, read?(file), now?()
 * }
 */
export function createBibSync(deps) {
  const read = deps.read ?? ((file) => readBib(file));
  const now = deps.now ?? (() => new Date());
  const changed = () => { try { deps.changed?.(); } catch { /* a listener's problem */ } };
  /** key → {watcher, state: 'idle'|'pushing'|'ok'|'error', error, busy, again} */
  const live = new Map();
  let stopped = false;

  const records = () => {
    const raw = deps.load();
    return (Array.isArray(raw) ? raw : []).map(checkRecord).filter(Boolean);
  };
  const find = (key) => records().find((r) => recordKey(r) === key) ?? null;
  const update = (key, patch) => {
    const list = records();
    const i = list.findIndex((r) => recordKey(r) === key);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    deps.save(list);
    return list[i];
  };

  function status(key, state, error = null) {
    const entry = live.get(key);
    if (!entry) return;
    entry.state = state;
    entry.error = error;
    changed();
  }

  /** Uploads the file if it changed since the last upload (or always, with force). */
  async function pushNow(key, { force = false } = {}) {
    const entry = live.get(key);
    if (!entry || stopped) return { ok: false, error: 'This file is not being watched.' };
    if (entry.busy) {
      entry.again = true;
      entry.force ||= force;
      return entry.busy;
    }
    entry.busy = (async () => {
      let outcome;
      try {
        outcome = await pushOnce(key, force);
      } finally {
        entry.busy = null;
      }
      if (entry.again && live.get(key) === entry && !stopped) {
        const again = entry.force;
        entry.again = false;
        entry.force = false;
        return pushNow(key, { force: again });
      }
      return outcome;
    })();
    return entry.busy;
  }

  async function pushOnce(key, force) {
    const record = find(key);
    if (!record) return { ok: false, error: 'This link is gone.' };
    if (record.server !== deps.server()) {
      // The app switched servers: the link lives on the other one, so a 404 here must not drop it.
      live.get(key)?.watcher?.stop();
      live.delete(key);
      changed();
      return { ok: false, error: 'Watched only while Laytekz is connected to that server.' };
    }
    const file = read(record.file);
    if (!file.ok) {
      status(key, 'error', file.error);
      return { ok: false, error: file.error };
    }
    if (!force && record.hash === file.hash) {
      status(key, 'ok');
      return { ok: true, unchanged: true };
    }
    status(key, 'pushing');
    let answer;
    try {
      answer = await deps.push(record, file.content);
    } catch {
      answer = { status: 0, body: null };
    }
    if (!live.has(key)) return { ok: false, error: 'Unlinked meanwhile.' };
    if (answer.status >= 200 && answer.status < 300) {
      update(key, { hash: file.hash, pushedAt: now().toISOString() });
      status(key, 'ok');
      return { ok: true };
    }
    if (answer.status === 404) {
      // The link was removed in the project (the Libraries panel, or the project is gone): stop watching.
      forget(key);
      return { ok: false, gone: true, error: 'The project no longer has this link, so Laytekz stopped watching the file.' };
    }
    const error = pushError(answer.status, answer.body);
    status(key, 'error', error);
    return { ok: false, error };
  }

  function watchRecord(record) {
    const key = recordKey(record);
    if (live.has(key) || stopped) return;
    const entry = { watcher: null, state: 'idle', error: null, busy: null, again: false, force: false };
    live.set(key, entry);
    entry.watcher = watchFile(record.file, () => { pushNow(key); }, {
      debounceMs: deps.debounceMs,
      watch: deps.watch,
      onError: () => status(key, 'error', 'Laytekz cannot watch the folder this file is in.'),
    });
  }

  function forget(key) {
    live.get(key)?.watcher?.stop();
    live.delete(key);
    deps.save(records().filter((r) => recordKey(r) !== key));
    changed();
  }

  return Object.freeze({
    /**
     * Watches every record of the server in use, and uploads what changed
     * while it was not watched; stops the watches of any other server. Safe
     * to call again (after a server switch).
     */
    start() {
      const server = deps.server();
      for (const r of records()) {
        const key = recordKey(r);
        if (r.server !== server) {
          if (live.has(key)) {
            live.get(key).watcher?.stop();
            live.delete(key);
            changed();
          }
          continue;
        }
        if (live.has(key)) continue;
        watchRecord(r);
        pushNow(key);
      }
    },
    /** A new link: stored, watched, and uploaded at once. */
    add(record) {
      const checked = checkRecord(record);
      if (!checked) throw new TypeError('Not a valid local .bib link.');
      const key = recordKey(checked);
      const list = records().filter((r) => recordKey(r) !== key);
      if (list.length >= MAX_LINKS) throw new Error(`At most ${MAX_LINKS} local files can be linked.`);
      deps.save([...list, checked]);
      watchRecord(checked);
      changed();
      return pushNow(key, { force: true });
    },
    /** Stops watching; removes the link on the server too when it is the server in use. */
    async unlink(key) {
      const record = find(key);
      if (!record) return { ok: false, error: 'This link is gone.' };
      live.get(key)?.watcher?.stop();
      live.delete(key);
      let remote = null;
      if (record.server === deps.server()) {
        try {
          remote = await deps.remove(record);
        } catch {
          remote = { status: 0 };
        }
      }
      deps.save(records().filter((r) => recordKey(r) !== key));
      changed();
      if (remote && (remote.status === 404 || (remote.status >= 200 && remote.status < 300))) return { ok: true };
      return {
        ok: true,
        warning: remote
          ? `Laytekz stopped watching the file, but the project still lists the link (${pushError(remote.status, remote.body)}). Unlink it in the Libraries panel.`
          : `Laytekz stopped watching the file. The link is on ${record.server}; unlink it there in the Libraries panel.`,
      };
    },
    pushNow,
    /** Every record, with its live status, for the settings window. */
    list() {
      return records().map((r) => {
        const entry = live.get(recordKey(r));
        return {
          key: recordKey(r),
          server: r.server,
          projectId: r.projectId,
          branch: r.branch,
          file: r.file,
          name: path.basename(r.file),
          bibFile: r.bibFile,
          pushedAt: r.pushedAt ?? null,
          watching: !!entry,
          state: entry?.state ?? 'idle',
          error: entry?.error ?? null,
        };
      });
    },
    has: (key) => live.has(key),
    stop() {
      stopped = true;
      for (const entry of live.values()) entry.watcher?.stop();
      live.clear();
    },
  });
}
