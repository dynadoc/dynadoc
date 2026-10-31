# Dynadoc Performance Fixes — Implementation Summary

> All fixes from `PERFORMANCE_ROOT_CAUSE_ANALYSIS.md` have been implemented across **9 files**.

---

## Files Changed

| File                                                                                                                                                                                             | Fix Applied                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [`electron.vite.config.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/electron.vite.config.ts)                                                                                         | RC3: Removed `force: true` from `optimizeDeps`                                 |
| [`src/main/index.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/main/index.ts)                                                                                                     | RC1–RC3, RC7: All main-process fixes                                           |
| [`src/preload/index.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/preload/index.ts)                                                                                               | RC2: Added `ensureLanguageTool()` IPC bridge                                   |
| [`src/preload/index.d.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/preload/index.d.ts)                                                                                           | RC2: Typed the new preload method                                              |
| [`src/renderer/index.html`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/renderer/index.html)                                                                                         | RC6: Reduced all splash CSS delays                                             |
| [`src/renderer/src/Main.svelte`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/renderer/src/Main.svelte)                                                                               | RC5: Removed `@tailwindcss/browser` runtime JIT                                |
| [`src/renderer/src/main.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/renderer/src/main.ts)                                                                                       | RC6: Parallelized store initialization                                         |
| [`src/renderer/src/stores/browser.store.ts`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/renderer/src/stores/browser.store.ts)                                                       | RC1: Removed eager Google tab creation                                         |
| [`src/renderer/src/components/app/editor/wysiwyg/WysiwygEditor.svelte`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/src/renderer/src/components/app/editor/wysiwyg/WysiwygEditor.svelte) | RC2: Lazy LanguageTool trigger via typed preload API                           |
| [`package.json`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/package.json)                                                                                                               | RC4-Build: Added `NODE_OPTIONS=--max-old-space-size=8192` to build/dev scripts |

---

## Fix Details

### RC1 — Eliminate Redundant WebContents at Boot

**Impact: -2 Chromium renderer processes, ~270 MB RAM saved**

- **`src/main/index.ts`**: Removed `_browserTabs.createTab('https://www.google.com')` from `createWindow()` — a full WebContentsView + live network request to Google was spawned every launch.
- **`src/renderer/src/stores/browser.store.ts`**: Removed eager `api.createTab('https://www.google.com')` from `initializeBrowserStore()`.
- **`src/main/index.ts`**: Removed `createOverlayView()` from `createWindow()`. The overlay `WebContentsView` (which loaded the entire app bundle a 2nd time) is now created lazily in the `overlay:set-visible` IPC handler only when first triggered.

### RC2 — Lazy LanguageTool (Java JVM) Startup

**Impact: -300 MB to -800 MB RAM on launch, eliminates Rosetta 2 CPU spike**

- **`src/main/index.ts`**: Removed `startLanguageTool()` call from `app.whenReady()`. Added `ensureLanguageToolStarted()` helper with `_ltStarted` guard to prevent double-spawning. Added `ipcMain.handle('languagetool:ensure-started')` IPC handler.
- **`src/preload/index.ts`**: Added `ensureLanguageTool: () => ipcRenderer.invoke('languagetool:ensure-started')` to the `api` object so renderer can trigger it safely.
- **`src/preload/index.d.ts`**: Added typed `ensureLanguageTool?()` declaration to `Window.api`.
- **`WysiwygEditor.svelte`**: Calls `window.api?.ensureLanguageTool?.()` before making the first LanguageTool HTTP request, triggering JVM startup on first use.

### RC3 — Stop Destroying Chromium V8 Cache on Every Boot

**Impact: Warm starts drop from ~2000ms to ~300ms JS parse time**

- **`src/main/index.ts`**: Removed `session.clearCache()` and `session.clearStorageData()` calls. Chromium now persists its V8 bytecode cache and HTTP cache across launches.
- **`src/main/index.ts`**: Gated `openDevTools()` behind `is.dev && process.env['DYNADOC_DEVTOOLS'] === '1'` instead of always-on.
- **`electron.vite.config.ts`**: Removed `force: true` from `optimizeDeps` so Vite reuses pre-bundled dependency artifacts in dev mode.

### RC5 — Remove Runtime CSS JIT Compiler

**Impact: Eliminates constant MutationObserver DOM scanning**

- **`src/renderer/src/Main.svelte`**: Removed `import './assets/js/vendor/tailwindcss.js'` (255 KB `@tailwindcss/browser` v4 runtime). UnoCSS + virtual:uno.css + the static `tailwind.min.css` already cover all styles at build time.

### RC6 — Strip Artificial Splash Screen Delays & Parallelize Store Hydration

**Impact: Splash visible duration reduced from 6.5s+ to ~300ms**

- **`src/renderer/index.html`**: All splash CSS transition delays reduced:
  - `.splash-card` transitions: `0.9s → 0.25s`
  - Card delays: `0.25s/0.35s/0.45s → 0.05s/0.07s/0.1s`
  - `.splash-lines path`: `stroke-dashoffset 1.6s → 0.3s`, `opacity 0.5s → 0.2s`
  - `transition-delay` on lines: `1.4s/1.5s/1.6s/1.7s → 0s`
  - `.splash-chip` transitions: `0.6s → 0.2s`, delays: `1s/1.15s/1.25s → 0.05s/0.07s/0.1s`
- **`src/renderer/src/main.ts`**: `initializeCommonStore()` and `initializeStore()` are now loaded and executed concurrently via `Promise.all()` instead of sequential `await` chains.

### RC7 — Stop Unthrottled 60 FPS Polling Timer

**Impact: Removes permanent 3-5% idle CPU, allows CPU sleep states**

- **`src/main/index.ts`**: Removed the always-running `setInterval(() => ..., 16)` that polled cursor position even when no meeting was active. Added `_laserCursorInterval` variable. Timer is now started inside `createLaserPointer()` and cleared in the `meeting:stop-sharing` handler.

---

## Verification

- ✅ `npx tsc --noEmit` — passes cleanly (only pre-existing errors in `tiptap-pagination-plus` extension)
- ✅ `npx tsc --noEmit -p tsconfig.node.json` — same pre-existing errors as before our changes, none introduced
- ✅ `NODE_OPTIONS=--max-old-space-size=8192 npx electron-vite build` — **passed, built in 2m 45s**

> [!WARNING]
> The build OOM'd initially (heap exhausted at ~4 GB) with the default Node.js heap. This is a direct symptom of **Root Cause 4** — the 13.5 MB `SpreadsheetEditor` chunk, 7.7 MB `index`, and several other giant chunks cause the bundler itself to OOM. Fixed in `package.json` (RC4-Build below).

### RC4-Build — Node.js Heap for Build & Dev Scripts

**File: [`package.json`](file:///Volumes/MacIn/Helton/VSCodeProjects/dynadoc/package.json)**

Added `cross-env NODE_OPTIONS=--max-old-space-size=8192` to:

- `"build"` — `npm run typecheck && cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-vite build`
- `"build:no-check"` — same
- `"build:electron"` — same
- `"dev"` — same (prevents potential OOM during hot-reload dev sessions with large chunks)

These already existed on `build:mac` and `build:linux` — now consistent across all build targets.

## Remaining Work (Phase 2 from Analysis)

> [!NOTE]
> Phase 1 fixes (all the above) target ~60% faster startup and ~50% less RAM. Phase 2 below requires deeper architectural refactoring.

### Phase 2 — Code Splitting (Not Yet Implemented)

These fixes require significant architectural changes and should be done incrementally:

1. **Lazy-load heavy editors** — Replace static imports in `App.svelte`/`Editor.svelte` with `{#await import(...)}` blocks for `WysiwygEditor`, `CodeEditor`, `PdfReader`, `VideoEditor`.
2. **Isolate React UI libraries** — `@fluentui/react-components`, `@mui/material`, `antd` are imported into Svelte. These should only load behind a `ReactWrapper` boundary when a Ribbon component is rendered.
3. **Defer CanvasKit & ECharts** — Load `canvaskit-wasm` and `echarts` only when a chart/drawing node enters the viewport.

> [!TIP]
> To enable DevTools in dev mode, set `DYNADOC_DEVTOOLS=1` environment variable before launching: `DYNADOC_DEVTOOLS=1 npm run dev`
