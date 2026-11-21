// ▶ Claude Code / ▶ Codex in the console (V2, WP25). In plain Node: the
// commands never carry a bypass flag or the token, mcp.json reads
// ${LAYTEKZ_TOKEN}, detection, the reasons the buttons give, and the token
// store. In the app: fake agents on a test PATH see the token only in their
// environment, a plain shell never gets it, a missing tool shows the install
// card (Check again finds it once installed), and with MCP off the buttons
// say why.

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENTS, REASONS, agentArgs, agentEnv, agentPrompt, blockedReason, claudeMcpConfig, codexConfigArgs, consentKey,
  detectAgent, findInDirs, hasBypassFlag, installCard, mcpUrl, projectKey, spawnSpec, writeAgentFiles,
} from '../src/main/features/console/agents.js';
import { createTokenStore, tokenName } from '../src/main/features/console/tokens.js';
import { checkSetting, CONSOLE_DEFAULTS } from '../src/main/features/console/shell-env.js';
import { clickMenuItem, launchApp, until } from './helpers.mjs';
import { DEFAULT_CAPABILITIES, TEST_USER, startMockServer } from './mock-server.mjs';

const SERVER = 'https://latex.example.test';
const TOKEN = 'aldn_secret_token_value_123';

async function fakeBin(dir, name) {
  const file = path.join(dir, name);
  // Records its arguments (NUL-separated), environment and folder, then waits.
  await fs.writeFile(file, `#!/bin/sh
rec="$FAKE_AGENT_RECORD.${name}"
for a in "$@"; do printf '%s\\0' "$a"; done > "$rec.args"
env > "$rec.env"
pwd > "$rec.cwd"
echo "fake-${name}-ready"
exec sleep 120
`, { mode: 0o755 });
  return file;
}

// ------------------------------------------------------------ plain Node

test.describe('agent launch logic (no Electron)', () => {
  test('commands: Claude Code gets mcp.json and the prompt file; Codex its -c keys; never a bypass flag or the token', () => {
    const claude = agentArgs('claude', { serverBase: SERVER, mcpConfigPath: '/u/agents/k/mcp.json', promptPath: '/u/agents/k/prompt.md', prompt: 'p' });
    expect(claude).toEqual(['--mcp-config', '/u/agents/k/mcp.json', '--append-system-prompt-file', '/u/agents/k/prompt.md']);
    expect(claude).not.toContain('--strict-mcp-config');
    const prompt = agentPrompt({ projectName: 'Thesis', projectId: 'abc123', branch: 'main', serverBase: SERVER });
    const codex = agentArgs('codex', { serverBase: SERVER, mcpConfigPath: 'x', promptPath: 'y', prompt });
    expect(codex.slice(0, 6)).toEqual(codexConfigArgs(SERVER));
    expect(codex).toContain(`mcp_servers.laytekz.url="${SERVER}/mcp"`);
    expect(codex).toContain('mcp_servers.laytekz.bearer_token_env_var="LAYTEKZ_TOKEN"');
    expect(codex).toContain('mcp_servers.laytekz.http_headers={"X-Laytekz-Agent"="codex"}');
    expect(codex.at(-1)).toBe(prompt);
    for (const args of [claude, codex]) {
      expect(hasBypassFlag(args)).toBe(false);
      expect(args.join(' ')).not.toContain(TOKEN);
      expect(args.join(' ')).not.toMatch(/dangerously|bypass|--yolo|--full-auto|--permission-mode/);
    }
    expect(prompt).toContain('project "abc123" and branch "main"');
    expect(() => agentArgs('other', {})).toThrow();
  });

  test('bypass flags are recognised wherever they would appear', () => {
    for (const bad of [
      ['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=acceptEdits'],
      ['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'], ['--full-auto'], ['-s', 'danger-full-access'],
      ['-a', 'never'], ['-c', 'approval_policy="never"'], ['-c', 'sandbox_mode="danger-full-access"'],
    ]) expect(hasBypassFlag(bad), bad.join(' ')).toBe(true);
    expect(hasBypassFlag(['--mcp-config', '/Users/sandbox/bypass/mcp.json'])).toBe(false);
  });

  test('mcp.json and prompt.md: the token stays a ${LAYTEKZ_TOKEN} reference, the work folder starts empty', async () => {
    expect(claudeMcpConfig(`${SERVER}/`)).toEqual({
      mcpServers: { laytekz: { type: 'http', url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer ${LAYTEKZ_TOKEN}', 'X-Laytekz-Agent': 'claude' } } },
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-agents-'));
    try {
      const files = writeAgentFiles(path.join(root, projectKey(SERVER, 'abc123')), { serverBase: SERVER, prompt: 'hello' });
      const text = await fs.readFile(files.mcpConfigPath, 'utf8');
      expect(text).toContain('Bearer ${LAYTEKZ_TOKEN}');
      expect(await fs.readFile(files.promptPath, 'utf8')).toBe('hello');
      expect(await fs.readdir(files.work)).toEqual([]);
      expect(path.dirname(files.mcpConfigPath)).toBe(path.dirname(files.work));
      if (process.platform !== 'win32') expect((await fs.stat(files.mcpConfigPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    expect(projectKey(SERVER, 'abc123')).toMatch(/^latex\.example\.test-abc123-[0-9a-f]{8}$/);
    expect(consentKey(`${SERVER}/`, 'abc123')).toBe(`${SERVER}|abc123`);
    expect(mcpUrl(`${SERVER}//`)).toBe(`${SERVER}/mcp`);
  });

  test('the environment: the token and project only for the agent, without Electron\'s variables', () => {
    const env = agentEnv({ PATH: '/usr/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', LAYTEKZ_TEST_MODE: '1' },
      { token: TOKEN, serverBase: SERVER, projectId: 'abc123', branch: 'main', pathValue: '/opt/bin:/usr/bin' });
    expect(env).toMatchObject({ LAYTEKZ_TOKEN: TOKEN, LAYTEKZ_URL: SERVER, LAYTEKZ_PROJECT: 'abc123', LAYTEKZ_BRANCH: 'main', PATH: '/opt/bin:/usr/bin', HOME: '/h' });
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LAYTEKZ_TEST_MODE']) expect(env[key]).toBeUndefined();
  });

  test('detection: the test folder only; non-executable files do not count; Windows .cmd shims run through cmd.exe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-bin-'));
    try {
      expect(await detectAgent('claude', { testBinDir: dir })).toBeNull();
      await fs.writeFile(path.join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o644 });
      if (process.platform !== 'win32') expect(findInDirs('codex', [dir])).toBeNull();
      const file = await fakeBin(dir, 'claude');
      expect(await detectAgent('claude', { testBinDir: dir })).toEqual({ file, pathValue: `${dir}:/usr/bin:/bin` });
      // Outside tests: the login shell's PATH, then the usual folders.
      const found = await detectAgent('claude', { platform: 'linux', home: '/nonexistent', env: {}, loginPath: async () => `/nowhere:${dir}` });
      expect(found).toEqual({ file, pathValue: `/nowhere:${dir}` });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(spawnSpec('/usr/local/bin/claude', ['--x'], 'darwin')).toEqual({ file: '/usr/local/bin/claude', args: ['--x'] });
    expect(spawnSpec('C:\\npm\\codex.cmd', ['-c', 'a b'], 'win32').args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });

  test('the buttons say why they cannot start: no project, an old server, MCP off, no accounts, or turned off', () => {
    const project = { id: 'abc123', branch: 'main' };
    const caps = { ...DEFAULT_CAPABILITIES, mcp: true };
    expect(blockedReason({ project: null, capabilities: caps })).toBe(REASONS.noProject);
    expect(blockedReason({ project, capabilities: null })).toBe(REASONS.oldServer);
    expect(blockedReason({ project, capabilities: { ...caps, mcp: false } })).toBe(REASONS.mcpOff);
    expect(blockedReason({ project, capabilities: { ...caps, accounts: false } })).toBe(REASONS.noAccounts);
    expect(blockedReason({ enabled: false, project, capabilities: caps })).toBe(REASONS.hidden);
    expect(blockedReason({ project, capabilities: caps })).toBeNull();
    expect(installCard('claude', 'darwin').commands).toEqual(AGENTS.claude.install.darwin);
    expect(installCard('codex', 'win32').commands).toEqual(['npm install -g @openai/codex']);
    expect(CONSOLE_DEFAULTS.agents).toBe(true);
    expect(checkSetting('agents', false)).toBe(false);
    expect(checkSetting('agents', 'no')).toBeNull();
  });

  test('tokens: minted once per project through the session, kept encrypted, replaced when revoked', async () => {
    const stored = {};
    const settings = { get: (k, d) => (k in stored ? structuredClone(stored[k]) : d), set: (k, v) => { if (v === undefined) delete stored[k]; else stored[k] = structuredClone(v); } };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
      decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
    };
    const server = { tokens: [], calls: [], signedIn: true, n: 0 };
    const reply = (status, body) => ({ status, json: async () => body });
    const sessionFetch = async (p, init = {}) => {
      server.calls.push(`${init.method ?? 'GET'} ${p}`);
      if (!server.signedIn) return reply(401, { error: 'Sign in required' });
      if ((init.method ?? 'GET') === 'GET') return reply(200, server.tokens.map(({ token: _t, ...r }) => r));
      const body = JSON.parse(init.body);
      server.n += 1;
      const rec = { id: `t${server.n}`, name: body.name, projectIds: body.projectIds, expiresAt: null, token: `aldn_${server.n}` };
      server.tokens.push(rec);
      return reply(200, rec);
    };
    const store = createTokenStore({ settings, sessionFetch, safeStorage, log: () => {} });
    const first = await store.tokenFor({ serverBase: SERVER, projectId: 'abc123', projectName: 'Thesis' });
    expect(first).toEqual({ token: 'aldn_1' });
    expect(server.tokens[0]).toMatchObject({ name: 'Laytekz agents · latex.example.test · Thesis', projectIds: ['abc123'] });
    expect(JSON.stringify(stored)).not.toContain('aldn_1');
    expect(stored.agentTokens[`${SERVER}|abc123`].id).toBe('t1');

    expect(await store.tokenFor({ serverBase: SERVER, projectId: 'abc123', projectName: 'Thesis' })).toEqual({ token: 'aldn_1' });
    expect(server.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);

    server.tokens = []; // revoked on the Agent access card
    expect(await store.tokenFor({ serverBase: SERVER, projectId: 'abc123', projectName: 'Thesis' })).toEqual({ token: 'aldn_2' });
    expect(server.calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
    expect(stored.agentTokens[`${SERVER}|abc123`].id).toBe('t2');

    server.signedIn = false;
    expect(await store.tokenFor({ serverBase: SERVER, projectId: 'zzz999', projectName: 'Other' })).toEqual({ error: 'signed-out' });
    expect(tokenName(SERVER, 'x'.repeat(200)).length).toBe(100);

    // No encryption on this system: the token lives in memory for this run only.
    const plain = {};
    const memStore = createTokenStore({
      settings: { get: (k, d) => plain[k] ?? d, set: (k, v) => { plain[k] = v; } },
      sessionFetch: async (p, init = {}) => ((init.method ?? 'GET') === 'GET' ? reply(200, [{ id: 'm1' }]) : reply(200, { id: 'm1', token: 'aldn_mem' })),
      safeStorage: { isEncryptionAvailable: () => false },
      log: () => {},
    });
    expect(await memStore.tokenFor({ serverBase: SERVER, projectId: 'abc123', projectName: 'T' })).toEqual({ token: 'aldn_mem' });
    expect(plain).toEqual({});
  });
});

// ---------------------------------------------------------------- in the app

const CONSOLE_URL = 'laytekz-ui://app/console.html';

async function inConsole(app, code) {
  return app.evaluate(async ({ BrowserWindow }, [url, js]) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const pages = [win.webContents, ...win.contentView.children.map((v) => v.webContents)];
      for (const wc of pages) {
        if (wc && !wc.isDestroyed() && wc.getURL().split('#')[0] === url) return wc.executeJavaScript(js);
      }
    }
    return null;
  }, [CONSOLE_URL, code]);
}

const screenText = (app) => inConsole(app, `(() => {
  const el = document.querySelector('[data-testid="console-terminal"]:not([hidden]) .xterm-rows');
  return el ? el.innerText : '';
})()`);

async function waitForText(app, pattern, timeout = 15_000) {
  return until(async () => {
    const text = await screenText(app);
    return text && pattern.test(text) ? text : null;
  }, { timeout, message: `console text ${pattern}` });
}

const clickIn = (app, testId) => inConsole(app, `document.querySelector('[data-testid="${testId}"]').click()`);
const agentButton = (app, kind) => inConsole(app, `(() => {
  const b = document.querySelector('[data-testid="console-agent-${kind}"]');
  return { disabled: b.getAttribute('aria-disabled'), title: b.title, shown: !b.closest('[hidden]') };
})()`);
const cardState = (app) => inConsole(app, `(() => {
  const c = document.querySelector('[data-testid="console-agent-card"]');
  return { hidden: c.hidden, title: c.querySelector('[data-testid="console-agent-card-title"]').textContent,
    text: c.querySelector('[data-testid="console-agent-card-text"]').textContent,
    commands: [...c.querySelectorAll('[data-testid="console-agent-command"]')].map((e) => e.textContent) };
})()`);
const tabsNow = (app) => inConsole(app, `[...document.querySelectorAll('[data-testid="console-tab"]')].map((t) => ({ kind: t.dataset.kind || null, name: t.textContent.replace('×', '').trim(), selected: t.getAttribute('aria-selected') === 'true' }))`);

async function readRecord(prefix, name) {
  const args = (await fs.readFile(`${prefix}.${name}.args`, 'utf8')).split('\0').slice(0, -1);
  const env = Object.fromEntries((await fs.readFile(`${prefix}.${name}.env`, 'utf8')).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const cwd = (await fs.readFile(`${prefix}.${name}.cwd`, 'utf8')).trim();
  return { args, env, cwd };
}

test.describe('agent buttons in the app', () => {
  test.skip(process.platform === 'win32', 'the fake agents are shell scripts');

  test('fake agents see the token only in their environment; install card and Check again; MCP off says why', async () => {
    test.setTimeout(150_000);
    const mock = await startMockServer({ capabilities: { ...DEFAULT_CAPABILITIES, mcp: true } });
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'laytekz-agent-bin-'));
    const recPrefix = path.join(bin, 'record');
    await fakeBin(bin, 'claude');
    const ctx = await launchApp({
      serverUrl: mock.url,
      env: { LAYTEKZ_TEST_AGENT_BIN: bin, FAKE_AGENT_RECORD: recPrefix },
    });
    try {
      // Signed in: a session the mock knows, as a cookie in the window's session.
      mock.state.sessions.set('agents-session', TEST_USER);
      await ctx.app.evaluate(async ({ session }, url) => {
        await session.fromPartition('persist:laytekz').cookies.set({ url, name: 'aldine_session', value: 'agents-session' });
      }, mock.url);

      // Not on a project: the buttons say so.
      await clickMenuItem(ctx.app, 'console-toggle');
      await until(async () => (await inConsole(ctx.app, 'document.body.dataset.ready')) === '1', { message: 'the console page' });
      expect(await agentButton(ctx.app, 'claude')).toEqual({ disabled: 'true', title: REASONS.noProject, shown: true });
      await clickIn(ctx.app, 'console-agent-claude');
      await until(async () => (await cardState(ctx.app)).hidden === false, { message: 'the reason card' });
      expect((await cardState(ctx.app)).text).toBe(REASONS.noProject);
      await clickIn(ctx.app, 'console-agent-card-close');

      // On a project: Claude Code starts in its own tab.
      await ctx.page.goto(`${mock.url}/p/proj1234?branch=main`);
      await clickIn(ctx.app, 'console-agent-claude');
      await waitForText(ctx.app, /fake-claude-ready/);
      const minted = mock.state.agents.minted;
      expect(minted).toHaveLength(1);
      expect(minted[0]).toMatchObject({ name: `Laytekz agents · 127.0.0.1:${mock.port} · Thesis draft`, projectIds: ['proj1234'], origin: null });
      const token = minted[0].token;
      const claude = await readRecord(recPrefix, 'claude');
      expect(claude.env.LAYTEKZ_TOKEN).toBe(token);
      expect(claude.env).toMatchObject({ LAYTEKZ_PROJECT: 'proj1234', LAYTEKZ_BRANCH: 'main', LAYTEKZ_URL: mock.url });
      expect(claude.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(claude.args[0]).toBe('--mcp-config');
      expect(claude.args[2]).toBe('--append-system-prompt-file');
      expect(hasBypassFlag(claude.args)).toBe(false);
      expect(claude.args.join('\n')).not.toContain(token);
      // The configuration sits next to the empty work folder, under the profile, never in clear.
      const mcpText = await fs.readFile(claude.args[1], 'utf8');
      expect(mcpText).toContain('Bearer ${LAYTEKZ_TOKEN}');
      expect(mcpText).toContain(`${mock.url}/mcp`);
      expect(mcpText).not.toContain(token);
      expect(fsSync.realpathSync(claude.cwd)).toBe(fsSync.realpathSync(path.join(path.dirname(claude.args[1]), 'work')));
      expect(fsSync.realpathSync(claude.args[1]).startsWith(fsSync.realpathSync(ctx.dir))).toBe(true);
      expect(await fs.readFile(claude.args[3], 'utf8')).toContain('project "proj1234" and branch "main"');
      const settingsText = await fs.readFile(path.join(ctx.dir, 'settings.json'), 'utf8');
      expect(settingsText).not.toContain(token);
      expect(JSON.parse(settingsText).features.console.agentTokens[`${mock.url}|proj1234`].id).toBe(minted[0].id);
      const consent = (await fs.readFile(path.join(ctx.dir, 'agent-consent.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(consent[0].message).toBe('Let Claude Code edit “Thesis draft”?');
      const tabs = await tabsNow(ctx.app);
      expect(tabs.at(-1)).toMatchObject({ kind: 'claude', name: 'Claude Code', selected: true });

      // A plain shell never has the token.
      await clickIn(ctx.app, 'console-new-tab');
      await until(async () => (await tabsNow(ctx.app)).length === tabs.length + 1, { message: 'a new shell tab' });
      await new Promise((r) => setTimeout(r, 500));
      await inConsole(ctx.app, `(() => { const t = document.querySelector('[data-testid="console-tab"][aria-selected="true"]'); return window.laytekzConsole.input(t.dataset.session, 'echo "tok=\${LAYTEKZ_TOKEN:-none}"\\r'); })()`);
      await waitForText(ctx.app, /^tok=none$/m);

      // Codex is not installed: the install card, then Check again once it is.
      await clickIn(ctx.app, 'console-agent-codex');
      await until(async () => (await cardState(ctx.app)).commands.length > 0, { message: 'the install card' });
      const card = await cardState(ctx.app);
      expect(card.title).toBe('Codex is not installed on this computer.');
      expect(card.commands).toEqual(AGENTS.codex.install[process.platform] ?? AGENTS.codex.install.linux);
      await fakeBin(bin, 'codex');
      await clickIn(ctx.app, 'console-agent-check');
      await waitForText(ctx.app, /fake-codex-ready/);
      expect((await cardState(ctx.app)).hidden).toBe(true);
      const codex = await readRecord(recPrefix, 'codex');
      expect(codex.env.LAYTEKZ_TOKEN).toBe(token);
      expect(codex.args).toContain('mcp_servers.laytekz.bearer_token_env_var="LAYTEKZ_TOKEN"');
      expect(codex.args).toContain(`mcp_servers.laytekz.url="${mock.url}/mcp"`);
      expect(hasBypassFlag(codex.args)).toBe(false);
      expect(codex.args.join('\n')).not.toContain(token);
      expect(mock.state.agents.minted).toHaveLength(1); // the stored token was reused

      // MCP turned off on the server: the buttons say why, and nothing starts.
      mock.state.capabilities = { ...DEFAULT_CAPABILITIES, mcp: false };
      const before = (await tabsNow(ctx.app)).length;
      await clickIn(ctx.app, 'console-agent-claude');
      await until(async () => (await cardState(ctx.app)).text === REASONS.mcpOff, { message: 'the MCP-off reason' });
      expect((await agentButton(ctx.app, 'claude')).title).toBe(REASONS.mcpOff);
      expect((await tabsNow(ctx.app)).length).toBe(before);
    } finally {
      await ctx.close();
      await mock.stop();
      await fs.rm(bin, { recursive: true, force: true });
    }
  });
});
