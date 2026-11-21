// Pure decisions the main process makes about input it does not control: the
// command line, addresses handed to the OS, and downloaded file names; and
// (Galley: V2 desktop shell, WP09) the user-agent token and which keyboard
// chords a menu item may take. No Electron here, so the unit tests can run
// them in plain Node.

import path from 'node:path';

// ------------------------------------------------------------ command line

const OS_ARGUMENTS = [/^-psn_\d+_\d+$/];

/** The arguments after the executable (and, from source, the app path) that look like switches and are not the OS's own. */
export function unexpectedSwitches(argv) {
  return argv.slice(1).filter((arg) => typeof arg === 'string' && arg.startsWith('-') && !OS_ARGUMENTS.some((re) => re.test(arg)));
}

// --------------------------------------------------- addresses for the OS

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The URL as a string when the OS may open it, otherwise null. */
export function externalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
  if (url.protocol !== 'mailto:' && (url.username || url.password)) return null;
  return url.href;
}

// ------------------------------------------------------------- downloads

// Files the OS runs, or follows, on a double click. A LaTeX editor never offers one.
const PROGRAM_EXTENSIONS = new Set([
  'app', 'command', 'tool', 'terminal', 'webloc', 'inetloc', 'fileloc', 'pkg', 'mpkg', 'scpt', 'applescript', 'workflow', 'action', 'jar',
  'exe', 'msi', 'msp', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'hta',
  'lnk', 'url', 'reg', 'msc', 'appref-ms', 'library-ms', 'settingcontent-ms',
]);

export function isProgramFile(name) {
  // Windows drops trailing dots and spaces, so "setup.exe." is setup.exe.
  const ext = path.extname(String(name).replace(/[.\s]+$/, '')).slice(1).toLowerCase();
  return PROGRAM_EXTENSIONS.has(ext);
}

// ------------------------------------------------------------ user agent

/** The token the web app looks for (server apps/web/src/util/desktop.ts DESKTOP_UA_TOKEN). */
export const DESKTOP_UA_TOKEN = 'Laytekz-Desktop';

/**
 * `ua` with " Laytekz-Desktop/<version>" at the end, replacing an earlier
 * token. The token is the whole contract with the web app: the page learns
 * that it runs in the desktop app and which version, and nothing else.
 */
export function withDesktopToken(ua, version) {
  const v = /^[0-9A-Za-z.+-]{1,32}$/.test(String(version)) ? String(version) : '0';
  const rest = String(ua ?? '').replace(new RegExp(`\\s*${DESKTOP_UA_TOKEN}/\\S*`, 'g'), '').trim();
  return `${rest} ${DESKTOP_UA_TOKEN}/${v}`.trim();
}

// ----------------------------------------------------------- accelerators

// Chords the web UI binds or keeps (server apps/web/src/util/shortcuts.ts,
// the editor keymaps, and the V2 table in the plan, section 2.3). 'Mod' is
// Command on macOS and Ctrl elsewhere. The page sees a key first, but a menu
// accelerator on one of these would still run when the page lets the key
// through, so the app never sets one. Mod+, is not here: in the desktop app
// the native Settings… item owns it and the web skips its own handler.
export const WEB_CHORDS = Object.freeze([
  // V1: SHORTCUTS, TAKEN, Typeset's Mod+Enter, Format document, CodeMirror's search and go-to-line
  'Mod+S', 'Mod+Enter', 'Mod+Shift+C', 'Mod+J', 'Mod+K', 'Mod+Shift+F', 'Shift+Alt+F',
  'Mod+F', 'Mod+G', 'Mod+Shift+G', 'Mod+D', 'Mod+B', 'Mod+I', 'Mod+/', 'Mod+[', 'Mod+]',
  'Mod+Shift+K', 'Mod+Alt+G', 'Mod+Shift+M',
  // V2
  'Mod+Shift+E', 'Mod+Shift+X', 'Mod+Shift+Space', 'Alt+Enter', 'Shift+Alt+Enter', 'Mod+Shift+H',
  'Mod+Shift+U', 'Shift+Alt+A', 'Mod+Right', 'Alt+\\', 'Mod+Shift+V', 'Mod+P', 'Shift+F10', 'Tab', 'Escape',
]);

// What the app menu itself uses (menu.js, and the roles' own accelerators),
// so a feature's item cannot take one of them either.
export const APP_MENU_CHORDS = Object.freeze({
  shared: [
    'Mod+,', 'Mod+R', 'Shift+Mod+R', 'Mod+0', 'Mod+Plus', 'Mod+=', 'Mod+-', 'Mod+M', 'Mod+W',
    'Mod+Z', 'Shift+Mod+Z', 'Mod+X', 'Mod+C', 'Mod+V', 'Mod+A',
  ],
  mac: ['Alt+Mod+I', 'Control+Mod+F', 'Mod+H', 'Alt+Mod+H', 'Mod+Q', 'Shift+Alt+Mod+V', 'Mod+`'],
  other: ['Control+Shift+I', 'F11', 'Control+Y', 'Alt+F4'],
});

const MODIFIERS = {
  commandorcontrol: 'mod', cmdorctrl: 'mod', mod: 'mod',
  command: 'cmd', cmd: 'cmd',
  control: 'ctrl', ctrl: 'ctrl',
  alt: 'alt', option: 'alt', altgr: 'altgr',
  shift: 'shift',
  super: 'super', meta: 'super',
};
const KEY_ALIASES = {
  return: 'enter', esc: 'escape', plus: 'plus', arrowright: 'right', arrowleft: 'left', arrowup: 'up', arrowdown: 'down',
  space: 'space', ' ': 'space', minus: '-', '_': '-',
};
const MODIFIER_ORDER = ['ctrl', 'alt', 'altgr', 'shift', 'cmd', 'super'];

/**
 * An Electron accelerator ('Shift+CommandOrControl+F') or a chord from the
 * tables above ('Mod+Shift+F'), as one canonical string for `platform`
 * ('darwin', 'win32', 'linux'): modifiers as a set in a fixed order, then the
 * key. Null when it does not parse.
 */
export function chordKey(accelerator, platform = process.platform) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null;
  const mac = platform === 'darwin';
  // "Mod++" and "Mod+Plus" name the same key; split keeps a trailing "+".
  const text = accelerator.trim();
  const parts = text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
  const keyPart = parts.pop();
  if (!keyPart) return null;
  const mods = new Set();
  for (const raw of parts) {
    const m = MODIFIERS[raw.trim().toLowerCase()];
    if (!m) return null;
    if (m === 'mod') mods.add(mac ? 'cmd' : 'ctrl');
    else if (m === 'super') mods.add(mac ? 'cmd' : 'super');
    else mods.add(m);
  }
  let key = keyPart.trim().toLowerCase();
  if (keyPart === ' ') key = 'space';
  key = KEY_ALIASES[key] ?? key;
  if (key === '+') key = 'plus';
  if (MODIFIERS[key]) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/**
 * Who already owns the accelerator on `platform`: 'the web UI', 'the app
 * menu', or null when it is free for a feature's menu item.
 */
export function acceleratorOwner(accelerator, platform = process.platform) {
  const chord = chordKey(accelerator, platform);
  if (!chord) return null;
  const same = (list) => list.some((c) => chordKey(c, platform) === chord);
  if (same(WEB_CHORDS)) return 'the web UI';
  const app = [...APP_MENU_CHORDS.shared, ...(platform === 'darwin' ? APP_MENU_CHORDS.mac : APP_MENU_CHORDS.other)];
  if (same(app)) return 'the app menu';
  return null;
}
