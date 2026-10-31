// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path2 from 'path'
import react from '@vitejs/plugin-react'

// vite.alias.ts
import path from 'path'
var __electron_vite_injected_dirname = '/Volumes/MacIn/Helton/VSCodeProjects/dynadoc'
var sharedAliases = {
  rootDir: path.resolve(__electron_vite_injected_dirname, ''),
  builtInExtensionsDir: path.resolve(__electron_vite_injected_dirname, 'extensions'),
  srcDir: path.resolve(__electron_vite_injected_dirname, 'src'),
  assetsDir: path.resolve(__electron_vite_injected_dirname, 'src/renderer/src/assets'),
  assetsImgDir: path.resolve(__electron_vite_injected_dirname, 'src/renderer/src/assets/img'),
  '@resources': path.resolve(__electron_vite_injected_dirname, 'resources')
}

// electron.vite.config.ts
import UnoCSS from 'unocss/vite'
import fs from 'node:fs'
var __electron_vite_injected_dirname2 = '/Volumes/MacIn/Helton/VSCodeProjects/dynadoc'
var packageJsonPath = path2.resolve(__electron_vite_injected_dirname2, 'package.json')
var packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
var allDependencies = Object.keys(packageJson.dependencies || {})
var electron_vite_config_default = defineConfig({
  // root: "src/public",
  main: {
    build: {
      rollupOptions: {
        input: {
          index: path2.resolve(__electron_vite_injected_dirname2, 'src/main/index.ts'),
          'workers/latexCompile.worker': path2.resolve(
            __electron_vite_injected_dirname2,
            'src/main/workers/latexCompile.worker.ts'
          )
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    },
    // plugins: []
    // Add rollupOptions to the main configuration
    /* build: {
      rollupOptions: {
        // Explicitly list monaco-editor as external for the Main Process
        external: ['monaco-editor'],
      },
    }, */
    //   build: {
    //   rollupOptions: {
    //     external: ['monaco-editor']
    //   }
    // },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // plugins: []
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path2.resolve(__electron_vite_injected_dirname2, 'src/preload/index.ts'),
          browser: path2.resolve(__electron_vite_injected_dirname2, 'src/preload/browser.ts'),
          'webview-var': path2.resolve(
            __electron_vite_injected_dirname2,
            'src/preload/webview-var.ts'
          ),
          'embedded-var': path2.resolve(
            __electron_vite_injected_dirname2,
            'src/preload/embedded-var.ts'
          )
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
    /* plugins: [
      externalizeDepsPlugin(),
      react()
    ],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "src/preload/index.ts"),
          fluent: path.resolve(__dirname, "src/preload/fluent-wrapper.ts")
        },
        output: {
          entryFileNames: "[name].js"
        }
      }
    } */
  },
  renderer: {
    server: {
      // host: '127.0.0.1',
      hmr: false,
      // 🚫 disable vite hot module replacement for renderer
      // watch: { usePolling: true } // (optional) if you still want file change detection
      watch: {
        ignored: [
          '**/node_modules/**',
          '**/dist/**',
          '**/build/**',
          '**/assets/fonts/**',
          // 👈 exclude big folders
          '**/assets/fluentui-system-icons/**',
          '**/assets/**/SVG/**',
          '**/assets/**/PDF/**'
        ]
      }
      /* fs: {
        allow: [
          // allow access to public folder explicitly
          path.resolve(__dirname, 'public'),
          path.resolve(__dirname, 'src/renderer')
        ]
      } */
    },
    plugins: [
      // Desktop only: give the renderer a `Buffer` global before anything else
      // runs. Under contextIsolation there are no Node globals, and roughly
      // eleven renderer modules plus several dependencies call Buffer at
      // runtime; the first call aborts the boot. See
      // src/renderer/src/utils/shims/buffer.ts.
      //
      // Injected here rather than imported from main.ts on purpose: main.ts is
      // shared with the web and mobile builds, which already install the same
      // global from lib/api/web/node.ts. Importing it there would pull the
      // module into their graphs and reshuffle their chunks for no gain. This
      // way their output is untouched, byte for byte.
      /* @__PURE__ */ (() => {
        const ENTRY = 'src/renderer/src/main.ts'
        let injected = false
        return {
          name: 'ddoc-desktop-buffer-global',
          enforce: 'pre',
          transform(code, id) {
            if (!id.replace(/\\/g, '/').endsWith(ENTRY)) return null
            injected = true
            return {
              code: `import './utils/shims/buffer'
${code}`,
              map: null
            }
          },
          buildEnd() {
            if (!injected) {
              this.error(`ddoc-desktop-buffer-global never matched ${ENTRY}`)
            }
          }
        }
      })(),
      // pdf.js's standalone viewer is vendored at src/renderer/pdfjs and reached
      // as ./pdfjs/web/viewer.html by PdfViewer.svelte. Vite copies
      // src/renderer/public verbatim, but this folder sits beside public/, not
      // inside it, and no build config has ever copied it -- `git log -S pdfjs`
      // over the build files turns up only the npm dependency. So out/renderer
      // has had no pdfjs directory since the folder landed (c74329e8,
      // 2025-12-03) and the viewer has been a 404 in every packaged build. It
      // worked in dev only, where Vite serves the renderer root directly.
      //
      // Copied rather than moved into public/ so the 394 vendored files stay
      // where git already has them, and so the exclusions stay visible in one
      // place: source maps are 9.1 MB of the folder's 20 MB, and
      // compressed.tracemonkey-pldi-09.pdf is pdf.js's own demo document.
      (() => {
        const SOURCE = path2.resolve(__electron_vite_injected_dirname2, 'src/renderer/pdfjs')
        const DEMO_PDF = 'compressed.tracemonkey-pldi-09.pdf'
        let outDir = ''
        return {
          name: 'ddoc-copy-pdfjs-viewer',
          apply: 'build',
          configResolved(config) {
            outDir = config.build.outDir
          },
          closeBundle() {
            const destination = path2.join(outDir, 'pdfjs')
            fs.cpSync(SOURCE, destination, {
              recursive: true,
              filter: (from) => !from.endsWith('.map') && path2.basename(from) !== DEMO_PDF
            })
            const entry = path2.join(destination, 'web', 'viewer.html')
            const worker = path2.join(destination, 'build', 'pdf.worker.mjs')
            for (const required of [entry, worker]) {
              if (!fs.existsSync(required)) {
                this.error(`ddoc-copy-pdfjs-viewer did not produce ${required}`)
              }
            }
          }
        }
      })(),
      // svelte(),
      svelte({
        hot: false,
        // disable Svelte HMR
        compilerOptions: {
          runes: true
        }
      }),
      react(),
      UnoCSS({
        configFile: path2.resolve(__electron_vite_injected_dirname2, 'uno.config.ts')
      })
      // monacoEditorPlugin.default({}),
      // svg()
      // monacoEditorPlugin({})
    ],
    resolve: {
      dedupe: ['yjs'],
      alias: {
        // Create shorthand for project directories to be used in file importations
        ...sharedAliases,
        '@oxc-parser/binding-wasm32-wasi': path2.resolve(
          __electron_vite_injected_dirname2,
          'src/renderer/src/utils/shims/empty.ts'
        )
        // svelte: path.resolve('node_modules', 'svelte/src/runtime')
        // '@': path.resolve(__dirname, './src'),
        // 'svelte/internal': path.resolve(__dirname, 'node_modules/svelte/internal'),
        // svelte: path.resolve(__dirname, 'node_modules/svelte')
      }
    },
    optimizeDeps: {
      include: [
        'monaco-editor',
        'react',
        'react-dom',
        '@fluentui/react-components',
        'w3c-keyname'
        // 3. Force-include everything from  dependencies object at cold start
        // ...allDependencies,
        /* '@fluentui/react-datepicker-compat',
        '@assistant-ui/react',
        '@assistant-ui/react-ai-sdk',
        '@assistant-ui/react-markdown',
        'svelte-persisted-store',
        'lodash-es',
        'highlight.js',
        'highlight.js/lib/common',
        'howler',
        'ag-psd',
        'antd',
        'crypto-js',
        'svelte-tiptap',
        'qrcode',
        'echarts',
        '@vscode/vscode-languagedetection',
        'katex',
        'videojs-record',
        'recordrtc' */
      ],
      exclude: ['latex.js', 'rollup', 'fsevents']
      // force: true  // PERF-FIX RC3: removed — was forcing full dep rebuild on every cold start, destroying V8 bytecode cache
    },
    ssr: {
      external: ['rollup', 'fsevents'],
      noExternal: ['svelte-i18n']
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        external: ['rollup', 'fsevents'],
        cache: false
        // Sometimes clearing the cache helps memory during OOM
        // output: {
        // Change the module format from 'cjs' to 'es'
        // format: 'es', // <--- Change this
        // },
      }
    }
  }
})
export { electron_vite_config_default as default }
