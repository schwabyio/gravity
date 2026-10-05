import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * Test results end to end: a step's `expect` block runs against a real
 * response, and the Tests tab shows each assertion beside the body lines it is
 * about.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      req.url === '/list'
        ? JSON.stringify({ items: [{ id: 2 }, { id: 1 }] })
        : JSON.stringify({ user: { id: 7, name: 'Ada', roles: ['viewer', 'admin'] }, extra: 'x' })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-results-')))
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
      '      gta.useStrictValidation()',
      '      gta.expectResponseStatusCodeToBe(200)',
      "      gta.expectResponseToHaveHeader('Content-Type', /^application\\/json/)",
      "      gta.expectResponseBodyToHaveProperty('user.id', 7)",
      "      gta.expectResponseBodyToHaveProperty('user.name', 'Grace')",
      "      gta.expectResponseBodyToHaveUnorderedArray('user.roles', ['admin', 'viewer'])",
      '  - name: list',
      `    GET: "${origin}/list"`,
      '    tests: |',
      "      gta.sortResponseBodyArrays('id')",
      "      gta.expectResponseBodyToHaveProperty('items.0.id', 1)",
      '  - name: ignore some',
      `    GET: "${origin}/user"`,
      '    tests: |',
      "      gta.ignoreResponseBodyProperty('user.roles')",
      '      gta.useStrictValidation()',
      "      gta.expectResponseBodyToHaveProperty('user.id', 7)",
      "      gta.expectResponseBodyToHaveProperty('user.name', 'Ada')",
      "      gta.ignoreResponseBodyProperty('extra')",
      ''
    ].join('\n')
  )

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
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

const testResults = () => page.locator('.test-results')
const response = () => page.locator('.response')
const line = (text: string) => response().locator('.body-lines li', { hasText: text })
const check = (name: string) => testResults().locator('.check', { hasText: name })
const responseTab = (name: string) => response().locator('.tabs button', { hasText: name })

test('results open under the Tests script, and the editor steps aside for them', async () => {
  await expect(testResults().locator('.test-results-title')).toHaveText('Test Results')
  await expect(testResults().locator('.test-results-summary')).toHaveText('2 of 6 failed')
  await expect(page.locator('.scripts-pane').getByRole('textbox', { name: 'Tests' })).toBeVisible()
  await expect(page.locator('.request-pane')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show the request editor' })).toBeVisible()
  await expect(page.locator('.step-list .step-mark').first()).toHaveAccessibleName('failed')
  await expect(page.locator('.step-list .step-summary').first()).toHaveText(/^200 · \d+ ms$/)
  // Hovering the result says how many checks failed, and which.
  await page.locator('.step-list .step-result').first().hover()
  const tip = page.getByRole('tooltip')
  await expect(tip.locator('.step-hover-title')).toHaveText('2 of 6 checks failed')
  await expect(tip.locator('.step-hover-line')).toHaveText([/^✕ /, /^✕ /])
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)
})

test('a failed assertion shows what it expected beside what came back', async () => {
  const failed = check('user.name')
  await expect(failed).toHaveClass(/fail/)
  await expect(failed.locator('.check-compare dd').first()).toHaveText('is "Grace"')
  await expect(failed.locator('.check-compare dd').nth(1)).toHaveText('"Ada"')
})

test('body lines, headers and the status are marked by their assertions', async () => {
  await expect(line('"id": 7')).toHaveClass(/mark-pass/)
  await expect(line('"name": "Ada"')).toHaveClass(/mark-fail/)
  await expect(line('"extra": "x"')).toHaveClass(/mark-unasserted/)
  // An assertion on an array claims every line of it.
  await expect(line('"admin"')).toHaveClass(/mark-pass/)
  await expect(response().locator('.status-pill')).toHaveClass(/mark-pass/)

  await responseTab('Headers').click()
  await expect(response().locator('tr', { hasText: 'Content-Type' })).toHaveClass(/mark-pass/)
})

test('selecting an assertion opens the tab it is about and points at it', async () => {
  // A body assertion brings the Body tab back from Headers.
  await check('user.name').locator('.check-head').click()
  await expect(responseTab('Body')).toHaveClass(/active/)
  await expect(line('"name": "Ada"')).toHaveClass(/focused/)
  await expect(line('"id": 7')).not.toHaveClass(/focused/)

  await check('Header Content-Type').locator('.check-head').click()
  await expect(responseTab('Headers')).toHaveClass(/active/)
  await expect(response().locator('tr', { hasText: 'Content-Type' })).toHaveClass(/focused/)
})

test('clicking a marked line selects its assertion', async () => {
  await responseTab('Body').click()
  await line('"id": 7').click()
  await expect(check('user.id')).toHaveClass(/selected/)
})

test('strict validation leftovers jump to their line', async () => {
  await expect(check('Strict').locator('.unasserted')).toHaveText('extra')
  await check('Strict').getByRole('button', { name: 'extra' }).click()
  await expect(line('"extra": "x"')).toHaveClass(/focused/)
})

test('failures only hides what passed', async () => {
  await testResults().getByLabel('Failures only').check()
  await expect(testResults().locator('.check')).toHaveCount(2)
  await testResults().getByLabel('Failures only').uncheck()
  await expect(testResults().locator('.check')).toHaveCount(6)
})

test('the scripts pane hides to a strip that still shows the verdict', async () => {
  await page.getByRole('button', { name: 'Hide the scripts' }).click()
  await expect(page.locator('.scripts-pane')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show the scripts' })).toContainText('2 failed')
  await page.getByRole('button', { name: 'Show the scripts' }).click()
  await expect(testResults()).toBeVisible()
})

test('an editor opened by hand stays open for the next send', async () => {
  await page.getByRole('button', { name: 'Show the request editor' }).click()
  await expect(page.locator('.request-pane')).toBeVisible()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(testResults().locator('.test-results-summary')).toHaveText('2 of 6 failed')
  await expect(page.locator('.request-pane')).toBeVisible()
})

test('a sorted body is shown as checked, with the raw one a click away', async () => {
  await page.locator('.step-open', { hasText: 'list' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(testResults().locator('.test-results-summary')).toHaveText('All 1 passed')

  const lines = response().locator('.body-lines li')
  await expect(lines.nth(3)).toContainText('"id": 1')
  await expect(response().locator('.body-mode-note')).toHaveText('sorted by id')

  await response().getByRole('button', { name: 'Raw' }).click()
  await expect(response().locator('pre.code')).toContainText(/"id": 2[\s\S]*"id": 1/)
})

test('what the tests ignored is listed, and its lines marked, but never counted as a check', async () => {
  await page.locator('.step-open', { hasText: 'ignore some' }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  // Two checks and strict validation's verdict: the ignores are not among them.
  await expect(testResults().locator('.test-results-summary')).toHaveText('All 3 passed')
  const group = testResults().locator('.ignored-group')
  await expect(group.locator('.check-name')).toHaveText(['user.roles', 'extra'])
  await expect(group).toContainText('Counted as checked by strict validation')
  await expect(line('"extra": "x"')).toHaveClass(/mark-ignored/)
  await expect(line('"extra": "x"').locator('.line-mark')).toHaveText('–')
  // Every line inside an ignored property, but a checked one keeps its check.
  await expect(line('"admin"')).toHaveClass(/mark-ignored/)
  await expect(line('"id": 7')).toHaveClass(/mark-pass/)
  // The script's ignoring lines are marked as such.
  await expect(page.locator('.scripts-pane .cm-check-gutter .cm-check-mark')).toHaveText([
    '–',
    '✓',
    '✓',
    '–'
  ])
  // Picking one shows it in the body.
  await group.getByRole('button', { name: /extra/ }).click()
  await expect(line('"extra": "x"')).toHaveClass(/focused/)
})
