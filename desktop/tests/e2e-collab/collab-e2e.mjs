#!/usr/bin/env node
// End-to-end proof of Laytekz's three promises, with real software:
//   (a) LaTeX editing with a live PDF,
//   (b) real-time co-editing between two clients,
//   (c) both through the Laytekz desktop app.
//
// It starts a throwaway Laytekz instance on the server from the live code slot and
// the live sandbox (deploy/libexec/smoke-instance.sh --serve: accounts off,
// its own data, its own compiler and token), reaches it through an SSH port
// forward, and drives two copies of the desktop app run from source (test
// mode, hidden windows, separate profiles) with Playwright. Every step's
// result, the timings and screenshots of both windows go to ./evidence.
// Everything it started is torn down at the end. See README.md.
//
//   node tests/e2e-collab/collab-e2e.mjs        (from desktop/)

import { _electron as electron } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, findPage, overlayText } from '../helpers.mjs';
import { startRelay } from './relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..');
const DEPLOY_DIR = path.resolve(APP_DIR, '..', 'deploy');
const EVIDENCE = path.join(HERE, 'evidence');
const env = process.env;
// The server's SSH name: LAYTEKZ_E2E_SSH_HOST, else GALLEY_SSH_HOST from deploy/site.env.
function siteSshHost() {
  try {
    const text = fs.readFileSync(new URL('../../../deploy/site.env', import.meta.url), 'utf8');
    return (/^GALLEY_SSH_HOST=(.+)$/m.exec(text) || [])[1]?.trim() || '';
  } catch { return ''; }
}
const SSH_HOST = env.LAYTEKZ_E2E_SSH_HOST || siteSshHost();
if (!SSH_HOST) { console.error('Set LAYTEKZ_E2E_SSH_HOST, or GALLEY_SSH_HOST in deploy/site.env, to the SSH name of your Laytekz server.'); process.exit(2); }
const REMOTE_APP_PORT = Number(env.LAYTEKZ_E2E_APP_PORT || 3052);
const REMOTE_COMPILER_PORT = Number(env.LAYTEKZ_E2E_COMPILER_PORT || 3053);
const SERVE_SECONDS = Number(env.LAYTEKZ_E2E_SERVE_SECONDS || 2400);
/** Run deploy/libexec/verify-compiler.sh against the throwaway compiler before serving (about a minute). */
const VERIFY_SANDBOX = env.LAYTEKZ_E2E_VERIFY_SANDBOX !== '0';
const KEEP_TMP = env.LAYTEKZ_E2E_KEEP === '1';
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const LIVE_PORTS = new Set([3040, 3041]);

const R = String(1000 + Math.floor(Math.random() * 9000));
const T = {
  aProbe: (i) => `ap${R}n${i}`,
  bProbe: (i) => `bp${R}n${i}`,
  aBoth: ` Ada wrote this line at once with Bob ac${R}z.`,
  bBoth: ` Bob wrote this one at the same time bc${R}z.`,
  pdf: ` The PDF shows this note pd${R}z.`,
  bad: '\\kzbrokenmacro',
  aWhileCut: ` Ada kept typing while Bob was cut ro${R}z.`,
  bWhileCut: ` Bob typed while cut bo${R}z.`,
  aNoLink: ` Ada typed with no link ax${R}z.`,
  bNoLink: ` Bob typed with no link bx${R}z.`,
};
const LINES = {
  intro: 'State the problem',
  conclusion: 'Wrap up and point',
  method: 'Describe your approach',
  results: 'Equations are first-class',
  abstract: 'A one-paragraph summary',
  conclusionHead: '\\section{Conclusion}',
};
const NAMES = { A: { name: 'Ada Lovelace', color: '#e8554d' }, B: { name: 'Bob Baker', color: '#2e933c' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Like sleep, but does not keep the process alive (for timeouts raced against an exit). */
const idleTimeout = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms).unref());
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const count = (hay, needle) => (hay ? hay.split(needle).length - 1 : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function until(fn, { timeout = 15_000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); } catch (err) { last = `error: ${err.message}`; }
    if (last && !(typeof last === 'string' && last.startsWith('error: '))) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${message} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

function run(cmd, args, { input, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input != null) child.stdin.end(input);
  });
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (!LIVE_PORTS.has(port)) return port;
  }
}

async function httpOk(url, ms = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'LaytekzE2E/harness' } });
    return res.ok;
  } catch { return false; }
}

async function freeBytes() {
  const s = await fsp.statfs('/');
  return s.bavail * s.bsize;
}

// ---------------------------------------------------------------- results

const results = { startedAt: new Date().toISOString(), runId: R, steps: [], timings: {}, environment: {}, teardown: {} };
const stepOf = {};

async function step(id, title, fn, { critical = false } = {}) {
  const rec = { id, title, status: 'running', details: {} };
  results.steps.push(rec);
  stepOf[id] = rec;
  const t0 = Date.now();
  log(`STEP ${id}: ${title}`);
  try {
    await fn(rec.details);
    rec.status = 'pass';
  } catch (err) {
    rec.status = 'fail';
    rec.error = String(err?.stack || err).split('\n').slice(0, 6).join('\n');
    log(`  FAIL ${id}: ${rec.error.split('\n')[0]}`);
    await Promise.all(clients.map((c) => shot(c, `${id}-FAILED`).catch(() => {})));
  }
  rec.ms = Date.now() - t0;
  log(`  ${rec.status.toUpperCase()} ${id} (${rec.ms} ms)`);
  await writeResults();
  if (rec.status === 'fail' && critical) throw new Error(`critical step ${id} failed`);
}

async function writeResults() {
  await fsp.mkdir(EVIDENCE, { recursive: true });
  // the Mac's home folder as ~ (the file is evidence that may be shared)
  const text = JSON.stringify(results, null, 2).split(os.homedir()).join('~');
  await fsp.writeFile(path.join(EVIDENCE, 'results.json'), `${text}\n`);
}

// ---------------------------------------------------------------- remote side

const remote = { dir: null, instance: null, instanceLog: [], ready: null, forward: null };
const REMOTE_DIR_RE = /^\/home\/[A-Za-z0-9._-]+\/galley-server\/e2e-collab-[A-Za-z0-9]{6}$/;

async function remoteSetup() {
  // A copy of the LIVE tooling (sandbox, shims, run scripts), with this
  // checkout's smoke-instance.sh (it has --serve), in a folder of its own:
  // nothing live is modified.
  const r = await run('ssh', [SSH_HOST, 'umask 077; d=$(mktemp -d ~/galley-server/e2e-collab-XXXXXX) && cp -a ~/galley-server/bin "$d/bin" && echo "$d"']);
  const dir = r.stdout.trim();
  if (r.code !== 0 || !REMOTE_DIR_RE.test(dir)) throw new Error(`remote setup failed: ${r.stderr || r.stdout}`);
  remote.dir = dir;
  const c = await run('rsync', ['-a', '--chmod=go-rwx', path.join(DEPLOY_DIR, 'libexec', 'smoke-instance.sh'), `${SSH_HOST}:${dir}/bin/libexec/smoke-instance.sh`]);
  if (c.code !== 0) throw new Error(`could not copy smoke-instance.sh: ${c.stderr}`);
  const same = await run('ssh', [SSH_HOST, `cd ~/galley-server && diff -rq bin ${dir}/bin | grep -v 'smoke-instance.sh' | head -n 5; readlink -f aldine`]);
  return { dir, liveCodeSlot: same.stdout.trim().split('\n').pop(), toolingDiffersFromLiveBesidesSmoke: same.stdout.trim().split('\n').slice(0, -1) };
}

function startInstance(publicUrl) {
  const cmd = [
    `GALLEY_BIN=${remote.dir}/bin`,
    `SMOKE_APP_PORT=${REMOTE_APP_PORT}`,
    `SMOKE_COMPILER_PORT=${REMOTE_COMPILER_PORT}`,
    `SMOKE_PUBLIC_URL=${publicUrl}`,
    `${remote.dir}/bin/libexec/smoke-instance.sh`,
    `--serve=${SERVE_SECONDS}`,
    ...(VERIFY_SANDBOX ? ['--verify'] : []),
  ].join(' ');
  const child = spawn('ssh', [SSH_HOST, cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
  remote.instance = child;
  let buf = '';
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      remote.instanceLog.push(line);
      log(`  [instance] ${line}`);
      const m = /^READY app=(\S+) compiler=(\S+) public=(\S+) root=(\S+)/.exec(line);
      if (m) { remote.ready = { app: m[1], compiler: m[2], public: m[3], root: m[4] }; resolve(remote.ready); }
    };
    const feed = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => { remote.instanceExit = code; reject(new Error(`the throwaway instance exited (${code}) before it was ready`)); });
    // unref: a finished run must not wait for this timer to exit
    setTimeout(() => reject(new Error('the throwaway instance did not become ready in 420 s')), 420_000).unref();
  });
}

async function stopInstance() {
  const child = remote.instance;
  if (!child || child.exitCode != null) return remote.instanceExit ?? child?.exitCode ?? null;
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  try { child.stdin.write('stop\n'); child.stdin.end(); } catch {}
  const code = await Promise.race([exited, idleTimeout(90_000, 'timeout')]);
  if (code === 'timeout') { child.kill('SIGTERM'); return 'killed after 90 s'; }
  return code;
}

function startForward(localPort) {
  const child = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${REMOTE_APP_PORT}`, SSH_HOST], { stdio: ['ignore', 'ignore', 'pipe'] });
  remote.forward = child;
  return until(() => httpOk(`http://127.0.0.1:${localPort}/api/health`), { timeout: 30_000, interval: 300, message: 'the SSH forward to answer /api/health' });
}

async function stopForward() {
  const child = remote.forward;
  if (!child || child.exitCode != null || child.signalCode) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, idleTimeout(5000)]);
  if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
}

// ---------------------------------------------------------------- clients

const clients = [];
let BASE = null;
let relay = null;
let RUN_TMP = null;

async function launchClient(tag, profileRoot) {
  const dir = path.join(profileRoot, `profile-${tag}`);
  const app = await electron.launch({
    args: [APP_DIR],
    env: cleanEnv({
      LAYTEKZ_TEST_MODE: '1',
      LAYTEKZ_TEST_USER_DATA: dir,
      LAYTEKZ_TEST_RECORD: path.join(dir, 'open-external.jsonl'),
      LAYTEKZ_TEST_SERVER_URL: BASE,
    }),
    timeout: 60_000,
  });
  const client = { tag, app, page: null, dir, compiles: [], console: [] };
  clients.push(client);
  const page = await findPage(app, BASE, 45_000);
  client.page = page;
  // Tag this app's traffic for the relay, then drop the connections made
  // before the tag so every later one carries it.
  await app.evaluate(async ({ BrowserWindow }, t) => {
    const win = BrowserWindow.getAllWindows()[0];
    const ses = win.webContents.session;
    const ua = `${ses.getUserAgent()} LaytekzE2E/${t}`;
    ses.setUserAgent(ua);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setUserAgent(ua);
    await ses.closeAllConnections();
  }, tag);
  page.on('request', (r) => {
    const u = r.url();
    if (r.method() === 'POST' && /\/api\/projects\/[^/]+\/compile(\?|$)/.test(u)) client.compiles.push({ at: Date.now(), url: u });
  });
  page.on('console', (m) => { if (m.type() === 'error') client.console.push(m.text().slice(0, 300)); });
  // The anonymous identity co-authors see, set as a person would in Project settings → Your name.
  await until(async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.evaluate(([name, color]) => {
      localStorage.setItem('aldine.name', name);
      localStorage.setItem('aldine.color', color);
      localStorage.setItem('aldine.autoTypeset', '1');
      localStorage.setItem('aldine.editorMode', 'source');
    }, [NAMES[tag].name, NAMES[tag].color]);
    return true;
  }, { timeout: 30_000, interval: 500, message: `client ${tag}'s profile setup` });
  await page.reload({ waitUntil: 'load' });
  return client;
}

/** The editor's whole document, from CodeMirror's state (not the DOM, which holds only the visible lines and the remote carets' name labels). */
function docText(page) {
  return page.evaluate(() => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
    return view ? view.state.doc.toString() : null;
  });
}

/** Puts the caret at the end of the first line containing `needle`, and focuses the editor (what a click there does). */
async function caretToLineEnd(page, needle) {
  const ok = await page.evaluate((n) => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
    if (!view) return 'no view';
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i += 1) {
      const line = doc.line(i);
      if (line.text.includes(n)) {
        view.focus();
        view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
        return true;
      }
    }
    return `no line contains ${n}`;
  }, needle);
  if (ok !== true) throw new Error(`caretToLineEnd: ${ok}`);
}

/** Scrolls the editor so the first line containing `needle` is near the top (for screenshots that show several edits). */
function scrollEditorTo(page, needle) {
  return page.evaluate((n) => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
    if (!view) return;
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i += 1) {
      if (doc.line(i).text.includes(n)) { view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(doc.line(i).from).top - 8); return; }
    }
  }, needle);
}

/** Starts watching this page's document for `token`; window.__kz[token] becomes the time (ms since epoch) it first appeared. */
function watchFor(page, token) {
  return page.evaluate((tok) => {
    window.__kz = window.__kz || {};
    window.__kz[tok] = null;
    const content = document.querySelector('.cm-content');
    const view = content?.cmTile?.root?.view;
    const has = () => (view ? view.state.doc.toString() : content.textContent).includes(tok);
    if (has()) { window.__kz[tok] = -1; return; }
    const mo = new MutationObserver(() => { if (has()) { window.__kz[tok] = Date.now(); mo.disconnect(); } });
    mo.observe(content, { subtree: true, childList: true, characterData: true });
    setTimeout(() => mo.disconnect(), 60_000);
  }, token);
}
const seenAt = (page, token, timeout = 20_000) => until(() => page.evaluate((t) => window.__kz?.[t], token), { timeout, interval: 25, message: `${token} to appear` });

/** Types `text` so that the last key is pressed at the returned time. */
async function typeTimed(page, text, delay = 0) {
  await page.keyboard.type(text.slice(0, -1), { delay });
  const t0 = Date.now();
  await page.keyboard.type(text.slice(-1));
  return t0;
}

function previewState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      pdf: q('[data-testid="preview"]')?.getAttribute('data-pdf') || null,
      busy: q('[data-testid="typeset-button"]')?.getAttribute('aria-busy') === 'true',
      status: (q('[data-testid="pdf-status"]')?.textContent || '').trim(),
      pages: document.querySelectorAll('canvas.pdf-page').length,
      text: Array.from(document.querySelectorAll('.pdf-text')).map((e) => e.textContent).join(' '),
      sync: q('[data-testid="sync-status"]')?.getAttribute('data-state') || null,
      syncText: (q('[data-testid="sync-status"]')?.textContent || '').trim(),
      errors: Array.from(document.querySelectorAll('[data-testid="errors-panel"] .errors__row')).map((e) => e.textContent.trim()).slice(0, 5),
    };
  });
}
const squash = (s) => (s || '').replace(/\s+/g, '');

/** Waits until no typeset runs and the preview stays on one run for `quietMs`. */
async function settle(client, quietMs = 5000, timeout = 150_000) {
  let key = null;
  let since = Date.now();
  return until(async () => {
    const s = await previewState(client.page);
    const k = `${s.busy}|${s.pdf}|${s.status}`;
    if (k !== key) { key = k; since = Date.now(); }
    return !s.busy && s.pdf && Date.now() - since >= quietMs ? s : null;
  }, { timeout, interval: 250, message: `client ${client.tag}'s typesetting to settle` });
}

async function shot(client, name) {
  await fsp.mkdir(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, `${name}-${client.tag}.png`);
  try {
    await client.page.screenshot({ path: file, timeout: 15_000 });
  } catch {
    const b64 = await client.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fsp.writeFile(file, Buffer.from(b64, 'base64'));
  }
  // Small PNGs: at most 1100 px wide (sips ships with macOS).
  if (process.platform === 'darwin') await run('/usr/bin/sips', ['-Z', '1100', file]);
  return file;
}

async function pdfToText(file) {
  for (const bin of ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext']) {
    const r = await run(bin, ['-layout', file, '-']);
    if (r.code === 0) return { tool: 'pdftotext', text: r.stdout };
  }
  return { tool: null, text: null };
}

async function fetchPdf(urlPath, file) {
  const res = await fetch(new URL(urlPath, BASE), { headers: { 'user-agent': 'LaytekzE2E/harness' } });
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(file, buf);
  return { status: res.status, bytes: buf.length, magic: buf.subarray(0, 5).toString('latin1') };
}

// ---------------------------------------------------------------- the scenario

async function main() {
  const free0 = await freeBytes();
  results.environment.macFreeBytesAtStart = free0;
  if (free0 < MIN_FREE_BYTES) throw new Error(`only ${(free0 / 1024 ** 3).toFixed(1)} GB free on the Mac; need 2 GB`);
  const tmpRoot = env.LAYTEKZ_E2E_TMP ? path.resolve(env.LAYTEKZ_E2E_TMP) : os.tmpdir();
  await fsp.mkdir(tmpRoot, { recursive: true });
  const TMP = await fsp.mkdtemp(path.join(tmpRoot, 'laytekz-collab-'));
  RUN_TMP = TMP;
  results.environment.tmp = TMP;
  // Fresh evidence for this run (only the files this script writes).
  await fsp.mkdir(EVIDENCE, { recursive: true });
  for (const f of await fsp.readdir(EVIDENCE)) if (/\.(png|json|pdf|txt)$/.test(f)) await fsp.rm(path.join(EVIDENCE, f));

  let fatal = null;
  try {
    // ---- infrastructure (not a numbered step: a failure here is no product result)
    const setup = await remoteSetup();
    Object.assign(results.environment, setup);
    const relayPort = await freePort();
    const forwardPort = await freePort();
    BASE = `http://127.0.0.1:${relayPort}`;
    results.environment.base = BASE;
    results.environment.forwardPort = forwardPort;
    results.environment.remotePorts = { app: REMOTE_APP_PORT, compiler: REMOTE_COMPILER_PORT };
    const ready = await startInstance(BASE);
    results.environment.instance = ready;
    results.environment.instanceCode = (remote.instanceLog.find((l) => l.includes('(code:')) || '').replace(/^.*\(code: (.*)\).*$/, '$1');
    // verify-compiler.sh's own lines arrive prefixed with "  | "
    const suite = remote.instanceLog.filter((l) => /^\s*\|/.test(l));
    results.environment.sandboxSuite = VERIFY_SANDBOX ? {
      ran: true,
      passLines: suite.filter((l) => /\bPASS\b/.test(l)).length,
      failLines: suite.filter((l) => /\bFAIL/.test(l)).length,
      verdict: remote.instanceLog.find((l) => /verify-compiler\.sh: all checks passed|verify-compiler\.sh reported failures/.test(l))?.trim() ?? null,
    } : { ran: false };
    await startForward(forwardPort);
    relay = await startRelay({ listenPort: relayPort, targetPort: forwardPort });
    if (!(await httpOk(`${BASE}/api/health`))) throw new Error('the relay does not reach the instance');
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { 'user-agent': 'LaytekzE2E/harness' } })).json();
    results.environment.authEnabled = me.authEnabled;

    const A = await launchClient('A', TMP);
    const B = await launchClient('B', TMP);
    results.environment.desktop = await A.app.evaluate(({ app, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = w.webContents.getLastWebPreferences?.() ?? {};
      return {
        appName: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
        electron: process.versions.electron, chrome: process.versions.chrome,
        windowVisible: w.isVisible(), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration,
        partition: w.webContents.session.storagePath ? 'persistent' : 'in-memory',
      };
    });
    results.environment.focusEmulated = { A: await A.page.evaluate(() => document.hasFocus()), B: await B.page.evaluate(() => document.hasFocus()) };

    let projectId = null;

    // ---- 1. project from a template, opened by both
    await step('1', 'A creates a project from the Article template and opens main.tex; B opens the same project from its project list', async (d) => {
      const name = `Laytekz e2e collab ${R}`;
      await A.page.locator('[data-testid="new-project"]:visible').first().click();
      await A.page.getByTestId('new-project-sheet').waitFor({ state: 'visible' });
      await A.page.getByTestId('new-project-name').fill(name);
      await A.page.getByTestId('template-article').click();
      await A.page.getByTestId('create-project').click();
      await A.page.waitForURL(/\/p\/[a-z0-9]+/, { timeout: 30_000 });
      projectId = new URL(A.page.url()).pathname.split('/p/')[1].split('/')[0];
      d.projectId = projectId;
      await A.page.locator('[data-testid="code-pane"][data-loaded="true"]').waitFor({ timeout: 30_000 });
      d.activeFileA = (await A.page.getByTestId('active-file').textContent())?.trim();
      if (d.activeFileA !== 'main.tex') throw new Error(`A has ${d.activeFileA} open, not main.tex`);
      // B: back to its project list, then open the card
      await B.page.goto(`${BASE}/`);
      await B.page.getByTestId(`open-${projectId}`).click({ timeout: 20_000 });
      await B.page.waitForURL(new RegExp(`/p/${projectId}`));
      await B.page.locator('[data-testid="code-pane"][data-loaded="true"]').waitFor({ timeout: 30_000 });
      d.activeFileB = (await B.page.getByTestId('active-file').textContent())?.trim();
      const [ta, tb] = [await docText(A.page), await docText(B.page)];
      if (!ta || ta !== tb) throw new Error('the two editors do not hold the same main.tex');
      if (!ta.includes('\\documentclass[11pt]{article}')) throw new Error('main.tex is not the Article template');
      d.mainTexLines = ta.split('\n').length;
      d.titles = { A: await A.page.title(), B: await B.page.title() };
      d.windowTitles = await Promise.all([A, B].map((c) => c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())));
      if (!d.windowTitles.every((t) => t.includes('Laytekz')) || d.windowTitles.some((t) => /Galley|Aldine/.test(t))) throw new Error(`window titles: ${d.windowTitles}`);
      await Promise.all([settle(A), settle(B)]);
      await shot(A, '01-project-open');
      await shot(B, '01-project-open');
    }, { critical: true });

    // ---- 2. presence
    await step('2', 'Presence: each client shows the other as connected, in main.tex', async (d) => {
      const other = (c, who) => c.page.locator(`[data-testid="presence"] [data-name="${who}"]`);
      await other(A, NAMES.B.name).waitFor({ timeout: 15_000 });
      await other(B, NAMES.A.name).waitFor({ timeout: 15_000 });
      d.inA = { title: await other(A, NAMES.B.name).getAttribute('title'), here: await other(A, NAMES.B.name).getAttribute('data-here') };
      d.inB = { title: await other(B, NAMES.A.name).getAttribute('title'), here: await other(B, NAMES.A.name).getAttribute('data-here') };
      if (d.inA.here !== 'true' || d.inB.here !== 'true') throw new Error(`not shown in the same file: ${JSON.stringify(d)}`);
      d.syncA = (await previewState(A.page)).syncText; d.syncB = (await previewState(B.page)).syncText;
      await shot(A, '02-presence');
      await shot(B, '02-presence');
    });

    // ---- 3. live edits, remote caret, concurrent typing
    await step('3', 'Real-time co-editing: A→B and B→A latency, A\'s caret in B, concurrent typing converges with nothing lost', async (d) => {
      const before = await docText(A.page);
      // A→B: five probes typed at the end of the Introduction line
      await caretToLineEnd(A.page, LINES.intro);
      const ab = [];
      for (let i = 1; i <= 5; i += 1) {
        const tok = T.aProbe(i);
        await watchFor(B.page, tok);
        const t0 = await typeTimed(A.page, ` ${tok}`);
        ab.push((await seenAt(B.page, tok)) - t0);
        await sleep(300);
      }
      // A's caret, drawn in B's editor, on the line A is typing in
      const caret = await until(() => B.page.evaluate(([who, tok]) => {
        for (const info of document.querySelectorAll('.cm-ySelectionInfo')) {
          if (info.textContent.trim() !== who) continue;
          const line = info.closest('.cm-line');
          return { label: info.textContent.trim(), onTypingLine: !!line && line.textContent.includes(tok) };
        }
        return null;
      }, [NAMES.A.name, T.aProbe(5)]), { timeout: 10_000, message: "A's caret in B's editor" });
      d.remoteCaretInB = caret;
      if (!caret.onTypingLine) throw new Error(`A's caret is not on A's line in B: ${JSON.stringify(caret)}`);
      await shot(B, '03a-remote-caret');
      // B→A: five probes at the end of the Conclusion line
      await caretToLineEnd(B.page, LINES.conclusion);
      const ba = [];
      for (let i = 1; i <= 5; i += 1) {
        const tok = T.bProbe(i);
        await watchFor(A.page, tok);
        const t0 = await typeTimed(B.page, ` ${tok}`);
        ba.push((await seenAt(A.page, tok)) - t0);
        await sleep(300);
      }
      d.latencyMs = { AtoB: ab, BtoA: ba };
      results.timings.keystrokeToRemoteMs = { AtoB: ab, BtoA: ba, medianAtoB: median(ab), maxAtoB: Math.max(...ab), medianBtoA: median(ba), maxBtoA: Math.max(...ba) };
      // Both type at once, in different places, keystroke by keystroke
      await caretToLineEnd(A.page, LINES.intro);
      await caretToLineEnd(B.page, LINES.conclusion);
      const t0 = Date.now();
      // keystroke by keystroke, 35 ms apart; the time of each one's last key is kept
      const lastKeys = await Promise.all([typeTimed(A.page, T.aBoth, 35), typeTimed(B.page, T.bBoth, 35)]);
      const typed = Math.max(...lastKeys);
      const converged = await until(async () => {
        const [ta, tb] = [await docText(A.page), await docText(B.page)];
        return ta === tb && ta.includes(T.aBoth) && ta.includes(T.bBoth) ? ta : null;
      }, { timeout: 15_000, interval: 25, message: 'both editors to hold the same text with both sentences' });
      d.concurrentTypingMs = typed - t0;
      d.convergedAfterLastKeyMs = Date.now() - typed;
      results.timings.concurrentConvergeAfterLastKeyMs = d.convergedAfterLastKeyMs;
      const expectedLength = before.length + [1, 2, 3, 4, 5].reduce((n, i) => n + 1 + T.aProbe(i).length + 1 + T.bProbe(i).length, 0) + T.aBoth.length + T.bBoth.length;
      d.lengths = { before: before.length, after: converged.length, expected: expectedLength };
      if (converged.length !== expectedLength) throw new Error(`length ${converged.length}, expected ${expectedLength}: text lost or duplicated`);
      const lines = converged.split('\n');
      const introLine = lines.find((l) => l.includes(LINES.intro));
      const conclLine = lines.find((l) => l.includes(LINES.conclusion));
      d.introLine = introLine;
      d.conclusionLine = conclLine;
      if (!introLine.endsWith(T.aBoth) || !conclLine.endsWith(T.bBoth)) throw new Error('a sentence is not where it was typed');
      for (const s of [T.aBoth, T.bBoth, ...[1, 2, 3, 4, 5].flatMap((i) => [T.aProbe(i), T.bProbe(i)])]) {
        if (count(converged, s) !== 1) throw new Error(`"${s}" appears ${count(converged, s)} times`);
      }
      d.identical = true;
      await Promise.all([scrollEditorTo(A.page, '\\section{Introduction}'), scrollEditorTo(B.page, '\\section{Introduction}')]);
      await sleep(150);
      await shot(A, '03b-converged');
      await shot(B, '03b-converged');
    });

    // ---- 4. live PDF
    await step('4', 'Live PDF: A stops typing, the preview re-typesets by itself with the new sentence; B shows the same build without compiling', async (d) => {
      await Promise.all([settle(A), settle(B)]);
      const pdfBefore = (await previewState(A.page)).pdf;
      const bCompilesBefore = B.compiles.length;
      const aCompilesBefore = A.compiles.length;
      await caretToLineEnd(A.page, LINES.method);
      await A.page.keyboard.type(T.pdf, { delay: 15 });
      const idle = Date.now();
      const tok = `pd${R}z`;
      const inA = await until(async () => {
        const s = await previewState(A.page);
        return s.pdf && s.pdf !== pdfBefore && squash(s.text).includes(tok) ? s : null;
      }, { timeout: 120_000, interval: 50, message: "A's preview to show a new PDF containing the sentence" });
      d.idleToNewPdfA = Date.now() - idle;
      const firstCompile = A.compiles.slice(aCompilesBefore)[0];
      d.idleToCompileRequestA = firstCompile ? firstCompile.at - idle : null;
      d.statusA = inA.status;
      const inB = await until(async () => {
        const s = await previewState(B.page);
        return s.pdf && s.pdf !== pdfBefore && squash(s.text).includes(tok) ? s : null;
      }, { timeout: 60_000, interval: 50, message: "B's preview to show the new PDF" });
      d.idleToNewPdfB = Date.now() - idle;
      // the final state: both on one run, and B never asked for a typeset
      const [fa, fb] = await Promise.all([settle(A), settle(B)]);
      d.finalPdfA = fa.pdf;
      d.finalPdfB = fb.pdf;
      d.aCompileRequests = A.compiles.length - aCompilesBefore;
      d.bCompileRequests = B.compiles.length - bCompilesBefore;
      d.statusB = inB.status;
      if (fa.pdf !== fb.pdf) throw new Error(`A and B show different runs: ${fa.pdf} vs ${fb.pdf}`);
      if (d.bCompileRequests !== 0) throw new Error(`B sent ${d.bCompileRequests} typeset request(s)`);
      if (d.aCompileRequests < 1) throw new Error('A sent no typeset request (no auto-typeset?)');
      // the server's PDF itself, through pdftotext
      const file = path.join(TMP, 'step4.pdf');
      d.fetched = await fetchPdf(fa.pdf, file);
      const { tool, text } = await pdfToText(file);
      d.pdfTextTool = tool;
      if (d.fetched.magic !== '%PDF-') throw new Error(`the server's PDF starts with ${d.fetched.magic}`);
      if (tool && !squash(text).includes(squash(T.pdf))) throw new Error('pdftotext does not find the sentence in the server\'s PDF');
      d.pdfTextHasSentence = tool ? true : 'pdftotext missing; checked through the app only';
      d.pdfTextHasBothCoEditedSentences = tool ? squash(text).includes(squash(T.aBoth)) && squash(text).includes(squash(T.bBoth)) : null;
      results.timings.idleToNewPdfMs = { A: d.idleToNewPdfA, B: d.idleToNewPdfB, idleToTypesetRequestA: d.idleToCompileRequestA };
      await shot(A, '04-live-pdf');
      await shot(B, '04-live-pdf');
    });

    // ---- 5. a LaTeX error from B, then the fix
    await step('5', 'A LaTeX error typed by B shows as a readable error with its line number; fixing it recovers', async (d) => {
      await Promise.all([settle(A), settle(B)]);
      const clean = await docText(B.page);
      await caretToLineEnd(B.page, LINES.conclusionHead);
      await B.page.keyboard.press('Enter');
      await B.page.keyboard.type(T.bad, { delay: 20 });
      await B.page.keyboard.press('Escape');
      const broken = await docText(B.page);
      const line = broken.split('\n').findIndex((l) => l.includes(T.bad)) + 1;
      d.errorLine = line;
      const t0 = Date.now();
      // An automatic typeset's errors fold the panel to its header ("1 error"),
      // so a half-typed command does not pop a list open; the person opens it.
      const panel = (c) => c.page.evaluate(() => {
        const p = document.querySelector('[data-testid="errors-panel"]');
        if (!p) return null;
        return {
          open: p.getAttribute('data-open'),
          header: (p.querySelector('.errors__head')?.textContent || '').trim(),
          rows: Array.from(p.querySelectorAll('.errors__row')).map((r) => ({
            text: r.textContent.trim(), line: r.querySelector('.errors__line')?.textContent.trim() || null, msg: r.querySelector('.errors__msg')?.textContent.trim() || null,
          })),
          status: (document.querySelector('[data-testid="pdf-status"]')?.textContent || '').trim(),
        };
      });
      const readError = async (c, timeout) => {
        const first = await until(async () => { const p = await panel(c); return p && /\berror/i.test(p.header) ? p : null; }, { timeout, interval: 100, message: `client ${c.tag}'s problems panel to report an error` });
        if (first.open !== 'true') await c.page.getByTestId('errors-toggle').click();
        const row = await until(async () => (await panel(c))?.rows.find((r) => /Undefined control sequence/i.test(r.text)) || null, { timeout: 5000, message: `the 'Undefined control sequence' row in ${c.tag}` });
        return { shownAfterMs: Date.now() - t0, headerBeforeOpening: first.header, foldedAtFirst: first.open !== 'true', status: first.status, row };
      };
      d.B = await readError(B, 90_000);
      // The row reads "main.tex · line N".
      const saysLine = (r) => new RegExp(`(^|\\s)line ${line}$`).test(r?.line || '');
      if (!saysLine(d.B.row)) throw new Error(`B's row says "${d.B.row.line}", the error is on line ${line}`);
      // A follows the same run without typesetting
      try {
        d.A = await readError(A, 30_000);
        d.A.lineMatches = saysLine(d.A.row);
      } catch (e) { d.A = `not shown in A: ${e.message.split('(')[0]}`; }
      await shot(B, '05a-latex-error');
      await shot(A, '05a-latex-error');
      await B.page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.focus());
      // B fixes it: select the bad line's text, delete it and the line break
      await B.page.keyboard.press('Shift+Home');
      await B.page.keyboard.press('Backspace');
      await B.page.keyboard.press('Backspace');
      const fixed = await docText(B.page);
      if (fixed !== clean) throw new Error('the fix did not restore the text exactly');
      const t1 = Date.now();
      const ok = await until(async () => {
        const s = await previewState(B.page);
        return !s.busy && /Typeset in/.test(s.status) && !s.errors.some((t) => /Undefined control sequence/i.test(t)) ? s : null;
      }, { timeout: 90_000, interval: 100, message: 'B to typeset cleanly again' });
      d.recoveredAfterMs = Date.now() - t1;
      d.statusAfterFixB = ok.status;
      const okA = await until(async () => {
        const s = await previewState(A.page);
        return /Typeset in/.test(s.status) && !s.errors.some((t) => /Undefined control sequence/i.test(t)) ? s : null;
      }, { timeout: 30_000, interval: 200, message: 'A to show the clean run' });
      d.statusAfterFixA = okA.status;
      await shot(B, '05b-fixed');
    });

    // ---- 6. SyncTeX both ways
    await step('6', 'SyncTeX: source→PDF jump flashes the right place; double-click in the PDF jumps to the source line', async (d) => {
      await Promise.all([settle(A), settle(B)]);
      // forward: caret on the Method line (it holds the step-4 sentence)
      await caretToLineEnd(A.page, LINES.method);
      await A.page.getByTestId('jump-to-pdf').click();
      const fwd = await until(() => A.page.evaluate((tok) => {
        const flash = document.querySelector('.pdf-flash');
        if (!flash) return null;
        const f = flash.getBoundingClientRect();
        // where the sentence's token is in the text layer
        for (const span of document.querySelectorAll('.pdf-text span')) {
          if (!span.textContent.includes(tok)) continue;
          const s = span.getBoundingClientRect();
          return { flash: { top: Math.round(f.top), bottom: Math.round(f.bottom) }, token: { top: Math.round(s.top), bottom: Math.round(s.bottom) }, overlaps: s.bottom > f.top - 4 && s.top < f.bottom + 4 };
        }
        return { flash: { top: Math.round(f.top), bottom: Math.round(f.bottom) }, token: null, overlaps: null };
      }, `pd${R}z`), { timeout: 15_000, interval: 30, message: 'the PDF flash after Jump to PDF' });
      d.forward = fwd;
      await shot(A, '06a-synctex-forward');
      // A paragraph of TeX output may span several lines; the flash marks the line SyncTeX gives for the source line.
      if (fwd.overlaps === false) d.forwardNote = 'the flash is on the page but not on the token\'s output line';
      // inverse: caret elsewhere, then double-click a probe word from step 3 in the PDF
      await caretToLineEnd(A.page, '\\documentclass');
      const target = T.aProbe(3);
      const box = await until(() => A.page.evaluate((tok) => {
        for (const span of document.querySelectorAll('.pdf-text span')) {
          const i = span.textContent.indexOf(tok);
          if (i < 0 || !span.firstChild) continue;
          const r = document.createRange();
          r.setStart(span.firstChild, i);
          r.setEnd(span.firstChild, i + tok.length);
          const b = r.getBoundingClientRect();
          span.scrollIntoView({ block: 'center' });
          const b2 = r.getBoundingClientRect();
          return { x: b2.left + b2.width / 2, y: b2.top + b2.height / 2, w: b.width };
        }
        return null;
      }, target), { timeout: 10_000, message: `${target} in A's PDF text layer` });
      await sleep(400);
      const box2 = await A.page.evaluate((tok) => {
        for (const span of document.querySelectorAll('.pdf-text span')) {
          const i = span.textContent.indexOf(tok);
          if (i < 0 || !span.firstChild) continue;
          const r = document.createRange();
          r.setStart(span.firstChild, i);
          r.setEnd(span.firstChild, i + tok.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
      }, target) ?? box;
      await A.page.mouse.dblclick(box2.x, box2.y);
      const inv = await until(() => A.page.evaluate(() => {
        const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
        if (!view) return null;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        return line.number > 1 ? { line: line.number, text: line.text.slice(0, 60) } : null;
      }), { timeout: 15_000, interval: 50, message: 'the caret to move after the double-click' });
      d.inverse = inv;
      if (!inv.text.startsWith(LINES.intro)) throw new Error(`double-click on ${target} went to line ${inv.line}: ${inv.text}`);
      await shot(A, '06b-synctex-inverse');
    });

    // ---- 7. B's network drops; A keeps typing; B catches up
    await step('7', 'Reconnect: B is cut off while A types (and B types offline); on restore B catches up, no text lost or duplicated', async (d) => {
      await Promise.all([settle(A, 2000), settle(B, 2000)]);
      const before = await docText(A.page);
      if (before !== (await docText(B.page))) throw new Error('A and B differ before the cut');
      d.relayBeforeCut = { openB: relay.open('B'), openA: relay.open('A'), websocketsByTag: { ...relay.stats.websocketsByTag } };
      if (!relay.stats.websocketsByTag.B) throw new Error("the relay never saw B's collaboration socket; the cut would test nothing");
      relay.block('B');
      const tCut = Date.now();
      const offline = await until(async () => { const s = await previewState(B.page); return s.sync === 'offline' ? s : null; }, { timeout: 20_000, interval: 100, message: 'B to say it is offline' });
      d.bNoticedCutMs = Date.now() - tCut;
      d.bStatusWhileCut = offline.syncText;
      await caretToLineEnd(A.page, LINES.results);
      await A.page.keyboard.type(T.aWhileCut, { delay: 20 });
      await caretToLineEnd(B.page, LINES.abstract);
      await B.page.keyboard.type(T.bWhileCut, { delay: 20 });
      await sleep(4000);
      const [cutA, cutB] = [await docText(A.page), await docText(B.page)];
      d.whileCut = { bHasAText: cutB.includes(T.aWhileCut), aHasBText: cutA.includes(T.bWhileCut), bStatus: (await previewState(B.page)).syncText };
      if (d.whileCut.bHasAText || d.whileCut.aHasBText) throw new Error('text crossed while B was cut off: the cut did not work');
      await shot(B, '07a-B-cut-off');
      await shot(A, '07a-B-cut-off');
      relay.unblock('B');
      const tBack = Date.now();
      d.cutForMs = tBack - tCut;
      const merged = await until(async () => {
        const [ta, tb] = [await docText(A.page), await docText(B.page)];
        return ta === tb && ta.includes(T.aWhileCut) && ta.includes(T.bWhileCut) ? ta : null;
      }, { timeout: 90_000, interval: 50, message: 'A and B to converge after the reconnect' });
      d.caughtUpAfterRestoreMs = Date.now() - tBack;
      const expected = before.length + T.aWhileCut.length + T.bWhileCut.length;
      d.lengths = { before: before.length, after: merged.length, expected };
      if (merged.length !== expected) throw new Error(`length ${merged.length}, expected ${expected}: duplicated or lost text`);
      for (const s of [T.aWhileCut, T.bWhileCut]) if (count(merged, s) !== 1) throw new Error(`"${s}" appears ${count(merged, s)} times`);
      await until(async () => (await previewState(B.page)).sync === 'saved', { timeout: 20_000, message: 'B to say Saved' });
      d.bStatusAfter = (await previewState(B.page)).syncText;
      results.timings.reconnect = { bNoticedCutMs: d.bNoticedCutMs, caughtUpAfterRestoreMs: d.caughtUpAfterRestoreMs, cutForMs: d.cutForMs };
      await shot(B, '07b-B-caught-up');
      await shot(A, '07b-B-caught-up');
    });

    await step('7b', 'Reconnect, both: the SSH forward is killed and restarted while both type offline; both converge', async (d) => {
      await Promise.all([settle(A, 2000), settle(B, 2000)]);
      const before = await docText(A.page);
      await stopForward();
      const tCut = Date.now();
      await until(async () => {
        const [sa, sb] = [await previewState(A.page), await previewState(B.page)];
        return sa.sync === 'offline' && sb.sync === 'offline';
      }, { timeout: 20_000, interval: 100, message: 'both to say offline' });
      d.bothNoticedMs = Date.now() - tCut;
      await caretToLineEnd(A.page, LINES.method);
      await caretToLineEnd(B.page, LINES.conclusion);
      await Promise.all([A.page.keyboard.type(T.aNoLink, { delay: 25 }), B.page.keyboard.type(T.bNoLink, { delay: 25 })]);
      await sleep(3000);
      d.statusWhileDown = { A: (await previewState(A.page)).syncText, B: (await previewState(B.page)).syncText };
      await shot(A, '07c-forward-down');
      const tBack = Date.now();
      await startForward(results.environment.forwardPort);
      d.forwardUpAfterMs = Date.now() - tBack;
      d.downForMs = tBack - tCut;
      const merged = await until(async () => {
        const [ta, tb] = [await docText(A.page), await docText(B.page)];
        return ta === tb && ta.includes(T.aNoLink) && ta.includes(T.bNoLink) ? ta : null;
      }, { timeout: 90_000, interval: 50, message: 'A and B to converge after the forward came back' });
      d.convergedAfterRestoreMs = Date.now() - tBack;
      const expected = before.length + T.aNoLink.length + T.bNoLink.length;
      d.lengths = { before: before.length, after: merged.length, expected };
      if (merged.length !== expected) throw new Error(`length ${merged.length}, expected ${expected}`);
      for (const s of [T.aNoLink, T.bNoLink]) if (count(merged, s) !== 1) throw new Error(`"${s}" appears ${count(merged, s)} times`);
      results.timings.reconnectBoth = { downForMs: d.downForMs, convergedAfterRestoreMs: d.convergedAfterRestoreMs };
      await shot(A, '07d-after-forward-back');
      await shot(B, '07d-after-forward-back');
    });

    // ---- 7c. the live PDF after the outages, with nobody pressing anything
    await step('7c', 'Live PDF after the outages: without anyone pressing anything, the preview catches up with the text typed while cut off', async (d) => {
      const offlineTyped = [T.bWhileCut, T.aNoLink, T.bNoLink].map((s) => squash(s));
      const caughtUp = (s) => s.pdf && offlineTyped.every((t) => squash(s.text).includes(t));
      const states = async () => ({ A: await previewState(A.page), B: await previewState(B.page) });
      const t0 = Date.now();
      let s = await states();
      d.atStart = { A: { status: s.A.status, pdf: !!s.A.pdf }, B: { status: s.B.status, pdf: !!s.B.pdf } };
      const byItself = await until(async () => { s = await states(); return caughtUp(s.A) && caughtUp(s.B) ? s : null; }, { timeout: 20_000, interval: 250, message: 'the previews to catch up by themselves' }).catch(() => null);
      d.caughtUpByItself = !!byItself;
      d.afterWaiting = { ms: Date.now() - t0, A: { status: s.A.status, pdf: !!s.A.pdf, caughtUp: !!caughtUp(s.A) }, B: { status: s.B.status, pdf: !!s.B.pdf, caughtUp: !!caughtUp(s.B) } };
      d.toastsA = (await overlayText(A.app, 'toast.html')) ?? null;
      d.pageToastsA = await A.page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent.trim()).slice(0, 3));
      d.pageToastsB = await B.page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent.trim()).slice(0, 3));
      if (!byItself) {
        await shot(A, '07e-preview-stale-after-outage');
        // What the person does: the web UI's "Try again" (or Typeset).
        const retry = A.page.getByTestId('typeset-retry');
        if (await retry.count()) { await retry.first().click(); d.recoveredWith = 'Try again (typeset-retry) in A'; } else { await A.page.getByTestId('typeset-button').click(); d.recoveredWith = 'Typeset in A'; }
        const t1 = Date.now();
        await until(async () => { s = await states(); return caughtUp(s.A) && caughtUp(s.B) && s.A.pdf === s.B.pdf ? s : null; }, { timeout: 90_000, interval: 250, message: 'both previews to catch up after Try again' });
        d.afterRetryMs = Date.now() - t1;
        throw new Error(`after the outages neither client re-typeset by itself; A said "${d.afterWaiting.A.status}", B "${d.afterWaiting.B.status}". One click on ${d.recoveredWith} brought both previews up to date in ${d.afterRetryMs} ms`);
      }
    });

    // ---- 8. download through the shell
    await step('8', "Download: A's Download the PDF goes through the shell's download handling and saves a real PDF", async (d) => {
      await Promise.all([settle(A), settle(B)]);
      const dlDir = path.join(TMP, 'downloads');
      await fsp.mkdir(dlDir, { recursive: true });
      const target = path.join(dlDir, 'laytekz-collab.pdf');
      // The shell asks where to save with a native dialog; answer it as a person would.
      await A.app.evaluate(({ dialog }, file) => {
        globalThis.__kzSave = [];
        dialog.showSaveDialogSync = (...args) => { globalThis.__kzSave.push((args.length > 1 ? args[1] : args[0])?.defaultPath ?? null); return file; };
      }, target);
      await A.page.getByTestId('pdf-download').click();
      await until(async () => { try { const s = await fsp.stat(target); return s.size > 1000; } catch { return false; } }, { timeout: 30_000, message: 'the saved PDF' });
      const toast = await until(() => overlayText(A.app, 'toast.html').then((t) => (t && t.includes('Saved') ? t : null)), { timeout: 15_000, message: "the shell's Saved toast" });
      d.toast = toast.replace(/\s+/g, ' ').trim();
      // the name the shell proposed (from the web UI's download attribute), without the home folder
      d.dialogProposedNames = (await A.app.evaluate(() => globalThis.__kzSave)).map((p) => (p ? path.basename(p) : p));
      if (d.dialogProposedNames.length !== 1) throw new Error(`the save dialog was asked ${d.dialogProposedNames.length} times`);
      const buf = await fsp.readFile(target);
      d.bytes = buf.length;
      d.magic = buf.subarray(0, 5).toString('latin1');
      if (d.magic !== '%PDF-') throw new Error(`the saved file starts with ${d.magic}`);
      const x = await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', target]);
      d.quarantine = x.code === 0 ? x.stdout.trim().replace(/;[0-9A-F-]{36}$/, ';<uuid>') : `missing (${x.stderr.trim()})`;
      const { tool, text } = await pdfToText(target);
      if (tool) {
        const doc = await docText(A.page);
        const want = [T.pdf, T.aWhileCut, T.bWhileCut, T.aNoLink, T.bNoLink, T.aBoth, T.bBoth].filter((s) => doc.includes(s));
        d.sentencesInPdf = Object.fromEntries(want.map((s) => [s.trim(), squash(text).includes(squash(s))]));
        if (!Object.values(d.sentencesInPdf).every(Boolean)) throw new Error(`the saved PDF lacks sentences: ${JSON.stringify(d.sentencesInPdf)}`);
        await fsp.writeFile(path.join(EVIDENCE, '08-downloaded-pdf.txt'), text);
      }
      await fsp.copyFile(target, path.join(EVIDENCE, '08-downloaded.pdf'));
      await shot(A, '08-download');
      // The shell's toast is a view of its own over the page, so the page's screenshot does not show it.
      const toastPng = await A.app.evaluate(async ({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          for (const view of win.contentView.children) {
            const wc = view.webContents;
            if (wc && !wc.isDestroyed() && wc.getURL() === 'laytekz-ui://app/toast.html') return (await wc.capturePage()).toPNG().toString('base64');
          }
        }
        return null;
      });
      if (toastPng) {
        await fsp.writeFile(path.join(EVIDENCE, '08-shell-toast-A.png'), Buffer.from(toastPng, 'base64'));
        d.toastScreenshot = '08-shell-toast-A.png';
      }
    });

    // ---- 9. what reached the server's disk
    await step('9', "Persistence: the server's copy of main.tex (from its file API) equals both editors", async (d) => {
      const doc = await docText(A.page);
      if (doc !== (await docText(B.page))) throw new Error('A and B differ');
      const t0 = Date.now();
      const disk = await until(async () => {
        const res = await fetch(`${BASE}/api/projects/${projectId}/file?branch=main&path=main.tex`, { headers: { 'user-agent': 'LaytekzE2E/harness' } });
        const text = await res.text();
        return text === doc ? text : null;
      }, { timeout: 30_000, interval: 500, message: "the server's main.tex to equal the editors' text" });
      d.matchedAfterMs = Date.now() - t0;
      d.length = disk.length;
      await fsp.writeFile(path.join(EVIDENCE, '09-final-main.tex.txt'), disk);
    });

    results.environment.relayStats = relay.stats;
    results.environment.consoleErrors = { A: A.console.slice(0, 20), B: B.console.slice(0, 20) };
  } catch (err) {
    fatal = err;
    results.fatal = String(err?.stack || err).split('\n').slice(0, 6).join('\n');
    log(`FATAL: ${results.fatal}`);
  } finally {
    await teardown(TMP);
    await writeResults();
  }
  printSummary();
  const failed = results.steps.filter((s) => s.status !== 'pass').length;
  process.exitCode = fatal || failed ? 1 : 0;
}

async function teardown(TMP) {
  log('teardown');
  const t = results.teardown;
  for (const c of clients) await c.app.close().catch(() => {});
  t.appsClosed = clients.length;
  if (relay) { await relay.close(); t.relay = 'closed'; }
  await stopForward();
  t.forward = 'stopped';
  t.instanceExit = await stopInstance();
  if (remote.dir && REMOTE_DIR_RE.test(remote.dir)) {
    const root = remote.ready?.root && /^\/home\/[A-Za-z0-9._-]+\/galley-server\/smoke-[A-Za-z0-9]{6}$/.test(remote.ready.root) ? remote.ready.root : '';
    const check = await run('ssh', [SSH_HOST, `rm -rf ${remote.dir}; sleep 1; ss -tlnH | awk '{print $4}' | grep -E ':(${REMOTE_APP_PORT}|${REMOTE_COMPILER_PORT})$' || echo ports-free; ${root ? `test -e ${root} && echo instance-dir-left || echo instance-dir-gone;` : ''} test -e ${remote.dir} && echo tooling-copy-left || echo tooling-copy-gone`]);
    t.remote = check.stdout.trim().split('\n');
  }
  const forwardLeft = remote.forward && remote.forward.exitCode == null && !remote.forward.signalCode;
  t.forwardProcessLeft = !!forwardLeft;
  if (!KEEP_TMP && TMP) { await fsp.rm(TMP, { recursive: true, force: true }); t.tmp = 'deleted'; } else t.tmp = `kept: ${TMP}`;
  t.macFreeBytesAtEnd = await freeBytes();
}

function printSummary() {
  console.log('\n==== Laytekz end-to-end collaboration test ====');
  for (const s of results.steps) console.log(`${s.status === 'pass' ? 'PASS' : 'FAIL'}  ${s.id.padEnd(3)} ${s.title}${s.error ? `\n        ${s.error.split('\n')[0]}` : ''}`);
  if (results.fatal) console.log(`FATAL ${results.fatal.split('\n')[0]}`);
  console.log('timings:', JSON.stringify(results.timings));
  console.log('teardown:', JSON.stringify(results.teardown));
  console.log(`evidence: ${EVIDENCE}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig}: tearing down`);
    teardown(RUN_TMP).finally(() => process.exit(130));
  });
}
process.on('exit', () => { try { remote.forward?.kill('SIGKILL'); remote.instance?.kill('SIGTERM'); } catch {} });

main();
