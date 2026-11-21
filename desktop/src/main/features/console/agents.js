// Claude Code and Codex from the console (V2, WP25, feature 5).
//
// ▶ Claude Code / ▶ Codex in the console's bar start the agent in a new tab,
// working on the project the main window shows. The project's files never
// come to this computer: the agent edits them through the server's MCP
// endpoint (<server>/mcp), so its edits reach co-authors live, marked as an
// agent's, with the server's Review and Revert. The agent runs in an empty
// per-project folder under the profile (userData/agents/<key>/work), and its
// configuration (mcp.json, prompt.md) sits next to that folder, never in it.
//
// The access token is minted through the main window's session (tokens.js)
// and reaches the agent only in its own process environment (LAYTEKZ_TOKEN):
// mcp.json reads ${LAYTEKZ_TOKEN}, Codex gets bearer_token_env_var. It is
// never written to a file in clear and never on a command line. No bypass
// flag is ever passed: the agents keep their own permission prompts.
//
// The pure helpers at the top run in plain Node (tests/agents.spec.mjs);
// createAgents() gets Electron's parts injected from index.js.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellEnv } from './shell-env.js';

export const AGENT_KINDS = Object.freeze(['claude', 'codex']);

export const AGENTS = Object.freeze({
  claude: Object.freeze({
    kind: 'claude',
    label: 'Claude Code',
    command: 'claude',
    install: Object.freeze({
      darwin: ['curl -fsSL https://claude.ai/install.sh | bash', 'brew install --cask claude-code'],
      linux: ['curl -fsSL https://claude.ai/install.sh | bash'],
      win32: ['irm https://claude.ai/install.ps1 | iex', 'winget install Anthropic.ClaudeCode'],
    }),
    extraDirs: ['.local/bin', '.claude/local'],
  }),
  codex: Object.freeze({
    kind: 'codex',
    label: 'Codex',
    command: 'codex',
    install: Object.freeze({
      darwin: ['npm install -g @openai/codex', 'brew install --cask codex'],
      linux: ['npm install -g @openai/codex'],
      win32: ['npm install -g @openai/codex'],
    }),
    extraDirs: ['.local/bin', '.npm-global/bin'],
  }),
});

/**
 * Flags that would switch off an agent's permission prompts or sandbox.
 * The app never passes them; agentArgs() refuses to build a command with one.
 */
export const BYPASS_FLAGS = Object.freeze([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  '--sandbox',
  '-s',
  '--ask-for-approval',
  '-a',
]);

export function hasBypassFlag(args) {
  return args.some((a, i) => {
    const s = String(a);
    if (s.startsWith('-')) {
      const flag = s.split('=')[0];
      return BYPASS_FLAGS.includes(flag) || /bypass|skip-permissions|yolo/i.test(flag);
    }
    // A Codex config override that changes approvals or the sandbox.
    return (args[i - 1] === '-c' || args[i - 1] === '--config') && /^(approval_policy|sandbox_mode|sandbox_workspace_write)|dangerous/i.test(s);
  });
}

/** The server's MCP endpoint. */
export function mcpUrl(serverBase) {
  return `${String(serverBase).replace(/\/+$/, '')}/mcp`;
}

/** The project's folder name under userData/agents: readable, and unique per server and project. */
export function projectKey(serverBase, projectId) {
  let host = 'server';
  try {
    host = new URL(serverBase).host.replace(/[^A-Za-z0-9.-]/g, '-');
  } catch {
    // keep the placeholder
  }
  const digest = crypto.createHash('sha256').update(`${serverBase}\n${projectId}`).digest('hex').slice(0, 8);
  return `${host}-${projectId}-${digest}`;
}

/** The key under which consent and the token are stored: one per server and project. */
export function consentKey(serverBase, projectId) {
  return `${String(serverBase).replace(/\/+$/, '')}|${projectId}`;
}

/** mcp.json for Claude Code. The token stays a ${LAYTEKZ_TOKEN} reference, which Claude Code expands from its environment. */
export function claudeMcpConfig(serverBase) {
  return {
    mcpServers: {
      laytekz: {
        type: 'http',
        url: mcpUrl(serverBase),
        headers: {
          Authorization: 'Bearer ${LAYTEKZ_TOKEN}',
          'X-Laytekz-Agent': 'claude',
        },
      },
    },
  };
}

/** The instructions the agent starts with: where the project lives and how to change and typeset it. */
export function agentPrompt({ projectName, projectId, branch, serverBase }) {
  const name = String(projectName || projectId).replace(/[\r\n]+/g, ' ').slice(0, 120);
  return [
    `You are helping with the Laytekz project "${name}" (project id ${projectId}, branch ${branch}) on ${serverBase}.`,
    '',
    "The project's files are not on this computer. Read and change them only through the laytekz MCP tools",
    `(project_structure, read_file, edit_file, write_file, batch_write), passing project "${projectId}" and branch "${branch}".`,
    'Your edits reach co-authors live, marked as an agent\'s edits, and they can review and revert them.',
    'Typeset with the laytekz compile tool and fix the errors it reports; if an error cites text you already fixed, compile again.',
    'The current folder is an empty scratch folder: do not create project files here.',
    '',
  ].join('\n');
}

/** Codex's -c overrides: the server's MCP endpoint, with the token read from LAYTEKZ_TOKEN. */
export function codexConfigArgs(serverBase) {
  return [
    '-c', `mcp_servers.laytekz.url=${JSON.stringify(mcpUrl(serverBase))}`,
    '-c', 'mcp_servers.laytekz.bearer_token_env_var="LAYTEKZ_TOKEN"',
    '-c', 'mcp_servers.laytekz.http_headers={"X-Laytekz-Agent"="codex"}',
  ];
}

/**
 * The agent's arguments (after its executable).
 * Claude Code: --mcp-config <mcp.json> --append-system-prompt-file <prompt.md>
 * (no --strict-mcp-config: the user's own servers stay).
 * Codex: the -c overrides, then the instructions as its first message.
 */
export function agentArgs(kind, { serverBase, mcpConfigPath, promptPath, prompt }) {
  let args;
  if (kind === 'claude') args = ['--mcp-config', mcpConfigPath, '--append-system-prompt-file', promptPath];
  else if (kind === 'codex') args = [...codexConfigArgs(serverBase), prompt];
  else throw new TypeError(`Unknown agent ${JSON.stringify(kind)}.`);
  if (hasBypassFlag(args)) throw new Error('Refusing to start an agent with a permission bypass flag.');
  return args;
}

/**
 * The agent's environment: the console's (shell-env.js, without Electron's
 * and Node's own variables), the login shell's PATH, the project, and the
 * token. Only agent tabs get LAYTEKZ_TOKEN.
 */
export function agentEnv(base, { token, serverBase, projectId, branch, pathValue }) {
  const extra = {
    LAYTEKZ_URL: String(serverBase),
    LAYTEKZ_PROJECT: String(projectId),
    LAYTEKZ_BRANCH: String(branch),
    LAYTEKZ_TOKEN: String(token),
  };
  if (pathValue) extra.PATH = pathValue;
  const env = shellEnv(base, extra);
  if (!pathValue && base.PATH) env.PATH = base.PATH;
  return env;
}

/**
 * Writes the agent's files under `root` (userData/agents/<key>): mcp.json and
 * prompt.md next to an empty work/ folder, owner-only. Nothing secret is in
 * them. Returns their paths.
 */
export function writeAgentFiles(root, { serverBase, prompt }) {
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const mcpConfigPath = path.join(root, 'mcp.json');
  const promptPath = path.join(root, 'prompt.md');
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify(claudeMcpConfig(serverBase), null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
  return { work, mcpConfigPath, promptPath };
}

// ------------------------------------------------------------- detection

function isExecutable(file, platform) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `command` in `dirs` (with PATHEXT's extensions on Windows), or null. */
export function findInDirs(command, dirs, { platform = process.platform, pathext = process.env.PATHEXT } = {}) {
  const names = platform === 'win32'
    ? (pathext || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((ext) => command + ext.toLowerCase())
    : [command];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file, platform)) return file;
    }
  }
  return null;
}

const PATH_MARK = '__LAYTEKZ_PATH__=';

/**
 * The PATH the user's login shell sets up ($SHELL -lic), which apps started
 * from the Dock do not get. 5 s at most; null when it fails.
 */
export function loginShellPath({ env = process.env, platform = process.platform, run = execFile, timeoutMs = 5000 } = {}) {
  if (platform === 'win32') return Promise.resolve(env.PATH || env.Path || null);
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return new Promise((resolve) => {
    try {
      run(shell, ['-l', '-i', '-c', `printf '\\n${PATH_MARK}%s\\n' "$PATH"`], {
        env: shellEnv(env), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024,
      }, (_err, stdout) => {
        const line = String(stdout ?? '').split('\n').reverse().find((l) => l.startsWith(PATH_MARK));
        resolve(line ? line.slice(PATH_MARK.length).trim() || null : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Finds an agent: {file, pathValue} or null. Looks in the login shell's PATH,
 * then the usual install folders. `testBinDir` (tests, from source only)
 * replaces all of that with one folder, so a test never finds the real tools.
 */
export async function detectAgent(kind, { env = process.env, platform = process.platform, home = os.homedir(), loginPath = loginShellPath, testBinDir = null } = {}) {
  const agent = AGENTS[kind];
  if (!agent) return null;
  if (testBinDir) {
    const pathValue = [testBinDir, '/usr/bin', '/bin'].join(':');
    const file = findInDirs(agent.command, [testBinDir], { platform });
    return file ? { file, pathValue } : null;
  }
  const sep = platform === 'win32' ? ';' : ':';
  const shellPath = await loginPath({ env, platform });
  const pathValue = shellPath || env.PATH || '';
  const dirs = [
    ...pathValue.split(sep),
    ...agent.extraDirs.map((d) => path.join(home, d)),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : platform === 'linux' ? ['/usr/local/bin'] : []),
  ];
  const file = findInDirs(agent.command, [...new Set(dirs)], { platform });
  return file ? { file, pathValue } : null;
}

/** What the pty runs: the agent itself, or cmd.exe for a Windows .cmd shim (npm's). */
export function spawnSpec(file, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`] };
  }
  return { file, args };
}

// ------------------------------------------------------------ the status

export const REASONS = Object.freeze({
  noProject: 'Open a project first. Claude Code and Codex work on the project shown in the main window.',
  oldServer: 'This server does not support agents from the console yet.',
  mcpOff: 'Agent access (MCP) is turned off on this server, so Claude Code and Codex cannot edit its projects. The server\'s operator can turn it on (ALDINE_MCP=1).',
  noAccounts: 'This server has no accounts, so Laytekz cannot create an access token for an agent.',
  signedOut: 'Sign in to Laytekz first, then start the agent again.',
  hidden: 'The agent buttons are turned off in Console settings.',
});

/** Why the agent buttons cannot start anything now, or null when they can. */
export function blockedReason({ enabled = true, project, capabilities }) {
  if (!enabled) return REASONS.hidden;
  if (!project) return REASONS.noProject;
  if (!capabilities) return REASONS.oldServer;
  if (!capabilities.mcp) return REASONS.mcpOff;
  if (!capabilities.accounts) return REASONS.noAccounts;
  return null;
}

/** The install card for a missing agent. */
export function installCard(kind, platform = process.platform) {
  const agent = AGENTS[kind];
  const commands = agent.install[platform] ?? agent.install.linux;
  return {
    kind,
    title: `${agent.label} is not installed on this computer.`,
    text: `Install it with one of these commands, then press Check again.${kind === 'codex' && platform !== 'darwin' ? ' It needs Node.js.' : ''}`,
    commands,
  };
}

// ---------------------------------------------------- the launcher (main)

/**
 * deps = {
 *   ctx: ShellCtx, sessions (console-sessions.js), tokens (tokens.js),
 *   userData: string, platform?: string,
 *   enabled(): boolean,                 // the console's `agents` setting
 *   confirm(question): Promise<{allow, always}>,   // the consent dialog
 *   copy(text): void,                   // the clipboard
 *   testBinDir?: string | null,
 *   log?(text): void,
 * }
 */
export function createAgents(deps) {
  const { ctx, sessions, tokens } = deps;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((text) => console.warn(`Laytekz agents: ${text}`));

  function currentProject() {
    const win = ctx.mainWindow();
    if (!win) return null;
    try {
      return ctx.projectFromUrl(win.webContents.getURL());
    } catch {
      return null;
    }
  }

  /** What the server offers (GET /api/capabilities, answered from its memory), read at each status check. */
  async function capabilities() {
    let value = null;
    try {
      const res = await ctx.sessionFetch('/api/capabilities', { headers: { accept: 'application/json' } });
      if (res.status === 200) {
        const body = await res.json();
        if (body && typeof body === 'object' && typeof body.rev === 'string') value = body;
      }
    } catch (err) {
      log(`capabilities: ${err?.message ?? err}`);
      return null;
    }
    return value;
  }

  async function status() {
    const project = currentProject();
    const enabled = deps.enabled();
    const reason = blockedReason({ enabled, project, capabilities: enabled && project ? await capabilities() : {} });
    return { enabled, project, reason };
  }

  async function projectName(id) {
    try {
      const res = await ctx.sessionFetch(`/api/projects/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
      if (res.status === 200) {
        const body = await res.json();
        if (typeof body?.name === 'string' && body.name.trim()) return body.name.trim().slice(0, 120);
      }
    } catch {
      // the id will do
    }
    return id;
  }

  function consented(key) {
    const all = ctx.settings.get('agentConsent', {});
    return !!(all && typeof all === 'object' && all[key] === true);
  }

  function rememberConsent(key) {
    const all = ctx.settings.get('agentConsent', {});
    ctx.settings.set('agentConsent', { ...(all && typeof all === 'object' ? all : {}), [key]: true });
  }

  /**
   * Starts an agent in a new tab. Returns {ok: true, session} or
   * {ok: false, reason, install?} for the console page to show.
   */
  async function launch(kind, { cols, rows } = {}) {
    const agent = AGENTS[kind];
    if (!agent) return { ok: false, reason: 'Unknown agent.' };
    const st = await status();
    if (st.reason) return { ok: false, reason: st.reason };
    const serverBase = ctx.server();
    const { id: projectId, branch } = st.project;

    const found = await detectAgent(kind, { platform, testBinDir: deps.testBinDir ?? null });
    if (!found) return { ok: false, reason: null, install: installCard(kind, platform) };

    const name = await projectName(projectId);
    const key = consentKey(serverBase, projectId);
    if (!consented(key)) {
      const answer = await deps.confirm({
        kind,
        message: `Let ${agent.label} edit “${name}”?`,
        detail: `It runs on this computer with your own ${kind === 'claude' ? 'Claude' : 'OpenAI'} account and can read and change every file in this project through Laytekz. Its edits reach your co-authors live, marked as an agent's, and can be reverted from History or the "edited N files" prompt. Text written by co-authors reaches ${agent.label} too, so keep its permission prompts on.`,
        checkbox: "Don't ask again for this project",
      });
      if (!answer?.allow) return { ok: false, reason: null, cancelled: true };
      if (answer.always) rememberConsent(key);
    }

    const minted = await tokens.tokenFor({ serverBase, projectId, projectName: name });
    if (!minted.token) return { ok: false, reason: minted.error === 'signed-out' ? REASONS.signedOut : (minted.message || 'Laytekz could not create an access token for the agent.') };

    const root = path.join(deps.userData, 'agents', projectKey(serverBase, projectId));
    const prompt = agentPrompt({ projectName: name, projectId, branch, serverBase });
    let files;
    try {
      files = writeAgentFiles(root, { serverBase, prompt });
    } catch (err) {
      return { ok: false, reason: `Laytekz could not prepare the agent's folder: ${err?.message ?? err}` };
    }
    const args = agentArgs(kind, { serverBase, mcpConfigPath: files.mcpConfigPath, promptPath: files.promptPath, prompt });
    const run = spawnSpec(found.file, args, platform);
    const env = agentEnv(process.env, { token: minted.token, serverBase, projectId, branch, pathValue: found.pathValue });
    const session = sessions.create({
      cols,
      rows,
      spec: {
        kind,
        file: run.file,
        args: run.args,
        cwd: files.work,
        env,
        title: agent.label,
        exitNote: `${agent.label} exited. Press Enter to start it again, or close the tab.`,
      },
    });
    if (!session) return { ok: false, reason: 'Too many terminals are open. Close one and try again.' };
    return { ok: true, session };
  }

  return Object.freeze({ status, launch, currentProject, capabilities, copy: deps.copy });
}

/**
 * The page side of the agents: ShellCtx IPC for console.html only (the host
 * checks the sender). Returns the dispose function.
 */
export function installAgentBridge({ ctx, agents }) {
  const CONSOLE = { pages: ['console.html'] };
  const off = [];
  const on = (channel, fn) => off.push(ctx.ipc.handle(channel, fn, CONSOLE));
  on('console:agent-status', () => agents.status());
  on('console:agent-launch', (_event, kind, size) => {
    if (!AGENT_KINDS.includes(kind)) return { ok: false, reason: 'Unknown agent.' };
    const cols = Number.isInteger(size?.cols) ? size.cols : undefined;
    const rows = Number.isInteger(size?.rows) ? size.rows : undefined;
    return agents.launch(kind, { cols, rows });
  });
  on('console:copy', (_event, text) => {
    if (typeof text !== 'string' || !text || text.length > 2000) return false;
    agents.copy(text);
    return true;
  });
  return () => {
    for (const dispose of off.splice(0)) dispose();
  };
}
