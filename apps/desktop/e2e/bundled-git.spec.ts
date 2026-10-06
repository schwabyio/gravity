import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * Without its own git — a download that failed at `npm install` — the app runs
 * the system git, and says so in the status bar: where it looked, and which git
 * runs instead.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let noGit: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-bundled-git-')))
  // dugite looks for its git here instead, and finds none.
  noGit = path.join(tmp, 'no-git')
  fs.mkdirSync(noGit)
  app = await launchApp({
    args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`],
    env: { ...process.env, LOCAL_GIT_DIRECTORY: noGit }
  })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the status bar says the system git runs, where the bundled one was looked for, and why', async () => {
  const label = page.locator('.status-bar .status-git')
  // Every machine the tests run on has a git on its PATH.
  await expect(label).toHaveText(/^system git \d+\.\d+/, { timeout: 30_000 })
  const looked =
    process.platform === 'win32'
      ? path.join(noGit, 'cmd', 'git.exe')
      : path.join(noGit, 'bin', 'git')
  await label.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    new RegExp(
      `^The bundled git is not at ${looked.replace(/[\\.]/g, '\\$&')}, so the system git, \\d.+, is used\\.$`
    )
  )
})
