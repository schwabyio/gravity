import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { DEFAULT_WINDOW, sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Find in the response body: ⌘F (Ctrl+F off a Mac) opens a find bar over the
 * Body tab that counts and marks every match, goes from one to the next, and
 * finds in Raw as in As checked — leaving ⌘F in a script editor to CodeMirror.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let server: http.Server
let app: ElectronApplication
let page: Page

const LONG = {
  wide: `${'x'.repeat(3000)} faraway`,
  items: Array.from({ length: 400 }, (_, id) => ({ id, tag: id === 399 ? 'needle' : 'hay' }))
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<user><name>Ada</name></user>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/long'
          ? LONG
          : {
              users: [
                { name: 'Ada', email: 'ada@example.test' },
                { name: 'Grace', email: 'grace@example.test' }
              ],
              note: 'ADA rules'
            }
      )
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'api-find-')))
  const repo = path.join(tmp, 'users-api')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    path.join(repo, 'collections', 'users.yml'),
    [
      'id: users',
      'steps:',
      '  - name: get user',
      `    GET: "${origin}/user"`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      '  - name: get xml',
      `    GET: "${origin}/xml"`,
      '  - name: long list',
      `    GET: "${origin}/long"`,
      ''
    ].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const response = () => page.locator('.response')
const findField = () => page.getByRole('textbox', { name: 'Find in the response body' })
const count = () => page.locator('.find-count')
const hits = () => response().locator('mark.find-hit')
const current = () => response().locator('mark.find-hit.current')
const openStep = async (name: string) => {
  await page.locator('.step-open', { hasText: name }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
}

test('⌘F opens find over the body, and counts and marks every match in any case', async () => {
  await page.keyboard.press('ControlOrMeta+f')
  await expect(findField()).toBeFocused()
  await page.keyboard.type('ada')
  await expect(count()).toHaveText('1 of 3')
  await expect(hits()).toHaveText(['Ada', 'ada', 'ADA'])
  await expect(current()).toHaveText('Ada')
})

test('Enter, ⌘G and the arrows go from one match to the next, and round', async () => {
  // Enter straight after typing goes on from what was just typed.
  await findField().fill('')
  await page.keyboard.type('ada')
  await page.keyboard.press('Enter')
  await expect(count()).toHaveText('2 of 3')
  await expect(current()).toHaveText('ada')
  await findField().press('Shift+Enter')
  await expect(count()).toHaveText('1 of 3')
  await findField().press('Shift+Enter')
  await expect(count()).toHaveText('3 of 3')
  await expect(current()).toHaveText('ADA')

  await page.keyboard.press('ControlOrMeta+g')
  await expect(count()).toHaveText('1 of 3')
  await page.keyboard.press('ControlOrMeta+Shift+g')
  await expect(count()).toHaveText('3 of 3')

  await page.getByRole('button', { name: 'Next match' }).click()
  await expect(count()).toHaveText('1 of 3')
  await page.getByRole('button', { name: 'Previous match' }).click()
  await expect(count()).toHaveText('3 of 3')
})

test('Match case finds only what is typed as typed', async () => {
  await page.getByRole('button', { name: 'Match case' }).click()
  await expect(page.getByRole('button', { name: 'Match case' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(count()).toHaveText('1 of 1')
  await expect(hits()).toHaveText(['ada'])
  await findField().fill('Nobody')
  await expect(count()).toHaveText('No results')
  await expect(page.getByRole('button', { name: 'Next match' })).toBeDisabled()
  await page.getByRole('button', { name: 'Match case' }).click()
  await findField().fill('ada')
  await expect(count()).toHaveText('1 of 3')
})

test('Escape closes it; ⌘F brings the search back, selected to type over', async () => {
  await findField().press('Escape')
  await expect(page.locator('.find-bar')).toHaveCount(0)
  await expect(hits()).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+f')
  await expect(findField()).toBeFocused()
  await expect(findField()).toHaveValue('ada')
  await expect(count()).toHaveText('1 of 3')
  await page.keyboard.type('grace')
  await expect(findField()).toHaveValue('grace')
  await expect(count()).toHaveText('1 of 2')
})

test('⌘F from the Headers tab, or with the response hidden, finds in the body', async () => {
  await page.getByRole('button', { name: 'Close find' }).click()
  await response().locator('.tabs button', { hasText: 'Headers' }).click()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(response().locator('.tabs button.active')).toHaveText('Body')
  await expect(findField()).toBeFocused()

  await page.getByRole('button', { name: 'Close find' }).click()
  await page.getByRole('button', { name: 'Hide the response' }).click()
  await expect(response()).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+f')
  await expect(findField()).toBeFocused()
  await expect(count()).toHaveText('1 of 2')
})

test('⌘F in a script editor is CodeMirror’s own search, not the body’s', async () => {
  await page.getByRole('button', { name: 'Close find' }).click()
  await page.locator('.scripts-pane').getByRole('textbox', { name: 'Tests' }).click()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(page.locator('.scripts-pane .cm-search')).toBeVisible()
  await expect(page.locator('.find-bar')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('the script editor’s search reads clearly in dark mode', async () => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('.scripts-pane').getByRole('textbox', { name: 'Tests' }).click()
  await page.keyboard.press('ControlOrMeta+f')
  const controls = page.locator('.scripts-pane .cm-search').locator('.cm-textfield, .cm-button')
  await expect(controls).toHaveCount(7)
  // Each field and button's text against what is behind it: WCAG's 4.5:1 for text.
  const contrasts = await controls.evaluateAll((elements) => {
    // Run in the page, where `globalThis` is its window.
    type Style = { color: string; backgroundColor: string; backgroundImage: string }
    const { getComputedStyle } = globalThis as unknown as {
      getComputedStyle: (element: unknown) => Style
    }
    const channels = (color: string) =>
      color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
    const luminance = (color: string) => {
      const [r, g, b] = channels(color).map((value) => {
        const c = value / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    return elements.map((element) => {
      const style = getComputedStyle(element)
      // A gradient behind the text, CodeMirror's own, cannot be read off: count it as none.
      if (style.backgroundImage !== 'none') return 1
      const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort(
        (a, b) => b - a
      )
      return (light! + 0.05) / (dark! + 0.05)
    })
  })
  for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5)
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: null })
})

test('finds in Raw as in As checked, each in what it shows', async () => {
  await openStep('get xml')
  await page.keyboard.press('ControlOrMeta+f')
  await findField().fill('<name>')
  await expect(count()).toHaveText('No results')
  await response().getByRole('button', { name: 'Raw' }).click()
  await expect(count()).toHaveText('1 of 1')
  await expect(response().locator('pre.response-body')).toHaveText('<user><name>Ada</name></user>')
  await expect(current()).toHaveText('<name>')
  await response().getByRole('button', { name: 'As checked' }).click()
  await findField().fill('ada')
  await expect(count()).toHaveText('1 of 1')
})

test('the current match is scrolled into view, down and across, under a find bar that stays', async () => {
  await openStep('long list')
  await page.keyboard.press('ControlOrMeta+f')
  await findField().fill('needle')
  await expect(count()).toHaveText('1 of 1')
  await expect(current()).toBeInViewport()
  await expect(page.locator('.find-bar')).toBeInViewport()

  await findField().fill('faraway')
  await expect(current()).toBeInViewport()
  await expect(findField()).toBeInViewport({ ratio: 1 })
})
