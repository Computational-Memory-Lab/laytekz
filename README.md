# Laytekz

Laytekz is a free, self-hosted collaborative LaTeX editor. Several people can
write in the same document at once, the PDF recompiles as they type, and
everything (projects, history, accounts) stays on a server you run yourself.

It comes in two forms that share one interface: a website served by your
server, and a desktop app for macOS and Windows that connects to it.

## What it does

- **Real-time co-editing.** Everyone's cursor and edits appear live, the way
  they do in a shared document editor.
- **Live PDF.** The document typesets itself shortly after you stop typing, and
  you can jump between a place in the source and the same place in the PDF.
- **Review.** Comment on a passage, reply, suggest a replacement, resolve.
- **History.** Every project is a git repository. Browse earlier versions,
  restore them, work on branches, and sync with GitHub, GitLab or Gitea.
- **Two ways to write.** Plain LaTeX source, or a visual mode that renders
  headings, maths and tables in place while leaving the source untouched.
- **References.** Search for a paper by title, DOI or arXiv ID and add its
  BibTeX entry, keep a `.bib` file in step with a Zotero or Mendeley library,
  or link a `.bib` file on your computer (desktop app). Pickers for citations
  and cross-references insert the right command for your packages.
- **Writing help.** Brackets, `$…$` and environments close themselves, `&` and
  `%` are escaped where you mean them literally, maths previews exactly as it
  will typeset when you hover it, tables get a grid picker and tidy columns,
  and built-in commands format statistics (p values, Bayes factors and more).
  Optional grey suggestions complete the sentence with Tab, from the
  document's own words or a small model that runs on your computer.
- **Word counts** that leave out tables, references and supplementary
  material, with rules you can edit.
- **Comments anywhere.** Select text in the PDF and comment on it; the comment
  shows on the matching source. A separate highlighter marks source lines in
  colours of your choosing.
- **Import a ZIP or a folder**, and rename a project's main file without
  touching its PDF, bibliography and build files.
- **Console and AI agents** (desktop app). A terminal tab beside the editor,
  with buttons that start Claude Code or Codex on the open project.
- **Settings** for appearance (light, dark or match the system), fonts and
  editor behaviour, and an optional desk pet.
- **Sign in with Google.** New accounts wait for an administrator's approval,
  unless their address is on the administrator's approved list.
- **Sandboxed typesetting.** Each compile runs confined to its own project.

## Get the desktop app

Download the installer for your computer from the
[Releases page](https://github.com/Computational-Memory-Lab/laytekz/releases):

| Computer | File |
| --- | --- |
| Mac with Apple silicon | `Laytekz-<version>-mac-arm64.dmg` |
| Mac with an Intel processor | `Laytekz-<version>-mac-x64.dmg` |
| Windows (most PCs) | `Laytekz-<version>-win-x64-setup.exe` |
| Windows on ARM | `Laytekz-<version>-win-arm64-setup.exe` |

The installers are not signed with a paid developer certificate, so macOS and
Windows show a warning the first time you open the app.
[desktop/INSTALL.md](desktop/INSTALL.md) explains how to get past it and how to
check a download against its checksum.

The app connects to a Laytekz server. Signing in opens your web browser, and the
app picks up the session when you return to it.

## The two repositories

| Repository | What is in it | Licence |
| --- | --- | --- |
| [laytekz](https://github.com/Computational-Memory-Lab/laytekz) (this one) | The desktop app (`desktop/`) and the tooling for running a server (`deploy/`) | MIT |
| [laytekz-server](https://github.com/Computational-Memory-Lab/laytekz-server) | The server and web interface | AGPL-3.0 |

To work on both, clone the server into a `server/` folder beside `desktop/` and
`deploy/`; this repository ignores that folder.

```bash
git clone https://github.com/Computational-Memory-Lab/laytekz.git
cd laytekz
git clone https://github.com/Computational-Memory-Lab/laytekz-server.git server
```

## Run your own server

[deploy/README.md](deploy/README.md) covers what the server needs (a Linux
machine, Node.js and TeX Live; no containers and no root access are required),
first-time setup, deploying, backups, and the security model.

## Build the desktop app

[desktop/README.md](desktop/README.md) covers running from source, the tests,
and packaging the installers.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## Licence and credits

The desktop app and the deploy tooling in this repository are released under
the [MIT License](LICENSE).

The server is based on [Aldine](https://github.com/trahloff/Aldine) by Tobias
Rahloff and is licensed, like Aldine, under the AGPL-3.0. Laytekz is a separate
project and is not affiliated with or endorsed by the Aldine project.
