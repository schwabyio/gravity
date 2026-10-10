import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readEnvironments, readProject } from './project.js'
import {
  observeReadRetries,
  readFolder,
  readText,
  UnreadableError,
  type ReadRetry
} from './readFolder.js'

/** An error as Node gives one: its code, then what it means, then the call. */
const failure = (code: string, meaning: string) =>
  Object.assign(new Error(`${code}: ${meaning}, scandir 'C:\\repo\\environments'`), { code })
const busy = () => failure('EBUSY', 'resource busy or locked')

let tmp: string
let retries: ReadRetry[]

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-read-'))
  await fs.mkdir(path.join(tmp, 'environments'))
  await fs.writeFile(path.join(tmp, 'environments', 'dev.yml'), 'name: development\nvars: {}\n')
  retries = []
  observeReadRetries((retry) => retries.push(retry))
  // The waits between tries, run at once.
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  observeReadRetries(null)
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Run `work` to its end, the waits between its tries passing as they come, its reads as they will. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false
  const outcome = work
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    .finally(() => (done = true))
  while (!done) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((resolve) => setImmediate(resolve))
  }
  const result = await outcome
  if ('error' in result) throw result.error
  return result.value
}

describe('readFolder', () => {
  it('finds a folder that is not there empty', async () => {
    expect(await readFolder(path.join(tmp, 'nope'))).toEqual([])
    expect(retries).toEqual([])
  })

  it('reads a folder held for a moment on a later try, and says it was tried again', async () => {
    const readdir = vi.spyOn(fs, 'readdir')
    readdir.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy())
    const entries = await settled(readFolder(path.join(tmp, 'environments')))
    expect(entries.map((entry) => entry.name)).toEqual(['dev.yml'])
    expect(readdir).toHaveBeenCalledTimes(3)
    expect(retries).toEqual([
      { path: path.join(tmp, 'environments'), code: 'EBUSY', tries: 3, read: true }
    ])
  })

  it('makes a folder held for good an UnreadableError, never an empty folder', async () => {
    const readdir = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValue(failure('EPERM', 'operation not permitted'))
    const reading = settled(readFolder(path.join(tmp, 'environments')))
    await expect(reading).rejects.toBeInstanceOf(UnreadableError)
    await expect(reading).rejects.toMatchObject({
      code: 'EPERM',
      reason: 'EPERM: operation not permitted'
    })
    expect(readdir).toHaveBeenCalledTimes(4)
    expect(retries).toEqual([
      { path: path.join(tmp, 'environments'), code: 'EPERM', tries: 4, read: false }
    ])
  })

  it('does not wait on an error no wait would mend', async () => {
    const readdir = vi
      .spyOn(fs, 'readdir')
      .mockRejectedValue(failure('ELOOP', 'too many symbolic links encountered'))
    await expect(settled(readFolder(tmp))).rejects.toBeInstanceOf(UnreadableError)
    expect(readdir).toHaveBeenCalledTimes(1)
    expect(retries).toEqual([])
  })
})

describe('readText', () => {
  it('fails on a file that is not there as it always did', async () => {
    await expect(readText(path.join(tmp, 'nope.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads a file held for a moment on a later try', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(busy())
    const text = await settled(readText(path.join(tmp, 'environments', 'dev.yml')))
    expect(text).toContain('name: development')
    expect(retries).toMatchObject([{ code: 'EBUSY', tries: 2, read: true }])
  })
})

describe('what a project holds, held by another program', () => {
  it('lists an environment held for a moment under its own name', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(busy())
    const listed = await settled(readEnvironments(path.join(tmp, 'environments')))
    expect(listed.map((environment) => environment.name)).toEqual(['development'])
  })

  it('does not list one held for good under a name it may not have', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(busy())
    await expect(settled(readEnvironments(path.join(tmp, 'environments')))).rejects.toThrow(
      /Could not read .*dev\.yml \(EBUSY: resource busy or locked\)/
    )
  })

  it('says project.yml could not be read, rather than that there is none', async () => {
    await fs.writeFile(path.join(tmp, 'project.yml'), 'name: Shop\n')
    vi.spyOn(fs, 'readFile').mockRejectedValue(busy())
    const info = await settled(readProject(tmp))
    expect(info.doc).toBeNull()
    expect(info.problems).toEqual([
      { path: 'project.yml', message: 'could not be read (EBUSY: resource busy or locked)' }
    ])
  })
})
