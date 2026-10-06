import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryWatcher } from './watcher.js'

let tmp: string
let watcher: DirectoryWatcher
let rescans: string[]

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-watcher-')))
  rescans = []
  watcher = new DirectoryWatcher((key) => rescans.push(key), 20)
})

afterEach(async () => {
  watcher.dispose()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A change noted for `key`, its rescan due once the debounce runs out. */
const noteChange = (key: string) =>
  (watcher as unknown as { schedule(key: string): void }).schedule(key)

describe('watching a project', () => {
  it('still rescans for a change noted before what is watched is replaced', async () => {
    watcher.watch('shop', [tmp])
    noteChange('shop')
    // A rescan showing its view watches again before the change's rescan is due.
    watcher.watch('shop', [tmp])
    await expect.poll(() => rescans).toEqual(['shop'])
  })

  it('drops a rescan due for a project no longer watched', async () => {
    watcher.watch('shop', [tmp])
    noteChange('shop')
    watcher.unwatch('shop')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rescans).toEqual([])
  })
})
