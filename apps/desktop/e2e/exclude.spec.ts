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
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * `exclude: true` leaves a collection out of group runs (`gta all`, a
 * directory). The app edits it in the collection settings drawer and marks it
 * in the sidebar and the collection header.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-exclude-')))
  const repo = path.join(tmp, 'shop-api')
  file = path.join(repo, 'collections', 'legacy.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    file,
    ['id: legacy', 'tags: [api]', 'steps:', '  - name: browse', '    GET: /browse', ''].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
})

test.afterAll(async () => {
  await app?.close()
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
