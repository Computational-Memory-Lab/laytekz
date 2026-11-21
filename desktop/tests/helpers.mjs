// Shared helpers for the Electron tests.

import { _electron as electron, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browse } from './browser-sim.mjs';

export const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sha256url = (text) => crypto.createHash('sha256').update(text).digest('base64url');

export async function tempDir(prefix = 'laytekz-e2e-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** The environment for a child Electron: editors such as VS Code export ELECTRON_RUN_AS_NODE, which turns Electron into plain Node. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Starts the app from source in test mode. Returns {app, page, dir, record, recorded(), close()}.
 * `page` is the main window, already on the server (or on the offline screen).
 */
export async function launchApp({ serverUrl, env = {}, dir: givenDir, waitForPage = true } = {}) {
  const dir = givenDir ?? await tempDir();
  const record = path.join(dir, 'open-external.jsonl');
  const app = await electron.launch({
    args: [APP_DIR],
    env: cleanEnv({
      LAYTEKZ_TEST_MODE: '1',
      LAYTEKZ_TEST_USER_DATA: dir,
      LAYTEKZ_TEST_RECORD: record,
      ...(serverUrl ? { LAYTEKZ_TEST_SERVER_URL: serverUrl } : {}),
      ...env,
    }),
  });
  let page = await app.firstWindow();
  if (waitForPage && serverUrl) page = await findPage(app, serverUrl);
  return {
    app,
    page,
    dir,
    record,
    recorded: () => readRecord(record),
    close: async ({ keepDir = false } = {}) => {
      await app.close().catch(() => {});
      if (!keepDir && !givenDir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** The page (window or view) whose URL starts with `prefix`, e.g. the main window once it is on the server. */
export async function findPage(app, prefix, timeout = 15_000) {
  return until(() => app.windows().find((p) => p.url().startsWith(prefix)), { timeout, message: `a page on ${prefix}` });
}

export async function readRecord(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line).url);
  } catch {
    return [];
  }
}

/** Waits for the page to finish its /api/auth/me round trip; returns the heading text. */
export async function pageReady(page) {
  await page.waitForSelector('body[data-ready="1"]', { timeout: 15_000 });
  return page.textContent('#who');
}

/** Clicks with a DOM click, which navigates exactly like a user's click on a link. */
export async function click(page, selector) {
  await page.evaluate((s) => document.querySelector(s).click(), selector);
}

/** Text of a local overlay (toast.html / offline.html) while it is attached to a window, else null. */
export async function overlayText(app, file) {
  return app.evaluate(async ({ BrowserWindow }, name) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const view of win.contentView.children) {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed() && wc.getURL() === `laytekz-ui://app/${name}`) {
          return wc.executeJavaScript('document.body.innerText');
        }
      }
    }
    return null;
  }, file);
}

export async function overlayClick(app, file, testId) {
  return app.evaluate(async ({ BrowserWindow }, [name, id]) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const view of win.contentView.children) {
        const wc = view.webContents;
        if (wc && !wc.isDestroyed() && wc.getURL() === `laytekz-ui://app/${name}`) {
          return wc.executeJavaScript(`document.querySelector('[data-testid="${id}"]').click(), true`);
        }
      }
    }
    return false;
  }, [file, testId]);
}

/** Polls `fn` until it returns a truthy value. */
export async function until(fn, { timeout = 10_000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last value: ${JSON.stringify(last)})`);
}

/** Clicks sign-in and returns the recorded start URL, parsed. */
export async function startSignIn(ctx, nth = 1) {
  await click(ctx.page, '#signin');
  const urls = await until(async () => {
    const all = (await ctx.recorded()).filter((u) => u.includes('/api/auth/desktop/start'));
    return all.length >= nth ? all : null;
  }, { message: 'the start URL to be recorded' });
  const url = new URL(urls[nth - 1]);
  return { url, params: Object.fromEntries(url.searchParams) };
}

/** Full handoff: start, play the browser, and wait for the window to show the signed-in page. */
export async function signInViaHandoff(ctx) {
  const start = await startSignIn(ctx);
  const result = await browse(start.url.href);
  expect(result.status).toBe(200);
  await expect.poll(() => ctx.page.textContent('#who').catch(() => null), { timeout: 10_000 }).toBe('Signed in as Test User');
  return { start, result };
}

/** Whether something is listening on a loopback URL's port. */
export async function listening(rawUrl) {
  try {
    await fetch(rawUrl, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (err) {
    return !(err?.cause?.code === 'ECONNREFUSED');
  }
}
