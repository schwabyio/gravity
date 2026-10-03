import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StepSchema, type VarValue } from '../model/documents.js'
import type { SentRequest } from '../model/run.js'
import { InterpolationError, VariableScope } from '../vars/scope.js'
import { toSentRequest } from './buildRequest.js'
import { BodyFileError, prepareRequest, type FileRoots } from './prepareRequest.js'

/** Bytes that are not text: a PNG signature, a NUL and a byte UTF-8 never uses. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

let tmp: string
let root: string
let shared: string

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-body-')))
  root = path.join(tmp, 'shop')
  shared = path.join(tmp, 'shared')
  await fs.mkdir(path.join(root, 'files'), { recursive: true })
  await fs.writeFile(path.join(root, 'files', 'avatar.png'), PNG)
  await fs.writeFile(path.join(root, 'files', 'order.json'), '{"id": "{{notResolved}}"}')
  await fs.writeFile(path.join(root, 'files', 'empty'), '')
  // The global project's: one only it has, and one the project has its own of.
  await fs.mkdir(path.join(shared, 'files'), { recursive: true })
  await fs.writeFile(path.join(shared, 'files', 'terms.txt'), 'shared terms')
  await fs.writeFile(path.join(shared, 'files', 'avatar.png'), 'shared avatar')
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const scope = (vars: Record<string, VarValue> = {}) =>
  new VariableScope([{ source: 'test', vars }], {})

async function prepare(
  step: unknown,
  vars: Record<string, VarValue> = {},
  files: FileRoots | null = { project: root, global: null }
) {
  const parsed = StepSchema.parse(step)
  return prepareRequest(toSentRequest(parsed), parsed.body, scope(vars), files)
}

/** The project, with the global project it uses. */
const withGlobal = (): FileRoots => ({ project: root, global: shared })

/** Read a multipart body back the way a server would, with an independent parser. */
async function received(request: SentRequest, payload: Uint8Array | null) {
  const type = request.headers.find((h) => h.name.toLowerCase() === 'content-type')!.value
  return new Response(payload, { headers: { 'content-type': type } }).formData()
}

describe('prepareRequest', () => {
  it('resolves variables in a form’s names and values before encoding them', async () => {
    const { request, payload } = await prepare(
      { POST: 'http://x/', body: { form: { user: '{{name}}', '{{field}}': 'a=b' } } },
      { name: 'dave & co', field: 'note' }
    )
    expect(payload).toBeNull()
    expect(request.body).toBe('user=dave+%26+co&note=a%3Db')
    expect(request.headers).toEqual([
      { name: 'Content-Type', value: 'application/x-www-form-urlencoded' }
    ])
  })

  it('builds a multipart body with text, typed text, files and repeated names', async () => {
    const { request, payload } = await prepare(
      {
        POST: '{{base}}/upload',
        body: {
          multipart: {
            description: 'A photo of {{name}}',
            metadata: { value: '{"album":"{{album}}"}', contentType: 'application/json' },
            avatar: { file: 'files/{{image}}' },
            tags: ['red', 'blue']
          }
        }
      },
      { base: 'http://x', name: 'Dave', album: 'Summer', image: 'avatar.png' }
    )
    expect(request.url).toBe('http://x/upload')
    expect(request.headers[0]!.value).toMatch(
      /^multipart\/form-data; boundary=----GravityBoundary[0-9a-f]{24}$/
    )

    const form = await received(request, payload)
    expect(form.get('description')).toBe('A photo of Dave')
    expect(form.get('metadata')).toBe('{"album":"Summer"}')
    expect(form.getAll('tags')).toEqual(['red', 'blue'])
    const avatar = form.get('avatar') as File
    expect(avatar.name).toBe('avatar.png')
    expect(avatar.type).toBe('image/png')
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(PNG)

    // Shown with the file's bytes replaced, so results and reports stay text.
    expect(request.body).toContain(
      'name="avatar"; filename="avatar.png"\r\nContent-Type: image/png'
    )
    expect(request.body).toContain('‹file files/avatar.png, 10 bytes›')
    expect(request.body).toContain('Content-Type: application/json\r\n\r\n{"album":"Summer"}')
  })

  it('sends a file part under its own name and type when told to', async () => {
    const { request, payload } = await prepare(
      {
        POST: 'http://x/',
        body: {
          multipart: {
            doc: {
              file: 'files/order.json',
              filename: 'order-{{id}}.json',
              contentType: 'text/plain'
            }
          }
        }
      },
      { id: '7' }
    )
    const doc = (await received(request, payload)).get('doc') as File
    expect(doc.name).toBe('order-7.json')
    expect(doc.type).toBe('text/plain')
    // A file is sent as it is: its own {{…}} are not variables.
    expect(await doc.text()).toBe('{"id": "{{notResolved}}"}')
  })

  it('sends an empty filename, as a browser does with no file chosen', async () => {
    const { request, payload } = await prepare({
      POST: 'http://x/',
      body: { multipart: { avatar: { file: 'files/empty', filename: '' } } }
    })
    expect(request.body).toContain('Content-Disposition: form-data; name="avatar"; filename=""')
    expect(payload).not.toBeNull()
  })

  it('writes a null as null in a JSON body, and as nothing elsewhere', async () => {
    const vars = { site: null, whole: null }
    const json = await prepare(
      { POST: 'http://x/{{site}}', body: { json: '{"website": {{site}}, "note": "{{site}}"}' } },
      vars
    )
    expect(json.request.body).toBe('{"website": null, "note": "null"}')
    expect(json.request.url).toBe('http://x/')
    const sole = await prepare({ POST: 'http://x/', body: { json: '{{whole}}' } }, vars)
    expect(sole.request.body).toBe('null')
    const text = await prepare({ POST: 'http://x/', body: { text: 'site: {{site}}' } }, vars)
    expect(text.request.body).toBe('site: ')
  })

  it('keeps a declared boundary, and adds one to a declared type without', async () => {
    const declared = await prepare({
      POST: 'http://x/',
      headers: { 'Content-Type': 'multipart/form-data; boundary=fixed' },
      body: { multipart: { a: '1' } }
    })
    expect(declared.request.body).toBe(
      '--fixed\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--fixed--\r\n'
    )
    const bare = await prepare({
      POST: 'http://x/',
      headers: { 'content-type': 'multipart/form-data' },
      body: { multipart: { a: '1' } }
    })
    expect(bare.request.headers).toHaveLength(1)
    expect((await received(bare.request, bare.payload)).get('a')).toBe('1')
  })

  it('sends a file body as it is, typed by its extension unless a header says', async () => {
    const png = await prepare({ PUT: 'http://x/', body: { file: 'files/avatar.png' } })
    expect(png.payload).toEqual(Buffer.from(PNG))
    expect(png.request.body).toBe('‹file files/avatar.png, 10 bytes›')
    expect(png.request.headers).toEqual([{ name: 'Content-Type', value: 'image/png' }])

    const typed = await prepare({
      PUT: 'http://x/',
      headers: { 'Content-Type': 'application/vnd.order+json' },
      body: { file: 'files/order.json' }
    })
    expect(typed.request.headers).toEqual([
      { name: 'Content-Type', value: 'application/vnd.order+json' }
    ])
  })

  it('says which file it could not read, and why', async () => {
    await expect(
      prepare({ POST: 'http://x/', body: { multipart: { avatar: { file: 'files/gone.png' } } } })
    ).rejects.toThrow(
      new BodyFileError(
        'multipart field avatar: files/gone.png — no such file in the project folder'
      )
    )
    await expect(prepare({ POST: 'http://x/', body: { file: 'files' } })).rejects.toThrow(
      'body.file: files — is a folder, not a file'
    )
    await expect(
      prepare({ POST: 'http://x/', body: { file: '{{where}}' } }, { where: '/etc/hosts' })
    ).rejects.toThrow('must be a relative path')
    await expect(
      prepare({ POST: 'http://x/', body: { file: 'files/avatar.png' } }, {}, null)
    ).rejects.toThrow('save the collection in a project first')
  })

  it('reads a file the project does not have from its global project, and says so', async () => {
    const whole = await prepare(
      { PUT: 'http://x/', body: { file: 'files/terms.txt' } },
      {},
      withGlobal()
    )
    expect(whole.payload).toEqual(Buffer.from('shared terms'))
    expect(whole.request.body).toBe('‹file global:files/terms.txt, 12 bytes›')
    expect(whole.request.headers).toEqual([{ name: 'Content-Type', value: 'text/plain' }])

    // The project's own copy wins; global: reads the global project's alone.
    const { request, payload } = await prepare(
      {
        POST: 'http://x/',
        body: {
          multipart: {
            own: { file: 'files/avatar.png' },
            shared: { file: 'global:files/avatar.png' },
            named: { file: '{{where}}files/terms.txt' }
          }
        }
      },
      { where: 'global:' },
      withGlobal()
    )
    const form = await received(request, payload)
    expect(new Uint8Array(await (form.get('own') as File).arrayBuffer())).toEqual(PNG)
    const theirs = form.get('shared') as File
    expect(theirs.name).toBe('avatar.png')
    expect(await theirs.text()).toBe('shared avatar')
    expect((form.get('named') as File).name).toBe('terms.txt')
    expect(request.body).toContain('‹file files/avatar.png, 10 bytes›')
    expect(request.body).toContain('‹file global:files/avatar.png, 13 bytes›')
    expect(request.body).toContain('‹file global:files/terms.txt, 12 bytes›')
  })

  it('says where it looked for a file, in the project and its global project', async () => {
    const file = async (written: string, files: FileRoots | null = withGlobal()) =>
      prepare({ POST: 'http://x/', body: { file: written } }, {}, files)
    await expect(file('files/gone.png')).rejects.toThrow(
      new BodyFileError(
        "body.file: files/gone.png — no such file in the project folder, or in its global project's (../shared)"
      )
    )
    await expect(file('global:files/gone.png')).rejects.toThrow(
      'body.file: global:files/gone.png — no such file in the global project folder'
    )
    await expect(file('global:files/terms.txt', { project: root, global: null })).rejects.toThrow(
      'body.file: global:files/terms.txt — this project does not use a global project'
    )
    await expect(file('global:../shop/files/avatar.png')).rejects.toThrow(
      'body.file: global:../shop/files/avatar.png — a global: path stays in the global project folder'
    )
    await expect(file('global:/etc/hosts')).rejects.toThrow('must be a relative path')
    // A path out of the project names its place itself: no global project to fall back to.
    await expect(file('../elsewhere/terms.txt')).rejects.toThrow(
      'body.file: ../elsewhere/terms.txt — no such file in the project folder'
    )
    expect((await file('../shared/files/terms.txt')).request.body).toBe(
      '‹file ../shared/files/terms.txt, 12 bytes›'
    )
    // Misspelled in the project is an error, never a reason to look further.
    await expect(file('files/Avatar.png')).rejects.toThrow(
      /^body\.file: files\/Avatar\.png is spelled/
    )
    // The global project's own steps: its folder is both.
    const own = await file('global:files/terms.txt', { project: shared, global: shared })
    expect(own.request.body).toBe('‹file global:files/terms.txt, 12 bytes›')
  })

  it('reports a missing variable in a part as an interpolation error', async () => {
    await expect(
      prepare({ POST: 'http://x/', body: { multipart: { a: '{{nope}}' } } })
    ).rejects.toBeInstanceOf(InterpolationError)
  })
})
