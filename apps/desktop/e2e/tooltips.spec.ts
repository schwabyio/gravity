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

/** Every icon-only control explains itself on hover and on keyboard focus. */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let app: ElectronApplication
let page: Page

const tip = () => page.locator('.tooltip')

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-tip-')))
  const repo = path.join(tmp, 'r')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  const file = path.join(repo, 'collections', 'c.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: c',
      'steps:',
      '  - name: one',
      '    GET: "http://example.test/one?a=1"',
      '    headers:',
      '      Accept: application/json',
      ''
    ].join('\n')
  )

  for (const args of [
    ['config', 'user.email', 'test@example.test'],
    ['config', 'user.name', 'Test'],
    ['add', '-A'],
    ['commit', '-m', 'initial', '--no-gpg-sign']
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await page.locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('every icon-only button is explained on hover', async () => {
  const cases: Array<[string, RegExp]> = [
    ['Fetch', /Fetch from the remote/],
    ['Pull', /no upstream/],
    ['Remove r', /files are left alone/],
    ['Run one', /Run this step on its own/]
  ]

  for (const [name, expected] of cases) {
    await page.mouse.move(0, 0)
    await page.getByRole('button', { name, exact: false }).first().hover()
    await expect(tip()).toHaveText(expected)
  }
})

test('the Pull explanation says why it is unavailable', async () => {
  // A repository with no remote has nothing to pull from, changes or not.
  fs.appendFileSync(path.join(tmp, 'r', 'collections', 'c.yml'), '\n')
  await expect(page.getByRole('button', { name: 'Review changes' })).toBeVisible({
    timeout: 15_000
  })
  await expect(page.getByRole('button', { name: 'Pull' })).toBeDisabled()

  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Pull' }).hover()
  await expect(tip()).toHaveText('Cannot pull: this branch has no upstream yet. Push to publish it')
})

test('explains the header remove and enable controls', async () => {
  await page
    .locator('.pane')
    .first()
    .getByRole('button', { name: /^Headers/ })
    .click()

  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Remove row' }).first().hover()
  await expect(tip()).toHaveText('Remove this header')

  await page.mouse.move(0, 0)
  await page.getByRole('checkbox').first().hover()
  await expect(tip()).toHaveText('Sent with the request')
})

test('explains removing a query parameter', async () => {
  await page
    .locator('.pane')
    .first()
    .getByRole('button', { name: /^Params/ })
    .click()
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Remove parameter' }).first().hover()
  await expect(tip()).toHaveText('Remove this parameter from the URL')
})

test('appears on keyboard focus, without waiting for a hover delay', async () => {
  await page.mouse.move(0, 0)
  await expect(tip()).toHaveCount(0)

  await page.getByRole('button', { name: 'Fetch' }).focus()
  await expect(tip()).toHaveText(/Fetch from the remote/)
})

test('dismisses on Escape and on pressing the button', async () => {
  await page.getByRole('button', { name: 'Fetch' }).focus()
  await expect(tip()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tip()).toHaveCount(0)

  // Pressing a button should act, not leave an explanation hanging over it.
  await page
    .locator('.pane')
    .first()
    .getByRole('button', { name: /^Headers/ })
    .click()
  await page.mouse.move(0, 0)
  const remove = page.getByRole('button', { name: 'Remove row' }).first()
  await remove.hover()
  await expect(tip()).toBeVisible()
  await remove.click()
  await expect(tip()).toHaveCount(0)
})

test('describes rather than renames, so buttons keep their accessible name', async () => {
  const fetch = page.getByRole('button', { name: 'Fetch' })
  await expect(fetch).toHaveCount(1)
  await fetch.focus()
  // The explanation is linked by describedby, not merged into the name.
  // Linked by describedby rather than merged into the name, so the button is
  // still reachable as 'Fetch' and nothing else.
  const describedBy = await fetch.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator('[role="tooltip"]')).toHaveAttribute('id', describedBy!)
})
