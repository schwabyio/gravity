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
 * Request settings: set for the whole collection in its settings drawer or for
 * a step in its Settings tab, inherited otherwise, saved to the file, and
 * honoured by the next send.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/final' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-settings-')))
  const repo = path.join(tmp, 'moves-api')
  file = path.join(repo, 'collections', 'moves.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    ['id: moves', 'steps:', '  - name: moved', `    GET: "${origin}/moved"`, ''].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.locator('.request-pane .tabs button', { hasText: 'Settings' }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const used = (label: string) =>
  page.getByRole('region', { name: label, exact: true }).locator('.setting-used')

test('with nothing set, every setting shows its default', async () => {
  await expect(used('Timeout')).toHaveText('0 msdefault')
  await expect(used('Follow redirects')).toHaveText('Ondefault')
  await expect(page.getByLabel('Max redirects for this step')).toHaveAttribute(
    'placeholder',
    'Inherit (5)'
  )
})

test('a collection setting is saved at the top, and the step inherits it', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await drawer.getByLabel('Timeout for the whole collection').fill('4000')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('id: moves\nsettings:\n  timeout: 4000\nsteps:')
  await expect(
    drawer.getByRole('region', { name: 'Timeout', exact: true }).locator('.setting-used')
  ).toHaveText('4000 mscollection')
  await drawer.getByRole('button', { name: 'Close' }).click()

  // The step tab has only the step's own fields, showing what they inherit.
  await expect(page.getByLabel('Timeout for the whole collection')).toHaveCount(0)
  await expect(used('Timeout')).toHaveText('4000 mscollection')
  await expect(page.getByLabel('Timeout for this step')).toHaveAttribute(
    'placeholder',
    'Inherit (4000)'
  )
})

test('a step setting overrides it, and the next send honours it', async () => {
  await page.getByLabel('Follow redirects for this step').selectOption('off')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toContain('    settings:\n      followRedirects: false')
  await expect(used('Follow redirects')).toHaveText('Offstep')

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('302')

  // Back to inheriting: the key goes, and the redirect is followed again.
  // (No tests on this step, so the request editor stays open after a send.)
  await page.getByLabel('Follow redirects for this step').selectOption('')
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('followRedirects')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
})

test('an invalid number is shown as such and never written', async () => {
  await page.getByLabel('Max redirects for this step').fill('2.5')
  await expect(page.getByRole('alert')).toHaveText('A whole number, 0 or more')
  await page.waitForTimeout(1500)
  expect(onDisk()).not.toContain('maxRedirects')

  await page.getByLabel('Max redirects for this step').fill('')
  await page.getByRole('button', { name: 'Collection settings' }).click()
  await page.getByLabel('Timeout for the whole collection').fill('')
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('settings')
  await page.keyboard.press('Escape')
})
