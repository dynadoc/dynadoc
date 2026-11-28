/**
 * Where a document keeps its assets (design, slide, sheet files), and how to
 * recognise the asset paths that were resolved against the drive root by
 * mistake on the web (#149).
 *
 * Pure: no filesystem, no platform detection. The caller answers the two
 * questions that need them (is the path a directory, what is the root of a
 * desktop path outside the cache) so this module stays testable on its own
 * (tests/smoke/asset-root.test.mjs).
 */

const toPosix = (value: string): string => String(value ?? '').replace(/\\/g, '/')

const dirnamePosix = (value: string): string => {
  const trimmed = toPosix(value).replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return trimmed.slice(0, index)
}

export type AssetRootInput = {
  /** The document's main file (index.html) or its folder. */
  documentPath: string
  /** The app cache directory (`getCacheDir`). */
  cacheDir: string
  /** Desktop app: documents live in the cache directory. */
  isDesktop: boolean
  /** Whether `documentPath` is a directory, when known. */
  isDirectory?: boolean
  /** Desktop only: root of a path outside the cache (getFileRootFromBaseDir). */
  rootOutsideCache: (cacheDir: string, documentPath: string) => string
  /** The platform's dirname (Windows paths on the desktop); posix by default. */
  dirname?: (value: string) => string
}

/**
 * The folder whose `assets/` belongs to the document.
 *
 * On the desktop a document is unpacked in the cache directory and its root
 * is the folder of its main file. On the web, documents live in the drive
 * (`drive/home/...`) and the cache directory is unrelated (`cache`): the
 * desktop fallback, a path relative to the cache, climbed out of it and
 * returned the drive root, so every document of a kind shared
 * `assets/<type>/<type>.json` there. On the web the document's own folder is
 * the root, always.
 */
export function documentAssetRoot(input: AssetRootInput): string {
  const { documentPath, cacheDir, isDesktop, isDirectory, rootOutsideCache } = input
  const dirname = input.dirname ?? dirnamePosix
  const inCache = documentPath.startsWith(cacheDir)
  if (!isDesktop || inCache) {
    return isDirectory ? documentPath : dirname(documentPath)
  }
  return rootOutsideCache(cacheDir, documentPath)
}

/**
 * True for an asset path that points at the shared, drive-root store a web
 * document got before #149: `assets/<type>/<file>`, with nothing before
 * `assets` (optionally `./` or `/`).
 */
export function isDriveRootAssetPath(src: string | null | undefined, assetType: string): boolean {
  if (!src) return false
  const normalized = toPosix(src).replace(/^\.?\/+/, '')
  const parts = normalized.split('/')
  return parts.length === 3 && parts[0] === 'assets' && parts[1] === assetType && Boolean(parts[2])
}

export type StoreFs = {
  exists: (filePath: string) => Promise<boolean>
  readFile: (filePath: string) => Promise<string>
  writeFile: (filePath: string, data: string) => Promise<void>
}

/**
 * Gives a canvas whose store is a shared drive-root file its own copy at
 * `target` (in its document folder) and returns the path to use from now on.
 * The shared file is never changed or removed, so whichever design opens
 * first, the others still find their shapes. Returns null, and the caller
 * keeps `src`, when there is nothing to move or the copy failed.
 *
 * `target` must be this canvas's own name (the caller derives it from the
 * canvas id). A target that exists already is this canvas's earlier copy,
 * kept as it is: when the rewritten `src` was not saved, the next open must
 * not copy the shared file over the edits made since.
 */
export async function copyDriveRootStore(
  src: string | null | undefined,
  target: string | null | undefined,
  assetType: string,
  fs: StoreFs
): Promise<string | null> {
  if (!src || !isDriveRootAssetPath(src, assetType)) return null
  if (!target || target === src || isDriveRootAssetPath(target, assetType)) return null
  try {
    if (await fs.exists(target)) return target
    // A store never written (nothing was drawn) has nothing to copy: the
    // canvas starts its own file at the new path.
    if (await fs.exists(src)) await fs.writeFile(target, await fs.readFile(src))
  } catch (err) {
    console.warn('Could not copy the shared store, keeping it', err)
    return null
  }
  return target
}
