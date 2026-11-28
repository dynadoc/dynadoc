/**
 * Runs Office text extraction in a worker thread, so a large spreadsheet
 * never blocks the Electron main process (and with it every window).
 *
 * One worker, started on first use, requests answered in order. `cancel()`
 * ends the work in flight: the worker is terminated, pending requests resolve
 * as cancelled, and the next request starts a fresh worker. If the worker
 * cannot start (missing build output), extraction falls back to the main
 * process, yielding between packages.
 */

import { Worker } from 'worker_threads'
import { extractInProcess, type OfficeExtractor } from './officeCache'
import type { OfficeExtraction, OfficeKind } from './officeText'

export type OfficeWorkerRequest = { id: number; kind: OfficeKind; bytes: Uint8Array }
export type OfficeWorkerResponse = { id: number; extraction: OfficeExtraction }

export const CANCELLED: OfficeExtraction = {
  ok: false,
  reason: 'search cancelled',
  transient: true
}

export function createOfficeWorkerExtractor(workerPath: string): {
  extract: OfficeExtractor
  cancel: () => void
  dispose: () => void
} {
  let worker: Worker | null = null
  let broken = false
  let nextId = 1
  const pending = new Map<number, (extraction: OfficeExtraction) => void>()

  const settleAll = (extraction: OfficeExtraction): void => {
    for (const resolve of pending.values()) resolve(extraction)
    pending.clear()
  }

  const start = (): Worker | null => {
    if (worker) return worker
    if (broken) return null
    try {
      const created = new Worker(workerPath)
      created.on('message', (message: OfficeWorkerResponse) => {
        const resolve = pending.get(message.id)
        if (!resolve) return
        pending.delete(message.id)
        if (pending.size === 0) created.unref()
        resolve(message.extraction)
      })
      created.on('error', (err) => {
        console.warn('[search] office worker failed:', err)
        if (worker === created) worker = null
        settleAll({ ok: false, reason: 'extraction failed', transient: true })
      })
      created.on('exit', () => {
        if (worker === created) worker = null
      })
      // An idle worker must not keep the process alive; a busy one must.
      created.unref()
      worker = created
      return created
    } catch (err) {
      console.warn('[search] office worker unavailable, extracting in process:', err)
      broken = true
      return null
    }
  }

  const extract: OfficeExtractor = (bytes, kind) => {
    const target = start()
    if (!target) return extractInProcess(bytes, kind)
    const id = nextId++
    // A Buffer from fs can share its memory with other buffers: copy, then
    // hand the copy over without a second copy.
    const copy = new Uint8Array(bytes)
    return new Promise((resolve) => {
      pending.set(id, resolve)
      target.ref()
      target.postMessage({ id, kind, bytes: copy } satisfies OfficeWorkerRequest, [copy.buffer])
    })
  }

  const cancel = (): void => {
    if (!worker || pending.size === 0) return
    const stopping = worker
    worker = null
    settleAll(CANCELLED)
    void stopping.terminate()
  }

  const dispose = (): void => {
    settleAll(CANCELLED)
    if (worker) void worker.terminate()
    worker = null
  }

  return { extract, cancel, dispose }
}
