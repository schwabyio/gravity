import { X509Certificate } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectDocSchema } from '../model/documents.js'
import { readProject } from './project.js'
import { editProjectSource } from './projectEdits.js'
import { loadProjectTls } from './projectTls.js'

const TLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/tls')

let tmp: string
let shop: string
let shared: string
let caPem: string

const write = async (file: string, body: string | Uint8Array) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-tls-')))
  shop = path.join(tmp, 'services', 'shop')
  shared = path.join(tmp, 'shared')
  caPem = await fs.readFile(path.join(TLS, 'ca.pem'), 'utf8')
  await write(path.join(shop, 'certs', 'ca.pem'), caPem)
  await write(path.join(shared, 'certs', 'ca.cer'), new X509Certificate(caPem).raw)
  await write(path.join(shared, 'project.yml'), 'name: Shared\ntls:\n  ca: [certs/ca.cer]\n')
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('loadProjectTls', () => {
  it('reads the project’s tls.ca, then its global project’s, each from its own folder', async () => {
    await write(
      path.join(shop, 'project.yml'),
      'uses: ../../shared\ntls:\n  ca:\n    - certs\\ca.pem\n'
    )
    const trust = await loadProjectTls(shop, await readProject(shop))
    expect(trust.problems).toEqual([])
    expect(trust.files).toEqual([
      {
        path: 'certs/ca.pem',
        source: 'project',
        file: path.join(shop, 'certs', 'ca.pem'),
        certificates: [{ subject: 'Gravity Test CA', expires: expect.stringMatching(/^2126-/) }],
        problem: null
      },
      expect.objectContaining({ path: 'certs/ca.cer', source: 'global', problem: null })
    ])
    // The DER file is trusted as PEM, as TLS wants it.
    expect(trust.ca).toHaveLength(2)
    expect(trust.ca.every((pem) => pem.trim() === caPem.trim())).toBe(true)
  })

  it('reports a file that cannot be used against its path, saying which project.yml lists it', async () => {
    await write(
      path.join(shop, 'certs', 'key.pem'),
      await fs.readFile(path.join(TLS, 'server-key.pem'))
    )
    await write(path.join(shared, 'project.yml'), 'name: Shared\ntls:\n  ca: [certs/missing.pem]\n')
    await write(
      path.join(shop, 'project.yml'),
      'uses: ../../shared\ntls:\n  ca: [certs/key.pem, certs]\n'
    )
    const trust = await loadProjectTls(shop, await readProject(shop))
    expect(trust.ca).toEqual([])
    expect(trust.files.map((file) => file.problem)).toEqual([
      'holds no certificate: a PEM file needs a -----BEGIN CERTIFICATE----- block',
      'is a folder, not a certificate file',
      'no such file'
    ])
    expect(trust.problems).toEqual([
      {
        path: 'certs/key.pem',
        message:
          'holds no certificate: a PEM file needs a -----BEGIN CERTIFICATE----- block (tls.ca in project.yml)'
      },
      { path: 'certs', message: 'is a folder, not a certificate file (tls.ca in project.yml)' },
      {
        path: '../../shared/certs/missing.pem',
        message: 'no such file (tls.ca in ../../shared/project.yml)'
      }
    ])
    await write(path.join(shared, 'project.yml'), 'name: Shared\ntls:\n  ca: [certs/ca.cer]\n')
  })

  it('trusts nothing extra without tls', async () => {
    await write(path.join(shop, 'project.yml'), 'name: Shop\n')
    expect(await loadProjectTls(shop, await readProject(shop))).toEqual({
      files: [],
      ca: [],
      problems: []
    })
  })
})

describe('project.yml tls', () => {
  it('takes a list of relative paths', () => {
    expect(ProjectDocSchema.parse({ tls: { ca: ['certs/a.pem'] } }).tls).toEqual({
      ca: ['certs/a.pem']
    })
    expect(() => ProjectDocSchema.parse({ tls: { ca: ['/etc/ssl/a.pem'] } })).toThrow(
      'tls.ca must be a relative path'
    )
    expect(() => ProjectDocSchema.parse({ tls: { ca: ['C:\\certs\\a.pem'] } })).toThrow(
      'tls.ca must be a relative path'
    )
    expect(() => ProjectDocSchema.parse({ tls: { ca: 'certs/a.pem' } })).toThrow(
      'tls.ca is a list of certificate files'
    )
    expect(() => ProjectDocSchema.parse({ tls: { cert: 'x' } })).toThrow()
  })

  it('is written after the other keys, with /, and removed when empty', () => {
    const source = 'name: Shop\nvars:\n  region: eu\n'
    const added = editProjectSource(source, [
      { key: 'tls', value: { ca: [' certs\\company-root.pem '] } }
    ])
    expect(added).toBe(
      'name: Shop\nvars:\n  region: eu\ntls:\n  ca:\n    - certs/company-root.pem\n'
    )
    expect(editProjectSource(added, [{ key: 'tls', value: undefined }])).toBe(source)
  })
})
