// A server mock (loaded by tests/mock-server.mjs) for the local .bib links
// (V2, WP41): the parts of WP35's frozen library contract the desktop app
// uses. Signed-in members only (the session cookie); records go to
// ctx.state.libraries:
//   GET    /api/projects/:id/libraries               the links
//   POST   /api/projects/:id/libraries               {provider:'desktop-file', bibFile?, branch?, replace?} → {link}
//   DELETE /api/projects/:id/libraries/:linkId       {ok}
//   PUT    /api/projects/:id/libraries/:linkId/content {content, branch?} → {ok}
// `state.libraries.files` holds project files that already exist (409 code
// 'exists' unless replace is true).

export const order = 300;

const BASE_RE = /^\/api\/projects\/([a-z0-9]{4,20})\/libraries$/;
const LINK_RE = /^\/api\/projects\/([a-z0-9]{4,20})\/libraries\/([A-Za-z0-9_-]+)$/;
const CONTENT_RE = /^\/api\/projects\/([a-z0-9]{4,20})\/libraries\/([A-Za-z0-9_-]+)\/content$/;
const BIB_RE = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,200}\.bib$/;

function row(link) {
  const { content: _c, ...rest } = link;
  return { ...rest, libraryName: 'a file on a computer', collectionName: null, recursive: true, lastSyncedAt: link.lastSyncedAt ?? null };
}

export async function handle(req, res, ctx) {
  const { pathname } = ctx.url;
  if (!pathname.startsWith('/api/projects/') || !pathname.includes('/libraries')) return false;
  const st = (ctx.state.libraries ??= { links: [], files: new Set(), posts: [], puts: [], deletes: [], next: 1 });
  const json = async () => {
    try {
      return JSON.parse((await ctx.readBody()) || '{}');
    } catch {
      return null;
    }
  };
  const meta = {
    origin: req.headers.origin ?? null,
    cookie: !!ctx.cookies.aldine_session,
    contentType: req.headers['content-type'] ?? null,
    at: Date.now(),
  };

  let m = BASE_RE.exec(pathname);
  if (m) {
    if (!ctx.user) return ctx.send(401, { error: 'Sign in required' }), true;
    if (req.method === 'GET') return ctx.send(200, st.links.filter((l) => l.projectId === m[1]).map(row)), true;
    if (req.method !== 'POST') return false;
    const body = await json();
    st.posts.push({ projectId: m[1], body, ...meta });
    if (!body || body.provider !== 'desktop-file') return ctx.send(400, { error: 'Choose Zotero, Mendeley or a file on your computer' }), true;
    let bibFile = body.bibFile;
    if (bibFile !== undefined && bibFile !== '') {
      if (typeof bibFile !== 'string' || !BIB_RE.test(bibFile)) return ctx.send(400, { error: 'The file must be a .bib inside the project' }), true;
      if (st.links.some((l) => l.projectId === m[1] && l.bibFile === bibFile)) return ctx.send(409, { error: 'Another linked library already writes that file.', code: 'taken' }), true;
      if (st.files.has(bibFile) && body.replace !== true) return ctx.send(409, { error: 'That file already exists.', code: 'exists' }), true;
    } else {
      let n = 1;
      bibFile = 'library.bib';
      while (st.files.has(bibFile) || st.links.some((l) => l.projectId === m[1] && l.bibFile === bibFile)) bibFile = `library-${++n}.bib`;
    }
    const link = {
      id: `l${String(st.next++).padStart(4, '0')}`, provider: 'desktop-file', linkedBy: ctx.user.id, projectId: m[1],
      branch: body.branch ?? 'main', bibFile,
    };
    st.links.push(link);
    st.files.add(bibFile);
    ctx.send(200, { link: row(link) });
    return true;
  }

  m = CONTENT_RE.exec(pathname);
  if (m && req.method === 'PUT') {
    const body = await json();
    st.puts.push({ projectId: m[1], linkId: m[2], content: body?.content ?? null, branch: body?.branch ?? null, ...meta });
    if (!ctx.user) return ctx.send(401, { error: 'Sign in required' }), true;
    const link = st.links.find((l) => l.projectId === m[1] && l.id === m[2]);
    if (!link) return ctx.send(404, { error: 'No such linked library' }), true;
    if (typeof body?.content !== 'string') return ctx.send(400, { error: 'Send {"content": "<the .bib text>"}' }), true;
    link.content = body.content;
    link.lastSyncedAt = new Date().toISOString();
    ctx.send(200, { ok: true });
    return true;
  }

  m = LINK_RE.exec(pathname);
  if (m && req.method === 'DELETE') {
    st.deletes.push({ projectId: m[1], linkId: m[2], ...meta });
    if (!ctx.user) return ctx.send(401, { error: 'Sign in required' }), true;
    const before = st.links.length;
    st.links = st.links.filter((l) => !(l.projectId === m[1] && l.id === m[2]));
    if (before === st.links.length) return ctx.send(404, { error: 'No such linked library' }), true;
    ctx.send(200, { ok: true });
    return true;
  }
  return false;
}
