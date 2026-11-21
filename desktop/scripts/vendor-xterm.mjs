#!/usr/bin/env node
// Copies the pinned xterm.js builds (devDependencies) into src/ui as flat
// files, so protocol.js's flat-name rule holds and the app needs no bundler.
// Run after changing an @xterm/* version: `npm run vendor:xterm`.
// Galley: V2 console (WP17).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ui = path.join(root, 'src', 'ui');

const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'console-xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'console-xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'console-xterm-addon-fit.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'console-xterm-addon-web-links.js'],
];

for (const [from, to] of FILES) {
  const [scope, name] = from.split('/');
  const pkgDir = path.dirname(require.resolve(`${scope}/${name}/package.json`));
  const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const src = path.join(pkgDir, from.split('/').slice(2).join('/'));
  let text = fs.readFileSync(src, 'utf8');
  // The source maps are not shipped; drop the comment that points at them.
  text = text.replace(/\n?\/[/*][#@] sourceMappingURL=.*$/m, '');
  const banner = `/* ${scope}/${name} ${version} (MIT), vendored by scripts/vendor-xterm.mjs. Do not edit. */\n`;
  fs.writeFileSync(path.join(ui, to), banner + text);
  console.log(`${to} <- ${scope}/${name}@${version}`);
}
