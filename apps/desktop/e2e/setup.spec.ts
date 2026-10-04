import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import YAML from 'yaml'
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
 * Setup and teardown (SPEC.md §2.10): steps run once around the others — and
 * around every row of a data file — shown and edited in lists of their own;
 * and `forEach`, one request per item of a list.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let shop: string
let origin: string
let server: http.Server
let received: string[] = []
let app: ElectronApplication
let page: Page

const PLAIN = (url: string) =>
  ['id: plain', 'steps:', '  # the only step', '  - name: one', `    GET: "${url}"`, ''].join('\n')

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-setup-')))
  shop = path.join(tmp, 'shop')
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(shop, file)), { recursive: true })
    fs.writeFileSync(path.join(shop, file), body)
  }
  write(
    'collections/seed.yml',
    [
      'id: seed',
      'setup:',
      '  - name: grant',
      `    POST: "${origin}/grant"`,
      '    tests: |',
      "      gta.set('admin', 'seed-admin')",
      "      gta.set('roots', ['r1', 'r2'])",
      'steps:',
      '  - name: write',
      `    PUT: "${origin}/write/{{who}}/{{admin}}"`,
      '  - name: read',
      `    GET: "${origin}/read/{{who}}"`,
      'teardown:',
      '  - name: revoke',
      `    DELETE: "${origin}/grant/{{item}}"`,
      '    forEach: "{{roots}}"',
      ''
    ].join('\n')
  )
  write('collections/seed.csv', 'who\na\nb\n')
  write(
    'collections/tagged.yml',
    [
      'id: tagged',
      'stepTags: true',
      'setup:',
      '  - name: grant',
      `    POST: "${origin}/tagged/grant"`,
      'steps:',
      '  - name: auth step',
      `    GET: "${origin}/tagged/auth"`,
      '    tags: [auth]',
      '  - name: other step',
      `    GET: "${origin}/tagged/other"`,
      '    tags: [other]',
      'teardown:',
      '  - name: revoke',
      `    DELETE: "${origin}/tagged/grant"`,
      ''
    ].join('\n')
  )
  write(
    'collections/bare.yml',
    [
      'id: bare',
      'setup:',
      '  - name: grant',
      `    POST: "${origin}/bare/grant"`,
      'steps: []',
      'teardown:',
      '  - name: revoke',
      `    DELETE: "${origin}/bare/grant"`,
      ''
    ].join('\n')
  )
  write(
    'requests/ping.yml',
    ['id: ping', 'params: {}', 'steps:', '  - name: ping', `    GET: "${origin}/ping"`, ''].join(
      '\n'
    )
  )
  write(
    'collections/mixed.yml',
    [
      'id: mixed',
      'setup:',
      '  - name: prepare',
      `    POST: "${origin}/prepare"`,
      'steps:',
      '  - use: ping',
      '    name: ping it',
      '  - name: maybe',
      `    GET: "${origin}/maybe"`,
      '    before:',
      '      script: |',
      "        gta.skip('not today')",
      ''
    ].join('\n')
  )
  write('collections/plain.yml', PLAIN(`${origin}/each/{{item}}`))
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 900 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row', { hasText: 'Seed' }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const section = (name: 'Setup' | 'Steps' | 'Teardown') => page.getByRole('region', { name })
const rowIn = (name: 'Setup' | 'Steps' | 'Teardown', step: string) =>
  section(name).locator('.step-list > li', { hasText: step })
const file = (id: string) => path.join(shop, 'collections', `${id}.yml`)
const read = (id: string) => fs.readFileSync(file(id), 'utf8')

test('setup and teardown show in lists of their own, around the steps', async () => {
  await expect(section('Setup').locator('.step-name')).toHaveText(['grant'])
  await expect(section('Steps').locator('.step-name')).toHaveText(['write', 'read'])
  await expect(section('Teardown').locator('.step-name')).toHaveText(['revoke'])
  await expect(section('Setup')).toContainText('Runs once before the steps, not once per row')
  await expect(section('Teardown')).toContainText('even when one of them failed')
})

test('Run all runs setup once, the steps per row, then teardown once per item', async () => {
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('7 passed', { timeout: 10_000 })
  expect(received).toEqual([
    'POST /grant',
    'PUT /write/a/seed-admin',
    'GET /read/a',
    'PUT /write/b/seed-admin',
    'GET /read/b',
    'DELETE /grant/r1',
    'DELETE /grant/r2'
  ])
  await expect(rowIn('Setup', 'grant').locator('.step-head .step-summary')).toContainText('200')
  await expect(rowIn('Teardown', 'revoke').locator('.step-head .step-summary')).toHaveText(
    '2 of 2 passed'
  )
  // Rows count their own steps; setup and teardown ran once, so they show on every row.
  const iterations = page.getByRole('group', { name: 'Iterations' })
  await expect(iterations.getByLabel('All iterations')).toHaveText('All: 4 passed')
  await iterations.locator('button.iteration').first().click()
  await expect(rowIn('Setup', 'grant').locator('.step-head .step-summary')).toContainText('200')
  await expect(rowIn('Teardown', 'revoke').locator('.step-head .step-summary')).toHaveText(
    '2 of 2 passed'
  )
})

test('a teardown step sent on its own runs without setup', async () => {
  received = []
  await rowIn('Teardown', 'revoke').locator('.step-open').click()
  await page.getByRole('button', { name: 'Send' }).click()
  // Its list comes from setup, which did not run.
  await expect(rowIn('Teardown', 'revoke').locator('.step-status')).toContainText(
    'Variable "roots" is not defined',
    { timeout: 10_000 }
  )
  expect(received).toEqual([])
})

test('setup and teardown steps are added, moved and deleted in their own lists', async () => {
  await page.locator('.collection-row', { hasText: 'Plain' }).click()
  await expect(page.getByRole('region', { name: 'Setup' })).toHaveCount(0)
  const original = read('plain')

  await page.getByRole('button', { name: '+ Add setup step' }).click()
  await expect.poll(() => YAML.parse(read('plain')).setup, { timeout: 5_000 }).toHaveLength(1)
  await page.getByRole('button', { name: '+ Add teardown step' }).click()
  await expect.poll(() => YAML.parse(read('plain')).teardown, { timeout: 5_000 }).toHaveLength(1)
  const text = read('plain')
  expect(text.indexOf('setup:')).toBeLessThan(text.indexOf('steps:'))
  expect(text.indexOf('teardown:')).toBeGreaterThan(text.indexOf('steps:'))
  // The steps are as they were, comment and all.
  expect(text).toContain(original.slice(original.indexOf('steps:')).trimEnd())

  // A second setup step, from the setup list's own button, then renamed and moved.
  await section('Setup').getByRole('button', { name: '+ Add setup step' }).click()
  await expect.poll(() => YAML.parse(read('plain')).setup, { timeout: 5_000 }).toHaveLength(2)
  await section('Setup').locator('.step-open').first().dblclick()
  await page.getByLabel('Step name').fill('grant')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => YAML.parse(read('plain')).setup.map((s: { name: string }) => s.name))
    .toEqual(['grant', 'New step'])
  await section('Setup').getByRole('button', { name: 'More actions for grant' }).click()
  await page.getByRole('menuitem', { name: 'Move down' }).click()
  await expect
    .poll(() => YAML.parse(read('plain')).setup.map((s: { name: string }) => s.name))
    .toEqual(['New step', 'grant'])
  await expect(section('Setup').locator('.step-name')).toHaveText(['New step', 'grant'])

  page.once('dialog', (dialog) => void dialog.accept())
  await section('Setup').getByRole('button', { name: 'More actions for grant' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect
    .poll(() => YAML.parse(read('plain')).setup.map((s: { name: string }) => s.name))
    .toEqual(['New step'])
  expect(YAML.parse(read('plain')).steps).toEqual([{ name: 'one', GET: `${origin}/each/{{item}}` }])

  // Deleting the last setup and teardown steps leaves the file as it was.
  for (const name of ['Setup', 'Teardown'] as const) {
    page.once('dialog', (dialog) => void dialog.accept())
    await section(name).getByRole('button', { name: 'More actions for New step' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
  }
  await expect.poll(() => read('plain'), { timeout: 5_000 }).toBe(original)
})

test('a step repeated for each item writes forEach and runs once per item', async () => {
  // With no setup or teardown left, the steps are a list of their own again.
  await expect(page.getByRole('region', { name: 'Steps' })).toHaveCount(0)
  await page.locator('.step-list > li', { hasText: 'one' }).locator('.step-open').click()
  await page.locator('.step-foreach > summary').click()
  await page.getByLabel('Repeat for each item of').fill('["x", "y"]')
  await expect
    .poll(() => YAML.parse(read('plain')).steps[0].forEach, { timeout: 5_000 })
    .toBe('["x", "y"]')
  await expect(page.locator('.step-foreach > summary')).toHaveText('for each ["x", "y"]')

  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(
    page.locator('.step-list > li', { hasText: 'one' }).locator('.step-summary')
  ).toHaveText('2 of 2 passed', { timeout: 10_000 })
  expect(received).toEqual(['GET /each/x', 'GET /each/y'])

  // Emptied, the step is written without it.
  await page.getByLabel('Repeat for each item of').fill('')
  await expect
    .poll(() => YAML.parse(read('plain')).steps[0], { timeout: 5_000 })
    .toEqual({
      name: 'one',
      GET: `${origin}/each/{{item}}`
    })
})

test('a use step, or a setup step, sent on its own runs only that', async () => {
  await page.locator('.collection-row', { hasText: 'Mixed' }).click()
  received = []
  await rowIn('Steps', 'ping it').locator('.step-open').click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(rowIn('Steps', 'ping it').locator('.step-head .step-summary')).toHaveText(
    '1 of 1 passed',
    {
      timeout: 10_000
    }
  )
  expect(received).toEqual(['GET /ping'])

  received = []
  await rowIn('Setup', 'prepare').locator('.step-open').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(rowIn('Setup', 'prepare').locator('.step-head .step-summary')).toContainText('200', {
    timeout: 10_000
  })
  expect(received).toEqual(['POST /prepare'])
})

test('a step its script skips says why, having sent nothing', async () => {
  received = []
  await rowIn('Steps', 'maybe').locator('.step-open').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(rowIn('Steps', 'maybe').locator('.step-mark')).toHaveAccessibleName('skipped', {
    timeout: 10_000
  })
  await expect(rowIn('Steps', 'maybe').locator('.step-status')).toHaveText('skipped: not today')
  await expect(page.locator('.placeholder.skipped')).toContainText('not today — nothing was sent')
  expect(received).toEqual([])
})

test('a use step has no forEach to edit; a request step has', async () => {
  await rowIn('Steps', 'ping it').locator('.step-open').click()
  await expect(page.locator('.step-foreach')).toHaveCount(0)
  await rowIn('Steps', 'maybe').locator('.step-open').click()
  await expect(page.locator('.step-foreach')).toHaveCount(1)
})

test('an edit to a setup step is saved in setup', async () => {
  await rowIn('Setup', 'prepare').locator('.step-open').click()
  await page.getByLabel('Request URL').fill(`${origin}/prepared`)
  await expect
    .poll(() => YAML.parse(read('mixed')).setup[0].POST, { timeout: 5_000 })
    .toBe(`${origin}/prepared`)
  expect(YAML.parse(read('mixed')).steps.map((s: { name: string }) => s.name)).toEqual([
    'ping it',
    'maybe'
  ])
})

test('a teardown written outside the app shows in its list at once', async () => {
  fs.writeFileSync(
    file('mixed'),
    `${read('mixed')}teardown:\n  - name: cleanup\n    DELETE: "${origin}/cleanup"\n`
  )
  await expect(section('Teardown').locator('.step-name')).toHaveText(['cleanup'], {
    timeout: 10_000
  })
  // It opens as itself: the app gave it an id of its own.
  await rowIn('Teardown', 'cleanup').locator('.step-open').click()
  await expect(page.getByLabel('Request URL')).toHaveValue(`${origin}/cleanup`)
})

test('a tag filter narrows the steps, never setup or teardown', async () => {
  await page.locator('.collection-row', { hasText: 'Tagged' }).click()
  const filter = page.getByRole('group', { name: 'Filter steps by tag' })
  await filter.getByRole('button', { name: 'auth' }).click()
  await expect(section('Setup').locator('.step-name')).toHaveText(['grant'])
  await expect(section('Teardown').locator('.step-name')).toHaveText(['revoke'])
  received = []
  await page.getByRole('button', { name: 'Run 1 step' }).click()
  await expect(page.locator('.run-summary')).toContainText('3 passed', { timeout: 10_000 })
  expect(received).toEqual(['POST /tagged/grant', 'GET /tagged/auth', 'DELETE /tagged/grant'])
  await filter.getByRole('button', { name: 'Clear' }).click()
})

test('a collection with only setup and teardown still runs them', async () => {
  await page.locator('.collection-row', { hasText: 'Bare' }).click()
  await expect(section('Setup').locator('.step-name')).toHaveText(['grant'])
  received = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(page.locator('.run-summary')).toContainText('2 passed', { timeout: 10_000 })
  expect(received).toEqual(['POST /bare/grant', 'DELETE /bare/grant'])
})
