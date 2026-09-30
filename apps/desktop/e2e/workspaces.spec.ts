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

/**
 * Workspaces and projects, end to end, against real git repositories.
 *
 * Nothing here is mocked except the native folder picker, which Playwright cannot
 * click: it is stubbed inside the main process, which is also how the app would
 * receive a real user's choice.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let userData: string
let singleRepo: string
let monorepo: string
let app: ElectronApplication
let page: Page

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** A collection file: a name and an ordered list of steps. */
/**
 * Steps point at a closed port on the loopback.
 *
 * They are meant to fail, and `127.0.0.1:1` refuses instantly with no name
 * resolution — a hostname would make the suite wait on DNS.
 */
const collection = (id: string, steps: Array<[string, string]>) =>
  [
    `id: ${id}`,
    'steps:',
    ...steps.flatMap(([step, method]) => [
      `  - name: ${step}`,
      `    ${method}: "http://127.0.0.1:1/${step}"`
    ]),
    ''
  ].join('\n')

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'user.name', 'Test')
}

const commitAll = (dir: string, message: string) => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', message, '--no-gpg-sign')
}

/** Point the folder picker at a path, the way a user choosing it would. */
async function pickFolder(target: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, target)
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-e2e-')))
  userData = path.join(tmp, 'userData')
  // These tests are about unsaved edits and explicit saves, so auto save is off.
  write(
    path.join(userData, 'settings.json'),
    JSON.stringify({ version: 1, editing: { autoSave: { enabled: false, delayMs: 1000 } } })
  )

  singleRepo = path.join(tmp, 'payments-api')
  initRepo(singleRepo)
  write(
    path.join(singleRepo, 'collections', 'checkout.yml'),
    collection('checkout', [
      ['create-session', 'POST'],
      ['capture', 'POST']
    ])
  )
  commitAll(singleRepo, 'initial')

  monorepo = path.join(tmp, 'platform')
  initRepo(monorepo)
  write(path.join(monorepo, '.gitignore'), 'node_modules/\n')
  write(
    path.join(monorepo, 'services', 'auth', 'collections', 'auth.yml'),
    collection('auth', [['login', 'POST']])
  )
  write(
    path.join(monorepo, 'services', 'auth', 'collections', 'tokens', 'refresh.yml'),
    collection('refresh', [['refresh-token', 'POST']])
  )
  // Deeper than one directory: reported on the project, never loaded.
  write(
    path.join(monorepo, 'services', 'auth', 'collections', 'tokens', 'old', 'legacy.yml'),
    collection('legacy', [['x', 'GET']])
  )
  write(
    path.join(monorepo, 'services', 'users', 'collections', 'users.yml'),
    collection('users', [['get-user', 'GET']])
  )
  // Outside collections/ and inside node_modules: never discovered.
  write(path.join(monorepo, 'docker-compose.yml'), 'services:\n  api:\n    image: x\n')
  write(
    path.join(monorepo, 'node_modules', 'dep', 'collections', 'nope.yml'),
    collection('nope', [['x', 'GET']])
  )
  commitAll(monorepo, 'initial')

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const project = (name: string) => page.getByRole('region', { name: `Project ${name}`, exact: true })

/** Open a collection from the sidebar so its steps show in the main pane. */
const openCollection = async (projectName: string, collectionName: string) => {
  await project(projectName).locator('.collection-row', { hasText: collectionName }).click()
}

const addProject = async (folder: string) => {
  await pickFolder(folder)
  await page.getByRole('button', { name: '+ Project' }).click()
}

/** Select a step by name in the step list. */
const openStep = async (name: string) => {
  await page.locator('.step-open', { hasText: name }).first().click()
}

test('adds a repository as a project, and each service of a monorepo as its own', async () => {
  await addProject(singleRepo)
  await expect(project('payments-api')).toBeVisible()

  // The monorepo's root has no collections/ of its own: the app asks rather
  // than quietly adding an empty project.
  let asked = ''
  page.once('dialog', (dialog) => {
    asked = dialog.message()
    void dialog.dismiss()
  })
  await addProject(monorepo)
  await expect.poll(() => asked).toContain('platform has no collections/ folder')
  await expect(project('platform')).toHaveCount(0)

  await addProject(path.join(monorepo, 'services', 'auth'))
  // Picking a collections/ folder itself adds the project holding it.
  await addProject(path.join(monorepo, 'services', 'users', 'collections'))
  await expect(project('auth')).toBeVisible()
  await expect(project('users')).toBeVisible()

  await expect(project('payments-api').locator('.collection-row')).toHaveCount(1)
  await expect(project('auth').locator('.collection-row')).toHaveCount(2)
  await expect(project('users').locator('.collection-row')).toHaveCount(1)
  await expect(page.locator('.sidebar')).not.toContainText('nope')
})

test('a project shows its directories one level deep, and reports anything deeper', async () => {
  await expect(page.locator('.sidebar .step-row')).toHaveCount(0)
  // The constant collections/ segment is never shown.
  await expect(page.locator('.sidebar')).not.toContainText('collections/')
  await expect(project('auth').locator('.group-row .label')).toHaveText(['tokens'])
  await expect(project('auth').locator('.collection-row')).toHaveText(['refresh', 'auth'])
  await expect(project('auth').getByRole('img', { name: 'Project problems' })).toHaveAttribute(
    'title',
    /one level deep, so collections\/tokens\/old\/ is not read/
  )
  await expect(page.locator('.sidebar')).not.toContainText('legacy')
})

test('selecting a collection shows its steps and the first step together', async () => {
  await openCollection('payments-api', 'checkout')

  const rows = page.locator('.step-open')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('create-session')
  await expect(rows.nth(1)).toContainText('capture')
  await expect(rows.first().locator('.method')).toHaveText('POST')
  await expect(page.locator('.collection-header h1')).toHaveText('checkout')
  // The header names the selected step, not the file or its counts.
  const current = page.locator('.collection-step')
  await expect(current.locator('.collection-step-seq')).toHaveText('Step 1 of 2')
  await expect(current.locator('.method')).toHaveText('POST')
  await expect(current.locator('.collection-step-name')).toHaveText('create-session')
  // Position is simply the index: list order is run order, there is no seq.
  await expect(rows.first().locator('.step-seq')).toHaveText('1')

  // No drilling: the editor for the first step is already on screen.
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session')
})

test('shows the branch and reflects a checkout made outside the app', async () => {
  // Two projects in one monorepo share its git state.
  await expect(project('auth').locator('.repo-branch')).toHaveText('main')
  await expect(project('users').locator('.repo-branch')).toHaveText('main')

  const branch = project('payments-api').locator('.repo-branch')
  await expect(branch).toHaveText('main')

  git(singleRepo, 'checkout', '-b', 'feature/pricing')
  await expect(branch).toHaveText('feature/pricing', { timeout: 15_000 })

  git(singleRepo, 'checkout', 'main')
  await expect(branch).toHaveText('main', { timeout: 15_000 })
})

test('a project heading collapses and expands its collections', async () => {
  const auth = project('auth')
  await expect(auth.locator('.collection-row')).toHaveCount(2)

  await auth.locator('.repo-toggle').click()
  await expect(auth.locator('.collection-row')).toHaveCount(0)
  // Collapsing one project leaves the others alone.
  await expect(project('payments-api').locator('.collection-row')).toHaveCount(1)

  await auth.locator('.repo-toggle').click()
  await expect(auth.locator('.collection-row')).toHaveCount(2)
})

test('a project’s filter narrows its collections, and leaves other projects alone', async () => {
  const auth = project('auth')
  const filter = auth.getByLabel('Filter auth')
  await filter.fill('REFR')
  await expect(auth.locator('.collection-row')).toHaveText(['refresh'])
  await expect(auth.locator('.group-row .label')).toHaveText(['tokens'])
  await expect(auth.locator('.filter-count')).toHaveText('1 of 2')
  await expect(project('users').locator('.collection-row')).toHaveCount(1)

  await filter.fill('nothing here')
  await expect(auth.locator('.filter-empty')).toHaveText('Nothing matches “nothing here”.')
  await filter.press('Escape')
  await expect(auth.locator('.collection-row')).toHaveText(['refresh', 'auth'])
  await expect(auth.locator('.filter-count')).toHaveCount(0)

  // A directory collapsed by hand shows what a filter finds in it, and is collapsed again after.
  await auth.locator('.group-row', { hasText: 'tokens' }).click()
  await expect(auth.locator('.collection-row')).toHaveText(['auth'])
  await filter.fill('tokens')
  await expect(auth.locator('.collection-row')).toHaveText(['refresh'])
  await filter.fill('')
  await expect(auth.locator('.collection-row')).toHaveText(['auth'])
  await auth.locator('.group-row', { hasText: 'tokens' }).click()
  await expect(auth.locator('.collection-row')).toHaveText(['refresh', 'auth'])
})

test('selecting another step swaps the editor without leaving the list', async () => {
  await openStep('capture')
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/capture')
  // The list is still on screen, with the new step marked selected.
  await expect(page.locator('.step-list li.selected')).toContainText('capture')
  await expect(page.locator('.collection-step-name')).toHaveText('capture')
  await expect(page.locator('.collection-step-seq')).toHaveText('Step 2 of 2')
  await expect(page.locator('.step-open')).toHaveCount(2)

  await openStep('create-session')
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session')
})

/**
 * A settled status: neither the idle dash nor the transient `running…`.
 *
 * Asserting only "not —" passes the moment the run starts, which leaves the run
 * in flight and races whatever the next test does.
 */
const SETTLED = /^(?!—$|running…$).+/

test('a step can be run on its own, and shows its result in the list', async () => {
  const row = page.locator('.step-list li', { hasText: 'create-session' })
  await expect(row.locator('.step-status')).toHaveText('—')

  await row.getByRole('button', { name: /^Run / }).click()
  // The port is closed, so this reports an error rather than a status code.
  await expect(row.locator('.step-status')).toHaveText(SETTLED, { timeout: 20_000 })
  // Only the step that was run has a result.
  await expect(
    page.locator('.step-list li', { hasText: 'capture' }).locator('.step-status')
  ).toHaveText('—')
})

test('Run all runs every step and reports a summary', async () => {
  await page.getByRole('button', { name: 'Run all' }).click()

  await expect(page.locator('.run-summary')).toBeVisible({ timeout: 30_000 })
  const statuses = page.locator('.step-list .step-status')
  await expect(statuses).toHaveCount(2)
  for (const status of await statuses.all()) {
    await expect(status).toHaveText(SETTLED, { timeout: 20_000 })
  }
})

test('a step changed on disk reloads when it has no unsaved edits', async () => {
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session')
  const file = path.join(singleRepo, 'collections', 'checkout.yml')
  const original = fs.readFileSync(file, 'utf8')

  fs.writeFileSync(
    file,
    collection('checkout', [
      ['changed-on-disk', 'POST'],
      ['capture', 'POST']
    ])
  )
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/changed-on-disk', {
    timeout: 15_000
  })

  fs.writeFileSync(file, original)
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session', {
    timeout: 15_000
  })
})

test('unsaved edits survive a change on disk and raise a conflict', async () => {
  await page.getByLabel('Request URL').fill('http://127.0.0.1:1/my-edit')
  await expect(page.locator('.save-status')).toContainText('1 unsaved change')

  const file = path.join(singleRepo, 'collections', 'checkout.yml')
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}# touched\n`)

  await expect(page.locator('.banner')).toContainText('Changed on disk', { timeout: 15_000 })
  // The edit is still there: nothing was discarded.
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/my-edit')

  await page.locator('.banner').getByRole('button', { name: 'Reload' }).click()
  await expect(page.locator('.banner')).toHaveCount(0)
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session')
})

test('saving an edit writes exactly one file and leaves the rest untouched', async () => {
  await page.getByLabel('Request URL').fill('http://127.0.0.1:1/saved-url')
  await page.keyboard.press('ControlOrMeta+s')

  await expect(page.locator('.save-status')).toHaveText('Saved')
  // Exactly one file modified: saving must not touch anything else.
  await expect
    // Do not trim the whole output: porcelain status is column-significant and
    // the leading space in " M path" is part of the status code.
    .poll(() => git(singleRepo, 'status', '--porcelain').split('\n').filter(Boolean), {
      timeout: 15_000
    })
    .toEqual([' M collections/checkout.yml'])

  const onDisk = fs.readFileSync(path.join(singleRepo, 'collections', 'checkout.yml'), 'utf8')
  expect(onDisk).toContain('POST: "http://127.0.0.1:1/saved-url"')
  // The sibling step in the same file is untouched.
  expect(onDisk).toContain('http://127.0.0.1:1/capture')

  git(singleRepo, 'checkout', '--', 'collections/checkout.yml')
  // Put back on disk, and so back in the editor: no edit is pending.
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/create-session', {
    timeout: 15_000
  })
})

test('an unsaved edit survives switching steps and coming back', async () => {
  await page.getByLabel('Request URL').fill('http://127.0.0.1:1/parked')
  await openStep('capture')

  // The list flags the step as having unsaved work.
  await expect(
    page.locator('.step-list li', { hasText: 'create-session' }).locator('.step-dirty')
  ).toBeVisible()

  await openStep('create-session')
  await expect(page.getByLabel('Request URL')).toHaveValue('http://127.0.0.1:1/parked')

  // Put it back so the following tests start from a clean file.
  await page.getByLabel('Request URL').fill('http://127.0.0.1:1/create-session')
})

test('workspaces each hold their own projects', async () => {
  const switcher = page.getByLabel('Workspace', { exact: true })
  await expect(switcher.locator('option:checked')).toHaveText('My workspace')

  await page.getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'New workspace' }).click()
  await page.getByLabel('New workspace name').fill('Payments team')
  await page.keyboard.press('Enter')
  await expect(switcher.locator('option:checked')).toHaveText('Payments team')
  await expect(page.locator('.sidebar')).toContainText('No projects in this workspace yet')

  await switcher.selectOption({ label: 'My workspace' })
  await expect(project('payments-api')).toBeVisible()
  await expect(project('auth')).toBeVisible()
})

test('a workspace survives a restart', async () => {
  // The registry must be on disk before a restart can prove anything. It is
  // written asynchronously as workspaces are added, so give it a moment.
  await expect
    .poll(() => fs.existsSync(path.join(userData, 'workspaces.json')), { timeout: 10_000 })
    .toBe(true)

  await app.close()
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, DEFAULT_WINDOW)
  await page.waitForSelector('.sidebar')

  await expect(project('payments-api')).toBeVisible({ timeout: 15_000 })
  await expect(project('auth')).toBeVisible()
  await expect(project('payments-api').locator('.collection-row')).toHaveCount(1)
  const switcher = page.getByLabel('Workspace', { exact: true })
  await expect(switcher.locator('option')).toHaveText(['My workspace', 'Payments team'])
  await expect(switcher.locator('option:checked')).toHaveText('My workspace')
})
