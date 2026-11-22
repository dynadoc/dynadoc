// What a spreadsheet reference does while its sheet is loading: wait for the
// sheet to open, drop the answer of a request that a newer one replaced, and
// ask the chips again once per name when the document's sheets are known.
// No imports on purpose, and the store, timers and broadcast are passed in:
// tests/smoke/sheet-ref-loading.test.mjs runs this file on its own with esbuild.

type Unsubscribe = () => void

export type LiveSheetWaiterDeps<Snapshot> = {
  /** A svelte-style store subscribe: calls back at once, then on each change. */
  subscribe: (run: (snapshot: Snapshot) => void) => Unsubscribe
  isLive: (snapshot: Snapshot, path: string) => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  defer?: (fn: () => void) => void
}

/**
 * Resolves with true once the sheet at `path` is live, or with false after
 * `timeoutMs` (a sheet that is not open, or not embedded in an open document).
 */
export function createLiveSheetWaiter<Snapshot>({
  subscribe,
  isLive,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  defer = (fn) => queueMicrotask(fn)
}: LiveSheetWaiterDeps<Snapshot>): (path: string, timeoutMs: number) => Promise<boolean> {
  return (path, timeoutMs) =>
    new Promise((resolve) => {
      let done = false
      let unsubscribe: Unsubscribe | null = null
      let timer: unknown = null
      const finish = (live: boolean): void => {
        if (done) return
        done = true
        if (timer !== null) clearTimer(timer)
        // subscribe() calls back before it returns the unsubscriber.
        defer(() => unsubscribe?.())
        resolve(live)
      }
      timer = setTimer(() => finish(false), timeoutMs)
      unsubscribe = subscribe((snapshot) => {
        if (isLive(snapshot, path)) finish(true)
      })
    })
}

/**
 * One token per request for a key. A request writes its answer only while its
 * token is the key's latest: a newer request (after the file changed, say)
 * has replaced it, and an older answer must not overwrite the newer one.
 */
export function createRequestTokens(): {
  start: (key: string) => number
  isCurrent: (key: string, token: number) => boolean
} {
  let last = 0
  const current = new Map<string, number>()
  return {
    start: (key) => {
      last += 1
      current.set(key, last)
      return last
    },
    isCurrent: (key, token) => current.get(key) === token
  }
}

/**
 * Names to ask again once a document's sheets are loaded: each name once, and
 * one wait per document however many chips asked meanwhile.
 */
export function createPendingRefBroadcast(
  broadcast: (name: string) => void
): (documentId: string, name: string, whenLoaded: () => Promise<unknown>) => void {
  const pending = new Map<string, Set<string>>()
  return (documentId, name, whenLoaded) => {
    let names = pending.get(documentId)
    if (names) {
      names.add(name)
      return
    }
    names = new Set([name])
    pending.set(documentId, names)
    const flush = (): void => {
      const toAsk = pending.get(documentId)
      pending.delete(documentId)
      toAsk?.forEach((each) => broadcast(each))
    }
    void whenLoaded().then(flush, flush)
  }
}
