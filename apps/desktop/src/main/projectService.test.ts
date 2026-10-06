import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/ipc.js'
import { ProjectService } from './projectService.js'

let tmp: string
let service: ProjectService
/** git's answers held back, oldest first, while `holding` is on: a slow git, on cue. */
let held: Array<() => void>
let holding: boolean

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-service-')))
  await fs.mkdir(path.join(tmp, 'shop', 'collections'), { recursive: true })
  await fs.writeFile(path.join(tmp, 'shop', 'collections', 'a.yml'), 'id: a\nsteps: []\n')
  service = new ProjectService({
    registryFile: path.join(tmp, 'workspaces.json'),
    moveAside: async () => undefined,
    scratchPads: () => path.join(tmp, 'scratch')
  })
  held = []
  holding = false
  // git stands in as a folder outside any repository, answering when let.
  Object.assign(service, {
    readRepo: () =>
      new Promise((resolve) => {
        const answer = () => resolve({ repo: null, git: null, gitNote: null })
        if (holding) held.push(answer)
        else answer()
      })
  })
})

afterEach(async () => {
  service.dispose()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('refreshing a project', () => {
  it('never lets a refresh begun earlier replace the view of one begun later', async () => {
    const state = await service.init()
    const added = await service.addProject(state.activeWorkspaceId!, path.join(tmp, 'shop'))
    if (!added.ok) throw new Error(added.message)
    const id = added.project.id
    const shown: ProjectView[] = []
    service.onProject((view) => shown.push(view))

    holding = true
    // Begun with other chosen; listed from its files once git keeps it waiting.
    const first = service.selectEnvironment(id, 'other')
    await expect.poll(() => shown.at(-1)?.selectedEnvironment, { timeout: 3000 }).toBe('other')

    // Begun after it, with local chosen, and answered first.
    const second = service.selectEnvironment(id, 'local')
    await expect.poll(() => held.length).toBe(2)
    held[1]!()
    await second
    expect(shown.at(-1)?.selectedEnvironment).toBe('local')

    // The first's git answers last: its view, of other, is not shown.
    const count = shown.length
    held[0]!()
    await first
    expect(shown).toHaveLength(count)
    expect(service.project(id)?.selectedEnvironment).toBe('local')
  })
})
