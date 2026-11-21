// File → Link a local .bib… (V2, WP41, feature 8). In plain Node: reading
// the file (UTF-8 only, 20 MB), the project file name, and the sync set
// (one upload 1 s after the last change, nothing for an unchanged file, a
// link removed on the server stops the watch, Unlink stops it). In the app,
// against the libraries mock: linking creates a desktop-file link and
// uploads the file through the window session (cookie, no Origin header);
// an edit reaches the server within 2 s; Unlink in the settings window
// removes the link and stops the uploads; the remote page has no preload.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_BYTES, checkRecord, createBibSync, projectBibName, readBib, recordKey,
} from '../src/main/features/bibwatch/watcher.js';
import { clickMenuItem, findPage, launchApp, until } from './helpers.mjs';
import { TEST_USER, startMockServer } from './mock-server.mjs';

const BIB = '@article{knuth1984,\n  title = {Literate Programming},\n  author = {Knuth, Donald E.},\n  year = {1984}\n}\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ plain Node

test.describe('local .bib links (no Electron)', () => {
  test('reading: UTF-8 only, BOM dropped, a missing file says so; project file names', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-bib-'));
    try {
      const good = path.join(dir, 'refs.bib');
      await fs.writeFile(good, `\uFEFF${BIB}`);
      const read = readBib(good);
      expect(read.ok).toBe(true);
      expect(read.content).toBe(BIB);
      expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
      const latin1 = path.join(dir, 'latin.bib');
      await fs.writeFile(latin1, Buffer.from([0x40, 0x61, 0x7b, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x7d]));
      expect(readBib(latin1)).toMatchObject({ ok: false, error: expect.stringContaining('not UTF-8') });
      expect(readBib(path.join(dir, 'gone.bib'))).toMatchObject({ ok: false, missing: true });
      expect(readBib(good, { stat: () => ({ size: MAX_BYTES + 1 }) })).toMatchObject({ ok: false, error: expect.stringContaining('20 MB') });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(projectBibName('/Users/a/Zotero/My Library.bib')).toBe('My Library.bib');
    expect(projectBibName('C:\\x\\refs.BIB')).toBe(path.sep === '\\' ? 'refs.bib' : '');
    expect(projectBibName('/a/.hidden.bib')).toBe('');
    expect(projectBibName('/a/notes.txt')).toBe('');
    expect(checkRecord({ server: 'https://x.test', projectId: 'abc123', branch: 'main', linkId: 'l1', file: '/a/b.bib', bibFile: 'b.bib' })).not.toBeNull();
    expect(checkRecord({ server: 'https://x.test/', projectId: 'abc123', branch: 'main', linkId: 'l1', file: '/a/b.bib', bibFile: 'b.bib' })).toBeNull();
    expect(checkRecord({ server: 'https://x.test', projectId: 'abc123', branch: '../x', linkId: 'l1', file: '/a/b.bib', bibFile: 'b.bib' })).toBeNull();
    expect(checkRecord({ server: 'https://x.test', projectId: 'abc123', branch: 'main', linkId: 'l1', file: 'b.bib', bibFile: 'b.bib' })).toBeNull();
  });

  test('sync: one upload 1 s after the last change, none when unchanged; a removed link and Unlink stop the watch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-bib-'));
    const file = path.join(dir, 'refs.bib');
    await fs.writeFile(file, BIB);
    let stored = [];
    const pushes = [];
    const removed = [];
    let answer = 200;
    const sync = createBibSync({
      load: () => stored,
      save: (list) => { stored = JSON.parse(JSON.stringify(list)); },
      server: () => 'https://x.test',
      push: async (record, content) => { pushes.push({ content, at: Date.now(), linkId: record.linkId }); return { status: answer, body: answer === 200 ? { ok: true } : { error: 'nope' } }; },
      remove: async (record) => { removed.push(record.linkId); return { status: 200, body: { ok: true } }; },
    });
    try {
      const rec = { server: 'https://x.test', projectId: 'abc123', branch: 'main', linkId: 'l1', file, bibFile: 'refs.bib' };
      const key = recordKey(rec);
      expect((await sync.add(rec)).ok).toBe(true);
      expect(pushes).toHaveLength(1);
      expect(stored[0].hash).toMatch(/^[0-9a-f]{64}$/);

      // Three quick saves, the last one by rename (as many editors save): one upload of the last content.
      await fs.writeFile(file, `${BIB}% 1\n`);
      await sleep(150);
      await fs.writeFile(file, `${BIB}% 2\n`);
      await sleep(150);
      await fs.writeFile(`${file}.tmp`, `${BIB}% 3\n`);
      const lastSave = Date.now();
      await fs.rename(`${file}.tmp`, file);
      await until(() => pushes.length >= 2, { timeout: 4000, message: 'the upload after the saves' });
      await sleep(1300);
      expect(pushes).toHaveLength(2);
      expect(pushes[1].content).toBe(`${BIB}% 3\n`);
      expect(pushes[1].at - lastSave).toBeGreaterThanOrEqual(900);

      // Saved again with the same bytes: nothing to upload.
      await fs.writeFile(file, `${BIB}% 3\n`);
      await sleep(1500);
      expect(pushes).toHaveLength(2);
      expect(sync.list()[0]).toMatchObject({ key, state: 'ok', watching: true, name: 'refs.bib' });

      // A server error is shown and kept; the next change tries again.
      answer = 500;
      expect(await sync.pushNow(key, { force: true })).toMatchObject({ ok: false, error: 'nope' });
      expect(sync.list()[0]).toMatchObject({ state: 'error', error: 'nope' });

      // The link was removed in the project: the record goes, the watch stops.
      answer = 404;
      expect(await sync.pushNow(key, { force: true })).toMatchObject({ ok: false, gone: true });
      expect(stored).toEqual([]);
      expect(sync.has(key)).toBe(false);
      await fs.writeFile(file, `${BIB}% 4\n`);
      await sleep(1400);
      expect(pushes).toHaveLength(4);

      // Unlink: removed on the server, no more uploads.
      answer = 200;
      await sync.add({ ...rec, linkId: 'l2' });
      expect(pushes).toHaveLength(5);
      expect(await sync.unlink(recordKey({ ...rec, linkId: 'l2' }))).toEqual({ ok: true });
      expect(removed).toEqual(['l2']);
      await fs.writeFile(file, `${BIB}% 5\n`);
      await sleep(1400);
      expect(pushes).toHaveLength(5);
      expect(stored).toEqual([]);
    } finally {
      sync.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe('local .bib links after a server switch (no Electron)', () => {
  test('a link of another server is kept and not pushed; start() picks the watches up again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-bib-'));
    const file = path.join(dir, 'refs.bib');
    await fs.writeFile(file, BIB);
    let stored = [];
    let server = 'https://a.test';
    const pushes = [];
    const sync = createBibSync({
      load: () => stored,
      save: (list) => { stored = JSON.parse(JSON.stringify(list)); },
      server: () => server,
      push: async (record) => { pushes.push(record.server); return { status: record.server === server ? 200 : 404, body: null }; },
      remove: async () => ({ status: 200, body: null }),
    });
    try {
      const rec = { server: 'https://a.test', projectId: 'abc123', branch: 'main', linkId: 'l1', file, bibFile: 'refs.bib' };
      const key = recordKey(rec);
      await sync.add(rec);
      server = 'https://b.test';
      expect(await sync.pushNow(key, { force: true })).toMatchObject({ ok: false, error: expect.stringContaining('that server') });
      expect(stored).toHaveLength(1);
      expect(sync.has(key)).toBe(false);
      expect(pushes).toEqual(['https://a.test']);
      server = 'https://a.test';
      await fs.writeFile(file, `${BIB}% while away\n`);
      sync.start();
      await until(() => pushes.length === 2, { message: 'the catch-up upload' });
      expect(sync.has(key)).toBe(true);
    } finally {
      sync.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ in the app

test.describe('local .bib links in the app', () => {
  test('link, an edit reaches the server within 2 s, Unlink stops it; no preload on the remote page', async () => {
    test.setTimeout(90_000);
    const mock = await startMockServer();
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-bib-app-'));
    const file = path.join(work, 'refs.bib');
    await fs.writeFile(file, BIB);
    const ctx = await launchApp({ serverUrl: mock.url, env: { LAYTEKZ_TEST_BIB_FILE: file } });
    try {
      mock.state.sessions.set('bib-session', TEST_USER);
      await ctx.app.evaluate(async ({ session }, url) => {
        await session.fromPartition('persist:laytekz').cookies.set({ url, name: 'aldine_session', value: 'bib-session' });
      }, mock.url);

      // Without a project open, it says to open one.
      await clickMenuItem(ctx.app, 'bibwatch-link');
      await until(async () => (await fs.readFile(path.join(ctx.dir, 'bibwatch.jsonl'), 'utf8').catch(() => '')).includes('Open a project first.'), { message: 'the "open a project" note' });

      await ctx.page.goto(`${mock.url}/p/proj1234`);
      await clickMenuItem(ctx.app, 'bibwatch-link');
      const libs = () => mock.state.libraries;
      await until(() => libs()?.puts.length >= 1, { message: 'the first upload' });
      expect(libs().posts[0].body).toEqual({ provider: 'desktop-file', branch: 'main', bibFile: 'refs.bib' });
      expect(libs().puts[0]).toMatchObject({ projectId: 'proj1234', linkId: 'l0001', content: BIB, branch: 'main', origin: null, cookie: true, contentType: 'application/json' });
      const settings = JSON.parse(await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8'));
      expect(settings.features.bibwatch.links).toEqual([expect.objectContaining({ server: mock.url, projectId: 'proj1234', linkId: 'l0001', file, bibFile: 'refs.bib' })]);
      expect(await fs.readFile(path.join(ctx.dir, 'bibwatch.jsonl'), 'utf8')).toContain('refs.bib is linked to refs.bib in this project.');

      // An edit reaches the server within 2 s.
      await sleep(300);
      const edited = `${BIB}@book{lamport1994, title = {LaTeX}, year = {1994}}\n`;
      const savedAt = Date.now();
      await fs.writeFile(file, edited);
      await until(() => libs().puts.length >= 2, { timeout: 2000, interval: 50, message: 'the upload of the edit within 2 s' });
      expect(libs().puts[1].content).toBe(edited);
      expect(libs().puts[1].at - savedAt).toBeLessThan(2000);

      // File → Linked .bib files… lists it; Unlink removes the link and stops the uploads.
      await clickMenuItem(ctx.app, 'bibwatch-manage');
      const page = await findPage(ctx.app, 'laytekz-ui://app/desktop-settings.html');
      await page.waitForSelector('body[data-ready="1"]');
      expect(new URL(page.url()).hash).toBe('#bib');
      await expect(page.locator('[data-testid="desktop-bib-link"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="desktop-bib-link"]')).toContainText('refs.bib → refs.bib');
      await page.click('[data-testid="desktop-bib-unlink"]');
      await until(() => libs().deletes.length === 1, { message: 'the unlink' });
      expect(libs().deletes[0]).toMatchObject({ projectId: 'proj1234', linkId: 'l0001', origin: null });
      await expect(page.locator('[data-testid="desktop-bib-empty"]')).toBeVisible();
      await fs.writeFile(file, `${edited}% after unlink\n`);
      await sleep(2500);
      expect(libs().puts).toHaveLength(2);
      expect(JSON.parse(await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8')).features.bibwatch?.links).toBeUndefined();

      expect(await ctx.page.evaluate(() => typeof window.laytekz)).toBe('undefined');
    } finally {
      await ctx.close();
      await mock.stop();
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});
