import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readYamlMap, YamlMapError } from './yamlMap.js'

let tmp: string
beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-yamlmap-')))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** `body` written to a file of its own, and the file read as a map labelled `shared/rules.yml`. */
async function read(name: string, body?: string) {
  const file = path.join(tmp, name)
  if (body !== undefined) await fs.writeFile(file, body)
  return readYamlMap(file, '../shared/rules.yml', 'ids: { collections: kebab-case }')
}

describe('readYamlMap', () => {
  it('reads a map, an empty file as an empty one, and no file as none', async () => {
    expect(await read('map.yml', 'tags:\n  allowed: [smoke]\n')).toEqual({
      tags: { allowed: ['smoke'] }
    })
    expect(await read('empty.yml', '')).toEqual({})
    expect(await read('comments.yml', '# nothing yet\n')).toEqual({})
    expect(await read('missing.yml')).toBeNull()
  })

  it('names the file, as the project reaches it, when it will not parse or is not a map', async () => {
    await expect(read('broken.yml', 'ids: [')).rejects.toThrow(
      /^\.\.\/shared\/rules\.yml will not parse: /
    )
    for (const [name, body] of [
      ['list.yml', '- a\n- b\n'],
      ['scalar.yml', 'kebab-case\n']
    ] as const) {
      const error = await read(name, body).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(YamlMapError)
      expect((error as Error).message).toBe(
        '../shared/rules.yml must be a map, such as ids: { collections: kebab-case }'
      )
    }
  })

  it('says why a file that is there cannot be read', async () => {
    await fs.mkdir(path.join(tmp, 'folder.yml'))
    await expect(read('folder.yml')).rejects.toThrow(/^\.\.\/shared\/rules\.yml cannot be read: /)
  })
})
