#!/usr/bin/env node
// One command for a local stack: the stub bridge plus a client pointed at it.
//
//   npm run dev:web:local       stub bridge + web client (Vite)
//   npm run dev:desktop:local   stub bridge + desktop app (electron-vite)
//
// Anything after `--` goes to the client, e.g.
//   npm run dev:web:local -- --open
//   npm run dev:web:local -- --port 5180
//
// The stub listens on DYNADOC_STUB_PORT (7070 by default) and keeps its files
// under DYNADOC_STUB_ROOT (~/.dynadoc-stub by default); see
// tools/stub-bridge/README.md. If a stub is already answering on that port it
// is reused, not started twice. The client gets VITE_API_URL from your
// environment if you set one, otherwise the stub's address.
//
// Ctrl+C stops both. When the client exits, the stub this script started is
// stopped too. Only Node is needed: no extra dependency, and the same command
// works on macOS, Linux and Windows.

/* eslint-disable @typescript-eslint/explicit-function-return-type --
   plain .mjs: there is no type annotation syntax to satisfy this rule here. */

import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const require = createRequire(path.join(repoRoot, 'package.json'))

// Resolved through package.json: neither package exports its bin script.
const packageFile = (name, file) =>
  path.join(path.dirname(require.resolve(`${name}/package.json`)), file)

const [target = 'web', ...rawArgs] = process.argv.slice(2)
const clientArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs

const TARGETS = {
  web: {
    label: 'web client',
    bin: () => packageFile('vite', 'bin/vite.js'),
    args: ['--config', 'web.vite.config.mts']
  },
  desktop: {
    label: 'desktop app',
    bin: () => packageFile('electron-vite', 'bin/electron-vite.js'),
    args: ['dev']
  }
}

const chosen = TARGETS[target]
if (!chosen) {
  console.error(`Unknown target "${target}". Use one of: ${Object.keys(TARGETS).join(', ')}.`)
  process.exit(2)
}

// The client's Content-Security-Policy allows http://localhost:7070 and not
// 127.0.0.1, so the address is spelled with "localhost" (see the stub README).
const stubPort = Number(process.env.DYNADOC_STUB_PORT || 7070)
const apiUrl = process.env.VITE_API_URL || `http://localhost:${stubPort}`

const log = (message) => console.log(`[dev-local] ${message}`)

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function waitForPort(port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portAnswers(port)) return true
    if (child.exitCode !== null) return false
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const children = new Set()
let stopping = false

function stopAll(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  // Give children a moment to exit cleanly, then leave.
  setTimeout(() => process.exit(code), 500).unref()
}

process.on('SIGINT', () => stopAll(130))
process.on('SIGTERM', () => stopAll(143))

let stub = null
if (await portAnswers(stubPort)) {
  log(`something already listens on port ${stubPort}; reusing it as the bridge.`)
} else {
  log(`starting the stub bridge on http://localhost:${stubPort}`)
  stub = spawn(process.execPath, [path.join(repoRoot, 'tools', 'stub-bridge', 'server.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DYNADOC_STUB_PORT: String(stubPort) }
  })
  children.add(stub)
  stub.on('exit', (code) => {
    if (!stopping) {
      log(`the stub bridge stopped (exit ${code}); stopping the ${chosen.label} too.`)
      stopAll(code || 1)
    }
  })
  if (!(await waitForPort(stubPort, stub))) {
    log('the stub bridge did not start; see its output above.')
    stopAll(1)
  }
}

if (!stopping) {
  log(`starting the ${chosen.label} with VITE_API_URL=${apiUrl}`)
  const client = spawn(process.execPath, [chosen.bin(), ...chosen.args, ...clientArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_API_URL: apiUrl,
      NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192'
    }
  })
  children.add(client)
  client.on('exit', (code) => {
    if (!stopping) {
      log(`the ${chosen.label} exited (${code ?? 'signal'}).`)
      stopAll(code ?? 0)
    }
  })
}
