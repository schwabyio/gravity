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
import { addProject } from './addProject'

/**
 * The project sidebar from the keyboard: ↑ and ↓ through its rows, opening
 * collections as they land; → and ← to open and close a folder or project.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let app: ElectronApplication
let page: Page

const collection = (dir: string, id: string) => {
  const file = path.join(dir, 'collections', `${id}.yml`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `id: ${path.basename(id)}\nsteps:\n  - name: one\n    GET: "http://127.0.0.1:1/x"\n`
  )
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-sidebar-keys-')))
  const shop = path.join(tmp, 'shop')
  collection(shop, 'alpha')
  collection(shop, 'beta')
  collection(shop, 'smoke/gamma')
  const billing = path.join(tmp, 'billing')
  collection(billing, 'invoices')
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await addProject(app, page, billing)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const open = () => page.locator('.collection-header h1')
const focused = () =>
  page.evaluate(() => {
    const active = (
      globalThis as unknown as { document: { activeElement: { textContent: string } | null } }
    ).document.activeElement
    return active?.textContent?.trim() ?? ''
  })

// The rows, top to bottom: shop, its folder smoke (open) and gamma in it, alpha, beta;
// billing, invoices.

test('↑ and ↓ go through the rows, opening each collection they land on', async () => {
  await page.locator('.collection-row', { hasText: 'alpha' }).click()
  await expect(open()).toHaveText('alpha')

  await page.keyboard.press('ArrowDown')
  await expect(open()).toHaveText('beta')
  await expect.poll(focused).toContain('beta')

  // A project heading is only focused: the open collection stays.
  await page.keyboard.press('ArrowDown')
  await expect.poll(focused).toContain('billing')
  await expect(open()).toHaveText('beta')
  await page.keyboard.press('ArrowDown')
  await expect(open()).toHaveText('invoices')

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(open()).toHaveText('beta')
})

test('← closes a folder and → opens it, its collections there to land on only while open', async () => {
  await page.keyboard.press('ArrowUp')
  await expect(open()).toHaveText('alpha')
  await page.keyboard.press('ArrowUp')
  await expect(open()).toHaveText('gamma')
  // A folder is only focused: the open collection stays.
  await page.keyboard.press('ArrowUp')
  await expect.poll(focused).toContain('smoke')
  await expect(open()).toHaveText('gamma')
  const folder = page.locator('.group-row', { hasText: 'smoke' })
  await expect(folder).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('ArrowLeft')
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  // Closed, the folder's collection is passed by.
  await page.keyboard.press('ArrowDown')
  await expect(open()).toHaveText('alpha')

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(open()).toHaveText('gamma')
})

test('Home and End go to the first and last rows; ← and → close and open a project', async () => {
  await page.keyboard.press('Home')
  await expect.poll(focused).toContain('shop')
  const heading = page.locator('.repo-toggle', { hasText: 'shop' })
  await page.keyboard.press('ArrowLeft')
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.collection-row', { hasText: 'alpha' })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(heading).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('End')
  await expect(open()).toHaveText('invoices')
})
