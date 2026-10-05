import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * The request's method, picked from a list the app draws, each method in its
 * own color as everywhere else it appears — on macOS too, where a system
 * dropdown opens the system's uncolored menu.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-methods-')))
  file = path.join(tmp, 'orders-api', 'collections', 'orders.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'id: orders\nsteps:\n  - name: list\n    GET: http://127.0.0.1:9/orders\n')
  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, path.join(tmp, 'orders-api'))
  await page.locator('.collection-row').click()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const picker = () => page.getByRole('button', { name: 'HTTP method' })
const list = () => page.getByRole('listbox', { name: 'HTTP method' })
const onDisk = () => fs.readFileSync(file, 'utf8')
/** The page's own window, for reading a color as it is drawn (these specs build without the DOM's types). */
type Drawn = { getComputedStyle: (element: unknown) => { color: string } }

test('lists every method, each in a color of its own, the chosen one marked', async () => {
  await expect(picker().locator('.method')).toHaveClass(/m-get/)
  await picker().click()
  await expect(list().getByRole('option')).toHaveText([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS'
  ])
  await expect(list().getByRole('option', { name: 'GET' })).toHaveAttribute('aria-selected', 'true')
  const colors = await list()
    .locator('.method')
    .evaluateAll((pills) =>
      pills.map((pill) => (globalThis as unknown as Drawn).getComputedStyle(pill).color)
    )
  expect(new Set(colors).size).toBe(7)
  // The same color as the step list gives the method.
  const inList = await page
    .locator('.step-list .method')
    .first()
    .evaluate((pill) => (globalThis as unknown as Drawn).getComputedStyle(pill).color)
  expect(colors[0]).toBe(inList)
})

test('a click picks a method, and it is saved', async () => {
  await list().getByRole('option', { name: 'POST' }).click()
  await expect(list()).toHaveCount(0)
  await expect(picker().locator('.method')).toHaveText('POST')
  await expect(page.locator('.step-list .method').first()).toHaveClass(/m-post/)
  await expect.poll(onDisk).toContain('POST: http://127.0.0.1:9/orders')
})

test('works from the keyboard: arrows, a letter, Enter, Escape', async () => {
  await picker().focus()
  await page.keyboard.press('ArrowDown')
  await expect(list()).toBeVisible()
  // From POST, P is the next method starting with it: PUT, then PATCH.
  await page.keyboard.press('p')
  await page.keyboard.press('p')
  await page.keyboard.press('Enter')
  await expect(list()).toHaveCount(0)
  await expect(picker().locator('.method')).toHaveText('PATCH')
  await expect(picker()).toBeFocused()

  await page.keyboard.press('Enter')
  await page.keyboard.press('End')
  await page.keyboard.press('Escape')
  await expect(list()).toHaveCount(0)
  await expect(picker().locator('.method')).toHaveText('PATCH')
  await expect.poll(onDisk).toContain('PATCH: http://127.0.0.1:9/orders')
})

test('a click elsewhere closes it, unchanged', async () => {
  await picker().click()
  await expect(list()).toBeVisible()
  await page.locator('.collection-header h1').click()
  await expect(list()).toHaveCount(0)
  await expect(picker().locator('.method')).toHaveText('PATCH')
})
