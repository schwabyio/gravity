import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * A project's rules (SPEC.md §1.4), its `rules.yml` over its global
 * project's. Where a file breaks one, its row is marked and the open
 * collection says so; the Tests editor flags what `tests.only` does not
 * allow as it is typed; Project settings lists the rules and every finding;
 * and the app will not create or rename what would break one.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let app: ElectronApplication
let page: Page

const write = (relative: string, text: string) => {
  const file = path.join(tmp, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const lines = (...text: string[]) => `${text.join('\n')}\n`

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-rules-')))
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: tmp, stdio: 'pipe' })
  write('shared/project.yml', 'name: shared\n')
  write(
    'shared/rules.yml',
    lines(
      'ids:',
      '  collections: kebab-case',
      'docs:',
      '  collections: required',
      'tests:',
      '  only: [gta]'
    )
  )
  write('shop/project.yml', 'name: shop\nuses: ../shared\n')
  write('shop/rules.yml', lines('layout:', '  folderNames: [orders, payments]'))
  write(
    'shop/collections/orders/list-orders.yml',
    lines(
      'id: list-orders',
      'docs: Lists the orders.',
      'steps:',
      '  - name: list',
      '    GET: http://127.0.0.1:9/orders',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      '  - name: count',
      '    GET: http://127.0.0.1:9/orders/count',
      '    tests: |',
      '      checks.orders.counted()'
    )
  )
  write(
    'shop/collections/orders/CreateOrder.yml',
    lines('id: CreateOrder', 'steps:', '  - name: create', '    POST: http://127.0.0.1:9/orders')
  )
  write(
    'shop/collections/misc/ping.yml',
    lines('id: ping', 'docs: Is it up?', 'steps:', '  - name: ping', '    GET: http://127.0.0.1:9/')
  )
  write(
    'shop/requests/get-token.yml',
    lines(
      'id: get-token',
      'params: {}',
      'steps:',
      '  - name: token',
      '    POST: http://127.0.0.1:9/token'
    )
  )
  // Its own collection, so it can be a project to copy to.
  write(
    'shared/collections/shared-check.yml',
    lines('id: shared-check', 'docs: What the shared parts do.', 'steps: []')
  )
  shop = path.join(tmp, 'shop')

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 860 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.waitForSelector('.collection-row')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const row = (id: string) => page.locator('.collection-row', { hasText: new RegExp(`^${id}`) })
const folderRow = (name: string) => page.locator('.group-row', { hasText: new RegExp(`^.${name}`) })
const step = (name: string) => page.locator('.step-list li', { hasText: name })

test('rows mark where files and folders break the rules, and the project counts them', async () => {
  await expect(row('CreateOrder').getByRole('img', { name: '2 rule findings' })).toBeVisible()
  await expect(row('CreateOrder').locator('.rule-mark')).toHaveAttribute(
    'title',
    /id: CreateOrder is not kebab-case \(ids\.collections in \.\.\/shared\/rules\.yml\)/
  )
  // A step's finding counts on its collection's row.
  await expect(row('list-orders').getByRole('img', { name: '1 rule finding' })).toBeVisible()
  await expect(row('ping').locator('.rule-mark')).toHaveCount(0)
  await expect(folderRow('misc').getByRole('img', { name: '1 rule finding' })).toBeVisible()
  await expect(folderRow('orders').locator('.rule-mark')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '4 rule findings: open the project’s rules' })
  ).toHaveText('△ 4')
})

test('an open collection says what it breaks, and marks each step that does', async () => {
  await row('CreateOrder').click()
  const banner = page.locator('.rule-banner')
  await expect(banner).toContainText(
    'id: CreateOrder is not kebab-case (ids.collections in ../shared/rules.yml)'
  )
  await expect(banner).toContainText('no docs (docs.collections in ../shared/rules.yml)')

  await row('list-orders').click()
  await expect(page.locator('.rule-banner')).toHaveCount(0)
  await expect(step('count').locator('.rule-mark')).toHaveAttribute(
    'title',
    /check files are not used here; tests here call only gta\.\* functions \(tests\.only in \.\.\/shared\/rules\.yml\)/
  )
  await expect(step('list').locator('.rule-mark')).toHaveCount(0)
})

test('the Tests editor flags what tests.only does not allow as it is typed, and offers none of it', async () => {
  await step('list').locator('.step-open').click()
  const scripts = page.locator('.scripts-pane')
  await expect(scripts.locator('.tests-rule-hint')).toContainText(
    'This project’s rules allow gta.* functions here'
  )
  await scripts.getByRole('textbox', { name: 'Tests' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('gta.te')
  // gta.test is a check of your own: not offered here.
  const options = page.locator('.cm-tooltip-autocomplete li')
  await expect(options.first()).toBeVisible()
  await expect(options.filter({ hasText: /^test/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  for (let i = 0; i < 'gta.te'.length; i++) await page.keyboard.press('Backspace')
  // Nor assert, which goes inside one.
  await page.keyboard.type('re')
  await expect(options.filter({ hasText: /^res$/ })).toBeVisible()
  await expect(options.filter({ hasText: /^assert/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  for (let i = 0; i < 're'.length; i++) await page.keyboard.press('Backspace')

  await page.keyboard.type('assert.ok(res.body)')
  await expect(scripts.locator('.cm-lintRange-warning')).toHaveText('assert.ok(res.body)')
  await scripts.locator('.cm-lintRange-warning').hover()
  await expect(page.locator('.cm-tooltip-lint')).toContainText(
    'assert.ok(res.body): tests here call only gta.* functions (tests.only in ../shared/rules.yml)'
  )

  // Saved, the step is a finding like any other.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(step('list').getByRole('img', { name: '1 rule finding' })).toBeVisible({
    timeout: 10_000
  })
})

test('Project settings lists each rule and its file, and every finding, each opening its file', async () => {
  await page.getByRole('button', { name: /rule findings: open the project’s rules/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  await expect(drawer.getByRole('heading', { name: 'Rules' })).toBeInViewport()
  const listed = drawer.locator('.rules-list .rule dt')
  await expect(listed).toHaveText([
    /^ids\.collections\s*kebab-case\s*\.\.\/shared\/rules\.yml/,
    /^layout\.folderNames\s*\[orders, payments\]\s*rules\.yml/,
    /^docs\.collections\s*required\s*\.\.\/shared\/rules\.yml/,
    /^tests\.only\s*\[gta\]\s*\.\.\/shared\/rules\.yml/
  ])
  await expect(drawer.locator('.rules-findings-title')).toHaveText('5 rule findings')

  await drawer.getByRole('button', { name: 'collections/orders/CreateOrder.yml:1' }).first().click()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.collection-header h1')).toHaveText('CreateOrder')

  // A step's finding opens its collection at that step.
  await page.getByRole('button', { name: /rule findings: open the project’s rules/ }).click()
  await drawer
    .getByRole('button', { name: /^collections\/orders\/list-orders\.yml:\d+$/ })
    .last()
    .click()
  await expect(page.locator('.collection-header h1')).toHaveText('list-orders')
  await expect(page.locator('.step-list li.selected')).toContainText('count')
})

test('the app will not create or rename what would break a rule', async () => {
  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New collection' }).click()
  await page.getByLabel('Folder', { exact: true }).selectOption('orders')
  await page.getByLabel('New collection id').fill('RefundOrder')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'RefundOrder' })).toHaveText(
    'id: RefundOrder is not kebab-case (rule ids.collections in ../shared/rules.yml)'
  )
  expect(fs.existsSync(path.join(shop, 'collections/orders/RefundOrder.yml'))).toBe(false)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await page.getByLabel('New folder name').fill('refunds')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'refunds' })).toHaveText(
    'folder refunds is not one of: orders, payments (rule layout.folderNames in rules.yml)'
  )
  expect(fs.existsSync(path.join(shop, 'collections/refunds'))).toBe(false)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Collection actions for ping' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('New id for ping').fill('Ping')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'Ping' })).toHaveText(
    'id: Ping is not kebab-case (rule ids.collections in ../shared/rules.yml)'
  )
  await page.keyboard.press('Escape')
  expect(fs.existsSync(path.join(shop, 'collections/misc/ping.yml'))).toBe(true)
})

test('more rules and a guide apply as rules.yml changes, and AGENTS.md points agents at them', async () => {
  write(
    'shop/rules.yml',
    lines(
      'layout:',
      '  folderNames: [orders, payments, misc]',
      'steps:',
      '  names: required',
      'tests:',
      '  statusCode: required',
      'guide: |',
      '  # Shop',
      '  Name each step for what it proves.'
    )
  )
  await row('ping').click()
  await expect(step('ping').getByRole('img', { name: '1 rule finding' })).toBeVisible({
    timeout: 10_000
  })
  await expect(step('ping').locator('.rule-mark')).toHaveAttribute(
    'title',
    /no tests check its status code with gta\.expectResponseStatusCodeToBe \(tests\.statusCode in rules\.yml\)/
  )
  await expect(folderRow('misc').locator('.rule-mark')).toHaveCount(0)

  await page.getByRole('button', { name: /rule findings: open the project’s rules/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  const guide = drawer.getByRole('note', { name: 'Guide from rules.yml' })
  await expect(guide.getByRole('heading', { name: 'Shop' })).toBeVisible()
  await expect(guide).toContainText('Name each step for what it proves.')

  await drawer.getByRole('button', { name: 'Add to AGENTS.md' }).click()
  await expect(drawer.locator('.rules-agents [role=status]')).toContainText(
    'This project’s AGENTS.md tells coding agents to run gta rules before writing a test here'
  )
  const agents = fs.readFileSync(path.join(shop, 'AGENTS.md'), 'utf8')
  expect(agents).toMatch(/^<!-- gravity:rules -->\n## API tests\n/)
  expect(agents).toContain('run `gta lint --json` in this folder')
  await page.keyboard.press('Escape')
})

test('the collection’s own Tests editor keeps to tests.only too', async () => {
  await row('ping').click()
  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await drawer
    .getByRole('navigation', { name: 'Collection settings sections' })
    .getByRole('button', { name: 'Tests' })
    .click()
  await expect(drawer.locator('.script-editor .hint')).toContainText(
    'This project’s rules allow gta.* functions here (tests.only in ../shared/rules.yml).'
  )
  await drawer.getByRole('textbox', { name: 'Collection tests' }).click()
  await page.keyboard.type('console.log(res.status)')
  await expect(drawer.locator('.cm-lintRange-warning')).toHaveText('console.log(res.status)')
  await drawer.getByRole('button', { name: 'Close' }).click()
  await expect(drawer).toHaveCount(0)
})

test('a library file’s row is marked, its finding opens it, and the app refuses what would break a rule', async () => {
  write(
    'shop/rules.yml',
    lines(
      'ids:',
      '  requests: camelCase',
      '  bases: kebab-case',
      'layout:',
      '  folders: required',
      '  folderNames: [orders, payments, misc]'
    )
  )
  const setRow = page.locator('.set-row', { hasText: 'get-token' })
  await expect(setRow.getByRole('img', { name: '1 rule finding' })).toBeVisible({
    timeout: 10_000
  })
  await expect(setRow.locator('.rule-mark')).toHaveAttribute(
    'title',
    'id: get-token is not camelCase (ids.requests in rules.yml)'
  )
  await page.getByRole('button', { name: /rule findings: open the project’s rules/ }).click()
  await page
    .getByRole('dialog', { name: 'Project settings' })
    .getByRole('button', { name: 'requests/get-token.yml:1', exact: true })
    .click()
  await expect(page.locator('.collection-header h1')).toHaveText('get-token')

  const refused = async (message: string) => {
    await expect(page.getByRole('alert').filter({ hasText: message })).toHaveText(message)
    await page.keyboard.press('Escape')
  }

  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New reusable requests file' }).click()
  await page.getByLabel('New reusable requests file id').fill('get-order')
  await page.keyboard.press('Enter')
  await refused('id: get-order is not camelCase (rule ids.requests in rules.yml)')
  expect(fs.existsSync(path.join(shop, 'requests/get-order.yml'))).toBe(false)

  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'New base collection' }).click()
  await page.getByLabel('New base collection id').fill('AuthedCalls')
  await page.keyboard.press('Enter')
  await refused('id: AuthedCalls is not kebab-case (rule ids.bases in rules.yml)')

  // Into collections/ itself, where layout.folders says no collection goes.
  await page.getByRole('button', { name: 'Collection actions for ping' }).click()
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click()
  const move = page.getByRole('form', { name: 'Move ping to a folder' })
  await move.getByLabel('Folder').selectOption({ label: 'collections/' })
  await move.getByRole('button', { name: 'Move' }).click()
  await expect(move.getByRole('alert')).toHaveText(
    'a collection goes in a folder of collections/ here (rule layout.folders in rules.yml)'
  )
  await move.getByRole('button', { name: 'Cancel' }).click()
  expect(fs.existsSync(path.join(shop, 'collections/misc/ping.yml'))).toBe(true)

  await page.getByRole('button', { name: 'Folder actions for misc' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('New name for the folder misc').fill('other')
  await page.keyboard.press('Enter')
  await refused(
    'folder other is not one of: orders, payments, misc (rule layout.folderNames in rules.yml)'
  )
  expect(fs.existsSync(path.join(shop, 'collections/misc'))).toBe(true)

  // To another project: by that project's rules, not this one's.
  await addProject(app, page, path.join(tmp, 'shared'))
  await page.getByRole('button', { name: 'Collection actions for CreateOrder' }).click()
  await page.getByRole('menuitem', { name: 'Copy to project…' }).click()
  const copy = page.getByRole('form', { name: 'Copy CreateOrder to a project' })
  await copy.getByLabel('Project').selectOption({ label: 'shared' })
  await copy.getByRole('button', { name: 'Copy' }).click()
  await expect(copy.getByRole('alert')).toHaveText(
    'id: CreateOrder is not kebab-case (rule ids.collections in rules.yml)'
  )
  await copy.getByRole('button', { name: 'Cancel' }).click()
  expect(fs.existsSync(path.join(tmp, 'shared/collections/CreateOrder.yml'))).toBe(false)
})

test('rules that cannot be read are a problem of the project’s, and none apply', async () => {
  write('shop/rules.yml', lines('ids:', '  colections: kebab-case'))
  const problem = page
    .getByRole('region', { name: 'Project shop', exact: true })
    .getByRole('img', { name: 'Project problems' })
  await expect(problem).toHaveAttribute(
    'title',
    /Rules are not valid \(SPEC\.md §1\.4\):\n {2}ids\.colections \(rules\.yml\): not a rule/,
    { timeout: 10_000 }
  )
  await expect(row('CreateOrder').locator('.rule-mark')).toHaveCount(0)
  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'Project settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  await expect(drawer.locator('.rules-problem')).toContainText(
    'ids.colections (rules.yml): not a rule; ids has collections, requests, bases, endpoints'
  )
  await page.keyboard.press('Escape')
})

test('Project settings lists the first hundred findings, and says how many more gta lint has', async () => {
  write('shop/rules.yml', lines('docs:', '  steps: required'))
  write(
    'shop/collections/orders/long-list.yml',
    lines(
      'id: long-list',
      'docs: One page at a time.',
      'steps:',
      ...Array.from({ length: 120 }, (_, i) => [
        `  - name: page ${i + 1}`,
        `    GET: /orders?page=${i + 1}`
      ]).flat()
    )
  )
  const count = page.getByRole('button', { name: /rule findings: open the project’s rules/ })
  await expect(count).toHaveText(/^△ 1\d\d$/, { timeout: 10_000 })
  const total = Number((await count.textContent())!.replace(/\D/g, ''))
  await count.click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  await expect(drawer.locator('.rules-findings-title')).toHaveText(`${total} rule findings`)
  await expect(
    drawer.getByRole('list', { name: 'Rule findings' }).getByRole('listitem')
  ).toHaveCount(100)
  await expect(drawer).toContainText(`And ${total - 100} more: gta lint lists them all.`)
  await page.keyboard.press('Escape')
})

test('with no rules, nothing is marked, the editors are as ever and Project settings says so', async () => {
  fs.rmSync(path.join(shop, 'rules.yml'))
  fs.rmSync(path.join(tmp, 'shared/rules.yml'))
  await expect(
    page.getByRole('button', { name: /rule findings: open the project’s rules/ })
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.rule-mark')).toHaveCount(0)

  await row('list-orders').click()
  await step('list').locator('.step-open').click()
  await expect(page.locator('.scripts-pane .tests-rule-hint')).toHaveCount(0)
  await expect(page.locator('.scripts-pane .script-editor .hint')).toContainText(
    'with gta, res and assert built in'
  )

  await page.getByRole('button', { name: 'Project actions for shop' }).click()
  await page.getByRole('menuitem', { name: 'Project settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  await expect(drawer.locator('.rules-none')).toHaveText(
    'No rules.yml here or in shared. Add one beside project.yml to write down this project’s conventions: id styles, folders, step names and URLs, docs, tags, what tests check, and a guide.'
  )
  // Nothing to point agents at.
  await expect(drawer.locator('.rules-agents')).toHaveCount(0)
  await page.keyboard.press('Escape')
})
