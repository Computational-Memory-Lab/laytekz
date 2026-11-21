# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on this repository's **Security** tab,
choose **Report a vulnerability**. The same applies to the server repository,
[laytekz-server](https://github.com/Computational-Memory-Lab/laytekz-server),
for problems in the server or the web interface.

Include what you found, how to reproduce it, and which version you tested (the
desktop app's version is under **Laytekz > About Laytekz**; the server's is in
the web interface's About dialog).

## What to expect

Reports are read by the maintainers. This is a small research-lab project with
no dedicated security team, so replies may take a few days. Fixes are released
in the next version, and the report is credited unless you would rather it were
not.

## Scope

- The desktop app in `desktop/`.
- The deployment tooling in `deploy/`, including the compile sandbox.
- The Laytekz changes to the server (listed in `GALLEY.md` in the server
  repository).

A problem that also exists in upstream [Aldine](https://github.com/trahloff/Aldine)
is best reported to that project as well, following its own security policy.
