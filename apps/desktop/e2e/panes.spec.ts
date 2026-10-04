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
  type Locator,
  type Page
} from '@playwright/test'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * The panes beside a step: each one's name and Hide in a row above its tabs,
 * where a narrow pane never scrolls Hide away, and the response hiding to a
 * strip that says what came back.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      setTimeout(
        () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ url: req.url }))
        },
        req.url === '/slow' ? 1500 : 0
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-panes-')))
  const shop = path.join(tmp, 'shop')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), `${lines.join('\n')}\n`)
  }
  write('requests/login.yml', [
    'id: login',
    'params:',
    '  user: alice',
    'steps:',
    '  - name: log in',
    `    GET: "${origin}/login/{{params.user}}"`
  ])
  write('collections/orders.yml', [
    'id: orders',
    'steps:',
    '  - name: ok',
    `    GET: "${origin}/ok"`,
    '    tests: gta.expectResponseStatusCodeToBe(200)',
    '  - name: slow',
    `    GET: "${origin}/slow"`,
    '  - name: down',
    '    GET: "http://127.0.0.1:1/down"',
    '  - name: unsent',
    `    GET: "${origin}/unsent"`,
    '  - use: login'
  ])

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const openStep = (name: string) => page.locator('.step-open', { hasText: name }).first().click()
const send = () => page.getByRole('button', { name: 'Send' }).click()
const requestPane = () => page.locator('.request-pane')
const responsePane = () => page.locator('.panes > section.pane:not(.request-pane)')
const scriptsPane = () => page.locator('.scripts-pane')
const responseStrip = () => page.getByRole('button', { name: 'Show the response' })

/** A pane's head holds its name and Hide, above its tabs, and none of its tabs hold a Hide. */
async function expectHeadAboveTabs(pane: Locator, title: string, hide: string) {
  const head = pane.locator('.pane-head')
  await expect(head.locator('.pane-title')).toHaveText(title)
  const button = head.getByRole('button', { name: hide })
  await expect(button).toBeVisible()
  await expect(pane.locator('.tabs').getByRole('button', { name: hide })).toHaveCount(0)
  const headBox = (await head.boundingBox())!
  const tabsBox = (await pane.locator('.tabs').first().boundingBox())!
  expect(headBox.y + headBox.height).toBeLessThanOrEqual(tabsBox.y + 1)
}

/** The whole of a button lies inside its pane: not scrolled away, not cut off. */
async function expectInside(button: Locator, pane: Locator) {
  const inner = (await button.boundingBox())!
  const outer = (await pane.boundingBox())!
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
}

test('each pane has its name and Hide in a row above its tabs', async () => {
  await openStep('ok')
  await expectHeadAboveTabs(requestPane(), 'Request', 'Hide the request editor')
  await expectHeadAboveTabs(scriptsPane(), 'Scripts', 'Hide the scripts')

  await send()
  await expect(page.locator('.status-pill')).toContainText('200')
  await expectHeadAboveTabs(responsePane(), 'Response', 'Hide the response')
})

test('each Hide says what hiding gives, on hover', async () => {
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Hide the response' }).hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Hide the response to give the request editor more room'
  )
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Hide the scripts' }).hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Hide the scripts to give the response more room'
  )
  await page.mouse.move(0, 0)
})

test('the response hides to a strip that says what came back, the editor taking its room', async () => {
  await expect(requestPane()).toHaveCount(0)
  await page.getByRole('button', { name: 'Hide the response' }).click()
  await expect(responsePane()).toHaveCount(0)
  await expect(requestPane()).toBeVisible()
  await expect(responseStrip()).toHaveText('Response · 200')
})

test('hidden, it stays hidden through another send and another step, saying what each got', async () => {
  // A request still out says so, then what came back.
  await openStep('slow')
  await send()
  await expect(responseStrip()).toHaveText('Response · sending…')
  await expect(responseStrip()).toHaveText('Response · 200', { timeout: 10_000 })
  await expect(responsePane()).toHaveCount(0)

  // Nothing came back: an error.
  await openStep('down')
  await send()
  await expect(responseStrip()).toHaveText('Response · error', { timeout: 10_000 })

  // A step not sent yet has nothing to show.
  await openStep('unsent')
  await expect(page.getByRole('button', { name: 'No response yet' })).toBeDisabled()
  await expect(responseStrip()).toHaveCount(0)

  await openStep('ok')
  await expect(responseStrip()).toHaveText('Response · 200')
})

test('the strip brings the response back, and the editor steps aside again', async () => {
  await responseStrip().click()
  await expect(responsePane()).toBeVisible()
  await expect(responsePane().locator('.status-pill')).toContainText('200')
  await expect(requestPane()).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show the request editor' })).toBeVisible()
})

test('a use step’s editor hides from its head too', async () => {
  await openStep('login')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.use-children .step-summary')).toHaveText([/^200 · /], {
    timeout: 10_000
  })
  await page.getByRole('button', { name: 'Show the request editor' }).click()
  await expectHeadAboveTabs(requestPane(), 'Request', 'Hide the request editor')
  await requestPane().getByRole('button', { name: 'Hide the request editor' }).click()
  await expect(requestPane()).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show the request editor' })).toBeVisible()
})

test('a pane too narrow for its tabs still shows its Hide whole', async () => {
  await openStep('unsent')
  // The scripts pane as wide as it goes leaves the request editor a sliver.
  await page.getByRole('separator', { name: 'Resize the scripts pane' }).focus()
  await page.keyboard.press('End')
  const tabs = requestPane().locator('.tabs')
  const overflow = await tabs.evaluate((element) => {
    const box = element as unknown as { scrollWidth: number; clientWidth: number }
    return box.scrollWidth > box.clientWidth
  })
  expect(overflow).toBe(true)
  await expectInside(
    requestPane().getByRole('button', { name: 'Hide the request editor' }),
    requestPane()
  )
  await expectInside(scriptsPane().getByRole('button', { name: 'Hide the scripts' }), scriptsPane())
  await page.getByRole('separator', { name: 'Resize the scripts pane' }).dblclick()
})
