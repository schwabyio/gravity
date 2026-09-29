import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitRepo } from '../git/repo.js'
import { resetGitRuntime } from '../git/runGit.js'
import { commitAll, git, isolateGit, tempDir, write } from '../git/testing.js'
import {
  addLfAttributes,
  appendLfBlock,
  convertToLf,
  FILES_LINES,
  isGtaPath,
  LF_BLOCK,
  LF_MARKER,
  lineEndingState
} from './lineEndings.js'

let tmp: string

beforeEach(async () => {
  tmp = await tempDir('gravity-eol-')
  await isolateGit(tmp)
})

afterEach(async () => {
  resetGitRuntime()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 })
})

/** A monorepo with one service as a project, holding source code as well as gta files. */
async function monorepo() {
  const root = path.join(tmp, 'platform')
  const project = path.join(root, 'services', 'api')
  await write(path.join(project, 'collections', 'smoke.yml'), 'id: smoke\r\nsteps: []\r\n')
  await write(path.join(project, 'src', 'main.ts'), 'export {}\r\n')
  await git(tmp, 'init', '--quiet', root)
  await commitAll(root, 'first')
  return { root, project, repo: (await GitRepo.open(project))! }
}

describe('the gta paths', () => {
  it('are the project’s own files and directories, and nothing else', () => {
    expect(isGtaPath('collections/smoke.yml')).toBe(true)
    expect(isGtaPath('collections/checkout/sessions.csv')).toBe(true)
    expect(isGtaPath('project.yml')).toBe(true)
    expect(isGtaPath('.gitattributes')).toBe(true)
    expect(isGtaPath('src/main.ts')).toBe(false)
    expect(isGtaPath('collections')).toBe(false)
    expect(isGtaPath('src/settings.yml')).toBe(false)
  })
})

describe('appendLfBlock', () => {
  it('adds the block below what is there, once', () => {
    expect(appendLfBlock('')).toBe(LF_BLOCK)
    const mine = '*.png binary'
    const added = appendLfBlock(mine)
    expect(added).toBe(`*.png binary\n\n${LF_BLOCK}`)
    expect(appendLfBlock(added)).toBe(added)
  })

  it('keeps upload files exactly as committed', () => {
    expect(LF_BLOCK).toContain('\n/files/** -text\n')
  })

  it('writes in the file’s own line endings', () => {
    const added = appendLfBlock('*.png binary\r\n')
    expect(added).toBe(`*.png binary\r\n\r\n${LF_BLOCK.replace(/\n/g, '\r\n')}`)
    expect(added.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('adds the upload lines to a block added before they were part of it', () => {
    const older = LF_BLOCK.replace(`${FILES_LINES.join('\n')}\n`, '')
    expect(appendLfBlock(older)).toBe(LF_BLOCK)
  })
})

describe('line endings in a repository', () => {
  it('reports a project not covered, with the files stored CRLF', async () => {
    const { repo, project } = await monorepo()
    expect(await lineEndingState(repo, project)).toEqual({
      covered: false,
      hasBlock: false,
      crlfFiles: ['services/api/collections/smoke.yml']
    })
  })

  it('is covered once the block is added, and the source code is left alone', async () => {
    const { root, repo, project } = await monorepo()
    await write(path.join(project, '.gitattributes'), '*.png binary\n')
    await addLfAttributes(project)
    await addLfAttributes(project)
    const text = await fs.readFile(path.join(project, '.gitattributes'), 'utf8')
    expect(text.startsWith('*.png binary\n\n')).toBe(true)
    expect(text.split(LF_MARKER)).toHaveLength(2)

    const state = await lineEndingState(repo, project)
    expect(state).toMatchObject({ covered: true, hasBlock: true })
    const attributes = await repo.attributes(['services/api/src/main.ts'], ['eol'])
    expect(attributes.get('services/api/src/main.ts')).toEqual({ eol: 'unspecified' })

    // Converted, the CRLF file shows as changed, and commits LF.
    expect(await convertToLf(repo, state.crlfFiles)).toEqual(['services/api/collections/smoke.yml'])
    const changed = (await repo.status()).files.map((file) => file.path).sort()
    expect(changed).toEqual(['services/api/.gitattributes', 'services/api/collections/smoke.yml'])
    await repo.commit(changed, 'LF')
    expect((await lineEndingState(repo, project)).crlfFiles).toEqual([])
    expect((await repo.status()).files).toEqual([])
    expect(await git(root, 'show', 'HEAD:services/api/src/main.ts')).toBe('export {}\r\n')
  })

  it('is not covered by a block that leaves upload files to git', async () => {
    const { repo, project } = await monorepo()
    const older = LF_BLOCK.replace(`${FILES_LINES.join('\n')}\n`, '')
    await write(path.join(project, '.gitattributes'), older)
    expect(await lineEndingState(repo, project)).toMatchObject({ covered: false, hasBlock: true })
    await addLfAttributes(project)
    expect(await lineEndingState(repo, project)).toMatchObject({ covered: true, hasBlock: true })
  })

  it('counts a repository-wide rule as covering the project', async () => {
    const { root, repo, project } = await monorepo()
    await write(path.join(root, '.gitattributes'), '* text=auto eol=lf\n')
    expect((await lineEndingState(repo, project)).covered).toBe(true)
  })
})
