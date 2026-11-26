# Architecture

> Dense reference document. New to the codebase? Start with [ONBOARDING.md](ONBOARDING.md), then come back here.

## System Overview

Dynadoc is an open-core document application. This repository is the client
(GPL-3.0): one Svelte 5 renderer, shared by three targets (desktop with
Electron, web with Vite, mobile with Capacitor). Everything that needs an
account, storage or key material lives in the API bridge, a separate
proprietary service that the client reaches over HTTPS.

```
┌─────────────────────────── This repository (GPL-3.0) ───────────────────────────┐
│                                                                                 │
│  Renderer (src/renderer, Svelte 5, shared by every target)                      │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ Text       Spreadsheet       Presentations   Design          Code         │  │
│  │ Tiptap 3   Fortune-sheet     Konva           CanvasKit       Monaco       │  │
│  │            + HyperFormula    + .pptx         (WASM, WebGL)                │  │
│  │                                                                           │  │
│  │ Yjs (CRDT)   Variables (@)   Svelte stores   i18n (en, fr, ja)            │  │
│  │                                                                           │  │
│  │ lib/api: window.server, one driver per target                             │  │
│  │          drivers/web.ts · drivers/mobile.ts · drivers/electron.ts         │  │
│  └──────────┬───────────────────────┬───────────────────────┬────────────────┘  │
│             │ fetch (RPC)           │ Capacitor bridge      │ IPC               │
│             ▼                       ▼                       ▼                   │
│      ┌────────────┐          ┌────────────┐         ┌──────────────────────┐    │
│      │ Web        │          │ Mobile     │         │ Desktop (Electron 40)│    │
│      │ Vite build │          │ Capacitor  │         │ preload → main       │    │
│      │ nginx image│          │ iOS/Android│         │ FS policy, ddoc://   │    │
│      └─────┬──────┘          └─────┬──────┘         └──────────┬───────────┘    │
│            │                       │                           │ spawn          │
│            │  dev: tools/stub-bridge (localhost:7070)          │                │
└────────────┼───────────────────────┼───────────────────────────┼────────────────┘
             │ HTTPS + Bearer JWT    │                           ▼
             │ WebSocket (Yjs)       │                ┌─────────────────────┐
             │                       │                │ dynadoc-middleware  │
             ▼                       ▼                │ (Go, not shipped)   │
┌─────────────────────────────────────────────────┐   └──────────┬──────────┘
│ API bridge (separate, proprietary)              │◄─────────────┘ HTTP + JWT
│ Go + Echo + PostgreSQL                          │
│ Auth (Casdoor), licence, billing, drive,        │
│ sync and versions, sharing, sealed-document     │
│ keys, collaboration, AI, grammar, forms, chat   │
└─────────────────────────────────────────────────┘
```

The renderer picks its target at startup (`src/renderer/src/libs/platform.ts`):
`window.electronAPI` means desktop, Capacitor means mobile, anything else is
the web.

## API base and the local stub

`VITE_API_URL` is the only boundary between the client and a backend.

- `npm run stub-bridge` serves the same HTTP contract from a local folder on
  `localhost:7070`, with one local user and no licence. Pair it with
  `npm run dev:web:stub`. See [tools/stub-bridge/README.md](../tools/stub-bridge/README.md)
  for the channels it answers and the ones it refuses by name.
- With no API base configured, the client falls back to production. An API URL
  the client has reached once is remembered in `localStorage` under
  `ddoc.api_url` and wins over `VITE_API_URL` until it is cleared.
- On the web the shell only renders for a signed-in session
  (`src/renderer/src/Main.svelte`). Without one, the client redirects once to
  the sign-in page, then shows a "Sign-in required" card. Reading a public
  share is the one exception. Against the stub, the session call answers with
  the local user, so the shell opens directly.

## Three Electron Processes

### Main Process (`src/main/index.ts`)

The main process has full Node.js access:

- **File system**: reads and writes `.ddoc`, `.xddoc` and `.sddoc` files through
  `src/main/ipc/filesystem.ts`; every path is checked by
  `src/main/utils/FilesystemPathPolicy.ts`, and paths picked in a native dialog
  are granted explicitly
- **Asset protocol**: serves document assets and the app bundle over `ddoc://`
  (`src/main/protocol/`), with a sandboxing CSP for document content
- **Child processes**: spawns the `dynadoc-middleware` binary (not shipped in
  this repository; the features that call it fail on their own)
- **Terminal**: integrated terminal via `node-pty`
- **Workers**: LaTeX compilation (`src/main/workers/latexCompile.worker.ts`)
- **App lifecycle**: windows (including the `/presentation` slideshow window),
  auto-update, deep links (`dynadoc://`)

### Preload (`src/preload/`)

The preload scripts are the security boundary:

- `index.ts` exposes a **minimal API surface** via `contextBridge.exposeInMainWorld()`
- `presentation.ts` serves the slideshow window; `browser.ts`, `webview-var.ts`
  and `embedded-var.ts` serve embedded browser and webview content
- The renderer can only call functions explicitly exposed here
- No direct `require()` or Node.js access leaks to the renderer

### Renderer (`src/renderer/`)

The renderer is a Svelte 5 application in runes mode:

- **No direct system access**: on desktop everything goes through the preload
  bridge, on web and mobile through the API driver
- **About 50 Svelte stores** in `src/renderer/src/stores/`
- **About 50 custom Tiptap extensions** in `src/renderer/src/extensions/tiptap/`
  (see [extensions.md](extensions.md))

## Editor Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Main.svelte (app shell)                                              │
│                                                                      │
│  Tabs: each tab holds one document                                   │
│  ┌──────────┐ ┌──────────────┐ ┌───────────────┐ ┌──────────┐ ┌──────┐│
│  │ Text     │ │ Spreadsheet  │ │ Presentations │ │ Design   │ │ Code ││
│  │ Tiptap 3 │ │ Fortune-sheet│ │ Konva, .pptx  │ │ CanvasKit│ │Monaco││
│  └──────────┘ └──────────────┘ └───────────────┘ └──────────┘ └──────┘│
│                                                                      │
│  Editor mode bar (one per editor): Editing ▾ | @ Variables | AI      │
│                                                                      │
│  Tiptap extensions (a selection)                                     │
│    CustomVarExtension           variables and the @ menu             │
│    CustomSlideExtension         slide decks                          │
│    CustomPresentationExtension  slideshow and presenter view         │
│    CustomSpreadsheetExtension   embedded spreadsheets                │
│    CustomDesignExtension        Design canvas                        │
│    CustomReviewExtension        track changes                        │
│    CustomAIExtension            AI content generation                │
│    CustomFormFieldExtension     interactive forms                    │
│    CustomTranslationExtension   side-by-side translation             │
│    CustomSecuredContentExtension sealed segments                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Editor mode bar

`src/renderer/src/extensions/tiptap/EditorModeBar/` mounts one bar per editor:
the review mode menu (Editing, Suggesting, Viewing), a switch for the AI
"prefer variables" setting (AI inserts `@client` instead of the literal value)
and the AI menu. In documents it floats beside the page and docks above the
page when there is no room; in sheets it sits in a strip above the grid; on
narrow or touch screens it becomes a pill and a bottom sheet.

### Variables

`src/renderer/src/extensions/tiptap/CustomVarExtension/`

- **Scopes**: a variable belongs to the document, or is a Desktop variable
  visible in every file. Desktop variables are stored in
  `<userData>/storage/global-vars.json` (`stores/globalVariables.ts`) and
  broadcast to other tabs and windows on the `dynadoc-vars` BroadcastChannel.
- **One value everywhere**: text chips, spreadsheet cells (`@name` or inside a
  formula such as `=B2*@rate`), slide text boxes and the slideshow read the
  same value; changing it updates every place.
- **The @ menu** (`components/CustomVarExtensionDropdown.svelte`): inline
  autocomplete ranked by name prefix, create and edit in place, scope badge,
  bottom sheet on narrow screens, right-to-left aware. Pure logic lives in
  `utils/variableMenu.utils.ts`.
- **Lookups are in memory**: `stores/variableManipulator.ts` resolves names
  from the in-memory map and never reads `vars.json` on a lookup; the smoke
  test `tests/smoke/variable-lookup-io.test.mjs` guards this.
- **Display**: `utils/variableFormat.utils.ts` keeps text as typed; a string is
  formatted as a date only under a date format and when it is a strict ISO
  date.

### Presentations

`src/renderer/src/extensions/tiptap/CustomSlideExtension/` and
`CustomPresentationExtension/`

```
 .pptx ──► zipLimits.ts ──► pptxImport.ts ──┐
           (rejects unsafe   + pptxMapping   │ creates
            archives)                        ▼
                               ┌──────────────────────────┐
     Variables (@) ──────────► │ Deck: one Y.Doc per slide│
        live value             │ shapes · texts · meta    │
                               │ slideDesign.ts: layouts, │
                               │ themes                   │
                               └────────────┬─────────────┘
              ┌─────────────────┬───────────┴──────┬───────────────────┐
              ▼                 ▼                  ▼                   ▼
          Editor           Slideshow          Presenter view      pptxExport.ts
     SlideDeck, Konva    /presentation       notes, next slide,  variables written
     canvas, TextShape   window              timer               at their current
     with the @ menu     (preload/                               value ──► .pptx
                          presentation.ts)
```

Slides are rendered to HTML by `utils/slideContent.ts` and
`utils/slideRender.ts`, with attribute values escaped and CSS values checked
against allow-lists (`utils/cssValues.ts`). Tests: `tests/smoke/slides.test.mjs`
and `tests/smoke/pptx.test.mjs`.

### Design

`src/renderer/src/extensions/tiptap/CustomDesignExtension/` renders with
CanvasKit (Skia compiled to WebAssembly, on a WebGL surface) in
`components/canvas/SkiaCanva.svelte`. The wasm file is imported with Vite's
`?url` so it always matches the installed `canvaskit-wasm` glue. Without WebGL
the canvas currently stays blank (dynadoc/dynadoc#101).

## State Management

State is managed through Svelte stores in `src/renderer/src/stores/`.

Key stores include:

- `editor.store.ts`: open editors, active document
- `docKind.store.ts`: kind of the active document (text, sheet, deck…)
- `theme.store.ts`: dark, light and custom themes
- `auth.store.ts`: authentication and user session
- `features.store.ts`: feature flags and entitlements
- `variables.store.svelte.ts`: variable state shared with the UI
- `sheetBridge.store.ts`: open spreadsheets and their variables API
- `upgradePlanModal.store.ts`: plan upgrade flow

## Collaboration Architecture

```
User A                     User B
       │                          │
       ▼                          ▼
  Yjs Document              Yjs Document
  (local CRDT)              (local CRDT)
       │                          │
       └─────────┐    ┌──────────┘
                 ▼    ▼
            ┌──────────────┐
            │  Hocuspocus  │
            │  WebSocket   │
            │  (bridge)    │
            └──────────────┘
                   │
              y-indexeddb
           (offline persistence)
```

- **Yjs 13**: CRDT-based conflict-free real-time editing
- **Hocuspocus provider 4**: WebSocket sync with the bridge
- **y-indexeddb**: offline persistence, syncs on reconnect
- **Auth**: collaboration tokens issued by `POST /api/collab/token`
  (`src/renderer/src/services/collab/tokenService.ts`)

## File Format

### `.ddoc` (Standard Document)

A `.ddoc` file is a container format that can hold multiple content types:

- Rich text (Tiptap/ProseMirror JSON)
- Spreadsheet data (Fortune-Sheet format)
- Slide decks (one Yjs document per slide)
- Design canvas (Design extension JSON)
- Embedded images, charts, and media

### `.sddoc` (Sealed Document)

An encrypted variant using:

- AES-256-GCM for content encryption
- RSA-2048 for key wrapping
- Key material held by the API bridge
- Requires a valid Pro/Enterprise license

Sealed documents always carry a watermark and lock after an idle period
(Settings > Privacy).

## Go Middleware

On desktop, the Electron main process spawns a Go binary (`dynadoc-middleware`)
that acts as a local proxy to the backend API. The binary is **not** in this
repository: the app starts without it, and the features that call it fail
individually.

```
Electron Main Process
       │
       │ spawn(dynadoc-middleware)
       │
       ▼
  ┌──────────────────────┐
  │  Go CLI Binary       │
  │                      │
  │  stdin  ← JSON cmd   │
  │  stdout → JSON resp  │
  │                      │
  │  Handles:            │
  │  - Auth token mgmt   │
  │  - API calls         │
  │  - File sync         │
  │  - AI proxy          │
  │  - Encryption ops    │
  └──────────┬───────────┘
             │
        HTTP REST
             │
             ▼
        API bridge
```

Communication is via JSON messages over stdin/stdout. The middleware handles
authentication state, token refresh, and request routing.

## Platform Targets

| Platform | Technology  | Entry Point                                            |
| -------- | ----------- | ------------------------------------------------------ |
| macOS    | Electron 40 | `electron-builder.yml` (DMG)                           |
| Windows  | Electron 40 | `electron-builder.yml` (NSIS)                          |
| Linux    | Electron 40 | `electron-builder.yml` (AppImage, snap, deb)           |
| iOS      | Capacitor 8 | `ios/` + `capacitor.config.ts`                         |
| Android  | Capacitor 8 | `android/` + `capacitor.config.ts`                     |
| Web      | Vite SPA    | `web.vite.config.mts`, served by nginx (`deploy/web/`) |

## Release and Deployment (web)

```
squash merge on main ─► Release Please ─► "Build the web image" ─► ghcr.io/dynadoc/dynadoc-web:<full sha>
  (CI, CodeQL,          (release PR,       (deploy/web/Dockerfile,        │
   npm-audit)            tag vX.Y.Z,         Node 22 + nginx)              │ pinned by full SHA,
                         CHANGELOG)                                        │ never `latest`
                                                                           ▼
                                                      GitOps repository (private): PR that
                                                      changes the image tag ─► ArgoCD ─► k3s
```

- Conventional Commit titles drive the version bump and the CHANGELOG.
- The release PR is opened by a bot, so its CI and Security workflows wait for
  a maintainer to approve them before they run.
- The image tag is the full commit SHA of the release commit; deployment is a
  one-line change of that tag in the GitOps repository, applied by ArgoCD.
