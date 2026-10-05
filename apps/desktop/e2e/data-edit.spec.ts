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
 * A data file (SPEC.md §2.8) edited in the app: a grid saved like any other
 * file — only what changed is rewritten, nothing with a problem is written,
 * and a change on disk is never overwritten.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const BOM = String.fromCharCode(0xfeff)
const ORIGINAL = `${BOM}userId,note\r\nann,"hello, world"\r\nbob,plain\r\n`

let tmp: string
let userData: string
let collections: string
let csv: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-data-edit-')))
  userData = path.join(tmp, 'ud')
  const repo = path.join(tmp, 'users-api')
  collections = path.join(repo, 'collections')
  fs.mkdirSync(collections, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  const collection = (id: string) =>
    [
      `id: ${id}`,
      'steps:',
      '  - name: get user',
      '    GET: "http://127.0.0.1:1/{{userId}}"',
      ''
    ].join('\n')
  fs.writeFileSync(path.join(collections, 'users.yml'), collection('users'))
  fs.writeFileSync(path.join(collections, 'typed.yml'), collection('typed'))
  fs.writeFileSync(path.join(collections, 'plain.yml'), collection('plain'))
  csv = path.join(collections, 'users.csv')
  fs.writeFileSync(csv, ORIGINAL)
  fs.writeFileSync(
    path.join(collections, 'typed.json'),
    JSON.stringify([{ userId: 1, active: true, name: 'Ann' }], null, 2) + '\n'
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const onDisk = () => fs.readFileSync(csv, 'utf8')
const drawer = () => page.getByRole('dialog', { name: 'Data file' })
const status = () => drawer().locator('.save-status')
const cell = (name: string) => drawer().getByLabel(name, { exact: true })

async function openCollection(name: string) {
  await page.locator('.collection-row', { hasText: name }).click()
  await expect(page.locator('.collection-header h1')).toHaveText(name)
}

async function openData() {
  await page.locator('.collection-header .data-badge').click()
  await expect(drawer()).toBeVisible()
}

async function setAutoSaveDelay(delayMs: number) {
  await page.getByRole('button', { name: 'App settings' }).click()
  await page.getByLabel('Delay before saving').fill(String(delayMs))
  await page.getByLabel('Delay before saving').press('Enter')
  await page.getByRole('button', { name: 'Close settings' }).click()
}

test('the badge opens the rows as a grid', async () => {
  await openCollection('users')
  await openData()
  await expect(drawer()).toContainText('users.csv')
  await expect(cell('Column 1 name')).toHaveValue('userId')
  await expect(cell('Column 2 name')).toHaveValue('note')
  await expect(cell('Row 1 note')).toHaveValue('hello, world')
  await expect(cell('Row 2 userId')).toHaveValue('bob')
  await expect(status()).toHaveText('Saved')
})

test('editing a cell rewrites that cell alone, keeping the BOM, and writes LF', async () => {
  await cell('Row 2 userId').fill('bobby')
  // The file was checked out with CRLF; the tools write LF.
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toBe(`${BOM}userId,note\nann,"hello, world"\nbobby,plain\n`)
  await expect(status()).toHaveText('Saved')
  // The sidebar and the header follow.
  await expect(
    page.locator('.collection-row', { hasText: 'users' }).locator('.data-mark')
  ).toHaveText('×2')
})

test('rows and columns are added, and quoted only where they need to be', async () => {
  await drawer().getByRole('button', { name: '+ Row' }).click()
  await cell('Row 3 userId').fill('cat, the third')
  await drawer().getByRole('button', { name: '+ Column' }).click()
  await cell('Column 3 name').fill('role')
  await cell('Row 1 role').fill('admin')
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toBe(`${BOM}userId,note,role\nann,"hello, world",admin\nbobby,plain,\n"cat, the third",,\n`)
  await expect(page.locator('.collection-header .data-badge')).toHaveText('users.csv · 3 rows')
})

test('a column named twice is shown, and nothing is saved until it is fixed', async () => {
  const before = onDisk()
  await cell('Column 3 name').fill('userId')
  await expect(drawer().getByLabel('Data file problems')).toContainText(
    'the column userId is named twice — not saved until fixed'
  )
  await page.waitForTimeout(1600)
  expect(onDisk()).toBe(before)

  await drawer().getByRole('button', { name: 'Remove column userId' }).nth(1).click()
  await expect(drawer().getByLabel('Data file problems')).toHaveCount(0)
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toBe(`${BOM}userId,note\nann,"hello, world"\nbobby,plain\n"cat, the third",\n`)
})

test('rows move and are removed', async () => {
  await drawer().getByRole('button', { name: 'Move row 3 up' }).click()
  await drawer().getByRole('button', { name: 'Remove row 1' }).click()
  // Rows not edited keep their text as written, wherever they move.
  await expect
    .poll(onDisk, { timeout: 5_000 })
    .toBe(`${BOM}userId,note\n"cat, the third",\nbobby,plain\n`)
})

test('a change on disk while editing is put to the person, never overwritten', async () => {
  await drawer().getByRole('button', { name: 'Close', exact: true }).click()
  await setAutoSaveDelay(3000)
  await openData()
  await cell('Row 2 note').fill('mine')

  const theirs = `${BOM}userId,note\r\ndan,theirs\r\n`
  fs.writeFileSync(csv, theirs)
  await expect(status()).toContainText('Changed on disk', { timeout: 15_000 })
  await page.waitForTimeout(3500)
  expect(onDisk()).toBe(theirs)

  await status().getByRole('button', { name: 'Reload' }).click()
  await expect(cell('Row 1 userId')).toHaveValue('dan')
  await expect(cell('Row 1 note')).toHaveValue('theirs')
  await expect(status()).toHaveText('Saved')
  expect(onDisk()).toBe(theirs)
  await drawer().getByRole('button', { name: 'Close', exact: true }).click()
  await setAutoSaveDelay(1000)
})

test('a JSON data file keeps each value’s type, and reads typed values as gta does', async () => {
  const json = path.join(collections, 'typed.json')
  await openCollection('typed')
  await openData()
  await expect(cell('Row 1 active')).toHaveValue('true')
  await cell('Row 1 name').fill('Annie')
  await cell('Row 1 name').blur()
  await expect
    .poll(() => fs.readFileSync(json, 'utf8'), { timeout: 5_000 })
    .toBe(JSON.stringify([{ userId: 1, active: true, name: 'Annie' }], null, 2) + '\n')

  await cell('Row 1 userId').fill('2')
  await cell('Row 1 userId').blur()
  await expect
    .poll(() => JSON.parse(fs.readFileSync(json, 'utf8')), { timeout: 5_000 })
    .toEqual([{ userId: 2, active: true, name: 'Annie' }])
  await drawer().getByRole('button', { name: 'Close', exact: true }).click()
})

test('a data file is created from a first column name, and deleted', async () => {
  const created = path.join(collections, 'plain.csv')
  await openCollection('plain')
  await page.getByRole('button', { name: '+ Data file' }).click()
  await page.getByLabel('First column name').fill('userId')
  await page.getByRole('button', { name: 'Create data file' }).click()

  await expect(drawer()).toBeVisible()
  expect(fs.readFileSync(created, 'utf8')).toBe('userId\n""\n')
  await expect(
    page.locator('.collection-row', { hasText: 'plain' }).locator('.data-mark')
  ).toHaveText('×1')
  await cell('Row 1 userId').fill('ann')
  await expect
    .poll(() => fs.readFileSync(created, 'utf8'), { timeout: 5_000 })
    .toBe('userId\nann\n')

  page.once('dialog', (dialog) => void dialog.accept())
  await drawer().getByRole('button', { name: 'Delete data file' }).click()
  await expect(drawer()).toHaveCount(0)
  expect(fs.existsSync(created)).toBe(false)
  await expect(page.getByRole('button', { name: '+ Data file' })).toBeVisible()
  await expect(
    page.locator('.collection-row', { hasText: 'plain' }).locator('.data-mark')
  ).toHaveCount(0)
})

test('the raw view saves the text exactly as typed, and the grid shows it', async () => {
  fs.writeFileSync(csv, ORIGINAL)
  await openCollection('users')
  await openData()
  await drawer().getByRole('button', { name: 'Raw', exact: true }).click()
  const raw = drawer().getByLabel('Data file text')
  const before = ORIGINAL
  // A text box has only \n, and the tools write LF: the CRLF file is written LF.
  await expect(raw).toHaveValue(before.replace(/\r\n/g, '\n'))
  // Quotes the grid would never write stay as typed.
  const typed = before.replace('bob,plain', '"bob","plain text"').replace(/\r\n/g, '\n')
  await raw.fill(typed)
  await expect.poll(onDisk, { timeout: 5_000 }).toBe(typed)
  await drawer().getByRole('button', { name: 'Grid', exact: true }).click()
  // The grid reads the typed text: the unquoted value is a cell of its own.
  await expect
    .poll(() =>
      drawer()
        .locator('.data-grid tbody input')
        .evaluateAll((inputs) => inputs.map((input) => (input as { value: string }).value))
    )
    .toContain('plain text')
  await drawer().getByRole('button', { name: 'Raw', exact: true }).click()
  await page.keyboard.press('Escape')
})

test('a column named twice keeps both columns’ values in the raw view, to be renamed there', async () => {
  fs.writeFileSync(csv, ORIGINAL)
  await openCollection('users')
  await openData()
  // The drawer opens in the view it was last left in.
  await drawer().getByRole('button', { name: 'Grid', exact: true }).click()
  // The file as written above, not as the test before left it.
  await expect(cell('Row 2 note')).toHaveValue('plain', { timeout: 5_000 })
  await cell('Column 2 name').fill('userId')
  await expect(drawer().getByLabel('Data file problems')).toContainText(
    'the column userId is named twice'
  )
  await drawer().getByRole('button', { name: 'Raw', exact: true }).click()
  const raw = drawer().getByLabel('Data file text')
  await expect(raw).toHaveValue(`${BOM}userId,userId\nann,"hello, world"\nbob,plain\n`)
  expect(onDisk()).toBe(ORIGINAL)

  const renamed = `${BOM}userId,comment\nann,"hello, world"\nbob,plain\n`
  await raw.fill(renamed)
  await expect.poll(onDisk, { timeout: 5_000 }).toBe(renamed)
  await drawer().getByRole('button', { name: 'Grid', exact: true }).click()
  await expect(cell('Row 1 comment')).toHaveValue('hello, world')
  await page.keyboard.press('Escape')
})

test('raw text that is not a table is shown, not saved, and a broken file is fixed there', async () => {
  await openCollection('users')
  await openData()
  await drawer().getByRole('button', { name: 'Raw', exact: true }).click()
  const raw = drawer().getByLabel('Data file text')
  const before = onDisk()
  await raw.fill('userId,userId\nann,bob\n')
  await expect(drawer().getByRole('alert', { name: 'Data file problems' })).toContainText(
    'names userId twice'
  )
  await page.waitForTimeout(1_500)
  expect(onDisk()).toBe(before)

  // A file broken on disk opens as its text, to be fixed in place.
  await raw.fill(before.replace(/\r\n/g, '\n'))
  await expect.poll(onDisk, { timeout: 5_000 }).toBe(before)
  fs.writeFileSync(csv, 'userId\n"never closed\n')
  await expect(raw).toHaveValue('userId\n"never closed\n', { timeout: 5_000 })
  await raw.fill('userId\nfixed\n')
  await expect.poll(onDisk, { timeout: 5_000 }).toBe('userId\nfixed\n')
  await drawer().getByRole('button', { name: 'Grid', exact: true }).click()
  await page.keyboard.press('Escape')
})
