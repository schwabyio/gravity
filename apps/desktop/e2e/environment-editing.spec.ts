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
 * Environment files: edited in the Environments drawer and saved in place,
 * created, renamed — the choice following — and deleted, with a run using an
 * environment's unsaved edits.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let environments: string
let server: http.Server
let received: string[] = []
let app: ElectronApplication
let page: Page

const DEMO = [
  '# The sandbox everyone shares.',
  'name: demo',
  'vars:',
  '  path: demo # where demo points',
  '  apiKey: { secret: true }',
  ''
].join('\n')

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-environments-')))
  const repo = path.join(tmp, 'shop-api')
  environments = path.join(repo, 'environments')
  fs.mkdirSync(path.join(repo, 'collections'), { recursive: true })
  fs.mkdirSync(environments)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(
    path.join(repo, 'collections', 'shop.yml'),
    ['id: shop', 'steps:', '  - name: items', `    GET: "${origin}/{{path}}"`, ''].join('\n')
  )
  fs.writeFileSync(path.join(environments, 'demo.yml'), DEMO)
  // The secrets' values, which never go in an environment file.
  fs.writeFileSync(path.join(repo, '.env'), 'apiKey=k1\ntoken=t1\n')

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
  await page.locator('.collection-row').click()
  await page.getByLabel('Environment', { exact: true }).selectOption('demo')
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const file = (name: string) => path.join(environments, name)
const onDisk = (name: string) => fs.readFileSync(file(name), 'utf8')
const drawer = () => page.getByRole('dialog', { name: 'Environments' })
const listed = () => drawer().getByRole('navigation', { name: 'Environment files' })
const picker = () => page.getByLabel('Environment', { exact: true })
const send = async () => {
  received = []
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200')
}

test('the drawer shows each environment’s variables, a secret without a value', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  await expect(listed().getByRole('button')).toHaveText(['demo', '+ New environment'])
  await expect(drawer().getByLabel('Environment name', { exact: true })).toHaveValue('demo')
  await expect(drawer().getByLabel('Value of path')).toHaveValue('demo')
  await expect(drawer().getByLabel('Type of apiKey')).toHaveValue('secret')
  await expect(drawer().getByLabel('Value of apiKey')).toBeDisabled()
})

test('a variable changed here is saved in place, and the next send uses it', async () => {
  await drawer().getByLabel('Value of path').fill('v2')
  await expect
    .poll(() => onDisk('demo.yml'), { timeout: 5_000 })
    .toBe(DEMO.replace('path: demo', 'path: v2'))
  await drawer().getByRole('button', { name: 'Close' }).click()
  await send()
  expect(received).toEqual(['/v2'])
})

test('a new environment gets a file, variables and a secret', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  await listed().getByRole('button', { name: '+ New environment' }).click()
  await drawer().getByLabel('New environment name').fill('Staging EU')
  await drawer().getByRole('button', { name: 'Create' }).click()
  await expect(drawer().getByLabel('Environment name', { exact: true })).toHaveValue('Staging EU')
  expect(onDisk('staging-eu.yml')).toBe('name: Staging EU\n')
  await expect(listed().getByRole('button')).toHaveText(['demo', 'Staging EU', '+ New environment'])

  await drawer().getByLabel('Variable name').last().fill('path')
  await drawer().getByLabel('Value of path').fill('staging')
  await drawer().getByLabel('Variable name').last().fill('token')
  await drawer().getByLabel('Type of token').selectOption('secret')
  await expect
    .poll(() => onDisk('staging-eu.yml'), { timeout: 5_000 })
    .toBe('name: Staging EU\nvars:\n  path: staging\n  token: { secret: true }\n')
})

test('typing carries on across auto saves, without losing the field', async () => {
  const value = drawer().getByLabel('Value of path')
  await value.click()
  await page.keyboard.press('End')
  // Pauses longer than the auto save delay, so each character lands mid-save.
  for (const character of '-eu') {
    await page.keyboard.type(character)
    await page.waitForTimeout(1_200)
  }
  await expect(value).toHaveValue('staging-eu')
  await expect(value).toBeFocused()
  await expect
    .poll(() => onDisk('staging-eu.yml'), { timeout: 5_000 })
    .toContain('  path: staging-eu\n')

  await value.fill('staging')
  await expect
    .poll(() => onDisk('staging-eu.yml'), { timeout: 5_000 })
    .toContain('  path: staging\n')
})

test('renaming the chosen environment keeps it chosen', async () => {
  await drawer().getByRole('button', { name: 'Close' }).click()
  await picker().selectOption('Staging EU')
  await page.getByRole('button', { name: 'Edit environments' }).click()
  await expect(drawer().getByLabel('Environment name', { exact: true })).toHaveValue('Staging EU')
  await drawer().getByLabel('Environment name', { exact: true }).fill('staging')
  await expect.poll(() => onDisk('staging-eu.yml'), { timeout: 5_000 }).toMatch(/^name: staging\n/)
  await drawer().getByRole('button', { name: 'Close' }).click()
  await expect(picker()).toHaveValue('staging')
  await send()
  expect(received).toEqual(['/staging'])
})

test('with auto save off, a send uses the environment as edited', async () => {
  await page.getByRole('button', { name: 'App settings' }).click()
  await page.getByLabel('Auto save').click()
  await expect(page.getByLabel('Auto save')).not.toBeChecked()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await page.getByRole('button', { name: 'Edit environments' }).click()
  await drawer().getByLabel('Value of path').fill('unsaved')
  await expect(drawer().locator('.save-status')).toContainText('1 unsaved change')
  await drawer().getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'Edit environments' })).toContainText('•')

  await send()
  expect(received).toEqual(['/unsaved'])
  expect(onDisk('staging-eu.yml')).toContain('path: staging')

  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => onDisk('staging-eu.yml'), { timeout: 5_000 }).toContain('path: unsaved')
})

test('deleting the chosen environment removes its file and the choice', async () => {
  await page.getByRole('button', { name: 'Edit environments' }).click()
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void dialog.accept()
  })
  await drawer().getByRole('button', { name: 'Delete' }).click()
  await expect(listed().getByRole('button')).toHaveText(['demo', '+ New environment'])
  expect(asked).toBe('Delete the environment “staging”? This deletes staging-eu.yml.')
  expect(fs.existsSync(file('staging-eu.yml'))).toBe(false)
  await drawer().getByRole('button', { name: 'Close' }).click()
  await expect(picker()).toHaveValue('')
})
