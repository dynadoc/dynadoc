import { Unzip, UnzipInflate } from 'fflate'

// Limits for an untrusted zip (a .pptx, or a .docx or .xlsx read by the search)
// before it is handed to a parser that inflates everything into memory. Pure
// (fflate only): tests/smoke runs it, and the main process imports it.

export type ZipLimits = {
  /** Total uncompressed bytes. */
  maxTotalBytes: number
  /** Uncompressed bytes of one entry. */
  maxEntryBytes: number
  /** Number of entries. */
  maxEntries: number
}

export const PPTX_ZIP_LIMITS: ZipLimits = {
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxEntries: 2000
}

const MB = 1024 * 1024
const mb = (bytes: number): string => `${Math.round(bytes / MB)} MB`

/** Names used in the messages, so they read right for each kind of file. */
export type ZipNames = {
  /** The file, as in "The file is not a valid {file}." */
  file: string
  /** What it holds, as in "The {thing} is too large to import." */
  thing: string
}

export const PPTX_ZIP_NAMES: ZipNames = { file: 'PowerPoint (.pptx) file', thing: 'presentation' }

/**
 * Why `bytes` must not be unpacked, or null when it is within `limits`.
 *
 * Two passes. The central directory gives the entry count and the declared
 * sizes, which rejects most oversized files without inflating anything. A
 * declared size can lie, so the entries are then inflated as a stream and
 * counted, stopping at the first limit crossed; nothing inflated is kept.
 */
export function checkZipLimits(
  bytes: Uint8Array,
  limits: ZipLimits = PPTX_ZIP_LIMITS,
  names: ZipNames = PPTX_ZIP_NAMES
): string | null {
  return scanZip(bytes, limits, names, null).problem
}

/**
 * Inflates the entries `keep` selects, once, within `limits`, and returns
 * them; the other entries are neither inflated nor counted. Same checks as
 * checkZipLimits: declared sizes first, then the inflated bytes as they come.
 */
export function inflateWithinLimits(
  bytes: Uint8Array,
  limits: ZipLimits,
  names: ZipNames,
  keep: (name: string) => boolean
): { problem: string; files?: undefined } | { problem: null; files: Record<string, Uint8Array> } {
  const result = scanZip(bytes, limits, names, keep)
  return result.problem === null
    ? { problem: null, files: result.files }
    : { problem: result.problem }
}

const nameDecoder = new TextDecoder()

function scanZip(
  bytes: Uint8Array,
  limits: ZipLimits,
  names: ZipNames,
  keep: ((name: string) => boolean) | null
): { problem: string | null; files: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = {}
  const fail = (problem: string): { problem: string; files: Record<string, Uint8Array> } => ({
    problem,
    files
  })
  const invalid = `The file is not a valid ${names.file}.`
  const tooLarge = `The ${names.thing} is too large to import.`
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return fail(invalid)
  const entries = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  // 0xFFFF / 0xFFFFFFFF mean ZIP64, which no presentation within the limits needs.
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail(tooLarge)
  if (entries > limits.maxEntries)
    return fail(
      `The ${names.thing} has too many parts to import (${entries}, at most ${limits.maxEntries}).`
    )
  if (cdOffset + cdSize > bytes.length) return fail(invalid)

  let declared = 0
  let at = cdOffset
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return fail(invalid)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const counted = !keep || keep(nameDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)))
    if (counted) {
      if (size === 0xffffffff) return fail(tooLarge)
      if (size > limits.maxEntryBytes)
        return fail(
          `A part of the ${names.thing} is too large to import (${mb(size)}, at most ${mb(limits.maxEntryBytes)}).`
        )
      declared += size
      if (declared > limits.maxTotalBytes)
        return fail(
          `The ${names.thing} is too large to import (more than ${mb(limits.maxTotalBytes)} unpacked).`
        )
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }

  let total = 0
  let count = 0
  let problem: string | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file): void => {
    if (problem) return
    if (++count > limits.maxEntries) {
      problem = `The ${names.thing} has too many parts to import (at most ${limits.maxEntries}).`
      return
    }
    if (keep && !keep(file.name)) return
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (err, chunk, final): void => {
      if (problem) return
      if (err) {
        problem = invalid
        return
      }
      size += chunk.length
      total += chunk.length
      if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) {
        problem = `The ${names.thing} is too large to import (more than ${mb(limits.maxTotalBytes)} unpacked).`
        file.terminate()
        return
      }
      if (keep) {
        chunks.push(chunk)
        if (final) files[file.name] = concat(chunks, size)
      }
    }
    file.start()
  }
  try {
    unzip.push(bytes, true)
  } catch {
    return fail(problem ?? invalid)
  }
  return problem ? fail(problem) : { problem: null, files }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
