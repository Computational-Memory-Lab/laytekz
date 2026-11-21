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
// Galley: V2 console (WP17): node-pty ships unpacked, with only this target's
// prebuild, an executable and validly signed spawn-helper, and it spawns a shell.

import fuses from '@electron/fuses'; // installed with electron-builder
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';
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

// ---- Galley: V2 console (WP17): the console's terminal as packaged ----
{
  const unpacked = path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const prebuild = path.join(unpacked, 'prebuilds', `darwin-${process.arch}`);
  const helper = path.join(prebuild, 'spawn-helper');
  const ptyNode = path.join(prebuild, 'pty.node');
  check(fs.existsSync(ptyNode) && fs.existsSync(helper), 'node-pty is unpacked next to the asar, with this target\'s prebuild');
  check(fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0o111, 'spawn-helper is executable (build/after-pack.cjs)');
  const kept = fs.existsSync(path.join(unpacked, 'prebuilds')) ? fs.readdirSync(path.join(unpacked, 'prebuilds')) : [];
  check(kept.length === 1 && kept[0] === `darwin-${process.arch}`, `only this target's prebuild ships (${kept.join(', ')})`);
  for (const file of [helper, ptyNode]) {
    const verify = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf8' });
    check(verify.status === 0, `codesign --verify --strict ${path.basename(file)} ${verify.status === 0 ? 'passes' : verify.stderr.trim()}`);
  }
  const whole = spawnSync('codesign', ['--verify', '--strict', '--deep', bundle], { encoding: 'utf8' });
  check(whole.status === 0, `codesign --verify --strict --deep on the app ${whole.status === 0 ? 'passes' : whole.stderr.trim()}`);
  // The packaged binary cannot be driven (its inspector fuse is off), so the
  // source Electron runs the packaged app.asar: the console's utility process
  // then loads pty-host.js from the asar and node-pty from app.asar.unpacked,
  // and the kernel checks spawn-helper's signature as it would in the app.
  const asar = path.join(bundle, 'Contents', 'Resources', 'app.asar');
  const consoleProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-packaged-console-'));
  const consoleMock = await startMockServer();
  const env = { ...process.env, LAYTEKZ_TEST_MODE: '1', LAYTEKZ_TEST_USER_DATA: consoleProfile, LAYTEKZ_TEST_SERVER_URL: consoleMock.url };
  delete env.ELECTRON_RUN_AS_NODE;
  let electronApp = null;
  const inConsole = (code) => electronApp.evaluate(async ({ BrowserWindow }, js) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const view of win.contentView.children) {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed() && wc.getURL() === 'laytekz-ui://app/console.html') return wc.executeJavaScript(js);
      }
    }
    return null;
  }, code);
  try {
    electronApp = await electron.launch({ args: [asar], env, executablePath: createRequire(import.meta.url)('electron') });
    await electronApp.firstWindow();
    await until(() => electronApp.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('console-toggle')), 'View → Console');
    await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('console-toggle').click());
    await until(async () => (await inConsole('document.body.dataset.ready')) === '1', 'the console page');
    await inConsole(`(() => {
      const tab = document.querySelector('[data-testid="console-tab"]');
      return window.laytekzConsole.input(tab.dataset.session, 'echo laytekz-$((6*7))\\r');
    })()`);
    const screen = () => inConsole(`document.querySelector('.xterm-rows')?.innerText || ''`);
    const printed = await until(async () => {
      const text = await screen();
      return /laytekz-42|posix_spawnp|could not/i.test(text) ? text : null;
    }, 'the shell to answer', 20_000).catch(() => screen());
    check(/laytekz-42/.test(printed), `the packaged app.asar's console spawns a shell (${/laytekz-42/.test(printed) ? 'echo printed laytekz-42' : JSON.stringify(String(printed).trim().slice(-200))})`);
  } catch (err) {
    check(false, `the packaged app.asar's console spawns a shell: ${err.message}`);
  } finally {
    await electronApp?.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await consoleMock.close();
    fs.rmSync(consoleProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
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
