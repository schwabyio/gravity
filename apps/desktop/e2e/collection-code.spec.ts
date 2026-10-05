import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * A collection's variables, pre-request script and tests: edited in its
 * settings drawer, saved in place, and what the next send uses — saved or not.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
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

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-collection-code-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'shop.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    [
      'id: shop',
      'vars:',
      "  apiVersion: '2' # the current API",
      'steps:',
      '  - name: items',
      `    GET: "${origin}/v{{apiVersion}}/{{resource}}?id={{id}}"`,
      ''
    ].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const drawer = () => page.getByRole('dialog', { name: 'Collection settings' })
const drawerTab = (name: string) =>
  drawer().getByRole('navigation', { name: 'Collection settings sections' }).getByRole('button', {
    name
  })
const openDrawer = () => page.getByRole('button', { name: 'Collection settings' }).click()

test('a variable is added with its type, next to the others and their comments', async () => {
  await openDrawer()
  await drawerTab('Variables').click()
  const names = drawer().getByLabel('Variable name')
  await expect(names).toHaveCount(2)
  await expect(names.first()).toHaveValue('apiVersion')

  await names.nth(1).fill('resource')
  await drawer().getByLabel('Value of resource').fill('items')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain("vars:\n  apiVersion: '2' # the current API\n  resource: items\nsteps:")
})

test('a number that is not one is marked, and not written', async () => {
  await drawer().getByLabel('Type of new variable').selectOption('number')
  await drawer().getByLabel('Value of new variable').fill('three')
  await drawer().getByLabel('Variable name').nth(2).fill('retries')
  await expect(drawer().getByRole('alert')).toHaveText('Not a number')
  await page.waitForTimeout(1500)
  expect(onDisk()).not.toContain('retries')

  await drawer().getByLabel('Value of retries').fill('3')
  await expect(drawer().getByRole('alert')).toHaveCount(0)
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  resource: items\n  retries: 3\n')
})

test('the pre-request script and tests are written as blocks before the steps', async () => {
  await drawerTab('Pre-request').click()
  await drawer().getByRole('textbox', { name: 'Collection pre-request script' }).click()
  await page.keyboard.type("gta.set('id', 'abc')")
  await drawerTab('Tests').click()
  await drawer().getByRole('textbox', { name: 'Collection tests' }).click()
  await page.keyboard.type('gta.expectResponseStatusCodeToBe(200)')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain(
      [
        '  retries: 3',
        'before:',
        '  script: |-',
        "    gta.set('id', 'abc')",
        'tests: |-',
        '  gta.expectResponseStatusCodeToBe(200)',
        'steps:'
      ].join('\n')
    )
  await drawer().getByRole('button', { name: 'Close', exact: true }).click()
})

test('a send uses them, and the step says the collection’s scripts run first', async () => {
  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.test-results-summary')).toHaveText(/1 passed/)
  expect(received).toEqual(['/v2/items?id=abc'])

  // The step's scripts are beside the response, whatever the request editor does.
  await page.locator('.scripts-pane .tabs button', { hasText: 'Pre-request' }).click()
  const note = page.getByRole('note', { name: 'Scripts before this step’s' })
  await expect(note).toContainText('Before this step’s script, these run in order:the collection’s')
  await note.getByRole('button', { name: 'Open the collection’s pre-request script' }).click()
  await expect(drawerTab('Pre-request')).toHaveClass(/active/)
  await expect(
    drawer().getByRole('textbox', { name: 'Collection pre-request script' })
  ).toContainText("gta.set('id', 'abc')")
  await page.getByRole('button', { name: 'Close', exact: true }).click()
})

test('with auto save off, a send uses the variables as edited, before they are saved', async () => {
  await page.getByRole('button', { name: 'App settings' }).click()
  await page.getByLabel('Auto save').click()
  await expect(page.getByLabel('Auto save')).not.toBeChecked()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await openDrawer()
  await drawerTab('Variables').click()
  await drawer().getByLabel('Value of apiVersion').fill('3')
  await drawer().getByRole('button', { name: 'Close', exact: true }).click()

  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received).toEqual(['/v3/items?id=abc'])
  expect(onDisk()).toContain("apiVersion: '2'")

  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain("apiVersion: '3' # the current API")
})
