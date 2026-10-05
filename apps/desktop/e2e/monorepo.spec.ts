import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * + Project on a monorepo's root, or a folder of repositories: it offers every
 * project in it — each folder with a collections/, and the global project
 * they use — and adds them in one go.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let platform: string
let app: ElectronApplication
let page: Page

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

const collection = (id: string) => `id: ${id}\nsteps:\n  - GET: http://127.0.0.1:9/${id}\n`

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-monorepo-')))
  platform = path.join(tmp, 'platform')
  write(path.join(platform, 'services', 'auth', 'collections', 'login.yml'), collection('login'))
  write(
    path.join(platform, 'services', 'users', 'collections', 'profile.yml'),
    collection('profile')
  )
  write(path.join(platform, 'services', 'users', 'project.yml'), 'uses: ../../shared\n')
  write(path.join(platform, 'shared', 'project.yml'), 'name: Shared\n')
  write(path.join(platform, 'node_modules', 'dep', 'collections', 'nope.yml'), collection('nope'))
  write(path.join(platform, 'docker-compose.yml'), 'services: {}\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: platform, stdio: 'pipe' })
  fs.mkdirSync(path.join(tmp, 'empty'))

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** + Project on `folder`, answering the question it asks, if any; resolves to that question. */
const addFrom = async (folder: string, answer = true): Promise<() => string> => {
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void (answer ? dialog.accept() : dialog.dismiss())
  })
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, folder)
  await page.getByRole('button', { name: '+ Project' }).click()
  return () => asked
}
const projects = () => page.locator('.sidebar section.project')

test('adds every project in a monorepo, and the shared project they use, at once', async () => {
  const asked = await addFrom(platform)
  await expect(page.locator('.sidebar-status')).toHaveText(
    'Added 3 projects from platform: auth, users, Shared.'
  )
  expect(asked()).toBe(
    'platform is not a project, but holds 3 projects: services/auth, services/users, shared. Add them all?'
  )
  await expect(projects()).toHaveCount(3)
  for (const name of ['auth', 'users', 'Shared']) {
    await expect(page.getByRole('region', { name: `Project ${name}`, exact: true })).toBeVisible()
  }
  await expect(page.locator('.sidebar')).not.toContainText('nope')
  // Nothing was made in the monorepo's root, or in the shared project.
  expect(fs.existsSync(path.join(platform, 'collections'))).toBe(false)
  expect(fs.existsSync(path.join(platform, 'shared', 'collections'))).toBe(false)
})

test('adding the same folder again adds nothing, and says so', async () => {
  await addFrom(platform)
  await expect(page.locator('.sidebar-status')).toHaveText(
    'All 3 projects in platform were here already.'
  )
  await expect(projects()).toHaveCount(3)
})

test('a folder with no projects in it asks before becoming one', async () => {
  const asked = await addFrom(path.join(tmp, 'empty'), false)
  await expect
    .poll(asked)
    .toBe(
      'empty has no collections/ folder, nor project.yml or anything else a project holds. Create collections/ in it and add it as a project?'
    )
  await expect(projects()).toHaveCount(3)
  expect(fs.existsSync(path.join(tmp, 'empty', 'collections'))).toBe(false)
})

test('a folder of repositories offers the projects in it, and adds them all', async () => {
  const other = path.join(tmp, 'other')
  write(path.join(other, 'apps', 'web', 'collections', 'home.yml'), collection('home'))
  write(path.join(other, 'apps', 'admin', 'collections', 'users.yml'), collection('users'))
  const asked = await addFrom(other)
  await expect(page.locator('.sidebar-status')).toHaveText(
    'Added 2 projects from other: admin, web.'
  )
  expect(asked()).toBe(
    'other is not a project, but holds 2 projects: apps/admin, apps/web. Add them all?'
  )
  await expect(projects()).toHaveCount(5)
  expect(fs.existsSync(path.join(other, 'collections'))).toBe(false)
})

test('a project holding more projects offers them too, or is added alone', async () => {
  const suite = path.join(tmp, 'suite')
  write(path.join(suite, 'collections', 'smoke.yml'), collection('smoke'))
  write(
    path.join(suite, 'services', 'billing', 'collections', 'invoices.yml'),
    collection('invoices')
  )
  write(path.join(suite, 'services', 'search', 'collections', 'query.yml'), collection('query'))

  // Told no: the folder picked, and nothing inside it.
  const declined = await addFrom(suite, false)
  await expect(page.getByRole('region', { name: 'Project suite', exact: true })).toBeVisible()
  expect(declined()).toBe(
    'suite is a project, and holds 2 more: services/billing, services/search. Add them too?'
  )
  await expect(projects()).toHaveCount(6)

  // Told yes: the rest join it.
  await addFrom(suite)
  await expect(page.locator('.sidebar-status')).toHaveText(
    'Added 2 projects from suite: billing, search. 1 more was here already.'
  )
  await expect(projects()).toHaveCount(8)
})
