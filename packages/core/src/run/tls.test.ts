import fs from 'node:fs/promises'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadCollection } from '../workspace/collection.js'
import { runCollection } from './runCollection.js'
import { runRequest } from './runRequest.js'

/** A project's `tls.ca` reaches the requests its collections send (SPEC.md §1.1). */

const TLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/tls')

let server: https.Server
let origin: string
let hits = 0
let root: string
let file: string

beforeAll(async () => {
  server = https.createServer(
    {
      cert: await fs.readFile(path.join(TLS, 'server.pem')),
      key: await fs.readFile(path.join(TLS, 'server-key.pem'))
    },
    (_req, res) => {
      hits++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"secure":true}')
    }
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `https://localhost:${(server.address() as AddressInfo).port}`

  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-run-tls-')))
  file = path.join(root, 'collections', 'secure.yml')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.mkdir(path.join(root, 'certs'))
  await fs.copyFile(path.join(TLS, 'ca.pem'), path.join(root, 'certs', 'local-ca.pem'))
  await fs.writeFile(
    file,
    [
      'id: secure',
      'steps:',
      '  - name: over TLS',
      `    GET: ${origin}/`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      ''
    ].join('\n')
  )
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  hits = 0
})

const useProjectYml = (text: string) => fs.writeFile(path.join(root, 'project.yml'), text)

async function run() {
  const loaded = await loadCollection(file, root)
  return runCollection({
    collection: loaded.doc,
    collectionPath: file,
    context: { collectionPath: file }
  })
}

describe('tls.ca', () => {
  it('trusts a server signed by the project’s CA', async () => {
    await useProjectYml('tls:\n  ca: [certs/local-ca.pem]\n')
    const summary = await run()
    expect(summary.results[0]?.error).toBeNull()
    expect(summary.passed).toBe(1)
  })

  it('trusts it for a step run on its own too', async () => {
    await useProjectYml('tls:\n  ca: [certs/local-ca.pem]\n')
    const loaded = await loadCollection(file, root)
    const result = await runRequest({
      step: loaded.doc.steps[0]!,
      collection: loaded.doc,
      itemPath: file,
      context: { collectionPath: file }
    })
    expect(result.status).toBe('pass')
  })

  it('fails with what to do when the project does not trust it', async () => {
    await useProjectYml('name: No CA\n')
    const summary = await run()
    expect(summary.results[0]?.status).toBe('error')
    expect(summary.results[0]?.error).toMatchObject({
      phase: 'http',
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      message: expect.stringContaining('add its certificate to tls.ca in project.yml')
    })
  })

  it('sends nothing while a tls.ca file cannot be used', async () => {
    await useProjectYml('tls:\n  ca: [certs/local-ca.pem, certs/gone.pem]\n')
    const summary = await run()
    expect(hits).toBe(0)
    expect(summary.results[0]?.error).toEqual({
      phase: 'http',
      message:
        'A certificate in tls.ca cannot be used — certs/gone.pem: no such file (tls.ca in project.yml)'
    })
  })
})
