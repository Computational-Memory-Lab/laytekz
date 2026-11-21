// The console page (V2, WP17): tabs of terminals drawn by xterm.js. The shells
// run in the main app (window.laytekzConsole, src/preload/console.cjs); this
// page only draws their output, as text, and sends keys back.
'use strict';

(() => {
  const api = window.laytekzConsole;
  const tabsEl = document.querySelector('[data-testid="console-tabs"]');
  const termsEl = document.querySelector('[data-testid="console-terminals"]');
  const offEl = document.querySelector('[data-testid="console-off"]');
  const isWindow = location.hash === '#window';
  document.body.classList.toggle('is-window', isWindow);

  /** id → {id, term, fit, el, tab, nameEl, exited, pendingAck, ackTimer} */
  const tabs = new Map();
  let active = null;
  let settings = null;
  let creating = false;

  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const THEMES = {
    dark: {
      background: '#1c1c1e', foreground: '#e6e6ea', cursor: '#e6e6ea', cursorAccent: '#1c1c1e',
      selectionBackground: 'rgba(91, 155, 255, 0.35)',
    },
    light: {
      background: '#ffffff', foreground: '#1c1c1e', cursor: '#1c1c1e', cursorAccent: '#ffffff',
      selectionBackground: 'rgba(52, 120, 246, 0.25)',
      black: '#000000', red: '#c41a16', green: '#007400', yellow: '#826b28', blue: '#0e4fd8',
      magenta: '#a90d91', cyan: '#3f6e74', white: '#8e8e93',
      brightBlack: '#5f5f66', brightRed: '#e0301e', brightGreen: '#1f8f1f', brightYellow: '#9a7b15',
      brightBlue: '#3478f6', brightMagenta: '#c93cb1', brightCyan: '#2f8f9d', brightWhite: '#c7c7cc',
    },
  };
  const theme = () => (dark.matches ? THEMES.dark : THEMES.light);
  const FONT = '"SF Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

  function termOptions() {
    return {
      fontFamily: FONT,
      fontSize: settings?.fontSize ?? 13,
      scrollback: settings?.scrollback ?? 5000,
      cursorStyle: settings?.cursorStyle ?? 'block',
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: false,
      theme: theme(),
      // OSC 8 hyperlinks: web pages only, opened in the browser by the app.
      linkHandler: { activate: (_event, uri) => api.openLink(uri), allowNonHttpProtocols: false },
    };
  }

  function addTab(info) {
    const el = document.createElement('div');
    el.className = 'console-term';
    el.dataset.testid = 'console-terminal';
    el.dataset.session = info.id;
    termsEl.appendChild(el);

    const term = new window.Terminal(termOptions());
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_event, uri) => api.openLink(uri)));
    term.open(el);

    const tab = document.createElement('div');
    tab.className = 'console-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.testid = 'console-tab';
    tab.dataset.session = info.id;
    const nameEl = document.createElement('span');
    nameEl.className = 'console-tab-name';
    nameEl.textContent = info.title || 'Terminal';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'console-tab-close';
    close.dataset.testid = 'console-tab-close';
    close.title = 'Close this terminal';
    close.setAttribute('aria-label', 'Close this terminal');
    close.textContent = '×';
    tab.append(nameEl, close);
    tabsEl.appendChild(tab);

    const t = { id: info.id, term, fit, el, tab, nameEl, exited: !!info.exited, pendingAck: 0, ackTimer: null, kind: info.kind || null };
    if (t.kind) tab.dataset.kind = t.kind;
    tabs.set(info.id, t);
    tab.classList.toggle('is-exited', t.exited);

    tab.addEventListener('mousedown', (e) => {
      if (e.target !== close) {
        e.preventDefault();
        select(info.id);
      }
    });
    close.addEventListener('click', () => closeTab(info.id));

    term.onData((data) => {
      if (t.exited) {
        if (data.includes('\r')) restart(t);
        return;
      }
      api.input(t.id, data);
    });
    term.onBinary((data) => {
      if (!t.exited) api.input(t.id, data);
    });
    term.onResize(({ cols, rows }) => api.resize(t.id, cols, rows));
    return t;
  }

  async function restart(t) {
    if (await api.restart(t.id)) {
      t.exited = false;
      t.tab.classList.remove('is-exited');
      t.term.reset();
      api.resize(t.id, t.term.cols, t.term.rows);
    }
  }

  function fitActive() {
    if (!active) return;
    const t = tabs.get(active);
    if (!t || t.el.hidden) return;
    try {
      t.fit.fit();
    } catch {
      // Not laid out yet.
    }
  }

  function select(id) {
    if (!tabs.has(id)) return;
    active = id;
    for (const t of tabs.values()) {
      const on = t.id === id;
      t.el.hidden = !on;
      t.tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    fitActive();
    tabs.get(id).term.focus();
  }

  function removeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    clearTimeout(t.ackTimer);
    t.term.dispose();
    t.el.remove();
    t.tab.remove();
    tabs.delete(id);
    if (active === id) {
      active = null;
      const next = [...tabs.keys()].pop();
      if (next) select(next);
    }
  }

  async function closeTab(id) {
    await api.close(id);
    removeTab(id);
    if (!tabs.size) api.panel('hide');
  }

  /** A size for a new shell before its terminal exists: what the active one has, or a guess from the page. */
  function guessSize() {
    const t = active && tabs.get(active);
    if (t) return { cols: t.term.cols, rows: t.term.rows };
    const cellW = (settings?.fontSize ?? 13) * 0.6;
    const cellH = (settings?.fontSize ?? 13) * 1.2;
    return {
      cols: Math.max(20, Math.floor((termsEl.clientWidth - 16) / cellW)),
      rows: Math.max(5, Math.floor((termsEl.clientHeight - 8) / cellH)),
    };
  }

  async function newTab() {
    if (creating) return null;
    creating = true;
    try {
      const { cols, rows } = guessSize();
      const info = await api.create(cols, rows);
      if (!info) return null;
      const t = tabs.get(info.id) ?? addTab(info);
      select(t.id);
      api.resize(t.id, t.term.cols, t.term.rows);
      return t;
    } finally {
      creating = false;
    }
  }

  // ---- ▶ Claude Code / ▶ Codex (V2, WP25). Main does the work (agents.js):
  // it checks the project and the server, finds the tool, asks for consent,
  // and opens the agent's tab; this page shows its answer.
  const agentsEl = document.querySelector('[data-testid="console-agents"]');
  const agentButtons = [...document.querySelectorAll('.console-agent')];
  const card = document.querySelector('[data-testid="console-agent-card"]');
  const cardTitle = document.querySelector('[data-testid="console-agent-card-title"]');
  const cardText = document.querySelector('[data-testid="console-agent-card-text"]');
  const cardCommands = document.querySelector('[data-testid="console-agent-card-commands"]');
  const checkAgain = document.querySelector('[data-testid="console-agent-check"]');
  const LABELS = { claude: 'Claude Code', codex: 'Codex' };
  let cardKind = null;

  function hideCard() {
    card.hidden = true;
    cardKind = null;
  }

  function showCard({ title = '', text = '', commands = [], kind = null }) {
    cardTitle.textContent = title;
    cardText.textContent = text;
    cardCommands.replaceChildren();
    for (const command of commands) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = command;
      code.dataset.testid = 'console-agent-command';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'console-text';
      copy.dataset.testid = 'console-agent-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        if (await api.copy(command)) {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }
      });
      const typeIt = document.createElement('button');
      typeIt.type = 'button';
      typeIt.className = 'console-text';
      typeIt.dataset.testid = 'console-agent-type';
      typeIt.textContent = 'Type it into the console';
      typeIt.title = 'Puts the command in a terminal without running it';
      typeIt.addEventListener('click', () => typeIntoShell(command));
      li.append(code, copy, typeIt);
      cardCommands.appendChild(li);
    }
    cardKind = kind;
    checkAgain.hidden = !kind;
    card.hidden = false;
    fitActive();
  }

  /** Puts text in a shell tab (the active one, or a new one) without pressing Enter. */
  async function typeIntoShell(text) {
    let t = active && tabs.get(active);
    if (!t || t.kind || t.exited) t = await newTab();
    if (!t) return;
    select(t.id);
    api.input(t.id, text);
  }

  let agentStatus = null;
  async function refreshAgents() {
    agentStatus = await api.agentStatus().catch(() => null);
    agentsEl.hidden = !agentStatus || !agentStatus.enabled;
    for (const button of agentButtons) {
      const label = LABELS[button.dataset.kind];
      const reason = agentStatus?.reason;
      button.setAttribute('aria-disabled', reason ? 'true' : 'false');
      button.title = reason || `Start ${label} on this project`;
    }
  }

  async function launchAgent(kind) {
    const button = agentButtons.find((b) => b.dataset.kind === kind);
    if (!button || button.classList.contains('is-busy')) return;
    button.classList.add('is-busy');
    try {
      const { cols, rows } = guessSize();
      const res = await api.launchAgent(kind, cols, rows);
      if (!res) return;
      if (res.ok && res.session) {
        hideCard();
        const t = tabs.get(res.session.id) ?? addTab(res.session);
        select(t.id);
        api.resize(t.id, t.term.cols, t.term.rows);
      } else if (res.install) {
        showCard({ title: res.install.title, text: res.install.text, commands: res.install.commands, kind });
      } else if (res.reason) {
        showCard({ title: `${LABELS[kind]} cannot start here.`, text: res.reason });
      }
    } finally {
      button.classList.remove('is-busy');
      refreshAgents();
    }
  }

  for (const button of agentButtons) button.addEventListener('click', () => launchAgent(button.dataset.kind));
  checkAgain.addEventListener('click', () => {
    if (cardKind) launchAgent(cardKind);
  });
  document.querySelector('[data-testid="console-agent-card-close"]').addEventListener('click', () => hideCard());

  function ackLater(t, chars) {
    t.pendingAck += chars;
    if (t.ackTimer) return;
    t.ackTimer = setTimeout(() => {
      t.ackTimer = null;
      const n = t.pendingAck;
      t.pendingAck = 0;
      if (n) api.ack(t.id, n);
    }, 40);
  }

  api.onData((id, data) => {
    const t = tabs.get(id);
    if (!t || !data) return;
    t.term.write(data, () => ackLater(t, data.length));
  });
  api.onExit((id) => {
    const t = tabs.get(id);
    if (!t) return;
    t.exited = true;
    t.tab.classList.add('is-exited');
  });
  api.onTitle((id, title) => {
    const t = tabs.get(id);
    if (t) t.nameEl.textContent = title || 'Terminal';
  });
  api.onSettings((next) => {
    settings = next;
    if (!next.enabled) {
      offEl.hidden = false;
      return;
    }
    refreshAgents();
    for (const t of tabs.values()) {
      t.term.options.fontSize = next.fontSize;
      t.term.options.scrollback = next.scrollback;
      t.term.options.cursorStyle = next.cursorStyle;
    }
    fitActive();
  });
  api.onFocus(() => {
    refreshAgents();
    if (!tabs.size) newTab();
    else if (active) {
      fitActive();
      tabs.get(active).term.focus();
    }
  });
  dark.addEventListener('change', () => {
    for (const t of tabs.values()) t.term.options.theme = theme();
  });
  new ResizeObserver(() => fitActive()).observe(termsEl);

  document.querySelector('[data-testid="console-new-tab"]').addEventListener('click', () => newTab());
  document.querySelector('[data-testid="console-hide"]').addEventListener('click', () => api.panel('hide'));
  document.querySelector('[data-testid="console-popout"]').addEventListener('click', () => api.panel('popout'));
  document.querySelector('[data-testid="console-dock"]').addEventListener('click', () => api.panel('dock'));
  document.querySelector('[data-testid="console-settings"]').addEventListener('click', () => api.panel('settings'));

  // The drag handle above the bar resizes the docked panel.
  const grip = document.querySelector('[data-testid="console-resize"]');
  grip.addEventListener('pointerdown', (e) => {
    if (isWindow || e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-dragging');
    api.panel('drag-start', e.screenY);
  });
  grip.addEventListener('pointermove', (e) => {
    if (grip.hasPointerCapture(e.pointerId)) api.panel('drag-move', e.screenY);
  });
  const endDrag = (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    grip.classList.remove('is-dragging');
    api.panel('drag-end');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  async function boot() {
    const hello = await api.hello();
    if (!hello) {
      offEl.hidden = false;
      return;
    }
    settings = hello.settings;
    await refreshAgents();
    for (const info of hello.sessions) {
      const t = addTab(info);
      const replay = await api.replay(info.id);
      if (replay) t.term.write(replay);
    }
    if (hello.sessions.length) select(hello.sessions[hello.sessions.length - 1].id);
    else await newTab();
    document.body.dataset.ready = '1';
  }

  boot();
})();
