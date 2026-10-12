import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
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

const COLOURED = [
  'Calls `GET /orders/{{orderId}}` as {{adminUser}}, expecting `201`.',
  '',
  '> [!WARNING]',
  '> Needs the `orders:write` scope.',
  '',
  '> [!TIP]',
  '> Pick **staging** first.',
  '',
  '```json',
  '{"sku": "{{sku}}", "qty": 2}',
  '```',
  '',
  '```js',
  "const id = gta.get('orderId')",
  '```'
].join('\n')

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'api-docs-')))
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
  // Docs that use what is coloured: callouts, fenced JSON and JS, variables, a method, a status.
  fs.writeFileSync(
    path.join(repo, 'collections', 'colours.yml'),
    [
      'id: colours',
      'docs: |-',
      ...COLOURED.split('\n').map((line) => `  ${line}`.trimEnd()),
      'steps:',
      '  - name: three',
      '    GET: "http://example.test/three"',
      ''
    ].join('\n')
  )
  // A collection without docs, so there is somewhere else to go and come back from.
  fs.writeFileSync(
    path.join(repo, 'collections', 'plain.yml'),
    ['id: plain', 'steps:', '  - name: two', '    GET: "http://example.test/two"', ''].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.waitForSelector('.collection-row')
  await openCollection('date')
  await page.waitForSelector('.docs-panel')
  // Docs open closed; open them so everything is on screen to assert against.
  await docsToggle().click()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const openCollection = (name: string) => page.locator('.collection-row', { hasText: name }).click()

const docs = () => page.locator('.docs-panel .md')
const docsToggle = () => page.locator('.docs-panel .docs-toggle')
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

test('docs sit under a Docs heading that opens and closes them', async () => {
  const toggle = docsToggle()
  await expect(toggle).toHaveText('Docs')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const heading = await toggle.boundingBox()

  // Closed, the heading is all there is: no docs, and hardly any room taken.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(docs()).toHaveCount(0)
  expect((await page.locator('.docs-panel').boundingBox())!.height).toBeLessThan(40)

  // The heading stays put, so it can be clicked again without chasing it.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(docs()).toBeVisible()
  expect((await toggle.boundingBox())!.y).toBe(heading!.y)

  // The pencil sits beside the title, and the row past it opens and closes them too.
  const pencil = await page
    .getByRole('button', { name: 'Edit the collection’s docs' })
    .boundingBox()
  expect(pencil!.x - (heading!.x + heading!.width)).toBeLessThan(16)
  const row = page.locator('.docs-head')
  const box = (await row.boundingBox())!
  await row.click({ position: { x: box.width - 20, y: box.height / 2 } })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await row.click({ position: { x: box.width - 20, y: box.height / 2 } })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

test('docs start closed', async () => {
  // Leaving the collection and coming back closes them again.
  await openCollection('plain')
  await expect(page.locator('.docs-panel')).toHaveCount(0)
  await openCollection('date')
  await expect(docsToggle()).toHaveAttribute('aria-expanded', 'false')
  await expect(docs()).toHaveCount(0)
})

test('a step with docs gets a Docs tab beside its scripts, after Tests', async () => {
  const scripts = page.locator('.scripts-pane')
  await expect(scripts.locator('.tabs button:not(.pane-toggle):not(.info-tip)')).toHaveText([
    /^Pre-request/,
    /^Tests/,
    /^Docs/
  ])
  // Not among what the request is made of.
  await expect(page.locator('.request-pane .tabs button', { hasText: 'Docs' })).toHaveCount(0)
  await scripts.getByRole('button', { name: /^Docs/ }).click()
  await expect(scripts.locator('.md strong')).toHaveText('bold')
  await expect(scripts.locator('.md .md-inline-code')).toHaveText('code')
  // Marked as having some.
  await expect(scripts.getByRole('button', { name: /^Docs/ }).locator('.dot')).toHaveCount(1)
})

test('a step without docs still has the tab, saying where they would go', async () => {
  await openCollection('plain')
  const scripts = page.locator('.scripts-pane')
  const tab = scripts.getByRole('button', { name: /^Docs/ })
  await expect(tab).toBeVisible()
  await expect(tab.locator('.dot')).toHaveCount(0)
  await tab.click()
  await expect(scripts.locator('.docs-empty')).toContainText('This step has no docs')
})

const plainFile = () => fs.readFileSync(path.join(tmp, 'r', 'collections', 'plain.yml'), 'utf8')

test('a step’s docs are written in the tab, previewed, and saved as its docs', async () => {
  const scripts = page.locator('.scripts-pane')
  await scripts.getByRole('button', { name: 'Edit the step’s docs' }).click()
  const box = scripts.getByRole('textbox', { name: 'Step docs' })
  await expect(box).toBeFocused()
  await page.keyboard.type('Says **hi**.')
  await expect
    .poll(plainFile, { timeout: 5_000 })
    .toContain('  - name: two\n    GET: "http://example.test/two"\n    docs: Says **hi**.\n')
  await scripts.getByRole('button', { name: 'Done' }).click()
  await expect(scripts.locator('.md strong')).toHaveText('hi')
  await expect(scripts.getByRole('button', { name: /^Docs/ }).locator('.dot')).toHaveCount(1)
})

test('a collection without docs gets them from + Docs, written above its steps', async () => {
  await page.getByRole('button', { name: '+ Docs' }).click()
  const box = page.getByRole('textbox', { name: 'Collection docs' })
  await expect(box).toBeFocused()
  await page.keyboard.type('Plain **one**.\n\nA second paragraph.')
  await expect
    .poll(plainFile, { timeout: 5_000 })
    .toContain('id: plain\ndocs: |-\n  Plain **one**.\n\n  A second paragraph.\nsteps:')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.docs-panel .md strong')).toHaveText('one')
  await expect(page.getByRole('button', { name: '+ Docs' })).toHaveCount(0)

  // The heading closes them while they are written too, and what was typed is kept.
  await page.getByRole('button', { name: 'Edit the collection’s docs' }).click()
  await box.fill('Plain **two**.')
  await expect.poll(plainFile, { timeout: 5_000 }).toContain('Plain **two**.')
  await docsToggle().click()
  await expect(box).toHaveCount(0)
  await expect(docs()).toHaveCount(0)
  await expect(docsToggle()).toHaveAttribute('aria-expanded', 'false')

  // Edited again from the pencil; emptied, they are gone from the file and + Docs is back.
  await page.getByRole('button', { name: 'Edit the collection’s docs' }).click()
  await box.fill('')
  await expect.poll(plainFile, { timeout: 5_000 }).not.toContain('Plain **')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '+ Docs' })).toBeVisible()
})

test('docs are formatted from the toolbar or the keys, and previewed as they will read', async () => {
  await page.getByRole('button', { name: '+ Docs' }).click()
  const box = page.getByRole('textbox', { name: 'Collection docs' })
  await expect(box).toBeFocused()
  const editor = page.locator('.docs-panel .docs-editor')
  const tool = (name: string) => editor.getByRole('toolbar').getByRole('button', { name })

  // Bold marks the word the cursor is in; ⌘I, with no word there, a pair to type between.
  await page.keyboard.type('Checks orders')
  await tool('Bold').click()
  await expect(box).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type(' and ')
  await page.keyboard.press('ControlOrMeta+i')
  await page.keyboard.type('refunds')
  // A list from the toolbar, which Enter carries on.
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await tool('Bulleted list').click()
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await expect
    .poll(plainFile, { timeout: 5_000 })
    .toContain('docs: |-\n  Checks **orders** and _refunds_\n  - one\n  - two\nsteps:')

  // Each tool says what it is, and its key where it has one.
  await page.mouse.move(0, 0)
  await tool('Bold').hover()
  await expect(page.getByRole('tooltip')).toHaveText(/^Bold \((⌘|Ctrl\+)B\)$/)

  // Preview shows them rendered, in place of the text and its tools; Write brings both back.
  await editor.getByRole('button', { name: 'Preview' }).click()
  const preview = editor.getByRole('region', { name: 'Preview' })
  await expect(preview.locator('strong')).toHaveText('orders')
  await expect(preview.locator('em')).toHaveText('refunds')
  await expect(preview.locator('li')).toHaveText(['one', 'two'])
  await expect(box).toBeHidden()
  await expect(editor.getByRole('toolbar')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Write' }).click()
  await expect(box).toBeFocused()
  await expect(preview).toHaveCount(0)
})

/** As much of the page's DOM as these run there, typed: specs are checked without the DOM's types. */
interface PageDom {
  document: {
    createElement: (tag: string) => { style: { color: string }; remove: () => void }
    body: { append: (node: unknown) => void }
  }
  getComputedStyle: (element: unknown) => { color: string }
}
/** The colour a CSS colour token comes to, as a computed style gives one. */
const token = (name: string) =>
  page.evaluate((name) => {
    // Run in the page, where `globalThis` is its window.
    const { document, getComputedStyle } = globalThis as unknown as PageDom
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, name)
const colorOf = (locator: ReturnType<Page['locator']>) =>
  locator.evaluate((element) => (globalThis as unknown as PageDom).getComputedStyle(element).color)

/** A node the observer saw added; text nodes have neither. */
interface AddedElement {
  matches: (selector: string) => boolean
  querySelector: (selector: string) => unknown
}
/** As much of a page's MutationObserver as the test below uses, typed the same way. */
interface Watching {
  MutationObserver: new (
    callback: (records: { addedNodes: ArrayLike<Partial<AddedElement>> }[]) => void
  ) => { observe: (target: unknown, options: { childList: boolean; subtree: boolean }) => void }
  document: { body: unknown }
  sawEditor?: boolean
}

test('another collection opens with its docs closed while these are written', async () => {
  // The test before left plain's docs being written.
  await expect(page.getByRole('textbox', { name: 'Collection docs' })).toBeVisible()
  // Watched from before the click, so an editor counts even if it is gone again by the
  // next frame. Removed by then, it still holds its text box.
  await page.evaluate(() => {
    const watching = globalThis as unknown as Watching
    const editor = '[aria-label="Collection docs"]'
    watching.sawEditor = false
    new watching.MutationObserver((records) => {
      for (const { addedNodes } of records)
        for (const node of Array.from(addedNodes))
          if (node.matches?.(editor) || node.querySelector?.(editor)) watching.sawEditor = true
    }).observe(watching.document.body, { childList: true, subtree: true })
  })
  await openCollection('colours')
  await expect(page.getByRole('heading', { name: 'colours', level: 1 })).toBeVisible()
  await expect(docsToggle()).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => (globalThis as unknown as Watching).sawEditor)).toBe(false)
})

test('docs are coloured: callouts, fenced code, variables, a method and a status code', async () => {
  await openCollection('colours')
  await expect(page.getByRole('heading', { name: 'colours', level: 1 })).toBeVisible()
  await expect(docsToggle()).toHaveAttribute('aria-expanded', 'false')
  await docsToggle().click()
  await expect(docsToggle()).toHaveAttribute('aria-expanded', 'true')

  // Callouts as GitHub has them: a title and icon in the callout's colour.
  const warning = docs().locator('.md-callout-warning')
  await expect(warning).toHaveAttribute('role', 'note')
  await expect(warning.locator('.md-callout-title')).toHaveText('Warning')
  await expect(warning).toContainText('Needs the orders:write scope.')
  expect(await colorOf(warning.locator('.md-callout-title'))).toBe(await token('--redirect'))
  expect(await colorOf(docs().locator('.md-callout-tip .md-callout-title'))).toBe(
    await token('--ok')
  )

  // A method and a status code in inline code, and variables in or out of code.
  const method = docs().locator('.md-method')
  await expect(method).toHaveText('GET')
  expect(await colorOf(method)).toBe(await token('--m-get'))
  const status = docs().locator('.md-status')
  await expect(status).toHaveText('201')
  expect(await colorOf(status)).toBe(await token('--ok'))
  await expect(docs().locator('.md-var')).toHaveText(['{{orderId}}', '{{adminUser}}', '{{sku}}'])
  expect(await colorOf(docs().locator('.md-var').first())).toBe(await token('--accent'))

  // Fenced JSON and JavaScript, token by token in the editors' colours.
  const json = docs().locator('.md-code[data-language="json"]')
  await expect(json).toHaveText('{"sku": "{{sku}}", "qty": 2}')
  expect(await colorOf(json.locator('.tok-name').first())).toBe(await token('--server'))
  expect(await colorOf(json.locator('.tok-number'))).toBe(await token('--redirect'))
  // A variable in a string is marked over the string's green.
  expect(await colorOf(json.locator('.md-var'))).toBe(await token('--accent'))
  const js = docs().locator('.md-code[data-language="js"]')
  expect(await colorOf(js.locator('.tok-keyword'))).toBe(await token('--accent'))
  expect(await colorOf(js.locator('.tok-string'))).toBe(await token('--ok'))

  // Written, fenced JSON is coloured in the text as it is shown.
  await page.getByRole('button', { name: 'Edit the collection’s docs' }).click()
  const box = page.getByRole('textbox', { name: 'Collection docs' })
  const key = box.locator('span').filter({ hasText: /^"qty"$/ })
  expect(await colorOf(key)).toBe(await token('--server'))
  await page.keyboard.press('Escape')
})
