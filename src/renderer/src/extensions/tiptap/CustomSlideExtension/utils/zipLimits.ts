import { Unzip, UnzipInflate } from 'fflate'

// Limits for an untrusted zip (a .pptx) before it is handed to a parser that
// inflates everything into memory. Pure (fflate only): tests/smoke runs it.

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
  limits: ZipLimits = PPTX_ZIP_LIMITS
): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // End of central directory: 22 bytes plus a comment of up to 65535.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return 'The file is not a valid PowerPoint (.pptx) file.'
  const entries = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  // 0xFFFF / 0xFFFFFFFF mean ZIP64, which no presentation within the limits needs.
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    return 'The presentation is too large to import.'
  if (entries > limits.maxEntries)
    return `The presentation has too many parts to import (${entries}, at most ${limits.maxEntries}).`
  if (cdOffset + cdSize > bytes.length) return 'The file is not a valid PowerPoint (.pptx) file.'

  let declared = 0
  let at = cdOffset
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return 'The file is not a valid PowerPoint (.pptx) file.'
    const size = view.getUint32(at + 24, true)
    if (size === 0xffffffff) return 'The presentation is too large to import.'
    if (size > limits.maxEntryBytes)
      return `A part of the presentation is too large to import (${mb(size)}, at most ${mb(limits.maxEntryBytes)}).`
    declared += size
    if (declared > limits.maxTotalBytes)
      return `The presentation is too large to import (more than ${mb(limits.maxTotalBytes)} unpacked).`
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
  }

  let total = 0
  let count = 0
  let problem: string | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file): void => {
    if (problem) return
    if (++count > limits.maxEntries) {
      problem = `The presentation has too many parts to import (at most ${limits.maxEntries}).`
      return
    }
    let size = 0
    file.ondata = (err, chunk): void => {
      if (problem) return
      if (err) {
        problem = 'The file is not a valid PowerPoint (.pptx) file.'
        return
      }
      size += chunk.length
      total += chunk.length
      if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) {
        problem = `The presentation is too large to import (more than ${mb(limits.maxTotalBytes)} unpacked).`
        file.terminate()
      }
    }
    file.start()
  }
  try {
    unzip.push(bytes, true)
  } catch {
    return problem ?? 'The file is not a valid PowerPoint (.pptx) file.'
  }
  return problem
}
