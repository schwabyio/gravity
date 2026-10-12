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
 * Wait steps (SPEC.md §2.1): added from a step's ⋯ or a list's +, written as
 * milliseconds or a {{variable}}, and run by Send and Run all, counting down,
 * with Cancel cutting one short.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page
/** What the server was sent, in order. */
let received: string[] = []

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-wait-')))
  const repo = path.join(tmp, 'orders-api')
  file = path.join(repo, 'collections', 'orders.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: orders',
      'vars:',
      '  pause: 300',
      'steps:',
      '  - name: create order',
      `    POST: "${origin}/orders"`,
      '  - name: search',
      `    GET: "${origin}/search"`,
      ''
    ].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const openStep = (name: string) => page.locator('.step-open', { hasText: name }).click()
const waitRow = () => page.locator('.step-list li', { has: page.locator('.method.m-wait') })
const field = () => page.getByLabel('Milliseconds to wait')
const status = () => page.getByRole('region', { name: 'Wait', exact: true })

test('a wait is added below a step from its ⋯, and written as milliseconds', async () => {
  await openStep('create order')
  await page.getByRole('button', { name: 'More actions for create order' }).click()
  await page.getByRole('menuitem', { name: 'Add wait below' }).click()
  await expect(waitRow().locator('.step-name')).toHaveText('wait 1 s')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('/orders"\n  - wait: 1000\n  - name: search\n')
  // It sends nothing: no request editor, response or scripts, just how long and its docs.
  await expect(field()).toHaveValue('1000')
  await expect(page.locator('.wait-reading')).toHaveText('1 s')
  await expect(page.locator('.request-pane')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Scripts' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Step docs' })).toBeVisible()
  await expect(page.locator('.collection-step .method')).toHaveText('WAIT')
  // A flag chip as any step has; a wait is never repeated for each item.
  await expect(page.locator('.wait-bar .step-flag-chip')).toHaveText('+ flag')
  await expect(page.locator('.step-repeat-chip')).toHaveCount(0)

  await field().fill('1500')
  await expect(page.locator('.wait-reading')).toHaveText('1.5 s')
  await expect(waitRow().locator('.step-name')).toHaveText('wait 1.5 s')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - wait: 1500\n')
})

test('says what is wrong with a wait that is no wait, and keeps it from being sent', async () => {
  await field().fill('2s')
  await expect(page.locator('.wait-problem')).toHaveText(
    'wait: 2s is not a number of milliseconds; write it as wait: 2000, or a {{variable}} holding one (SPEC.md §2.1)'
  )
  await expect(page.locator('.wait-bar .send')).toBeDisabled()
  await field().fill('900000')
  await expect(page.locator('.wait-problem')).toContainText('longer than a wait can be')
  // The file keeps the last wait that was one, with nothing to save meanwhile.
  await expect(page.locator('.save-status')).toHaveText('Saved')
  expect(onDisk()).toContain('  - wait: 1500\n')
  await expect(waitRow().locator('.step-name')).toHaveText('wait 1.5 s')

  // A {{variable}} is kept as written, and read in words from its value now.
  await field().fill('{{pause}}')
  await expect(page.locator('.wait-problem')).toHaveCount(0)
  await expect(page.locator('.wait-reading')).toHaveText('300 ms')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - wait: "{{pause}}"\n')
  await expect(waitRow().locator('.step-name')).toHaveText('wait {{pause}}')
})

test('Send waits, counting down, and Cancel cuts a wait short', async () => {
  await field().fill('1200')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - wait: 1200\n')
  received = []
  await page.locator('.wait-bar .send').click()
  await expect(page.locator('.wait-bar .send')).toHaveText('Waiting…')
  await expect(status()).toContainText(/Waiting · \d\.\d s left/)
  await expect(waitRow().locator('.step-summary')).toHaveText(/\d\.\d s left/)
  await expect(status()).toContainText(/Waited 1\.\d\d s/, { timeout: 5_000 })
  await expect(waitRow().locator('.step-summary')).toHaveText(/waited 1\.\d\d s/)
  // Nothing was sent, and nothing marked passed: there was nothing to check.
  expect(received).toEqual([])
  await expect(waitRow().locator('.step-mark')).toHaveCount(0)

  await field().fill('60000')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - wait: 60000\n')
  await page.locator('.wait-bar .send').click()
  await expect(status()).toContainText('Waiting ·')
  await page.locator('.wait-bar').getByRole('button', { name: 'Cancel' }).click()
  await expect(status()).toContainText(/Wait cancelled after .+ of 1 min/)
  await expect(waitRow().locator('.step-mark')).toHaveAttribute('aria-label', 'error')
})

test('Run all waits between the steps around it, and a list’s + adds one at its end', async () => {
  await field().fill('300')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - wait: 300\n')
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('3 passed', { timeout: 10_000 })
  expect(received).toEqual(['POST /orders', 'GET /search'])
  await expect(waitRow().locator('.step-summary')).toHaveText(/waited 3\d\d ms/)

  await page.getByRole('button', { name: 'Add to steps' }).click()
  await page.getByRole('menuitem', { name: 'Add wait', exact: true }).click()
  await expect.poll(onDisk, { timeout: 5_000 }).toMatch(/\/search"\n {2}- wait: 1000\n$/)
  await expect(waitRow()).toHaveCount(2)
})
