import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * A project's heading in the sidebar, short of room: the shared project it uses
 * gives way first, cut short and then gone, and the project's own name last, so
 * the project is never hidden behind its shared project. Where that happens
 * depends on the platform's fonts, Linux's being wider, so the widths here leave
 * room for any of them.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const SHARED = 'Platform Shared Configuration And Environments'

let tmp: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-heading-')))
  const shared = path.join(tmp, 'platform-config')
  fs.mkdirSync(path.join(shared, 'environments'), { recursive: true })
  fs.writeFileSync(path.join(shared, 'project.yml'), `name: ${SHARED}\n`)
  fs.writeFileSync(path.join(shared, 'environments', 'dev.yml'), 'vars: {}\n')
  const repo = path.join(tmp, 'orders-service')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'project.yml'), 'uses: ../platform-config\n')
  fs.writeFileSync(path.join(repo, 'collections', 'orders.yml'), 'id: orders\nsteps: []\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const heading = () =>
  page.getByRole('region', { name: 'Project orders-service', exact: true }).locator('.repo-head')
/** Shown whole, or cut short with an ellipsis. */
const cutShort = (locator: Locator) =>
  locator.evaluate((element) => element.scrollWidth > element.clientWidth)
const right = async (locator: Locator) => {
  const box = (await locator.boundingBox())!
  return box.x + box.width
}

/** Drag the sidebar's edge to `x`; it stops at its narrowest. */
async function sidebarTo(x: number) {
  const edge = page.getByRole('separator', { name: 'Resize the collections pane' })
  const box = (await edge.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(x, box.y + 300, { steps: 5 })
  await page.mouse.up()
  await page.mouse.move(800, 600)
}

test('a long shared project name is cut short before the project’s own name', async () => {
  await sidebarTo(360)
  const name = heading().locator('.repo-name')
  const badge = heading().locator('.uses-badge')
  await expect(name).toHaveText('orders-service')
  await expect(badge).toHaveText(`uses ${SHARED}`)
  expect(await cutShort(name)).toBe(false)
  expect(await cutShort(badge)).toBe(true)
  // Its whole name is on hover, and nothing is pushed out of the sidebar. A tooltip goes
  // at any scroll or resize in the window, so the pointer comes back until it shows.
  await expect(async () => {
    await page.mouse.move(800, 600)
    await badge.hover()
    await expect(page.getByRole('tooltip')).toContainText(`Uses ${SHARED}`, { timeout: 2000 })
  }).toPass()
  await page.mouse.move(800, 600)
  const remove = heading().getByRole('button', { name: 'Remove orders-service' })
  expect(await right(remove)).toBeLessThanOrEqual(await right(page.locator('.sidebar')))
})

test('a narrow sidebar leaves the shared project out, and keeps the project named', async () => {
  await sidebarTo(150)
  await expect(heading().locator('.uses-badge')).toBeHidden()
  const name = heading().locator('.repo-name')
  await expect(name).toBeVisible()
  expect((await name.boundingBox())!.width).toBeGreaterThan(30)
  const remove = heading().getByRole('button', { name: 'Remove orders-service' })
  expect(await right(remove)).toBeLessThanOrEqual(await right(page.locator('.sidebar')))

  // Widened again, it is back.
  await sidebarTo(420)
  await expect(heading().locator('.uses-badge')).toBeVisible()
  expect(await cutShort(heading().locator('.repo-name'))).toBe(false)
})

test('the shared project is left out before the project’s name would be cut short', async () => {
  const name = heading().locator('.repo-name')
  const badge = heading().locator('.uses-badge')
  let goneFirst = false
  for (let x = 420; x >= 150; x -= 10) {
    await sidebarTo(x)
    if (await badge.isVisible()) expect(await cutShort(name), `at ${x}`).toBe(false)
    else if (!(await cutShort(name))) goneFirst = true
  }
  expect(goneFirst).toBe(true)
})
