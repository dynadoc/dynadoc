// Minimal, production-faithful stand-in for the renderer's `./shims/node`
// module. SecurityHelpers only reaches the filesystem through `nodeApi`, so a
// Node-backed shim lets the real class run under a plain `node` process without
// Electron, a browser, or any production code change.

import fs from 'node:fs'
import path from 'node:path'

export const nodeApi = {
  fs,
  fsPromises: fs.promises,
  path
}
