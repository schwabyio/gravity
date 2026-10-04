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
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Tags: a collection's select all of it; a step's — only with step tags on in
 * the collection's settings — are edited, listed, and filter the list and Run.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-tags-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'shop.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    [
      'id: shop',
      'stepTags: true',
      'steps:',
      '  - name: browse',
      `    GET: "${origin}/browse"`,
      '    tags: [smoke]',
      '  - name: login',
      `    POST: "${origin}/login"`,
      '    tags: [auth, smoke]',
      '  - name: checkout',
      `    POST: "${origin}/checkout"`,
      ''
    ].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
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
const row = (name: string) => page.locator('.step-list li', { hasText: name })
const stepTags = () => page.getByRole('group', { name: 'step tags' })
const collectionTags = () => page.getByRole('group', { name: 'collection tags' })

test('the list shows each step’s tags', async () => {
  await expect(row('browse').locator('.step-tags .tag')).toHaveText(['smoke'])
  await expect(row('login').locator('.step-tags .tag')).toHaveText(['auth', 'smoke'])
  await expect(row('checkout').locator('.step-tags')).toHaveCount(0)
  // The selected step's tags are in the header, editable.
  await expect(stepTags().locator('.tag')).toHaveText(['smoke×'])
})

test('a step tag is added with suggestions, and saved on one line', async () => {
  await stepTags().getByRole('button', { name: 'Add a tag to step' }).click()
  await page.keyboard.type('au')
  await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toHaveText('auth')
  await page.getByRole('option', { name: 'auth' }).click()
  await page.keyboard.type('slow')
  await page.keyboard.press('Enter')
  await expect(stepTags().locator('.tag')).toHaveText(['smoke×', 'auth×', 'slow×'])
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('    tags: [smoke, auth, slow]')
})

test('a tag that is not a tag is refused as it is typed', async () => {
  await page.keyboard.type('has space')
  await expect(page.getByRole('alert')).toHaveText('Letters, digits and - _ . : only')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(stepTags().locator('.tag')).toHaveText(['smoke×', 'auth×', 'slow×'])
})

test('a step tag is removed with ×', async () => {
  await stepTags().getByRole('button', { name: 'Remove tag slow from step' }).click()
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('    tags: [smoke, auth]\n')
})

test('collection tags go after the name, and are not repeated on the steps', async () => {
  await collectionTags().getByRole('button', { name: 'Add a tag to collection' }).click()
  await page.keyboard.type('api')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toMatch(/^id: shop\ntags: \[api\]\nstepTags: true\nsteps:/)
  await expect(stepTags().locator('.tag')).toHaveText(['smoke×', 'auth×'])
  await expect(row('checkout').locator('.step-tags')).toHaveCount(0)
  // They select the whole collection, so there is nothing to filter by.
  await expect(
    page.getByRole('group', { name: 'Filter steps by tag' }).getByRole('button', { name: 'api' })
  ).toHaveCount(0)
})

test('filtering by tag narrows the list, and Run runs only what it shows', async () => {
  const filter = page.getByRole('group', { name: 'Filter steps by tag' })
  // browse gained auth above; checkout has neither.
  await filter.getByRole('button', { name: 'auth' }).click()
  await expect(page.locator('.step-list li')).toHaveCount(2)
  await expect(row('checkout')).toHaveCount(0)
  await expect(filter).toContainText('2 of 3')

  await page.getByRole('button', { name: 'Run 2 steps' }).click()
  await expect(page.locator('.run-summary')).toContainText('2 passed', { timeout: 10_000 })
  await expect(row('login').locator('.step-summary')).toHaveText(/^200 · \d+ ms$/)
  // It has no tests, so nothing passed: no mark.
  await expect(row('login').locator('.step-mark')).toHaveCount(0)

  // The others were not run.
  await filter.getByRole('button', { name: 'Clear' }).click()
  await expect(page.locator('.step-list li')).toHaveCount(3)
  await expect(row('checkout').locator('.step-mark')).toHaveCount(0)
  await expect(row('checkout').locator('.step-summary')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run all' })).toBeVisible()
})

test('turning step tags off asks first, then takes every step tag with it', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  const toggle = drawer.getByRole('switch', { name: 'Step tags' })
  await expect(toggle).toBeChecked()

  // Changing your mind leaves everything as it was.
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void dialog.dismiss()
  })
  await toggle.click()
  expect(asked).toBe('Remove the tags from 2 steps?')
  await expect(toggle).toBeChecked()

  page.once('dialog', (dialog) => void dialog.accept())
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('stepTags')
  expect(onDisk()).toMatch(/^id: shop\ntags: \[api\]\nsteps:/)
  expect(onDisk()).not.toContain('    tags:')

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(stepTags()).toHaveCount(0)
  await expect(page.locator('.step-list .step-tags')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Filter steps by tag' })).toHaveCount(0)
})

test('turning step tags back on writes it after the collection tags', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  await page.getByRole('switch', { name: 'Step tags' }).click()
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toMatch(/^id: shop\ntags: \[api\]\nstepTags: true\nsteps:/)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(stepTags().getByRole('button', { name: 'Add a tag to step' })).toBeVisible()
})
