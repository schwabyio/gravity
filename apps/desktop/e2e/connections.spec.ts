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
 * Connections (SPEC.md §2.11): one step's event stream held open for later
 * steps to read — across Sends, until it is sent again, closed, or Run all
 * starts — and in Run all, for the length of the run.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page
/** The order streams open on the server now. */
const watchers = new Set<http.ServerResponse>()
let orders = 0

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/orders/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: subscribed\ndata: {"topic":"orders"}\n\n')
      watchers.add(res)
      res.on('close', () => watchers.delete(res))
      return
    }
    const id = ++orders
    for (const watcher of watchers) {
      watcher.write(`id: ${id}\nevent: order.created\ndata: {"id":${id}}\n\n`)
    }
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-connections-')))
  const repo = path.join(tmp, 'orders-api')
  file = path.join(repo, 'collections', 'orders.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: orders',
      'steps:',
      '  - name: watch orders',
      `    GET: "${origin}/orders/events"`,
      '    settings:',
      '      untilEvent: subscribed',
      '  - name: place order',
      `    POST: "${origin}/orders"`,
      '    tests: |',
      "      gta.expectResponseBodyToHaveProperty('id', 'orderId', 'setAsCollectionVariable')",
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
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const openStep = (name: string) => page.locator('.step-open', { hasText: name }).click()
const bar = () => page.getByLabel('Open connections')
const streamMetric = () => page.locator('.response .stream-metric')
const send = () => page.getByRole('button', { name: 'Send' }).click()

test('a request keeps its stream open as a connection, set in its Settings tab', async () => {
  await page.locator('.request-pane .tabs button', { hasText: 'Settings' }).click()
  await page.getByLabel('Connection this request opens').fill('orders')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('/orders/events"\n    connection: orders\n    settings:\n')

  // Only now that a step opens one can a step read it: added after the order is placed.
  await openStep('place order')
  await page.getByRole('button', { name: '+ Read a connection' }).click()
  const read = page.locator('.step-list li', { hasText: 'read orders' })
  await expect(read.locator('.method')).toHaveText('READ')
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('  - connection: orders\n')
  await expect(page.getByLabel('Connection to read')).toHaveValue('orders')
  // It sends nothing, so it has no params, headers or body.
  await expect(page.locator('.request-pane .tabs button', { hasText: 'Headers' })).toHaveCount(0)
  await page.locator('.request-pane .tabs button', { hasText: 'Settings' }).click()
  await page.getByLabel('Until event for this step').fill('order.created')
  await page.getByLabel('Stream timeout for this step').fill('5000')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain(
      '  - connection: orders\n    settings:\n      streamTimeout: 5000\n      untilEvent: order.created\n'
    )
})

test('a connection a Send opens stays open for the steps sent after it', async () => {
  await openStep('watch orders')
  await send()
  await expect(streamMetric()).toHaveText('1 event · until event reached · connection orders open')
  await expect(bar()).toContainText('orders')
  await expect(bar()).toContainText('open · 0 held')

  await openStep('place order')
  await send()
  await expect(page.locator('.status-pill')).toContainText('201')
  await expect(bar()).toContainText('open · 1 held')

  await openStep('read orders')
  await send()
  await expect(streamMetric()).toHaveText('1 event · until event reached · connection orders open')
  await expect(
    page.locator('.response .body-lines li', { hasText: '"event": "order.created"' })
  ).toHaveCount(1)
  await expect(bar()).toContainText('open · 0 held')
})

test('Close closes it, and a step reading it then says it is not open', async () => {
  await bar().getByRole('button', { name: 'Close connection orders' }).click()
  await expect(bar()).toHaveCount(0)
  await expect.poll(() => watchers.size, { timeout: 5_000 }).toBe(0)

  await send()
  await expect(page.locator('.placeholder.error')).toContainText(
    'No connection named orders is open'
  )
})

test('Run all opens its own, and leaves none open', async () => {
  await openStep('watch orders')
  await send()
  await expect(bar()).toContainText('orders')

  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('3 passed')
  // It closed what the Send had opened, and its own when it ended.
  await expect(bar()).toHaveCount(0)
  await expect.poll(() => watchers.size, { timeout: 5_000 }).toBe(0)
})
