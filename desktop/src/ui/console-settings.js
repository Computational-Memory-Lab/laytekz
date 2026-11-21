// Console settings (V2, WP17): each control saves as soon as it changes.
'use strict';

(() => {
  const api = window.laytekzConsole;
  const form = document.getElementById('form');

  function show(settings) {
    if (!settings) return;
    form.enabled.checked = !!settings.enabled;
    form.agents.checked = settings.agents !== false;
    if (document.activeElement !== form.shell) form.shell.value = settings.shell ?? '';
    if (document.activeElement !== form.fontSize) form.fontSize.value = String(settings.fontSize);
    if (document.activeElement !== form.scrollback) form.scrollback.value = String(settings.scrollback);
    form.cursorStyle.value = settings.cursorStyle;
  }

  async function save(key, value) {
    const next = await api.setSetting(key, value);
    if (next) show(next);
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  form.enabled.addEventListener('change', () => save('enabled', form.enabled.checked));
  form.agents.addEventListener('change', () => save('agents', form.agents.checked));
  form.shell.addEventListener('change', () => save('shell', form.shell.value));
  form.fontSize.addEventListener('change', () => save('fontSize', Number.parseInt(form.fontSize.value, 10)));
  form.scrollback.addEventListener('change', () => save('scrollback', Number.parseInt(form.scrollback.value, 10)));
  form.cursorStyle.addEventListener('change', () => save('cursorStyle', form.cursorStyle.value));

  api.getSettings().then((s) => {
    show(s);
    document.body.dataset.ready = '1';
  });
})();
