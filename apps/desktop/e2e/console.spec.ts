import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

const { version } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))

/**
 * The console: a Console button at the left of the status bar opens a panel
 * across the bottom of the window with every request any run made, what its
 * scripts wrote and what went wrong, each request a click from its raw text
 * and a copy icon.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const SECRET = 'not-for-anyone-7f3a'

let tmp: string
let origin: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/orders') {
      req.resume()
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"out of stock"}')
      })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":7,"name":"Ada"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-console-')))
  const repo = path.join(tmp, 'shop-api')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), [...lines, ''].join('\n'))
  }
  write('collections/orders.yml', [
    'id: orders',
    'steps:',
    '  - name: get user',
    `    GET: "${origin}/users/7"`,
    '    headers:',
    '      Authorization: "Bearer {{shopToken}}"',
    '    before:',
    '      script: |',
    "        console.log('token', gta.get('shopToken'))",
    '    tests: |',
    '      gta.expectResponseStatusCodeToBe(200)',
    "      console.warn('slow answer')",
    '  - name: create order',
    `    POST: "${origin}/orders"`,
    '    body:',
    `      json: '{"item":"book"}'`,
    '    tests: |',
    '      gta.expectResponseStatusCodeToBe(201)'
  ])
  write('environments/staging.yml', ['vars:', '  shopToken: { secret: true }'])
  write('.env', [`shopToken=${SECRET}`])

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 860 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.getByLabel('Environment', { exact: true }).selectOption('staging')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const consoleButton = () => page.locator('.status-bar').getByRole('button', { name: /^Console/ })
const panel = () => page.getByRole('region', { name: 'Console', exact: true })
const lines = () => panel().locator('.console-row')
const request = (text: string) => panel().locator('.console-row.request', { hasText: text })
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())

test('the status bar has a Console button, and the console starts closed', async () => {
  await expect(consoleButton()).toBeVisible()
  await expect(consoleButton()).toHaveAttribute('aria-expanded', 'false')
  await expect(panel()).toHaveCount(0)
})

test("the status bar shows the app's version at its right", async () => {
  const label = page.locator('.status-bar .status-version')
  await expect(label).toHaveText(`v${version}`)
  const bar = await page.locator('.status-bar').boundingBox()
  const box = await label.boundingBox()
  expect(bar!.x + bar!.width - (box!.x + box!.width)).toBeLessThan(16)
})

test('what a Send did while the console was closed is there when it opens', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200 OK', { timeout: 15_000 })
  // The script's console.warn shows as a warning on the button.
  await expect(consoleButton()).toHaveAccessibleName('Console, 1 warning')

  await consoleButton().click()
  await expect(panel()).toBeVisible()
  await expect(lines()).toHaveCount(3)
  const sent = request('get user')
  await expect(sent).toContainText('GET')
  await expect(sent).toContainText(`${origin}/users/7`)
  await expect(sent).toContainText('200 OK')
  await expect(sent).toContainText('1 check passed')
  await expect(sent).toContainText('orders › get user')
  // What the scripts wrote, each saying which script, a secret's value hidden.
  await expect(lines().nth(1)).toContainText('pre-request')
  await expect(lines().nth(1)).toContainText('token [secret: shopToken]')
  await expect(lines().nth(2)).toHaveClass(/log-warn/)
  await expect(lines().nth(2)).toContainText('slow answer')
  await expect(panel()).not.toContainText(SECRET)
})

test('a request opens to its raw text, and its copy icons put it on the clipboard', async () => {
  await request('get user').locator('button.console-line').click()
  const raw = panel().getByRole('region', { name: 'Raw request' })
  await expect(raw.locator('pre')).toHaveText(
    `GET ${origin}/users/7\nAuthorization: Bearer [secret: shopToken]`
  )
  await expect(panel().getByRole('region', { name: 'Raw response' }).locator('pre')).toContainText(
    '200 OK\ncontent-type: application/json'
  )

  await raw.getByRole('button', { name: 'Copy the request' }).click()
  await expect(raw.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await clipboard()).toBe(`GET ${origin}/users/7\nAuthorization: Bearer [secret: shopToken]`)

  await panel()
    .getByRole('region', { name: 'Raw response' })
    .getByRole('button', { name: 'Copy the response' })
    .click()
  const response = await clipboard()
  expect(response).toMatch(/^200 OK\n/)
  expect(response).toMatch(/\n\n\{"id":7,"name":"Ada"\}$/)

  await panel().getByRole('button', { name: 'Copy the request and response' }).click()
  expect(await clipboard()).toMatch(
    new RegExp(`^GET ${origin.replace(/\./g, '\\.')}/users/7\\n[\\s\\S]*\\n\\n200 OK\\n`)
  )

  await request('get user').locator('button.console-line').click()
  await expect(panel().getByRole('region', { name: 'Raw request' })).toHaveCount(0)
})

test('Run all has a line for its start and its totals, and its failures show', async () => {
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(lines().last()).toContainText('Run all finished', { timeout: 15_000 })
  await expect(lines().last()).toContainText('1 passed · 1 failed')
  await expect(lines().last()).toHaveClass(/run-failed/)
  await expect(panel().locator('.console-row.run').first()).toContainText(
    'Run all · orders · staging'
  )

  const order = request('create order')
  await expect(order).toContainText('POST')
  await expect(order).toContainText('500 Internal Server Error')
  await expect(order).toContainText('1 of 1 checks failed')
  await order.locator('button.console-line').click()
  await expect(panel().getByRole('region', { name: 'Raw request' }).locator('pre')).toContainText(
    `POST ${origin}/orders`
  )
  await expect(panel().getByRole('region', { name: 'Raw request' }).locator('pre')).toContainText(
    '{"item":"book"}'
  )
  await expect(panel().getByRole('list', { name: 'Failed checks' })).toContainText('✕')
})

test('the console filters by kind and by what is typed', async () => {
  const show = panel().getByLabel('Show')
  await show.selectOption('requests')
  await expect(lines()).toHaveCount(3)
  await show.selectOption('logs')
  await expect(panel().locator('.console-row.log')).toHaveCount(4)
  await expect(lines()).toHaveCount(4)
  await show.selectOption('problems')
  // The failed order, and each run's warning.
  await expect(request('create order')).toBeVisible()
  await expect(panel().locator('.console-row.log-warn')).toHaveCount(2)
  await expect(panel().locator('.console-row.run-failed')).toHaveCount(1)

  await show.selectOption('all')
  const filter = panel().getByLabel('Filter the console')
  await filter.fill('POST orders')
  await expect(lines()).toHaveCount(1)
  await filter.fill('no line says this')
  await expect(panel()).toContainText('Nothing here matches the filter.')
  await filter.press('Escape')
  await expect(filter).toHaveValue('')
  await expect(lines()).not.toHaveCount(0)
})

test('Clear empties the console', async () => {
  await panel().getByRole('button', { name: 'Clear' }).click()
  await expect(lines()).toHaveCount(0)
  await expect(panel()).toContainText('Every request a Send or Run all makes shows here')
  await expect(consoleButton()).toHaveAccessibleName('Console')
})

test('the console resizes from its top edge', async () => {
  const before = (await panel().boundingBox())!.height
  const divider = panel().getByRole('separator', { name: 'Resize the console' })
  await divider.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await panel().boundingBox())!.height).toBe(before + 32)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await panel().boundingBox())!.height).toBe(260)
})

test('⌘J closes and opens the console, and a reload opens it as it was left', async () => {
  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel()).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel()).toBeVisible()

  await page.reload()
  await page.waitForSelector('.sidebar')
  await expect(panel()).toBeVisible()
  await panel().getByRole('button', { name: 'Close the console' }).click()
  await expect(panel()).toHaveCount(0)
  await page.reload()
  await page.waitForSelector('.sidebar')
  await expect(consoleButton()).toHaveAttribute('aria-expanded', 'false')
})
