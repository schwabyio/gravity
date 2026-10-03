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
 * What git says of each file, in the sidebar: M on a collection, request set,
 * endpoints file or base changed since the last commit, U on one not
 * committed yet, C on one in conflict — and a dot on a folder holding any.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let repo: string
let globalConfig: string
let app: ElectronApplication
let page: Page

/** git with a config of the test's own, so no signing or identity of the machine's reaches it. */
const gitEnv = (): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  ),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1'
})
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], {
    cwd: repo,
    stdio: 'pipe',
    env: gitEnv()
  }).toString()
const write = (relative: string, body: string) => {
  const file = path.join(repo, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}
const collection = (id: string) => `id: ${id}\nsteps: []\n`

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-git-marks-')))
  globalConfig = path.join(tmp, 'gitconfig')
  fs.writeFileSync(globalConfig, '')
  repo = path.join(tmp, 'shop')
  write('collections/orders.yml', collection('orders'))
  write('collections/checkout/sessions.yml', collection('sessions'))
  write('collections/checkout/sessions.csv', 'user\nada\n')
  write('collections/admin/users.yml', collection('users'))
  write('requests/login.yml', 'id: login\nparams: {}\nsteps: []\n')
  git('init', '--initial-branch=main')
  git('add', '-A')
  git('commit', '-m', 'start')

  app = await electron.launch({
    args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`],
    env: gitEnv()
  })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
  await addProject(app, page, repo)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const shop = () => page.getByRole('region', { name: 'Project shop', exact: true })
const mark = (row: string) =>
  shop().locator('.collection-item, .set-row', { hasText: row }).locator('.git-mark').first()
const folderDot = (folder: string) =>
  shop().locator('.folder-item', { hasText: folder }).locator('.git-mark.dot')

test('a clean repository marks nothing', async () => {
  await expect(shop().locator('.repo-branch')).toHaveText('main')
  await expect(shop().locator('.git-mark')).toHaveCount(0)
})

test('changed files are M, new ones U, and their folders get a dot', async () => {
  write('collections/orders.yml', `${collection('orders')}# edited\n`)
  write('collections/checkout/sessions.csv', 'user\nada\ngrace\n')
  write('collections/admin/roles.yml', collection('roles'))
  write('requests/login.yml', 'id: login\nparams: {}\nsteps: []\n# edited\n')

  await expect(mark('orders')).toHaveAttribute('data-letter', 'M')
  await expect(mark('orders')).toHaveClass(/modified/)
  // A data file is its collection's: the collection is marked.
  await expect(mark('sessions')).toHaveAttribute('data-letter', 'M')
  await expect(mark('roles')).toHaveAttribute('data-letter', 'U')
  await expect(mark('roles')).toHaveClass(/new/)
  await expect(mark('login')).toHaveAttribute('data-letter', 'M')
  await expect(mark('users')).toHaveCount(0)
  await expect(folderDot('checkout')).toHaveClass(/modified/)
  await expect(folderDot('admin')).toHaveClass(/new/)
  // Said in words where the row explains itself.
  await expect(shop().locator('.collection-row', { hasText: 'roles' })).toHaveAttribute(
    'title',
    'admin/roles.yml — new, not committed yet'
  )
})

test('a file gone from a folder still marks the folder', async () => {
  fs.rmSync(path.join(repo, 'collections', 'admin', 'users.yml'))
  fs.rmSync(path.join(repo, 'collections', 'admin', 'roles.yml'))
  await expect(shop().locator('.collection-row', { hasText: 'users' })).toHaveCount(0)
  await expect(folderDot('admin')).toHaveClass(/modified/)
})

test('a commit clears the marks', async () => {
  git('add', '-A')
  git('commit', '-m', 'changes')
  await expect(shop().locator('.git-mark')).toHaveCount(0)
})

test('a file in conflict is C, and outranks a change in its folder', async () => {
  git('checkout', '-b', 'theirs')
  write('collections/checkout/sessions.yml', `${collection('sessions')}# theirs\n`)
  git('commit', '-am', 'theirs')
  git('checkout', 'main')
  write('collections/checkout/sessions.yml', `${collection('sessions')}# ours\n`)
  git('commit', '-am', 'ours')
  expect(() => git('merge', 'theirs')).toThrow()

  await expect(mark('sessions')).toHaveAttribute('data-letter', 'C')
  await expect(mark('sessions')).toHaveClass(/conflicted/)
  await expect(folderDot('checkout')).toHaveClass(/conflicted/)

  git('merge', '--abort')
  await expect(shop().locator('.git-mark')).toHaveCount(0)
})

test('the open collection marks each step changed, new or moved since the last commit', async () => {
  const steps = (...names: string[]) =>
    `id: flow\nsteps:\n${names.map((n) => `  - name: ${n}\n    GET: http://127.0.0.1:9/${n}\n`).join('')}`
  write('collections/flow.yml', steps('login', 'list', 'remove'))
  git('add', '-A')
  git('commit', '-m', 'flow')
  await shop().locator('.collection-row', { hasText: 'flow' }).click()
  await expect(page.locator('.collection-header h1')).toHaveText('flow')
  const bar = (n: number) => page.locator('.step-list > li').nth(n).locator('.step-git')
  await expect(page.locator('.step-git')).toHaveCount(0)

  // list changed, remove gone, create new.
  write('collections/flow.yml', steps('login', 'list', 'create').replace('9/list', '9/list?page=2'))
  await expect(bar(1)).toHaveClass(/changed/)
  await expect(bar(1)).toHaveAttribute('aria-label', 'Changed since the last commit')
  await expect(bar(2)).toHaveClass(/new/)
  await expect(bar(0)).toHaveCount(0)
  await expect(page.locator('.steps-removed')).toHaveText('1 step removed since the last commit')
  await expect(page.locator('.settings-changed')).toHaveCount(0)

  // Moved, and the collection's own headers changed: the settings gear says so.
  write(
    'collections/flow.yml',
    steps('list', 'remove', 'login').replace(
      'steps:',
      'headers:\n  Accept: application/json\nsteps:'
    )
  )
  await expect(bar(2)).toHaveClass(/moved/)
  await expect(bar(0)).toHaveCount(0)
  await expect(page.locator('.steps-removed')).toHaveCount(0)
  await expect(page.locator('.settings-changed')).toHaveCount(1)

  git('add', '-A')
  git('commit', '-m', 'flow again')
  await expect(page.locator('.step-git')).toHaveCount(0)
  await expect(page.locator('.settings-changed')).toHaveCount(0)
})
