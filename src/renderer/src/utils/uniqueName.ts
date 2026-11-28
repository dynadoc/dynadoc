/**
 * The name-picking half of generateUniqueNameAsync (documentFileUtils.ts),
 * without the filesystem, so it can be tested on its own
 * (tests/smoke/asset-root.test.mjs).
 */

/**
 * The name of a directory entry. Node's readdir answers strings; on the web
 * `fs:readdir` answers the bridge's drive entries (`{ path, name, ... }`), and
 * reading those as strings made every one "[object Object]", so a unique name
 * never moved past the base name there (#149).
 */
export function directoryEntryName(entry: unknown): string {
  if (typeof entry === 'string') return entry
  const name = (entry as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : String(entry ?? '')
}

/** The first free `<base>[<separator>N]<extension>` among `existing`. */
export function pickUniqueName(
  existing: unknown[],
  safeBase: string,
  extension: string,
  separator: string,
  copyStyle: string | null
): string {
  const escaped = safeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const numberRegex = copyStyle
    ? new RegExp(`^${copyStyle} ${escaped}(?:${separator}(\\d+))?${extension}$`)
    : new RegExp(`^${escaped}(?:${separator}(\\d+))?${extension}$`)

  let maxIndex = 0
  for (const entry of existing) {
    const match = directoryEntryName(entry).match(numberRegex)
    if (!match) continue
    const num = match[1] ? parseInt(match[1], 10) : 1
    if (num > maxIndex) maxIndex = num
  }

  if (maxIndex === 0) {
    return copyStyle ? `${copyStyle} ${safeBase}${extension}` : `${safeBase}${extension}`
  }

  return copyStyle
    ? `${copyStyle} ${safeBase}${separator}${maxIndex + 1}${extension}`
    : `${safeBase}${separator}${maxIndex + 1}${extension}`
}
