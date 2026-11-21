// The configured Laytekz server: URL validation, origin checks and the health probe.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROVIDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Turns what a person typed into a server base URL (origin plus an optional
 * base path, no trailing slash). https is required except on this computer.
 */
export function normalizeServerUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Enter the address of a Laytekz server.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That is not a valid web address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The address must start with https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'The address must not contain a user name or password.' };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: 'Use https:// (plain http:// is allowed only for localhost and 127.0.0.1).' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

export class Server {
  constructor(baseUrl) {
    const url = new URL(baseUrl);
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    this.origin = url.origin;
    this.basePath = url.pathname.replace(/\/+$/, '');
    this.host = url.host;
  }

  url(path) {
    return `${this.base}${path}`;
  }

  /**
   * The path below the base path when `raw` is on this server, else null,
   * with percent-escapes decoded the way the server's router decodes them
   * before matching (so /api/auth/oauth/goo%67le is the sign-in link too).
   * A path that does not decode is not one of the server's.
   */
  localPath(raw) {
    let url;
    try {
      url = raw instanceof URL ? raw : new URL(raw);
    } catch {
      return null;
    }
    if (url.origin !== this.origin) return null;
    let pathname;
    try {
      pathname = url.pathname.split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
    if (!this.basePath) return pathname;
    if (pathname === this.basePath) return '/';
    return pathname.startsWith(`${this.basePath}/`) ? pathname.slice(this.basePath.length) : null;
  }

  owns(raw) {
    return this.localPath(raw) !== null;
  }

  isApi(raw) {
    return this.localPath(raw)?.startsWith('/api/') ?? false;
  }

  /** The server's sign-in routes (<base>/api/auth/...). */
  isAuthApi(raw) {
    return this.localPath(raw)?.startsWith('/api/auth/') ?? false;
  }

  /** "google" for <base>/api/auth/oauth/google (the web UI's sign-in link), else null. */
  signInProvider(raw) {
    const m = /^\/api\/auth\/oauth\/([^/]+)$/.exec(this.localPath(raw) ?? '');
    return m && PROVIDER_RE.test(m[1]) ? m[1] : null;
  }
}

const NETWORK_REASONS = [
  [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/, 'This computer is not connected to the internet.'],
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, "The server's address could not be found."],
  [/ERR_CONNECTION_REFUSED/, 'The server refused the connection. It may be restarting.'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/, 'The connection to the server was interrupted.'],
  [/TIMED_OUT|TimeoutError|aborted due to timeout/i, 'The server took too long to answer.'],
  [/ERR_CERT_|ERR_SSL_|CERT_/, "The server's security certificate is not valid."],
];

export function networkReason(message) {
  const text = String(message ?? '');
  for (const [re, reason] of NETWORK_REASONS) if (re.test(text)) return reason;
  const code = /ERR_[A-Z_]+/.exec(text)?.[0];
  return code ? `The server could not be reached (${code}).` : 'The server could not be reached.';
}

export function httpReason(status) {
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) {
    return `The server is not responding right now (HTTP ${status}).`;
  }
  return `The server answered with an error (HTTP ${status}).`;
}

/** Statuses on a top-level page that mean "the server is down", not "this page has a problem". */
export function isOutageStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

/**
 * GET <base>/api/health and expect {"ok": true}. Never sends cookies.
 * Resolves to {ok: true} or {ok: false, reason}.
 */
export async function checkHealth(ses, baseUrl, timeoutMs = 8000) {
  let res;
  try {
    res = await ses.fetch(`${baseUrl}/api/health`, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: networkReason(err?.message ?? err?.name) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // fall through: not JSON
  }
  if (body?.ok === true) return { ok: true };
  if (typeof body?.error === 'string') {
    return { ok: false, reason: `The server reported a problem: ${body.error.slice(0, 200)}` };
  }
  if (res.status >= 500) return { ok: false, reason: httpReason(res.status) };
  return { ok: false, reason: 'This address does not answer like a Laytekz server (no /api/health).' };
}
