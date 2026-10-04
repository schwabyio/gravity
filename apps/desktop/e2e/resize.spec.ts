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
import { addProject } from './addProject'

/** Both dividers: drag, clamp, keyboard, reset, and remembered between launches. */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let userData: string
let repo: string
let app: ElectronApplication
let page: Page

const sidebar = () => page.locator('.sidebar')
const stepsColumn = () => page.locator('.steps-column')
const sidebarHandle = () => page.getByRole('separator', { name: 'Resize the collections pane' })
const stepsHandle = () => page.getByRole('separator', { name: 'Resize the steps pane' })

const widthOf = async (locator: ReturnType<typeof sidebar>) => (await locator.boundingBox())!.width

/** Drag a divider by a number of pixels. */
async function drag(handle: ReturnType<typeof sidebarHandle>, by: number) {
  const box = (await handle.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + by, y, { steps: 8 })
  await page.mouse.up()
}

async function launch() {
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-resize-')))
  userData = path.join(tmp, 'ud')
  repo = path.join(tmp, 'r')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  const file = path.join(repo, 'collections', 'c.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    'id: c\nsteps:\n  - name: one\n    GET: "http://example.test/1"\n  - name: two\n    GET: "http://example.test/2"\n'
  )

  await launch()
  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the collections pane drags wider and narrower', async () => {
  const before = await widthOf(sidebar())
  expect(before).toBe(300)

  await drag(sidebarHandle(), 80)
  expect(await widthOf(sidebar())).toBeCloseTo(before + 80, -1)

  await drag(sidebarHandle(), -120)
  expect(await widthOf(sidebar())).toBeCloseTo(before - 40, -1)
})

test('the steps pane drags independently of the collections pane', async () => {
  const sidebarBefore = await widthOf(sidebar())
  const stepsBefore = await widthOf(stepsColumn())

  await drag(stepsHandle(), 90)
  expect(await widthOf(stepsColumn())).toBeCloseTo(stepsBefore + 90, -1)
  // Dragging one must not move the other.
  expect(await widthOf(sidebar())).toBeCloseTo(sidebarBefore, -1)
})

test('a divider stops at its limits rather than collapsing the pane', async () => {
  await drag(sidebarHandle(), -2000)
  const min = await widthOf(sidebar())
  expect(min).toBe(200)

  await drag(sidebarHandle(), 3000)
  expect(await widthOf(sidebar())).toBe(560)
})

test('a divider is operable from the keyboard', async () => {
  await sidebarHandle().focus()
  await page.keyboard.press('Home')
  expect(await widthOf(sidebar())).toBe(200)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  expect(await widthOf(sidebar())).toBe(232)

  await page.keyboard.press('End')
  expect(await widthOf(sidebar())).toBe(560)
})

test('double-clicking a divider resets it', async () => {
  await sidebarHandle().dblclick()
  expect(await widthOf(sidebar())).toBe(300)

  await stepsHandle().dblclick()
  expect(await widthOf(stepsColumn())).toBe(320)
})

test('reports its size to assistive technology', async () => {
  await expect(sidebarHandle()).toHaveAttribute('aria-valuenow', '300')
  await expect(sidebarHandle()).toHaveAttribute('aria-valuemin', '200')
  await expect(sidebarHandle()).toHaveAttribute('aria-valuemax', '560')
  await expect(sidebarHandle()).toHaveAttribute('aria-orientation', 'vertical')
})

test('both widths survive a restart', async () => {
  await drag(sidebarHandle(), 60)
  await drag(stepsHandle(), 40)
  const sidebarWidth = await widthOf(sidebar())
  const stepsWidth = await widthOf(stepsColumn())

  await app.close()
  await launch()
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')

  expect(await widthOf(sidebar())).toBeCloseTo(sidebarWidth, -1)
  expect(await widthOf(stepsColumn())).toBeCloseTo(stepsWidth, -1)
})
