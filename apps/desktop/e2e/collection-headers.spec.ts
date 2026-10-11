import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import YAML from 'yaml'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Collection headers: edited in the collection's settings, saved in place with
 * their comments, shown under each step's own, replaced by a step header of the
 * same name in any case, and sent.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let received: http.IncomingHttpHeaders = {}
/** The request's headers as they came, name and value in turn, a repeated one each time. */
let raw: string[] = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received = req.headers
    raw = req.rawHeaders
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-headers-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'shop.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    [
      'id: shop',
      'headers:',
      '  Accept: application/json # every step',
      'steps:',
      '  - name: plain',
      `    GET: "${origin}/plain"`,
      '    headers:',
      '      accept: text/plain',
      '  - name: browse',
      `    GET: "${origin}/browse"`,
      ''
    ].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const inherited = () => page.getByRole('region', { name: 'Headers from the collection' })
const drawer = () => page.getByRole('dialog', { name: 'Collection settings' })
const headersTab = () => page.locator('.request-pane .tabs button', { hasText: 'Headers' })
const openStep = (name: string) =>
  page.locator('.step-list li', { hasText: name }).locator('.step-open').click()

test('a step shows the collection’s headers under its own, and which it replaces', async () => {
  await openStep('plain')
  await headersTab().click()
  await expect(inherited().locator('tr')).toHaveText([
    'Acceptapplication/jsonreplaced by this step'
  ])
  await expect(headersTab()).toContainText('1')

  await openStep('browse')
  await expect(inherited().locator('tr')).toHaveText(['Acceptapplication/json'])
  await expect(inherited().locator('tr.unused')).toHaveCount(0)
})

test('a collection header is added in its settings and saved in place', async () => {
  await inherited().getByRole('button', { name: 'Edit the collection’s headers' }).click()
  await expect(drawer()).toBeVisible()
  await drawer().getByPlaceholder('Name').last().fill('X-Client')
  // The blank row became X-Client, and a new blank row followed it.
  await drawer().getByPlaceholder('Value').nth(1).fill('gta')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('headers:\n  Accept: application/json # every step\n  X-Client: gta\nsteps:')
  await page.keyboard.press('Escape')
  await expect(drawer()).toHaveCount(0)
  await expect(inherited().locator('tr')).toHaveText(['Acceptapplication/json', 'X-Clientgta'])
})

test('a send carries the collection’s headers, with the step’s replacing its own', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received['accept']).toBe('application/json')
  expect(received['x-client']).toBe('gta')

  await openStep('plain')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  expect(received['accept']).toBe('text/plain')
  expect(received['x-client']).toBe('gta')
})

test('removing every collection header removes the key', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const remove = drawer().getByRole('button', { name: 'Remove row' })
  await remove.first().click()
  await remove.first().click()
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('X-Client')
  expect(onDisk()).toMatch(/^id: shop\nsteps:/)
  await page.keyboard.press('Escape')
  await expect(inherited()).toHaveCount(0)
})

test('a header given more than once is sent once per value, a value switched off kept but not sent', async () => {
  await openStep('browse')
  // A response came for it before: the editor stepped aside for it.
  const show = page.getByRole('button', { name: 'Show the request editor' })
  if (await show.count()) await show.click()
  await headersTab().click()
  const rows = page.locator('.request-pane .tab-body table').first().locator('tbody tr')
  const fill = async (index: number, name: string, value: string) => {
    await rows.nth(index).locator('input').nth(1).fill(name)
    await rows.nth(index).locator('input').nth(2).fill(value)
  }
  await fill(0, 'X-Forwarded-For', '10.0.0.1')
  await fill(1, 'X-Forwarded-For', '10.0.0.2')
  // Another spelling of the same name is the same header.
  await fill(2, 'x-forwarded-for', '10.0.0.3')
  await rows.nth(2).getByRole('checkbox').uncheck()
  await expect
    .poll(() => YAML.parse(onDisk()).steps[1].headers, { timeout: 5_000 })
    .toEqual({ 'X-Forwarded-For': ['10.0.0.1', '10.0.0.2', { value: '10.0.0.3', enabled: false }] })

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
  const sent = raw.flatMap((name, i) =>
    i % 2 === 0 && name.toLowerCase() === 'x-forwarded-for' ? [raw[i + 1]] : []
  )
  expect(sent).toEqual(['10.0.0.1', '10.0.0.2'])

  // Read back as written: each value its own row, the one switched off unticked.
  await openStep('plain')
  await openStep('browse')
  await expect(rows.nth(2).getByRole('checkbox')).not.toBeChecked()
  await expect(rows.nth(0).getByRole('checkbox')).toBeChecked()
})
