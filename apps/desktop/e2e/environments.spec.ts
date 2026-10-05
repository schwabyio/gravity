import { execFileSync } from 'node:child_process'
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
 * Environments end to end: a request authored with `{{baseUrl}}` must reach a
 * real server only because the selected environment supplied the value.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let repo: string
let server: http.Server
let origin: string
let app: ElectronApplication
let page: Page

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, realm: req.headers['x-realm'] ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-env-')))
  repo = path.join(tmp, 'payments-api')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  write(
    path.join(repo, 'collections', 'checkout.yml'),
    [
      'id: checkout',
      'vars:',
      '  apiVersion: "2"',
      '  realm: shop',
      'steps:',
      '  - name: create-session',
      '    GET: "{{baseUrl}}/v{{apiVersion}}/sessions"',
      '    headers:',
      '      X-Realm: "{{realm}}"',
      '      X-Trace: "{{$uuid}}"',
      ''
    ].join('\n')
  )
  write(
    path.join(repo, 'collections', 'refunds.yml'),
    ['id: refunds', 'steps:', '  - name: refund', '    GET: "{{baseUrl}}/refund"', ''].join('\n')
  )
  write(
    path.join(repo, 'environments', 'local.yml'),
    ['name: local', 'vars:', `  baseUrl: ${origin}`, ''].join('\n')
  )
  write(
    path.join(repo, 'environments', 'other.yml'),
    ['name: other', 'vars:', '  baseUrl: http://127.0.0.1:1', ''].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')

  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await page.locator('.collection-row').first().click()
  // The first step's editor is on screen as soon as the collection opens.
  await expect(page.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/v{{apiVersion}}/sessions')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('offers the collection environments and starts with none selected', async () => {
  const picker = page.getByLabel('Environment', { exact: true })
  await expect(picker).toBeVisible()
  await expect(picker.locator('option')).toHaveText(['No environment', 'local', 'other'])
  await expect(picker).toHaveValue('')
  // Unset is called out, because variables cannot resolve without it.
  await expect(page.locator('.env-picker')).toHaveClass(/unset/)
})

test('without an environment, an unresolved variable is reported as such', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toContainText('"baseUrl" is not defined', {
    timeout: 15_000
  })
})

test('selecting an environment resolves the request and sends it', async () => {
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await expect(page.locator('.env-picker')).not.toHaveClass(/unset/)

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toHaveText('200 OK', { timeout: 15_000 })

  // The collection variable and the folder variable both resolved too.
  await expect(page.locator('.response-body')).toContainText('/v2/sessions')
  await expect(page.locator('.response-body')).toContainText('"realm": "shop"')
})

test('the URL field still shows what was authored, not what was sent', async () => {
  await expect(page.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/v{{apiVersion}}/sessions')
})

test('switching environments changes where the request goes', async () => {
  await page.getByLabel('Environment', { exact: true }).selectOption('other')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toBeVisible({ timeout: 15_000 })

  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toHaveText('200 OK', { timeout: 15_000 })
})

test('the chosen environment survives a restart', async () => {
  await app.close()
  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.collection-row', { timeout: 15_000 })
  await page.locator('.collection-row').first().click()

  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('local')
})

/* ------------------------------------------------ variable highlighting -- */

const token = (name: string) => page.locator('.var-token', { hasText: `{{${name}}}` }).first()

test('colours resolved variables and greys out unresolved ones', async () => {
  await page.getByLabel('Environment', { exact: true }).selectOption('local')

  // baseUrl and apiVersion both resolve; nothing here is unresolved yet.
  await expect(token('baseUrl')).toHaveClass(/resolved/)
  await expect(token('apiVersion')).toHaveClass(/resolved/)

  await page.getByLabel('Request URL').fill('{{baseUrl}}/{{notAThing}}')
  await expect(token('notAThing')).toHaveClass(/unresolved/)
  await expect(token('baseUrl')).toHaveClass(/resolved/)
})

test('an unresolved variable becomes resolved when the environment supplies it', async () => {
  await page.getByLabel('Environment', { exact: true }).selectOption('')
  await expect(token('baseUrl')).toHaveClass(/unresolved/)

  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await expect(token('baseUrl')).toHaveClass(/resolved/)
})

test('hovering a resolved variable shows its value and where it came from', async () => {
  await page.getByLabel('Request URL').fill('{{baseUrl}}/v{{apiVersion}}/sessions')
  await page.mouse.move(0, 0)
  await token('baseUrl').hover()

  const card = page.locator('.var-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.var-card-name')).toHaveText('baseUrl')
  await expect(card.locator('.var-card-value')).toHaveText(origin)
  await expect(card.locator('.var-card-origin')).toHaveText(/local\.yml$/)
})

test('hovering an unresolved variable says so instead of showing a value', async () => {
  await page.getByLabel('Request URL').fill('{{baseUrl}}/{{notAThing}}')
  await page.mouse.move(0, 0)
  await token('notAThing').hover()

  const card = page.locator('.var-card')
  await expect(card.locator('.var-card-value')).toHaveText('Not defined in this environment')
  // Nothing to copy when there is no value.
  await expect(card.getByRole('button', { name: 'Copy' })).toHaveCount(0)
})

test('copying a variable puts its value on the clipboard', async () => {
  await page.getByLabel('Request URL').fill('{{baseUrl}}/v{{apiVersion}}/sessions')
  // Move the pointer away first: it has not moved since the previous test, so a
  // hover onto the same coordinates would dispatch no mouse event at all.
  await page.mouse.move(0, 0)
  await token('apiVersion').hover()
  await page
    .locator('.var-card')
    .getByRole('button', { name: 'Copy the value of apiVersion' })
    .click()

  // The copy icon turns to a tick.
  await expect(page.locator('.var-card').getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect(page.locator('.var-card .copy-button.copied')).toHaveCount(1)
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('2')
})

test('collection variables resolve inside a header value too', async () => {
  // A send above put the editor aside.
  const show = page.getByRole('button', { name: 'Show the request editor' })
  if (await show.isVisible()) await show.click()
  const requestPane = page.locator('.request-pane')
  await requestPane.getByRole('button', { name: /^Headers/ }).click()

  const headerToken = requestPane.locator('.var-token', { hasText: '{{realm}}' })
  await expect(headerToken).toHaveClass(/resolved/)

  await page.mouse.move(0, 0)
  await headerToken.hover()
  // Scope to the pane: the URL bar's own card lingers briefly while the pointer
  // travels, so an unscoped locator can match two cards at once.
  const card = requestPane.locator('.var-card')
  await expect(card.locator('.var-card-value')).toHaveText('shop')
  await expect(card.locator('.var-card-origin')).toHaveText('checkout.yml')
})

test('a generated variable is marked dynamic rather than previewed', async () => {
  const requestPane = page.locator('.request-pane')
  await requestPane.getByRole('button', { name: /^Headers/ }).click()

  const dynamicToken = requestPane.locator('.var-token', { hasText: '{{$uuid}}' })
  await expect(dynamicToken).toHaveClass(/resolved/)

  await page.mouse.move(0, 0)
  await dynamicToken.hover()
  const card = requestPane.locator('.var-card')
  await expect(card.locator('.var-card-value')).toHaveText('Generated for each request')
  await expect(card.getByRole('button', { name: 'Copy' })).toHaveCount(0)
})

/* ------------------------------------------------- the choice sticks -- */

const openCollection = (name: string) => page.locator('.collection-row', { hasText: name }).click()

test('the chosen environment follows the environments directory, not the file', async () => {
  await openCollection('Checkout')
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('local')

  // A sibling collection resolving against the same environments/ keeps it.
  await openCollection('Refunds')
  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('local')

  await openCollection('Checkout')
  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('local')
})

test('changing it on one collection changes it for the set', async () => {
  await openCollection('Refunds')
  await page.getByLabel('Environment', { exact: true }).selectOption('other')

  await openCollection('Checkout')
  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('other')

  // And clearing it clears it for the set too.
  await page.getByLabel('Environment', { exact: true }).selectOption('')
  await openCollection('Refunds')
  await expect(page.getByLabel('Environment', { exact: true })).toHaveValue('')
})
