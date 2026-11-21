// Opens the desktop settings window at one of its parts (#server, #bib, …)
// from another WP41 feature (bibwatch's File → Linked .bib files…), which
// cannot open a page it does not own.

let opener = null;

/** index.js, at start (a function) and at stop (null). */
export function setSettingsOpener(fn) {
  opener = fn;
}

export function openDesktopSettings(hash) {
  return opener ? opener(hash) : null;
}
