import { execFileSync } from 'node:child_process'
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
 * What a step inherits, shown where it is edited — each layer's headers,
 * scripts and settings: the endpoints file's, the endpoint's, the base
 * collection's and the collection's — and the request as a run sent it.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const SECRET = 's3cret-key-123'

let tmp: string
let shop: string
let server: http.Server
let received: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: /^\/users\/([^/?]+)/.exec(req.url ?? '')?.[1] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-layers-')))
  shop = path.join(tmp, 'shop')
  const write = (file: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), `${lines.join('\n')}\n`)
  }
  write('.env', [`apiKey=${SECRET}`])
  write('environments/local.yml', ['vars:', '  apiKey: { secret: true }'])
  write('endpoints/people.yml', [
    'id: people',
    'headers:',
    "  X-Request-Id: '{{requestId}}'",
    'before:',
    "  script: gta.set('requestId', 'req-1')",
    'steps:',
    '  - GET: /users/{id}',
    '    headers:',
    '      Accept: application/json',
    '    settings:',
    '      timeout: 7000',
    '    tests: gta.expectResponseStatusCodeToBe(200)'
  ])
  write('bases/auth.yml', [
    'id: auth',
    'headers:',
    '  Authorization: Bearer {{token}}',
    'settings:',
    '  maxRedirects: 3',
    'vars:',
    '  token: t1',
    'before:',
    "  script: gta.set('fromBase', 'yes')"
  ])
  write('checks/ids.js', [
    'export function same(id) {',
    "  gta.expectResponseBodyToHaveProperty('id', id)",
    '}'
  ])
  write('collections/users.yml', [
    'id: users',
    'extends: auth',
    'vars:',
    `  baseUrl: "${origin}"`,
    'headers:',
    '  Accept: application/xml',
    '  X-Client: gta',
    'before:',
    "  script: gta.set('fromCollection', 'yes')",
    'tests: gta.expectResponseStatusCodeToBe(200)',
    'steps:',
    '  - name: get user',
    '    GET: "{{baseUrl}}/users/42"',
    '    headers:',
    '      X-Client: mine',
    '  - name: with key',
    '    GET: "{{baseUrl}}/users/7"',
    '    headers:',
    "      X-Api-Key: '{{apiKey}}'",
    "    tests: checks.ids.same('7')"
  ])
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

const openStep = (name: string) => page.locator('.step-open', { hasText: name }).click()
const requestTab = (name: string) => page.locator('.request-pane .tabs button', { hasText: name })
const scriptTab = (name: string) => page.locator('.scripts-pane .tabs button', { hasText: name })
const fromLayer = (title: string) =>
  page.getByRole('region', { name: `Headers from the ${title}`, exact: true })
const layerSections = () => page.getByRole('region', { name: /^Headers from the / })
/** Bring the request editor back, if a result has put it aside. */
const showEditor = async () => {
  const show = page.getByRole('button', { name: 'Show the request editor' })
  if (await show.isVisible()) await show.click()
}

test('the endpoint note says what the base adds, a pre-request script included', async () => {
  await openStep('get user')
  await expect(page.locator('.endpoint-note')).toContainText(
    'Endpoint base GET /users/{id} — adds headers X-Request-Id, Accept, a pre-request script and checks.'
  )
})

test('the Headers tab lists each layer’s headers, outermost first, and what replaces them', async () => {
  await requestTab('Headers').click()
  await expect(layerSections()).toHaveCount(4)
  expect(
    await layerSections().evaluateAll((sections) =>
      sections.map((section) => section.getAttribute('aria-label'))
    )
  ).toEqual([
    'Headers from the endpoints file',
    'Headers from the endpoint',
    'Headers from the base collection',
    'Headers from the collection'
  ])
  await expect(fromLayer('endpoints file').locator('.inherited-head')).toContainText(
    'From the endpoints file people.yml'
  )
  await expect(fromLayer('endpoints file').locator('tr')).toHaveText(['X-Request-Id{{requestId}}'])
  await expect(fromLayer('endpoint').locator('tr')).toHaveText([
    'Acceptapplication/jsonreplaced by the collection'
  ])
  await expect(fromLayer('base collection').locator('tr')).toHaveText([
    'AuthorizationBearer {{token}}'
  ])
  await expect(fromLayer('collection').locator('tr')).toHaveText([
    'Acceptapplication/xml',
    'X-Clientgtareplaced by this step'
  ])
  // X-Request-Id, Accept, Authorization and the step's own X-Client.
  await expect(requestTab('Headers')).toContainText('4')

  // Each layer opens where it is written.
  await fromLayer('base collection')
    .getByRole('button', { name: 'Open the base collection auth' })
    .click()
  await expect(page.locator('.collection-header h1')).toHaveText('auth')
  await page.locator('.collection-row', { hasText: 'Users' }).click()
  await openStep('get user')
})

test('a step that leaves its endpoint base out shows its layers as not used, and does not count them', async () => {
  await showEditor()
  await page.getByRole('button', { name: 'Don’t use it here' }).click()
  await requestTab('Headers').click()
  await expect(fromLayer('endpoint').locator('.inherited-head')).toContainText(
    'not used by this step'
  )
  await expect(fromLayer('endpoint').locator('tr')).toHaveText(['Acceptapplication/jsonnot used'])
  await expect(requestTab('Headers')).toContainText('3')
  await requestTab('Settings').click()
  await expect(
    page.getByRole('region', { name: 'Timeout', exact: true }).locator('.setting-used')
  ).toHaveText('0 msdefault')

  await page.getByRole('button', { name: 'Use it' }).click()
  await requestTab('Headers').click()
  await expect(requestTab('Headers')).toContainText('4')
})

test('the Settings tab says which layer each inherited setting comes from', async () => {
  await requestTab('Settings').click()
  const used = (label: string) =>
    page.getByRole('region', { name: label, exact: true }).locator('.setting-used')
  await expect(used('Timeout')).toHaveText('7000 msendpoint')
  await expect(used('Max redirects')).toHaveText('3base collection')
  await expect(used('Follow redirects')).toHaveText('Ondefault')
})

test('the Pre-request and Tests tabs list the scripts that run first, in order', async () => {
  await scriptTab('Pre-request').click()
  const before = page.getByRole('note', { name: 'Scripts before this step’s' })
  await expect(before.locator('li')).toHaveCount(3)
  await expect(before.locator('li').nth(0)).toContainText('the endpoints file’s people.yml')
  await expect(before.locator('li').nth(1)).toContainText('the base collection’s auth')
  await expect(before.locator('li').nth(2)).toContainText('the collection’s')

  await scriptTab('Tests').click()
  const tests = page.getByRole('note', { name: 'Tests before this step’s' })
  await expect(tests.locator('li')).toHaveCount(2)
  await expect(tests.locator('li').nth(0)).toContainText('the endpoint’s GET /users/{id}')
  await expect(tests.locator('li').nth(1)).toContainText('the collection’s')
  await expect(tests).toContainText(
    'The endpoint base’s checks give way to this step’s own checks of the same thing.'
  )

  await scriptTab('Pre-request').click()
  await before.getByRole('button', { name: 'Open the collection’s pre-request script' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await expect(
    drawer.getByRole('textbox', { name: 'Collection pre-request script' })
  ).toContainText("gta.set('fromCollection', 'yes')")
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
})

test('the shared scripts show their code, marked by a send, and the results say where each check came from', async () => {
  await openStep('with key')
  await scriptTab('Tests').click()
  const tests = page.getByRole('note', { name: 'Tests before this step’s' })
  const files = page.getByRole('note', { name: 'Check files called' })
  await expect(files.locator('li')).toHaveText(['checks/ids.js'])
  // Folded to a line until opened: the code is there to read.
  const collection = tests.locator('li', { hasText: 'the collection’s' })
  await collection.locator('.shared-script-toggle').click()
  await expect(collection.getByRole('textbox')).toContainText(
    'gta.expectResponseStatusCodeToBe(200)'
  )

  // Its key comes from the environment.
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  // The collection's status check stood in for the endpoint's, so only it made one.
  await expect(collection.locator('.script-chip')).toHaveText('✓ 1')
  await expect(collection.locator('.cm-check-mark')).toHaveText(['✓'])
  await expect(
    tests.locator('li', { hasText: 'the endpoint’s' }).locator('.script-chip')
  ).toHaveCount(0)
  // The check file says what it checked, on its own line, and the step's line that called it.
  const ids = files.locator('li')
  await expect(ids.locator('.script-chip')).toHaveText('✓ 1')
  await ids.locator('.shared-script-toggle').click()
  await expect(ids.locator('.cm-check-mark')).toHaveText(['✓'])
  await expect(ids.locator('.cm-check-gutter .cm-gutterElement').nth(2)).toHaveText('✓')
  await expect(
    page.locator('.scripts-pane .code-editor:not(.read-only) .cm-check-mark')
  ).toHaveText(['✓'])

  const results = page.locator('.test-results')
  await expect(
    results.locator('.check', { hasText: 'Status is 200' }).locator('.check-source')
  ).toHaveText(['collection'])
  await expect(
    results.locator('.check', { hasText: 'id is "7"' }).locator('.check-source')
  ).toHaveText(['checks/ids.js'])
})

test('a result shows the request as sent: every header, resolved, and a secret hidden', async () => {
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await openStep('with key')
  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received[0]?.headers['x-api-key']).toBe(SECRET)

  // The console has the request as sent, raw.
  await page
    .locator('.status-bar')
    .getByRole('button', { name: /^Console/ })
    .click()
  const panel = page.getByRole('region', { name: 'Console', exact: true })
  await panel
    .locator('.console-row.request', { hasText: 'with key' })
    .last()
    .locator('button.console-line')
    .click()
  const sent = panel.getByRole('region', { name: 'Raw request' }).locator('pre')
  await expect(sent).toHaveText(
    new RegExp(
      [
        '^GET http://127\\.0\\.0\\.1:\\d+/users/7',
        'X-Request-Id: req-1',
        'Accept: application/xml',
        'Authorization: Bearer t1',
        'X-Client: gta',
        'X-Api-Key: \\[secret: apiKey\\]$'
      ].join('\n')
    )
  )
  await expect(panel).not.toContainText(SECRET)
  await page
    .locator('.status-bar')
    .getByRole('button', { name: /^Console/ })
    .click()
})
