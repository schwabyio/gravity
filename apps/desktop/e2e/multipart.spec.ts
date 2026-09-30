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

/**
 * Multipart and file bodies, edited in the Body tab and sent: the parts are
 * written to the collection, and a file chosen in the project folder reaches
 * the server byte for byte (SPEC.md §2.2).
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

let tmp: string
let shop: string
let server: http.Server
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Answers with what it received: each field's text, or a file's name, type and size.
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      const type = req.headers['content-type'] ?? ''
      const bytes = Buffer.concat(chunks)
      const answer: Record<string, unknown> = { type }
      if (type.startsWith('multipart/')) {
        const form = await new Response(bytes, { headers: { 'content-type': type } }).formData()
        for (const [name, value] of form) {
          answer[name] =
            typeof value === 'string'
              ? value
              : { filename: value.name, type: value.type, size: value.size }
        }
      } else {
        answer['hex'] = bytes.toString('hex')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-multipart-')))
  shop = path.join(tmp, 'shop')
  fs.mkdirSync(path.join(shop, 'collections'), { recursive: true })
  fs.mkdirSync(path.join(shop, 'files'))
  fs.writeFileSync(path.join(shop, 'files', 'avatar.png'), PNG)
  fs.writeFileSync(
    path.join(shop, 'collections', 'upload.yml'),
    ['id: upload', 'steps:', `  - POST: "${origin}/upload"`, ''].join('\n')
  )

  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await sizeWindow(app, page, { width: 1500, height: 900 })
  await page.waitForSelector('.sidebar')
  await pickNext(shop)
  await page.getByRole('button', { name: '+ Project' }).click()
  await page.getByRole('region', { name: 'Project shop' }).locator('.collection-row').click()
  await page.waitForSelector('.steps-column')
  await page.locator('.pane').first().getByRole('button', { name: /^Body/ }).click()
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

const collectionFile = () => fs.readFileSync(path.join(shop, 'collections', 'upload.yml'), 'utf8')

/** Send, then what the server said it received, as the response body shows it. */
const send = async () => {
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.status-pill')).toHaveText('200 OK')
  return page.locator('.response-body')
}

test('a multipart body with a text part and a file chosen from the project', async () => {
  await page.getByLabel('Body type').selectOption('multipart')
  const parts = page.getByRole('table', { name: 'Multipart parts' })
  await parts.getByLabel('Name of new part', { exact: true }).fill('caption')
  await parts.getByLabel('Value of caption', { exact: true }).fill('Me, at the beach')

  // The next blank row: a file, picked in the project folder and named after it.
  await parts.getByLabel('Type of new part', { exact: true }).selectOption('file')
  await pickNext(path.join(shop, 'files', 'avatar.png'))
  await parts.getByLabel('Choose a file for new part', { exact: true }).click()
  await expect(parts.getByLabel('File for avatar', { exact: true })).toHaveValue('files/avatar.png')

  await expect
    .poll(collectionFile, { timeout: 5_000 })
    .toContain(
      [
        '    body:',
        '      multipart:',
        '        caption: Me, at the beach',
        '        avatar:',
        '          file: files/avatar.png'
      ].join('\n')
    )

  const received = await send()
  await expect(received).toContainText('"type": "multipart/form-data; boundary=')
  await expect(received).toContainText('"caption": "Me, at the beach"')
  await expect(received).toContainText('"filename": "avatar.png"')
  await expect(received).toContainText('"type": "image/png"')
  await expect(received).toContainText(`"size": ${PNG.length}`)
})

test('a file sent as the whole body', async () => {
  await page.getByLabel('Body type').selectOption('file')
  await pickNext(path.join(shop, 'files', 'avatar.png'))
  await page.getByRole('button', { name: 'Choose file…' }).click()
  await expect(page.getByLabel('Body file')).toHaveValue('files/avatar.png')
  await expect
    .poll(collectionFile, { timeout: 5_000 })
    .toContain('body:\n      file: files/avatar.png')

  const received = await send()
  await expect(received).toContainText('"type": "image/png"')
  await expect(received).toContainText(`"hex": "${PNG.toString('hex')}"`)
})

test('a file that is not there stops the send, naming it', async () => {
  await page.getByLabel('Body file').fill('files/gone.png')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.placeholder.error')).toContainText(
    'body.file: files/gone.png — no such file in the project folder'
  )
})
