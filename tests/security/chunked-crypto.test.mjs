#!/usr/bin/env node
// Round-trip tests for SecurityHelpers.encryptFileChunked / decryptFileChunked.
//
// Why this exists
//   Large files are encrypted part-by-part. The writer and reader must agree on
//   the on-disk layout byte for byte, or decryption fails GCM authentication
//   and the file is lost. This test pins the canonical chunk layout
//   [salt][iv][authTag][ciphertext] and proves a multi-chunk binary file
//   survives a full encrypt -> decrypt round-trip, while a wrong password or a
//   tampered part is rejected.
//
// How it runs without Electron
//   SecurityHelpers reaches disk only through `nodeApi` from './shims/node'.
//   esbuild bundles the real production source for Node, with that one import
//   redirected to a Node-backed stub (node-shim-stub.mjs). The class itself is
//   exercised unchanged — no browser, no bundler config, no test runner, and
//   nothing newer than Node 20 is required.
//
// Usage
//   node tests/security/chunked-crypto.test.mjs

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { build } from 'esbuild'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const SOURCE = path.join(repoRoot, 'src', 'renderer', 'src', 'utils', 'SecurityHelpers.ts')
const SHIM_STUB = path.join(here, 'node-shim-stub.mjs')

const log = (...args) => console.log('[chunked-crypto]', ...args)
let failures = 0

function check(name, condition) {
  if (condition) {
    log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}`)
  }
}

async function expectReject(name, fn) {
  try {
    await fn()
    failures += 1
    console.error(`  FAIL  ${name} (expected a rejection, got success)`)
  } catch {
    log(`  ok    ${name}`)
  }
}

const PART_RE = /\.part\d+$/
const PASSWORD = 'correct horse battery staple'
const WRONG_PASSWORD = 'incorrect horse battery staple'

const work = mkdtempSync(path.join(tmpdir(), 'ddoc-chunked-crypto-'))
try {
  // Bundle the real production source, redirecting its only renderer import
  // (`./shims/node`) to a Node-backed stub. Node builtins stay external under
  // platform: 'node'.
  const bundlePath = path.join(work, 'SecurityHelpers.mjs')
  await build({
    entryPoints: [SOURCE],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-shims-node',
        setup(b) {
          b.onResolve({ filter: /(^|\/)shims\/node$/ }, () => ({ path: SHIM_STUB }))
        }
      }
    ]
  })

  const { default: SecurityHelpers } = await import(pathToFileURL(bundlePath).href)

  const CHUNK = SecurityHelpers.CHUNK_SIZE
  const { SALT_LEN, IV_LEN, TAG_LEN } = SecurityHelpers

  const listParts = (dir) => readdirSync(dir).filter((name) => PART_RE.test(name)).sort()

  // Encrypts `data` into a fresh parts directory and returns its path, so the
  // parts can be decrypted or tampered with afterwards.
  async function encryptToParts(label, data) {
    const srcDir = path.join(work, `${label}-src`)
    const partsDir = path.join(work, `${label}-parts`)
    mkdirSync(srcDir, { recursive: true })
    const srcPath = path.join(srcDir, `${label}.bin`)
    writeFileSync(srcPath, data)
    await SecurityHelpers.encryptFileChunked(srcPath, partsDir, PASSWORD)
    return partsDir
  }

  // -------------------------------------------------------------------------
  // Case 1: a binary file larger than CHUNK_SIZE must split into >= 2 parts
  // and round-trip byte for byte.
  log('multi-chunk binary round-trip')
  const bigData = crypto.randomBytes(CHUNK + 123_456)
  check('source is genuinely binary (contains a NUL byte)', bigData.includes(0x00))

  const bigParts = await encryptToParts('big', bigData)
  check('at least two chunks were produced', listParts(bigParts).length >= 2)

  const bigOut = path.join(work, 'big-out.bin')
  await SecurityHelpers.decryptFileChunked(bigParts, bigOut, PASSWORD)
  const bigDecrypted = readFileSync(bigOut)
  check('decrypted size matches the original', bigDecrypted.length === bigData.length)
  check('decrypted bytes are identical to the original', bigDecrypted.equals(bigData))

  // -------------------------------------------------------------------------
  // Case 2: a file exactly CHUNK_SIZE bytes long round-trips without loss.
  log('exact CHUNK_SIZE boundary round-trip')
  const exactData = crypto.randomBytes(CHUNK)
  const exactParts = await encryptToParts('exact', exactData)
  check('at least one chunk was produced', listParts(exactParts).length >= 1)

  const exactOut = path.join(work, 'exact-out.bin')
  await SecurityHelpers.decryptFileChunked(exactParts, exactOut, PASSWORD)
  check('decrypted bytes are identical to the original', readFileSync(exactOut).equals(exactData))

  // -------------------------------------------------------------------------
  // Case 3: a wrong password fails GCM authentication.
  log('integrity failures')
  await expectReject('wrong password is rejected', () =>
    SecurityHelpers.decryptFileChunked(bigParts, path.join(work, 'bad-pw-out.bin'), WRONG_PASSWORD)
  )

  // -------------------------------------------------------------------------
  // Case 4: a flipped ciphertext byte fails authentication.
  const tamperCipherParts = await encryptToParts('tamper-ct', bigData)
  {
    const first = path.join(tamperCipherParts, listParts(tamperCipherParts)[0])
    const buf = readFileSync(first)
    buf[SALT_LEN + IV_LEN + TAG_LEN + 10] ^= 0xff // a byte inside the ciphertext
    writeFileSync(first, buf)
  }
  await expectReject('a flipped ciphertext byte is rejected', () =>
    SecurityHelpers.decryptFileChunked(tamperCipherParts, path.join(work, 'tamper-ct-out.bin'), PASSWORD)
  )

  // -------------------------------------------------------------------------
  // Case 5: a flipped auth-tag byte fails authentication.
  const tamperTagParts = await encryptToParts('tamper-tag', bigData)
  {
    const first = path.join(tamperTagParts, listParts(tamperTagParts)[0])
    const buf = readFileSync(first)
    buf[SALT_LEN + IV_LEN] ^= 0xff // a byte inside the auth tag
    writeFileSync(first, buf)
  }
  await expectReject('a flipped auth-tag byte is rejected', () =>
    SecurityHelpers.decryptFileChunked(tamperTagParts, path.join(work, 'tamper-tag-out.bin'), PASSWORD)
  )

  if (failures > 0) {
    console.error(`\n[chunked-crypto] FAIL: ${failures} check(s) failed\n`)
    process.exit(1)
  }
  log('OK — chunked encryption round-trips and rejects tampering')
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
