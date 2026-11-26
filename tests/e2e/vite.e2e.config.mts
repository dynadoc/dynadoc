/**
 * Vite config for the web e2e suite.
 *
 * It is the web build (`web.vite.config.mts`) with two changes and nothing
 * else, so what the suite runs is what `npm run build:web` ships:
 *
 *   - the bundle goes to `tests/e2e/.web-dist` instead of `web/dist`, so a test
 *     run never overwrites a build a contributor made by hand;
 *   - `vite preview` proxies `/api` to the stub bridge on the test port.
 *
 * The proxy is the reason the stub can run on a port other than 7070. The
 * renderer's Content Security Policy only allowlists `http://localhost:7070` on
 * the loopback interface, so a stub on 7071 called directly would be refused by
 * the browser. Calls to the page's own origin are allowed by `'self'`, so the
 * build points `VITE_API_URL` at the preview server and the preview server
 * forwards to the stub. The CSP stays exactly as shipped.
 */
import { defineConfig, mergeConfig } from 'vite'
import path from 'path'
import webConfig from '../../web.vite.config.mts'

const stubPort = Number(process.env.E2E_STUB_PORT || 7071)
const webPort = Number(process.env.E2E_WEB_PORT || 4180)

// Always the preview server's own origin, even when the shell exports another
// VITE_API_URL (`dev:web:stub` users often do): Vite reads VITE_* variables
// from process.env after this file runs.
process.env.VITE_API_URL = `http://localhost:${webPort}`

const server = {
  host: 'localhost',
  port: webPort,
  strictPort: true,
  proxy: {
    '/api': {
      target: `http://127.0.0.1:${stubPort}`,
      changeOrigin: true,
      ws: true
    }
  }
}

export default mergeConfig(
  webConfig,
  defineConfig({
    build: {
      outDir: path.resolve(__dirname, '.web-dist'),
      emptyOutDir: true
    },
    // `preview` serves the built bundle (the default, and what CI runs).
    // `server` is the same thing for `E2E_SERVER=dev`, see playwright.config.ts.
    preview: server,
    server
  })
)
