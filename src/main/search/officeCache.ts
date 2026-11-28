/**
 * Office text for the multi-file search, read once per version of a file.
 *
 * Unzipping and parsing a package is the expensive part of searching it, and
 * the Search sidebar searches again 220 ms after each keystroke. The text of
 * each package is kept in memory, keyed by path, modification time and size
 * (a saved file gets a new key), so a new query over unchanged files only
 * runs the matcher. Bounded: at most 200 packages or 50 million characters,
 * the least recently used going first. Failures are kept too, so a broken
 * package is not unzipped again on every keystroke.
 *
 * Extraction itself is injected: the main process runs it in a worker thread
 * (officeWorker.ts), the stub bridge and the tests in process.
 */

import fsp from 'fs/promises'
import {
  extractOfficeText,
  officeKindOf,
  type OfficeExtraction,
  type OfficeKind
} from './officeText'

export type OfficeExtractor = (bytes: Uint8Array, kind: OfficeKind) => Promise<OfficeExtraction>

/** In process, after yielding once so other work in the event loop can run first. */
export const extractInProcess: OfficeExtractor = (bytes, kind) =>
  new Promise((resolve) => setImmediate(() => resolve(extractOfficeText(bytes, kind))))

export const OFFICE_CACHE_MAX_FILES = 200
export const OFFICE_CACHE_MAX_CHARS = 50_000_000

type Entry = { key: string; extraction: OfficeExtraction; chars: number }

const cache = new Map<string, Entry>()
let cachedChars = 0

function sizeOf(extraction: OfficeExtraction): number {
  if (!extraction.ok) return extraction.reason.length
  let chars = 0
  for (const segment of extraction.segments) chars += segment.text.length + segment.label.length
  return chars
}

function remember(filePath: string, entry: Entry): void {
  forget(filePath)
  cache.set(filePath, entry)
  cachedChars += entry.chars
  for (const [oldest, old] of cache) {
    if (cache.size <= OFFICE_CACHE_MAX_FILES && cachedChars <= OFFICE_CACHE_MAX_CHARS) break
    if (oldest === filePath) continue
    cache.delete(oldest)
    cachedChars -= old.chars
  }
}

function forget(filePath: string): void {
  const entry = cache.get(filePath)
  if (!entry) return
  cache.delete(filePath)
  cachedChars -= entry.chars
}

export function clearOfficeCache(): void {
  cache.clear()
  cachedChars = 0
}

export function officeCacheStats(): { files: number; chars: number } {
  return { files: cache.size, chars: cachedChars }
}

/**
 * The text of a package, from the cache when the file has not changed.
 * `maxBytes` bounds the package itself; `null` when the file cannot be read.
 */
export async function officeTextFor(
  filePath: string,
  extract: OfficeExtractor,
  maxBytes: number
): Promise<OfficeExtraction | null> {
  const kind = officeKindOf(filePath)
  if (!kind) return null
  let stats: { mtimeMs: number; size: number }
  try {
    stats = await fsp.stat(filePath)
  } catch {
    return null
  }
  const key = `${stats.mtimeMs}:${stats.size}`
  const hit = cache.get(filePath)
  if (hit && hit.key === key) {
    // Most recently used goes to the end.
    cache.delete(filePath)
    cache.set(filePath, hit)
    return hit.extraction
  }
  if (stats.size > maxBytes) {
    const extraction: OfficeExtraction = {
      ok: false,
      reason: `larger than ${Math.round(maxBytes / (1024 * 1024))} MB`
    }
    remember(filePath, { key, extraction, chars: sizeOf(extraction) })
    return extraction
  }
  let bytes: Buffer
  try {
    bytes = await fsp.readFile(filePath)
  } catch {
    return null
  }
  const extraction = await extract(bytes, kind)
  if (!(!extraction.ok && extraction.transient)) {
    remember(filePath, { key, extraction, chars: sizeOf(extraction) })
  }
  return extraction
}
