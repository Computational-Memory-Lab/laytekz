// File → Link a local .bib…: keeps a .bib file on this computer in sync with
// a project (V2, WP41, feature 8). It covers Mendeley Desktop's BibTeX sync
// folder, Better BibTeX auto-export, JabRef, EndNote exports and a synced
// Paperpile file.
//
// The main process creates a library link on the server (POST
// /api/projects/:id/libraries, provider 'desktop-file', WP35's contract),
// watches the file and, 1 s after the last change, PUTs its content
// (…/libraries/:linkId/content) through the window session
// (ShellCtx.sessionFetch: the session cookie, no Origin header). The remote
// page gets no preload and learns nothing about local files. The watched
// files are kept per server and per project in settings.json
// (features.bibwatch.links). Unlinking is in the desktop settings window
// (File → Linked .bib files…), and a link removed in the project's Libraries
// panel stops the watch at the next upload.
//
// No Electron import at the top level (the feature list loads in plain Node).

import path from 'node:path';
import { setBibwatch } from './api.js';
import { createBibSync, projectBibName, readBib } from './watcher.js';
import { openDesktopSettings } from '../desktopSettings/open.js';

let running = null;

/** @type {import('../index.js').ShellFeature} */
const bibwatchFeature = {
  id: 'bibwatch',
  menu: [
    { where: 'file', item: { id: 'bibwatch-link', label: 'Link a local .bib…', click: () => running?.linkFromMenu() } },
    { where: 'file', item: { id: 'bibwatch-manage', label: 'Linked .bib files…', click: () => openDesktopSettings('bib') } },
  ],
  start: (ctx) => startBibwatch(ctx),
};

async function startBibwatch(ctx) {
  const { app, dialog, BrowserWindow } = await import('electron');
  const { test } = await import('../../env.js');
  const fs = await import('node:fs');
  const testMode = test.enabled && !app.isPackaged;
  const listeners = new Set();

  const json = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };
  const call = async (p, init) => {
    try {
      const res = await ctx.sessionFetch(p, init);
      return { status: res.status, body: await json(res) };
    } catch {
      return { status: 0, body: null };
    }
  };
  const linkPath = (r) => `/api/projects/${encodeURIComponent(r.projectId)}/libraries/${encodeURIComponent(r.linkId)}`;
  const send = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const sync = createBibSync({
    load: () => ctx.settings.get('links', []),
    save: (records) => ctx.settings.set('links', records.length ? records : undefined),
    server: () => ctx.server(),
    push: (record, content) => call(`${linkPath(record)}/content`, send('PUT', { content, branch: record.branch })),
    remove: (record) => call(linkPath(record), { method: 'DELETE' }),
    changed: () => {
      for (const fn of listeners) fn();
    },
  });

  // ------------------------------------------------ dialogs (recorded in test mode)

  const record = (entry) => {
    try {
      fs.appendFileSync(path.join(test.userData, 'bibwatch.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch { /* best effort */ }
  };
  const front = () => BrowserWindow.getFocusedWindow() ?? ctx.mainWindow();

  async function tell(message, detail, type = 'info') {
    if (test.enabled) {
      record({ dialog: message, detail, type });
      return;
    }
    const win = front();
    const options = { type, message, detail, buttons: ['OK'] };
    await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  }

  async function ask(message, detail, buttons) {
    if (test.enabled) {
      const answer = testMode ? Number.parseInt(process.env.LAYTEKZ_TEST_BIB_ANSWER ?? '0', 10) : 0;
      record({ question: message, detail, buttons, answer });
      return Number.isInteger(answer) ? answer : 0;
    }
    const win = front();
    const options = { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 };
    const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    return response;
  }

  async function chooseFile() {
    if (test.enabled) {
      // Test mode never shows the open panel: the file comes from the environment (from source only).
      return testMode && process.env.LAYTEKZ_TEST_BIB_FILE && path.isAbsolute(process.env.LAYTEKZ_TEST_BIB_FILE)
        ? process.env.LAYTEKZ_TEST_BIB_FILE : null;
    }
    const win = front();
    const options = {
      title: 'Link a local .bib file',
      buttonLabel: 'Link',
      properties: ['openFile'],
      filters: [{ name: 'BibTeX', extensions: ['bib'] }],
    };
    const { canceled, filePaths } = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return canceled || !filePaths?.length ? null : filePaths[0];
  }

  // --------------------------------------------------------------- linking

  async function createLink(project, bibFile, replace) {
    return call(`/api/projects/${encodeURIComponent(project.id)}/libraries`, send('POST', {
      provider: 'desktop-file', branch: project.branch, ...(bibFile ? { bibFile } : {}), ...(replace ? { replace: true } : {}),
    }));
  }

  async function linkFromMenu() {
    const win = ctx.mainWindow();
    const project = win ? ctx.projectFromUrl(win.webContents.getURL()) : null;
    if (!project) {
      await tell('Open a project first.', 'Then choose File → Link a local .bib… to keep a .bib file on this computer in sync with that project.');
      return;
    }
    const file = await chooseFile();
    if (!file) return;
    const content = readBib(file);
    if (!content.ok) {
      await tell('Laytekz cannot link this file.', content.error, 'warning');
      return;
    }
    const server = ctx.server();
    const already = sync.list().find((r) => r.server === server && r.projectId === project.id && r.file === file);
    if (already) {
      await tell(`${path.basename(file)} is already linked to ${already.bibFile}.`, 'Each time you save it, Laytekz uploads it to this project.');
      return;
    }
    const wanted = projectBibName(file);
    let answer = await createLink(project, wanted, false);
    if (answer.status === 409 && answer.body?.code === 'exists') {
      const choice = await ask(
        `${wanted} is already in this project.`,
        `Replace it with your file? From then on, each time you save ${path.basename(file)}, Laytekz replaces the project's copy.`,
        ['Replace', 'Use another name', 'Cancel'],
      );
      if (choice !== 0 && choice !== 1) return;
      answer = await createLink(project, choice === 0 ? wanted : '', choice === 0);
    } else if (wanted && (answer.status === 400 || (answer.status === 409 && answer.body?.code === 'taken'))) {
      answer = await createLink(project, '', false);
    }
    const link = answer.body?.link;
    if (answer.status < 200 || answer.status >= 300 || !link || typeof link.id !== 'string') {
      const why = answer.status === 0 ? 'The server could not be reached.'
        : answer.status === 401 ? 'Sign in to Laytekz first.'
          : answer.status === 404 ? 'This server cannot link local files yet.'
            : (typeof answer.body?.error === 'string' ? answer.body.error : `The server answered ${answer.status}.`);
      await tell('Laytekz could not link the file.', why, 'warning');
      return;
    }
    const pushed = await sync.add({
      server, projectId: project.id, branch: project.branch, linkId: link.id, file, bibFile: String(link.bibFile ?? wanted),
    });
    if (pushed?.ok) {
      await tell(
        `${path.basename(file)} is linked to ${link.bibFile} in this project.`,
        'While Laytekz is open, each time you save the file it replaces the project\'s copy, which stays read-only in the editor. To stop, choose File → Linked .bib files….',
      );
    } else {
      await tell(`${path.basename(file)} is linked, but the first upload failed.`, pushed?.error ?? 'Laytekz tries again at the next change.', 'warning');
    }
  }

  running = { linkFromMenu };
  setBibwatch(Object.freeze({
    list: () => sync.list(),
    pushNow: (key, opts) => sync.pushNow(key, opts),
    unlink: (key) => sync.unlink(key),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  }));
  sync.start();
  // A server switch (Change Server…) moves the watches to that server's links.
  let lastServer = ctx.server();
  const serverCheck = setInterval(() => {
    if (ctx.server() === lastServer) return;
    lastServer = ctx.server();
    sync.start();
  }, 3000);
  serverCheck.unref?.();

  return () => {
    clearInterval(serverCheck);
    running = null;
    setBibwatch(null);
    listeners.clear();
    sync.stop();
  };
}

export default bibwatchFeature;
