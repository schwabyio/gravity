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

/** Once what has changed has been told and rescanned for, forget those rescans. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
  rescans = []
}

describe('watching a project', () => {
  it('still rescans for a change noted before what is watched is replaced', async () => {
    watcher.watch('shop', [tmp])
    noteChange('shop')
    // A rescan showing its view watches again before the change's rescan is due.
    watcher.watch('shop', [tmp])
    await expect.poll(() => rescans).toEqual(['shop'])
  })

  it('still rescans for a change not yet told when what is watched is watched again', async () => {
    watcher.watch('shop', [{ path: tmp, recursive: false }])
    await fs.writeFile(path.join(tmp, 'rules.yml'), 'ids: {}\n')
    // Busy, as main is while a rescan shows its view: the change waits to be told.
    const until = Date.now() + 50
    while (Date.now() < until);
    watcher.watch('shop', [{ path: tmp, recursive: false }])
    await expect.poll(() => rescans).toEqual(['shop'])
  })

  it('watches a folder made again in place of one deleted', async () => {
    const bases = path.join(tmp, 'bases')
    await fs.mkdir(bases)
    watcher.watch('shop', [bases])
    await fs.rm(bases, { recursive: true })
    await fs.mkdir(bases)
    await settle()
    watcher.watch('shop', [bases])
    await fs.writeFile(path.join(bases, 'authed.yml'), 'id: authed\n')
    await expect.poll(() => rescans).toEqual(['shop'])
  })

  it('watches a folder made inside one watched in depth, without watching again', async () => {
    const collections = path.join(tmp, 'collections')
    await fs.mkdir(collections)
    watcher.watch('shop', [collections])
    await fs.mkdir(path.join(collections, 'payments'))
    await settle()
    await fs.writeFile(path.join(collections, 'payments', 'refund.yml'), 'id: refund\n')
    await expect.poll(() => rescans).toEqual(['shop'])
  })

  it('watches a folder once it is there', async () => {
    const checks = path.join(tmp, 'checks')
    watcher.watch('shop', [checks])
    await fs.mkdir(checks)
    watcher.watch('shop', [checks])
    await fs.writeFile(path.join(checks, 'orders.js'), 'export function counted() {}\n')
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
