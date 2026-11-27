// Native modules that only some features need.
//
// A static `import` of a native addon runs when the main process loads, so a
// module that was not rebuilt for this Electron (node-pty is the usual one:
// its install exits successfully while producing nothing) used to take the
// whole application down before a window opened. Loading them on first use
// keeps the failure where it belongs: the feature that needs the module fails,
// with a message that says why, and everything else keeps working.

type NodePty = typeof import('node-pty')

let nodePtyPromise: Promise<NodePty> | null = null

export class NativeModuleUnavailableError extends Error {
  readonly moduleName: string

  constructor(moduleName: string, feature: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `${feature} is unavailable: the native module "${moduleName}" could not be loaded ` +
        `(${reason.split('\n')[0]}). Reinstall dependencies with \`npm ci\` so it is ` +
        `rebuilt for this Electron version.`
    )
    this.name = 'NativeModuleUnavailableError'
    this.moduleName = moduleName
  }
}

export function loadNodePty(): Promise<NodePty> {
  if (!nodePtyPromise) {
    nodePtyPromise = import('node-pty').catch((error) => {
      // Only a successful load is cached, so the next attempt tries again.
      nodePtyPromise = null
      throw new NativeModuleUnavailableError('node-pty', 'The integrated terminal', error)
    })
  }
  return nodePtyPromise
}
