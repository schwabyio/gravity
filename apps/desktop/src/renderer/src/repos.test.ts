import { describe, expect, it } from 'vitest'
import type { GitStatusView } from '@shared/ipc.js'
import { currentRepo, repositories, sidebarEntries, type RepoProject } from './repos.js'

const status = (branch: string, read = 1) => ({ branch, read }) as GitStatusView

const project = (id: string, repoRoot: string | null, more: Partial<RepoProject> = {}) => ({
  id,
  repoRoot,
  git: repoRoot ? status('main') : null,
  gitNote: null,
  busy: false,
  ...more
})

const shop = project('shop', '/work/shop')
const orders = project('orders', '/work/platform')
const scratch = project('scratch', null)
const users = project('users', '/work/platform')
const shared = project('shared', '/work/platform')

describe('repositories', () => {
  it('lists each repository once, in the order its first project is listed', () => {
    const repos = repositories([shop, orders, scratch, users])
    expect(repos.map((repo) => repo.name)).toEqual(['shop', 'platform'])
    expect(repos[1]!.projects.map((p) => p.id)).toEqual(['orders', 'users'])
    expect(repos[1]!.git?.branch).toBe('main')
  })

  it('leaves out scratch pads and projects outside git', () => {
    expect(repositories([scratch])).toEqual([])
  })

  it('takes a Windows root, and its folder name, with either slash', () => {
    const repos = repositories([
      project('a', 'C:\\work\\platform'),
      project('b', 'C:/work/platform/')
    ])
    expect(repos).toHaveLength(1)
    expect(repos[0]!.name).toBe('platform')
  })

  it('is busy while any of its projects says so, and takes git from one that has it', () => {
    const [repo] = repositories([
      project('a', '/work/platform', { git: null, gitNote: 'git did not answer' }),
      project('b', '/work/platform', { busy: true })
    ])
    expect(repo!.busy).toBe(true)
    expect(repo!.git?.branch).toBe('main')
  })

  it('says what the latest read of any of its projects found', () => {
    const [repo] = repositories([
      project('a', '/work/platform', { git: status('main', 3) }),
      project('b', '/work/platform', { git: status('feature', 7) }),
      project('c', '/work/platform', { git: status('old', 5) })
    ])
    expect(repo!.git?.branch).toBe('feature')
  })
})

describe('sidebarEntries', () => {
  it('puts the projects of a shared repository under it, where the first one was', () => {
    const entries = sidebarEntries([shop, orders, scratch, users, shared])
    expect(
      entries.map((entry) =>
        entry.kind === 'project'
          ? entry.project.id
          : `${entry.repo.name}: ${entry.repo.projects.map((p) => p.id).join(', ')}`
      )
    ).toEqual(['shop', 'platform: orders, users, shared', 'scratch'])
  })

  it('leaves a repository with one project in the workspace as that project', () => {
    expect(sidebarEntries([shop, orders])).toEqual([
      { kind: 'project', project: shop },
      { kind: 'project', project: orders }
    ])
  })
})

describe('currentRepo', () => {
  const repos = repositories([shop, orders, users])

  it('names the open collection’s repository', () => {
    expect(currentRepo(repos, users)?.name).toBe('platform')
    expect(currentRepo(repos, shop)?.name).toBe('shop')
  })

  it('with none open, or one outside git, names the only repository, or none of several', () => {
    expect(currentRepo(repos, null)).toBeNull()
    expect(currentRepo(repos, scratch)).toBeNull()
    const one = repositories([shop, scratch])
    expect(currentRepo(one, null)?.name).toBe('shop')
    expect(currentRepo(one, scratch)?.name).toBe('shop')
    expect(currentRepo([], null)).toBeNull()
  })
})
