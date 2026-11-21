// The desktop app's own settings (V2, WP41, feature 7), without Electron:
// their defaults, the checks every value passes before it is stored, and the
// small URL rules for "reopen the last project". Stored in settings.json
// under features.desktopSettings (ShellCtx.settings); a value equal to its
// default is removed instead of written.

export const ZOOM_CHOICES = Object.freeze([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

export const PREF_DEFAULTS = Object.freeze({
  openAtLogin: false,
  launch: 'list',
  zoomFactor: 1,
  spellLanguages: Object.freeze([]),
});

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** The value, cleaned, when it is a valid value for `key`; otherwise null. */
export function checkPref(key, value) {
  switch (key) {
    case 'openAtLogin':
      return typeof value === 'boolean' ? value : null;
    case 'launch':
      return value === 'list' || value === 'last' ? value : null;
    case 'zoomFactor':
      return typeof value === 'number' && Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX
        ? Math.round(value * 100) / 100 : null;
    case 'spellLanguages':
      return Array.isArray(value) && value.length <= 8 && value.every((v) => typeof v === 'string' && LANG_RE.test(v))
        ? [...new Set(value)] : null;
    default:
      return null;
  }
}

/** Every setting, read through `get(key)` and checked; a missing or invalid value gives the default. */
export function readPrefs(get) {
  const out = {};
  for (const key of Object.keys(PREF_DEFAULTS)) {
    const v = checkPref(key, get(key));
    out[key] = v === null ? PREF_DEFAULTS[key] : v;
  }
  return out;
}

export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** "/p/<id>" plus "?branch=<b>" when it is not main: the path "reopen the last project" opens. */
export function projectPath(project) {
  if (!project || typeof project.id !== 'string') return null;
  const branch = project.branch && project.branch !== 'main' ? `?branch=${encodeURIComponent(project.branch)}` : '';
  return `/p/${project.id}${branch}`;
}

/** Whether `url` is the server's project list (its base, with or without a trailing slash; any query). */
export function isProjectList(base, url) {
  if (typeof base !== 'string' || typeof url !== 'string') return false;
  const bare = url.split('#')[0].split('?')[0];
  return bare === base || bare === `${base}/`;
}

/** The label a zoom factor shows: "125%". */
export const zoomLabel = (factor) => `${Math.round(factor * 100)}%`;
