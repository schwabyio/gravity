import fs from 'node:fs'
import https from 'node:https'
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
 * A server whose certificate a local CA signed: refused until the project
 * trusts that CA in Project settings, which writes `tls.ca` (SPEC.md §1.1),
 * or until it uses a global project whose `tls.ca` lists it.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const TLS = path.resolve(process.cwd(), '../../packages/core/test-fixtures/tls')

let tmp: string
let shop: string
let origin: string
let server: https.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  server = https.createServer(
    {
      cert: fs.readFileSync(path.join(TLS, 'server.pem')),
      key: fs.readFileSync(path.join(TLS, 'server-key.pem'))
    },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"secure":true}')
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `https://localhost:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-tls-')))
  shop = path.join(tmp, 'shop')
  fs.mkdirSync(path.join(shop, 'collections'), { recursive: true })
  fs.mkdirSync(path.join(shop, 'certs'))
  fs.copyFileSync(path.join(TLS, 'ca.pem'), path.join(shop, 'certs', 'local-ca.pem'))
  write(path.join(shop, 'collections', 'secure.yml'), secureCollection())

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 850 })
  await page.waitForSelector('.sidebar')
  await (await addProject(app, page, shop)).locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
})

test.afterAll(async () => {
  await app?.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** What the next open dialog picks. */
const pickNext = (target: string) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, target)

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** One step: a GET to the server a local CA signed for. */
const secureCollection = () => ['id: secure', 'steps:', `  - GET: "${origin}/"`, ''].join('\n')

const projectRegion = (name: string) => page.getByRole('region', { name: `Project ${name}` })

const openProjectSettings = async (name = 'shop') => {
  await page.getByRole('button', { name: `Project actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Project settings' }).click()
  return page.getByRole('dialog', { name: 'Project settings' })
}

test('an untrusted CA fails the send, saying where to trust it', async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  const error = page.locator('.placeholder.error')
  await expect(error).toContainText('add its certificate to tls.ca in project.yml')
  await expect(error).toContainText('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
})

test('adding the CA in Project settings writes tls.ca and makes the send pass', async () => {
  const drawer = await openProjectSettings()
  // Spelled as a dialog may spell it, not as the project root is: through the
  // symlink macOS keeps /var behind, or with a short name like RUNNER~1 on Windows.
  await pickNext(path.join(os.tmpdir(), path.basename(tmp), 'shop', 'certs', 'local-ca.pem'))
  await drawer.getByRole('button', { name: 'Add certificate…' }).click()

  await expect(drawer.getByLabel('CA certificate 1')).toHaveValue('certs/local-ca.pem')
  await expect
    .poll(() => read(path.join(shop, 'project.yml')), { timeout: 5_000 })
    .toBe('tls:\n  ca:\n    - certs/local-ca.pem\n')
  // Once saved, it shows what the file holds, so it is plainly the CA meant.
  await expect(drawer.getByRole('list', { name: 'CA certificates' })).toContainText(
    'Gravity Test CA · expires'
  )
  await drawer.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toHaveText('200 OK')
})

test('a certificate file that cannot be used is a project problem, and sends nothing', async () => {
  const drawer = await openProjectSettings()
  await drawer.getByLabel('CA certificate 1').fill('certs/gone.pem')
  await expect(drawer.getByRole('list', { name: 'CA certificates' })).toContainText(
    'no such file',
    { timeout: 5_000 }
  )
  await drawer.getByRole('button', { name: 'Close' }).click()
  await expect(projectRegion('shop').getByLabel('Project problems')).toBeVisible()

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toContainText(
    'A certificate in tls.ca cannot be used — certs/gone.pem: no such file'
  )

  // Removing it trusts nothing extra: tls leaves project.yml.
  const again = await openProjectSettings()
  await again.getByRole('button', { name: 'Remove certs/gone.pem' }).click()
  await expect.poll(() => read(path.join(shop, 'project.yml')), { timeout: 5_000 }).toBe('{}\n')
  await expect(projectRegion('shop').getByLabel('Project problems')).toHaveCount(0)
  await again.getByRole('button', { name: 'Close' }).click()
})

test('a global project’s tls.ca is trusted by every project that uses it, and by no other', async () => {
  const shared = path.join(tmp, 'shared')
  write(path.join(shared, 'project.yml'), 'name: Shared\ntls:\n  ca: [certs/company-root.pem]\n')
  write(
    path.join(shared, 'certs', 'company-root.pem'),
    fs.readFileSync(path.join(TLS, 'ca.pem'), 'utf8')
  )
  // Two services using it, neither with a tls of its own.
  const services = ['orders', 'billing']
  for (const name of services) {
    write(path.join(tmp, name, 'project.yml'), 'uses: ../shared\n')
    write(path.join(tmp, name, 'collections', 'secure.yml'), secureCollection())
  }

  for (const name of services) {
    await addProject(app, page, path.join(tmp, name))
    await expect(projectRegion(name).locator('.uses-badge')).toHaveText('uses Shared')
    await projectRegion(name).locator('.collection-row').click()
    // No response left over from the last project's send.
    await expect(page.locator('.status-pill')).toHaveCount(0)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.status-pill')).toHaveText('200 OK')
  }

  // Shown in each using project's settings, as shared, and not editable from there.
  const drawer = await openProjectSettings('orders')
  const sharedList = drawer.getByRole('list', { name: 'Shared CA certificates' })
  await expect(sharedList).toContainText('certs/company-root.pem')
  await expect(sharedList).toContainText('Gravity Test CA · expires')
  await expect(sharedList.locator('input, button')).toHaveCount(0)
  await expect(drawer.getByRole('list', { name: 'CA certificates', exact: true })).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Close' }).click()
  expect(read(path.join(tmp, 'orders', 'project.yml'))).toBe('uses: ../shared\n')

  // shop does not use it: its send is still refused.
  await projectRegion('shop').locator('.collection-row').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toContainText('UNABLE_TO_VERIFY_LEAF_SIGNATURE')

  // The shared file gone is a problem on every project using it, seen without a restart.
  fs.rmSync(path.join(shared, 'certs', 'company-root.pem'))
  for (const name of services) {
    await expect(projectRegion(name).getByLabel('Project problems')).toBeVisible({
      timeout: 5_000
    })
  }
  await expect(projectRegion('shop').getByLabel('Project problems')).toHaveCount(0)
  await projectRegion('billing').locator('.collection-row').click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toContainText(
    'A certificate in tls.ca cannot be used — ../shared/certs/company-root.pem: no such file (tls.ca in ../shared/project.yml)'
  )
})
