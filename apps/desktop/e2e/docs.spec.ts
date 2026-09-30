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

/**
 * Docs rendering, against the constructs the reference suite actually uses:
 * bold, bullet and ordered lists, fenced code with a language, tables, links
 * and inline code.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let app: ElectronApplication
let page: Page

const DOCS = [
  '**Objective: Validate the date() function in the following places:**',
  '',
  '- response body',
  '  - nested under body',
  '  - also nested',
  '- response header',
  '- a wrapped item that continues',
  '  onto the next line',
  '',
  '``` javascript',
  'date(dateFormat [String], secondsOffset [Number], timeZoneScheme [String]);',
  '```',
  '',
  'This function generates a date in any required format. [See here](https://example.test/fmt) for specifiers.',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| `%Y` | four digit year |',
  '| `%m` | month |',
  '',
  '# A heading',
  '',
  '1. first',
  '2. second',
  '',
  '> A quoted aside.',
  '',
  'A `javascript:alert(1)` link is [not one](javascript:alert(1)).'
].join('\n')

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-docs-')))
  const repo = path.join(tmp, 'r')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })

  const file = path.join(repo, 'collections', 'date.yml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      'id: date',
      'docs: |-',
      ...DOCS.split('\n').map((line) => `  ${line}`.trimEnd()),
      'steps:',
      '  - name: one',
      '    GET: "http://example.test/one"',
      '    docs: |-',
      '      Step docs with **bold** and `code`.',
      ''
    ].join('\n')
  )
  // A collection without docs, so there is somewhere else to go and come back from.
  fs.writeFileSync(
    path.join(repo, 'collections', 'plain.yml'),
    ['id: plain', 'steps:', '  - name: two', '    GET: "http://example.test/two"', ''].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await openCollection('date')
  await page.waitForSelector('.docs-panel')
  // Docs open collapsed; expand so everything is on screen to assert against.
  await page.getByRole('button', { name: 'Show more' }).click()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const openCollection = (name: string) => page.locator('.collection-row', { hasText: name }).click()

const docs = () => page.locator('.docs-panel .md')
/**
 * Items of the FIRST outer list only.
 *
 * `li` alone would also match its nested items, and `.md > .md-list > li` would
 * also match the ordered list further down the same document.
 */
const topLevelItems = () => page.locator('.docs-panel .md > ul.md-list').first().locator('> li')

test('renders markdown rather than showing its source', async () => {
  // The markers themselves must be gone from the visible text.
  const text = (await docs().innerText()).trim()
  expect(text).not.toContain('**')
  expect(text).not.toContain('```')
  expect(text).not.toContain('| --- |')
  expect(text).toContain('Objective: Validate the date() function')
})

test('renders bold, lists and headings as elements', async () => {
  await expect(docs().locator('strong').first()).toContainText('Objective')
  // Scoped to the outer list: `ul > li` alone would also match the nested one.
  await expect(topLevelItems()).toHaveCount(3)
  await expect(topLevelItems().first()).toContainText('response body')
  await expect(docs().locator('ol li')).toHaveText(['first', 'second'])
  await expect(docs().locator('.md-h')).toHaveText('A heading')
  await expect(docs().locator('.md-quote')).toContainText('A quoted aside.')
})

test('nests a sub-list inside its parent item', async () => {
  const first = topLevelItems().first()
  await expect(first.locator('.md-list li')).toHaveText(['nested under body', 'also nested'])
})

test('joins a wrapped list item onto one line', async () => {
  await expect(topLevelItems().nth(2)).toHaveText(
    'a wrapped item that continues onto the next line'
  )
})

test('renders a fenced code block, naming its language', async () => {
  const code = docs().locator('.md-code')
  await expect(code).toHaveAttribute('data-language', 'javascript')
  await expect(code).toContainText('date(dateFormat [String]')
})

test('renders a table with its header row', async () => {
  await expect(docs().locator('.md-table th')).toHaveText(['Name', 'Note'])
  await expect(docs().locator('.md-table td').first()).toHaveText('%Y')
  // Inline code inside a cell is still code.
  await expect(docs().locator('.md-table td .md-inline-code').first()).toHaveText('%Y')
})

test('links http(s) only, and never javascript:', async () => {
  const links = docs().locator('a')
  await expect(links).toHaveCount(1)
  await expect(links).toHaveAttribute('href', 'https://example.test/fmt')
  await expect(links).toHaveAttribute('target', '_blank')
  // The javascript: link renders as text, with no anchor at all.
  await expect(docs()).toContainText('not one (javascript:alert(1))')
})

test('collapses long docs behind a chevron toggle', async () => {
  const toggle = page.locator('.docs-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  // An icon, named for screen readers and explained on hover.
  await expect(toggle).toHaveText('')
  await toggle.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Show less')
  await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible()

  await page.getByRole('button', { name: 'Show less' }).click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible()

  const collapsed = await page.locator('.docs-body').boundingBox()
  const before = await toggle.boundingBox()
  await page.getByRole('button', { name: 'Show more' }).click()
  const expanded = await page.locator('.docs-body').boundingBox()
  expect(expanded!.height).toBeGreaterThan(collapsed!.height)

  // The toggle stays put, so it can be clicked again without chasing it.
  const after = await toggle.boundingBox()
  expect(after!.y).toBe(before!.y)
  expect(after!.x + after!.width).toBe(before!.x + before!.width)
})

test('docs start collapsed', async () => {
  // Leaving the collection and coming back resets the panel to its default state.
  await openCollection('plain')
  await expect(page.locator('.docs-panel')).toHaveCount(0)
  await openCollection('date')
  await expect(page.locator('.docs-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('a step with docs gets a Docs tab', async () => {
  const requestPane = page.locator('.pane').first()
  await requestPane.getByRole('button', { name: 'Docs' }).click()
  await expect(requestPane.locator('.md strong')).toHaveText('bold')
  await expect(requestPane.locator('.md .md-inline-code')).toHaveText('code')
})
