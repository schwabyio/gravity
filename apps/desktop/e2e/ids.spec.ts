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
import { sizeWindow } from './window'

/**
 * A collection's `id` is its file name, unique in `collections/` ignoring case
 * (SPEC.md §2). The app marks a file that breaks the rule, offers to fix an id
 * that is not the file name, and refuses to create one that is taken.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let repo: string
let app: ElectronApplication
let page: Page

const collection = (id: string) =>
  [`id: ${id}`, 'steps:', '  - name: browse', '    GET: /browse', ''].join('\n')

const write = (relative: string, text: string) => {
  const file = path.join(repo, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-ids-')))
  repo = path.join(tmp, 'shop-api')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  // Renamed on disk without its id following.
  write('collections/renamed.yml', collection('old-name'))
  // One id, twice: two directories, two cases.
  write('collections/checkout/login.yml', collection('login'))
  write('collections/admin/Login.yml', collection('Login'))

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, repo)
  await page.getByRole('button', { name: '+ Project' }).click()
  await page.waitForSelector('.collection-row')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const row = (id: string) => page.locator('.collection-row', { hasText: new RegExp(`^${id}`) })
const banner = () => page.locator('.id-banner')

test('an id that is not the file name is marked, and fixed in one click', async () => {
  await expect(row('renamed').locator('.problem')).toBeVisible()
  await row('renamed').click()
  await expect(banner()).toContainText('id: old-name does not match the file name, renamed.yml')

  await banner().getByRole('button', { name: 'Set id to renamed' }).click()
  const file = path.join(repo, 'collections', 'renamed.yml')
  await expect
    .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 5_000 })
    .toMatch(/^id: renamed\n/)
  await expect(banner()).toHaveCount(0, { timeout: 5_000 })
  await expect(row('renamed').locator('.problem')).toHaveCount(0)
})

test('an id two files share is marked on both, with no fix to offer', async () => {
  for (const id of ['login', 'Login']) {
    await expect(
      page.locator('.collection-row', { hasText: id }).first().locator('.problem')
    ).toBeVisible()
  }
  await page
    .locator('.collection-row')
    .filter({ hasText: /^login/ })
    .click()
  await expect(banner()).toContainText('id: login is also the id of collections/admin/Login.yml')
  await expect(banner().getByRole('button')).toHaveCount(0)
})

test('a new collection with an id already taken is refused', async () => {
  await page.getByRole('button', { name: 'Project actions for shop-api' }).click()
  await page.getByRole('menuitem', { name: 'New collection' }).click()
  await page.getByLabel('New collection id').fill('RENAMED')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'already has the id' })).toContainText(
    'collections/renamed.yml already has the id RENAMED'
  )
  // Listed, not stat'd: on macOS and Windows RENAMED.yml would find renamed.yml.
  expect(fs.readdirSync(path.join(repo, 'collections'))).not.toContain('RENAMED.yml')
})
