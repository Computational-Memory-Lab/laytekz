// Desktop app settings (V2, WP41). Each control saves as soon as it changes;
// the server address saves on Connect. location.hash names the part to show
// (#server from Change Server…, #bib from File → Linked .bib files…).
'use strict';

(() => {
  const api = window.laytekz;
  const $ = (id) => document.getElementById(id);
  let current = null;
  let defaultUrl = '';

  const pct = (f) => `${Math.round(f * 100)}%`;
  const ago = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };

  function say(el, text, tone) {
    el.textContent = text || '';
    el.classList.toggle('error', tone === 'error');
    el.classList.toggle('ok', tone === 'ok');
  }

  function show(state) {
    if (!state) return;
    current = state;
    defaultUrl = state.server.defaultUrl;
    const url = $('server-url');
    if (document.activeElement !== url && !url.dataset.dirty) url.value = state.server.current ?? '';

    $('login-row').hidden = !state.openAtLogin.supported;
    $('open-at-login').checked = !!state.openAtLogin.value;
    $('login-hint').hidden = !state.openAtLogin.supported || state.openAtLogin.applies;
    for (const radio of document.querySelectorAll('input[name="launch"]')) radio.checked = radio.value === state.launch.value;
    $('launch-hint').textContent = state.launch.last
      ? `The last project on this server: ${state.launch.last}`
      : 'No project has been opened on this server yet.';

    const zoom = $('zoom-select');
    const choices = [...state.zoom.choices];
    if (!choices.includes(state.zoom.value)) choices.push(state.zoom.value);
    choices.sort((a, b) => a - b);
    zoom.replaceChildren(...choices.map((f) => {
      const o = document.createElement('option');
      o.value = String(f);
      o.textContent = f === 1 ? '100% (actual size)' : pct(f);
      return o;
    }));
    zoom.value = String(state.zoom.value);

    const sp = state.spelling;
    $('spelling-mac').hidden = sp.supported;
    $('spelling-list').hidden = !sp.supported;
    $('spelling-hint').hidden = !sp.supported;
    if (sp.supported) {
      const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([navigator.language], { type: 'language' }) : null;
      $('spelling-list').replaceChildren(...sp.available.map((lang) => {
        const label = document.createElement('label');
        label.className = 'row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = lang;
        box.checked = sp.selected.includes(lang);
        box.dataset.testid = `desktop-spelling-${lang}`;
        box.addEventListener('change', saveSpelling);
        const text = document.createElement('span');
        let name = lang;
        try { name = names ? `${names.of(lang)} (${lang})` : lang; } catch { /* keep the code */ }
        text.textContent = name;
        label.append(box, text);
        return label;
      }));
    }

    const list = $('bib-list');
    const links = state.bib.links;
    $('bib-empty').hidden = links.length > 0;
    list.replaceChildren(...links.map((link) => {
      const li = document.createElement('li');
      li.dataset.testid = 'desktop-bib-link';
      li.dataset.key = link.key;
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${link.name} → ${link.bibFile}`;
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = `${link.file} · project ${link.projectId}${link.branch !== 'main' ? `, branch ${link.branch}` : ''}${link.server !== state.server.current ? ` on ${link.server}` : ''}`;
      const status = document.createElement('div');
      status.className = 'status';
      status.dataset.testid = 'desktop-bib-status';
      if (link.state === 'error') {
        status.classList.add('error');
        status.textContent = link.error;
      } else if (link.state === 'pushing') {
        status.textContent = 'Uploading…';
      } else if (!link.watching) {
        status.textContent = link.server !== state.server.current ? 'Watched only while Laytekz is connected to that server.' : 'Not watched.';
      } else {
        status.textContent = link.pushedAt ? `Uploaded ${ago(link.pushedAt)}` : 'Watching for changes.';
      }
      const actions = document.createElement('div');
      actions.className = 'actions';
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.textContent = 'Upload now';
      upload.dataset.testid = 'desktop-bib-push';
      upload.disabled = !link.watching;
      upload.addEventListener('click', () => bibAction('bib-push', link.key, upload));
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.textContent = 'Unlink';
      unlink.dataset.testid = 'desktop-bib-unlink';
      unlink.addEventListener('click', () => bibAction('bib-unlink', link.key, unlink));
      actions.append(upload, unlink);
      li.append(name, actions, where, status);
      return li;
    }));
  }

  async function set(key, value) {
    const out = await api.action('set', { key, value });
    if (out?.state) show(out.state);
  }

  function saveSpelling() {
    const picked = [...$('spelling-list').querySelectorAll('input:checked')].map((b) => b.value);
    if (picked.length > 8) {
      this.checked = false;
      return;
    }
    set('spellLanguages', picked);
  }

  async function bibAction(name, key, button) {
    button.disabled = true;
    say($('bib-message'), name === 'bib-push' ? 'Uploading…' : 'Unlinking…');
    const out = await api.action(name, key);
    if (out?.state) show(out.state);
    if (!out) say($('bib-message'), '');
    else if (!out.ok) say($('bib-message'), out.error, 'error');
    else if (out.warning) say($('bib-message'), out.warning, 'error');
    else say($('bib-message'), name === 'bib-push' ? (out.unchanged ? 'Already up to date.' : 'Uploaded.') : 'Unlinked. The project keeps its copy of the file.', 'ok');
    button.disabled = false;
  }

  // ----------------------------------------------------------------- server

  $('server-url').addEventListener('input', () => { $('server-url').dataset.dirty = '1'; });
  $('server-default').addEventListener('click', () => {
    $('server-url').value = defaultUrl;
    $('server-url').dataset.dirty = '1';
    say($('server-message'), '');
    $('server-url').focus();
  });
  $('server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('server-url');
    for (const id of ['server-url', 'server-save', 'server-default']) $(id).disabled = true;
    say($('server-message'), `Checking ${input.value.trim() || 'the address'}…`);
    const out = await api.action('server-save', input.value);
    for (const id of ['server-url', 'server-save', 'server-default']) $(id).disabled = false;
    if (!out) return;
    if (!out.ok) {
      say($('server-message'), out.error, 'error');
      input.focus();
    } else if (out.same) {
      delete input.dataset.dirty;
      say($('server-message'), `Already connected to ${out.url}.`, 'ok');
    } else if (out.switched) {
      delete input.dataset.dirty;
      say($('server-message'), `Connected to ${out.url}.`, 'ok');
    } else {
      delete input.dataset.dirty;
      say($('server-message'), `Laytekz restarts to connect to ${out.url}.`, 'ok');
    }
  });

  // ------------------------------------------------------------- the rest

  $('open-at-login').addEventListener('change', () => set('openAtLogin', $('open-at-login').checked));
  for (const radio of document.querySelectorAll('input[name="launch"]')) {
    radio.addEventListener('change', () => { if (radio.checked) set('launch', radio.value); });
  }
  $('zoom-select').addEventListener('change', () => set('zoomFactor', Number($('zoom-select').value)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') api.action('close');
  });

  function goTo() {
    const part = location.hash.slice(1);
    const section = part && document.getElementById(part);
    if (!section || section.tagName !== 'SECTION') return;
    section.scrollIntoView({ block: 'start' });
    section.classList.remove('flash');
    void section.offsetWidth;
    section.classList.add('flash');
    if (part === 'server') {
      $('server-url').focus();
      $('server-url').select();
    }
  }
  window.addEventListener('hashchange', goTo);

  api.onState(show);
  api.state().then((state) => {
    show(state);
    goTo();
    document.body.dataset.ready = '1';
  });
  // Upload times stay fresh while the window is open.
  setInterval(() => { if (current && current.bib.links.length && !document.hidden) api.state().then(show); }, 30_000);
})();
