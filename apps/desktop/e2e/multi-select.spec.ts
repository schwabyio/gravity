import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Picking several steps at once — ⌘- or Ctrl-click, Shift-click, ⌘A or
 * Ctrl+A — and deleting them together from a right-click.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-multi-')))
  const repo = path.join(tmp, 'shop')
  file = path.join(repo, 'collections', 'orders.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: orders',
      'steps:',
      ...['a', 'b', 'c', 'd', 'e'].flatMap((name) => [
        `  - name: ${name}`,
        `    GET: "http://127.0.0.1:1/${name}"`
      ]),
      ''
    ].join('\n')
  )
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const row = (name: string) =>
  page.locator('.step-list > li', { has: page.locator('.step-name', { hasText: name }) })
const picked = () => page.locator('.step-list > li.picked .step-name')
const onDisk = () =>
  (
    (YAML.parse(fs.readFileSync(file, 'utf8')) as { steps: Array<{ name: string }> }).steps ?? []
  ).map((step) => step.name)

test('⌘- or Ctrl-click picks steps, and their right-click deletes them together', async () => {
  await row('b').locator('.step-open').click()
  await row('d')
    .locator('.step-open')
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(picked()).toHaveText(['b', 'd'])
  // The editor stays on the step that was selected.
  await expect(page.locator('.collection-step-name')).toHaveText('b')

  await row('d').locator('.step-open').click({ button: 'right' })
  const remove = page.getByRole('menuitem', { name: 'Delete 2 steps' })
  await expect(page.getByRole('menu')).toHaveCount(1)
  page.once('dialog', (dialog) => void dialog.accept())
  await remove.click()
  await expect.poll(onDisk, { timeout: 5_000 }).toEqual(['a', 'c', 'e'])
  await expect(page.locator('.step-list .step-name')).toHaveText(['a', 'c', 'e'])
  await expect(picked()).toHaveCount(0)
})

test('Shift-click picks a run; Escape, a plain click or another step’s right-click leave one', async () => {
  await row('a').locator('.step-open').click()
  await row('c')
    .locator('.step-open')
    .click({ modifiers: ['Shift'] })
  await expect(picked()).toHaveText(['a', 'c'])
  await page.keyboard.press('Escape')
  await expect(picked()).toHaveCount(0)

  await row('c')
    .locator('.step-open')
    .click({ modifiers: ['Shift'] })
  await expect(picked()).toHaveText(['a', 'c'])
  // A step outside the picks gets its own menu, and the picks go.
  await row('e').locator('.step-open').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  await expect(picked()).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.collection-header').click()
})

test('⌘A or Ctrl+A picks every step, and Delete all removes them', async () => {
  await row('a').locator('.step-open').click()
  await page.keyboard.press('ControlOrMeta+a')
  await expect(picked()).toHaveText(['a', 'c', 'e'])
  await row('c').locator('.step-open').click({ button: 'right' })
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('Delete 3 steps? This removes them from the file.')
    void dialog.accept()
  })
  await page.getByRole('menuitem', { name: 'Delete all 3 steps' }).click()
  await expect.poll(onDisk, { timeout: 5_000 }).toEqual([])
  await expect(page.locator('.step-list .step-name')).toHaveCount(0)
})
