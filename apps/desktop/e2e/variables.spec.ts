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
 * Runtime variables: what a collection's Sends and runs set with gta.set and
 * captures. The Variables tab of the bottom panel lists them, with the step
 * that set each; the collection's next Sends start from them, as the steps of
 * a run share theirs; the editor shows them on hover. Run all starts from
 * nothing, and Clear or another environment forgets them.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const SECRET = 'key-9b1e'

let tmp: string
let origin: string
let server: http.Server
let app: ElectronApplication
let page: Page
/** A new token for each login, so a value from a later one is told from an earlier. */
let logins = 0

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/login') {
        logins++
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ token: `tok-${logins}` }))
      }
      // Orders only for a token a login gave.
      const ok = /^Bearer tok-\d+$/.test(req.headers.authorization ?? '')
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(ok ? '[{"id":8812}]' : '{"error":"no token"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-variables-')))
  const repo = path.join(tmp, 'shop-api')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), [...lines, ''].join('\n'))
  }
  write('collections/orders.yml', [
    'id: orders',
    'steps:',
    '  - name: login',
    '    POST: "{{baseUrl}}/login"',
    '    tests: |',
    "      gta.expectResponseBodyToHaveProperty('token', 'authToken', 'setAsCollectionVariable')",
    "      gta.set('signedWith', 'Key ' + gta.get('apiKey'))",
    '  - name: get orders',
    '    GET: "{{baseUrl}}/orders?by={{authToken}}"',
    '    headers:',
    '      Authorization: "Bearer {{authToken}}"',
    '    tests: |',
    '      gta.expectResponseStatusCodeToBe(200)',
    "      gta.set('orderId', res.body[0].id)"
  ])
  // A reusable requests file saving the token under the name its caller gives.
  write('requests/sign-in.yml', [
    'id: sign-in',
    'params:',
    '  saveTokenAs: { required: true }',
    'steps:',
    '  - name: sign in',
    '    POST: "{{baseUrl}}/login"',
    '    tests: gta.set(params.saveTokenAs, res.body.token)'
  ])
  write('collections/reuse.yml', [
    'id: reuse',
    'steps:',
    '  - use: sign-in',
    '    name: sign in admin',
    '    with: { saveTokenAs: adminToken }',
    '  - name: list orders',
    '    GET: "{{baseUrl}}/orders?as={{adminToken}}"',
    '    headers:',
    '      Authorization: "Bearer {{adminToken}}"'
  ])
  // A step whose own pre-request script sets the header it sends.
  write('collections/trace.yml', [
    'id: trace',
    'steps:',
    '  - name: make trace',
    '    POST: "{{baseUrl}}/trace"',
    '    headers:',
    '      X-Trace-Id: "{{traceId}}"',
    '    body:',
    '      json: \'{ "trace": "{{traceId}}" }\'',
    '    before:',
    "      script: gta.set('traceId', 'trace-' + Date.now())"
  ])
  write('environments/local.yml', ['vars:', `  baseUrl: ${origin}`, '  apiKey: { secret: true }'])
  write('environments/other.yml', ['vars:', `  baseUrl: ${origin}`, '  apiKey: { secret: true }'])
  write('.env', [`apiKey=${SECRET}`])

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 900 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row', { hasText: 'orders' }).click()
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const variablesButton = () =>
  page.locator('.status-bar').getByRole('button', { name: /^Variables/ })
const panel = () => page.getByRole('region', { name: 'Variables', exact: true })
const row = (name: string) =>
  panel()
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) })
const openStep = (name: string) => page.locator('.step-open', { hasText: name }).click()
const send = async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 15_000 })
}
const token = (name: string) => page.locator('.var-token', { hasText: `{{${name}}}` }).first()
const card = () => page.locator('.var-card')
const hover = async (name: string) => {
  await page.mouse.move(0, 0)
  // Forced: the field under the variable takes the pointer, and finds the variable by position.
  await token(name).hover({ force: true })
  await expect(card().locator('.var-card-name')).toHaveText(name)
}

test('a variable a step sets reads as set by it, not undefined, before it has run', async () => {
  await openStep('get orders')
  await expect(token('authToken')).toHaveClass(/(^| )resolved( |$)/)
  await hover('authToken')
  await expect(card().locator('.var-card-value')).toHaveText('Not set until that step runs')
  await expect(card().locator('.var-card-origin')).toHaveText('set by login · captured')
})

test('the Variables tab opens from the status bar, with nothing set yet', async () => {
  await expect(variablesButton()).toHaveAccessibleName('Variables')
  await variablesButton().click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByRole('tab', { name: 'Variables' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(panel()).toContainText('Nothing set yet')
})

test('what a Send sets is listed with the step that set it, a secret in it hidden', async () => {
  await openStep('login')
  await send()
  await expect(variablesButton()).toHaveAccessibleName('Variables, 2 set')
  await expect(row('authToken')).toContainText('tok-1')
  await expect(row('authToken')).toContainText('login · captured')
  await expect(row('signedWith')).toContainText('Key [secret: apiKey]')
  await expect(panel()).not.toContainText(SECRET)
  await expect(panel().locator('.variables-summary')).toHaveText(/^Sends · local · /)

  // Copying gives the value as set, the secret's included.
  await row('signedWith').getByRole('button', { name: 'Copy the value of signedWith' }).click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(`Key ${SECRET}`)
})

test('the next Send starts from them, and the editor shows their values', async () => {
  await openStep('get orders')
  await hover('authToken')
  await expect(card().locator('.var-card-value')).toHaveText('tok-1')
  await expect(card().locator('.var-card-origin')).toHaveText('set by login · captured')

  await send()
  await expect(page.locator('.status-pill')).toContainText('200 OK')
  await expect(row('orderId')).toContainText('8812')
  await expect(row('orderId')).toContainText('get orders · tests')
})

test('Clear forgets them: the next Send starts from nothing', async () => {
  await panel().getByRole('button', { name: 'Clear' }).click()
  await expect(panel()).toContainText('Nothing set yet')
  await expect(variablesButton()).toHaveAccessibleName('Variables')
  await send()
  await expect(page.locator('.placeholder.error')).toContainText(
    'Variable "authToken" is not defined'
  )
})

test('Run all starts from nothing and keeps what it set after', async () => {
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.getByRole('button', { name: 'Run all' })).toBeEnabled({ timeout: 15_000 })
  await expect(panel().locator('.variables-summary')).toHaveText(/^Run all · local · /)
  await expect(row('authToken')).toContainText(`tok-${logins}`)
  await expect(row('orderId')).toContainText('get orders · tests')

  // A Send after it starts from what it set.
  await send()
  await expect(page.locator('.status-pill')).toContainText('200 OK')
})

test('another environment forgets them', async () => {
  await expect(variablesButton()).toHaveAccessibleName('Variables, 3 set')
  await page.getByLabel('Environment', { exact: true }).selectOption('other')
  await expect(panel()).toContainText('Nothing set yet')
  // Back in the first, they are gone for good: a Send starts from nothing.
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await send()
  await expect(page.locator('.placeholder.error')).toContainText(
    'Variable "authToken" is not defined'
  )
  await expect(panel()).toContainText('Nothing set yet')
})

test('the Console button switches the panel to the console, and back', async () => {
  const consoleButton = page.locator('.status-bar').getByRole('button', { name: /^Console/ })
  await consoleButton.click()
  await expect(page.getByRole('region', { name: 'Console', exact: true })).toBeVisible()
  await expect(panel()).toHaveCount(0)
  await page.getByRole('tab', { name: 'Variables' }).click()
  await expect(panel()).toBeVisible()
  await variablesButton().click()
  await expect(panel()).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Console', exact: true })).toHaveCount(0)
})

test("a reusable requests file's step names the variable its caller gives, and its Send carries it", async () => {
  await page.locator('.collection-row', { hasText: 'reuse' }).click()
  await openStep('list orders')
  await hover('adminToken')
  await expect(card().locator('.var-card-value')).toHaveText('Not set until that step runs')
  await expect(card().locator('.var-card-origin')).toHaveText('set by sign in admin · tests')

  // A use step's Send is its Run.
  await openStep('sign in admin')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(variablesButton()).toHaveAccessibleName('Variables, 1 set', { timeout: 15_000 })
  await openStep('list orders')
  await send()
  await expect(page.locator('.status-pill')).toContainText('200 OK')
  await variablesButton().click()
  await expect(row('adminToken')).toContainText('sign in admin · tests')
})

test('after a run, a variable its step’s own script sets shows the value it last set', async () => {
  await page.locator('.collection-row', { hasText: 'trace' }).click()
  await openStep('make trace')
  const headers = async () => {
    // A run puts the request editor aside.
    const show = page.getByRole('button', { name: 'Show the request editor' })
    if (await show.isVisible()) await show.click()
    await page
      .locator('.request-pane')
      .getByRole('button', { name: /^Headers/ })
      .click()
  }
  await headers()
  await hover('traceId')
  await expect(card().locator('.var-card-value')).toHaveText('Generated for each request')

  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.getByRole('button', { name: 'Run all' })).toBeEnabled({ timeout: 15_000 })
  await headers()
  await hover('traceId')
  // What it went out with last; the next Send sets it again.
  await expect(card().locator('.var-card-value')).toHaveText(/^trace-\d+$/)
  await expect(card().locator('.var-card-origin')).toHaveText('set by make trace · pre-request')
})

test('the request body’s variables have the same card, the value a run set in it', async () => {
  const pane = page.locator('.request-pane')
  await pane.getByRole('button', { name: /^Body/ }).click()
  const variable = pane.locator('.cm-var', { hasText: '{{traceId}}' })
  await expect(variable).toHaveClass(/(^| )resolved( |$)/)
  await page.mouse.move(0, 0)
  await variable.hover()
  await expect(card().locator('.var-card-name')).toHaveText('traceId')
  await expect(card().locator('.var-card-value')).toHaveText(/^trace-\d+$/)
  await expect(card().locator('.var-card-origin')).toHaveText('set by make trace · pre-request')
  await expect(card().getByRole('button', { name: 'Copy the value of traceId' })).toBeVisible()

  // Off it, the card goes.
  await page.mouse.move(0, 0)
  await expect(card()).toHaveCount(0)
})
