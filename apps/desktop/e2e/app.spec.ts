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
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * End-to-end proof that the whole chain works: renderer -> preload -> main ->
 * utility process -> undici -> back. Runs against a local server so it never
 * needs the network.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let server: http.Server
let origin: string
let app: ElectronApplication
let page: Page

/** A one-pixel PNG: a body whose bytes are not text. */
const DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const requestPane = () => page.locator('.request-pane')
const responsePane = () => page.locator('.panes > section.pane:not(.request-pane)')

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late')
      }, 5_000)
      return
    }
    if (req.url === '/dot.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(DOT_PNG, 'base64'))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', url: req.url, probe: req.headers['x-probe'] ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-app-')))
  const repo = path.join(tmp, 'r')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  const file = path.join(repo, 'collections', 'probe.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: probe',
      'steps:',
      '  - name: ping',
      `    GET: "${origin}/ping"`,
      '  - name: slow',
      `    GET: "${origin}/slow"`,
      ''
    ].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('with no collection open, the pane says so rather than showing a blank request', async () => {
  // Nothing is open at launch, and there is no request form waiting to be filled.
  const fresh = await electron.launch({
    args: [MAIN, `--user-data-dir=${path.join(tmp, 'fresh')}`]
  })
  const freshPage = await fresh.firstWindow()
  await freshPage.waitForSelector('.sidebar')

  await expect(freshPage.locator('.placeholder')).toHaveText(
    'Choose a collection to see its steps.'
  )
  await expect(freshPage.getByLabel('Request URL')).toHaveCount(0)
  // The buttons that used to sit beside the title are gone.
  await expect(freshPage.getByRole('button', { name: 'New' })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: 'Save' })).toHaveCount(0)

  await fresh.close()
})

test('sends a request and renders the response', async () => {
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.status-pill')).toHaveText('200 OK')
  await expect(responsePane().locator('.response-body')).toContainText('"status": "ok"')

  await responsePane()
    .getByRole('button', { name: /^Headers/ })
    .click()
  await expect(responsePane().locator('.kv.readonly')).toContainText('content-type')

  await responsePane().getByRole('button', { name: 'Timings' }).click()
  await expect(responsePane().locator('.kv.readonly')).toContainText('Time to first byte')
})

test('sends request headers the user adds', async () => {
  // A response put the editor aside; opened by hand, it stays open from here on.
  await page.getByRole('button', { name: 'Show the request editor' }).click()
  await requestPane()
    .getByRole('button', { name: /^Headers/ })
    .click()
  await requestPane().getByPlaceholder('Name').first().fill('X-Probe')
  await requestPane().getByPlaceholder('Value').first().fill('from-e2e')

  await page.getByRole('button', { name: 'Send' }).click()

  await responsePane().getByRole('button', { name: 'Body' }).click()
  await expect(page.locator('.status-pill')).toHaveText('200 OK')
  await expect(responsePane().locator('.response-body')).toContainText('"probe": "from-e2e"')
})

test('query parameters and the URL stay in sync', async () => {
  await page.getByLabel('Request URL').fill(`${origin}/search`)
  await requestPane()
    .getByRole('button', { name: /^Params/ })
    .click()

  await requestPane().getByPlaceholder('Name').first().fill('q')
  await requestPane().getByPlaceholder('Value').first().fill('hello world')

  await expect(page.getByLabel('Request URL')).toHaveValue(`${origin}/search?q=hello%20world`)

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(responsePane().locator('.response-body')).toContainText('/search?q=hello%20world')
})

test('shows an image body as the image', async () => {
  await page.getByLabel('Request URL').fill(`${origin}/dot.png`)
  await page.getByRole('button', { name: 'Send' }).click()

  await responsePane().getByRole('button', { name: 'Body' }).click()
  const image = responsePane().locator('.body-image img')
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${DOT_PNG}`)
  // Decoded, not just there: the browser read one pixel.
  await expect(image).toHaveJSProperty('naturalWidth', 1)
  await expect(responsePane().locator('.body-image')).toContainText('image/png · 70 B')
})

test('a slow request can be cancelled', async () => {
  await page.locator('.step-open', { hasText: 'slow' }).click()
  await page.getByRole('button', { name: 'Send' }).click()

  await page.locator('.url-bar').getByRole('button', { name: 'Cancel' }).click()
  await expect(responsePane().locator('.placeholder.error')).toContainText('cancelled', {
    timeout: 15_000
  })
})
