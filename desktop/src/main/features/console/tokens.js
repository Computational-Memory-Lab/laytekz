// The agents' access tokens (V2, WP25). One project-scoped personal access
// token per server and project, minted through the main window's session
// (POST /api/tokens with its cookie, ShellCtx.sessionFetch; no Origin header,
// so the server's origin check treats it as a non-browser client) and named
// "Laytekz agents · <host> · <project>", so it shows on the account's Agent
// access card, where revoking it works.
//
// The token is kept encrypted with Electron's safeStorage (the OS keychain)
// in settings.json (features.console.agentTokens), and only in memory when
// the system offers no encryption. In clear it goes only into an agent
// process's environment (agents.js). Before each launch the session's token
// list is checked, so a token revoked or expired on the server is replaced.
//
// No Electron import: safeStorage and sessionFetch are injected.

import { consentKey } from './agents.js';

const NAME_MAX = 100;

/** The token's name on the Agent access card. */
export function tokenName(serverBase, projectName) {
  let host = 'server';
  try {
    host = new URL(serverBase).host;
  } catch {
    // keep the placeholder
  }
  const name = `Laytekz agents · ${host} · ${String(projectName).replace(/\s+/g, ' ').trim()}`;
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

/**
 * deps = {
 *   settings: ShellCtx.settings,
 *   sessionFetch: ShellCtx.sessionFetch,
 *   safeStorage?: Electron safeStorage (isEncryptionAvailable, encryptString, decryptString),
 *   log?(text): void,
 * }
 */
export function createTokenStore(deps) {
  const log = deps.log ?? ((text) => console.warn(`Laytekz agents: ${text}`));
  /** key → {id, token}: tokens that could not be encrypted, for this run only. */
  const memory = new Map();

  const canEncrypt = () => {
    try {
      return !!deps.safeStorage?.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  function storedAll() {
    const all = deps.settings.get('agentTokens', {});
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  }

  function load(key) {
    if (memory.has(key)) return memory.get(key);
    const rec = storedAll()[key];
    if (!rec || typeof rec.id !== 'string' || typeof rec.enc !== 'string' || !canEncrypt()) return null;
    try {
      const token = deps.safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
      return token ? { id: rec.id, token } : null;
    } catch (err) {
      log(`a stored token could not be decrypted: ${err?.message ?? err}`);
      return null;
    }
  }

  function save(key, rec) {
    if (canEncrypt()) {
      try {
        const enc = deps.safeStorage.encryptString(rec.token).toString('base64');
        deps.settings.set('agentTokens', { ...storedAll(), [key]: { id: rec.id, enc } });
        memory.delete(key);
        return;
      } catch (err) {
        log(`the token could not be encrypted, so it is kept for this run only: ${err?.message ?? err}`);
      }
    }
    memory.set(key, rec);
  }

  function forget(key) {
    memory.delete(key);
    const all = { ...storedAll() };
    if (key in all) {
      delete all[key];
      deps.settings.set('agentTokens', Object.keys(all).length ? all : undefined);
    }
  }

  /** 'live' | 'gone' (revoked or expired) | 'signed-out' | 'unknown' (the list could not be read). */
  async function check(id) {
    try {
      const res = await deps.sessionFetch('/api/tokens', { headers: { accept: 'application/json' } });
      if (res.status === 401) return 'signed-out';
      if (res.status !== 200) return 'unknown';
      const list = await res.json();
      const rec = Array.isArray(list) ? list.find((t) => t && t.id === id) : null;
      if (!rec) return 'gone';
      if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return 'gone';
      return 'live';
    } catch {
      return 'unknown';
    }
  }

  async function mint(serverBase, projectId, projectName) {
    let res;
    try {
      res = await deps.sessionFetch('/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name: tokenName(serverBase, projectName), projectIds: [projectId] }),
      });
    } catch (err) {
      return { error: 'network', message: `Laytekz could not reach the server to create an access token (${err?.message ?? err}).` };
    }
    if (res.status === 401) return { error: 'signed-out' };
    if (res.status === 404) return { error: 'no-accounts', message: 'This server has no accounts, so Laytekz cannot create an access token for an agent.' };
    let body = null;
    try {
      body = await res.json();
    } catch {
      // handled below
    }
    if (res.status !== 200 || typeof body?.token !== 'string' || typeof body?.id !== 'string') {
      const why = typeof body?.error === 'string' ? `: ${body.error}` : ` (HTTP ${res.status})`;
      return { error: 'refused', message: `The server would not create an access token for the agent${why}.` };
    }
    return { id: body.id, token: body.token };
  }

  /**
   * The token for one project: {token} or {error, message?}. Reuses the stored
   * one while the server still lists it; otherwise mints a new one.
   */
  async function tokenFor({ serverBase, projectId, projectName }) {
    const key = consentKey(serverBase, projectId);
    const have = load(key);
    if (have) {
      const state = await check(have.id);
      if (state === 'live' || state === 'unknown') return { token: have.token };
      if (state === 'signed-out') return { error: 'signed-out' };
      forget(key);
    }
    const minted = await mint(serverBase, projectId, projectName);
    if (!minted.token) return minted;
    save(key, minted);
    return { token: minted.token };
  }

  return Object.freeze({ tokenFor, forget: (serverBase, projectId) => forget(consentKey(serverBase, projectId)) });
}
