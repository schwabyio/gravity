import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { DEFAULT_WINDOW, sizeWindow } from './window'

/**
 * Edit and save: auto save and its setting, explicit saves, step structure, and
 * never writing over a change made outside the app.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let repo: string
let file: string
let userData: string
let app: ElectronApplication
let page: Page

const ORIGINAL = [
  '# Kept by every save.',
  'id: orders',
  'steps:',
  '  - name: list',
  '    GET: "http://127.0.0.1:1/orders" # the index',
  '',
  '  - name: create',
  '    POST: "http://127.0.0.1:1/orders"',
  '',
  '  - name: remove',
  '    DELETE: "http://127.0.0.1:1/orders/1"',
  ''
].join('\n')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
const onDisk = () => fs.readFileSync(file, 'utf8')
const reset = () => fs.writeFileSync(file, ORIGINAL)

async function launch() {
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-save-')))
  repo = path.join(tmp, 'orders-api')
  userData = path.join(tmp, 'ud')
  file = path.join(repo, 'collections', 'orders.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  git('init', '--initial-branch=main')
  reset()

  await launch()
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, repo)
  await page.getByRole('button', { name: '+ Project' }).click()
  await page.locator('.collection-row').click()
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/orders')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const url = () => page.getByLabel('Request URL')
const status = () => page.locator('.save-status')
const step = (name: string) => page.locator('.step-list li', { hasText: name })
const stepNames = () => page.locator('.step-list .step-name')

async function setAutoSave(enabled: boolean, delayMs?: number) {
  await page.getByRole('button', { name: 'App settings' }).click()
  const toggle = page.getByLabel('Auto save')
  if ((await toggle.isChecked()) !== enabled) await toggle.click()
  if (enabled) await expect(toggle).toBeChecked()
  else await expect(toggle).not.toBeChecked()
  if (delayMs !== undefined) {
    await page.getByLabel('Delay before saving').fill(String(delayMs))
    await page.getByLabel('Delay before saving').press('Enter')
  }
  await page.getByRole('button', { name: 'Close settings' }).click()
}

test('auto save is on by default and waits for typing to stop', async () => {
  await url().fill('http://127.0.0.1:1/orders?page=2')
  // Not straight away…
  expect(onDisk()).not.toContain('page=2')
  // …but about a second later, with everything else in the file untouched.
  await expect.poll(onDisk, { timeout: 5_000 }).toContain('GET: "http://127.0.0.1:1/orders?page=2"')
  await expect(status()).toHaveText('Saved')
  expect(onDisk()).toBe(ORIGINAL.replace('/orders" # the index', '/orders?page=2" # the index'))

  // Our own write coming back through the watcher is not a conflict.
  await page.waitForTimeout(600)
  await expect(page.locator('.banner')).toHaveCount(0)
  await url().fill('http://127.0.0.1:1/orders')
  await expect.poll(onDisk, { timeout: 5_000 }).toBe(ORIGINAL)
})

test('the setting persists, and with auto save off nothing is written until Save', async () => {
  await setAutoSave(false)
  const settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
  expect(settings.editing.autoSave).toEqual({ enabled: false, delayMs: 1000 })

  await url().fill('http://127.0.0.1:1/orders?manual=1')
  await page.locator('.step-open', { hasText: 'create' }).click()
  await url().fill('http://127.0.0.1:1/orders?manual=2')
  await expect(status()).toContainText('2 unsaved changes')
  await page.waitForTimeout(1500)
  expect(onDisk()).toBe(ORIGINAL)

  // One Save writes both edited steps.
  await status().getByRole('button', { name: 'Save' }).click()
  await expect(status()).toHaveText('Saved')
  expect(onDisk()).toContain('GET: "http://127.0.0.1:1/orders?manual=1"')
  expect(onDisk()).toContain('POST: "http://127.0.0.1:1/orders?manual=2"')

  reset()
  await expect(url()).toHaveValue('http://127.0.0.1:1/orders', { timeout: 15_000 })
})

test('steps can be added, renamed, duplicated, moved and deleted', async () => {
  await page.locator('.step-open', { hasText: 'list' }).click()
  // Structure changes write at once, whatever the auto save setting.
  await page.getByRole('button', { name: '+ Add step' }).click()
  await expect(stepNames()).toHaveText(['list', 'New step', 'create', 'remove'])
  await expect.poll(onDisk).toContain('- name: New step')

  await step('New step').locator('.step-open').dblclick()
  await page.getByLabel('Step name').fill('search')
  await page.getByLabel('Step name').press('Enter')
  await url().fill('http://127.0.0.1:1/orders/search')
  // Changing the method as well: one step is never left with no method, or two.
  await page.getByLabel('HTTP method').selectOption('POST')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(status()).toHaveText('Saved')
  await expect
    .poll(onDisk)
    .toContain('- name: search\n    POST: "http://127.0.0.1:1/orders/search"')

  await step('create').getByRole('button', { name: 'More actions for create' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(stepNames()).toHaveText(['list', 'search', 'create', 'create copy', 'remove'])

  await step('remove').getByRole('button', { name: 'More actions for remove' }).click()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  await expect(stepNames()).toHaveText(['list', 'search', 'create', 'remove', 'create copy'])

  page.once('dialog', (dialog) => void dialog.accept())
  await step('create copy').getByRole('button', { name: 'More actions for create copy' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(stepNames()).toHaveText(['list', 'search', 'create', 'remove'])

  // Every step the app did not touch is byte-for-byte what it was, comment included.
  const saved = onDisk()
  expect(saved).toContain('# Kept by every save.')
  expect(saved).toContain('    GET: "http://127.0.0.1:1/orders" # the index')
  expect(saved.indexOf('- name: search')).toBeLessThan(saved.indexOf('- name: create'))
  expect(saved.indexOf('- name: remove')).toBeGreaterThan(saved.indexOf('- name: create'))

  // Drag reorders too.
  await step('remove').dragTo(step('list'))
  await expect(stepNames()).toHaveText(['remove', 'list', 'search', 'create'])
  await expect
    .poll(() => onDisk().indexOf('- name: remove'))
    .toBeLessThan(onDisk().indexOf('- name: list'))

  reset()
  await expect(stepNames()).toHaveText(['list', 'create', 'remove'], { timeout: 15_000 })
})

test('an edit is never written over a change made outside the app', async () => {
  await setAutoSave(true, 3000)
  await page.locator('.step-open', { hasText: 'list' }).click()
  await url().fill('http://127.0.0.1:1/orders?mine=1')

  // Someone else changes another step before the auto save fires.
  const theirs = ORIGINAL.replace('/orders/1"', '/orders/2"')
  fs.writeFileSync(file, theirs)
  await expect(status()).toContainText('Changed on disk', { timeout: 15_000 })

  // Auto save does not overwrite it…
  await page.waitForTimeout(3500)
  expect(onDisk()).toBe(theirs)

  // …and Keep mine lays the edit over their version rather than replacing it.
  await status().getByRole('button', { name: 'Keep mine' }).click()
  await expect.poll(onDisk, { timeout: 10_000 }).toContain('/orders?mine=1')
  expect(onDisk()).toContain('/orders/2"')

  await setAutoSave(true, 1000)
  reset()
  await expect(url()).toHaveValue('http://127.0.0.1:1/orders', { timeout: 15_000 })
})

test('closing with unsaved edits asks, and Save writes them', async () => {
  await setAutoSave(false)
  await url().fill('http://127.0.0.1:1/orders?at-close=1')
  await expect(status()).toContainText('1 unsaved change')

  const asked = await app.evaluate(async ({ dialog, BrowserWindow }) => {
    let message = ''
    dialog.showMessageBox = (async (_window: unknown, options: { message: string }) => {
      message = options.message
      return { response: 0, checkboxChecked: false }
    }) as never
    const window = BrowserWindow.getAllWindows()[0]!
    const closed = new Promise<void>((resolve) => window.once('closed', () => resolve()))
    window.close()
    await closed
    return message
  })
  expect(asked).toBe('Save your changes before closing?')
  expect(onDisk()).toContain('/orders?at-close=1')

  await app.close()
  await launch()
})
