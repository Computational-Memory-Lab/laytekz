// Every hand-off to the system browser or mail client goes through here.

import { dialog, shell } from 'electron';
import fs from 'node:fs';
import { test } from './env.js';
import { externalUrl } from './rules.js';

export { externalUrl };

export async function openExternal(raw) {
  const href = externalUrl(raw);
  if (!href) return false;
  if (test.enabled) {
    fs.appendFileSync(test.recordFile, `${JSON.stringify({ url: href, at: Date.now() })}\n`);
    return true;
  }
  try {
    await shell.openExternal(href);
    return true;
  } catch {
    return false;
  }
}

// A page can send addresses to the system browser without any click (a
// script setting location or calling window.open), which a browser's popup
// blocker would stop. A few in a short time pass, as a person clicking links
// does; past that each one is asked about, one question at a time, and
// whatever the page sends while the question is open is dropped.
export const PAGE_OPEN_BUDGET = 4;
export const PAGE_OPEN_WINDOW_MS = 10_000;
let recentPageOpens = [];
let asking = false;

function describe(href) {
  const url = new URL(href);
  return url.protocol === 'mailto:' ? `an email to ${decodeURIComponent(url.pathname) || 'someone'}` : url.host;
}

/** Opens an address a web page asked for, within the budget above. `parent` is the page's window. */
export async function openFromPage(raw, parent) {
  const href = externalUrl(raw);
  if (!href) return false;
  const now = Date.now();
  recentPageOpens = recentPageOpens.filter((t) => now - t < PAGE_OPEN_WINDOW_MS);
  if (recentPageOpens.length < PAGE_OPEN_BUDGET) {
    recentPageOpens.push(now);
    return openExternal(href);
  }
  if (asking) return false;
  asking = true;
  try {
    const options = {
      type: 'question',
      title: 'Open in Your Browser?',
      message: `The page wants to open ${describe(href)} in your browser.`,
      detail: 'It has opened several addresses in a short time.',
      buttons: ['Open', 'Don’t Open'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return false;
    recentPageOpens = [Date.now()];
    return openExternal(href);
  } finally {
    asking = false;
  }
}
