// A server mock (loaded by tests/mock-server.mjs) for the probe shell
// feature: /api/probe/echo records what a request from ShellCtx.sessionFetch
// carried (method, Origin, session cookie, user agent, body) and answers it.

export const order = 100;

export async function handle(req, res, ctx) {
  if (ctx.url.pathname !== '/api/probe/echo') return false;
  const body = await ctx.readBody();
  const seen = {
    method: req.method,
    origin: req.headers.origin ?? null,
    sessionCookie: !!ctx.cookies.aldine_session,
    userAgent: req.headers['user-agent'] ?? '',
    contentType: req.headers['content-type'] ?? null,
    body,
  };
  (ctx.state.probe ??= []).push(seen);
  ctx.send(200, { ok: true, ...seen });
  return true;
}
