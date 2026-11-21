// The small pages the loopback listener answers the system browser with.
// Script-free, self-contained, and never echo anything from the request.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function browserPage({ title, message, ok }) {
  const mark = ok ? '&#10003;' : '!';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)} – Laytekz</title>
<style>
  :root { color-scheme: dark light; --bg: #1c1c1e; --fg: #f5f5f7; --muted: #a1a1a6; --card: #232326; --accent: ${ok ? '#5b8cff' : '#ff6961'}; }
  @media (prefers-color-scheme: light) { :root { --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; --card: #ffffff; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { min-height: 100%; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
  .card { max-width: 420px; background: var(--card); border-radius: 16px; padding: 32px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
  .mark { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 26px; line-height: 48px; font-weight: 600; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><div class="card"><div class="mark" aria-hidden="true">${mark}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></main></body>
</html>`;
}

export const PAGES = {
  signedIn: { ok: true, title: 'You are signed in', message: 'Return to Laytekz. You can close this tab.' },
  cancelled: { ok: false, title: 'Sign-in cancelled', message: 'Laytekz was not signed in. You can close this tab and try again from the app.' },
  wrongState: { ok: false, title: 'This sign-in link is out of date', message: 'It does not belong to the sign-in Laytekz is waiting for. Start again from the app.' },
  finished: { ok: false, title: 'This sign-in has already finished', message: 'Return to Laytekz. You can close this tab.' },
  notFound: { ok: false, title: 'Not found', message: 'This address is only used by the Laytekz app to finish signing in.' },
  failed: (reason) => ({ ok: false, title: 'Laytekz could not finish signing in', message: `${reason} Return to Laytekz to try again.` }),
};
