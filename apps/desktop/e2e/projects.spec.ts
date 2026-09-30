import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { sizeWindow } from './window'

/**
 * A project's own things: new directories and collections, `project.yml` and
 * the global project it uses — whose variables and environments a send uses.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let shared: string
let server: http.Server
let received: string[] = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-projects-')))
  const repo = path.join(tmp, 'platform')
  shop = path.join(repo, 'services', 'shop')
  shared = path.join(repo, 'shared')
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  write(
    path.join(shop, 'collections', 'smoke.yml'),
    ['id: smoke', 'steps:', `  - GET: "${origin}/{{path}}/{{region}}/{{owner}}"`, ''].join('\n')
  )
  write(path.join(shared, 'project.yml'), 'name: Shared\nvars:\n  owner: platform\n')
  write(path.join(shared, 'environments', 'demo.yml'), 'name: demo\nvars:\n  path: shared-path\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, shop)
  await page.getByRole('button', { name: '+ Project' }).click()
  await expect(page.getByRole('region', { name: 'Project shop' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A file's text, or nothing yet. */
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

const project = () => page.getByRole('region', { name: 'Project shop' })
const projectMenu = async (item: string) => {
  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}
const send = async () => {
  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
}

test('a new directory shows at once, empty', async () => {
  await projectMenu('New directory')
  await page.getByLabel('New directory name').fill('a:b')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('cannot contain')
  await page.getByLabel('New directory name').fill('Orders')
  await page.keyboard.press('Enter')

  await expect(project().locator('.group-row .label')).toHaveText(['Orders'])
  await expect(project()).toContainText('No collections yet')
  expect(fs.statSync(path.join(shop, 'collections', 'Orders')).isDirectory()).toBe(true)
})

test('a new collection is written in its directory and opened', async () => {
  await projectMenu('New collection')
  await page.getByLabel('Directory').selectOption('Orders')
  // An id is its file name, so it cannot have a space.
  await page.getByLabel('New collection id').fill('Place order')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toContainText('An id is letters, digits and - _ .')
  await page.getByLabel('New collection id').fill('place-order')
  await page.keyboard.press('Enter')

  await expect(page.locator('.collection-header h1')).toHaveText('place-order')
  expect(fs.readFileSync(path.join(shop, 'collections', 'Orders', 'place-order.yml'), 'utf8')).toBe(
    'id: place-order\nsteps: []\n'
  )
  await expect(project().locator('.collection-row')).toHaveText(['place-order', 'smoke'])
})

test('project settings write project.yml, with uses written with /', async () => {
  await projectMenu('Project settings')
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  // Typed the Windows way; written the way every platform reads.
  await drawer.getByLabel('Global project').fill('..\\..\\shared')
  const own = drawer.getByRole('group', { name: 'Project variables' })
  await own.getByLabel('Variable name').last().fill('region')
  await own.getByLabel('Value of region').fill('eu')
  await expect
    .poll(() => read(path.join(shop, 'project.yml')), { timeout: 5_000 })
    .toBe('uses: ../../shared\nvars:\n  region: eu\n')
  await expect(drawer).toContainText('Now: Shared')
  await drawer.getByRole('button', { name: 'Close' }).click()
  // Linking a global project leaves its own file alone.
  expect(read(path.join(shared, 'project.yml'))).toBe('name: Shared\nvars:\n  owner: platform\n')
  await expect(project().locator('.uses-badge')).toHaveText('uses Shared')
})

test('a send uses the global project’s variables and shared environment', async () => {
  await project().locator('.collection-row', { hasText: 'Smoke' }).click()
  await page.getByLabel('Environment', { exact: true }).selectOption('demo')
  await send()
  expect(received).toEqual(['/shared-path/eu/platform'])
})

test('a shared environment is marked, and editing it edits the global project', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  const drawer = page.getByRole('dialog', { name: 'Environments' })
  await expect(
    drawer.getByRole('navigation', { name: 'Environment files' }).getByRole('button', {
      name: /demo/
    })
  ).toContainText('shared')
  await expect(drawer.getByRole('note')).toContainText('every project that uses it')

  await drawer.getByLabel('Value of path').fill('edited')
  await expect
    .poll(() => fs.readFileSync(path.join(shared, 'environments', 'demo.yml'), 'utf8'), {
      timeout: 5_000
    })
    .toBe('name: demo\nvars:\n  path: edited\n')
  await drawer.getByRole('button', { name: 'Close' }).click()
  await send()
  expect(received).toEqual(['/edited/eu/platform'])
})

test('the project’s own environment of the same name wins, key by key', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  const drawer = page.getByRole('dialog', { name: 'Environments' })
  await drawer.getByRole('button', { name: '+ New environment' }).click()
  await drawer.getByLabel('New environment name').fill('demo')
  await drawer.getByRole('button', { name: 'Create' }).click()
  // The new file is the one open: the project's own, not the shared one.
  await expect(drawer.locator('.env-list > button[aria-current="true"]')).toHaveText('demo')
  await expect(drawer.getByRole('note')).toHaveCount(0)
  await drawer.getByLabel('Variable name').last().fill('path')
  await drawer.getByLabel('Value of path').fill('own')
  await expect
    .poll(() => read(path.join(shop, 'environments', 'demo.yml')), { timeout: 5_000 })
    .toBe('name: demo\nvars:\n  path: own\n')
  await drawer.getByRole('button', { name: 'Close' }).click()

  // Still one "demo" to choose.
  await expect(page.getByLabel('Environment', { exact: true }).locator('option')).toHaveText([
    'No environment',
    'demo'
  ])
  await send()
  expect(received).toEqual(['/own/eu/platform'])
})

test('shared variables are edited in place, for every project using them', async () => {
  await projectMenu('Project settings')
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  const sharedVars = drawer.getByRole('group', { name: 'Shared variables' })
  await expect(drawer.getByRole('note')).toContainText('applies to every project that uses it')
  await expect(sharedVars.getByLabel('Value of owner')).toHaveValue('platform')

  await sharedVars.getByLabel('Value of owner').fill('payments-team')
  await expect
    .poll(() => read(path.join(shared, 'project.yml')), { timeout: 5_000 })
    .toBe('name: Shared\nvars:\n  owner: payments-team\n')
  // This project's own file is untouched.
  expect(read(path.join(shop, 'project.yml'))).toBe('uses: ../../shared\nvars:\n  region: eu\n')
  await drawer.getByRole('button', { name: 'Close' }).click()
  await send()
  expect(received).toEqual(['/own/eu/payments-team'])
})

test('a project variable of the same name overrides the shared one', async () => {
  await projectMenu('Project settings')
  const own = page
    .getByRole('dialog', { name: 'Project settings' })
    .getByRole('group', { name: 'Project variables' })
  await own.getByLabel('Variable name').last().fill('owner')
  await own.getByLabel('Value of owner').fill('mine')
  await expect
    .poll(() => read(path.join(shop, 'project.yml')), { timeout: 5_000 })
    .toBe('uses: ../../shared\nvars:\n  region: eu\n  owner: mine\n')
  await page.getByRole('button', { name: 'Close' }).click()
  await send()
  expect(received).toEqual(['/own/eu/mine'])
})
