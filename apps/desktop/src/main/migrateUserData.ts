import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Where the app keeps its data: named for the product, Gravity Test
 * Automation, though the app itself is called Gravity.
 *
 * Electron names the user-data directory after the app, so renaming the app
 * would otherwise move it and forget every added workspace, and a directory
 * called only `Gravity` could be another program's.
 */
const DATA_DIR = 'Gravity Test Automation'

/**
 * Keep the user data in `DATA_DIR`, whatever the app is called. Runs before
 * `ready`, as Electron requires, and never when `--user-data-dir` points
 * somewhere else, as the end-to-end tests do.
 */
export function placeUserData(): void {
  if (process.argv.some((arg) => arg.startsWith('--user-data-dir'))) return
  app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR))
}

/**
 * Where the app kept its data before it was named Gravity Test Automation:
 * Electron named the directory `@schwabyio/api-desktop` after the package.
 */
const LEGACY_DIR = path.join('@schwabyio', 'api-desktop')

/** What is worth carrying over: the workspace list, and per-viewer layout. */
const CARRIED = ['workspaces.json', 'Local Storage']

/**
 * Copy the old user data into the new directory, once.
 *
 * Runs before `ready`, while nothing has opened the new directory's storage
 * yet. Only on a first launch — keyed on the workspace list, not on the
 * directory, because Electron creates the directory itself before this runs —
 * and never when `--user-data-dir` points somewhere else, as the end-to-end
 * tests do. Nothing already in the new directory is overwritten, and the old
 * directory is left in place, so nothing is lost if this goes wrong.
 */
export function migrateUserData(): void {
  if (process.argv.some((arg) => arg.startsWith('--user-data-dir'))) return
  try {
    const target = app.getPath('userData')
    const legacy = path.join(app.getPath('appData'), LEGACY_DIR)
    const firstLaunch = !fs.existsSync(path.join(target, 'workspaces.json'))
    if (!firstLaunch || !fs.existsSync(legacy)) return

    fs.mkdirSync(target, { recursive: true })
    for (const name of CARRIED) {
      const from = path.join(legacy, name)
      const to = path.join(target, name)
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true })
    }
  } catch (cause) {
    // Starting with no workspaces is recoverable; failing to start is not.
    console.warn('Could not carry over data from the previous app name:', cause)
  }
}
