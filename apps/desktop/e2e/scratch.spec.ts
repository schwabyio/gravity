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
 * Scratch pads: projects the app makes in its own data folder for ad hoc
 * requests, with no git, as many as wanted in any workspace — and, for any
 * project, renaming, copying, moving and deleting collections from the sidebar.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let userData: string
let shop: string
let shared: string
let origin: string
let server: http.Server
let app: ElectronApplication
let page: Page

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}
const exists = (file: string) => fs.existsSync(file)
const read = (file: string) => fs.readFileSync(file, 'utf8')
/** A file's text, or null until it is written: for polling. */
const readSoon = (file: string) => (fs.existsSync(file) ? read(file) : null)
const pad = (...parts: string[]) => path.join(userData, 'Scratch pads', 'Scratch pad', ...parts)

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-scratch-')))
  userData = path.join(tmp, 'ud')
  shop = path.join(tmp, 'shop-api')
  write(path.join(shop, 'collections', 'smoke', 'health.yml'), 'id: health\nsteps: []\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })
  shared = path.join(tmp, 'shared')
  write(path.join(shared, 'project.yml'), 'name: Shared\n')
  write(path.join(shared, 'environments', 'local.yml'), `vars:\n  baseUrl: ${origin}\n`)

  await launch()
  await addProject(app, page, shop)
})

/** Start the app on this spec's data folder, with a Trash that deletes and remembers. */
async function launch() {
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1400, height: 860 })
  await page.waitForSelector('.sidebar')
  await app.evaluate(({ shell }) => {
    const fs = process.getBuiltinModule('node:fs')
    const trashed: string[] = []
    ;(globalThis as { trashed?: string[] }).trashed = trashed
    shell.trashItem = async (file: string) => {
      trashed.push(file)
      fs.rmSync(file, { recursive: true, force: true })
    }
  })
}

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const project = (name: string) => page.getByRole('region', { name: `Project ${name}`, exact: true })
const trashed = () => app.evaluate(() => (globalThis as { trashed?: string[] }).trashed ?? [])
const rowMenu = async (where: string, collection: string, item: string) => {
  const row = project(where).locator('.collection-item', { hasText: collection })
  await row.hover()
  await row.getByRole('button', { name: `Collection actions for ${collection}` }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}
const header = () => page.locator('.collection-header h1')

test('+ Scratch pad makes a project in the app’s data folder, marked, with no git', async () => {
  await page.getByRole('button', { name: '+ Scratch pad' }).click()
  const name = page.getByLabel('New scratch pad name')
  await expect(name).toHaveValue('Scratch pad')
  await name.press('Enter')

  const scratch = project('Scratch pad')
  await expect(scratch.locator('.scratch-tag')).toHaveText('scratch pad')
  await expect(scratch.locator('.repo-branch')).toHaveCount(0)
  // The project in a repository shows its branch; the scratch pad has none to show.
  await expect(project('shop-api').locator('.repo-branch')).toHaveText('main')
  expect(fs.statSync(pad('collections')).isDirectory()).toBe(true)
  // Empty, it offers what to make first: a collection, or a folder to hold them.
  await expect(scratch.locator('.project-empty')).toHaveText(
    'No collections yet. New collection · New folder'
  )
})

test('an empty project’s New folder shortcut makes one', async () => {
  // In a project of its own, so the scratch pad stays empty for the tests after.
  const empty = path.join(tmp, 'empty-api')
  fs.mkdirSync(path.join(empty, 'collections'), { recursive: true })
  await addProject(app, page, empty)
  await project('empty-api').getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('New folder name').fill('auth')
  await page.getByLabel('New folder name').press('Enter')

  await expect(project('empty-api').locator('.group-row .label')).toHaveText(['auth'])
  expect(fs.statSync(path.join(empty, 'collections', 'auth')).isDirectory()).toBe(true)
  await page.getByRole('button', { name: 'Remove empty-api' }).click()
})

test('another scratch pad is offered the next free name, and a used one is refused', async () => {
  await page.getByRole('button', { name: '+ Scratch pad' }).click()
  const name = page.getByLabel('New scratch pad name')
  await expect(name).toHaveValue('Scratch pad 2')
  await name.fill('scratch PAD')
  await name.press('Enter')
  await expect(page.getByRole('alert')).toContainText(
    'There is already a scratch pad called "Scratch pad"'
  )
  await name.fill('a:b')
  await name.press('Enter')
  await expect(page.getByRole('alert')).toContainText('cannot contain')
  await name.press('Escape')
  await expect(name).toHaveCount(0)
})

test('a scratch collection runs with the environments of the global project it uses', async () => {
  await project('Scratch pad').getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('New collection id').fill('ping')
  await page.keyboard.press('Enter')
  await expect(header()).toHaveText('ping')
  expect(read(pad('collections', 'ping.yml'))).toBe('id: ping\nsteps: []\n')

  // Picked, not typed: from the app's data folder, the path is a run of ../
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, shared)
  await page.getByRole('button', { name: 'Project actions for Scratch pad' }).click()
  await page.getByRole('menuitem', { name: 'Project settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Project settings' })
  await drawer.getByRole('button', { name: 'Choose…' }).click()
  await expect(drawer.getByLabel('Global project')).toHaveValue('../../../shared')
  await expect
    .poll(() => readSoon(pad('project.yml')), { timeout: 5_000 })
    .toBe('uses: ../../../shared\n')
  await expect(drawer).toContainText('Now: Shared')
  // No git, so nothing to say about line endings.
  await expect(drawer.getByRole('heading', { name: 'Line endings' })).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: '+ Add step' }).click()
  await page.getByLabel('Request URL').fill('{{baseUrl}}/ping')
  await page.getByLabel('Environment', { exact: true }).selectOption('local')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toContainText('200 OK', { timeout: 15_000 })
  await expect.poll(() => read(pad('collections', 'ping.yml'))).toContain('{{baseUrl}}/ping')
})

test('a collection is renamed from its row, and the open one follows', async () => {
  await rowMenu('Scratch pad', 'ping', 'Rename')
  const id = page.getByLabel('New id for ping')
  await expect(id).toHaveValue('ping')
  await id.fill('ping-check')
  await id.press('Enter')

  await expect(header()).toHaveText('ping-check')
  expect(exists(pad('collections', 'ping.yml'))).toBe(false)
  expect(read(pad('collections', 'ping-check.yml'))).toContain('id: ping-check\n')
  await expect(project('Scratch pad').locator('.collection-row')).toHaveText(['ping-check'])
})

test('a scratch collection is copied into a project, once', async () => {
  await rowMenu('Scratch pad', 'ping-check', 'Copy to project…')
  const form = page.getByRole('form', { name: 'Copy ping-check to a project' })
  await form.getByLabel('Project').selectOption({ label: 'shop-api' })
  await form.getByLabel('Folder').selectOption('smoke')
  await form.getByRole('button', { name: 'Copy' }).click()

  await expect(form).toHaveCount(0)
  await expect(page.locator('.sidebar-status')).toHaveText('Copied ping-check to shop-api.')
  expect(read(path.join(shop, 'collections', 'smoke', 'ping-check.yml'))).toContain(
    '{{baseUrl}}/ping'
  )
  expect(exists(pad('collections', 'ping-check.yml'))).toBe(true)
  await expect(project('shop-api').locator('.collection-row')).toHaveText(['health', 'ping-check'])

  // Its id is taken there now.
  await rowMenu('Scratch pad', 'ping-check', 'Copy to project…')
  await form.getByRole('button', { name: 'Copy' }).click()
  await expect(form.getByRole('alert')).toHaveText(
    'collections/smoke/ping-check.yml already has the id ping-check'
  )
  await form.getByRole('button', { name: 'Cancel' }).click()
})

test('a collection is moved into a project with its data file', async () => {
  // Written on disk, as anyone may: the scratch pad is watched like any project.
  write(pad('collections', 'users.yml'), 'id: users\nsteps: []\n')
  write(pad('collections', 'users.csv'), 'user\nada\n')
  await expect(project('Scratch pad').locator('.collection-row')).toHaveText([
    'ping-check',
    'users×1'
  ])

  await rowMenu('Scratch pad', 'users', 'Move to project…')
  const form = page.getByRole('form', { name: 'Move users to a project' })
  await expect(form).toContainText('Its data file goes with it.')
  await form.getByRole('button', { name: 'Move' }).click()

  await expect(project('Scratch pad').locator('.collection-row')).toHaveText(['ping-check'])
  expect(read(path.join(shop, 'collections', 'users.csv'))).toBe('user\nada\n')
  expect(exists(path.join(shop, 'collections', 'users.yml'))).toBe(true)
  expect(exists(pad('collections', 'users.yml'))).toBe(false)
  expect(exists(pad('collections', 'users.csv'))).toBe(false)
})

test('a collection of any project is deleted to the Trash, and an open one closes', async () => {
  await project('shop-api').locator('.collection-row', { hasText: 'ping-check' }).click()
  await expect(header()).toHaveText('ping-check')
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('Delete the collection “ping-check”? It goes to the Trash.')
    void dialog.accept()
  })
  await rowMenu('shop-api', 'ping-check', 'Delete')

  await expect(project('shop-api').locator('.collection-row')).toHaveText(['health', 'users×1'])
  expect(await trashed()).toContain(path.join(shop, 'collections', 'smoke', 'ping-check.yml'))
  await expect(page.locator('.placeholder')).toHaveText('Choose a collection to see its steps.')
})

test('a folder is renamed with what is in it, and deleted to the Trash', async () => {
  const projectMenu = async (item: string) => {
    await page.getByRole('button', { name: 'Project actions for Scratch pad' }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  const folderMenu = async (name: string, item: string) => {
    const row = project('Scratch pad').locator('.folder-item', { hasText: name })
    await row.hover()
    await row.getByRole('button', { name: `Folder actions for ${name}` }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }
  await projectMenu('New folder')
  await page.getByLabel('New folder name').fill('auth')
  await page.getByLabel('New folder name').press('Enter')
  // Empty, the folder offers a collection of its own, in it from the start.
  const folder = project('Scratch pad')
  await expect(folder.locator('.directory-empty')).toHaveText('No collections yet. New collection')
  await folder.getByRole('button', { name: 'New collection in auth' }).click()
  await expect(page.getByLabel('Folder', { exact: true })).toHaveValue('auth')
  await page.getByLabel('New collection id').fill('token')
  await page.keyboard.press('Enter')
  await expect(header()).toHaveText('token')

  // Its menu makes one there too.
  await folderMenu('auth', 'New collection')
  await expect(page.getByLabel('Folder', { exact: true })).toHaveValue('auth')
  await page.getByLabel('New collection id').fill('refresh')
  await page.keyboard.press('Enter')
  await expect(header()).toHaveText('refresh')
  expect(read(pad('collections', 'auth', 'refresh.yml'))).toBe('id: refresh\nsteps: []\n')
  await project('Scratch pad').locator('.collection-row', { hasText: 'token' }).click()
  await expect(header()).toHaveText('token')

  await folderMenu('auth', 'Rename')
  const name = page.getByLabel('New name for the folder auth')
  await expect(name).toHaveValue('auth')
  await name.fill('login')
  await name.press('Enter')
  await expect(project('Scratch pad').locator('.group-row .label')).toHaveText(['login'])
  expect(exists(pad('collections', 'auth'))).toBe(false)
  expect(read(pad('collections', 'login', 'token.yml'))).toBe('id: token\nsteps: []\n')
  // The open collection went with it: what it writes now lands in the renamed folder.
  await expect(header()).toHaveText('token')
  await page.getByRole('button', { name: '+ Add step' }).click()
  await expect
    .poll(() => readSoon(pad('collections', 'login', 'token.yml')))
    .toContain('- name: New step')

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      'Delete the folder “login” and its 2 collections? Everything in it goes to the Trash.'
    )
    void dialog.accept()
  })
  await folderMenu('login', 'Delete')
  await expect(project('Scratch pad').locator('.group-row')).toHaveCount(0)
  expect(await trashed()).toContain(pad('collections', 'login'))
  expect(exists(pad('collections', 'login'))).toBe(false)
  await expect(page.locator('.placeholder')).toHaveText('Choose a collection to see its steps.')
})

test('a scratch pad is renamed from its menu, its folder too, and an open collection follows', async () => {
  const rename = async (from: string, to: string) => {
    await page.getByRole('button', { name: `Project actions for ${from}` }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const name = page.getByLabel(`New name for ${from}`)
    await expect(name).toHaveValue(from)
    await name.fill(to)
    await name.press('Enter')
  }
  await project('Scratch pad').locator('.collection-row', { hasText: 'ping-check' }).click()
  await expect(header()).toHaveText('ping-check')

  await rename('Scratch pad', 'Spike')
  const spike = path.join(userData, 'Scratch pads', 'Spike')
  await expect(project('Spike').locator('.scratch-tag')).toHaveText('scratch pad')
  expect(exists(pad())).toBe(false)
  expect(exists(path.join(spike, 'collections', 'ping-check.yml'))).toBe(true)
  // Its uses: still reaches the global project, from a folder beside the old one.
  await expect(project('Spike').locator('.uses-badge')).toHaveText('uses Shared')
  // The open collection followed: what it writes lands in the renamed folder.
  await expect(header()).toHaveText('ping-check')
  await page.getByRole('button', { name: '+ Add step' }).click()
  await expect
    .poll(() => readSoon(path.join(spike, 'collections', 'ping-check.yml')))
    .toContain('- name: New step')

  // A name Windows refuses is refused here too.
  await page.getByRole('button', { name: 'Project actions for Spike' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('New name for Spike').fill('a:b')
  await page.getByLabel('New name for Spike').press('Enter')
  await expect(page.getByRole('alert')).toContainText('cannot contain')
  await page.getByLabel('New name for Spike').press('Escape')

  await rename('Spike', 'Scratch pad')
  await expect(project('Scratch pad')).toBeVisible()
  expect(exists(pad('collections', 'ping-check.yml'))).toBe(true)
})

test('a collection’s menu adds a request, and a new request set it uses', async () => {
  const steps = () =>
    (read(pad('collections', 'ping-check.yml')).match(/- name: New step/g) ?? []).length
  const before = steps()
  // From another collection: the menu opens the one it is on.
  await project('shop-api').locator('.collection-row', { hasText: 'health' }).click()
  await expect(header()).toHaveText('health')
  await rowMenu('Scratch pad', 'ping-check', 'New request')
  await expect(header()).toHaveText('ping-check')
  await expect.poll(steps).toBe(before + 1)
  // At the end, and selected.
  await expect(page.locator('.step-list > li').last()).toHaveClass(/selected/)
  await expect(page.getByLabel('Request URL')).toHaveValue('')

  await rowMenu('Scratch pad', 'ping-check', 'New request set')
  const id = page.getByLabel('New request set id, used in ping-check')
  await id.fill('login-flow')
  await id.press('Enter')
  await expect
    .poll(() => readSoon(pad('requests', 'login-flow.yml')))
    .toBe('id: login-flow\nparams: {}\nsteps: []\n')
  await expect.poll(() => read(pad('collections', 'ping-check.yml'))).toContain('use: login-flow')
  await expect(
    page.getByRole('group', { name: 'Request sets of Scratch pad' }).locator('.set-row')
  ).toHaveText(['login-flow'])
})

test('a collection moves to another folder, from its menu or by dragging', async () => {
  const where = () =>
    ['ping-check.yml', 'smoke/ping-check.yml'].filter((file) =>
      exists(pad('collections', ...file.split('/')))
    )
  await page.getByRole('button', { name: 'Project actions for Scratch pad' }).click()
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await page.getByLabel('New folder name').fill('smoke')
  await page.getByLabel('New folder name').press('Enter')
  await project('Scratch pad').locator('.collection-row', { hasText: 'ping-check' }).click()
  await expect(header()).toHaveText('ping-check')

  // From the menu: every folder it is not in, the root among them.
  await rowMenu('Scratch pad', 'ping-check', 'Move to folder…')
  const form = page.getByRole('form', { name: 'Move ping-check to a folder' })
  await expect(form.getByLabel('Folder').locator('option')).toHaveText(['smoke/'])
  await form.getByRole('button', { name: 'Move' }).click()
  await expect.poll(where).toEqual(['smoke/ping-check.yml'])
  // The open collection went with it: what it writes lands in its new folder.
  await expect(header()).toHaveText('ping-check')
  const steps = () =>
    (readSoon(pad('collections', 'smoke', 'ping-check.yml')) ?? '').split('- name:').length
  const before = steps()
  await page.getByRole('button', { name: '+ Add step' }).click()
  await expect.poll(steps).toBe(before + 1)

  // Dragged onto the project's heading: back to the root of collections/.
  const row = () => project('Scratch pad').locator('.collection-item', { hasText: 'ping-check' })
  await row().dragTo(project('Scratch pad').locator('.project-drop'))
  await expect.poll(where).toEqual(['ping-check.yml'])

  // Dragged onto a folder's row: into that folder.
  await row().dragTo(project('Scratch pad').locator('.folder-item', { hasText: 'smoke' }))
  await expect.poll(where).toEqual(['smoke/ping-check.yml'])
  await expect(project('Scratch pad').locator('.group-row .label')).toHaveText(['smoke'])
})

test('opening one ⋯ menu closes any other open one', async () => {
  const menu = () => page.getByRole('menu')
  const open = async (where: ReturnType<typeof project> | Page, button: string) => {
    const target = where.getByRole('button', { name: button })
    await target.hover()
    await target.click()
  }
  const row = project('Scratch pad').locator('.collection-item', { hasText: 'ping-check' })
  await row.hover()
  await open(row, 'Collection actions for ping-check')
  await expect(menu()).toHaveCount(1)
  await expect(menu()).toContainText('New request set')

  // Another of the same list: its row's menu replaces it.
  const folder = project('Scratch pad').locator('.folder-item', { hasText: 'smoke' })
  await folder.hover()
  await open(folder, 'Folder actions for smoke')
  await expect(menu()).toHaveCount(1)
  await expect(menu()).not.toContainText('New request')

  // Menus of other components: the project's, another project's, a step's, the workspace's
  // (last: open, it covers the project headings below it).
  const others: Array<[string, string]> = [
    ['Project actions for Scratch pad', 'New folder'],
    ['Project actions for shop-api', 'Changes and commit'],
    ['More actions for New step', 'Duplicate'],
    ['Workspace actions', 'New workspace']
  ]
  for (const [button, says] of others) {
    await page.getByRole('button', { name: button }).first().click()
    await expect(menu()).toHaveCount(1)
    await expect(menu()).toContainText(says)
  }

  // And a click anywhere else closes the last.
  await header().click()
  await expect(menu()).toHaveCount(0)
})

test('one button collapses every project, and then expands them again', async () => {
  const rows = () => page.locator('.sidebar .collection-row')
  await expect(rows()).not.toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse all projects' }).click()
  await expect(rows()).toHaveCount(0)
  for (const name of ['shop-api', 'Scratch pad']) {
    await expect(project(name).locator('.repo-toggle')).toHaveAttribute('aria-expanded', 'false')
  }

  // All collapsed, it expands them all.
  await page.getByRole('button', { name: 'Expand all projects' }).click()
  await expect(project('Scratch pad').locator('.collection-row')).toHaveText(['ping-check'])
  await expect(project('shop-api').locator('.repo-toggle')).toHaveAttribute('aria-expanded', 'true')

  // One opened by hand after collapsing all leaves the button collapsing, not expanding.
  await page.getByRole('button', { name: 'Collapse all projects' }).click()
  await project('shop-api').locator('.repo-toggle').click()
  await page.getByRole('button', { name: 'Collapse all projects' }).click()
  await expect(rows()).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all projects' }).click()
})

test('a scratch pad is still one after a restart', async () => {
  await app.close()
  await launch()
  const scratch = project('Scratch pad')
  await expect(scratch.locator('.scratch-tag')).toHaveText('scratch pad')
  await expect(scratch.locator('.collection-row')).toHaveText(['ping-check'])
})

test('deleting a scratch pad puts its folder in the Trash', async () => {
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      'Delete the scratch pad “Scratch pad” and its 1 collection? Its folder goes to the Trash.'
    )
    void dialog.accept()
  })
  await page.getByRole('button', { name: 'Delete Scratch pad' }).click()

  await expect(project('Scratch pad')).toHaveCount(0)
  expect(await trashed()).toEqual([pad()])
  expect(exists(pad())).toBe(false)
  // A project in a repository is only ever removed: its files stay.
  await expect(page.getByRole('button', { name: 'Remove shop-api' })).toBeVisible()
})

test('deleting a workspace puts its scratch pads in the Trash', async () => {
  await page.getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'New workspace' }).click()
  await page.getByLabel('New workspace name').fill('Spikes')
  await page.getByLabel('New workspace name').press('Enter')
  await page.getByRole('button', { name: '+ Scratch pad' }).click()
  await page.getByLabel('New scratch pad name').press('Enter')
  await expect(project('Scratch pad').locator('.scratch-tag')).toHaveText('scratch pad')

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      'Delete the workspace “Spikes” and its 1 project? Their folders go to the Trash.'
    )
    void dialog.accept()
  })
  await page.getByRole('button', { name: 'Workspace actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete workspace' }).click()

  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).not.toContainText(
    'Spikes'
  )
  await expect.poll(trashed).toEqual([pad(), pad()])
  expect(exists(pad())).toBe(false)
})
