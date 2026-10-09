// `npm run dev:clean`: `npm run dev` as a first launch sees it — no workspaces,
// App settings, flag overrides or scratch pads, and every pane at its default.
// Its data goes in gravity-clean in the system's temp folder, emptied as each
// run starts rather than when the app quits: Ctrl+C stops electron-vite before
// Electron has finished with the folder, and electron-vite gives no way to wait
// for Electron itself. So what a run wrote is there to look at until the next.
//
// The data folder the app keeps is never read or touched: `--user-data-dir`
// turns off placeUserData and migrateUserData both, so nothing is carried over
// from the folder it had before it was renamed either.
import { spawn } from 'node:child_process'
import console from 'node:console'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const data = path.join(os.tmpdir(), 'gravity-clean')
// Which run has the folder: a second must not empty it from under the first.
const owner = path.join(os.tmpdir(), 'gravity-clean.pid')

const running = (() => {
  try {
    const pid = Number(readFileSync(owner, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch (cause) {
    // No file, or nothing by that pid: no run has it. EPERM: something does.
    return cause?.code === 'EPERM' ? Number(readFileSync(owner, 'utf8')) : null
  }
})()
if (running) {
  console.error(
    [
      `Another npm run dev:clean (pid ${running}) is using ${data}.`,
      `Quit that app first. If it is not running, delete ${owner} and run this again.`
    ].join('\n')
  )
  process.exit(1)
}

// Windows can hold a file a moment after Electron exits.
rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
mkdirSync(data, { recursive: true })
writeFileSync(owner, String(process.pid))
console.log(`A clean app: its data is in ${data}, emptied when dev:clean next starts.`)

const require = createRequire(import.meta.url)
const { bin } = require('electron-vite/package.json')
const electronVite = path.join(
  path.dirname(require.resolve('electron-vite/package.json')),
  bin['electron-vite']
)

// No shell, so the folder needs no quoting on any platform; electron-vite hands
// what follows `--` to Electron, through every restart a change to main makes.
const dev = spawn(process.execPath, [electronVite, 'dev', '--', `--user-data-dir=${data}`], {
  stdio: 'inherit'
})
dev.on('exit', (code, signal) => {
  rmSync(owner, { force: true })
  process.exit(code ?? (signal ? 1 : 0))
})
