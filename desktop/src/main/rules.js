// Pure decisions the main process makes about input it does not control: the
// command line, addresses handed to the OS, and downloaded file names. No
// Electron here, so the unit tests can run them in plain Node.

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
