// A server mock (loaded by tests/mock-server.mjs) for the console's agent
// buttons (V2, WP25): personal access tokens (GET/POST/DELETE /api/tokens,
// session cookie only, like the server's tokenRouteUser) and the project
// detail (GET /api/projects/:id). Records go to ctx.state.agents.

export const order = 200;

const PROJECT_RE = /^\/api\/projects\/([a-z0-9]{4,20})$/;
const TOKEN_RE = /^\/api\/tokens\/([A-Za-z0-9_-]+)$/;

export async function handle(req, res, ctx) {
  const { pathname } = ctx.url;
  const st = (ctx.state.agents ??= { tokens: [], minted: [], next: 1 });

  if (pathname === '/api/tokens' || TOKEN_RE.test(pathname)) {
    if (req.headers.authorization) {
      ctx.send(403, { error: 'Access tokens cannot manage tokens — sign in to do this' });
      return true;
    }
    if (!ctx.user) {
      ctx.send(401, { error: 'Sign in required' });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/tokens') {
      ctx.send(200, st.tokens.map(({ token: _secret, ...rec }) => rec));
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/tokens') {
      const body = JSON.parse((await ctx.readBody()) || '{}');
      const id = `tok${st.next++}`;
      const token = `aldn_mock_${id}_${Math.random().toString(36).slice(2, 10)}`;
      const rec = { id, name: body.name, projectIds: body.projectIds ?? null, expiresAt: body.expiresAt ?? null, createdAt: new Date().toISOString(), token };
      st.tokens.push(rec);
      st.minted.push({ ...rec, origin: req.headers.origin ?? null });
      ctx.send(200, rec);
      return true;
    }
    const m = TOKEN_RE.exec(pathname);
    if (req.method === 'DELETE' && m) {
      const before = st.tokens.length;
      st.tokens = st.tokens.filter((t) => t.id !== m[1]);
      ctx.send(before === st.tokens.length ? 404 : 200, before === st.tokens.length ? { error: 'Token not found' } : { ok: true });
      return true;
    }
    return false;
  }

  const p = PROJECT_RE.exec(pathname);
  if (req.method === 'GET' && p) {
    ctx.send(200, { id: p[1], name: 'Thesis draft', rootFile: 'main.tex', branches: ['main'], readOnly: false });
    return true;
  }
  return false;
}
