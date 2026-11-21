// A shell feature for the tests only: tests/shell.spec.mjs launches the app
// with LAYTEKZ_TEST_SHELL_FEATURES pointing here (honoured only from source
// in test mode), and the host appends it to SHELL_FEATURES. It touches every
// part of the ShellFeature/ShellCtx contract (src/main/features/index.js) the
// way a real feature would. The leading underscore keeps mock-server.mjs from
// loading it as a server mock.
//
// It uses offline.html as its page (the tests cannot add files under
// src/ui): in its own partition, with the shared ui.cjs preload and a CSP of
// its own. Its state makes the page read "Can't reach probe-host".

export const PROBE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'";
export const PROBE_PARTITION = 'laytekz-probe';

const probe = {
  id: 'probe',
  menu: [
    { where: 'app', item: { id: 'probe-app', label: 'Probe App Item', click: () => record('menu:app') } },
    // Cmd/Ctrl+Shift+E is Insert citation in the web UI: the host drops the accelerator, keeps the item.
    { where: 'file', item: { id: 'probe-file', label: 'Probe File Item', accelerator: 'CommandOrControl+Shift+E', click: () => record('menu:file') } },
    { where: 'view', item: { id: 'probe-view', label: 'Probe Overlay', accelerator: 'Control+`', click: () => toggleOverlay() } },
    { where: 'help', item: { id: 'probe-help', label: 'Probe Help Item', click: () => { throw new Error('a probe menu item that throws'); } } },
    { where: 'nowhere', item: { id: 'probe-bad', label: 'Never shown' } },
  ],
  pages: {
    'offline.html': { partition: PROBE_PARTITION, preload: 'ui.cjs', csp: PROBE_CSP },
  },
  vetoPermissions: ['clipboard-sanitized-write'],
  start(ctx) {
    const self = globalThis.laytekzProbe;
    self.ctx = ctx;
    self.started.push({
      server: ctx.server(),
      mainWindow: !!ctx.mainWindow(),
      mainWindowUrl: ctx.mainWindow()?.webContents.getURL() ?? null,
    });
    ctx.settings.set('startedWith', ctx.server());
    ctx.ipc.handle('ui:get-state', () => ({
      host: 'probe-host', reason: 'The probe feature answered.', nextRetryAt: Date.now() + 60_000, checking: false,
    }), { pages: ['offline.html'] });
    ctx.ipc.handle('ui:action', (_event, name, payload) => {
      record(`action:${name}`, payload);
      return 'probe-ok';
    }, { pages: ['offline.html'] });
    self.removeEcho = ctx.ipc.handle('probe:echo', (_event, value) => value, { pages: ['offline.html'] });
    return () => {
      ctx.settings.set('stopped', true);
    };
  },
};

// A second feature that fails to start: the host must report it and carry on.
const broken = {
  id: 'probeBroken',
  menu: [{ where: 'help', item: { id: 'probe-broken-help', label: 'Broken Help Item' } }],
  vetoPermissions: ['probe-only-permission'],
  start() {
    throw new Error('the probe feature that fails on purpose');
  },
};

globalThis.laytekzProbe = { ctx: null, started: [], events: [], overlay: null };

function record(name, payload = null) {
  globalThis.laytekzProbe.events.push({ name, payload });
}

function toggleOverlay() {
  const self = globalThis.laytekzProbe;
  if (!self.overlay) {
    self.overlay = self.ctx.overlay('offline.html', { bounds: (width, height) => ({ x: 0, y: height - 200, width, height: 200 }) });
  }
  if (self.overlay.visible) self.overlay.hide();
  else self.overlay.show();
  record(`overlay:${self.overlay.visible ? 'shown' : 'hidden'}`);
}

export default [probe, broken];
