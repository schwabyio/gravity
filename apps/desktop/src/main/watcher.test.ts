import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryWatcher } from './watcher.js'

let tmp: string
let watcher: DirectoryWatcher
let rescans: string[]
/** The paths each rescan was told of, all together. */
let told: string[]
/** What became of the watchers, as the load log would say it. */
let notes: string[]

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-watcher-')))
  rescans = []
  told = []
  notes = []
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

/**
 * Watch, and wait until the watchers are listening: macOS's start a moment after
 * they are asked for, later still under load, and a change made before then is
 * never told. The full unit run missed one now and then.
 */
const startWatching = async (targets: Parameters<DirectoryWatcher['watch']>[1]) => {
  watcher.watch('shop', targets)
  await settle()
}

/** A rescan for the project, however many changes were told. */
const rescanned = () => expect.poll(() => rescans).toContain('shop')

describe.each([
  ['in depth as the platform watches', undefined],
  ['each folder by itself, as on Linux', true]
])('watching a project, %s', (_, eachFolder) => {
  beforeEach(() => {
    watcher = new DirectoryWatcher(
      (key, paths) => {
        rescans.push(key)
        told.push(...paths)
      },
      20,
      eachFolder,
      (key, what, folder) => notes.push(`${key}: ${what} ${folder}`)
    )
  })

  it('says when it stops watching a folder that is gone, for the load log', async () => {
    const bases = path.join(tmp, 'bases')
    await fs.mkdir(bases)
    watcher.watch('shop', [bases])
    await fs.rm(bases, { recursive: true })
    watcher.watch('shop', [bases])
    expect(notes).toContain(`shop: Stopped watching ${bases}`)
  })

  it('names the file it was told of, for the load log', async () => {
    await startWatching([{ path: tmp, recursive: false }])
    await fs.writeFile(path.join(tmp, 'rules.yml'), 'ids: {}\n')
    await rescanned()
    expect(told).toContain(path.join(tmp, 'rules.yml'))
  })

  it('still rescans for a change noted before what is watched is replaced', async () => {
    watcher.watch('shop', [tmp])
    noteChange('shop')
    // A rescan showing its view watches again before the change's rescan is due.
    watcher.watch('shop', [tmp])
    await rescanned()
  })

  it('still rescans for a change not yet told when what is watched is watched again', async () => {
    await startWatching([{ path: tmp, recursive: false }])
    await fs.writeFile(path.join(tmp, 'rules.yml'), 'ids: {}\n')
    // Busy, as main is while a rescan shows its view: the change waits to be told.
    const until = Date.now() + 50
    while (Date.now() < until);
    watcher.watch('shop', [{ path: tmp, recursive: false }])
    await rescanned()
  })

  it('tells of a file written in place after it was saved by renaming another over it', async () => {
    const orders = path.join(tmp, 'collections', 'orders')
    await fs.mkdir(orders, { recursive: true })
    const file = path.join(orders, 'list-orders.yml')
    await fs.writeFile(file, 'id: list-orders\n')
    const targets = [path.join(tmp, 'collections')]
    await startWatching(targets)
    // Saved as the app saves: written beside it, then renamed over it.
    await fs.writeFile(`${file}.tmp`, 'id: list-orders\nsteps: []\n')
    await fs.rename(`${file}.tmp`, file)
    await rescanned()
    watcher.watch('shop', targets)
    await settle()
    await fs.writeFile(file, 'id: list-orders\nsteps: []\ndocs: Written outside the app.\n')
    await rescanned()
  })

  it('watches a folder made inside one watched in depth, once a rescan watches again', async () => {
    const collections = path.join(tmp, 'collections')
    await fs.mkdir(collections)
    await startWatching([collections])
    await fs.mkdir(path.join(collections, 'payments'))
    await rescanned()
    watcher.watch('shop', [collections])
    await settle()
    await fs.writeFile(path.join(collections, 'payments', 'refund.yml'), 'id: refund\n')
    await rescanned()
  })

  it('rescans a folder that is there once watched, for what was written before', async () => {
    const checks = path.join(tmp, 'checks')
    watcher.watch('shop', [checks])
    await fs.mkdir(checks)
    await fs.writeFile(path.join(checks, 'orders.js'), 'export function counted() {}\n')
    watcher.watch('shop', [checks])
    await rescanned()
    await settle()
    await fs.writeFile(path.join(checks, 'orders.js'), 'export function counted() { }\n')
    await rescanned()
  })

  it('watches a folder made again in place of one deleted', async () => {
    const bases = path.join(tmp, 'bases')
    await fs.mkdir(bases)
    watcher.watch('shop', [bases])
    await fs.rm(bases, { recursive: true })
    await fs.mkdir(bases)
    await settle()
    watcher.watch('shop', [bases])
    // Another folder, so what is in it is read again.
    await rescanned()
    await settle()
    await fs.writeFile(path.join(bases, 'authed.yml'), 'id: authed\n')
    await rescanned()
  })

  it('lets go of a folder no longer listed', async () => {
    const [kept, dropped] = [path.join(tmp, 'collections'), path.join(tmp, 'endpoints')]
    await fs.mkdir(kept)
    await fs.mkdir(dropped)
    watcher.watch('shop', [kept, dropped])
    // macOS may yet tell of the folders just made.
    await settle()
    watcher.watch('shop', [kept])
    await fs.writeFile(path.join(dropped, 'users.yml'), 'id: users\n')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rescans).toEqual([])
  })

  it('drops a rescan due for a project no longer watched', async () => {
    watcher.watch('shop', [tmp])
    noteChange('shop')
    watcher.unwatch('shop')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(rescans).toEqual([])
  })
})
