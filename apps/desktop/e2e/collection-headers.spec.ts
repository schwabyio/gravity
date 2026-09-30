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
 * Collection headers: edited in the collection's settings, saved in place with
 * their comments, shown under each step's own, replaced by a step header of the
 * same name in any case, and sent.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let received: http.IncomingHttpHeaders = {}
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received = req.headers
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-headers-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'shop.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    [
      'id: shop',
      'headers:',
      '  Accept: application/json # every step',
      'steps:',
      '  - name: plain',
      `    GET: "${origin}/plain"`,
      '    headers:',
      '      accept: text/plain',
      '  - name: browse',
      `    GET: "${origin}/browse"`,
      ''
    ].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, repo)
  await page.getByRole('button', { name: '+ Project' }).click()
  await page.locator('.collection-row').click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const inherited = () => page.getByRole('region', { name: 'Headers from the collection' })
const drawer = () => page.getByRole('dialog', { name: 'Collection settings' })
const headersTab = () => page.locator('.request-pane .tabs button', { hasText: 'Headers' })
const openStep = (name: string) =>
  page.locator('.step-list li', { hasText: name }).locator('.step-open').click()

test('a step shows the collection’s headers under its own, and which it replaces', async () => {
  await openStep('plain')
  await headersTab().click()
  await expect(inherited().locator('tr')).toHaveText([
    'Acceptapplication/jsonreplaced by this step'
  ])
  await expect(headersTab()).toContainText('1')

  await openStep('browse')
  await expect(inherited().locator('tr')).toHaveText(['Acceptapplication/json'])
  await expect(inherited().locator('tr.unused')).toHaveCount(0)
})

test('a collection header is added in its settings and saved in place', async () => {
  await inherited().getByRole('button', { name: 'Edit the collection’s headers' }).click()
  await expect(drawer()).toBeVisible()
  await drawer().getByPlaceholder('Name').last().fill('X-Client')
  // The blank row became X-Client, and a new blank row followed it.
  await drawer().getByPlaceholder('Value').nth(1).fill('gta')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('headers:\n  Accept: application/json # every step\n  X-Client: gta\nsteps:')
  await page.keyboard.press('Escape')
  await expect(drawer()).toHaveCount(0)
  await expect(inherited().locator('tr')).toHaveText(['Acceptapplication/json', 'X-Clientgta'])
})

test('a send carries the collection’s headers, with the step’s replacing its own', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received['accept']).toBe('application/json')
  expect(received['x-client']).toBe('gta')

  await openStep('plain')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received['accept']).toBe('text/plain')
  expect(received['x-client']).toBe('gta')
})

test('removing every collection header removes the key', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const remove = drawer().getByRole('button', { name: 'Remove row' })
  await remove.first().click()
  await remove.first().click()
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('X-Client')
  expect(onDisk()).toMatch(/^id: shop\nsteps:/)
  await page.keyboard.press('Escape')
  await expect(inherited()).toHaveCount(0)
})
