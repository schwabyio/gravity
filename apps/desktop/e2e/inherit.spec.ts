import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import YAML from 'yaml'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Inheritance: an endpoint's base — headers and checks every request to it
 * gets, its checks giving way to a step's own — and a collection extending a
 * base collection.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let server: http.Server
let received: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers })
    const id = /^\/users\/([^/?]+)/.exec(req.url ?? '')?.[1]
    res.writeHead(id === '404' ? 404 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(id === '404' ? { error: 'no such user' } : { id }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-inherit-')))
  shop = path.join(tmp, 'shop')
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), body)
  }
  write(
    'endpoints/users.yml',
    [
      'id: users',
      'steps:',
      '  - GET: /users/{id}',
      '    headers:',
      '      Accept: application/json',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      "      gta.expectResponseBodyToHaveProperty('id', endpoint.id)",
      ''
    ].join('\n')
  )
  write(
    'bases/auth.yml',
    ['id: auth', 'headers:', '  Authorization: Bearer {{token}}', 'vars:', '  token: t1', ''].join(
      '\n'
    )
  )
  write(
    'collections/users.yml',
    [
      'id: users',
      'vars:',
      `  baseUrl: "${origin}"`,
      '  userId: "42"',
      'steps:',
      '  - name: get user',
      '    GET: "{{baseUrl}}/users/{{userId}}"',
      '  - name: missing user',
      '    GET: "{{baseUrl}}/users/404"',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(404)',
      "      gta.expectResponseBodyToHaveProperty('id', '', 'notThisExpectedKey')",
      ''
    ].join('\n')
  )
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 900 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row', { hasText: 'Users' }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const file = () => YAML.parse(fs.readFileSync(path.join(shop, 'collections', 'users.yml'), 'utf8'))
// The endpoint note itself: the scripts pane beside it names the endpoint base too.
const note = () => page.locator('.endpoint-note')
const openStep = (name: string) => page.locator('.step-open', { hasText: name }).click()

test('a step says which endpoint base its request is under, and what it adds', async () => {
  await expect(page.locator('.endpoint-note')).toContainText(
    'Endpoint base GET /users/{id} — adds headers Accept and checks.'
  )
  await expect(
    page.getByRole('group', { name: 'Endpoints of shop' }).locator('.set-row')
  ).toHaveText(['users'])
  await expect(page.getByRole('group', { name: 'Bases of shop' }).locator('.set-row')).toHaveText([
    'auth'
  ])
})

test('Run all: the base’s headers and checks, a step’s own check replacing the base’s', async () => {
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('2 passed', { timeout: 10_000 })
  expect(received.map((request) => request.headers['accept'])).toEqual([
    'application/json',
    'application/json'
  ])
  await openStep('get user')
  await expect(page.locator('.test-results .check')).toHaveCount(2)
  await openStep('missing user')
  // 404 and no id: the step's two checks, in place of the base's 200 and id.
  await expect(page.locator('.test-results .check')).toHaveCount(2)
  await expect(page.locator('.test-results .check.fail')).toHaveCount(0)
})

test('a step can leave its endpoint base out, and take it back', async () => {
  await openStep('get user')
  const show = page.getByRole('button', { name: 'Show the request editor' })
  if (await show.isVisible()) await show.click()
  await page.getByRole('button', { name: 'Don’t use it here' }).click()
  await expect.poll(() => file().steps[0].base, { timeout: 5_000 }).toBe(false)
  await expect(page.locator('.endpoint-note')).toContainText('Not using the endpoint base')

  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received[0]?.headers['accept']).not.toBe('application/json')

  await page.getByRole('button', { name: 'Use it' }).click()
  await expect.poll(() => 'base' in file().steps[0], { timeout: 5_000 }).toBe(false)
  await expect(note()).toBeVisible()
})

test('a collection extends a base collection, set in its settings', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await drawer.getByLabel('Base collection').selectOption('auth')
  await expect.poll(() => file().extends, { timeout: 5_000 }).toBe('auth')
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()

  received = []
  await openStep('get user')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received[0]?.headers['authorization']).toBe('Bearer t1')
})

test('an endpoints file is made in the app, and its endpoints added like steps', async () => {
  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New endpoints file' }).click()
  await page.getByLabel('New endpoints file id').fill('orders')
  await page.keyboard.press('Enter')
  const orders = path.join(shop, 'endpoints', 'orders.yml')
  await expect.poll(() => fs.existsSync(orders)).toBe(true)

  await page.getByRole('group', { name: 'Endpoints of shop' }).getByText('orders').click()
  await expect(page.locator('.hint.empty')).toContainText('No endpoints yet')
  await page.getByRole('button', { name: '+ Add endpoint' }).click()
  await expect
    .poll(() => YAML.parse(fs.readFileSync(orders, 'utf8')).steps, { timeout: 5_000 })
    .toEqual([{ GET: '/path/{id}' }])
  // An endpoint is not under a base itself.
  await expect(page.locator('.endpoint-note')).toHaveCount(0)
})
