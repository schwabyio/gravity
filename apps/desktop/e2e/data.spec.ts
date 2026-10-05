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
 * A data file (SPEC.md §2.8) beside a collection: the app marks it, runs a
 * single step with the row picked, and Run all once per row — as gta does —
 * with each row's results under its own iteration.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let csv: string
let server: http.Server
let seen: string[] = []
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '')
    // bob is not known: his row's check fails.
    res.writeHead(req.url === '/users/bob' ? 404 : 200, { 'content-type': 'application/json' })
    // slow takes its time, for Stop to land mid-run.
    setTimeout(() => res.end('{"ok":true}'), req.url === '/users/slow' ? 1500 : 0)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-data-')))
  const repo = path.join(tmp, 'users-api')
  const collections = path.join(repo, 'collections')
  fs.mkdirSync(collections, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    path.join(collections, 'users.yml'),
    [
      'id: users',
      'steps:',
      '  - name: get user',
      `    GET: "${origin}/users/{{userId}}"`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      ''
    ].join('\n')
  )
  csv = path.join(collections, 'users.csv')
  fs.writeFileSync(csv, 'userId,iterationLabel\nann,First\nbob,Second\ncat,Third\n')
  fs.writeFileSync(path.join(collections, 'plain.yml'), 'id: plain\nsteps: []\n')

  app = await launchApp({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 800 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row', { hasText: 'users' }).click()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const row = (name: string) => page.locator('.collection-row', { hasText: name })
const picker = () => page.getByRole('combobox', { name: 'Data row' })
const iterations = () => page.getByRole('group', { name: 'Iterations' })

test('a collection with a data file is marked with its row count', async () => {
  await expect(row('users').locator('.data-mark')).toHaveText('×3')
  await expect(row('plain').locator('.data-mark')).toHaveCount(0)
  await expect(page.locator('.collection-header .data-badge')).toHaveText('users.csv · 3 rows')
})

test('the row picker lists each row by its label, and a step runs with the row picked', async () => {
  await expect(picker().locator('option')).toHaveText(['1 — First', '2 — Second', '3 — Third'])
  await expect(picker()).toHaveValue('0')
  await picker().selectOption({ label: '3 — Third' })
  seen = []
  await page.locator('.step-list > li').first().getByText('get user', { exact: true }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => seen, { timeout: 10_000 }).toEqual(['/users/cat'])
  await expect(page.getByLabel('Result from')).toHaveText('Iteration 3 (Third) - get user')

  // Variables show the picked row's values, and where they came from.
  await page.mouse.move(0, 0)
  await page.locator('.var-token', { hasText: '{{userId}}' }).first().hover()
  const card = page.locator('.var-card')
  await expect(card.locator('.var-card-value')).toHaveText('cat')
  await expect(card.locator('.var-card-origin')).toHaveText(/users\.csv row 3/)
  await page.mouse.move(0, 0)
})

test('Run all runs every row in order, each an iteration of its own', async () => {
  seen = []
  // The button says it runs every row, so a single send's one row is not mistaken for it.
  await expect(page.locator('.run-all')).toHaveText('▶ Run all · 3 rows')
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect
    .poll(() => seen, { timeout: 10_000 })
    .toEqual(['/users/ann', '/users/bob', '/users/cat'])
  await expect(page.locator('.run-summary')).toContainText('2 passed')
  await expect(page.locator('.run-summary')).toContainText('1 failed')

  const chips = iterations().locator('button.iteration')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toHaveClass(/passed/)
  await expect(chips.nth(1)).toHaveClass(/failed/)
  await expect(chips.nth(2)).toHaveClass(/passed/)
  await expect(iterations().getByLabel('All iterations')).toHaveText(
    'All: 2 passed, 1 failed · 1 of 3 rows failed'
  )

  // An iteration picked shows its own results.
  await chips.nth(1).click()
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(picker()).toHaveValue('1')
  await expect(page.locator('.step-list .step-mark').first()).toHaveClass(/fail/)
  await expect(page.locator('.step-list .step-summary').first()).toContainText('404')
  await expect(page.getByLabel('Result from')).toHaveText('Iteration 2 (Second) - get user')
  await chips.nth(0).click()
  await expect(page.locator('.step-list .step-mark').first()).toHaveClass(/pass/)
})

test('Stop ends the run, leaving the rows after it unrun', async () => {
  fs.writeFileSync(csv, 'userId\nslow\nann\ncat\n')
  // No labels now: the picker shows the new file has been read.
  await expect(picker().locator('option')).toHaveText(['1', '2', '3'], { timeout: 5_000 })
  seen = []
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect.poll(() => seen, { timeout: 10_000 }).toEqual(['/users/slow'])
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('button', { name: 'Run all' })).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1000)
  expect(seen).toEqual(['/users/slow'])
})

test('the mark follows the file on disk', async () => {
  fs.writeFileSync(csv, 'userId\nann\nbob\ncat\ndan\n')
  await expect(row('users').locator('.data-mark')).toHaveText('×4', { timeout: 5_000 })
  await expect(page.locator('.collection-header .data-badge')).toHaveText('users.csv · 4 rows')
  await expect(picker().locator('option')).toHaveText(['1', '2', '3', '4'])
  fs.rmSync(csv)
  await expect(row('users').locator('.data-mark')).toHaveCount(0, { timeout: 5_000 })
  await expect(page.locator('.collection-header .data-badge:not(.create)')).toHaveCount(0)
  await expect(picker()).toHaveCount(0)
  await expect(iterations()).toHaveCount(0)
  await expect(page.getByRole('button', { name: '+ Data file' })).toBeVisible()
})
