# Dynadoc

Dynadoc is a document editor built around a single container format. One
document holds rich text, spreadsheets, slides, a design canvas and embedded
files, together with the metadata and variables that bind them. Two file types
exist: `.xddoc` for ordinary documents and `.sddoc` for sealed documents, which
are encrypted and carry per-recipient access.

This repository contains the **client**: an Electron desktop application and a
web build, both written in Svelte 5 and TypeScript, plus Capacitor scaffolding
for iOS and Android.

Licensed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE).
Third-party components and their licences are inventoried in [NOTICE](NOTICE).

## What is not in this repository

The server side — the API bridge that handles accounts, licensing, document
storage and sealed-document key material — is **not open source** and is not
published here. The client talks to it over HTTPS.

Two consequences, stated plainly so you do not lose an afternoon to them:

- **You need an account on a running Dynadoc instance** to sign in, open stored
  documents or use collaboration. There is no offline or local-only mode in the
  code today, despite what older documents in `docs/` may suggest.
  For development there is a stand-in: `npm run stub-bridge` serves the same
  HTTP contract from one directory on your own disk, with no account, no cloud
  and no licence. It is how you run this repository without the bridge, and it
  is the recommended way in. Read
  [tools/stub-bridge/README.md](tools/stub-bridge/README.md) before you rely on
  it — it states which channels it answers, which it refuses by name, and what
  has not been verified end to end.
- **Several desktop features depend on binaries that are not in this
  repository.** The build previously shipped a local middleware executable, a
  TeX engine, a grammar checker, a document converter and a bundled JRE under
  `resources/bin/`. Those are third-party or server-coupled artefacts and were
  deliberately left out. The application starts without them; the features that
  call them fail individually.

The web build is the least encumbered entry point and is what we recommend for
contributors.

## Requirements

|         |                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js | **22 LTS**, exactly — the CI pins it and nothing in the repo enforces it for you                                                                               |
| npm     | **10** — npm 11 silently skips install scripts unless you approve them, which leaves you with an incomplete `node_modules` and no error                        |
| Git     | any recent version                                                                                                                                             |
| Linux   | `build-essential`, `python3`, `libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev` — the `postinstall` step runs `electron-rebuild` |
| macOS   | Xcode Command Line Tools                                                                                                                                       |
| Windows | Visual Studio Build Tools (C++) and Python 3, for `node-gyp`                                                                                                   |

## Getting started

```bash
git clone https://github.com/dynadoc/dynadoc.git
cd dynadoc

cp .env.example .env.local    # .env.local, not .env — see below
npm ci                        # not `npm install`: the lockfile is committed
```

Configure `.env.local`. Every variable is read at build time by Vite:

| Variable                 | Meaning                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL`           | Base URL of the Dynadoc API you are developing against. `http://localhost:7070` for a local backend, otherwise the instance you have an account on. |
| `VITE_IPC_WS_URL`        | Optional override for the local IPC WebSocket. Leave empty for the default.                                                                         |
| `VITE_TRANSCRIBE_WS_URL` | Speech-to-text endpoint used by meeting transcription. Leave empty to keep transcription idle.                                                      |

`.env` is not tracked and must not be committed. Use `.env.local`, which Vite
gives precedence and `.gitignore` already covers.

### Run

One command per target. The stub bridge (`tools/stub-bridge`) is the local
stand-in for the proprietary API bridge; it keeps its files in
`~/.dynadoc-stub`.

| You want                                  | Command                     | What it starts                                     |
| ----------------------------------------- | --------------------------- | -------------------------------------------------- |
| The web app, ready to use                 | `npm run dev:web:local`     | the stub on port 7070 and the web client (Vite)    |
| The desktop app                           | `npm run dev`               | the desktop app; no backend needed for local files |
| The desktop app with the stub beside it   | `npm run dev:desktop:local` | the stub on port 7070 and the desktop app          |
| Only the web client, stub already running | `npm run dev:web:stub`      | the web client pointed at `http://localhost:7070`  |
| Only the stub                             | `npm run stub-bridge`       | the stub on port 7070                              |

With `dev:web:local` and `dev:desktop:local`, Ctrl+C stops both processes,
a stub already listening on the port is reused, and anything after `--` goes
to the client (`npm run dev:web:local -- --open`). On macOS or Linux,
`make start` is the same as `dev:web:local` plus a first-time install and
opening the browser; `make stop` cleans up anything left behind.

Open the URL Vite prints for the web app. The first load compiles a large
dependency graph and can take a minute; the page reloads itself once if the
dev server was still re-optimising dependencies.

Which API the client talks to: `VITE_API_URL` if it is set (`.env.local`, or
the environment), else, when the page is served from `localhost`, the stub's
address `http://localhost:7070`. A development server never falls back to the
production API. One exception survives reloads: an API address the client
reached once is stored in `localStorage` under `ddoc.api_url` and wins over
`VITE_API_URL` until you clear it. See
[tools/stub-bridge/README.md](tools/stub-bridge/README.md) for what the stub
answers and what it refuses by name.

#### What works on desktop without the bridge and the binaries

Working with documents on your disk needs neither: create a document,
spreadsheet, presentation or design, type, save with Ctrl+S (Cmd+S) or
File > Save, Save As to any folder, open `.xddoc`, `.xlsx`, `.pptx` and
`.pdf` files with File > Open, export to PDF, and quit and relaunch with the
open tabs restored.

These need something this repository does not ship, and each one says so
when you use it instead of failing silently:

| Feature                                 | Needs                                     |
| --------------------------------------- | ----------------------------------------- |
| Sign in, accounts, cloud drive, sharing | the API bridge and `dynadoc-middleware`   |
| Sealed `.sddoc` documents               | `dynadoc-middleware`                      |
| Opening `.docx`, exporting to Word      | the `DocxToHtml` converter                |
| Integrated terminal                     | `node-pty` built for this Electron        |
| LaTeX, grammar checking                 | the TeX engine, the grammar checker (JRE) |

### Build

```bash
npm run build:web          # static web bundle in web/dist
npm run build:electron     # Electron bundle (main + preload + renderer) in out/
npm run build:linux:dir    # unpacked Linux app in dist/linux-unpacked
npm run build:linux        # packaged Linux app (AppImage, snap, deb)
npm run build:mac          # packaged macOS app
npm run build:win          # packaged Windows app
```

`build:linux:dir` is the quickest way to try a packaged build: run
`dist/linux-unpacked/dynadoc`. A packaged app is not served from `localhost`,
so it talks to the API set in `VITE_API_URL` at build time, and to the
production API if none was set; documents on your disk work either way.

The packaged builds are unsigned: no signing identity is configured in this
repository.

### Verify your install

Two native modules fail quietly often enough to be worth checking by hand:

```bash
ls node_modules/canvas/build/Release/canvas.node    # must exist
ls node_modules/node-pty/build/Release/*.node       # must exist
```

`node-pty` exits successfully while producing nothing on recent Node versions.
If that directory is empty, the app still starts; the integrated terminal
says it cannot load and how to fix it (`npm ci` again, so `electron-rebuild`
rebuilds it for this Electron).

## Repository layout

| Path                                  | Contents                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/main/`                           | Electron main process: filesystem and OS access, IPC handlers, window and tab management |
| `src/preload/`                        | Preload entry points (`index`, `browser`, `webview-var`, `embedded-var`)                 |
| `src/renderer/`                       | The application itself — Svelte 5 with runes, plus a vendored pdf.js                     |
| `src/renderer/src/extensions/tiptap/` | Editor extensions, one directory per feature                                             |
| `web/`, `web.vite.config.mts`         | Web target                                                                               |
| `android/`, `ios/`                    | Capacitor projects                                                                       |
| `build/`, `electron-builder.yml`      | Packaging configuration and icons                                                        |
| `extensions/`                         | Editor themes and file icons                                                             |
| `bin/DocxToHtml/`                     | C# sources of the DOCX converter (binaries are not committed)                            |
| `scripts/`                            | Repository tooling                                                                       |
| `docs/`                               | Design and architecture notes, of varying freshness                                      |

`src/main/index.ts` is a single large file. That is known, and it is being
addressed incrementally rather than in one move.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it covers the checks that
actually run, branch and commit conventions, and the pull request process.
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions and reports

- **Bug or feature request** — open an issue using the templates.
- **Question or design discussion** — open a GitHub Discussion rather than an
  issue.
- **Security vulnerability** — do not open a public issue. Follow
  [SECURITY.md](SECURITY.md).

## History

This repository starts from a snapshot of the client, not from the project's
first commit. See [NOTICE-HISTORY.md](NOTICE-HISTORY.md).
