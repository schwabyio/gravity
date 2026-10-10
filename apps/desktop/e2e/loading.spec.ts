import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { DesktopApi } from '../src/shared/ipc'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * Projects still being read say so: + Project on a monorepo says which of how
 * many it is reading, each project is in the sidebar as soon as it is listed,
 * and a spinner stands where its branch goes until git answers. git is made as
 * slow to start here as it can be on Windows.
 */

// The slow git is a shell script in front of dugite's.
test.skip(process.platform === 'win32', 'the slow git is a shell script')

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const DUGITE = path.resolve(process.cwd(), '../../node_modules/dugite/git')
/** How long each git call takes to start. */
const SLOW_SECONDS = 2

let tmp: string
let platform: string
let app: ElectronApplication
let page: Page

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-loading-')))
  const slowGit = path.join(tmp, 'git')
  write(
    path.join(slowGit, 'bin', 'git'),
    `#!/bin/sh\nsleep ${SLOW_SECONDS}\nexec "${path.join(DUGITE, 'bin', 'git')}" "$@"\n`
  )
  fs.chmodSync(path.join(slowGit, 'bin', 'git'), 0o755)
  for (const folder of ['etc', 'libexec', 'share']) {
    if (fs.existsSync(path.join(DUGITE, folder))) {
      fs.symlinkSync(path.join(DUGITE, folder), path.join(slowGit, folder))
    }
  }

  platform = path.join(tmp, 'platform')
  const collection = (id: string) => `id: ${id}\nsteps:\n  - GET: http://127.0.0.1:9/${id}\n`
  write(path.join(platform, 'services', 'auth', 'collections', 'login.yml'), collection('login'))
  write(path.join(platform, 'services', 'users', 'collections', 'me.yml'), collection('me'))
  write(path.join(platform, 'services', 'users', 'project.yml'), 'uses: ../../shared\n')
  write(path.join(platform, 'shared', 'project.yml'), 'name: Shared\n')
  write(path.join(platform, 'shared', 'environments', 'dev.yml'), 'vars: {}\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: platform, stdio: 'pipe' })

  app = await launchApp({
    args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`],
    env: { ...process.env, LOCAL_GIT_DIRECTORY: slowGit }
  })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  // git set up, as it is a while after startup: from then on each project waits a moment
  // for it, so the add goes one project at a time, slowly enough to see.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          // Run in the page, where `globalThis` is its window.
          const { desktop } = globalThis as unknown as {
            desktop: Pick<DesktopApi, 'consoleHistory'>
          }
          return (await desktop.consoleHistory()).some((line) => line.subject === 'git')
        }),
      { timeout: 30_000 }
    )
    .toBe(true)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('adding a monorepo says how far along it is, and each project that git has yet to answer for', async () => {
  test.setTimeout(90_000)
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, platform)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '+ Project' }).click()

  const status = page.locator('.sidebar-status')
  await expect(status).toContainText(/^Adding projects from platform… [123] of 3: \w+$/)
  // Listed before git has answered: a spinner where the branch will be.
  await expect(page.getByRole('img', { name: 'Loading auth' })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Project auth', exact: true }).locator('.collection-row')
  ).toHaveText(['login'])

  await expect(status).toHaveText('Added 3 projects from platform: auth, users, Shared.', {
    timeout: 30_000
  })
  await expect(page.locator('.sidebar .loading-spinner')).toHaveCount(0, { timeout: 30_000 })
  await expect(
    page.getByRole('region', { name: 'Project auth', exact: true }).locator('.repo-branch')
  ).toHaveText('main')
})
