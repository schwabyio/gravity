import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadCollection } from '../workspace/collection.js'
import { runCollection } from './runCollection.js'
import { runRequest } from './runRequest.js'

/**
 * Multipart and file bodies, run end to end: files read from the project a
 * step belongs to, the bytes a server receives, and a file that cannot be
 * read (SPEC.md §2.2).
 */

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

let server: http.Server
let origin: string
let hits = 0
let tmp: string
let shop: string
let shared: string

const write = async (file: string, body: string | Uint8Array) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

beforeAll(async () => {
  // Answers with what it received: each field's text, or a file's name, type and bytes.
  server = http.createServer((req, res) => {
    hits++
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
              : {
                  filename: value.name,
                  type: value.type,
                  bytes: [...new Uint8Array(await value.arrayBuffer())]
                }
        }
      } else {
        answer['bytes'] = [...bytes]
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-upload-')))
  shop = path.join(tmp, 'shop')
  shared = path.join(tmp, 'shared')
  await write(path.join(shop, 'project.yml'), 'uses: ../shared\n')
  await write(path.join(shop, 'files', 'avatar.png'), PNG)
  await write(path.join(shared, 'project.yml'), 'name: Shared\n')
  await write(path.join(shared, 'files', 'terms.txt'), 'shared terms')
  // A request set in the global project: its file is the global project's.
  await write(
    path.join(shared, 'requests', 'accept-terms.yml'),
    [
      'id: accept-terms',
      'params: { who: { required: true } }',
      'steps:',
      '  - name: accept terms',
      `    POST: ${origin}/terms`,
      '    body:',
      '      multipart:',
      "        who: '{{params.who}}'",
      '        terms: { file: files/terms.txt }',
      '    tests: |',
      "      gta.expectResponseBodyToHaveProperty('who', 'dave')",
      "      gta.expectResponseBodyToHaveProperty('terms.filename', 'terms.txt')",
      ''
    ].join('\n')
  )
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmp, { recursive: true, force: true })
})

async function run(file: string, text: string) {
  await write(file, text)
  const loaded = await loadCollection(file, shop)
  expect(loaded.problems).toEqual([])
  return runCollection({
    collection: loaded.doc,
    collectionPath: file,
    context: { collectionPath: file }
  })
}

describe('uploads', () => {
  it('sends a multipart body with a file from the project folder, from a collection a directory down', async () => {
    const summary = await run(
      path.join(shop, 'collections', 'profile', 'avatar.yml'),
      [
        'id: avatar',
        'vars: { image: avatar.png }',
        'steps:',
        '  - name: upload',
        `    POST: ${origin}/avatar`,
        '    body:',
        '      multipart:',
        '        caption: Me, {{image}}',
        '        avatar: { file: "files/{{image}}" }',
        ''
      ].join('\n')
    )
    const result = summary.results[0]!
    expect(result.error).toBeNull()
    expect(JSON.parse(result.response!.body)).toEqual({
      type: expect.stringMatching(/^multipart\/form-data; boundary=/),
      caption: 'Me, avatar.png',
      avatar: { filename: 'avatar.png', type: 'image/png', bytes: [...PNG] }
    })
    expect(result.request.body).toContain('‹file files/avatar.png, 10 bytes›')
  })

  it('sends a file body as it is', async () => {
    const summary = await run(
      path.join(shop, 'collections', 'raw.yml'),
      [
        'id: raw',
        'steps:',
        `  - PUT: ${origin}/raw`,
        '    body: { file: files/avatar.png }',
        ''
      ].join('\n')
    )
    expect(JSON.parse(summary.results[0]!.response!.body)).toEqual({
      type: 'image/png',
      bytes: [...PNG]
    })
  })

  it('reads a global project’s request set’s files from the global project', async () => {
    const summary = await run(
      path.join(shop, 'collections', 'terms.yml'),
      ['id: terms', 'steps:', '  - use: accept-terms', '    with: { who: dave }', ''].join('\n')
    )
    expect(summary.results[0]?.error).toBeNull()
    expect(summary.passed).toBe(1)
  })

  it('stops a step whose file cannot be read, sending nothing', async () => {
    hits = 0
    const summary = await run(
      path.join(shop, 'collections', 'missing.yml'),
      [
        'id: missing',
        'steps:',
        `  - POST: ${origin}/avatar`,
        '    body: { multipart: { avatar: { file: files/gone.png } } }',
        ''
      ].join('\n')
    )
    expect(hits).toBe(0)
    expect(summary.results[0]).toMatchObject({
      status: 'error',
      error: {
        phase: 'body',
        message: 'multipart field avatar: files/gone.png — no such file in the project folder'
      }
    })
  })

  it('refuses a file for a request in no project', async () => {
    const result = await runRequest({
      step: { POST: `${origin}/raw`, body: { file: 'files/avatar.png' } }
    })
    expect(result.error).toMatchObject({
      phase: 'body',
      message: expect.stringContaining('save the collection in a project first')
    })
  })
})
