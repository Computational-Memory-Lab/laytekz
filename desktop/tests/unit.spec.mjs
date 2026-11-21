// Pure helpers, no Electron.

import { test, expect } from '@playwright/test';
import { externalUrl, isProgramFile, unexpectedSwitches } from '../src/main/rules.js';
import { Server, normalizeServerUrl } from '../src/main/server.js';
import { DesktopSignIn, createPkce } from '../src/main/signin.js';
import { sha256url } from './helpers.mjs';

test.describe('DesktopSignIn', () => {
  const make = () => {
    const opened = [];
    const outcomes = [];
    const signIn = new DesktopSignIn({
      server: () => new Server('https://laytekz.invalid'),
      session: () => null,
      openExternal: async (url) => { opened.push(url); return true; },
      timeoutMs: 60_000,
      onWaiting: () => {},
      onEnd: (outcome) => outcomes.push(outcome),
    });
    return { signIn, opened, outcomes };
  };

  test('PKCE: 43-character verifier and its S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(sha256url(verifier));
  });

  test('a start superseded while its port is still binding does not leak the listener', async () => {
    const { signIn, opened, outcomes } = make();
    const first = signIn.start('google');
    const firstFlow = signIn.flow;
    const second = signIn.start('google');
    await Promise.all([first, second]);
    expect(firstFlow.listener.listening).toBe(false);
    expect(signIn.flow.listener.listening).toBe(true);
    expect(opened).toHaveLength(1);
    expect(outcomes).toEqual(['superseded']);
    signIn.cancel();
    expect(outcomes).toEqual(['superseded', 'cancelled']);
  });
});

test.describe('normalizeServerUrl', () => {
  const ok = (input, url) => expect(normalizeServerUrl(input)).toEqual({ ok: true, url });
  const bad = (input, pattern) => {
    const result = normalizeServerUrl(input);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(pattern);
  };

  test('accepts https and keeps a base path', () => {
    ok('https://latex.devon7y.com', 'https://latex.devon7y.com');
    ok('https://latex.devon7y.com/', 'https://latex.devon7y.com');
    ok('latex.example.org', 'https://latex.example.org');
    ok('https://example.org/internal/laytekz/', 'https://example.org/internal/laytekz');
    ok('https://example.org/?x=1#y', 'https://example.org');
  });

  test('allows plain http only on this computer', () => {
    ok('http://localhost:3000', 'http://localhost:3000');
    ok('http://127.0.0.1:3040', 'http://127.0.0.1:3040');
    ok('http://[::1]:3000', 'http://[::1]:3000');
    bad('http://example.com', /https/);
    bad('http://192.168.1.10:3000', /https/);
  });

  test('rejects other schemes, credentials and junk', () => {
    bad('', /Enter/);
    bad('ftp://example.com', /https/);
    bad('file:///etc/passwd', /https/);
    bad('javascript:alert(1)', /valid|https/);
    bad('https://user:pw@example.com', /user name/);
    bad('https://exa mple.com', /valid/);
  });
});

test.describe('Server', () => {
  test('recognises its own URLs and the sign-in link', () => {
    const s = new Server('https://latex.devon7y.com');
    expect(s.owns('https://latex.devon7y.com/p/abc')).toBe(true);
    expect(s.owns('https://latex.devon7y.com.evil.test/')).toBe(false);
    expect(s.owns('http://latex.devon7y.com/')).toBe(false);
    expect(s.signInProvider('https://latex.devon7y.com/api/auth/oauth/google')).toBe('google');
    expect(s.signInProvider('https://latex.devon7y.com/api/auth/oauth/google/callback')).toBe(null);
    expect(s.signInProvider('https://latex.devon7y.com/api/auth/oauth/google?x=1')).toBe('google');
    expect(s.isApi('https://latex.devon7y.com/api/remotes/github/oauth')).toBe(true);
    expect(s.isApi('https://latex.devon7y.com/apiary')).toBe(false);
    expect(s.url('/api/health')).toBe('https://latex.devon7y.com/api/health');
  });

  test('decodes percent-escapes as the server router does', () => {
    const s = new Server('https://latex.devon7y.com');
    expect(s.signInProvider('https://latex.devon7y.com/api/auth/oauth/goo%67le')).toBe('google');
    expect(s.signInProvider('https://latex.devon7y.com/api/%61uth/oauth/google')).toBe('google');
    expect(s.signInProvider('https://latex.devon7y.com/%61pi/auth/oauth/google')).toBe('google');
    expect(s.isApi('https://latex.devon7y.com/%61pi/remotes/github/oauth')).toBe(true);
    expect(s.isAuthApi('https://latex.devon7y.com/api/%61uth/elsewhere')).toBe(true);
    expect(s.isAuthApi('https://latex.devon7y.com/api/remotes/github/oauth')).toBe(false);
    expect(s.localPath('https://latex.devon7y.com/p/a%20b')).toBe('/p/a b');
    expect(s.owns('https://latex.devon7y.com/p/%E0%A4%A')).toBe(false);
    const b = new Server('https://example.org/laytekz');
    expect(b.signInProvider('https://example.org/laytekz/api/auth/oauth/%6fidc')).toBe('oidc');
    expect(b.owns('https://example.org/%6caytekz/p/1')).toBe(true);
  });

  test('honours a base path', () => {
    const s = new Server('https://example.org/laytekz');
    expect(s.owns('https://example.org/laytekz')).toBe(true);
    expect(s.owns('https://example.org/laytekz/p/1')).toBe(true);
    expect(s.owns('https://example.org/other')).toBe(false);
    expect(s.signInProvider('https://example.org/laytekz/api/auth/oauth/oidc')).toBe('oidc');
    expect(s.signInProvider('https://example.org/api/auth/oauth/oidc')).toBe(null);
    expect(s.url('/api/auth/desktop/start')).toBe('https://example.org/laytekz/api/auth/desktop/start');
  });
});

test.describe('rules', () => {
  test('a packaged build accepts no switch but the OS\'s own', () => {
    expect(unexpectedSwitches(['/Applications/Laytekz.app/Contents/MacOS/Laytekz', '-psn_0_123', 'file.tex', '--remote-debugging-pipe', '-v', '--proxy-server=x']))
      .toEqual(['--remote-debugging-pipe', '-v', '--proxy-server=x']);
    expect(unexpectedSwitches(['Laytekz.exe'])).toEqual([]);
    expect(unexpectedSwitches(['electron', '/path/to/app'])).toEqual([]);
  });

  test('only http(s) without credentials, and mailto, go to the OS', () => {
    const table = {
      'https://example.com/a': 'https://example.com/a',
      'http://example.com': 'http://example.com/',
      'mailto:someone@example.org': 'mailto:someone@example.org',
      'file:///etc/hosts': null,
      'smb://server/share': null,
      'javascript:alert(1)': null,
      'data:text/html,hi': null,
      'laytekz-ui://app/toast.html': null,
      'vscode://file/x': null,
      'https://user:pw@example.com/': null,
      'ftp://example.com': null,
      'not a url': null,
    };
    for (const [input, expected] of Object.entries(table)) expect(externalUrl(input), input).toBe(expected);
  });

  test('program files are recognised, document files are not', () => {
    for (const name of ['run.command', 'setup.EXE', 'setup.exe.', 'setup.exe ', 'link.webloc', 'Installer.pkg', 'x.ps1', 'y.lnk']) expect(isProgramFile(name), name).toBe(true);
    for (const name of ['paper.pdf', 'project.zip', 'main.tex', 'refs.bib', 'figure.png', 'notes.txt', 'build.sh', 'main.synctex.gz', 'exe']) expect(isProgramFile(name), name).toBe(false);
  });
});
