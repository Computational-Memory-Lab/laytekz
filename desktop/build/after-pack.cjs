// electron-builder afterPack hook (Galley: V2 console, WP17).
// node-pty 1.1.0 ships spawn-helper without its execute bit, which makes every
// spawn fail with "posix_spawnp failed"; set it to 755. Keep only the target's
// prebuild, and fail the build when it is missing, so a package never ships a
// console that cannot start.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ARCHS = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = ARCHS[context.arch] ?? String(context.arch);
  const ptyDir = path.join(resourcesDir(context), 'app.asar.unpacked', 'node_modules', 'node-pty');
  const prebuilds = path.join(ptyDir, 'prebuilds');
  if (!fs.existsSync(prebuilds)) throw new Error(`after-pack: node-pty prebuilds are missing (${prebuilds})`);

  const wanted = arch === 'universal' ? [`${platform}-x64`, `${platform}-arm64`] : [`${platform}-${arch}`];
  for (const dir of wanted) {
    const full = path.join(prebuilds, dir);
    const needed = platform === 'win32' ? ['pty.node', 'conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'] : ['pty.node', 'spawn-helper'];
    for (const file of needed) {
      if (!fs.existsSync(path.join(full, file))) throw new Error(`after-pack: node-pty prebuild file ${dir}/${file} is missing`);
    }
    if (platform !== 'win32') fs.chmodSync(path.join(full, 'spawn-helper'), 0o755);
  }
  for (const dir of fs.readdirSync(prebuilds)) {
    if (!wanted.includes(dir)) fs.rmSync(path.join(prebuilds, dir), { recursive: true, force: true });
  }
};
