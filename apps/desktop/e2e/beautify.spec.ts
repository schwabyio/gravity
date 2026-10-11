import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * The Body tab's editor: JSON and XML coloured, variables marked, ⌘F to find;
 * and Beautify, for a JSON or XML body: indented two spaces a level, every
 * value and variable kept as written, saved like an edit and undone like one;
 * a body that is not JSON or XML says where, unchanged.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-beautify-')))
  const shop = path.join(tmp, 'shop')
  fs.mkdirSync(path.join(shop, 'collections'), { recursive: true })
  file = path.join(shop, 'collections', 'orders.yml')
  fs.writeFileSync(
    file,
    [
      'id: orders',
      'steps:',
      '  - name: create',
      '    POST: http://127.0.0.1:9/orders',
      '    body:',
      `      json: '{"sku":"{{sku}}","qty":{{qty}},"price":1.0}'`,
      '  - name: soap',
      '    POST: http://127.0.0.1:9/soap',
      '    body:',
      `      xml: '<order id="{{id}}"><sku>ACME-1</sku><gift/></order>'`,
      '  - name: note',
      '    POST: http://127.0.0.1:9/note',
      '    body:',
      '      text: hello',
      ''
    ].join('\n')
  )
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 900 })
  await page.waitForSelector('.sidebar')
  await (await addProject(app, page, shop)).locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const open = async (step: string) => {
  await page.locator('.step-list > li', { hasText: step }).locator('.step-open').click()
  await page.locator('.request-pane').getByRole('button', { name: /^Body/ }).click()
}
const body = () => page.getByRole('textbox', { name: 'Request body' })
/** As much of the page's DOM as these run there, typed: specs are checked without the DOM's types. */
interface PageDom {
  document: {
    createElement: (tag: string) => { style: { color: string }; remove: () => void }
    body: { append: (node: unknown) => void }
  }
  getComputedStyle: (element: unknown) => { color: string }
}
/** The body as the editor holds it, line by line. */
const text = () =>
  body().evaluate((content) => (content as unknown as { innerText: string }).innerText)
const onDisk = (index: number) => YAML.parse(fs.readFileSync(file, 'utf8')).steps[index].body
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
/** The colour of the token that is `text` and nothing else. */
const colorOf = (text: string) =>
  body()
    .locator('span')
    .filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .last()
    .evaluate((span) => (globalThis as unknown as PageDom).getComputedStyle(span).color)

test('a JSON body is coloured: names, strings, numbers, and its variables as the URL has them', async () => {
  await open('create')
  expect(await colorOf('"price"')).toBe(await token('--server'))
  expect(await colorOf('1.0')).toBe(await token('--redirect'))
  // No environment holds them: shown as resolving to nothing.
  await expect(body().locator('.cm-var.unresolved')).toHaveText(['{{sku}}', '{{qty}}'])
})

test('Beautify indents a JSON body, keeps its values and variables, and is undone as an edit', async () => {
  await page.getByRole('button', { name: 'Beautify' }).click()
  const pretty = '{\n  "sku": "{{sku}}",\n  "qty": {{qty}},\n  "price": 1.0\n}'
  await expect.poll(text).toBe(pretty)
  await expect.poll(() => onDisk(0).json, { timeout: 5_000 }).toBe(pretty)

  await body().press('ControlOrMeta+z')
  await expect.poll(text).toBe('{"sku":"{{sku}}","qty":{{qty}},"price":1.0}')
  await expect
    .poll(() => onDisk(0).json, { timeout: 5_000 })
    .toBe('{"sku":"{{sku}}","qty":{{qty}},"price":1.0}')
})

test('⌘F finds in the body, not in the response', async () => {
  await body().click()
  await body().press('ControlOrMeta+f')
  const search = page.locator('.body-code .cm-search')
  await expect(search).toBeVisible()
  // Typed: the panel takes its query as keys come up.
  await expect(search.getByRole('textbox', { name: 'Find' })).toBeFocused()
  await page.keyboard.type('price')
  await expect(body().locator('.cm-searchMatch')).toHaveText(['price'])
  await expect(page.locator('.find-bar')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
})

test('a body that is not JSON says where, and is left as it is', async () => {
  await body().fill('{"sku": "A" "qty": 1}')
  await page.getByRole('button', { name: 'Beautify' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Not valid JSON: Expected , or } (line 1, column 13)'
  )
  await expect.poll(text).toBe('{"sku": "A" "qty": 1}')
  // Edited, the problem goes with the body it was about.
  await body().fill('{"sku": "A", "qty": 1}')
  await expect(page.locator('.body-problem')).toHaveCount(0)
})

test('Shift+Alt+F beautifies an XML body, coloured as XML', async () => {
  await open('soap')
  expect(await colorOf('sku')).toBe(await token('--server'))
  expect(await colorOf('id')).toBe(await token('--redirect'))
  await body().click()
  await body().press('Shift+Alt+KeyF')
  const pretty = '<order id="{{id}}">\n  <sku>ACME-1</sku>\n  <gift/>\n</order>'
  await expect.poll(text).toBe(pretty)
  await expect.poll(() => onDisk(1).xml, { timeout: 5_000 }).toBe(pretty)
})

test('a text body has no Beautify', async () => {
  await open('note')
  await expect.poll(text).toBe('hello')
  await expect(page.getByRole('button', { name: 'Beautify' })).toHaveCount(0)
})
