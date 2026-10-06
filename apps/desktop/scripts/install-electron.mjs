// Before `npm run dev` and `npm start`: download Electron's binary when it is not
// there yet. Since Electron 42 `npm install` no longer does: the electron package
// downloads it on the first `require('electron')`, which electron-vite never
// makes — it reads the package's path.txt, and without one fails with "Electron
// uninstall". Electron's own install script does the download, and exits at once
// when the binary is already there. Once electron-vite finds Electron through
// `require('electron')`, or downloads it itself, this can go.
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const electron = path.dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')
const pathFile = path.join(electron, 'path.txt')

// The download says nothing for its first 30 s: say what is happening.
if (!existsSync(pathFile)) {
  console.log(`Downloading Electron ${version}, once: 120 to 150 MB from GitHub's releases.`)
}
const install = spawnSync(process.execPath, [path.join(electron, 'install.js')], {
  stdio: 'inherit'
})
// What electron-vite will look for: path.txt, naming a binary in dist/.
const binary = existsSync(pathFile)
  ? path.join(electron, 'dist', readFileSync(pathFile, 'utf8'))
  : null
if (install.status !== 0 || !binary || !existsSync(binary)) {
  console.error(
    [
      '',
      `Electron ${version} did not download${binary ? `: there is nothing at ${binary}` : ''}.`,
      'Behind a proxy, set HTTPS_PROXY, or point ELECTRON_MIRROR at a mirror the network',
      'allows. Then run this again.',
      ''
    ].join('\n')
  )
  process.exit(1)
}
