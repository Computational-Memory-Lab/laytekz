// A loopback TCP relay that can cut one client's network on its own.
//
// Both desktop apps load the same origin (http://127.0.0.1:<relay port>), so
// the server's Origin check sees exactly one public origin, as on the live
// site. Each app tags its own requests by appending "LaytekzE2E/<tag>" to its
// session's User-Agent (collab-e2e.mjs does this before it opens anything).
// The relay reads the first request head of every connection, files the
// connection under that tag, and pipes it to the SSH forward. block(tag)
// destroys every connection of that tag and refuses new ones until
// unblock(tag): to that app the server is unreachable, while the other app
// keeps working. Nothing is parsed after the first head; bytes pass unchanged.

import net from 'node:net';

const HEAD_LIMIT = 64 * 1024;
const TAG_RE = /\r\nuser-agent:[^\r\n]*LaytekzE2E\/([A-Za-z0-9_-]+)/i;

export function startRelay({ listenPort, targetPort, host = '127.0.0.1' }) {
  const blocked = new Set();
  /** tag -> Set of {client, upstream} */
  const live = new Map();
  const stats = { accepted: 0, refused: 0, dropped: 0, upstreamFailures: 0, byTag: {}, websocketsByTag: {} };

  const server = net.createServer((client) => {
    stats.accepted += 1;
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0 && head.length < HEAD_LIMIT) return;
      client.off('data', onData);
      client.pause();
      const text = head.subarray(0, end < 0 ? head.length : end).toString('latin1');
      const tag = TAG_RE.exec(text)?.[1] ?? 'untagged';
      stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;
      if (/\r\nupgrade:\s*websocket/i.test(text)) stats.websocketsByTag[tag] = (stats.websocketsByTag[tag] ?? 0) + 1;
      if (blocked.has(tag)) {
        stats.refused += 1;
        client.destroy();
        return;
      }
      const upstream = net.connect(targetPort, host);
      const pair = { client, upstream };
      if (!live.has(tag)) live.set(tag, new Set());
      live.get(tag).add(pair);
      const forget = () => live.get(tag)?.delete(pair);
      upstream.on('connect', () => {
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on('error', () => { stats.upstreamFailures += 1; client.destroy(); });
      upstream.on('close', () => { forget(); client.destroy(); });
      client.on('close', () => { forget(); upstream.destroy(); });
    };
    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      resolve({
        port: server.address().port,
        stats,
        open: (tag) => live.get(tag)?.size ?? 0,
        block(tag) {
          blocked.add(tag);
          for (const { client, upstream } of live.get(tag) ?? []) {
            stats.dropped += 1;
            client.destroy();
            upstream.destroy();
          }
          live.get(tag)?.clear();
        },
        unblock(tag) { blocked.delete(tag); },
        close() {
          for (const set of live.values()) for (const { client, upstream } of set) { client.destroy(); upstream.destroy(); }
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}
