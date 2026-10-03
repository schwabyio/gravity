import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import YAML from 'yaml'
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
 * Request reuse: a step that runs a request set with values of its own, its
 * set's requests each shown and reported, check files callable from its code,
 * and request sets made and given params in the app.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let server: http.Server
let received: string[] = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '')
    const status = req.url?.startsWith('/login/bad') ? 401 : 200
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'tok', url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-reuse-')))
  shop = path.join(tmp, 'shop')
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), body)
  }
  write(
    'requests/login.yml',
    [
      'id: login',
      'params:',
      '  username: { required: true, description: Who logs in }',
      '  expectStatus: 200',
      'steps:',
      '  - name: log in',
      `    POST: "${origin}/login/{{params.username}}"`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(params.expectStatus)',
      "      if (params.expectStatus === 200) gta.set('token', res.body.token)",
      ''
    ].join('\n')
  )
  write(
    'requests/orders.yml',
    [
      'id: orders',
      'params:',
      '  item: widget',
      'steps:',
      '  - name: add to cart',
      `    POST: "${origin}/cart/{{params.item}}"`,
      '  - name: check out',
      `    POST: "${origin}/checkout"`,
      ''
    ].join('\n')
  )
  write('checks/common.js', 'export function ok() {\n  gta.expectResponseStatusCodeToBe(200)\n}\n')
  write(
    'collections/flow.yml',
    [
      'id: flow',
      'steps:',
      '  - use: login',
      '    with:',
      '      username: alice',
      '  - name: profile',
      `    GET: "${origin}/me?token={{token}}"`,
      ''
    ].join('\n')
  )
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 900 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row', { hasText: 'Flow' }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const flow = () => YAML.parse(fs.readFileSync(path.join(shop, 'collections', 'flow.yml'), 'utf8'))
const stepRow = (name: string) => page.locator('.step-list > li', { hasText: name })
const children = (name: string) => page.getByRole('list', { name: `Requests of ${name}` })

test('a use step shows its set’s requests, and the project lists its request sets', async () => {
  await expect(stepRow('Login').locator('.step-open .method')).toHaveText('USE')
  await expect(children('login').locator('.use-child-name')).toHaveText(['log in'])
  await expect(
    page.getByRole('group', { name: 'Request sets of shop' }).locator('.set-row')
  ).toHaveText(['login', 'orders'])
})

test('Run all runs the set’s requests with the values given, sharing variables', async () => {
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('2 passed', { timeout: 10_000 })
  expect(received).toEqual(['/login/alice', '/me?token=tok'])
  await expect(stepRow('Login').locator('.step-foot .step-status')).toHaveText('1 of 1 passed')
  await expect(children('login').locator('.step-status')).toHaveText(['200'])
})

test('selecting a use step shows its set and the values it passes', async () => {
  await stepRow('Login').locator('.step-open').click()
  await expect(page.getByLabel('Request set', { exact: true })).toHaveValue('login')
  // With results to show, the editor has stepped aside.
  await page.getByRole('button', { name: 'Show the request editor' }).click()
  await expect(page.getByLabel('Value of param username')).toHaveValue('alice')
  await expect(page.getByLabel('Value of param expectStatus')).toHaveAttribute(
    'placeholder',
    'default: 200'
  )
  await expect(page.locator('.use-with')).toContainText('Who logs in')

  // A number for a param whose default is one is saved as a number.
  await page.getByLabel('Value of param username').fill('bad')
  await page.getByLabel('Value of param expectStatus').fill('401')
  await expect
    .poll(() => flow().steps[0], { timeout: 5_000 })
    .toEqual({ use: 'login', with: { username: 'bad', expectStatus: 401 } })

  received = []
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(children('login').locator('.step-status')).toHaveText(['401'], { timeout: 10_000 })
  expect(received).toEqual(['/login/bad'])
  await expect(stepRow('Login').locator('.step-foot .step-status')).toHaveText('1 of 1 passed')
})

test('a missing required value stops the step before anything is sent', async () => {
  await page.getByLabel('Value of param username').fill('')
  await expect.poll(() => flow().steps[0].with, { timeout: 5_000 }).toEqual({ expectStatus: 401 })
  received = []
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(stepRow('Login').locator('.step-foot .step-status')).toContainText(
    'needs username in with:',
    { timeout: 10_000 }
  )
  expect(received).toEqual([])
  await page.getByLabel('Value of param username').fill('alice')
  await page.getByLabel('Value of param expectStatus').fill('')
})

test('a new use step runs another set; each of its requests is shown on its own', async () => {
  await page.getByRole('button', { name: '+ Use a request set' }).click()
  // It goes in after the selected step, and is selected itself.
  await expect(page.locator('.step-list > li').nth(1)).toHaveClass(/selected/)
  await page.getByLabel('Request set', { exact: true }).selectOption('orders')
  await page.getByRole('button', { name: 'Tests', exact: true }).click()
  await page.getByRole('textbox', { name: 'Tests after the set' }).click()
  await page.keyboard.type('checks.common.ok()')
  await expect
    // Added after the selected step.
    .poll(() => flow().steps[1], { timeout: 5_000 })
    .toEqual({ use: 'orders', tests: 'checks.common.ok()' })

  received = []
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(children('orders').locator('.step-status')).toHaveText(['200', '200'], {
    timeout: 10_000
  })
  expect(received).toEqual(['/cart/widget', '/checkout'])
  await expect(stepRow('Orders').locator('.step-foot .step-status')).toHaveText('2 of 2 passed')

  // The use step's own tests ran on the set's last request.
  await children('orders')
    .getByRole('button', { name: /check out/ })
    .click()
  await expect(page.locator('.use-shown')).toHaveText('Showing 2 of 2 · check out')
  await expect(page.locator('.test-results-pane')).toContainText('Status is 200')
})

test('a request set is made in the app, and given params', async () => {
  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New request set' }).click()
  await page.getByLabel('New request set id').fill('refund')
  await page.keyboard.press('Enter')
  const file = path.join(shop, 'requests', 'refund.yml')
  // Polled for its text, not only the file: it is made empty, then written, and
  // on a slow disk a read in between finds nothing in it.
  await expect
    .poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''))
    .toBe('id: refund\nparams: {}\nsteps: []\n')

  await page.getByRole('group', { name: 'Request sets of shop' }).getByText('refund').click()
  await expect(page.locator('.collection-header h1')).toHaveText('refund')
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await drawer.getByRole('button', { name: 'Params' }).click()
  await drawer.getByLabel('Param name').last().fill('amount')
  await drawer.getByLabel('Type of amount').selectOption('number')
  await drawer.getByLabel('Default of amount').fill('10')
  await expect
    .poll(() => YAML.parse(fs.readFileSync(file, 'utf8')).params, { timeout: 5_000 })
    .toEqual({ amount: 10 })
})

test('a request set’s step is marked as the one a use step’s tests check', async () => {
  const file = path.join(shop, 'requests', 'orders.yml')
  // The test before leaves the collection settings open.
  const settings = page.getByRole('dialog', { name: 'Collection settings' })
  if (await settings.isVisible()) await settings.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('group', { name: 'Request sets of shop' }).getByText('orders').click()
  await expect(page.locator('.collection-header h1')).toHaveText('orders')
  const marker = page.getByRole('checkbox', { name: /A use step’s tests check this response/ })

  await stepRow('add to cart').locator('.step-open').click()
  await marker.check()
  await expect
    .poll(() => YAML.parse(fs.readFileSync(file, 'utf8')).steps[0].useTests, { timeout: 5_000 })
    .toBe(true)

  // One step at a time: another cannot take it while this one has it.
  await stepRow('check out').locator('.step-open').click()
  await expect(marker).toBeDisabled()
  await expect(page.locator('.step-use-tests')).toContainText('step 1 has this')

  await stepRow('add to cart').locator('.step-open').click()
  await marker.uncheck()
  await expect
    .poll(() => YAML.parse(fs.readFileSync(file, 'utf8')).steps[0].useTests, { timeout: 5_000 })
    .toBeUndefined()
})

test('a project’s filter narrows its request sets too', async () => {
  const shopProject = page.getByRole('region', { name: 'Project shop' })
  // The filter looks through request sets as well as collections, and counts them to five.
  const more = ['refunds', 'search'].map((id) => path.join(shop, 'requests', `${id}.yml`))
  for (const file of more) {
    fs.writeFileSync(file, `id: ${path.basename(file, '.yml')}\nparams: {}\nsteps: []\n`)
  }
  await shopProject.getByLabel('Filter shop').fill('ord')
  await expect(
    page.getByRole('group', { name: 'Request sets of shop' }).locator('.set-row')
  ).toHaveText(['orders'])
  await expect(shopProject.locator('.collection-row')).toHaveCount(0)
  await shopProject.getByLabel('Filter shop').fill('')
  await expect(shopProject.locator('.collection-row')).toHaveCount(1)
  for (const file of more) fs.rmSync(file)
  await expect(shopProject.getByLabel('Filter shop')).toHaveCount(0)
})
