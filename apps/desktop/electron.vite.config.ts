import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @schwabyio/gravity-core is workspace source, so it is compiled into the bundle.
    // Its runtime dependencies are declared in this package too, which keeps them
    // external and tells the packager what to ship.
    plugins: [externalizeDepsPlugin({ exclude: ['@schwabyio/gravity-core'] })],
    build: {
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
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
