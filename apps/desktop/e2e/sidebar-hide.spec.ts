import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * The collections pane hidden for the main pane's room: to a strip that
 * brings it back as it was, from its head or ⌘B (Ctrl+B off a Mac), and
 * remembered between launches.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let userData: string
let app: ElectronApplication
let page: Page

const sidebar = () => page.locator('.sidebar')
const strip = () => page.getByRole('button', { name: 'Show the collections pane' })
const hide = () => page.getByRole('button', { name: 'Hide the collections pane' })
const handle = () => page.getByRole('separator', { name: 'Resize the collections pane' })
const billing = () => page.locator('.repo-toggle', { hasText: 'billing' })
const widthOf = async (selector: string) => (await page.locator(selector).boundingBox())!.width

const collection = (dir: string, id: string) => {
  const file = path.join(dir, 'collections', `${id}.yml`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `id: ${id}\nsteps:\n  - name: one\n    GET: "http://127.0.0.1:1/x"\n`)
}

async function launch() {
  app = await launchApp({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.layout')
}

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-sidebar-hide-')))
  userData = path.join(tmp, 'ud')
  const shop = path.join(tmp, 'shop')
  collection(shop, 'alpha')
  const billingFolder = path.join(tmp, 'billing')
  collection(billingFolder, 'invoices')
  await launch()
  await addProject(app, page, shop)
  await addProject(app, page, billingFolder)
  await page.locator('.collection-row', { hasText: 'alpha' }).click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('hidden from its head, the pane leaves a strip and the workbench takes its room', async () => {
  // Wider than it starts, and with a project closed: what it comes back as.
  await handle().focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await billing().click()
  await expect(billing()).toHaveAttribute('aria-expanded', 'false')
  expect(await widthOf('.sidebar')).toBe(332)
  const before = await widthOf('.workbench')

  await page.mouse.move(0, 0)
  await hide().hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    /^Hide the collections pane for more room \((⌘|Ctrl\+)B\)$/
  )
  await hide().click()
  await expect(sidebar()).toBeHidden()
  await expect(strip()).toHaveText('Collections ▸')
  expect(await widthOf('.workbench')).toBe(before + 332 - 28)
  // The collection stays open.
  await expect(page.locator('.collection-header h1')).toHaveText('alpha')
})

test('the strip brings it back as it was: its width, and its project still closed', async () => {
  await strip().click()
  await expect(sidebar()).toBeVisible()
  await expect(strip()).toHaveCount(0)
  expect(await widthOf('.sidebar')).toBe(332)
  await expect(billing()).toHaveAttribute('aria-expanded', 'false')
  await billing().click()
  await expect(billing()).toHaveAttribute('aria-expanded', 'true')
})

test('⌘B hides and shows it, wherever focus is', async () => {
  await page.locator('.collection-row', { hasText: 'alpha' }).focus()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(sidebar()).toBeHidden()

  await page.locator('.step-open').first().click()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(sidebar()).toBeVisible()
})

test('in the docs editor ⌘B is Bold, and the pane stays', async () => {
  await page.getByRole('button', { name: '+ Docs' }).click()
  const box = page.getByRole('textbox', { name: 'Collection docs' })
  await expect(box).toBeFocused()
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('bold')
  await expect(box).toHaveText('**bold**')
  await expect(sidebar()).toBeVisible()
  await box.fill('')
  await page.keyboard.press('Escape')
})

test('hidden with a message in it, the strip says so', async () => {
  // + Project at a folder that is not there: the pane says why, until dismissed.
  await app.evaluate(
    ({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    },
    path.join(tmp, 'missing')
  )
  await page.getByRole('button', { name: '+ Project' }).click()
  await expect(page.locator('.sidebar-error')).toBeVisible()

  await hide().click()
  await expect(strip()).toHaveText('Collections · error ▸')
  await expect(strip()).toHaveClass(/failed/)
  await strip().click()
  await page.locator('.sidebar-error').getByRole('button', { name: 'Dismiss' }).click()
  await hide().click()
  await expect(strip()).toHaveText('Collections ▸')
})

test('hidden, it stays hidden through a restart', async () => {
  await app.close()
  await launch()
  await expect(strip()).toBeVisible()
  await expect(sidebar()).toBeHidden()
  await strip().click()
  expect(await widthOf('.sidebar')).toBe(332)
})
