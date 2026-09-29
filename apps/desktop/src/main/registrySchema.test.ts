import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RegistryV2Schema, migrateV1, type RegistryV1 } from './registrySchema.js'

const root = path.resolve('/repos')
const at = (...segments: string[]) => path.join(root, ...segments)

describe('migrating a version 1 registry', () => {
  const v1: RegistryV1 = {
    version: 1,
    workspaces: [
      {
        id: 'ws-a',
        path: at('payments'),
        name: 'payments',
        autoFetchSeconds: 300,
        selectedEnvironments: { [at('payments', 'environments')]: 'demo' }
      },
      {
        id: 'ws-b',
        path: at('platform'),
        name: 'platform',
        autoFetchSeconds: null,
        selectedEnvironments: {
          [at('platform', 'services', 'auth', 'environments')]: 'staging',
          [at('platform', 'environments')]: 'shared-demo'
        }
      },
      {
        id: 'ws-c',
        path: at('empty'),
        name: 'empty',
        autoFetchSeconds: null,
        selectedEnvironments: {}
      }
    ]
  }
  const roots: Record<string, string[]> = {
    [at('payments')]: [at('payments')],
    [at('platform')]: [at('platform', 'services', 'auth'), at('platform', 'services', 'users')],
    [at('empty')]: []
  }

  it('makes one project per folder that held collections/, in a Default workspace', async () => {
    const v2 = await migrateV1(v1, async (folder) => roots[folder] ?? [])
    expect(RegistryV2Schema.parse(v2)).toEqual(v2)
    expect(v2.workspaces).toHaveLength(1)
    expect(v2.workspaces[0]?.name).toBe('Default')
    expect(v2.activeWorkspaceId).toBe(v2.workspaces[0]?.id)
    expect(v2.workspaces[0]?.projects.map((project) => project.path)).toEqual([
      at('payments'),
      at('platform', 'services', 'auth'),
      at('platform', 'services', 'users'),
      at('empty')
    ])
  })

  it('keeps each project’s chosen environment, from its own set or the one above', async () => {
    const v2 = await migrateV1(v1, async (folder) => roots[folder] ?? [])
    const chosen = v2.workspaces[0]?.projects.map((project) => project.selectedEnvironment)
    expect(chosen).toEqual(['demo', 'staging', 'shared-demo', null])
    expect(v2.workspaces[0]?.projects[0]?.autoFetchSeconds).toBe(300)
  })

  it('keeps a folder it cannot read as a project, so nothing disappears', async () => {
    const v2 = await migrateV1(v1, async () => {
      throw new Error('gone')
    })
    expect(v2.workspaces[0]?.projects).toHaveLength(3)
  })
})

describe('a version 2 registry', () => {
  it('reads a file written before the line-endings notice existed', () => {
    const parsed = RegistryV2Schema.parse({
      version: 2,
      activeWorkspaceId: 'ws-a',
      workspaces: [
        {
          id: 'ws-a',
          name: 'A',
          projects: [{ id: 'p', path: at('payments'), autoFetchSeconds: null }]
        }
      ]
    })
    expect(parsed.workspaces[0]?.projects[0]?.lineEndingsNoticeDismissed).toBe(false)
  })
})
