# Running a Laytekz server

Laytekz is a free, self-hosted collaborative LaTeX editor. This folder holds
the tooling that runs its server on a Linux machine of your own: three
ordinary processes under one user account, supervised by PM2. There are no
containers and no system services, and once the prerequisites are installed
nothing needs root. This guide covers what the server needs, first-time
setup, day-to-day operation and the security model.

An example of a running instance is https://latex.devon7y.com. The examples
below use `latex.example.com` for your site and `<your-server>` for the
server's SSH name.

**Names you will meet.** "galley" is the project's internal code name. It
lives on in directory names (`~/galley-server`, `~/galley-backups`), process
names (`galley-app`, `galley-compiler`, `galley-tunnel`), `GALLEY_*`
variables, the `Galley:` markers in the server code, and file names such as
`galley-sandbox.py`. "Aldine" is the open-source editor the server is based
on ([Aldine](https://github.com/trahloff/Aldine), AGPL-3.0); its settings are
the `ALDINE_*` variables. The Laytekz server, a modified fork of Aldine, lives
in its own repository,
[laytekz-server](https://github.com/Computational-Memory-Lab/laytekz-server).

```text
./status.sh                is everything healthy?
./deploy.sh                build the server code and switch to it
./deploy.sh --rollback     go back to the previous code
./logs.sh                  read logs
./backup-now.sh            take a backup now (one runs every night anyway)
./restore.sh               check or restore a backup
./update-tex.sh            update TeX Live
./setup.sh                 provision or repair the server; safe to re-run
```

Run them from `deploy/` in your checkout.

---

## 1. How the pieces fit

```text
 browser / desktop app
        |  https://latex.example.com
        v
 Cloudflare edge  <====  outbound tunnel  ====  galley-tunnel (cloudflared, PM2)
                                                       |
                                                       v  http://127.0.0.1:3040
                                                 galley-app (Node, PM2)
                                   web UI, API, Google sign-in, live collaboration
                                   (WebSocket /collab), SQLite database, git repos
                                                       |
                                                       v  http://127.0.0.1:3041
                                                 galley-compiler (Node, PM2)
                                   runs latexmk/biber inside galley-sandbox
                                   (Landlock + seccomp), writes PDFs into the project
```

* Nothing listens on a public interface. Both Node services bind
  `127.0.0.1`. The tunnel dials *out* to Cloudflare, so the server opens no
  inbound port.
* The server is upstream Aldine plus the fork's patches, built from
  laytekz-server. The compiler is Aldine's own compile service, hardened by
  the fork (see section 13). `./status.sh` shows which Aldine version the
  live code is based on.
* Every page calls the product Laytekz and credits "Based on Aldine". Two
  pages work signed out: `/privacy` and `/source`, which redirects to the
  AGPL source tarball of the running code (`/source.tar.gz?v=…`, rebuilt by
  every deploy, downloaded as `laytekz-source.tar.gz`).
* All data stays on the server: one SQLite database plus one git repository
  per project.

### How the scripts reach the server

The scripts live in two places: your checkout, which is the source of truth,
and a copy on the server in `~/galley-server/bin`. Run a script on your
workstation and it first copies this folder to the server with rsync, then
runs the same script there over `ssh` with the same arguments, and exits with
its status. Run it on the server (`~/galley-server/bin/status.sh`) and it does
the work directly. `lib/common.sh` decides which case applies: a Linux machine
with a `~/galley-server` directory is the server, anything else is a
workstation. `GALLEY_REMOTE=1` in the environment forces workstation mode,
`GALLEY_REMOTE=0` forces server mode.

On the workstation the scripts read `deploy/site.env` (section 4) and refuse
to run without it. The copy sent to the server never includes `site.env`,
other `*.env` files, `*.local.md` notes, `secrets/`, keys or credential files,
because `~/galley-server/bin` is readable from inside the compile sandbox.
The only setting passed along is the public URL; scripts started on the
server by cron or PM2 read it back from `config/app.env`.

Two exceptions. `deploy.sh` must be started on your workstation, because it
sends the server tree from there (`./deploy.sh --rollback` works on either
side). The helpers in `libexec/` run on the server only, for example
`ssh <your-server> galley-server/bin/libexec/verify-compiler.sh`.

## 2. What the server needs

The tooling installs nothing system-wide. Before the first run, have:

* **An x86_64 Linux machine you can reach with SSH**, with one ordinary
  account for Laytekz. Log in with a key: every command opens several SSH
  connections. Run nothing else under that account if you can (section 13
  explains why).
* **A kernel with Landlock enabled**, which the compile sandbox is built on.
  Linux 6.7 or newer (Landlock ABI 4) is recommended; section 13 says what
  older kernels lose. `setup.sh` refuses to continue without Landlock.
* **Common tools:** `/usr/bin/python3` (the sandbox and the backup checks),
  bash, rsync, git, curl, openssl, perl, GNU tar, `flock`, `ss`, and a
  working `crontab` for the account. latexindent needs the Perl modules
  YAML::Tiny and File::HomeDir. If they are not installed, `setup.sh` fetches
  the distribution's packages with `apt-get download` and unpacks them under
  `~/galley-server/opt/perl5`, which assumes Debian or Ubuntu.
* **Node.js 22**, unpacked at `~/.local/opt/node` so that
  `~/.local/opt/node/bin/node` and `npm` exist (the official Linux tarball
  works). It need not be on your PATH. `setup.sh` installs PM2 into it.
* **TeX Live**, installed with `install-tl` into `~/texlive/tl` (binaries in
  `~/texlive/tl/bin/x86_64-linux`). Use the full scheme, so documents can use
  any package; `config/texlive-scheme` says `full`, and the compiler reports
  it on `/health`.
* **A way to publish 127.0.0.1:3040 on the internet over HTTPS.** As shipped,
  the tooling uses Cloudflare Tunnel (the site's domain must be on
  Cloudflare): PM2 runs `/usr/local/bin/cloudflared` as `galley-tunnel`,
  and `setup.sh` refuses to run without that binary and
  `~/galley-server/cloudflared/config.yml`. Putting the binary in
  `/usr/local/bin` is usually the one step that needs an administrator. To
  publish the site another way, such as a reverse proxy on the same host,
  remove the `galley-tunnel` entry from `config/ecosystem.config.cjs`, the two
  `cloudflared` checks from `setup.sh` and `galley-tunnel` from the process
  check in `status.sh`. Keep `TRUST_PROXY=1` only if exactly one proxy sits in
  front, and give the proxy a read timeout above 90 s (see "Time limits" in
  section 13).
* **A Google OAuth client** for sign-in (Google Cloud Console, credentials of
  type *Web application*) with the authorized redirect URI
  `https://latex.example.com/api/auth/oauth/google/callback`. The consent
  screen needs only the `openid`, `email` and `profile` scopes.

On your workstation you need bash, ssh, rsync and curl, and a checkout of
this repository with laytekz-server cloned into `server/` beside `deploy/`,
as the [top-level README](../README.md) shows. `deploy.sh` ships that
`server/` folder unless told otherwise.

## 3. Layout on the server

Everything lives under the account's home directory. Every directory is mode
700 and every file 600; the scripts run with umask 077.

| Path | What it is |
|---|---|
| `~/galley-server/` | Laytekz's root |
| `  aldine` → `app-a` or `app-b` | symlink to the **live code slot** |
| `  app-a/`, `app-b/` | two built copies of the code (blue/green). A deploy builds the idle one, then flips the symlink |
| `  data/` | **DATA_DIR**: `projects/<id>/` (one git repo each), `worktrees/<id>/<branch>/`, compile output in each `.aldine-out/` |
| `  meta/` | **META_DIR**: `aldine.db` (users, sessions, shares, comments; SQLite in WAL mode), `yjs/` (live-editing snapshots), `undo/`, `avatars/` |
| `  cache/` | **CACHE_DIR**: disposable (template and venue-kit downloads) |
| `  config/app.env` | app settings + `ALDINE_SIGNING_SECRET` and `COMPILER_TOKEN` (both generated by setup.sh) |
| `  config/app.local.env` | optional: your own extra app settings (create it yourself; loaded last) |
| `  config/compiler.env` | compiler settings + the same `COMPILER_TOKEN` line. **Never put any other secret here** |
| `  secrets/google-oauth.env` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| `  cloudflared/` | tunnel `config.yml` + tunnel credentials JSON |
| `  admin-email` | the administrator address(es), one per line |
| `  compiler-home/` | the compiler's private HOME: temp dirs, font caches (luaotfload, fontconfig), biber's unpacked cache |
| `  tlmgr-backups/` | copies of TeX Live packages replaced by `update-tex.sh` (90 days) |
| `  opt/perl5/` | Perl modules latexindent needs, if setup.sh had to fetch them |
| `  source/galley-source.tar.gz` | the AGPL source of the live code (served at `/source.tar.gz`, downloaded as `laytekz-source.tar.gz`, top folder `laytekz-source/`), a hard link to `galley-source-<slot>.tar.gz` |
| `  bin/` | copy of this folder (scripts, sandbox, templates; no secrets) |
| `  logs/` | `app.log`, `compiler.log`, `tunnel.log` (PM2, rotated), `backup.log`, `cron.log`, `deploy-*.log`, `update-tex-*.log` |
| `  backups-staging/` | scratch space used during a backup or restore |
| `~/galley-backups/` | nightly backups, `galley-YYYYmmdd-HHMMSS.tar.gz`, newest 14 kept |
| `~/.pm2/` | PM2's own state: `dump.pm2` (saved process list), `modules/pm2-logrotate` |
| `~/.local/opt/node/bin` | Node 22, `npm`, `pm2` (not on the default PATH) |
| `~/texlive/tl/` | TeX Live (`bin/x86_64-linux` not on the default PATH) |
| `/usr/local/bin/cloudflared` | the tunnel binary (the one path outside your home directory) |

## 4. First-time setup

1. **Describe your installation.** On your workstation:

   ```bash
   cd deploy
   cp site.env.example site.env
   ```

   In `site.env`, set `GALLEY_SSH_HOST` to the server's host name or an alias
   from `~/.ssh/config`, and `GALLEY_PUBLIC_URL` to the site's address with no
   trailing slash. Git ignores `site.env`.

2. **Create the root and the private files on the server.**

   ```bash
   ssh <your-server>
   umask 077
   mkdir -p ~/galley-server/secrets ~/galley-server/cloudflared
   ```

   * `~/galley-server/secrets/google-oauth.env`, two lines, no quotes, no
     spaces:

     ```text
     GOOGLE_OAUTH_CLIENT_ID=<client id>
     GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
     ```

     `setup.sh` only warns when this file is missing, but the app refuses to
     start without it.
   * `~/galley-server/admin-email`: the administrator's address, one per line
     (section 9).
   * The tunnel. Create a named tunnel with `cloudflared` (`cloudflared tunnel
     login`, `cloudflared tunnel create` and `cloudflared tunnel route dns`;
     Cloudflare's documentation covers them), move its credentials JSON into
     `~/galley-server/cloudflared/`, and write
     `~/galley-server/cloudflared/config.yml`:

     ```yaml
     tunnel: <tunnel id>
     credentials-file: /home/<user>/galley-server/cloudflared/<tunnel id>.json
     ingress:
       - hostname: latex.example.com
         service: http://127.0.0.1:3040
       - service: http_status:404
     ```

   Backups do not include the Google secret or the tunnel credentials. Keep a
   copy of both in a password manager or a folder outside the repository,
   never inside it.

3. **Build the first code slot by hand.** `setup.sh` needs a built server
   tree and `deploy.sh` needs a provisioned server, so the very first tree is
   copied and built manually, with the same excludes and build commands that
   `deploy.sh` uses. From the root of your checkout:

   ```bash
   rsync -a --chmod=go-rwx --exclude=.git --exclude=node_modules --exclude=e2e/shots \
     --exclude=/site --exclude=/brand --exclude='.data*' --exclude='.secrets*' --exclude=dist \
     --exclude='/.galley-*' --exclude=.DS_Store --filter=':- .gitignore' \
     server/ <your-server>:galley-server/aldine/
   ```

   Then, on the server:

   ```bash
   export PATH=$HOME/.local/opt/node/bin:$PATH
   cd ~/galley-server/aldine
   npm ci --no-audit --no-fund
   npm run build -w apps/web && npm run build -w apps/server
   ```

4. **Provision.** Back on your workstation, in `deploy/`:

   ```bash
   ./setup.sh
   ```

   It checks the prerequisites (including the Landlock self-test), creates
   the directories and fixes their permissions, moves the tree into slot
   `app-a` behind the `aldine` symlink, renders `config/app.env` and
   `config/compiler.env` from the templates (generating
   `ALDINE_SIGNING_SECRET` and `COMPILER_TOKEN` once), fetches latexindent's
   Perl modules if needed, builds the AGPL source tarball, installs PM2 and
   pm2-logrotate, warms the compiler's font and biber caches (slow the first
   time), starts the three processes, saves the PM2 process list, installs
   the crontab block (section 15) and prints a brief status. It never touches
   `data/`, `meta/` or backups, and never prints a secret.

5. **Check.**

   ```bash
   ./status.sh
   ssh <your-server> galley-server/bin/libexec/verify-compiler.sh
   ```

   Then open https://latex.example.com, sign in with Google using the
   administrator's address, and typeset a document. From now on, ship code
   with `./deploy.sh`.

## 5. Start, stop, restart

Use PM2 on the server. It is not on the default PATH, so either prefix the
commands below or run `export PATH=$HOME/.local/opt/node/bin:$PATH` first:

```bash
ssh <your-server>
export PATH=$HOME/.local/opt/node/bin:$PATH
pm2 status                         # galley-app, galley-compiler, galley-tunnel (+ pm2-logrotate module)
pm2 restart galley-app             # e.g. after editing app.local.env or secrets/google-oauth.env
pm2 restart galley-compiler
pm2 restart galley-tunnel          # after editing cloudflared/config.yml (a few seconds offline)
pm2 stop galley-app                # take the site down (the tunnel then answers 502)
pm2 start galley-app
pm2 save                           # after start/stop/delete, so a reboot restores the same set
```

When the app stops, it writes every open document to disk and commits it
first. PM2 allows it 20 s before forcing the stop. If a process keeps
crashing, PM2 retries after 1 s, backing off to 15 s between tries, and never
gives up.

Do not edit `config/app.env` or `config/compiler.env` by hand: `setup.sh`
rewrites them. `./setup.sh --restart` re-renders both from the templates,
then restarts the app and the compiler. The tunnel keeps running. It keeps
the signing secret and the compiler token; when it has to create the token
(the first run after an upgrade from a version without one), it restarts both
processes even without `--restart`, because each must hold the same value.

## 6. Deploy and roll back

```bash
cd deploy                       # in your checkout
./deploy.sh                     # ships ../server, your laytekz-server clone
./deploy.sh --src /path/to/tree
./deploy.sh --rollback          # back to the previous slot, no build
```

What it does: it rsyncs the tree into the **idle** slot. The excludes are
`.git`, `node_modules`, `e2e/shots`, `/site`, `/brand`, `.data*`,
`.secrets*` and `dist`, plus every `.gitignore` rule of the repository, so
`.env`, `lifecycle-state.json`, `.claude/` and build output are never sent
or published. (It refuses a tree whose `.gitignore` uses `!` negation, which
rsync reads differently from git.) Then, on the server:

1. It runs `npm ci` only if `package-lock.json` changed since that slot's
   last install.
2. It runs the production build (web bundle, server, PDF viewer) and the
   slot's source tarball.
3. It takes a **backup**.
4. It makes sure `config/app.env` and `config/compiler.env` carry the same
   `COMPILER_TOKEN`, generating one if neither has it (an install from before
   the token gets it here, with no manual step). It prints whether it added
   one, never the value.
5. It flips the symlink and restarts the compiler and then the app.
6. It waits for health on 127.0.0.1 and through the public URL.

If health fails, the deploy flips back to the old slot by itself and prints
**FAILED** (exit 1). On success it prints **OK**. Data is never touched.

A deploy does not re-render the env files from the templates. When a
template changed (new settings such as `COMPILE_DEADLINE_MS`), run
`./setup.sh --restart` after the deploy.

**Downtime.** The site is down only while the app restarts. With nobody
editing, that is about a second. While someone has a document open, the app
writes and commits it within a second but may then not exit (an open
collaboration connection can hold up upstream's `app.close()`), and PM2 kills
it after its 20 s `kill_timeout`. People then see Cloudflare's 502 page for
about 20 s, and their editor reconnects. `./setup.sh --restart` and
`--rotate-compiler-token` cost the same.

**After a deploy**, check:

```bash
./status.sh                                                     # exit 0, "refused (401)", 127.0.0.1 only
ssh <your-server> galley-server/bin/libexec/verify-compiler.sh  # sandbox + token suite, all PASS
ssh <your-server> galley-server/bin/libexec/smoke-instance.sh   # real typeset through a throwaway app (ports 3050/3051)
```

Then typeset once on the site.

**Rollback caveat.** An upstream upgrade may migrate the database schema when
it first starts, and old code refuses a newer schema. Rolling back across a
migration therefore also needs the database from before it: run
`./restore.sh <the pre-deploy backup> --replace-live-data` after
`./deploy.sh --rollback`. The deploy prints that backup's file name.

**Source offer.** The AGPL requires the running code and the offered source
to match. Make every server change in your laytekz-server clone and ship it
with `./deploy.sh`, which rebuilds the tarball. Never patch the live slot in
place.

## 7. Status and logs

`./status.sh` reports the PM2 processes, health of the app and the compiler on
127.0.0.1 and of the public URL, the listeners (which must be 127.0.0.1
only), whether the compiler refuses a request without the token, the live
slot and its Aldine version, the served source tarball, disk use, the latest
backup and the crontab block. It exits 0 only when the processes, the health
checks, the listeners and the token check are all in order and a backup less
than 36 hours old exists. `./status.sh --brief` shows only processes and
health.

```bash
./logs.sh                  # last 40 lines of app, compiler, tunnel
./logs.sh app -n 300       # app | compiler | tunnel | backup | cron | deploy
./logs.sh app -f           # follow live (Ctrl-C)
./logs.sh errors           # error/warning lines across all logs
```

pm2-logrotate rotates the PM2 logs at 10 MB and nightly at 03:00 (server
time). It keeps 14 of them, gzipped. `libexec/tidy.sh` (hourly) rotates
`backup.log` and `cron.log` at 5 MB and removes leftover temp directories.

## 8. Backups and restore

**Automatic:** every night at 03:30 (server time), cron runs `backup-now.sh`.
Each backup is one tarball in `~/galley-backups`, and the newest 14 are kept.
It contains:

* `db/aldine.db`: a consistent copy of the live database, made while the app
  runs with upstream's own `dist/db/snapshot.js` (SQLite `VACUUM INTO`). It
  is never a `cp` of the live file, which can miss writes still in the WAL.
  It is checked with `PRAGMA integrity_check`.
* `data/`: all project repositories and worktrees (compile output left out).
* `meta/`: live-editing snapshots, undo images, avatars, instance settings.
* `config/`: both env files (including the signing secret and the compiler
  token).
* `MANIFEST.txt`.

**Not included:** `secrets/google-oauth.env` and the tunnel credentials in
`cloudflared/`. They rarely change; keep a copy of both in a password manager
or a folder outside the repository, never inside it. **Backups are credential
stores** (the database holds live session ids), so they stay mode 600.

**Off-machine copies.** The backups sit on the same disk as the data, and
nothing copies them elsewhere. Copy them off the server regularly, to a
private, preferably encrypted place outside the repository:

```bash
rsync -a <your-server>:galley-backups/ <backup-dir>/
```

The privacy page (`/privacy`) tells users that backups stay on the same
server. If you keep copies elsewhere, or your deployment otherwise differs
from what the page describes, edit its text (`apps/server/src/privacy.ts` in
the server repository) and deploy.

**Commands:**

```bash
./backup-now.sh                                  # now (--keep N to keep N instead of 14)
./restore.sh latest --into /tmp/check --boot     # unpack + verify a copy (never touches live)
./restore.sh galley-20261120-033000.tar.gz --replace-live-data
```

`--into DIR --boot` unpacks the backup on the server, runs `integrity_check`
and row counts, runs `git fsck` on every repository, then starts the app on
127.0.0.1:3060 against the copy and lists its projects. `DIR` must be an
absolute path on the server; delete it afterwards.

`--replace-live-data` refuses to run without that exact flag. It checks the
backup in a staging copy first. Then it stops the app and the compiler, moves
the current `data/` and `meta/` aside into
`~/galley-server/pre-restore-<time>/` (it deletes nothing), puts the restored
copies in place at the same absolute paths, repairs git worktree links, starts
everything and waits for health. Your current `config/` is kept unless you add
`--with-config`. People stay signed in after a restore.

Copies are taken while the app runs, as upstream does. A commit landing
mid-copy can leave one repository a few seconds behind the database; the
restored copy then lacks those seconds of that project's work.

## 9. Accounts

### Administrator address

`ALDINE_ADMIN_EMAILS` is read from `~/galley-server/admin-email`, which holds
one address per line. To change it, edit the file and run
`./setup.sh --restart`. If the file is missing or invalid, setup.sh writes a
placeholder and warns, and then nobody can approve accounts.

An address on that list signs in with Google straight away and can open
**/admin**. Everyone else waits for approval.

### Letting someone in

1. **Google side.** While your OAuth app's publishing status is *Testing*,
   Google itself lets only listed test users sign in. Add their Google
   address in Google Cloud Console under **Google Auth Platform → Audience →
   Test users** (formerly **APIs & Services → OAuth consent screen**). To drop
   this step, publish the app to *In production*. Apps that ask only for
   `openid email profile` usually need no Google review.
2. They open https://latex.example.com and sign in with Google. They see
   "Waiting for approval", and the app log records
   `[aldine] new account waiting for approval: <address>`. The tooling
   configures no mail transport, so no email is sent.
3. You open **https://latex.example.com/admin**. Waiting accounts are listed
   first. Choose **Manage → Approve account**, and they can sign in.

To turn someone away, delete the account in /admin. Disabling an account signs
it out everywhere at once.

### Rotating the Google client secret

1. In Google Cloud Console, go to **Credentials → your OAuth client (Web
   application) → Add secret**. Copy the new secret.
2. On the server, edit `~/galley-server/secrets/google-oauth.env` and replace
   `GOOGLE_OAUTH_CLIENT_SECRET=...` (no quotes, no spaces). Update your copy
   outside the repository too.
3. Run `pm2 restart galley-app`. Test a sign-in, then **disable or delete the
   old secret** in the console.

Existing sessions are unaffected. The redirect URI must stay
`https://latex.example.com/api/auth/oauth/google/callback`.

### Rotating the signing secret

Delete the `ALDINE_SIGNING_SECRET=` line from `config/app.env` and run
`./setup.sh --restart`, which generates a new one. Only 15-minute PDF links
and "known browser" cookies expire. Sessions do not.

### Rotating the compiler token

`COMPILER_TOKEN` is the shared secret the app sends to the compiler in the
`x-compiler-token` header. Every compiler route except `GET /health` answers
401 without it. The same line sits at the end of `config/app.env` and
`config/compiler.env`.

```bash
./setup.sh --rotate-compiler-token
```

This writes a new 64-character token into both files (it is never printed),
then restarts the compiler and the app. Typesets that are running at that
moment fail once; people just typeset again. Rotate it whenever you suspect a
copy leaked, for example a backup that left your control (`config/` is in
every backup). `./status.sh` reports whether the compiler refuses requests
without the token.

## 10. After a reboot

Nothing to do. Cron's `@reboot` entry runs `libexec/resurrect.sh`. It waits
15 s for the network, then runs `pm2 resurrect`, which brings back exactly the
set last saved with `pm2 save` (or starts `config/ecosystem.config.cjs` if
nothing was saved). Check with `./status.sh` a minute after boot. The tooling
uses cron rather than a systemd user service because a user service only
starts at boot when lingering is enabled for the account, which usually needs
root to turn on.

If Laytekz is not up, read `~/galley-server/logs/cron.log`, then run
`~/galley-server/bin/libexec/resurrect.sh` by hand on the server (or
`./setup.sh`, which starts anything missing). `resurrect.sh --dry-run`
reports what it would do.

## 11. Updating the server code

To take a new version of laytekz-server:

```bash
cd server                                  # your laytekz-server clone, in your checkout
git pull
cd ../deploy && ./deploy.sh
```

### Upgrading from upstream Aldine

Maintainers of the fork, or of your own fork, merge upstream releases:

```bash
cd server
git remote add upstream https://github.com/trahloff/Aldine.git   # once
git fetch upstream
git merge upstream/main                    # or a release tag, e.g. v1.17.0
# resolve conflicts; keep the fork's patches (search for "Galley:" in the code)
npm ci && npm run build                    # optional local check
cd ../deploy && ./deploy.sh
```

Before merging, read upstream's `CHANGELOG.md` for new or renamed environment
variables, and for anything under "Breaking". New variables go into
`config/app.env.template` or `config/compiler.env.template` here, followed by
`./setup.sh --restart`. Also note when a release changes the database schema,
because there is no downgrade (see the rollback caveat in section 6). The
deploy's own pre-deploy backup covers it.

## 12. TeX Live

```bash
./update-tex.sh --check    # what would change
./update-tex.sh            # tlmgr update --self --all, rebuild caches, restart compiler, verify
./update-tex.sh --install PKG...   # add packages (only useful with a smaller scheme)
```

After updating, it rebuilds the compiler's caches (biber's unpacked cache,
luaotfload's font database, fontconfig), restarts the compiler and runs
`libexec/verify-compiler.sh`. That script runs the full sandbox and
real-document test suite through the live compiler API (about a minute), and
you can run it any time:

```bash
ssh <your-server> galley-server/bin/libexec/verify-compiler.sh
```

Every package it replaces is kept for 90 days in
`~/galley-server/tlmgr-backups`. On the server,
`~/texlive/tl/bin/x86_64-linux/tlmgr restore --backupdir ~/galley-server/tlmgr-backups <pkg>`
undoes one.

A **new yearly release** of TeX Live (each spring) cannot be reached with
`tlmgr update`. To move to it:

1. Install it with `install-tl` into `~/texlive/tl-new`, using the same
   profile as before.
2. Stop the compiler, then `mv ~/texlive/tl ~/texlive/tl-<old year>` and
   `mv ~/texlive/tl-new ~/texlive/tl`.
3. Run `./setup.sh --warm --restart`, then `verify-compiler.sh`.

**Fonts.** XeLaTeX finds every TeX Live font by name, through fontconfig.
LuaLaTeX finds them through luaotfload's database. Popular families
(Libertinus, Source, Fira, Noto, STIX Two, TeX Gyre, EB Garamond, ...) are
pre-cached by `warm-caches.sh`. Any other font costs a few seconds per
compile, because a TeX run's own font cache lasts only that run.

**Thumbnails** (page-1 previews on the project list) are off
(`ALDINE_THUMBNAILS=0`). The compiler can render them with Ghostscript or
poppler's `pdftoppm`, which would then parse PDFs that users influence. Turn
them on (in `config/compiler.env.template`, then `./setup.sh --restart`) only
if one of those is installed from your distribution and kept updated by it; a
private copy in your home directory would miss its security updates.
Typesetting is unaffected, and projects show a placeholder.

## 13. Security model

**Who can get in.** Only people who sign in with Google, are on the Google
app's test-user list (while it is in Testing mode), and whom an administrator
approved in /admin. Password sign-in, sign-up and OAuth client
self-registration are off.

**What the network sees.** Only the tunnel reaches the app from outside. The
app and the compiler listen on 127.0.0.1 only, so from another machine their
ports are closed whatever firewall the host has; `./status.sh` checks the
listeners.

**Data at rest.** Everything lives under `~/galley-server` with permissions
700/600. Other accounts on the host cannot read it. Root, and anything
running as the service account, can. Nothing is encrypted at rest. The
database stores session ids, so a copy of it, or of a backup, lets someone act
as your users until those sessions expire.

**The compiler** runs every user's LaTeX. That is code, and TeX Live's own
switches do not contain it. Measured on TeX Live 2026:

* `openin_any = p` does **not** stop `\input` or `\openin` of `/absolute`
  or `../` paths.
* LuaLaTeX's `io.open` reads any file the account can read, including the
  app's `/proc/<pid>/environ`, which holds the Google secret.

So every TeX run is boxed in by **galley-sandbox** (`libexec/galley-sandbox.py`),
built on two unprivileged Linux kernel features:

* **Landlock** confines file access.
  * *Layer 1* is the compiler service. It can read the system, TeX Live and
    its own code, and write `data/` and its own HOME. `meta/` (the database),
    `config/`, `secrets/`, `cloudflared/`, `~/.ssh`, the backups and the rest
    of the home directory simply do not exist for it. It may bind its own
    port but not open TCP connections (on Linux 6.7 or newer; see "Kernel
    version matters" below).
  * *Layer 2* is each TeX run. It can see **only its own project**. The
    project root and its `.git` are read-only. Only the project's subfolders
    (such as `.aldine-out`, where output goes) and a private temp dir are
    writable. Other projects, shared caches and TeX Live are read-only or
    invisible. It has no TCP at all.
* **seccomp** refuses the system calls a TeX run never needs: creating any
  socket (so it cannot talk to PM2 or any other local service), io_uring,
  ptrace, bpf, perf_event_open, userfaultfd and the kernel keyring.
* Also: restricted shell escape (only TeX Live's vetted list, such as `bibtex`
  and `kpsewhich`), no `latexmkrc`, no format chosen by the document, an
  8 GB address-space and 1 GB file-size cap per process, lower CPU priority
  (nice 5), at most 3 compiles at once, at most 85 s per latexmk run, and an
  answer to every typeset request within 90 s (see "Time limits" below).
* **Main document names are checked** against an allowlist in both the app
  and the compiler: letters and accents of any script, digits, spaces and
  `. _ - ( ) +`, in folders. latexmk hands the name to `/bin/sh` inside double
  quotes, where a backtick runs a command, so a crafted file name would
  otherwise run a command in the compiler (still inside the per-run sandbox).
  A project whose main document already has such a name gets "Can't
  typeset ...: rename the file ..." and nothing runs.
* **The compiler API needs a token.** Requests without `COMPILER_TOKEN` in the
  `x-compiler-token` header get 401 (only `GET /health` is open), so other
  local accounts and services on the same host cannot start typesets through
  127.0.0.1:3041. The compiler refuses to start on 127.0.0.1 without a token.
  Request bodies over 64 KB are refused, and a tool's captured output is
  capped in memory.
* The compiler's environment holds exactly one secret, `COMPILER_TOKEN`. The
  launcher builds it from `compiler.env` alone (nothing inherited), never
  puts a value on a command line, and refuses any other secret-looking
  variable name. The compiler removes the token from its environment before
  it starts any tool, galley-sandbox drops it again for every TeX run, and a
  TeX run cannot read the compiler's `/proc/<pid>/environ` (Landlock).

**Kernel version matters.** Landlock has grown with each kernel release, and
galley-sandbox uses what the running kernel offers
(`/usr/bin/python3 -I ~/galley-server/bin/libexec/galley-sandbox.py selftest`
prints the ABI):

* Without Landlock at all, `setup.sh` stops and the compiler refuses to start.
* Below ABI 3 (Linux 6.2), Landlock cannot refuse `truncate()`, so a TeX run
  could empty files the account may write.
* Below ABI 4 (Linux 6.7), Landlock has no network rules: the compiler
  service itself could open TCP connections. TeX runs still cannot create
  any socket, because of seccomp.
* Signal scoping arrived in ABI 6 (Linux 6.12), and galley-sandbox does not
  request it, so on any kernel a TeX run can signal other processes of the
  same account (see below).

**Time limits.** Cloudflare gives up on a request after about 100 s and
shows its own error page. So the app answers every typeset request within
`COMPILE_DEADLINE_MS` (90 s), the wait behind the same branch's earlier
typesets included. It hands the compiler the time that is left, and the
compiler stops latexmk when that runs out, or after `COMPILE_TIMEOUT_MS`
(85 s) for a single run. The person then sees "Typesetting was stopped: this
server answers a typeset within 90 s ..." in the error list, not a gateway
error.

`verify-compiler.sh` proves all of this against the running service. It tries
to read a canary file, `aldine.db`, the env files, the app's environment,
another project and `~/.ssh`. It tries `\write18`, `os.execute`, `io.popen`,
writing `.git/config` and creating a git hook, and opening sockets. Every
attempt is refused. It also checks the token, refused main document names,
the body and time limits, and that an APA 7 + biblatex/biber paper, XeLaTeX,
LuaLaTeX, SyncTeX, the precompiled preamble and latexindent all still work.

**What an approved but malicious user could still do:**

1. Read and change their **own** projects and projects shared with them. A
   collaborator's document runs inside that same project's sandbox when you
   compile it, so it can do what the collaborator could already do by editing.
2. Read world-readable system files (`/etc/passwd`, `/usr`, TeX Live), and
   see the host's processes and their command lines through `/proc`, as any
   local account can. None of these should hold secrets, which is why the
   launchers never put one on a command line.
3. **Slow the machine down.** They can keep up to 3 compiles busy for 85 s
   each, use up to 8 GB of memory per process, or write large files into
   their own project until the timeout. Anything else on the same host shares
   that CPU and disk. The caps limit the damage but do not prevent it. If it
   becomes a problem, set `ALDINE_COMPILE_QUOTA_MIN` (minutes per user per
   month) or `ALDINE_COMPILE_PER_MIN`, or delete the account.
4. **Send signals** to other processes of the service account, for example to
   kill the app, which PM2 restarts within seconds. Landlock can scope
   signals only on Linux 6.12 or newer, and galley-sandbox does not use that
   feature. This is one more reason to run nothing else under that account.
5. Exploit a **kernel** bug to escape Landlock and seccomp. Install your
   distribution's kernel updates and reboot after them.
6. Abuse the app itself within their own rights: upload files, create
   projects, use disk space.

**Other local users** (other accounts on the host, or a compromised service
running as one of them) can connect to 127.0.0.1:3040 and 3041. The compiler
answers them only on `GET /health`; everything else needs `COMPILER_TOKEN`,
which only the service account can read (in `config/`, and in the environment
of its own processes). They can still reach the app without passing through
the tunnel, where they need an account like anyone else. That is upstream's
design, and it is acceptable on a host you control.

**What would make it stronger:** a separate Unix user for the compiler
(needs root), containers or a virtual machine around the services, and a host
that runs nothing besides Laytekz.

## 14. Configuration reference

**Your installation (`deploy/site.env`, on your workstation):**

| Variable | Default | Meaning |
|---|---|---|
| `GALLEY_SSH_HOST` | required | how you reach the server with `ssh`: a host name or an alias from `~/.ssh/config` |
| `GALLEY_PUBLIC_URL` | required | the public address, no trailing slash; becomes `ALDINE_PUBLIC_URL`, and deploy and status check its `/api/health` |
| `GALLEY_APP_PORT` / `GALLEY_COMPILER_PORT` | `3040` / `3041` | the loopback ports of the app and the compiler (see below) |
| `GALLEY_REMOTE` | auto | environment only: `1` always acts as the workstation, `0` always as the server |

A variable already set in your environment wins over the file. The two port
settings are used by the scripts where they run on the server, and
`site.env` is not copied there (only the public URL is passed along), so
ports set only in your workstation's `site.env` have no effect. Keep the
defaults unless something else on the server uses them. To move, put the
same two lines in `~/galley-server/bin/site.env` on the server (the tooling
copy leaves that file alone), point the tunnel's `config.yml` at the new app
port, then run `./setup.sh --restart` and `pm2 restart galley-tunnel`.

The rendered files on the server are `config/app.env` and
`config/compiler.env`, made from `config/*.env.template` by `setup.sh`.
Settings not listed below are upstream defaults (see "All configuration" in
upstream's [deploy/README.md](https://github.com/trahloff/Aldine/blob/main/deploy/README.md)).

**App, set explicitly:**

| Variable | Value | Why |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3040` | loopback only; the tunnel's target |
| `TRUST_PROXY` | `1` | one proxy (cloudflared) in front; real client IPs for rate limits |
| `ALDINE_PUBLIC_URL` | `https://latex.example.com` (from `GALLEY_PUBLIC_URL`) | OAuth callback, links, cookie security |
| `COOKIE_SECURE` | `1` | Secure cookies (also implied by the https URL) |
| `COMPILER_URL` | `http://127.0.0.1:3041` | |
| `COMPILER_TOKEN` | generated once (64 chars), same line as in compiler.env | sent to the compiler in `x-compiler-token`; never printed. Rotate: `./setup.sh --rotate-compiler-token` |
| `COMPILE_DEADLINE_MS` | `90000` | every typeset request is answered within 90 s, under Cloudflare's ~100 s limit; past it the typeset is stopped and reported as timed out |
| `AUTH_ENABLED` / `ALDINE_SSO_ONLY` | `1` / `1` | accounts on, passwords off |
| `ALDINE_SIGNUP` | `approval` | new accounts wait for /admin |
| `ALDINE_ADMIN_EMAILS` | from `~/galley-server/admin-email` | who may approve |
| `ALDINE_OAUTH_REGISTRATION` | `closed` | no self-registered OAuth/MCP clients, no client-metadata fetches |
| `ALDINE_PERSONAL_TEMPLATE_REPOS` | `0` | users cannot make the server `git clone` arbitrary URLs |
| `ALDINE_INSTANCE_NAME` | unset | the product name, Laytekz, is built into the code. Any value set here appears after it (`Laytekz · <name>`, `Provided by <name>`) |
| `DATA_DIR` / `META_DIR` / `CACHE_DIR` | `~/galley-server/{data,meta,cache}` | absolute, outside the code |
| `ALDINE_SIGNING_SECRET` | generated once (64 chars) | explicit, survives restores, never printed |
| `GALLEY_SOURCE_URL` / `GALLEY_SOURCE_TARBALL` | `…/source.tar.gz` / `~/galley-server/source/galley-source.tar.gz` | AGPL source offer (the fork's patch) |
| `GALLEY_GOOGLE_ENV` | `~/galley-server/secrets/google-oauth.env` | where `run-app.sh` loads the Google credentials from; the app refuses to start if the file is missing |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | from `secrets/google-oauth.env` | loaded by `run-app.sh`, not stored in config/ |
| `WEB_DIST`, `TEMPLATES_DIR`, `PLUGINS_DIR` | the live slot's folders | set by `run-app.sh` at start |
| `LOG_LEVEL` | `info` | |

**App, deliberately left unset (off or default):**

* `ALDINE_SUPPORT`: no support contact, so the privacy page tells people to
  ask whoever invited them to delete their account. To name a contact, set
  an email address or an https page here (`config/app.local.env`, then
  `pm2 restart galley-app`) or on /admin.
* `ALDINE_MCP`: no Claude connector.
* AI keys (`ANTHROPIC/OPENAI/OPENROUTER_API_KEY`): no AI fix.
* `SMTP_*` / `SES_FROM`: no email; links and notices go to the log.
* GitHub, GitLab and Gitea OAuth apps, `GITLAB_TOKEN`, `TEMPLATE_REPOS`,
  `SENTRY_DSN`, `REDIS_URL`, `DATABASE_URL`: SQLite is the database.
* `ALDINE_COMPILE_QUOTA_MIN` and `ALDINE_COMPILE_PER_MIN`: uncapped.
* `ALDINE_TRASH_DAYS` (30) and `RL_*` limits: upstream defaults.
* `ALDINE_AVATARS` (on): the server keeps its own copy of Google profile
  pictures.
* `REMOTE_PROVIDERS` (all shown): users may connect *their own* GitHub,
  GitLab or Gitea account with a personal token to push or pull a project. To
  hide all three, put `REMOTE_PROVIDERS=none` in `config/app.local.env` and
  restart the app. A value that matches no provider hides them all, per
  `apps/server/src/remotes.ts` in the server repository.

**Compiler:** see the comments in `config/compiler.env.template`. In short:

* `HOST=127.0.0.1`, `PORT=3041`, the same `DATA_DIR`.
* `COMPILER_TOKEN`: the same line as in app.env, appended by setup.sh. Without
  it the compiler refuses to start on 127.0.0.1. (Upstream's container
  layout, with `HOST` unset, needs no token; `COMPILER_ALLOW_UNAUTHENTICATED=1`
  is the explicit way to run without one.)
* `COMPILE_TIMEOUT_MS=85000` (one latexmk run), `MAX_CONCURRENT_COMPILES=3`.
* `ALDINE_PREAMBLE_CACHE=1`, `ALDINE_THUMBNAILS=0`,
  `TEXLIVE_SCHEME_FILE` (pointing at `config/texlive-scheme`).
* Its own `HOME` (`compiler-home`), `TMPDIR` and `XDG_*`.
* `PAR_GLOBAL_TMPDIR` (biber's cache).
* PATH: sandbox shims, then TeX Live, then `/usr/bin:/bin`.
* `TEXMFCNF` pointing at `config/texmf/texmf.cnf`, the override that kpathsea
  reads first: paranoid in/out, restricted shell escape, `parse_first_line=f`,
  no formats from the project, private `TEXMF{HOME,VAR,CONFIG}`.
* `openin_any=p`, `openout_any=p` and `shell_escape=p` repeated as
  environment variables, which beat any texmf.cnf.
* The `GALLEY_SANDBOX_*` lists that define the two Landlock layers, and the
  per-run limits `GALLEY_TOOL_MAX_AS_GIB`, `GALLEY_TOOL_MAX_FILE_GIB` and
  `GALLEY_TOOL_NICE`.

## 15. Files in this folder

| File | Role |
|---|---|
| `deploy.sh`, `status.sh`, `logs.sh`, `backup-now.sh`, `restore.sh`, `update-tex.sh`, `setup.sh` | the commands above |
| `site.env.example` | template for `site.env`, your installation's settings (untracked, never copied to the server) |
| `lib/common.sh` | shared paths and helpers; loads `site.env`; the workstation-to-server re-run logic |
| `libexec/run-app.sh`, `libexec/run-compiler.sh` | PM2 entry points; load env files, start Node (the compiler inside the sandbox) |
| `libexec/galley-sandbox.py` + `libexec/shim.sh` + `libexec/shims/*` | Landlock/seccomp sandbox; the shims put `latexmk`, `pdflatex`, `xelatex`, `lualatex`, `synctex`, `latexindent` inside it |
| `libexec/warm-caches.sh` | builds the caches TeX runs may only read |
| `libexec/verify-compiler.sh` | sandbox + real-document test suite against the live compiler (`--port`, `--env` to point it at another instance): the token, the sandbox, refused root file names, body and time limits, real documents |
| `libexec/smoke-instance.sh` | throwaway second instance (ports 3050/3051, accounts off, its own token): create project → write .tex → compile → fetch PDF, token refusals, a refused main document name; `--verify` also runs verify-compiler.sh against it; `--backup` also backs it up and restores it (on port 3060). `GALLEY_CODE=<built tree>` and `GALLEY_BIN=<tooling copy>` test code or tooling before it goes live. `--serve[=SECONDS]` runs no API checks (with `--verify`, the sandbox suite first) and keeps the instance up for a client behind `ssh -L` until its SSH session ends (`SMOKE_APP_PORT`, `SMOKE_COMPILER_PORT`, `SMOKE_PUBLIC_URL`); the desktop app's [end-to-end collaboration test](../desktop/tests/e2e-collab/README.md) uses it |
| `libexec/make-source-tarball.sh` | builds the AGPL source tarball of a slot |
| `libexec/resurrect.sh`, `libexec/tidy.sh` | `@reboot` and hourly cron jobs |
| `config/ecosystem.config.cjs` | the PM2 process list (no secrets) |
| `config/app.env.template`, `config/compiler.env.template` | env templates (no secrets; setup.sh appends the generated ones) |
| `config/texmf/texmf.cnf` | kpathsea override for the compiler |
| `config/fonts.conf.template`, `config/luaotfload.conf` | font setup for XeLaTeX / LuaLaTeX |
| `config/texlive-scheme` | `full`, reported by the compiler's /health |

The crontab on the server holds this managed block, rewritten by `setup.sh`
(which writes absolute paths; lines outside the block are left alone):

```text
# >>> galley (managed by ~/galley-server/bin/setup.sh) >>>
@reboot    ~/galley-server/bin/libexec/resurrect.sh   >> ~/galley-server/logs/cron.log 2>&1
30 3 * * * ~/galley-server/bin/backup-now.sh --quiet  >> ~/galley-server/logs/backup.log 2>&1
17 * * * * ~/galley-server/bin/libexec/tidy.sh        >> ~/galley-server/logs/cron.log 2>&1
# <<< galley <<<
```

This tooling, like the rest of this repository, is released under the
[MIT License](../LICENSE); the server is AGPL-3.0. Report security problems
privately, as described in [SECURITY.md](../SECURITY.md).
