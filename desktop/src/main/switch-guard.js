// Command-line switches are refused in a packaged build.
//
// Chromium reads its switches from the command line, and some hand the app
// to whoever started it: --remote-debugging-port gives a local process the
// decrypted session cookie and script in the signed-in page, --proxy-server
// with --ignore-certificate-errors puts the session in the middle, and so on.
// The fuses only cover Node's own switches. Nothing the app needs arrives as
// a switch (old macOS adds -psn_<n>_<n> when Finder launches an app), so a
// packaged build that sees one exits before any window, session or DevTools
// server exists. This module is main.js's first import so it runs first.
//
// From source the guard is off (Playwright passes --remote-debugging-port and
// --inspect itself); LAYTEKZ_TEST_SWITCH_GUARD=1 turns it on there for tests.
// That variable can only add the check, never remove it.

import { app } from 'electron';
import { unexpectedSwitches } from './rules.js';

export function guardSwitches(argv = process.argv) {
  const bad = unexpectedSwitches(argv);
  if (!bad.length) return true;
  const names = [...new Set(bad.map((arg) => arg.split('=')[0]))].join(', ');
  console.error(`Laytekz does not accept command-line switches (${names}). Start it without them.`);
  app.exit(1);
  process.exit(1);
  return false;
}

if (app.isPackaged || process.env.LAYTEKZ_TEST_SWITCH_GUARD === '1') guardSwitches();
