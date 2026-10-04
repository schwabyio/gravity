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
import { addProject } from './addProject'

/**
 * A `text/event-stream` response: read until the server closes it or a
 * setting stops it, shown as its events with the checks marked on them, and
 * the stream as sent a click away (SPEC.md §2.3, §3).
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (req.url === '/prices') {
      // Open until the client goes: one event now, then one every 50ms.
      res.write('event: subscribed\ndata: {"symbol":"ACME"}\n\n')
      let price = 100
      const every = setInterval(
        () => res.write(`event: price\ndata: {"symbol":"ACME","price":${price++}}\n\n`),
        50
      )
      res.on('close', () => clearInterval(every))
      return
    }
    // An answer streamed to a POST, which the server closes.
    req.resume()
    req.on('end', () => {
      for (const word of ['Hello', ',', ' Ada']) res.write(`data: {"delta":"${word}"}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-events-')))
  const repo = path.join(tmp, 'prices-api')
  file = path.join(repo, 'collections', 'prices.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: prices',
      'steps:',
      '  - name: price stream',
      `    GET: "${origin}/prices"`,
      '    settings:',
      '      maxEvents: 3',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      "      gta.expectResponseBodyToHaveProperty('[0].event', 'subscribed')",
      "      gta.expectResponseBodyToHaveProperty('[1].data.price', 100)",
      '  - name: answer',
      `    POST: "${origin}/chat"`,
      '    body:',
      `      json: '{ "prompt": "Ada" }'`,
      '  - name: ticker',
      `    GET: "${origin}/prices"`,
      '    tests: |',
      "      gta.expectResponseBodyToHaveProperty('[0].event', 'subscribed')",
      ''
    ].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const response = () => page.locator('.response')
const line = (text: string) => response().locator('.body-lines li', { hasText: text })
const streamMetric = () => response().locator('.stream-metric')
const used = (label: string) =>
  page.getByRole('region', { name: label, exact: true }).locator('.setting-used')

test('an open stream stops at Max events, and its events are checked like any body', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  await expect(streamMetric()).toHaveText('3 events · max events reached')
  await expect(page.locator('.test-results .test-results-summary')).toHaveText('All 3 passed')

  await expect(line('"event": "subscribed"')).toHaveClass(/mark-pass/)
  await expect(line('"price": 100')).toHaveClass(/mark-pass/)
  await expect(line('"price": 101')).toHaveCount(1)
  await expect(line('"price": 102')).toHaveCount(0)
  await expect(response().locator('.body-mode-note')).toHaveText('read as events')

  await response().getByRole('button', { name: 'Raw' }).click()
  await expect(response().locator('pre.code')).toContainText(
    'event: subscribed\ndata: {"symbol":"ACME"}'
  )
  await response().getByRole('button', { name: 'As checked' }).click()

  await response().locator('.tabs button', { hasText: 'Timings' }).click()
  await expect(response().getByRole('cell', { name: 'First event' })).toBeVisible()
  await response().locator('.tabs button', { hasText: 'Body' }).click()
})

test('Max events and Stream timeout are settings, saved and honoured like the others', async () => {
  await page.getByRole('button', { name: 'Show the request editor' }).click()
  await page.locator('.request-pane .tabs button', { hasText: 'Settings' }).click()
  await expect(used('Max events')).toHaveText('3step')
  await expect(used('Stream timeout')).toHaveText('0 msdefault')

  await page.getByLabel('Max events for this step').fill('')
  await page.getByLabel('Stream timeout for this step').fill('120')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('    settings:\n      streamTimeout: 120\n')
  expect(onDisk()).not.toContain('maxEvents')

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(streamMetric()).toContainText('stream timeout reached')
})

test('a stream the server closes is read to its end', async () => {
  await page.locator('.step-open', { hasText: 'answer' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(streamMetric()).toHaveText('4 events · closed by the server')
  await expect(line('"delta": "Hello"')).toHaveCount(1)
  await expect(line('"data": "[DONE]"')).toHaveCount(1)
})

test('an open stream shows its events as they come, and Stop ends it so its checks run', async () => {
  await page.locator('.step-open', { hasText: 'ticker' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  // Nothing stops it but the button: its events show as they arrive.
  const live = page.getByLabel('Event stream')
  await expect(live.locator('.status-pill')).toHaveText('200 OK')
  await expect
    .poll(() => live.locator('.live-events li').count(), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(3)
  await expect(live.locator('.live-events li').first()).toContainText('"event":"subscribed"')

  await live.getByRole('button', { name: 'Stop' }).click()
  await expect(streamMetric()).toContainText('stopped')
  await expect(page.locator('.test-results .test-results-summary')).toHaveText('All 1 passed')
})
