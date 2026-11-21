#!/usr/bin/env node
// Smoke test for the packaged app (npm run pack:mac first; macOS only).
//
// Playwright cannot attach to a packaged build because the
// EnableNodeCliInspectArguments fuse is off, so this launches the binary
// directly in test mode against the mock server. The mock page clicks its own
// sign-in link; the test then plays the system browser and checks, from the
// mock's request log, that the window loaded the server, handed sign-in to
// the browser, exchanged the code, and came back with the session cookie.
// It also checks that the source-only override LAYTEKZ_TEST_SERVER_URL is
// ignored by a packaged build, that every fuse is as electron-builder.yml
// sets it, that the macOS signature carries the hardened runtime, and that a
// command-line switch makes the app exit before its DevTools server starts.

import fuses from '@electron/fuses'; // installed with electron-builder
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browse } from './browser-sim.mjs';
import { startMockServer } from './mock-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.LAYTEKZ_APP,
  path.join(root, 'dist', `mac-${process.arch}`, 'Laytekz.app', 'Contents', 'MacOS', 'Laytekz'),
  path.join(root, 'dist', 'mac', 'Laytekz.app', 'Contents', 'MacOS', 'Laytekz'),
].filter(Boolean);
const binary = candidates.find((p) => fs.existsSync(p));
if (!binary) {
  console.error(`No packaged app found (looked in ${candidates.join(', ')}). Run npm run pack:mac first.`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const checks = [];
const check = (ok, label) => {
  checks.push({ ok: !!ok, label });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

// ---- the binary itself, before any launch ----
const { FuseV1Options, getCurrentFuseWire } = fuses;
const FuseState = { DISABLE: 48, ENABLE: 49 }; // the wire's ASCII '0' and '1'
const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};
const wire = await getCurrentFuseWire(binary);
for (const [name, on] of Object.entries(EXPECTED_FUSES)) {
  check(wire[FuseV1Options[name]] === (on ? FuseState.ENABLE : FuseState.DISABLE), `fuse ${name} is ${on ? 'on' : 'off'}`);
}
const bundle = binary.replace(/\/Contents\/MacOS\/[^/]+$/, '');
// codesign -d prints to stderr.
const signed = spawnSync('codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' });
const signature = `${signed.stdout ?? ''}${signed.stderr ?? ''}`;
check(/flags=0x\w*\([^)]*\bruntime\b[^)]*\)/.test(signature), `the signature has the hardened runtime (${/flags=\S+/.exec(signature)?.[0] ?? 'no flags line'})`);

// ---- a command-line switch: the app exits before the DevTools server exists ----
{
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-packaged-'));
  const env = { ...process.env, LAYTEKZ_TEST_MODE: '1', LAYTEKZ_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, ['--remote-debugging-port=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('still running'); }, 15_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  check(code === 1, `--remote-debugging-port makes the packaged app exit with status 1 (got ${code})`);
  check(!/DevTools listening/.test(out), 'and no DevTools server ever listened');
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const mock = await startMockServer({ autoSignIn: true });
const decoy = await startMockServer();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-packaged-'));
const record = path.join(profile, 'open-external.jsonl');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ serverUrl: mock.url }));

const env = { ...process.env, LAYTEKZ_TEST_MODE: '1', LAYTEKZ_TEST_USER_DATA: profile, LAYTEKZ_TEST_RECORD: record, LAYTEKZ_TEST_SERVER_URL: decoy.url };
// The fuses make these inert in a packaged build; set them to prove it.
env.ELECTRON_RUN_AS_NODE = '1';
env.NODE_OPTIONS = '--require /nonexistent-laytekz-test.js';

console.log(`Launching ${binary}`);
const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

try {
  await until(() => mock.seen((r) => r.path === '/' && r.method === 'GET').length > 0 || exited, 'the window to load the server');
  check(!exited, 'the packaged app starts with ELECTRON_RUN_AS_NODE and NODE_OPTIONS set (fuses ignore them)');
  const home = mock.seen((r) => r.path === '/')[0];
  check(home && /Electron\//.test(home.userAgent), 'the main window loaded the server page from settings.json');
  check(decoy.state.requests.length === 0, 'LAYTEKZ_TEST_SERVER_URL is ignored by a packaged build');

  const startUrl = await until(() => {
    try {
      return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).url)
        .find((u) => u.includes('/api/auth/desktop/start'));
    } catch {
      return null;
    }
  }, 'the sign-in start URL in the openExternal record');
  const params = new URL(startUrl).searchParams;
  check(params.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge')),
    'clicking sign-in recorded a start URL with an S256 challenge (no browser opened)');
  check(mock.seen((r) => r.path.startsWith('/api/auth/oauth/')).length === 0, 'the window never loaded the embedded OAuth route');

  const page = await browse(startUrl);
  check(page.status === 200 && page.text.includes('You are signed in'), 'the loopback listener answered the browser with the signed-in page');
  const exchange = mock.state.exchanges[0];
  check(exchange?.status === 200 && crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url') === params.get('code_challenge'),
    'the exchange carried the verifier matching the challenge');
  await until(() => mock.seen((r) => r.path === '/' && r.sessionCookie).length > 0, 'the window to reload with the session cookie');
  check(true, 'the window reloaded with the session cookie (signed in)');
  check(mock.seen((r) => r.path === '/api/auth/me' && r.sessionCookie).length >= 2, '/api/auth/me sees the session from the app and the page');
} catch (err) {
  check(false, err.message);
  if (output) console.log(`--- app output ---\n${output.slice(-4000)}`);
} finally {
  if (!exited) child.kill('SIGTERM');
  await until(() => exited, 'the app to exit', 10_000).catch(() => child.kill('SIGKILL'));
  await mock.close();
  await decoy.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
