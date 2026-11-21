// The running local .bib links, for the desktop settings window
// (features/desktopSettings), which lists them with Upload now and Unlink.
// Both features are WP41's; this module only passes the handle across.

let running = null;

/** index.js, at start (the handle) and at stop (null). */
export function setBibwatch(handle) {
  running = handle;
}

/** {list(), pushNow(key, opts), unlink(key), subscribe(fn) → unsubscribe} while the feature runs, else null. */
export function getBibwatch() {
  return running;
}
