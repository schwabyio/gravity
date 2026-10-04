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
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * "Open in …": the external editor App settings name, and every place a file
 * opens in it — at the step or the script's line where there is one.
 *
 * The editor is a custom command that runs a small script recording what it
 * was given, so nothing real is started and every opening can be checked.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let recorded: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-editor-')))
  recorded = path.join(tmp, 'opened.jsonl')
  fs.writeFileSync(
    path.join(tmp, 'record.cjs'),
    `require('node:fs').appendFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`
  )
  shop = path.join(tmp, 'shop')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), `${lines.join('\n')}\n`)
  }
  write('project.yml', ['name: shop'])
  write('checks/ids.js', ['export function ok() {', '  gta.expectResponseStatusCodeToBe(200)', '}'])
  write('requests/login.yml', [
    'id: login',
    'params:',
    '  user: alice',
    'steps:',
    `  - GET: "${origin}/login"`
  ])
  write('environments/local.yml', ['vars:', '  a: 1'])
  write('collections/orders.csv', ['id', '1', '2'])
  write('collections/orders.yml', [
    'id: orders', // 1
    'tests: |', // 2
    '  checks.ids.ok()', // 3
    'steps:', // 4
    '  - name: list', // 5
    `    GET: "${origin}/list"`, // 6
    '  - name: broken', // 7
    `    GET: "${origin}/broken"`, // 8
    '    tests: |', // 9
    '      gta.expectResponseStatusCodeToBe(200)', // 10
    '      notDefined()' // 11
  ])

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row', { hasText: 'orders' }).click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** What the editor was last given: the file and the line, as the command named them. */
const lastOpened = () => {
  if (!fs.existsSync(recorded)) return null
  const lines = fs.readFileSync(recorded, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as string[]
}
const opened = (file: string, line: number) => [path.join(shop, file), String(line)]
const label = 'Open in editor'

test('App settings choose a custom command, and Test opens the app’s settings file with it', async () => {
  await page.getByRole('button', { name: 'App settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'App settings' })
  const editor = dialog.getByLabel('Open files in')
  await expect(editor).toHaveValue('system')
  await editor.selectOption('custom')
  await dialog
    .getByLabel('Command')
    .fill(`"${process.execPath}" "${path.join(tmp, 'record.cjs')}" {file} {line}`)
  await dialog.getByRole('button', { name: 'Test' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Opened the app’s settings.json.')
  await expect.poll(lastOpened).toEqual([path.join(tmp, 'ud', 'settings.json'), '1'])
  await dialog.getByRole('button', { name: 'Close settings' }).click()

  // Kept, as every setting is.
  const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'ud', 'settings.json'), 'utf8'))
  expect(settings.editor.kind).toBe('custom')
})

test('the collection header opens its file at the selected step', async () => {
  await page.locator('.step-open', { hasText: 'broken' }).click()
  await page.getByRole('button', { name: `${label}: orders.yml, at broken` }).click()
  await expect.poll(lastOpened).toEqual(opened('collections/orders.yml', 7))
})

test('a collection’s, a request set’s and the project’s menus open their files', async () => {
  const row = page.locator('.collection-item', { hasText: 'orders' })
  await row.locator('.collection-row').click({ button: 'right' })
  await page.getByRole('menuitem', { name: label }).click()
  await expect.poll(lastOpened).toEqual(opened('collections/orders.yml', 1))

  await page.locator('.collection-item', { hasText: 'login' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: label }).click()
  await expect.poll(lastOpened).toEqual(opened('requests/login.yml', 1))

  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: `${label}: project.yml` }).click()
  await expect.poll(lastOpened).toEqual(opened('project.yml', 1))
})

test('the scripts pane opens a shared script at its line, and a check file', async () => {
  await page.locator('.step-open', { hasText: 'list' }).click()
  const scripts = page.locator('.scripts-pane')
  await scripts.getByRole('button', { name: `${label}: the collection’s tests` }).click()
  await expect.poll(lastOpened).toEqual(opened('collections/orders.yml', 3))
  await scripts.getByRole('button', { name: `${label}: checks/ids.js` }).click()
  await expect.poll(lastOpened).toEqual(opened('checks/ids.js', 1))
})

test('a script that stopped opens at the line it stopped on', async () => {
  await page.locator('.step-open', { hasText: 'broken' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  const banner = page.locator('.test-results .script-error')
  await expect(banner).toContainText('Tests stopped at line 2')
  await banner.getByRole('button', { name: `${label} at line 2` }).click()
  await expect.poll(lastOpened).toEqual(opened('collections/orders.yml', 11))
})

test('the data and environment drawers open the file they show', async () => {
  await page.locator('.collection-header .data-badge').click()
  const data = page.getByRole('dialog', { name: 'Data file' })
  // Beside the file's name, not the drawer's close.
  await data
    .locator('.drawer-head h2')
    .getByRole('button', { name: `${label}: orders.csv` })
    .click()
  await expect.poll(lastOpened).toEqual(opened('collections/orders.csv', 1))
  await data.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('button', { name: 'Edit environments' }).click()
  const environments = page.getByRole('dialog', { name: 'Environments' })
  // With the chosen environment, beside its file — not in the drawer's head.
  await expect(
    environments.locator('.drawer-head').getByRole('button', { name: /^Open in/ })
  ).toHaveCount(0)
  await environments
    .locator('.env-detail')
    .getByRole('button', { name: `${label}: local.yml` })
    .click()
  await expect.poll(lastOpened).toEqual(opened('environments/local.yml', 1))
  await environments.getByRole('button', { name: 'Close', exact: true }).click()
})

test('an editor that will not start says why, in the status bar, until dismissed', async () => {
  await page.getByRole('button', { name: 'App settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'App settings' })
  await dialog.getByLabel('Command').fill(path.join(tmp, 'no-such-editor'))
  await dialog.getByLabel('Command').press('Enter')
  await dialog.getByRole('button', { name: 'Close settings' }).click()

  await page.getByRole('button', { name: `${label}: orders.yml, at broken` }).click()
  const message = page.locator('.status-bar .status-message')
  await expect(message).toContainText('Open in editor failed: Could not start')
  await message.getByRole('button', { name: 'Dismiss' }).click()
  await expect(message).toHaveCount(0)
})
