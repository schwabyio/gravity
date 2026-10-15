import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Starting a collection fresh: ↺ Reset, or closing it with ×, clears what its
 * Sends and runs left — results, the run's summary, the variables they carry,
 * the connections they hold. Opening another and coming back keeps them.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let server: http.Server
let app: ElectronApplication
let page: Page
/** How many times the slow step's request has reached the server. */
let slowAsked = 0

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      // Slow enough to close the collection while it is still being answered.
      if (req.url === '/slow') slowAsked++
      const delay = req.url === '/slow' ? 2_000 : 0
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'tok-1' }))
      }, delay)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-fresh-')))
  const repo = path.join(tmp, 'shop')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), [...lines, ''].join('\n'))
  }
  write('collections/orders.yml', [
    'id: orders',
    'stepTags: true',
    'steps:',
    '  - name: login',
    `    POST: "${origin}/login"`,
    '    tags: [smoke]',
    "    tests: gta.set('authToken', res.body.token)",
    '  - name: get orders',
    `    GET: "${origin}/orders"`,
    '  - name: slow',
    `    GET: "${origin}/slow"`
  ])
  write('collections/other.yml', ['id: other', 'steps:', '  - name: ping', `    GET: "${origin}/"`])

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await openCollection('orders')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const reset = () => page.getByRole('button', { name: '↺ Reset' })
// Each result's status and time, under a step that has one.
const marks = () => page.locator('.step-list .step-summary')
const summary = () => page.locator('.run-summary')
const variablesButton = () =>
  page.locator('.status-bar').getByRole('button', { name: /^Variables/ })
const selected = () => page.locator('.step-list > li.selected .step-name')
const smoke = () =>
  page.getByRole('group', { name: 'Filter steps by tag' }).getByRole('button', { name: 'smoke' })

async function openCollection(name: string) {
  await page.locator('.collection-row', { hasText: name }).click()
  await expect(page.locator('.collection-header h1')).toHaveText(name)
}

async function send(step: string) {
  await page.locator('.step-open', { hasText: step }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })
}

test('Reset sits beside Run all, with nothing to clear until something is sent', async () => {
  await expect(reset()).toBeDisabled()
  await reset().hover({ force: true })
  await expect(page.getByRole('tooltip')).toHaveText(
    'Clear this collection’s results, carried variables and open connections, as closing it does'
  )
  await page.mouse.move(0, 0)
})

test('opening another collection and coming back keeps what its Sends left', async () => {
  await send('login')
  await expect(marks()).toHaveCount(1)
  await expect(variablesButton()).toHaveAccessibleName('Variables, 1 set')
  await expect(reset()).toBeEnabled()

  await openCollection('other')
  await openCollection('orders')
  await expect(marks()).toHaveCount(1)
  await expect(variablesButton()).toHaveAccessibleName('Variables, 1 set')
  await expect(selected()).toHaveText('login')
})

test('Reset clears the results and the variables, and leaves the collection open where it was', async () => {
  await reset().click()
  await expect(marks()).toHaveCount(0)
  await expect(variablesButton()).toHaveAccessibleName('Variables')
  await expect(reset()).toBeDisabled()
  await expect(selected()).toHaveText('login')
})

test('closed with ×, it opens again fresh: no results or summary, its first step, no filter', async () => {
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(summary()).toBeVisible({ timeout: 30_000 })
  await expect(marks()).toHaveCount(3)
  await expect(variablesButton()).toHaveAccessibleName('Variables, 1 set')
  await page.locator('.step-open', { hasText: 'get orders' }).click()
  await smoke().click()
  await expect(smoke()).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Close the collection' }).click()
  await expect(page.locator('.collection-header')).toHaveCount(0)
  await openCollection('orders')
  await expect(marks()).toHaveCount(0)
  await expect(summary()).toHaveCount(0)
  await expect(variablesButton()).toHaveAccessibleName('Variables')
  await expect(smoke()).toHaveAttribute('aria-pressed', 'false')
  await expect(selected()).toHaveText('login')
  await expect(reset()).toBeDisabled()
})

test('closed while a Send is answered, nothing of it comes back', async () => {
  const asked = slowAsked
  await page.locator('.step-open', { hasText: 'slow' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => slowAsked).toBe(asked + 1)
  await page.getByRole('button', { name: 'Close the collection' }).click()

  await openCollection('orders')
  // The cancelled Send is done once Send is back.
  await page.locator('.step-open', { hasText: 'slow' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })
  await expect(marks()).toHaveCount(0)
  await expect(page.locator('.placeholder.error')).toHaveCount(0)
  await expect(reset()).toBeDisabled()
})
