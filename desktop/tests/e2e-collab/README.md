# End-to-end collaboration test

One script that proves Laytekz's three promises with real software:

- **(a)** LaTeX editing with a live PDF,
- **(b)** real-time co-editing between two clients,
- **(c)** both running through the Laytekz desktop app.

Two copies of the desktop app, run from source, edit one project on a
throwaway Laytekz instance on the server. That instance runs the **live code slot**
(`~/galley-server/aldine`) and a **copy of the live tooling**
(`~/galley-server/bin`: run scripts, galley-sandbox, shims), so its compiler
runs inside the same Landlock + seccomp sandbox as the site. Accounts are off,
and it has its own data, meta and cache directories and its own compiler token.
The live processes, data and database are not touched and nothing live is
restarted. As `smoke-instance.sh` always has, the throwaway compiler starts
from the live `config/compiler.env` (with its own port, data directory and
token) and shares the compiler's warmed font and biber caches in
`compiler-home`. No Google sign-in happens.

## Run it

From `desktop/` on your workstation:

```sh
env -u ELECTRON_RUN_AS_NODE node tests/e2e-collab/collab-e2e.mjs
```

It takes about two and a half minutes (about 20 s of them for the sandbox
suite) and exits 0 only when every step passes. It needs:

- SSH to your server working without a prompt (the script opens three SSH
  connections: setup, the instance, the port forward);
- `npm install` done in `desktop/` (Electron 45 and `@playwright/test`);
- at least 2 GB free on your workstation (checked at start);
- optionally `pdftotext` (Homebrew poppler) to read the PDFs' text outside the
  app; without it the PDF text is checked through the app only.

It is not part of `npm test`: the file names do not match `*.spec.mjs`, and it
needs the server.

| Variable | Default | Effect |
| --- | --- | --- |
| `LAYTEKZ_E2E_SSH_HOST` | `GALLEY_SSH_HOST` from `deploy/site.env` | SSH host of the Laytekz server |
| `LAYTEKZ_E2E_APP_PORT` / `LAYTEKZ_E2E_COMPILER_PORT` | `3052` / `3053` | ports of the throwaway app and compiler on the server (127.0.0.1 only; 3040/3041 are refused) |
| `LAYTEKZ_E2E_SERVE_SECONDS` | `2400` | the instance stops by itself after this long, whatever happens on your workstation |
| `LAYTEKZ_E2E_VERIFY_SANDBOX` | `1` | `0` skips `verify-compiler.sh` against the throwaway compiler |
| `LAYTEKZ_E2E_TMP` | the OS temp folder | where the run's temp folder (two app profiles, downloads, fetched PDFs) is made |
| `LAYTEKZ_E2E_KEEP` | unset | `1` keeps that temp folder |

## What it sets up, and tears down

```text
 Mac                                                     the server (127.0.0.1 only)
 ───                                                     ─────
 desktop app A ─┐                                        smoke-instance.sh --serve
 (from source,  │   relay            ssh -N -L           ├─ app      :3052  (live code slot,
  test mode)    ├─► 127.0.0.1:P ───► 127.0.0.1:F ══════► │            accounts off, own data)
 desktop app B ─┘   (tags A / B)                         └─ compiler :3053  (galley-sandbox,
 (own profile)                                                         own token)
```

1. On the server: `mktemp -d ~/galley-server/e2e-collab-XXXXXX`, a copy of
   `~/galley-server/bin` into it, and this checkout's
   `deploy/libexec/smoke-instance.sh` over the copy's (it has `--serve`).
2. Over SSH: `smoke-instance.sh --serve` with `GALLEY_BIN` pointing at that
   copy, `SMOKE_APP_PORT=3052`, `SMOKE_COMPILER_PORT=3053`, and
   `SMOKE_PUBLIC_URL=http://127.0.0.1:P`, which becomes the instance's
   `ALDINE_PUBLIC_URL`, so the fork's Origin checks run exactly as on the
   site. With `--verify` it first runs `verify-compiler.sh` (the sandbox and
   token suite: canary reads, `aldine.db`, env files, other projects,
   `\write18`, sockets, real documents) against the throwaway compiler, and
   refuses to serve if any check fails (`environment.sandboxSuite` in
   `results.json`). The script stops the instance and deletes its directory
   when that SSH session's input closes, so a crashed run still cleans up on
   the server.
3. `ssh -N -L 127.0.0.1:F:127.0.0.1:3052 the server`: nothing new listens on any
   network interface on either machine.
4. A relay on `127.0.0.1:P` (`relay.mjs`). Both apps load the same origin
   through it. Each app appends `LaytekzE2E/A` or `/B` to its session's
   User-Agent, and the relay uses that tag to cut one app's connections on
   its own (step 7).
5. Two Electron apps from source with `LAYTEKZ_TEST_MODE=1` (windows never
   shown), separate `LAYTEKZ_TEST_USER_DATA` profiles (so the single-instance
   lock and the sessions do not collide), and `LAYTEKZ_TEST_SERVER_URL`
   pointed at the relay. The installed app and its profile are not touched.

At the end it closes both apps, the relay and the forward, stops the instance,
deletes the tooling copy, and checks that ports 3052/3053 are free and both
remote directories are gone (`teardown` in `results.json`). If a run is killed
hard, the instance still stops on its own; remove a left tooling copy with
`ssh the server 'rm -rf ~/galley-server/e2e-collab-*'`.

## The steps

Every step is recorded as pass or fail in `evidence/results.json`, with its
details and timings; a failure does not stop later steps (only step 1 is
required by the rest).

1. **Project.** A clicks New project, names it, picks the **Article**
   template and creates it: the editor opens `main.tex`. B goes to its
   project list and opens the card. Both editors hold the same text; both
   window titles say Laytekz.
2. **Presence.** Each window's presence chip shows the other person, in
   `main.tex` (`data-here="true"`).
3. **Co-editing.** A types five probe words at the end of one line; for each,
   the time from A's last keystroke to the word's appearance in B's editor
   (a MutationObserver in B, same wall clock) is recorded. Then the same B→A.
   A's caret, labelled with A's name, is drawn in B's editor on the line A is
   typing in. Then A and B type a sentence each, at the same time, keystroke
   by keystroke, in different paragraphs. Both editors' full documents
   (CodeMirror's state, not the DOM) must become identical, with each
   sentence exactly once and where it was typed, and the length exactly the
   original plus everything typed.
4. **Live PDF.** A types a sentence and stops. Without anyone pressing
   Typeset, A's preview must show a new PDF whose text layer holds the
   sentence; B's preview must show the **same run** (`data-pdf`) and B must
   have sent **no** typeset request. The server's PDF is also fetched and read
   with `pdftotext`.
5. **Errors.** B types `\kzbrokenmacro` on a line of its own. B's automatic
   typeset reports it: the status says "1 error" and the problems panel
   header "1 error", folded (upstream folds the errors of a typeset made while
   you type, so a half-typed command does not pop a list open). The test opens
   it, as a person would, and the row must say "Undefined control sequence"
   with `main.tex · line N`, N being the line B typed on. A's panel follows
   the same run. B deletes the line; the document is byte-identical to before
   and the next automatic typeset is clean in both.
6. **SyncTeX.** Forward: A's caret on a line, Jump to PDF, a flash band must
   appear on that line's output. Inverse: a double-click on one of A's probe
   words in the PDF must move A's caret to the source line that holds it.
7. **Reconnect (B alone).** The relay cuts every connection of B and refuses
   new ones. B must say it is offline. A types a sentence and B types one
   offline, and neither may reach the other while cut. On restore, both
   documents must converge with each sentence once and the exact expected
   length (no duplicated document, nothing lost).
   **7b (both).** The SSH forward itself is killed while both type, then
   restarted on the same port; both converge the same way.
   **7c (live PDF after the outages).** With nobody pressing anything, the
   previews must catch up with the text typed while cut off, within 20 s of
   the reconnect. If they do not, the step fails, and the test then presses
   Try again (or Typeset) in A, as a person would, so the later steps start
   from a current PDF; the time that took is recorded.
8. **Download.** A clicks Download the PDF. The shell's `will-download`
   handler asks where to save (a native dialog, answered by the test in the
   main process, as the shell's own tests do), saves the file, marks it with
   `com.apple.quarantine`, and shows its "Saved …" toast. The file must start
   with `%PDF-` and `pdftotext` must find the sentences typed so far.
9. **Persistence.** The server's `main.tex` (its file API) must equal both
   editors' text.

## Evidence

`evidence/` holds, for the last run:

- `results.json`: every step's status, details and error, the timings
  (`keystrokeToRemoteMs`, `concurrentConvergeAfterLastKeyMs`,
  `idleToNewPdfMs`, `reconnect`, `reconnectBoth`), the environment (code slot,
  ports, app identity, relay counters) and the teardown checks;
- `NN-<moment>-A.png` / `-B.png`: both windows at the key moments, at most
  1100 px wide (`*-FAILED-*.png` when a step fails);
- `07e-preview-stale-after-outage-A.png` (only when step 7c fails): A's
  window 20 s after the reconnect, the offline sentences in the editor and a
  "Failed" preview from before them;
- `08-shell-toast-A.png`: the shell's own "Saved …" toast (a view of its own
  over the page, so it is captured separately from `08-download-A.png`);
- `08-downloaded.pdf` and `08-downloaded-pdf.txt`: the file the shell saved,
  and its text;
- `09-final-main.tex.txt`: the server's final `main.tex`.

Each run replaces these files.

## Known gap (step 7c)

On 2026-11-20 every step passed except 7c. When the connection drops while a
client has unsent edits, its automatic typeset fires, cannot reach the server
and fails ("Typesetting failed: Could not reach the server", status "Failed",
"Preview is from the last successful typeset"). Nothing re-arms it when the
collaboration socket reconnects, so the edits made while cut off reach the
other client and the server's file at once, but no PDF until someone types
again or presses Try again or Typeset. This is upstream web code
(`apps/web/src/pages/Editor.tsx`: `doCompile`'s catch sets `result: null`
and a `requestError`; `armAutoTypeset` is only called from local edits and
agent signals). A fix would re-arm the automatic typeset when the open
document's sync state goes from disconnected to connected while the last
typeset failed with a request error.

## Notes on test mode

- Windows are hidden, so the OS never focuses them. Playwright's Chromium
  focus emulation makes `document.hasFocus()` true in each page
  (`environment.focusEmulated` in `results.json`); without it the remote
  carets of step 3 would not be published, because y-codemirror publishes a
  caret only from a focused document, as for a person typing.
- The caret is placed with CodeMirror's API (what a click on the line does);
  all text is typed with real key events.
- The anonymous names are set in `localStorage` (`aldine.name`,
  `aldine.color`), which is what Project settings → Your name writes.
