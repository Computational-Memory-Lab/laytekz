// Plays the system browser in tests: follows redirects with a per-host cookie
// jar, all the way to the app's loopback listener, and returns the last page.

export async function browse(startUrl, { maxRedirects = 10 } = {}) {
  const jar = new Map();
  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const host = new URL(current).host;
    const cookies = jar.get(host) ?? new Map();
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), accept: 'text/html' },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    jar.set(host, cookies);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    return { status: res.status, url: current, text: await res.text() };
  }
  throw new Error('Too many redirects');
}
