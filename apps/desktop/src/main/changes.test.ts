import path from 'node:path'
import type { GitFileChange } from '@schwabyio/gravity-core'
import { describe, expect, it } from 'vitest'
import { classifyChanges, isSecretFile } from './changes.js'

const repo = path.resolve('/repos/platform')
const at = (...segments: string[]) => path.join(repo, ...segments)

const change = (file: string, over: Partial<GitFileChange> = {}): GitFileChange => ({
  path: file,
  origPath: null,
  x: '.',
  y: 'M',
  kind: 'modified',
  staged: false,
  submodule: false,
  ...over
})

describe('classifyChanges', () => {
  const roots = [
    { id: 'api', path: at('services', 'api') },
    { id: 'shared', path: at('shared') }
  ]

  it('checks gta’s own files in a project, and nothing else', () => {
    const { files, truncated } = classifyChanges(
      repo,
      [
        change('services/api/collections/smoke.yml'),
        change('services/api/project.yml'),
        change('services/api/src/main.ts'),
        change('shared/environments/demo.yml'),
        change('README.md')
      ],
      roots
    )
    expect(truncated).toBe(false)
    expect(files.map((file) => [file.path, file.projectId, file.checkedByDefault])).toEqual([
      ['services/api/collections/smoke.yml', 'api', true],
      ['services/api/project.yml', 'api', true],
      ['services/api/src/main.ts', 'api', false],
      ['shared/environments/demo.yml', 'shared', true],
      ['README.md', null, false]
    ])
  })

  it('never checks a secret, a conflict or a submodule', () => {
    const { files } = classifyChanges(
      repo,
      [
        change('services/api/collections/.env', { kind: 'untracked' }),
        change('services/api/collections/a.yml', { kind: 'conflicted' }),
        change('services/api/collections/lib', { submodule: true })
      ],
      roots
    )
    expect(files.map((file) => file.checkedByDefault)).toEqual([false, false, false])
    expect(files[0]?.secret).toBe(true)
  })

  it('gives a nested project its own files', () => {
    const { files } = classifyChanges(
      repo,
      [change('services/api/collections/a.yml')],
      [
        { id: 'outer', path: at('services') },
        { id: 'inner', path: at('services', 'api') }
      ]
    )
    expect(files[0]?.projectId).toBe('inner')
  })
})

describe('isSecretFile', () => {
  it('knows .env files, but not their templates', () => {
    expect(isSecretFile('.env')).toBe(true)
    expect(isSecretFile('.env.local')).toBe(true)
    expect(isSecretFile('.env.example')).toBe(false)
    expect(isSecretFile('env.yml')).toBe(false)
  })
})
