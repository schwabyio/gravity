import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry } from './workspaceRegistry.js'

let tmp: string

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-registry-')))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('saving the workspace registry', () => {
  it('saves changes made at once one after another, so every one lands', async () => {
    const file = path.join(tmp, 'workspaces.json')
    const registry = new WorkspaceRegistry(file)
    const workspace = (await registry.load()).workspaces[0]!
    await Promise.all([
      ...Array.from({ length: 20 }, (_, n) =>
        registry.addProject(workspace.id, path.join(tmp, `project-${n}`))
      ),
      registry.createWorkspace('Second')
    ])

    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
      workspaces: Array<{ name: string; projects: unknown[] }>
    }
    expect(saved.workspaces.map((entry) => entry.name)).toEqual(['My workspace', 'Second'])
    expect(saved.workspaces[0]!.projects).toHaveLength(20)
    expect(await fs.readdir(tmp)).toEqual(['workspaces.json'])
  })

  it('saves again after a save fails', async () => {
    // A file where the registry's folder should be: the first save cannot write.
    const folder = path.join(tmp, 'user-data')
    await fs.writeFile(folder, '')
    const registry = new WorkspaceRegistry(path.join(folder, 'workspaces.json'))
    await registry.load()
    await expect(registry.createWorkspace('Lost')).rejects.toThrow()

    await fs.rm(folder)
    await registry.createWorkspace('Kept')
    const saved = JSON.parse(await fs.readFile(path.join(folder, 'workspaces.json'), 'utf8')) as {
      workspaces: Array<{ name: string }>
    }
    expect(saved.workspaces.map((entry) => entry.name)).toEqual(['My workspace', 'Lost', 'Kept'])
  })
})
