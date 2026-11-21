// A small JSON settings file in the profile folder: the chosen server and the window state.

import { app } from 'electron';
import { MOVED_SERVERS } from './env.js';
import fs from 'node:fs';
import path from 'node:path';

let cache = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings() {
  if (cache) return cache;
  try {
    let text = fs.readFileSync(file(), 'utf8');
    // A server that moved: every saved value and key naming its old address
    // (the server, per-server preferences, linked .bib files) follows it.
    let moved = false;
    for (const [from, to] of Object.entries(MOVED_SERVERS)) {
      if (text.includes(from)) { text = text.split(from).join(to); moved = true; }
    }
    const parsed = JSON.parse(text);
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    if (moved) saveSettings({});
  } catch {
    cache = {};
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...loadSettings(), ...patch };
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('Laytekz: could not save settings:', err.message);
  }
  return cache;
}
