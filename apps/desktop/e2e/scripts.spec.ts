import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
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
 * Code in a step: the Tests and Pre-request tabs, xtest on `gta`, and what a
 * script's results, console output and errors look like once it has run.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let file: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, user: { id: 7, name: 'Ada', roles: ['admin'] } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-scripts-')))
  const repo = path.join(tmp, 'users-api')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  file = path.join(repo, 'collections', 'users.yml')
  fs.writeFileSync(
    file,
    [
      'id: users',
      'steps:',
      '  - name: get user',
      `    GET: "${origin}/users/{{userId}}"`,
      '    before:',
      '      script: |',
      "        gta.set('userId', 7)",
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      "      gta.expectResponseBodyToHaveProperty('user.name', 'Grace')",
      "      gta.expectResponseBodyToHaveProperty('user.nickname', null, 'notThisExpectedKey')",
      "      gta.test('roles are known', () => assert.deepEqual(res.body.user.roles, ['admin']))",
      "      console.log('user', res.body.user.id)",
      '  - name: no code',
      `    GET: "${origin}/plain"`,
      ''
    ].join('\n')
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const results = () => page.locator('.test-results')
const check = (name: string) => results().locator('.check', { hasText: name })
const scriptTab = (name: string) => page.locator('.scripts-pane .tabs button', { hasText: name })
const editor = (label: string) => page.getByRole('textbox', { name: label })

test('the scripts pane shows the step’s code, Tests first, Pre-request a tab away', async () => {
  // Tests is open from the start, beside the request: nothing to click.
  await expect(scriptTab('Tests')).toHaveClass(/active/)
  await expect(editor('Tests')).toContainText('gta.expectResponseStatusCodeToBe(200)')
  // The request editor keeps only what the request is made of.
  await expect(page.locator('.request-pane .tabs button', { hasText: 'Tests' })).toHaveCount(0)
  await expect(page.locator('.request-pane .tabs button', { hasText: 'Pre-request' })).toHaveCount(
    0
  )
  // Pre-request comes first, the order they run.
  await expect(page.locator('.scripts-pane .tabs button').first()).toContainText('Pre-request')
  await scriptTab('Pre-request').click()
  await expect(editor('Pre-request script')).toContainText("gta.set('userId', 7)")
})

test('the page ends where the window does, with the code editor on it', async () => {
  // Nothing below the app to scroll to: the editor's tooltip holder once ran past it.
  const sizes = await page.evaluate(() => {
    const view = globalThis as unknown as {
      innerHeight: number
      document: { scrollingElement: { scrollHeight: number } }
    }
    return { page: view.document.scrollingElement.scrollHeight, window: view.innerHeight }
  })
  expect(sizes.page).toBe(sizes.window)
})

test('each script tab says what its script holds before a run', async () => {
  await expect(scriptTab('Pre-request').locator('.script-chip')).toHaveText('1 line')
  await expect(scriptTab('Tests').locator('.script-chip')).toHaveText(/^\d+ checks?$/)
})

test('switching steps shows each step’s own code, and says when there is none', async () => {
  await scriptTab('Tests').click()
  await page.locator('.step-open', { hasText: 'no code' }).click()
  await expect(editor('Tests')).toContainText('No tests for this step yet')
  await expect(page.locator('.cm-placeholder')).toBeVisible()
  await page.locator('.step-open', { hasText: 'get user' }).click()
  await expect(editor('Tests')).toContainText('gta.expectResponseStatusCodeToBe(200)')
  await expect(page.locator('.cm-placeholder')).toHaveCount(0)
})

test('running the code reports each check, a named test and the console', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  // The pre-request script supplied the variable the URL needed.
  await expect(results().locator('.test-results-summary')).toHaveText('1 of 4 failed')
  // The tabs say how it went; the script stays on top, the results under it.
  await expect(scriptTab('Tests').locator('.script-chip')).toHaveText('✕ 1 of 4')
  await expect(scriptTab('Pre-request').locator('.script-chip')).toHaveText('✓')
  await expect(editor('Tests')).toBeVisible()
  const script = (await editor('Tests').boundingBox())!
  expect(script.y).toBeLessThan((await results().boundingBox())!.y)
  // Each line a check was made on is marked, a failure with what it said under it.
  const marks = page.locator('.scripts-pane .cm-check-gutter .cm-check-mark')
  await expect(marks).toHaveText(['✓', '✕', '✓', '✓'])
  await expect(marks.nth(1)).toHaveAttribute('aria-label', /^✕ user\.name/)
  await expect(page.locator('.scripts-pane .cm-check-failed')).toHaveText(
    "gta.expectResponseBodyToHaveProperty('user.name', 'Grace')"
  )
  await expect(page.locator('.scripts-pane .cm-check-note')).toContainText('Grace')
  await expect(check('user.name')).toHaveClass(/fail/)
  await expect(check('user.nickname is absent')).toHaveClass(/pass/)
  await expect(
    results().locator('.check-group', { hasText: 'Tests' }).locator('.check')
  ).toHaveText(/roles are known/)
  await expect(results().locator('.console-lines')).toHaveText('user 7')
  // A check written in code marks the body line it is about, like any other.
  await expect(page.locator('.response .body-lines li', { hasText: '"name": "Ada"' })).toHaveClass(
    /mark-fail/
  )
})

test('the marks follow their lines through an edit, and the next send marks it afresh', async () => {
  const marks = page.locator('.scripts-pane .cm-check-gutter .cm-check-mark')
  await editor('Tests').click()
  // A line pushed down keeps its mark; nothing was checked on the new one yet.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Enter')
  await expect(marks).toHaveText(['✓', '✕', '✓', '✓'])
  await expect(page.locator('.scripts-pane .cm-check-failed')).toContainText("'user.name'")
  await page.keyboard.press('Backspace')

  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type("gta.test('from the editor', () => assert.ok(true))")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(check('from the editor')).toHaveClass(/pass/)
  await expect(marks).toHaveText(['✓', '✕', '✓', '✓', '✓'])
})

test('the editor completes gta', async () => {
  await editor('Tests').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('gta.expectResponseBodyToHaveU')
  const options = page.locator('.cm-tooltip-autocomplete li')
  await expect(options.first()).toContainText('expectResponseBodyToHaveUnorderedArray')
  await page.keyboard.press('Escape')
  // Leave the half-typed call out of the next test.
  for (let i = 0; i < 'gta.expectResponseBodyToHaveU'.length + 1; i++) {
    await page.keyboard.press('Backspace')
  }
})

test('a script that throws is shown with its line, and the editor marks it', async () => {
  await editor('Tests').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('notDefined()')
  await page.getByRole('button', { name: 'Send' }).click()

  const banner = results().locator('.script-error')
  await expect(banner).toContainText('Tests stopped at line 8')
  await expect(banner).toContainText('ReferenceError: notDefined is not defined')
  await expect(banner).toContainText('The line is marked in the script above')
  await expect(scriptTab('Tests').locator('.script-chip')).toHaveText('!')
  await expect(page.locator('.cm-error-line')).toHaveText('notDefined()')
})

test('saving writes the code back as the step’s tests', async () => {
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.app-subtitle')).not.toContainText('•')
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('      notDefined()\n')
  const saved = fs.readFileSync(file, 'utf8')
  expect(saved).toContain('    tests: |')
  expect(saved).toContain("      gta.test('from the editor', () => assert.ok(true))")
  // The pre-request script is untouched.
  expect(saved).toContain("      script: |\n        gta.set('userId', 7)")
})

test('the editor shows syntax errors and unknown gta functions as you type', async () => {
  await editor('Tests').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const = 1')

  // V8's own message, underlined where it points, with a marker in the gutter.
  await expect(page.locator('.cm-lintRange-error')).toHaveText('=')
  await expect(page.locator('.cm-lint-marker-error')).toHaveCount(1)
  await page.locator('.cm-lintRange-error').hover()
  await expect(page.locator('.cm-tooltip-lint')).toContainText("SyntaxError: Unexpected token '='")

  // Fixing it clears it.
  await page.keyboard.press('ControlOrMeta+End')
  for (let i = 0; i < 'const = 1'.length; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type("gta.expectResponseBodyToHaveProprety('id', 7)")
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0)
  await page.locator('.cm-lintRange-warning').hover()
  await expect(page.locator('.cm-tooltip-lint')).toContainText(
    'Did you mean expectResponseBodyToHaveProperty?'
  )
})
