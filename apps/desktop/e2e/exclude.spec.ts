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
 * `exclude: true` leaves a collection out of group runs (`gta all`, a
 * directory). The app edits it in the collection settings drawer and marks it
 * in the sidebar and the collection header. On a step, it is put there from the
 * step's ⋯, marked on its row, and a chip on its request bar takes it off; Run
 * all leaves the step out, as `gta all` does, and Send still sends it.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let ordersFile: string
let flowFile: string
let server: http.Server
let received: string[] = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-exclude-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'legacy.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    ['id: legacy', 'tags: [api]', 'steps:', '  - name: browse', '    GET: /browse', ''].join('\n')
  )
  ordersFile = path.join(repo, 'collections', 'orders.yml')
  fs.writeFileSync(
    ordersFile,
    [
      'id: orders',
      'setup:',
      '  - name: grant',
      '    POST: /grant',
      'steps:',
      '  - name: create',
      '    POST: /orders',
      '  - name: refund',
      '    POST: /refund',
      ''
    ].join('\n')
  )
  flowFile = path.join(repo, 'collections', 'flow.yml')
  fs.writeFileSync(
    flowFile,
    [
      'id: flow',
      'setup:',
      '  - name: seed',
      `    POST: "${origin}/seed"`,
      'steps:',
      '  - name: first',
      `    GET: "${origin}/first"`,
      '  - name: second',
      `    GET: "${origin}/second"`,
      '    exclude: true',
      '  - name: third',
      `    GET: "${origin}/third"`,
      ''
    ].join('\n')
  )
  fs.mkdirSync(path.join(repo, 'requests'))
  fs.writeFileSync(
    path.join(repo, 'requests', 'login.yml'),
    ['id: login', 'params: {}', 'steps:', '  - name: log in', '    POST: /login', ''].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await sidebarRow().click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(file, 'utf8')
const sidebarRow = () => page.locator('.collection-row', { hasText: 'Legacy' })
const badge = () => page.locator('.collection-header .excluded-badge')

test('excluding a collection writes exclude: true after its tags and marks it', async () => {
  await expect(sidebarRow()).not.toHaveClass(/excluded/)
  await expect(badge()).toHaveCount(0)

  await page.getByRole('button', { name: 'Collection settings' }).click()
  const toggle = page
    .getByRole('dialog', { name: 'Collection settings' })
    .getByRole('switch', { name: 'Exclude from group runs' })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()

  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toMatch(/^id: legacy\ntags: \[api\]\nexclude: true\nsteps:/)
  await page.keyboard.press('Escape')

  await expect(badge()).toHaveText('Excluded')
  // The sidebar follows the file, via the watcher.
  await expect(sidebarRow()).toHaveClass(/excluded/, { timeout: 5_000 })
  await expect(sidebarRow().getByLabel('excluded from group runs')).toBeVisible()
})

test('the badge opens the drawer, and turning it off removes the key', async () => {
  await badge().click()
  const toggle = page
    .getByRole('dialog', { name: 'Collection settings' })
    .getByRole('switch', { name: 'Exclude from group runs' })
  await toggle.click()
  await expect.poll(onDisk, { timeout: 5_000 }).not.toContain('exclude')
  expect(onDisk()).toMatch(/^id: legacy\ntags: \[api\]\nsteps:/)
  await page.keyboard.press('Escape')

  await expect(badge()).toHaveCount(0)
  await expect(sidebarRow()).not.toHaveClass(/excluded/, { timeout: 5_000 })
})

test('an excluded collection opened from disk shows as excluded', async () => {
  fs.writeFileSync(file, onDisk().replace('steps:', 'exclude: true\nsteps:'))
  await expect(sidebarRow()).toHaveClass(/excluded/, { timeout: 5_000 })
  await expect(badge()).toHaveText('Excluded', { timeout: 5_000 })
})

const ordersOnDisk = () => fs.readFileSync(ordersFile, 'utf8')
const stepRow = (name: string) => page.locator('.step-list li', { hasText: name })
const chip = () => page.locator('.step-exclude-chip')

test('a step is excluded from its ⋯, written after its URL, and marked', async () => {
  await page.locator('.collection-row', { hasText: /orders/i }).click()
  await stepRow('refund').locator('.step-open').click()
  await expect(stepRow('refund')).not.toHaveClass(/excluded/)
  await expect(chip()).toHaveCount(0)

  await page.getByRole('button', { name: 'More actions for refund' }).click()
  await page.getByRole('menuitem', { name: 'Exclude from group runs' }).click()
  await expect
    .poll(ordersOnDisk, { timeout: 5_000 })
    .toContain('  - name: refund\n    POST: /refund\n    exclude: true\n')

  await expect(stepRow('refund')).toHaveClass(/excluded/)
  await expect(stepRow('refund').getByLabel('excluded from group runs')).toBeVisible()
  await expect(stepRow('create')).not.toHaveClass(/excluded/)
  await expect(chip()).toHaveText('⊘ excluded')
})

test('a setup step offers no exclude, and the chip takes a step’s off', async () => {
  const more = page.getByRole('button', { name: 'More actions for grant' })
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Exclude from group runs' })).toHaveCount(0)
  await more.click()

  await chip().click()
  const toggle = page
    .getByRole('dialog', { name: 'Group runs' })
    .getByRole('switch', { name: 'Exclude from group runs' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect.poll(ordersOnDisk, { timeout: 5_000 }).not.toContain('exclude')
  await expect(chip()).toHaveCount(0)
  await expect(stepRow('refund')).not.toHaveClass(/excluded/)
})

test('an excluded step written on disk shows as excluded, and its ⋯ puts it back', async () => {
  fs.writeFileSync(
    ordersFile,
    ordersOnDisk().replace('    POST: /orders\n', '    POST: /orders\n    exclude: true\n')
  )
  await expect(stepRow('create')).toHaveClass(/excluded/, { timeout: 5_000 })

  await page.getByRole('button', { name: 'More actions for create' }).click()
  await page.getByRole('menuitem', { name: 'Include in group runs' }).click()
  await expect.poll(ordersOnDisk, { timeout: 5_000 }).not.toContain('exclude')
  await expect(stepRow('create')).not.toHaveClass(/excluded/)
})

test('a reusable requests file’s steps offer no exclude: the use step is what is left out', async () => {
  await page
    .getByRole('group', { name: /^Reusable requests of / })
    .getByText('login')
    .click()
  await expect(page.locator('.collection-header h1')).toHaveText('login')
  const more = page.getByRole('button', { name: 'More actions for log in' })
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /group runs/ })).toHaveCount(0)
  await more.click()
})

test('Run all leaves an excluded step out, as gta all does, and Send still sends it', async () => {
  await page.locator('.collection-row', { hasText: /flow/i }).click()
  await expect(stepRow('second')).toHaveClass(/excluded/)
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toBeVisible({ timeout: 15_000 })
  expect(received).toEqual(['/seed', '/first', '/third'])
  await expect(stepRow('first').locator('.step-summary')).toHaveText(/^200 · /)
  await expect(stepRow('third').locator('.step-summary')).toHaveText(/^200 · /)
  await expect(stepRow('second').locator('.step-summary')).toHaveCount(0)

  received = []
  await stepRow('second').locator('.step-open').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(stepRow('second').locator('.step-summary')).toHaveText(/^200 · /)
  expect(received).toEqual(['/second'])
})

test('with every step excluded, Run all has nothing to run', async () => {
  fs.writeFileSync(
    flowFile,
    fs
      .readFileSync(flowFile, 'utf8')
      .replace(/(\/first"\n)/, '$1    exclude: true\n')
      .replace(/(\/third"\n)/, '$1    exclude: true\n')
  )
  await expect(stepRow('third')).toHaveClass(/excluded/, { timeout: 5_000 })
  await expect(stepRow('first')).toHaveClass(/excluded/)
  await expect(page.getByRole('button', { name: 'Run all' })).toBeDisabled()
})
