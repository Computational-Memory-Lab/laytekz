// The console's shell, its environment and the settings it reads (V2, WP17).
// Pure functions: no Electron import, so the unit tests run them in plain Node.

import os from 'node:os';
import path from 'node:path';

/** Variables a child shell must never inherit from the app (they change how Electron, Node or Chromium start). */
const DROP_PREFIXES = ['ELECTRON_', 'CHROME_', 'GOOGLE_', 'LAYTEKZ_TEST_'];
const DROP_NAMES = new Set(['NODE_OPTIONS', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID', 'ORIGINAL_XDG_CURRENT_DESKTOP']);

/** The console's settings and their defaults (features.console.* in settings.json). */
export const CONSOLE_DEFAULTS = Object.freeze({
  enabled: true,
  shell: '',
  fontSize: 13,
  scrollback: 5000,
  cursorStyle: 'block',
  panelHeight: 0.38,
  // Galley: V2 (WP25): the ▶ Claude Code and ▶ Codex buttons in the console's bar.
  agents: true,
});

export const PANEL_MIN = 0.2;
export const PANEL_MAX = 0.75;

const CURSOR_STYLES = ['block', 'bar', 'underline'];

/** One setting value, checked; an invalid value gives null (the caller keeps the old one). */
export function checkSetting(key, value) {
  switch (key) {
    case 'enabled':
    case 'agents': // Galley: V2 (WP25)
      return typeof value === 'boolean' ? value : null;
    case 'shell':
      return typeof value === 'string' && value.length <= 400 && !/[\0\r\n]/.test(value) ? value.trim() : null;
    case 'fontSize':
      return Number.isInteger(value) && value >= 8 && value <= 32 ? value : null;
    case 'scrollback':
      return Number.isInteger(value) && value >= 100 && value <= 100_000 ? value : null;
    case 'cursorStyle':
      return CURSOR_STYLES.includes(value) ? value : null;
    case 'panelHeight':
      return typeof value === 'number' && Number.isFinite(value) ? clampPanel(value) : null;
    default:
      return null;
  }
}

export function clampPanel(fraction) {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, fraction));
}

/** Every setting, with stored values that pass checkSetting and defaults for the rest. */
export function readSettings(get) {
  const out = {};
  for (const [key, fallback] of Object.entries(CONSOLE_DEFAULTS)) {
    let stored;
    try {
      stored = get(key);
    } catch {
      stored = undefined;
    }
    const checked = stored === undefined ? null : checkSetting(key, stored);
    out[key] = checked ?? fallback;
  }
  return out;
}

/**
 * The environment for a shell in the console: the app's own minus what would
 * change how a child Electron, Node or Chromium starts, plus a terminal type
 * and a UTF-8 locale (apps started from the Dock on macOS get no LANG).
 */
export function shellEnv(base = process.env, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (DROP_NAMES.has(key) || DROP_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Laytekz';
  if (!env.LANG && process.platform !== 'win32') env.LANG = 'en_US.UTF-8';
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Splits a shell setting ("/bin/zsh -l", or a quoted path with spaces) into
 * file and arguments. Only double quotes group; nothing is expanded.
 */
export function splitCommand(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let any = false;
  for (const ch of String(text)) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (any) parts.push(current);
      current = '';
      any = false;
    } else {
      current += ch;
      any = true;
    }
  }
  if (any) parts.push(current);
  return parts;
}

/**
 * The shell to start: {file, args, name}. With no setting, the user's login
 * shell ($SHELL -l) on macOS and Linux, PowerShell on Windows. `name` is the
 * process name the shell shows while nothing else runs in the foreground.
 */
export function defaultShell({ setting = '', platform = process.platform, env = process.env, exists = () => true } = {}) {
  const custom = splitCommand(setting);
  if (custom.length) {
    const [file, ...args] = custom;
    return { file, args, name: processName(file, platform) };
  }
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows';
    const pwsh = (env.ProgramFiles || 'C:\\Program Files') + '\\PowerShell\\7\\pwsh.exe';
    const file = exists(pwsh) ? pwsh : `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return { file, args: ['-NoLogo'], name: processName(file, platform) };
  }
  let file = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : null;
  if (!file) file = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file, args: ['-l'], name: processName(file, platform) };
}

export function processName(file, platform = process.platform) {
  const base = platform === 'win32' ? path.win32.basename(file) : path.posix.basename(file);
  return base.replace(/^-/, '');
}

export function homeDir() {
  return os.homedir();
}

/**
 * The commands still running in the foreground of the console's shells:
 * a session whose foreground process is not its own shell. Exited sessions
 * do not count. Returns the process names, in tab order.
 */
export function runningCommands(sessions) {
  const out = [];
  for (const s of sessions) {
    if (s.exited || !s.process) continue;
    const proc = processName(String(s.process));
    if (proc && proc !== s.shellName) out.push(proc);
  }
  return out;
}

/** The quit question for runningCommands(), or null when nothing runs. */
export function quitQuestion(commands) {
  if (!commands.length) return null;
  const n = commands.length;
  const names = [...new Set(commands)].join(', ');
  return {
    message: n === 1 ? `A command is still running in the console (${names}).` : `${n} commands are still running in the console (${names}).`,
    detail: n === 1 ? 'Quitting Laytekz stops it.' : 'Quitting Laytekz stops them.',
  };
}

/** Links the terminal may open in the browser: web pages only. */
export function linkAllowed(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}
