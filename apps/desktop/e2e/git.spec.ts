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

/**
 * Committing, pushing, pulling and branching from the app, against real
 * repositories: a bare remote, the monorepo the app works in, and another clone
 * standing in for a colleague. The app runs its bundled git.
 *
 * git's global config is a file of the test's own, so the machine's identity,
 * signing and line-ending settings never reach it — and the app's saving of a
 * name and email can be seen.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let userData: string
let globalConfig: string
let remote: string
let work: string
let other: string
let project: string
let app: ElectronApplication
let page: Page

/** Who git says you are, when these are set: here, never. */
const IDENTITY = [
  'EMAIL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL'
]

/** The environment git runs in, for the test and the app alike. */
const gitEnv = (): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !IDENTITY.includes(entry[0])
    )
  ),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1'
})

/** git as a colleague at a terminal: their own name, never the app's. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Colleague', '-c', 'user.email=colleague@example.test', ...args],
    { cwd, stdio: 'pipe', env: gitEnv() }
  ).toString()

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

const collection = (id: string, step: string) =>
  `id: ${id}\nsteps:\n  - name: ${step}\n    GET: "http://127.0.0.1:1/${step}"\n`

const drawer = () => page.getByRole('dialog', { name: 'Changes' })
const include = (file: string) => drawer().getByRole('checkbox', { name: `Include ${file}` })
const status = () => drawer().getByRole('status')
const failure = () => drawer().locator('.git-failure')
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim()

async function launch() {
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`], env: gitEnv() })
  page = await app.firstWindow()
  await page.waitForSelector('.sidebar')
  // A discard goes to the Trash; here, the "Trash" deletes and remembers.
  await app.evaluate(({ shell }) => {
    const fs = process.getBuiltinModule('node:fs')
    const trashed: string[] = []
    ;(globalThis as { trashed?: string[] }).trashed = trashed
    shell.trashItem = async (file: string) => {
      trashed.push(file)
      fs.rmSync(file, { force: true })
    }
  })
}

async function openChanges() {
  if (await drawer().isVisible()) return
  await page.getByRole('button', { name: 'Project actions for api' }).click()
  await page.getByRole('menuitem', { name: 'Changes and commit' }).click()
  await expect(drawer()).toBeVisible()
}

async function closeChanges() {
  if (await drawer().isVisible()) await drawer().getByRole('button', { name: 'Close' }).click()
}

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-git-')))
  userData = path.join(tmp, 'userData')
  globalConfig = path.join(tmp, 'gitconfig')
  // No name or email: the app has to ask for them. No CRLF conversion either.
  write(
    globalConfig,
    '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n'
  )

  remote = path.join(tmp, 'remote.git')
  fs.mkdirSync(remote)
  git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')

  work = path.join(tmp, 'platform')
  project = path.join(work, 'services', 'api')
  write(path.join(work, 'README.md'), '# Platform\n')
  write(path.join(project, 'collections', 'smoke.yml'), collection('smoke', 'ping'))
  write(path.join(project, 'src', 'main.ts'), 'export const main = 1\n')
  git(tmp, 'init', '--quiet', work)
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'Start')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '--quiet', '-u', 'origin', 'main')
  other = path.join(tmp, 'other')
  git(tmp, 'clone', '--quiet', remote, other)

  await launch()
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, project)
  await page.getByRole('button', { name: '+ Project' }).click()
  await expect(page.getByRole('region', { name: 'Project api', exact: true })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('lists every change in the repository, checking only gta’s own files', async () => {
  write(path.join(project, 'collections', 'smoke.yml'), collection('smoke', 'pong'))
  write(path.join(project, 'collections', 'new.yml'), collection('new', 'hello'))
  write(path.join(project, 'src', 'main.ts'), 'export const main = 2\n')
  write(path.join(work, 'README.md'), '# Platform, edited\n')
  // Staged at a terminal: the app's commit must leave it staged.
  write(path.join(project, 'src', 'staged.ts'), 'export {}\n')
  git(work, 'add', 'services/api/src/staged.ts')

  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(drawer()).toBeVisible()
  await expect(include('services/api/collections/smoke.yml')).toBeChecked()
  await expect(include('services/api/collections/new.yml')).toBeChecked()
  await expect(include('services/api/src/main.ts')).not.toBeChecked()
  await expect(include('services/api/src/staged.ts')).not.toBeChecked()
  await expect(include('README.md')).not.toBeChecked()
  await expect(drawer().getByRole('region', { name: 'Elsewhere in platform' })).toContainText(
    'README.md'
  )
})

test('shows what changed in a file, and all of a new one', async () => {
  await drawer()
    .getByRole('button', { name: 'services/api/collections/smoke.yml, modified' })
    .click()
  const smoke = drawer().getByRole('region', {
    name: 'Changes to services/api/collections/smoke.yml'
  })
  await expect(smoke.locator('.diff-line.del')).toContainText(['- name: ping', 'ping"'])
  await expect(smoke.locator('.diff-line.add')).toContainText(['- name: pong', 'pong"'])

  await drawer()
    .getByRole('button', { name: 'services/api/collections/new.yml, new, not in git yet' })
    .click()
  const added = drawer().getByRole('region', {
    name: 'Changes to services/api/collections/new.yml'
  })
  await expect(added.locator('.diff-line.add')).toHaveCount(4)
})

test('asks for a name and email, saves them globally, and commits only what is checked', async () => {
  await drawer().getByLabel('Your name').fill('Ann Tester')
  await drawer().getByLabel('Your email').fill('ann@example.test')
  await drawer().getByLabel('Commit message').fill('Point smoke at pong')
  await drawer().getByRole('button', { name: 'Commit 2 files to main' }).click()

  await expect(status()).toContainText(/Committed [0-9a-f]{7} to main\./)
  expect(fs.readFileSync(globalConfig, 'utf8')).toContain('ann@example.test')
  expect(git(work, 'show', '--name-status', '--format=%an %s', 'HEAD')).toBe(
    'Ann Tester Point smoke at pong\n\nA\tservices/api/collections/new.yml\nM\tservices/api/collections/smoke.yml\n'
  )
  expect(git(work, 'diff', '--cached', '--name-only')).toBe('services/api/src/staged.ts\n')
  // The identity is set now: no fields next time.
  await expect(drawer().getByLabel('Your name')).toHaveCount(0)
})

test('marks a commit not pushed yet, and Push sends it', async () => {
  await drawer().getByRole('button', { name: 'History' }).click()
  const first = drawer().locator('.history-row').first()
  await expect(first).toContainText('Point smoke at pong')
  await expect(first.getByRole('img', { name: 'Not pushed yet' })).toBeVisible()

  await drawer().getByRole('button', { name: 'Push ↑1' }).click()
  await expect(status()).toHaveText('Pushed main to origin/main.')
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(head(work))
  await expect(first.getByRole('img', { name: 'Not pushed yet' })).toHaveCount(0)
  await drawer()
    .getByRole('button', { name: /^Changes/ })
    .click()
})

test('discards a change, putting the old version aside in the Trash', async () => {
  page.once('dialog', (dialog) => void dialog.accept())
  await drawer().getByRole('button', { name: 'Discard changes to README.md' }).click()
  await expect(status()).toHaveText('Discarded README.md.')
  expect(fs.readFileSync(path.join(work, 'README.md'), 'utf8')).toBe('# Platform\n')
  const trashed = await app.evaluate(() => (globalThis as { trashed?: string[] }).trashed)
  // The app names a file by its real path: on Windows, `runneradmin` where
  // os.tmpdir() gave the 8.3 name RUNNER~1.
  expect(trashed).toEqual([path.join(fs.realpathSync.native(work), 'README.md')])
  await expect(include('README.md')).toHaveCount(0)

  // Tidy up what the rest of the tests do not need.
  git(work, 'reset', '--quiet', 'services/api/src/staged.ts')
  fs.rmSync(path.join(project, 'src', 'staged.ts'))
  git(work, 'checkout', '--', 'services/api/src/main.ts')
})

test('creates a branch, publishes it, and switches back', async () => {
  await drawer().getByRole('button', { name: '+ Branch' }).click()
  await drawer().getByLabel('New branch name').fill('feature/x')
  await drawer().getByRole('button', { name: 'Create' }).click()
  await expect(status()).toHaveText('Created feature/x, and switched to it.')
  await expect(page.locator('.repo-branch')).toHaveText('feature/x')

  await drawer().getByRole('button', { name: 'Publish' }).click()
  await expect(status()).toHaveText('Published feature/x to origin/feature/x.')
  expect(git(remote, 'rev-parse', 'feature/x').trim()).toBe(head(work))

  await drawer().getByLabel('Branch').selectOption('local:main')
  await expect(status()).toHaveText('Switched to main.')
  await expect(page.locator('.repo-branch')).toHaveText('main')
})

test('pulls a colleague’s commit', async () => {
  git(other, 'pull', '--quiet')
  write(path.join(other, 'services', 'api', 'collections', 'theirs.yml'), collection('theirs', 'a'))
  git(other, 'add', '-A')
  git(other, 'commit', '--quiet', '-m', 'Theirs')
  git(other, 'push', '--quiet')

  await drawer().getByRole('button', { name: 'Fetch' }).click()
  await drawer().getByRole('button', { name: 'Pull ↓1' }).click()
  await expect(status()).toHaveText('Pulled 1 commit.')
  expect(fs.existsSync(path.join(project, 'collections', 'theirs.yml'))).toBe(true)
})

test('replays your commits on top of theirs when both moved on', async () => {
  write(path.join(other, 'README.md'), '# Platform, theirs\n')
  git(other, 'commit', '--quiet', '-am', 'Their readme')
  git(other, 'push', '--quiet')
  write(path.join(project, 'collections', 'mine.yml'), collection('mine', 'b'))
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'Mine')

  await drawer().getByRole('button', { name: 'Fetch' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await drawer().getByRole('button', { name: 'Pull ↓1' }).click()
  await expect(status()).toHaveText(
    'Replayed your 1 commit on top of 1 new commit from origin/main.'
  )
  expect(git(work, 'log', '--format=%s', '-3')).toBe('Mine\nTheir readme\nTheirs\n')
  await drawer().getByRole('button', { name: 'Push ↑1' }).click()
  await expect(status()).toHaveText('Pushed main to origin/main.')
})

test('a push the remote refuses says to pull first', async () => {
  git(other, 'pull', '--quiet')
  write(
    path.join(other, 'services', 'api', 'collections', 'smoke.yml'),
    collection('smoke', 'theirs')
  )
  git(other, 'commit', '--quiet', '-am', 'Their smoke')
  git(other, 'push', '--quiet')
  write(path.join(project, 'collections', 'smoke.yml'), collection('smoke', 'mine'))
  git(work, 'commit', '--quiet', '-am', 'My smoke')

  // Not fetched yet: the app does not know the remote moved on until it tries.
  await drawer().getByRole('button', { name: 'Push ↑1' }).click()
  await expect(failure()).toContainText('refused the push')
  await expect(failure()).toContainText('Pull, then push again')
})

test('a pull whose commits conflict changes nothing', async () => {
  const before = head(work)
  await drawer().getByRole('button', { name: 'Fetch' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await drawer().getByRole('button', { name: 'Pull ↓1' }).click()
  await expect(failure()).toContainText(
    'Your commits conflict with origin/main in services/api/collections/smoke.yml. Nothing was changed.'
  )
  await expect(failure()).toContainText('git pull --rebase')
  expect(head(work)).toBe(before)
  expect(fs.existsSync(path.join(work, '.git', 'rebase-merge'))).toBe(false)
  expect(git(work, 'status', '--porcelain')).toBe('')

  git(work, 'reset', '--quiet', '--hard', 'origin/main')
})

test('the line-endings notice can be put off, and stays put off after a restart', async () => {
  const notice = drawer().getByRole('note').filter({ hasText: 'line endings' })
  await expect(notice).toContainText('api')
  await notice.getByRole('button', { name: 'Not now' }).click()
  await expect(notice).toHaveCount(0)

  await app.close()
  await launch()
  await openChanges()
  await expect(drawer().getByRole('note').filter({ hasText: 'line endings' })).toHaveCount(0)
  await closeChanges()
})

test('Project settings adds .gitattributes and converts files stored with CRLF', async () => {
  write(path.join(project, 'collections', 'crlf.yml'), 'id: crlf\r\nsteps: []\r\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'A CRLF file')

  await page.getByRole('button', { name: 'Project actions for api' }).click()
  await page.getByRole('menuitem', { name: 'Project settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Project settings' })
  const section = settings.getByRole('region', { name: 'Line endings' })
  await expect(section).toContainText('may check this project’s files out with CRLF')
  await expect(section).toContainText('1 file is stored with CRLF line endings.')

  await section.getByRole('button', { name: 'Add .gitattributes' }).click()
  await expect(section).toContainText('git stores this project’s files with LF line endings')
  expect(fs.readFileSync(path.join(project, '.gitattributes'), 'utf8')).toContain(
    '/collections/** text=auto eol=lf'
  )
  await section.getByRole('button', { name: 'Convert to LF' }).click()
  await expect(section).toContainText('Converted 1 file to LF')
  expect(fs.readFileSync(path.join(project, 'collections', 'crlf.yml'), 'utf8')).toBe(
    'id: crlf\nsteps: []\n'
  )

  await section.getByRole('button', { name: 'Open Changes' }).click()
  await expect(include('services/api/.gitattributes')).toBeChecked()
  await expect(include('services/api/collections/crlf.yml')).toBeChecked()
  await drawer().getByLabel('Commit message').fill('Keep gta files LF')
  await drawer().getByRole('button', { name: 'Commit 2 files to main' }).click()
  await expect(status()).toContainText('Committed')
  expect(git(work, 'ls-files', '--eol', 'services/api/collections/crlf.yml')).toMatch(/^i\/lf/)
})

test('clones a repository into a chosen folder, as a new project', async () => {
  await closeChanges()
  const parent = path.join(tmp, 'clones')
  fs.mkdirSync(parent)
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, parent)
  await page.getByRole('button', { name: '+ Clone' }).click()
  await page.getByLabel('Repository URL').fill(remote)
  await page.getByRole('button', { name: 'Clone…' }).click()

  await expect(page.getByRole('region', { name: 'Project remote', exact: true })).toBeVisible({
    timeout: 15_000
  })
  expect(fs.existsSync(path.join(parent, 'remote', 'services', 'api', 'collections'))).toBe(true)
  await expect(page.getByRole('button', { name: '+ Clone' })).toBeEnabled()
})
