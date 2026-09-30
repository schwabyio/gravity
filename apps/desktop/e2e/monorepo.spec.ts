import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * + Monorepo: search a folder and add every project in it — each folder with a
 * collections/, and the global project they use — in one go.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-monorepo-')))
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

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const addFrom = async (folder: string) => {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, folder)
  await page.getByRole('button', { name: '+ Monorepo' }).click()
}
const projects = () => page.locator('.sidebar section.project')

test('adds every project in a monorepo, and the shared project they use, at once', async () => {
  await addFrom(platform)
  await expect(page.locator('.sidebar-status')).toHaveText(
    'Added 3 projects from platform: auth, users, Shared.'
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

test('a folder with no projects in it says what a project is', async () => {
  await addFrom(path.join(tmp, 'empty'))
  await expect(page.locator('.sidebar-error')).toContainText(
    'No projects in empty: a project is a folder holding collections/.'
  )
  await expect(projects()).toHaveCount(3)
})

test('+ Project on a monorepo’s root offers the projects in it, and adds them all', async () => {
  const other = path.join(tmp, 'other')
  write(path.join(other, 'apps', 'web', 'collections', 'home.yml'), collection('home'))
  write(path.join(other, 'apps', 'admin', 'collections', 'users.yml'), collection('users'))
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void dialog.accept()
  })
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, other)
  await page.getByRole('button', { name: '+ Project' }).click()
  await expect(page.locator('.sidebar-status')).toHaveText(
    'Added 2 projects from other: admin, web.'
  )
  expect(asked).toBe(
    'other is not a project, but holds 2 projects: apps/admin, apps/web. Add them all?'
  )
  await expect(projects()).toHaveCount(5)
  expect(fs.existsSync(path.join(other, 'collections'))).toBe(false)
})
