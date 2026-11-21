# Laytekz desktop

The Laytekz desktop app for macOS and Windows. It is a thin, hardened Electron
shell around the Laytekz web app (based on [Aldine](https://github.com/trahloff/Aldine)).
The main window loads the remote server (default `https://laytekz.devon7y.com`)
in a persistent session, so the web UI runs unmodified: its relative API calls,
its collaboration WebSocket and its HttpOnly session cookie all work as they do
in a browser.

Google blocks OAuth inside embedded browsers, so the app signs in through the
**system browser** and receives the session over a loopback redirect (see
[How sign-in works](#how-sign-in-works)).

- Electron 45.4.1, electron-builder 26.18.0, Playwright 1.65.1 (all pinned exactly)
- Plain JavaScript (ESM main process, CommonJS preload), no bundler and no UI framework
- One runtime dependency, node-pty 1.1.0 (Node-API prebuilds, nothing to rebuild)

## Layout

```text
desktop/
├── package.json             scripts, pinned dev dependencies
├── electron-builder.yml     packaging: targets, fuses, artifact names, signing
├── playwright.config.mjs
├── build/                   icons (icon.icns, icon.ico, icon.png; made separately), entitlements.mac.plist
├── src/
│   ├── main/
│   │   ├── main.js          entry: lifecycle, main window, offline/retry, sign-in UI, context menu
│   │   ├── switch-guard.js  first import: a packaged build refuses command-line switches
│   │   ├── rules.js         pure rules: switches, addresses for the OS, program files (no Electron imports)
│   │   ├── env.js           constants and test mode
│   │   ├── server.js        server URL validation, origin checks, /api/health probe (no Electron imports)
│   │   ├── signin.js        desktop handoff: PKCE, loopback listener, code exchange
│   │   ├── browser-pages.js the pages the loopback listener shows in the system browser
│   │   ├── navigation.js    navigation policy, same-origin popups, integration auth window
│   │   ├── hardening.js     webPreferences, permissions, downloads, app-wide guards
│   │   ├── overlays.js      offline screen and toast (WebContentsViews over the main window)
│   │   ├── dialogs.js       Change Server window, About box
│   │   ├── menu.js          application menu
│   │   ├── protocol.js      laytekz-ui:// scheme for the local pages
│   │   ├── ui-bridge.js     the only IPC: local pages ↔ main process
│   │   ├── external.js      shell.openExternal wrapper (scheme check, test recorder, page budget)
│   │   ├── settings.js      settings.json in the profile folder
│   │   └── features/        V2 shell features: index.js (the list), host.js (ShellCtx, menu items, pages, IPC), <id>/
│   │       └── console/     the console: panel, sessions, IPC, shell environment, pty-host.js (utility process)
│   │           agents.js, tokens.js  ▶ Claude Code / ▶ Codex: detection, consent, the project token, mcp.json in userData
│   ├── preload/ui.cjs       preload for local pages only (never for the remote page)
│   ├── preload/console.cjs  the console pages' bridge (window.laytekzConsole)
│   └── ui/                  local pages: offline, toast, change-server (+ ui.css)
│       └── console*.{html,js,css}  the console page, its settings page, vendored xterm.js (npm run vendor:xterm)
├── tests/
│   ├── mock-server.mjs      stand-in Laytekz server implementing the handoff contract
│   ├── browser-sim.mjs      plays the system browser (follows redirects with cookies)
│   ├── helpers.mjs          launches the app under Playwright in test mode
│   ├── mocks/               server mocks per shell feature (<id>.mjs); _probe-feature.mjs is the test-only feature
│   ├── *.spec.mjs           Playwright tests (unit, signin, navigation, offline, shell, hardening, console, agents)
│   └── smoke-packaged.mjs   end-to-end check of the packaged .app
└── release/                 release installers (git-ignored except INSTALL.md), see Release builds
    ├── Laytekz-<version>-mac-{arm64,x64}.{dmg,zip}, Laytekz-<version>-win-{x64,arm64}-setup.exe
    ├── SHA256SUMS.txt
    ├── INSTALL.md           instructions for the people who receive the installers
    └── mac-arm64/Laytekz.app  unpacked Apple Silicon build, same files as the arm64 dmg and zip
```

## Run from source

```sh
npm install
npm start
```

Node 22 or later. `npm start` runs `electron .` against the configured server.
To work against a local server, use **Laytekz → Change Server…** (Windows:
**File → Change Server…**; neither has a shortcut now, since Cmd/Ctrl+, is
**Settings…**) and enter `http://localhost:3000`; plain `http://` is
accepted only for `localhost`, `127.0.0.1` and `[::1]`.

If Electron starts as plain Node (`bad option: --remote-debugging-port`, or no
window), your shell has `ELECTRON_RUN_AS_NODE` set (some editors export it to
child processes). Run `env -u ELECTRON_RUN_AS_NODE npm start`. The tests strip
it themselves.

## Test

```sh
npm test               # Playwright drives Electron from source; windows stay hidden
npm run pack:mac && npm run test:packaged   # end-to-end check of the packaged .app (macOS)
```

`npm run pack:mac` deletes and rebuilds `dist/mac-arm64` (see
[Package](#package)). To check a release build instead, test a copy of it:
see [Release builds](#release-builds).

`npm test` runs 92 tests. Each test starts its
own mock server (`tests/mock-server.mjs`) on a random port and its own app
instance with a throwaway profile. Nothing opens a browser: test mode records
`shell.openExternal` calls to a file and `tests/browser-sim.mjs` plays the
browser. Areas covered:

- **Unit:** server URL rules, origin and base-path matching (percent-escapes
  decoded as the server's router does), PKCE, a sign-in superseded while its
  port is still binding, and the tables in `rules.js`: refused switches,
  addresses the OS may open, program files.
- **Sign-in:** the start URL carries every contract parameter, a loopback
  `redirect_uri` and an S256 challenge that matches the verifier sent later.
  The callback leads to an exchange, and the HttpOnly cookie lands in the
  window's session, where `/api/auth/me` sees it. Also covered: wrong state,
  Cancel, "Open the browser again", `error=access_denied`, a second attempt
  (and a second click while the first is young, which does nothing), exchange
  failure, an exchange answered with a redirect (not followed), replay (no
  second exchange request at all), the listener's Host check, 127.0.0.1 bind
  and GET-only rule, two simultaneous callbacks (one exchange), timeout while
  the account awaits approval, quit mid-flow, and `window.open` of the sign-in
  link.
- **Navigation:** external links go to the recorder, never the window.
  Off-origin and `file:` navigation is blocked. Same-origin popups get the same
  hardening. Downloads go through the save dialog, and downloads from other
  origins are blocked. Only the allowed permissions are granted. The
  integration OAuth round trip runs in the auth window.
- **Offline:** covers a server that is down at start-up, a failed reload, a
  gateway 502 and an unhealthy `/api/health`, each recovering by itself or
  through Retry.
- **Shell:** Change Server validation and persistence, menu contents and
  accelerator conflicts (modifiers compared as sets), the About text and its
  links, remembered window bounds, the unload guard, and the single-instance
  lock. Also Settings… (Cmd/Ctrl+,) and the open-settings event, the
  `/settings/desktop-app` intercept, the user-agent token, a cancelled context
  menu against the spelling menu, and the shell feature host (the probe
  feature, plus unit tests without Electron).
- **Console:** View → Console, a command's output, resize, pop-out and dock,
  no network in the console page, the quit question and the off switch
  (`tests/console.spec.mjs`).
- **Agents:** fake claude and codex see the token only in their environment,
  the install card, MCP off (`tests/agents.spec.mjs`).
- **Hardening:** what a hostile page or a launcher can do: command-line
  switches (refused before the DevTools server starts), `window.open`
  features, the window cap, a project window outliving the main window with
  its unsynced-edits prompt, the budget for hand-offs to the browser, repeated
  sign-in starts, percent-encoded sign-in links, sign-in chains that leave the
  server, the auth window's reach, program and `data:` downloads, repeated save
  dialogs, the quarantine attribute, permissions for third-party frames and
  pages, TLS client-certificate requests, and a quit cancelled with Stay
  during sign-in.

`tests/smoke-packaged.mjs` launches the real binary (Playwright cannot attach
to it because the inspect fuse is off) with `ELECTRON_RUN_AS_NODE` and
`NODE_OPTIONS` set, to show the fuses ignore them. The mock page clicks its
own sign-in link, and the script completes the handoff and checks the mock's
request log. It also checks that `LAYTEKZ_TEST_SERVER_URL` is ignored by a
packaged build, reads every fuse from the binary, checks that the signature
carries the hardened runtime, and checks that `--remote-debugging-port` makes
the app exit with status 1 before any DevTools server listens. Point it at a
build elsewhere with `LAYTEKZ_APP=/path/to/Laytekz.app/Contents/MacOS/Laytekz`.

### Test mode

Test mode is for automated runs only. Turn it on with `LAYTEKZ_TEST_MODE=1`.

| Variable | Effect | Packaged build |
| --- | --- | --- |
| `LAYTEKZ_TEST_MODE=1` | Windows are never shown or focused. `shell.openExternal` appends `{"url","at"}` lines to the record file instead of opening anything. The profile moves to a throwaway folder, and Chromium's mock keychain replaces the OS keychain | yes |
| `LAYTEKZ_TEST_USER_DATA=/abs/dir` | Profile folder for the run (default: a new temp folder) | yes |
| `LAYTEKZ_TEST_RECORD=/abs/file.jsonl` | Where openExternal calls are recorded (default: `<profile>/open-external.jsonl`) | yes |
| `LAYTEKZ_TEST_SERVER_URL=http://127.0.0.1:PORT` | Server to load, instead of settings.json or the default | **ignored** |
| `LAYTEKZ_TEST_SIGNIN_TIMEOUT_MS=1500` | Sign-in timeout (default 5 minutes) | **ignored** |
| `LAYTEKZ_TEST_SHELL_FEATURES=/abs/file.mjs` | Extra shell features (default export: an array) appended to the shipped ones | **ignored** |
| `LAYTEKZ_TEST_CONSOLE_QUIT=cancel` | The console's quit question answers Cancel (default Quit); the question goes to `console-quit.jsonl` in the profile | **ignored** |
| `LAYTEKZ_TEST_AGENT_BIN=/abs/dir` | The agent buttons look for claude and codex only in this folder | **ignored** |
| `LAYTEKZ_TEST_AGENT_CONSENT=always\|cancel` | The agent consent question's answer (default Allow); questions go to `agent-consent.jsonl` | **ignored** |
| `LAYTEKZ_TEST_RETRY_MS=300` | Base delay of the offline retry backoff (default 2 s, capped at 60 s) | **ignored** |
| `LAYTEKZ_TEST_SIGNIN_DEBOUNCE_MS=300` | How long a waiting sign-in ignores another start (default 10 s) | **ignored** |
| `LAYTEKZ_TEST_SWITCH_GUARD=1` | Turns on, from source, the command-line switch check a packaged build always runs | not needed (always on) |

In a packaged build, test mode can only hide windows, redirect openExternal to
a file and isolate the profile. None of those weakens security, and the real
profile and its cookies are never touched. To point a packaged build at a test
server, write `{"serverUrl": "http://127.0.0.1:PORT"}` to
`$LAYTEKZ_TEST_USER_DATA/settings.json` first, as `tests/smoke-packaged.mjs`
does.

## Package

```sh
npm run pack:mac   # unpacked .app for this Mac's architecture → dist/mac-arm64/Laytekz.app (fast)
npm run dist:mac   # dist/Laytekz-<version>-mac-{arm64,x64}.{dmg,zip}
npm run dist:win   # dist/Laytekz-<version>-win-{x64,arm64}-setup.exe (NSIS)
npm run dist       # both
```

**Before you build:** electron-builder deletes the whole per-architecture
output folder (`dist/mac-arm64`, `dist/mac`, `dist/win-unpacked`, ...) before
it unpacks Electron into it, whatever else that folder holds. Never build into
a folder that holds an app someone is running. Release builds go to
`release/` instead (next section).

### Release builds

This is how the installers in `release/` were made (version 1.0.0, on an
Apple Silicon Mac, with Electron's zips already in `~/Library/Caches/electron`).
One target at a time, deleting each unpacked folder afterwards: an unpacked
build needs about 265 MB (macOS) or 360 MB (Windows) next to its installers,
and every installer is 105 to 127 MB.

```sh
env -u ELECTRON_RUN_AS_NODE npm test    # 76 tests; do not package a red tree

# release/Laytekz-<v>-mac-arm64.{dmg,zip}; keeps release/mac-arm64/Laytekz.app
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dmg:arm64 zip:arm64 -c.directories.output=release
# release/Laytekz-<v>-mac-x64.{dmg,zip}; check release/mac/ (below), then delete it
env -u ELECTRON_RUN_AS_NODE npx electron-builder --mac dmg:x64 zip:x64 -c.directories.output=release
rm -rf release/mac
# release/Laytekz-<v>-win-x64-setup.exe; check release/win-unpacked/, then delete it
env -u ELECTRON_RUN_AS_NODE npx electron-builder --win nsis:x64 -c.directories.output=release
rm -rf release/win-unpacked
# release/Laytekz-<v>-win-arm64-setup.exe; check release/win-arm64-unpacked/, then delete it
env -u ELECTRON_RUN_AS_NODE npx electron-builder --win nsis:arm64 -c.directories.output=release
rm -rf release/win-arm64-unpacked

# The zip blockmaps are auto-update metadata (this app has no auto-update), builder-debug.yml a debug dump.
rm -f release/Laytekz-*.zip.blockmap release/builder-debug.yml
(cd release && shasum -a 256 Laytekz-*.dmg Laytekz-*.zip Laytekz-*-setup.exe > SHA256SUMS.txt)
```

The checks run on these builds (macOS can check everything but running the
Windows apps):

- **macOS, both architectures:** extract the zip with
  `ditto -x -k release/Laytekz-<v>-mac-<arch>.zip <tmp>`, or copy the app out
  of the dmg mounted with `hdiutil attach -nobrowse -readonly`, and run
  `LAYTEKZ_APP=<tmp>/Laytekz.app/Contents/MacOS/Laytekz npm run test:packaged`
  on that copy (20 checks, hidden test mode, throwaway profile). The x64 app
  runs under Rosetta. Its first launch can time out while Rosetta translates
  Electron, so run it a second time. Also: `codesign --verify --deep --strict`,
  `codesign -dv` (expect `Signature=adhoc`, `flags=0x10002(adhoc,runtime)`,
  no team ID), `spctl -a -vv -t exec` (expect `rejected`: there is no
  Developer ID), `syspolicy_check distribution` (expect only "Notary Ticket
  Missing") and `hdiutil verify` on each dmg.
- **Windows, both architectures:** the installer is a 32-bit NSIS stub for
  both architectures (it runs on ARM64 Windows too). Its version resource
  names Laytekz and the package version, and its icon is `build/icon.ico`. `7z l` on the installer lists `$PLUGINSDIR/app-64.7z` or
  `app-arm64.7z`, which holds `Laytekz.exe` (PE32+ x64 or ARM64) with the
  same version, icon and fuses, and an `INTEGRITY` resource equal to the
  SHA-256 of the `app.asar` header. With the integrity fuse on, a mismatch
  would stop the app from starting.
- **All four:** every fuse is read back with `@electron/fuses`, and `app.asar`
  holds exactly `package.json` and `src/`, byte for byte (`@electron/asar`).

The config is in `electron-builder.yml`. Notes:

- **Signing:** there is no Apple Developer ID and no Windows certificate. Mac
  builds are signed ad hoc (`identity: "-"`), which is what Apple Silicon
  needs to run them at all, with the **hardened runtime** and no
  notarization. The hardened runtime stops `DYLD_INSERT_LIBRARIES` and
  similar from loading code into the app; `build/entitlements.mac.plist`
  allows only what Electron needs (JIT, and library validation off because an
  ad hoc signature has no team ID). Windows
  executables are not signed (`signExecutable: false`), but they still get
  their icon and version information.
- **Cross-building Windows on a Mac** needs neither Wine nor rcedit.
  electron-builder 26 edits Windows resources with the pure-JavaScript
  `resedit`, and downloads its own NSIS. To build one architecture only, run
  `npx electron-builder --win nsis:x64` (the plain `--x64` flag does not
  override the per-target architectures in the config).
- **Icons:** the config points at `build/icon.icns`, `build/icon.ico` and
  `build/icon.png`. If one is missing, electron-builder falls back to the
  Electron icon with a warning and the build still succeeds.
- **Files:** the archive holds only `package.json` and `src/`. asar is on.
- **Fuses:** these are flipped at package time, which is why they do not apply
  to `npm start`.

  | Fuse | Setting | Why |
  | --- | --- | --- |
  | `RunAsNode` | off | `ELECTRON_RUN_AS_NODE` cannot turn the app into a Node interpreter |
  | `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` are ignored |
  | `EnableNodeCliInspectArguments` | off | `--inspect` and SIGUSR1 cannot attach a debugger to the main process |
  | `OnlyLoadAppFromAsar` | on | no side-loading of an unpacked `app/` folder |
  | `EnableEmbeddedAsarIntegrityValidation` | on | `app.asar` must match the hash embedded at build time |
  | `EnableCookieEncryption` | on | the cookie store, which holds the session cookie, is encrypted with an OS-held key |
  | `GrantFileProtocolExtraPrivileges` | off | local pages use `laytekz-ui://`, not `file://` |
  | `LoadBrowserProcessSpecificV8Snapshot` | off | not used |

## How sign-in works

The web UI's login page links to `/api/auth/oauth/google`. The app never loads
that URL in a window. It intercepts it on `will-navigate`, `will-redirect` and
`window.open`, and runs the desktop handoff (RFC 8252 loopback redirect with
PKCE) against the server's `/api/auth/desktop/*` routes:

```text
 App (main process)            System browser                 Laytekz server
 ──────────────────            ──────────────                 ──────────────
 verifier = 32 random bytes (base64url)
 challenge = b64url(SHA-256(verifier)); state = 32 random bytes
 listen on 127.0.0.1:<random>/callback
 openExternal ───────────────► GET /api/auth/desktop/start
                                 ?code_challenge&code_challenge_method=S256
                                 &redirect_uri=http://127.0.0.1:<port>/callback
                                 &state&provider=google ─────► validates, signed cookie,
                                                               302 to Google sign-in
                               (Google sign-in) ─────────────► callback, session
                                                               GET /api/auth/desktop/continue
                                                               (confirm page if the browser
                                                               was already signed in)
               ◄────────────── 302 http://127.0.0.1:<port>/callback?code&state
 check state (constant time)
 POST /api/auth/desktop/exchange  {code, code_verifier, redirect_uri}
   from the window's own session (session.fetch, credentials: include)
                                                         ────► 200 {user} + Set-Cookie aldine_session
 GET /api/auth/me (same session) → user present
 answer the browser "You are signed in. Return to Laytekz."; close the listener
 reload the window, bring it to the front
```

Details:

- The listener accepts only `GET /callback`, with `Host: 127.0.0.1:<port>` to
  guard against DNS rebinding. A wrong `state` gets a 400 page and is
  otherwise ignored, so the real callback can still arrive. The first callback
  with the right state ends the attempt, and the listener then closes. Every
  answer is a small script-free page with a strict CSP, `no-store` and
  `Referrer-Policy: no-referrer`.
- While waiting, a toast says "Finish signing in in your browser" and offers
  **Open the Browser Again** (the same start URL) and **Cancel**. An attempt
  ends after 5 minutes. It also ends when a new attempt starts, on
  `error=access_denied`, on an exchange failure, on Cancel, or when the app
  quits. When it ends, the listener closes and the toast explains the outcome
  with **Try Again**.
- An account awaiting approval never reaches the callback. The browser shows
  the server's "Waiting for approval" page and the app times out with a hint.
- The exchange runs through `session.fetch` in the window's partition with
  `credentials: 'include'`, so Chromium stores the HttpOnly `Set-Cookie`
  directly in that session. The cookie never passes through app code. The
  request also sends `Origin: <server origin>`.
- The verifier, the code and cookies are never logged. The verifier is
  dropped when the attempt ends.
- Sign-out is the web UI's own `POST /api/auth/logout`.

## Security decisions

Remote content is treated as untrusted with respect to the OS.

- **Remote windows** (the main window, same-origin popups, the auth window)
  use `contextIsolation`, `sandbox`, `webSecurity` and `safeDialogs`. They
  have no `nodeIntegration` (also off in workers and subframes), no `webviewTag`
  and **no preload**. The remote page gets no API from the app. All of them
  share the persistent partition `persist:laytekz`.
- **Local pages** (offline screen, toast, Change Server) are served from
  `laytekz-ui://app/` in a separate in-memory partition. Its network access is
  cancelled except for that scheme, and it has no permissions or downloads.
  The scheme is not registered in the remote session. Each local page has a
  CSP (`default-src 'none'; script-src 'self'; style-src 'self'`) as a
  response header and as a meta tag. Their preload exposes three functions
  over two IPC channels, and the main process accepts IPC only from
  registered local webContents whose top frame is on `laytekz-ui://app/`.
- **Navigation:**
  - Top-level navigation stays on the configured origin (and base path). The
    sign-in link starts the handoff. Any other `http(s):`/`mailto:` URL is
    handed to `shell.openExternal` after a scheme check. Everything else,
    including `file:`, is blocked. An app-wide guard also blocks `file:` in
    every webContents and refuses `<webview>` attachment.
  - `window.open` to the same origin opens an in-app window with the same
    hardening and policy, built from a fixed option set: the page's features
    string (frameless, always on top, not closable, off screen, opacity, ...)
    is ignored. Such a window outlives the main window, so closing the main
    window never discards a project window's unsynced edits without its
    prompt. At most 10 app windows exist at once. Any other `window.open`
    goes to the system browser.
  - **No-gesture limits:** a page can navigate or call `window.open` without
    a click, which a browser's popup blocker would stop. Four hand-offs to the
    system browser within 10 seconds pass; past that each one asks "Open
    <host> in your browser?", one question at a time. A new sign-in start
    while one is waiting and less than 10 seconds old does nothing.
  - The sign-in link is matched after decoding percent-escapes, as the
    server's router does, so `/api/auth/oauth/goo%67le` also starts the
    handoff. A redirect chain that starts under `<base>/api/auth/` and leaves
    the server is blocked, never shown in an embedded window.
  - **Integration round trips** (GitHub, GitLab and similar) are recognised
    as a redirect chain that starts at the server's `/api/` and leaves the
    origin. The window's navigation is cancelled and the chain is replayed in
    a hardened **auth window** in the same session. That window follows the
    servers' own redirects (https, or http on loopback only), and a page in
    it may move within the sites those redirects reached; a link to any other
    site opens in the system browser. Its title always shows the host it is
    on, its popups go to the system browser, and `beforeunload` cannot trap
    it. When
    the chain returns to a non-`/api/` page on the server, the auth window
    closes and that page loads in the window that started the flow, with the
    same cookies.
- **Permissions:** everything is denied except `clipboard-sanitized-write`
  (copying), and that only for the server's origin. The web UI never reads
  the clipboard or uses the Fullscreen API. Device (HID, serial, USB) access
  is denied.
- **Client certificates:** a TLS client-certificate request is declined.
  Electron would otherwise answer with the first certificate in the store.
- **Downloads:** a download must come from the server's origin, `blob:` URLs
  on it included. `data:` URLs are refused (they name no origin, and the web
  UI does not use them). Program files (`.app`, `.command`, `.pkg`, `.exe`,
  `.msi`, `.bat`, `.ps1`, `.lnk` and similar) are refused. Each download goes
  through a native save dialog; downloads that arrive while one is open, or
  more than three dialogs in 15 seconds, are refused with a notice. A saved
  file gets the quarantine attribute on macOS and a Mark of the Web
  (`Zone.Identifier`, zone 3) on Windows, so Gatekeeper and SmartScreen check
  it when it is opened. It ends in a toast with **Show in Folder**.
- **Command line:** a packaged build exits at once, before any window,
  session or DevTools server exists, when it is started with any switch
  (`--remote-debugging-port`, `--proxy-server`, `--user-data-dir`, ...).
  Only macOS's own `-psn_…` argument is accepted. The fuses cover only
  Node's switches; Chromium's would otherwise hand the decrypted session to
  whoever started the app.
- **Unload:** the web UI blocks unload while edits are unsynced. The app turns
  that into a native "Leave / Stay" question instead of Electron's default of
  silently refusing to close. A quit cancelled with Stay leaves a sign-in in
  progress running.
- **Fuses:** see the table above.

## Native behaviour

- **Menus:** the macOS app menu has About Laytekz (version, Electron/Chromium,
  the connected server, the credit "Based on Aldine" with the upstream link
  `https://github.com/trahloff/Aldine`, the AGPL note with the server's
  source link `<server>/source`, the privacy page `<server>/privacy`, and
  buttons for both), Settings… (⌘,), Change Server…, Services, Hide Laytekz and Quit
  Laytekz. Then come Edit (standard roles), View (Reload, Force Reload,
  Developer Tools, zoom, full screen), Window, and Help (Laytekz Website,
  server source, Privacy). On Windows, File holds Settings… (Ctrl+,),
  Change Server and Exit, and Help holds About Laytekz.
- **Shortcuts:** the web UI owns ⌘/Ctrl + S, K, J, F, G, D, B, I, /, [, ],
  Enter, ⇧M, ⇧F, ⇧K, ⇧G and ⌥G, plus Shift+Alt+F, and CodeMirror takes Ctrl+M
  on Windows. No menu accelerator uses any of them (a test checks this). On
  Windows, Minimize therefore has no accelerator. The page always sees keys
  first.
- **Windows:**
  - Size, position and the maximized state are remembered, and a position on
    a disconnected display is dropped. The minimum size is 800×540.
  - A second launch focuses the running window. On macOS, closing the window
    keeps the app in the Dock, and clicking the Dock icon reopens it.
  - The window title follows the page title. The dark `#1c1c1e` background
    (the web UI's default theme) shows until the first paint.
  - A context menu offers Cut/Copy/Paste, spelling suggestions and link
    actions.
- **Offline:** if `/api/health` fails at start-up, or a top-level load fails
  (including gateway errors such as Cloudflare's 502/530), a local page shows
  the reason, **Retry Now** and **Change Server…**. It retries with
  exponential backoff (2 s doubling to 60 s) and reloads the page once the
  server answers.

Settings live in `settings.json` in the profile folder:
`~/Library/Application Support/Laytekz` on macOS and `%APPDATA%\Laytekz` on
Windows. They hold `serverUrl` and `window`. The folder and the keychain
item ("Laytekz Safe Storage") follow the product name, so a test build made
under the app's earlier working name kept its own: the first Laytekz launch
starts signed out with default settings. Sign in once; the earlier build's
folder and keychain item can be deleted by hand.

## Installing unsigned builds (for end users)

The instructions for the people who receive the installers are in
[`release/INSTALL.md`](release/INSTALL.md). Send it with the files, or paste it
into the release notes. It covers which file to pick, getting past Gatekeeper
and SmartScreen, signing in, updating and checking the checksums. Keep it in
step with this section's facts:

- Neither platform's build is signed with a paid certificate, so Gatekeeper
  ("Not Opened", then **Privacy & Security → Open Anyway**) and SmartScreen
  (**More info → Run anyway**) warn on first launch, and again for each new
  version.
- Ad hoc signatures change with every build, and the keychain item "Laytekz
  Safe Storage" (the key of the encrypted cookie store) trusts only the build
  that created it. After a macOS update, macOS asks once whether Laytekz may
  use it. **Always Allow** keeps the session; Deny means signing in again.
- `LSMinimumSystemVersion` is 13.0 (Electron 45). Windows 10 or later.
- The Windows installer installs for the current user only (no administrator
  rights), lets the user choose the folder, and adds Start-menu and desktop
  shortcuts. Running a newer installer replaces the old version and keeps
  `%APPDATA%\Laytekz`.

## Server contract notes

The app implements the desktop handoff contract as written. A few points the
server side should know:

- **Exchange `Origin`:** the exchange request sends `Origin: <server origin>`
  (the server's own origin, not the loopback one). If the server adds an
  Origin check on `POST /api/*`, the exchange passes it.
- **Non-200 exchange responses:** the app treats any non-200 as failure
  (`400 invalid_grant`, `415`, `429` with its own message, and anything else).
  It does not parse error bodies beyond the status.
- **Base path:** `ALDINE_BASE_PATH` is supported. A server URL with a path
  (`https://host/laytekz`) puts every contract URL under that path, and the
  sign-in link is matched as `<base>/api/auth/oauth/<provider>`.
- **The `/api/auth/oauth/*` intercept** also catches the "connect a sign-in
  method" flow, which is only available to password accounts. With
  `ALDINE_SSO_ONLY` that flow does not exist.
- **The state** is 43 base64url characters (32 random bytes). The contract
  allows 16 to 128.
- **About and Help** link to `<server>/source` (a redirect to wherever the
  server's AGPL source offer points: `GALLEY_SOURCE_URL`, its tarball, or
  upstream) and to `<server>/privacy`. Both are routes of the Laytekz server
  (`apps/server/src/galley-source.ts`, `privacy.ts`).

## License

The desktop app is released under the MIT License (see [LICENSE](LICENSE)).

The server it connects to is a separate project,
[laytekz-server](https://github.com/Computational-Memory-Lab/laytekz-server),
which is based on [Aldine](https://github.com/trahloff/Aldine) and licensed
under the AGPL-3.0. The desktop app loads that server's web interface; it does
not bundle any of its code.
