/**
 * Search and replace across the files of a folder.
 *
 * Used by the desktop main process (`search:*` IPC handlers in src/main/index.ts)
 * and by the local stub bridge, so the web build exercised against the stub
 * runs the same code. Node only (fs, path, crypto), no Electron import.
 *
 * Replace is two steps, and both read documents through the text model of
 * htmlText.ts, so the preview lists exactly what the apply writes (#137):
 *
 * 1. `previewReplaceInFiles` lists every change, file by file, with the text
 *    before and after, and a hash of each file as it was read.
 * 2. `applyReplaceInFiles` takes that list back. A file whose hash no longer
 *    matches (edited since the preview) is skipped, not replaced. Before a file
 *    is written, a copy of it goes into a backup folder; a manifest of the run
 *    is written next to the copies and one line per run is appended to a log.
 *    `restoreReplaceBackup` puts the copies back, for every file that has not
 *    been changed again since.
 */

import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { findInTextModel, planReplace, replacementFor, textModelFor } from './htmlText'
import { createSearchRegExp } from './matcher'

export type SearchFsPayload = {
  rootPath: string
  query: string
  isRegex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  includePattern?: string
  excludePattern?: string
  maxResults?: number
  maxMatchesPerFile?: number
  restrictToPaths?: string[]
}

export type ReplacePayload = SearchFsPayload & { replaceText: string }

export type ApplyReplacePayload = ReplacePayload & {
  /** From the preview: the apply must use the same query, options and scope. */
  previewToken: string
  /**
   * The files of the preview, with the hash each had when it was previewed and
   * the indexes (in the preview's `changes`) the user unticked.
   */
  files: Array<{ path: string; hash: string; exclude?: number[] }>
}

export type SearchFsMatch = {
  line: number
  column: number
  length: number
  preview: string
  before: string
  match: string
  after: string
}

export type SearchFsFileResult = {
  file: string
  path: string
  relativePath: string
  matches: number
  items: SearchFsMatch[]
}

export type ReplacePreviewChange = SearchFsMatch & {
  replacement: string
  /** Set when this match is shown but will not be replaced, with the reason. */
  skipped?: 'protected' | 'object'
}

export type ReplacePreviewFile = {
  file: string
  path: string
  relativePath: string
  hash: string
  replacements: number
  changes: ReplacePreviewChange[]
}

export type ReplaceBackupManifest = {
  id: string
  createdAt: string
  rootPath: string
  query: string
  replaceText: string
  options: { isRegex: boolean; caseSensitive: boolean; wholeWord: boolean }
  files: Array<{
    path: string
    backup: string
    hashBefore: string
    hashAfter: string
    replacements: number
    changes: Array<{ line: number; before: string; after: string }>
  }>
  restoredAt?: string
}

/** Files larger than this are not read: they would block the main process. */
export const SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024

export const SEARCH_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.xml',
  '.csv',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.vue',
  '.go',
  '.rs',
  '.py',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sql',
  '.graphql',
  '.gql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.xddoc',
  '.sddoc'
])

/**
 * The only files a replace writes: documents and plain text. Never data or
 * code (`vars.json`, translations, `.css`, `.js`), whatever the patterns say.
 */
export const REPLACE_EXTENSIONS = new Set(['.html', '.htm', '.sddoc', '.md', '.markdown', '.txt'])

export function isReplaceableFile(filePath: string): boolean {
  return REPLACE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function normalizeSearchPath(inputPath: string): string {
  return String(inputPath || '')
    .trim()
    .replace(/\\/g, '/')
}

function escapeGlobChar(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseCsvPatterns(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizeSearchPath(glob)
  let out = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === '*') {
      if (next === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      out += '.'
      continue
    }

    out += escapeGlobChar(char)
  }
  out += '$'
  return new RegExp(out, 'i')
}

export function compilePatternList(value: string): RegExp[] {
  return parseCsvPatterns(value).map(globToRegex)
}

export function matchesAnyPatternForFile(
  filePath: string,
  rootPath: string,
  patterns: RegExp[]
): boolean {
  if (!patterns.length) return false
  const normalizedFull = normalizeSearchPath(filePath)
  const normalizedRelative = normalizeSearchPath(path.relative(rootPath, filePath))
  const baseName = path.basename(filePath)
  return patterns.some(
    (pattern) =>
      pattern.test(normalizedFull) || pattern.test(normalizedRelative) || pattern.test(baseName)
  )
}

export function isLikelyTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (SEARCH_TEXT_EXTENSIONS.has(ext)) return true
  return !ext
}

export function hasBinaryContent(buffer: Buffer): boolean {
  const threshold = Math.min(buffer.length, 2048)
  for (let index = 0; index < threshold; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

function isInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Inside the root (or the root itself), after resolving symbolic links on both sides. */
function isReallyInsideRoot(filePath: string, rootPath: string): boolean {
  try {
    const real = fs.realpathSync(filePath)
    const realRoot = fs.realpathSync(rootPath)
    return real === realRoot || isInsideRoot(real, realRoot)
  } catch {
    return false
  }
}

export async function collectSearchFiles(
  rootPath: string,
  includeMatchers: RegExp[],
  excludeMatchers: RegExp[],
  restrictToPaths: string[] = [],
  maxFiles: number = 6000
): Promise<string[]> {
  if (restrictToPaths.length > 0) {
    return (
      restrictToPaths
        .filter((item) => item && fs.existsSync(item))
        // A restricted list names files of this search, never files elsewhere.
        .filter((item) => isReallyInsideRoot(item, rootPath))
        .filter(
          (item) =>
            !excludeMatchers.length || !matchesAnyPatternForFile(item, rootPath, excludeMatchers)
        )
        .filter(
          (item) =>
            !includeMatchers.length || matchesAnyPatternForFile(item, rootPath, includeMatchers)
        )
    )
  }

  const output: string[] = []
  const stack: string[] = [rootPath]

  while (stack.length > 0 && output.length < maxFiles) {
    const currentDir = stack.pop() as string
    let entries: fs.Dirent[] = []
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true })
    } catch {
      entries = []
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (excludeMatchers.length && matchesAnyPatternForFile(fullPath, rootPath, excludeMatchers))
        continue

      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (!entry.isFile()) continue
      if (includeMatchers.length && !matchesAnyPatternForFile(fullPath, rootPath, includeMatchers))
        continue

      output.push(fullPath)
    }
  }

  return output
}

export function hashContent(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** Reads a file the search can work on, or null (unreadable, too large, binary). */
async function readSearchableFile(filePath: string): Promise<Buffer | null> {
  if (!isLikelyTextFile(filePath)) return null
  let buffer: Buffer
  try {
    buffer = await fsp.readFile(filePath)
  } catch (err) {
    console.warn('[search] skipping file:', filePath, err)
    return null
  }
  if (buffer.byteLength > SEARCH_MAX_FILE_BYTES) return null
  if (hasBinaryContent(buffer)) return null
  return buffer
}

function toSearchMatch(match: {
  line: number
  column: number
  before: string
  match: string
  after: string
}): SearchFsMatch {
  const lineText = `${match.before}${match.match}${match.after}`
  return {
    line: match.line,
    column: match.column,
    length: Math.max(1, match.match.length),
    preview: lineText.trim(),
    before: match.before,
    match: match.match,
    after: match.after
  }
}

/**
 * Binds an apply to its preview: the indexes of unticked changes only mean
 * something for the same query, options, replacement and scope.
 */
export function previewTokenFor(payload: ReplacePayload): string {
  return hashContent(
    JSON.stringify([
      String(payload.rootPath || '').trim(),
      String(payload.query || ''),
      String(payload.replaceText ?? ''),
      !!payload.isRegex,
      !!payload.caseSensitive,
      !!payload.wholeWord,
      String(payload.includePattern || ''),
      String(payload.excludePattern || '')
    ])
  )
}

type MatcherResult = { matcher: RegExp } | { error: string }

function buildMatcher(payload: SearchFsPayload): MatcherResult {
  try {
    return { matcher: createSearchRegExp(String(payload.query || ''), payload) }
  } catch {
    return { error: 'Invalid regular expression' }
  }
}

async function filesForPayload(payload: SearchFsPayload, rootPath: string): Promise<string[]> {
  const includeMatchers = compilePatternList(payload.includePattern || '')
  const excludeMatchers = compilePatternList(payload.excludePattern || '')
  const restrictToPaths = Array.isArray(payload.restrictToPaths) ? payload.restrictToPaths : []
  return collectSearchFiles(rootPath, includeMatchers, excludeMatchers, restrictToPaths)
}

export async function searchInFiles(payload: SearchFsPayload): Promise<{
  ok: boolean
  files: SearchFsFileResult[]
  totalMatches: number
  scannedFiles: number
  truncated: boolean
  error?: string
}> {
  const rootPath = String(payload?.rootPath || '').trim()
  const query = String(payload?.query || '')
  const empty = { files: [], totalMatches: 0, scannedFiles: 0, truncated: false }
  if (!rootPath || !query) return { ok: true, ...empty }
  if (!fs.existsSync(rootPath)) return { ok: false, ...empty, error: 'Search root does not exist' }

  const built = buildMatcher(payload)
  if ('error' in built) return { ok: false, ...empty, error: built.error }

  const maxResults = Math.max(1, Number(payload.maxResults || 2000))
  const maxMatchesPerFile = Math.max(1, Number(payload.maxMatchesPerFile || 200))
  const files = await filesForPayload(payload, rootPath)
  const grouped: SearchFsFileResult[] = []
  let totalMatches = 0
  let truncated = false

  for (const filePath of files) {
    const buffer = await readSearchableFile(filePath)
    if (!buffer) continue

    const model = textModelFor(filePath, buffer.toString('utf-8'))
    const limit = Math.min(maxMatchesPerFile, maxResults - totalMatches)
    const found = findInTextModel(model, built.matcher, { limit })
    const items = found.matches.map(toSearchMatch)
    totalMatches += items.length
    if (found.truncated || totalMatches >= maxResults) truncated = true

    if (items.length > 0) {
      grouped.push({
        file: path.basename(filePath),
        path: filePath,
        relativePath: path.relative(rootPath, filePath),
        matches: items.length,
        items
      })
    }

    if (totalMatches >= maxResults) break
  }

  return { ok: true, files: grouped, totalMatches, scannedFiles: files.length, truncated }
}

/** Lists every change a replace would make, without writing anything. */
export async function previewReplaceInFiles(payload: ReplacePayload): Promise<{
  ok: boolean
  previewToken?: string
  files: ReplacePreviewFile[]
  replacements: number
  skipped: number
  changedFiles: number
  error?: string
}> {
  const rootPath = String(payload?.rootPath || '').trim()
  const query = String(payload?.query || '')
  const replaceText = String(payload?.replaceText ?? '')
  const empty = { files: [], replacements: 0, skipped: 0, changedFiles: 0 }
  if (!rootPath || !query) return { ok: true, ...empty }
  if (!fs.existsSync(rootPath)) return { ok: false, ...empty, error: 'Search root does not exist' }

  const built = buildMatcher(payload)
  if ('error' in built) return { ok: false, ...empty, error: built.error }

  const files = (await filesForPayload(payload, rootPath)).filter(isReplaceableFile)
  const preview: ReplacePreviewFile[] = []
  let replacements = 0
  let skipped = 0

  for (const filePath of files) {
    const buffer = await readSearchableFile(filePath)
    if (!buffer) continue
    const plan = planReplace(filePath, buffer.toString('utf-8'), built.matcher, replaceText, {
      expand: !!payload.isRegex
    })
    if (plan.matches.length === 0) continue
    const changes: ReplacePreviewChange[] = plan.matches.map((match) => ({
      ...toSearchMatch(match),
      replacement: match.blocked
        ? match.match
        : replacementFor(match, replaceText, { expand: !!payload.isRegex }),
      ...(match.blocked ? { skipped: match.blocked } : {})
    }))
    replacements += plan.replaced
    skipped += plan.matches.length - plan.replaced
    preview.push({
      file: path.basename(filePath),
      path: filePath,
      relativePath: path.relative(rootPath, filePath),
      hash: hashContent(buffer),
      replacements: plan.replaced,
      changes
    })
  }

  return {
    ok: true,
    previewToken: previewTokenFor(payload),
    files: preview,
    replacements,
    skipped,
    changedFiles: preview.filter((file) => file.replacements > 0).length
  }
}

/** Each changed line, as it read before and after, for the manifest and the log. */
function changedLines(
  filePath: string,
  matches: Array<{ line: number; before: string; match: string; after: string }>,
  applied: boolean[],
  output: string
): Array<{ line: number; before: string; after: string }> {
  const afterLines = textModelFor(filePath, output).text.split('\n')
  const seen = new Set<number>()
  const lines: Array<{ line: number; before: string; after: string }> = []
  for (const [index, match] of matches.entries()) {
    if (!applied[index] || seen.has(match.line)) continue
    seen.add(match.line)
    lines.push({
      line: match.line,
      before: `${match.before}${match.match}${match.after}`.trim(),
      after: (afterLines[match.line - 1] ?? '').trim()
    })
  }
  return lines
}

/** Writes next to the file, then renames: a failed write leaves the file as it was. */
async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  const mode = await fsp
    .stat(filePath)
    .then((stats) => stats.mode & 0o7777)
    .catch(() => undefined)
  try {
    await fsp.writeFile(temp, content, mode === undefined ? undefined : { mode })
    if (mode !== undefined) await fsp.chmod(temp, mode)
    await fsp.rename(temp, filePath)
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

function newBackupId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`
}

const BACKUP_ID_PATTERN = /^[0-9TZ-]+-[0-9a-f]{6}$/

export const REPLACE_LOG_FILE = 'replace-log.jsonl'

/**
 * One line per replace or restore: when, where, how many, which files. The
 * changed text itself stays in the run's manifest, next to its backup copies,
 * and goes away with them.
 */
async function appendLog(backupRoot: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fsp.mkdir(backupRoot, { recursive: true })
    await fsp.appendFile(path.join(backupRoot, REPLACE_LOG_FILE), `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.warn('[search] could not append to the replace log:', err)
  }
}

/** How many replace backups are kept; older ones are removed on the next apply. */
export const REPLACE_BACKUPS_KEPT = 20

async function pruneBackups(backupRoot: string, keep: string): Promise<void> {
  try {
    const entries = (await fsp.readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && BACKUP_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const name of entries.slice(REPLACE_BACKUPS_KEPT)) {
      if (name === keep) continue
      await fsp.rm(path.join(backupRoot, name), { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('[search] could not prune replace backups:', err)
  }
}

async function writeManifest(backupDir: string, manifest: ReplaceBackupManifest): Promise<void> {
  await fsp.mkdir(backupDir, { recursive: true })
  await writeFileAtomic(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/**
 * Applies a previewed replace. `backupRoot` is where the copies, the manifest
 * and the log go; it is chosen by the caller (the app's cache folder on
 * desktop), never by the renderer.
 */
export async function applyReplaceInFiles(
  payload: ApplyReplacePayload,
  backupRoot: string
): Promise<{
  ok: boolean
  changedFiles: number
  replacements: number
  files: string[]
  skippedFiles: Array<{ path: string; reason: string }>
  backupId?: string
  backupDir?: string
  logPath?: string
  error?: string
}> {
  const rootPath = String(payload?.rootPath || '').trim()
  const query = String(payload?.query || '')
  const replaceText = String(payload?.replaceText ?? '')
  const expected = Array.isArray(payload?.files) ? payload.files : []
  const empty = { changedFiles: 0, replacements: 0, files: [], skippedFiles: [] }
  if (!rootPath || !query || expected.length === 0) return { ok: true, ...empty }
  if (!fs.existsSync(rootPath)) return { ok: false, ...empty, error: 'Search root does not exist' }
  if (!backupRoot) return { ok: false, ...empty, error: 'No backup location' }

  if (String(payload.previewToken || '') !== previewTokenFor(payload)) {
    return { ok: false, ...empty, error: 'The preview is out of date: preview the replace again' }
  }

  const built = buildMatcher(payload)
  if ('error' in built) return { ok: false, ...empty, error: built.error }

  const expectedHash = new Map(expected.map((item) => [path.resolve(item.path), item.hash]))
  const excluded = new Map(
    expected.map((item) => [
      path.resolve(item.path),
      new Set((Array.isArray(item.exclude) ? item.exclude : []).map(Number))
    ])
  )
  const allowed = new Set(
    (
      await filesForPayload(
        { ...payload, restrictToPaths: expected.map((item) => item.path) },
        rootPath
      )
    )
      .filter(isReplaceableFile)
      .map((item) => path.resolve(item))
  )

  const backupId = newBackupId()
  const backupDir = path.join(backupRoot, backupId)
  const manifest: ReplaceBackupManifest = {
    id: backupId,
    createdAt: new Date().toISOString(),
    rootPath,
    query,
    replaceText,
    options: {
      isRegex: !!payload.isRegex,
      caseSensitive: !!payload.caseSensitive,
      wholeWord: !!payload.wholeWord
    },
    files: []
  }
  const skippedFiles: Array<{ path: string; reason: string }> = []
  let replacements = 0

  // The manifest exists before the first file changes, and is rewritten after
  // each one, so whatever happens next, every change made has its undo.
  try {
    await writeManifest(backupDir, manifest)
  } catch (err) {
    console.warn('[search] could not create the replace backup:', err)
    return { ok: false, ...empty, error: 'Could not create the backup, nothing was replaced' }
  }

  for (const [filePath, hash] of expectedHash) {
    if (!allowed.has(filePath)) {
      skippedFiles.push({ path: filePath, reason: 'not part of this search' })
      continue
    }
    const buffer = await readSearchableFile(filePath)
    if (!buffer) {
      skippedFiles.push({ path: filePath, reason: 'unreadable' })
      continue
    }
    const hashBefore = hashContent(buffer)
    if (hashBefore !== hash) {
      skippedFiles.push({ path: filePath, reason: 'changed since the preview' })
      continue
    }
    const plan = planReplace(filePath, buffer.toString('utf-8'), built.matcher, replaceText, {
      expand: !!payload.isRegex,
      skip: excluded.get(filePath)
    })
    if (plan.replaced === 0) continue

    const backupName = `${String(manifest.files.length + 1).padStart(4, '0')}-${path.basename(filePath)}`
    const backupPath = path.join(backupDir, 'files', backupName)
    try {
      await fsp.mkdir(path.dirname(backupPath), { recursive: true })
      await fsp.writeFile(backupPath, buffer)
    } catch (err) {
      // No backup, no change.
      console.warn('[search] backup failed, file left unchanged:', filePath, err)
      skippedFiles.push({ path: filePath, reason: 'backup failed' })
      continue
    }
    const entry = {
      path: filePath,
      backup: path.join('files', backupName),
      hashBefore,
      hashAfter: hashContent(Buffer.from(plan.output, 'utf-8')),
      replacements: plan.replaced,
      changes: changedLines(filePath, plan.matches, plan.applied, plan.output)
    }
    // Listed before the write: a restore checks hashAfter, so an entry whose
    // write did not happen is simply not restored.
    manifest.files.push(entry)
    try {
      await writeManifest(backupDir, manifest)
    } catch (err) {
      console.warn('[search] manifest not updated, file left unchanged:', filePath, err)
      manifest.files.pop()
      skippedFiles.push({ path: filePath, reason: 'backup failed' })
      continue
    }
    try {
      await writeFileAtomic(filePath, plan.output)
    } catch (err) {
      console.warn('[search] write failed:', filePath, err)
      manifest.files.pop()
      skippedFiles.push({ path: filePath, reason: 'write failed' })
      await writeManifest(backupDir, manifest).catch(() => {})
      continue
    }
    replacements += plan.replaced
  }

  const logPath = path.join(backupRoot, REPLACE_LOG_FILE)
  if (manifest.files.length === 0) {
    await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {})
  } else {
    await pruneBackups(backupRoot, backupId)
  }
  await appendLog(backupRoot, {
    action: 'replace',
    at: manifest.createdAt,
    backupId: manifest.files.length > 0 ? backupId : null,
    rootPath,
    options: manifest.options,
    replacements,
    files: manifest.files.map((file) => ({ path: file.path, replacements: file.replacements })),
    skippedFiles
  })

  return {
    ok: true,
    changedFiles: manifest.files.length,
    replacements,
    files: manifest.files.map((file) => file.path),
    skippedFiles,
    ...(manifest.files.length > 0 ? { backupId, backupDir } : {}),
    logPath
  }
}

/** Puts back the files of one replace, unless they were changed again since. */
export async function restoreReplaceBackup(
  backupId: string,
  backupRoot: string
): Promise<{
  ok: boolean
  restored: string[]
  skippedFiles: Array<{ path: string; reason: string }>
  error?: string
}> {
  const empty = { restored: [], skippedFiles: [] }
  if (!backupRoot || !BACKUP_ID_PATTERN.test(String(backupId || ''))) {
    return { ok: false, ...empty, error: 'Unknown backup' }
  }
  const backupDir = path.join(backupRoot, backupId)
  let manifest: ReplaceBackupManifest
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'))
  } catch {
    return { ok: false, ...empty, error: 'Unknown backup' }
  }

  const restored: string[] = []
  const skippedFiles: Array<{ path: string; reason: string }> = []
  for (const file of manifest.files) {
    const backupPath = path.join(backupDir, file.backup)
    if (!isInsideRoot(backupPath, backupDir)) {
      skippedFiles.push({ path: file.path, reason: 'invalid backup entry' })
      continue
    }
    let current: Buffer
    try {
      current = await fsp.readFile(file.path)
    } catch {
      skippedFiles.push({ path: file.path, reason: 'file no longer exists' })
      continue
    }
    if (hashContent(current) !== file.hashAfter) {
      skippedFiles.push({ path: file.path, reason: 'changed since the replace' })
      continue
    }
    try {
      await writeFileAtomic(file.path, await fsp.readFile(backupPath))
      restored.push(file.path)
    } catch (err) {
      console.warn('[search] restore failed:', file.path, err)
      skippedFiles.push({ path: file.path, reason: 'restore failed' })
    }
  }

  manifest.restoredAt = new Date().toISOString()
  await writeManifest(backupDir, manifest).catch((err) =>
    console.warn('[search] could not mark the backup as restored:', err)
  )
  await appendLog(backupRoot, {
    action: 'restore',
    at: manifest.restoredAt,
    backupId,
    restored,
    skippedFiles
  })
  return { ok: true, restored, skippedFiles }
}
