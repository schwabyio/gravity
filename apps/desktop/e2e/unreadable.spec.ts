import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { addProject } from './addProject'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * A part of a project that cannot be read — on Windows, a fresh clone's files
 * held by antivirus — is a problem said on the project and in the console's
 * load log, never a project quietly short of what is in it.
 */

// Made unreadable by its permissions, which Windows does not have, and root ignores.
test.skip(process.platform === 'win32', 'no folder permissions to take away on Windows')
test.skip(process.getuid?.() === 0, 'root reads every folder')

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let environments: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-unreadable-')))
  const repo = path.join(tmp, 'shop-api')
  environments = path.join(repo, 'environments')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'collections', 'orders.yml'),
    'id: orders\nsteps:\n  - GET: http://127.0.0.1:9/orders\n'
  )
  fs.mkdirSync(environments)
  fs.writeFileSync(path.join(environments, 'dev.yml'), 'vars: {}\n')
  fs.chmodSync(environments, 0o000)

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
})

test.afterAll(async () => {
  await app?.close()
  fs.chmodSync(environments, 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })
})

const project = () => page.getByRole('region', { name: 'Project shop-api', exact: true })
const problems = () => project().getByRole('img', { name: 'Project problems' })

test('a folder that cannot be read is a problem on its project, and a warning in the console', async () => {
  await expect(problems()).toHaveAttribute(
    'title',
    /environments could not be read \(EACCES: permission denied\)/
  )
  // Its collections are listed all the same.
  await expect(project().locator('.collection-row')).toHaveText(['orders'])

  const consoleButton = page.locator('.status-bar').getByRole('button', { name: /^Console/ })
  await expect(consoleButton).toHaveAccessibleName('Console, 1 warning')
  await consoleButton.click()
  const said = page.locator('.console-row.load-problem')
  await expect(said).toHaveCount(1)
  await expect(said).toContainText('shop-api')
  await expect(said).toContainText('environments could not be read (EACCES: permission denied)')
})

test('once it can be read, the next change lists what it holds and the problem goes', async () => {
  fs.chmodSync(environments, 0o755)
  fs.writeFileSync(path.join(environments, 'qa.yml'), 'vars: {}\n')
  await expect(problems()).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.console-row.load', { hasText: 'Read again' })).toContainText(
    '1 collection, 2 environments, where it had 1 collection, 0 environments'
  )
})
