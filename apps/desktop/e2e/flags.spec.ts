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

/**
 * Feature flags (SPEC.md §2.9) in the app: an environment's fixed values and
 * its command, shown with where each came from; steps a flag skips marked and
 * not run; overrides and Refresh; and flag conditions edited in the files.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let repo: string
let collectionFile: string
let environmentFile: string
let script: string
let server: http.Server
let seen: string[] = []
let app: ElectronApplication
let page: Page

/**
 * What the flag command prints next, as JSON. Writing the script changes the
 * project, which reloads the flags about 200 ms later; failing takes a second, so
 * that reload lands while a Refresh is still running, as it can on a slow machine.
 */
const serve = (flags: Record<string, unknown> | 'fail') =>
  fs.writeFileSync(
    script,
    flags === 'fail'
      ? 'setTimeout(() => { console.error("flag service unreachable"); process.exit(2) }, 1000)\n'
      : `console.log(${JSON.stringify(JSON.stringify(flags))})\n`
  )

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-flags-')))
  repo = path.join(tmp, 'shop-api')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'environments'), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  script = path.join(repo, 'flags.cjs')
  serve({ newCheckout: true })
  environmentFile = path.join(repo, 'environments', 'local.yml')
  fs.writeFileSync(
    environmentFile,
    [
      'name: local',
      'vars:',
      '  env: local',
      'flags:',
      // Quoted: Node may be under C:\Program Files.
      `  command: '${JSON.stringify(process.execPath)} flags.cjs'`,
      '  values:',
      '    newCheckout: false',
      '    region: eu',
      ''
    ].join('\n')
  )
  collectionFile = path.join(repo, 'collections', 'shop.yml')
  fs.writeFileSync(
    collectionFile,
    [
      'id: shop',
      'steps:',
      '  - name: new checkout',
      `    GET: "${origin}/new"`,
      '    flags: { newCheckout: true }',
      '  - name: old checkout',
      `    GET: "${origin}/old"`,
      '    flags: { newCheckout: false }',
      '  - name: always',
      `    GET: "${origin}/always"`,
      ''
    ].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForSelector('.sidebar')
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, repo)
  await page.getByRole('button', { name: '+ Project' }).click()
  await page.locator('.collection-row', { hasText: 'shop' }).click()
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const drawer = () => page.getByRole('dialog', { name: 'Feature flags' })
const flagRow = (name: string) => drawer().locator('tr', { hasText: name })
const stepRow = (name: string) => page.locator('.step-list li', { hasText: name })
const onDisk = (file: string) => fs.readFileSync(file, 'utf8')

const runAll = async () => {
  seen = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toBeVisible({ timeout: 15_000 })
}

test('the drawer lists each flag with where it came from', async () => {
  await expect(page.getByRole('button', { name: 'Feature flags' })).toContainText('2')
  await page.getByRole('button', { name: 'Feature flags' }).click()
  await expect(flagRow('newCheckout')).toContainText('command')
  await expect(
    flagRow('newCheckout').getByRole('switch', { name: 'Flag newCheckout' })
  ).toBeChecked()
  await expect(flagRow('region')).toContainText('environment file')
  await expect(drawer().locator('.flags-command code')).toContainText('flags.cjs')
  await page.keyboard.press('Escape')
})

test('a step its flags skip is marked, and Run all does not send it', async () => {
  await expect(stepRow('old checkout').locator('.step-flag')).toHaveText('skipped')
  await expect(stepRow('old checkout').locator('.step-flag')).toHaveAttribute(
    'aria-label',
    'skipped: feature flag newCheckout is on'
  )
  await expect(stepRow('new checkout').locator('.step-flag')).toHaveCount(0)
  await runAll()
  expect(seen.sort()).toEqual(['/always', '/new'])
  await expect(page.locator('.run-summary')).toContainText('1 skipped')
  await expect(stepRow('old checkout').locator('.step-status')).toHaveText('skipped')

  // Run on its own, it is skipped the same way, and the response pane says why.
  seen = []
  await page.getByRole('button', { name: 'Run old checkout' }).click()
  await stepRow('old checkout').locator('.step-open').click()
  await expect(page.locator('.placeholder.skipped')).toContainText(
    'feature flag newCheckout is on — nothing was sent'
  )
  expect(seen).toEqual([])
})

test('an override flips which step runs, and clearing it flips back', async () => {
  await page.getByRole('button', { name: 'Feature flags' }).click()
  await flagRow('newCheckout').getByRole('switch', { name: 'Flag newCheckout' }).click()
  await expect(flagRow('newCheckout')).toContainText('override')
  await page.keyboard.press('Escape')
  await expect(stepRow('new checkout').locator('.step-flag')).toHaveText('skipped')
  await runAll()
  expect(seen.sort()).toEqual(['/always', '/old'])

  await page.getByRole('button', { name: 'Feature flags' }).click()
  await drawer().getByRole('button', { name: 'Clear override of newCheckout' }).click()
  await expect(flagRow('newCheckout')).toContainText('command')
  await page.keyboard.press('Escape')
  await expect(stepRow('old checkout').locator('.step-flag')).toHaveText('skipped')
})

test('Refresh runs the command again, and a failing one says why', async () => {
  serve({ newCheckout: false, pricing: 'v2' })
  await page.getByRole('button', { name: 'Feature flags' }).click()
  await drawer().getByRole('button', { name: 'Refresh' }).click()
  await expect(flagRow('pricing').getByLabel('Flag pricing')).toHaveValue('v2')
  await expect(
    flagRow('newCheckout').getByRole('switch', { name: 'Flag newCheckout' })
  ).not.toBeChecked()

  serve('fail')
  await drawer().getByRole('button', { name: 'Refresh' }).click()
  await expect(drawer().locator('.flags-error')).toContainText('flag service unreachable')
  // Runs go on with the fixed values.
  await expect(flagRow('region')).toContainText('environment file')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Feature flags' })).toHaveClass(/warn/)

  serve({ newCheckout: true })
  await page.getByRole('button', { name: 'Feature flags' }).click()
  await drawer().getByRole('button', { name: 'Refresh' }).click()
  await expect(drawer().locator('.flags-error')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('collection and step flags are edited into the file', async () => {
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Collection settings' })
  await settings.getByRole('button', { name: '+ Add flag' }).click()
  await settings.getByLabel('collection flag name').fill('region')
  await settings.getByLabel('collection flag region value').fill('eu')
  await expect
    .poll(() => onDisk(collectionFile), { timeout: 5_000 })
    .toMatch(/^id: shop\nflags:\n {2}region: eu\nsteps:/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.flag-chip')).toHaveText('region: eu')

  await stepRow('always').locator('.step-open').click()
  const stepFlags = page.locator('.step-flags')
  await stepFlags.locator('summary').click()
  await stepFlags.getByRole('button', { name: '+ Add a flag this step needs' }).click()
  await stepFlags.getByLabel('step flag name').fill('pricing')
  await stepFlags.getByLabel('step flag pricing value').fill('2')
  await expect
    .poll(() => onDisk(collectionFile), { timeout: 5_000 })
    .toMatch(/- name: always\n {4}GET: "[^"]+"\n {4}flags:(\n {6}| \{ )pricing: 2/)
})

test('a flag the environment does not declare shows as an error', async () => {
  // `pricing` is not in the environment now: the command prints only newCheckout.
  await expect(stepRow('always').locator('.step-flag')).toHaveText('flag?')
  await expect(stepRow('always').locator('.step-flag')).toHaveAttribute(
    'aria-label',
    /flag error: feature flag pricing is not known/
  )
})

test('environment flags are edited into the environment file', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  const environments = page.getByRole('dialog', { name: 'Environments' })
  await environments.getByRole('button', { name: '+ Add a fixed flag value' }).click()
  const names = environments.getByLabel('environment flag name')
  await names.last().fill('pricing')
  await environments.getByLabel('environment flag pricing value').fill('2')
  await expect
    .poll(() => onDisk(environmentFile), { timeout: 5_000 })
    .toMatch(/values:\n {4}newCheckout: false\n {4}region: eu\n {4}pricing: 2\n/)
  await page.keyboard.press('Escape')
  // Declared now: the step's condition holds.
  await expect(stepRow('always').locator('.step-flag')).toHaveCount(0, { timeout: 5_000 })
})
