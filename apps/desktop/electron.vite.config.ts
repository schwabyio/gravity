import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * `npm run coverage:e2e` builds with GRAVITY_COVERAGE=1: source maps, so what
 * the end-to-end tests reach maps back to `src/`. Every other build has none.
 */
const sourcemap = process.env['GRAVITY_COVERAGE'] === '1'

export default defineConfig({
  main: {
    // @schwabyio/gravity-core is workspace source, so it is compiled into the bundle.
    // Its runtime dependencies are declared in this package too, which keeps them
    // external and tells the packager what to ship.
    plugins: [externalizeDepsPlugin({ exclude: ['@schwabyio/gravity-core'] })],
    build: {
      sourcemap,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Forked with utilityProcess: HTTP and (later) user scripts run here,
          // never in the main process.
          runWorker: resolve(__dirname, 'src/main/runWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      sourcemap,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
