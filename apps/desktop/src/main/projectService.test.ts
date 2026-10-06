import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/ipc.js'
import type { GitSetup } from './bundledGit.js'
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
  // git stands in as a folder outside any repository, answering when let. And
  // nothing is watched: every refresh is one a test begins.
  Object.assign(service, {
    watcher: { watch: () => undefined, unwatch: () => undefined, dispose: () => undefined },
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

/** The project at shop/, added to the workspace; its id. */
async function addShop(): Promise<string> {
  const state = await service.init()
  const added = await service.addProject(state.activeWorkspaceId!, path.join(tmp, 'shop'))
  if (!added.ok) throw new Error(added.message)
  return added.project.id
}

/** Every view of a project shown from now on, oldest first. */
function watchShown(): ProjectView[] {
  const shown: ProjectView[] = []
  service.onProject((view) => shown.push(view))
  return shown
}

describe('refreshing a project', () => {
  it('never lets a refresh begun earlier replace the view of one begun later', async () => {
    const id = await addShop()
    const shown = watchShown()

    holding = true
    // Begun before b.yml is made; listed from its files once git keeps it waiting.
    const first = service.refresh(id)
    await expect.poll(() => shown.at(-1)?.collections.length, { timeout: 3000 }).toBe(1)
    await fs.writeFile(path.join(tmp, 'shop', 'collections', 'b.yml'), 'id: b\nsteps: []\n')

    // Begun after it, so it reads b.yml, and answered first.
    const second = service.refresh(id)
    await expect.poll(() => held.length).toBe(2)
    held[1]!()
    await second
    expect(shown.at(-1)?.collections).toHaveLength(2)

    // The first's git answers last: its view, without b.yml, is not shown.
    const count = shown.length
    held[0]!()
    await first
    expect(shown).toHaveLength(count)
    expect(service.project(id)?.collections).toHaveLength(2)
  })
})

describe('choosing an environment', () => {
  it('shows the choice at once, and a refresh begun before it keeps it', async () => {
    const id = await addShop()
    const shown = watchShown()

    holding = true
    // Begun before the choice, and kept waiting by git.
    const refreshing = service.refresh(id)
    await expect.poll(() => shown.length, { timeout: 3000 }).toBe(1)

    await service.selectEnvironment(id, 'local')
    // Shown at once, with no refresh of its own: git was not asked again.
    expect(shown.at(-1)?.selectedEnvironment).toBe('local')
    expect(held).toHaveLength(1)
    const saved = JSON.parse(await fs.readFile(path.join(tmp, 'workspaces.json'), 'utf8'))
    expect(saved.workspaces[0].projects[0].selectedEnvironment).toBe('local')

    // The refresh read its files before the choice; its view, once git answers, has it.
    held[0]!()
    await refreshing
    expect(shown.at(-1)?.selectedEnvironment).toBe('local')
    expect(service.project(id)?.selectedEnvironment).toBe('local')
  })
})

describe('starting up', () => {
  it('lists each project from its files while git is still being set up', async () => {
    await addShop()
    service.dispose()
    // A later start, finding the project in the registry, with git slow to set up.
    let settle!: (git: GitSetup) => void
    const starting = new ProjectService({
      registryFile: path.join(tmp, 'workspaces.json'),
      moveAside: async () => undefined,
      scratchPads: () => path.join(tmp, 'scratch')
    })
    service = starting
    starting.setGit(new Promise<GitSetup>((resolve) => (settle = resolve)))
    const shown = watchShown()

    const init = starting.init()
    await expect.poll(() => shown.at(-1)?.collections.length).toBe(1)
    expect(shown.at(-1)?.gitNote).toBeNull()

    // git turns out to be missing: the project says so once it is known.
    settle({ binary: 'git', version: null, bundled: false, note: null })
    await init
    expect(shown.at(-1)?.gitNote).toMatch(/git is not installed/)
  })
})
