// Build-wide constants and the test mode.
//
// Test mode (LAYTEKZ_TEST_MODE=1) exists for automated runs. In a packaged
// build it can only hide windows, write shell.openExternal calls to a file
// instead of opening a browser, and move the profile to a throwaway folder
// (which also swaps the OS keychain for Chromium's mock keychain, so the real
// profile and its encrypted cookies are never touched). The overrides that
// change behaviour (server URL, timeouts) are honoured only when running from
// source, where app.isPackaged is false.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_ID = 'com.devon7y.laytekz';
export const DEFAULT_SERVER_URL = 'https://laytekz.devon7y.com';
export const SITE_URL = 'https://laytekz.devon7y.com';
/** Server addresses that moved: settings saved under an old one are carried to the new one at load. */
export const MOVED_SERVERS = { 'https://latex.devon7y.com': 'https://laytekz.devon7y.com' };
/** The project Laytekz is based on (the credit in About, as on the web app's). */
export const UPSTREAM_NAME = 'Aldine';
export const UPSTREAM_URL = 'https://github.com/trahloff/Aldine';
/** The web UI's dark background (theme.css --bg-app), so a load never flashes white. */
export const BACKGROUND = '#1c1c1e';
export const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
/** A new sign-in start within this time of the last one, while it is still waiting, is ignored. */
export const SIGNIN_DEBOUNCE_MS = 10_000;
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60_000;

const env = process.env;
const enabled = env.LAYTEKZ_TEST_MODE === '1';
const fromSource = enabled && !app.isPackaged;

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function testProfileDir() {
  const wanted = env.LAYTEKZ_TEST_USER_DATA;
  if (wanted && path.isAbsolute(wanted)) {
    fs.mkdirSync(wanted, { recursive: true });
    return wanted;
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-test-'));
}

const userData = enabled ? testProfileDir() : null;

export const test = Object.freeze({
  enabled,
  userData,
  recordFile: enabled ? (env.LAYTEKZ_TEST_RECORD && path.isAbsolute(env.LAYTEKZ_TEST_RECORD)
    ? env.LAYTEKZ_TEST_RECORD
    : path.join(userData, 'open-external.jsonl')) : null,
  serverUrl: fromSource ? env.LAYTEKZ_TEST_SERVER_URL || null : null,
  signinTimeoutMs: fromSource ? positiveInt(env.LAYTEKZ_TEST_SIGNIN_TIMEOUT_MS) : null,
  signinDebounceMs: fromSource ? positiveInt(env.LAYTEKZ_TEST_SIGNIN_DEBOUNCE_MS) : null,
  retryBaseMs: fromSource ? positiveInt(env.LAYTEKZ_TEST_RETRY_MS) : null,
  // Galley: V2 desktop shell (WP09): a module whose default export is a list
  // of extra shell features (tests/mocks/_probe-feature.mjs), appended to
  // SHELL_FEATURES so the tests can drive the feature host. From source only.
  shellFeatures: fromSource && env.LAYTEKZ_TEST_SHELL_FEATURES && path.isAbsolute(env.LAYTEKZ_TEST_SHELL_FEATURES)
    ? env.LAYTEKZ_TEST_SHELL_FEATURES : null,
});
