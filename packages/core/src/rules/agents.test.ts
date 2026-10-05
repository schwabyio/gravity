import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addAgentsSection, agentsState } from './agents.js'
import { AGENTS_SECTION } from './model.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function folder(agents?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-agents-')))
  roots.push(root)
  if (agents !== undefined) await fs.writeFile(path.join(root, 'AGENTS.md'), agents)
  return root
}

const read = (root: string) => fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')

describe('the AGENTS.md section', () => {
  it('makes the file when there is none', async () => {
    const root = await folder()
    expect(await agentsState(root)).toEqual({ exists: false, hasSection: false })
    expect(await addAgentsSection(root)).toEqual({ exists: true, hasSection: true })
    expect(await read(root)).toBe(AGENTS_SECTION)
    expect(AGENTS_SECTION).toContain('run `gta rules` in this folder')
    expect(AGENTS_SECTION).toContain('run `gta lint --json` in this folder')
  })

  it('fills an empty file with it', async () => {
    const root = await folder('\n\n')
    expect(await agentsState(root)).toEqual({ exists: true, hasSection: false })
    await addAgentsSection(root)
    expect(await read(root)).toBe(AGENTS_SECTION)
  })

  it('adds it after what the file says, once, in the file’s own line endings', async () => {
    const root = await folder('# Service\r\n\r\nBuild with make.\r\n\r\n\r\n')
    expect(await agentsState(root)).toEqual({ exists: true, hasSection: false })
    await addAgentsSection(root)
    const text = await read(root)
    expect(text).toBe(
      `# Service\r\n\r\nBuild with make.\r\n\r\n${AGENTS_SECTION.replace(/\n/g, '\r\n')}`
    )
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')

    await addAgentsSection(root)
    expect(await read(root)).toBe(text)
    expect(await agentsState(root)).toEqual({ exists: true, hasSection: true })
    expect(await fs.readdir(root)).toEqual(['AGENTS.md'])
  })

  it('says why an AGENTS.md that is there cannot be read, and writes nothing', async () => {
    const root = await folder()
    await fs.mkdir(path.join(root, 'AGENTS.md'))
    await expect(agentsState(root)).rejects.toThrow(/EISDIR/)
    await expect(addAgentsSection(root)).rejects.toThrow(/EISDIR/)
    expect(await fs.readdir(path.join(root, 'AGENTS.md'))).toEqual([])
  })
})
