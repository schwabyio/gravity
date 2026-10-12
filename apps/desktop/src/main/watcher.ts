import fs, { type FSWatcher } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * Filesystem watching, on `node:fs.watch` with no dependencies.
 *
 * Two deliberate choices:
 *
 * 1. **Only collection roots and the git directory are watched**, never the whole
 *    repository. In a monorepo, unrelated source churn must not wake the app.
 * 2. **The event payload is ignored.** macOS reports paths that are not the file
 *    that changed, and platforms disagree about `rename` versus `change`. Any
 *    event under a watched root simply means "something here moved", which
 *    triggers a debounced rescan. Being payload-independent is what makes a
 *    zero-dependency watcher safe.
 *
 * Node's recursive watching on Linux misses writes to a file saved by renaming,
 * so there each folder is watched itself (`eachFolder`). Should that prove
 * unreliable too, `chokidar` drops in behind this same interface — nothing
 * outside this file knows how watching works.
 */
/**
 * A directory to watch. Not recursive for a folder whose own entries matter but
 * whose depths do not — a project root (for `project.yml`, and a `collections/`
 * appearing), or a `.git` directory (for `HEAD` and `index`).
 */
export interface WatchTarget {
  path: string
  recursive: boolean
}

/** A directory being watched, and which folder it was when watching began. */
interface Watching {
  watcher: FSWatcher
  path: string
  /** The folder itself, so one deleted and made again in its place is watched anew. */
  folder: string
  /** Its watcher failed, the folder most likely deleted: it is watched anew. */
  failed: boolean
}

/** What a key watches: the targets it was last given, and a watcher for each folder. */
interface Watched {
  listed: Set<string>
  folders: Map<string, Watching>
}

/** The most paths kept of what was told before one rescan. */
const MAX_TOLD = 20

/**
 * The longest a rescan waits for changes to stop being told. A watcher that
 * never stops — one Windows keeps telling of its own folder, deleted (below) —
 * must not put the rescan off for good.
 */
const MAX_WAIT_MS = 1000

export class DirectoryWatcher {
  private readonly watched = new Map<string, Watched>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** When each key's first change since its last rescan was told. */
  private readonly since = new Map<string, number>()
  /** What each key's watchers were told of since its last rescan. */
  private readonly told = new Map<string, Set<string>>()

  constructor(
    /**
     * A rescan is due, with the paths the watchers named, for the load log only:
     * they are what the platform says, not always the file that changed (above).
     */
    private readonly onChange: (key: string, told: string[]) => void,
    private readonly debounceMs = 200,
    /**
     * Watch a folder in depth as each folder in it, rather than as Node does. On Linux
     * Node watches each file in it, by inode: a file saved by renaming another over it,
     * as the app and many editors save, is watched no more, and what is written to it
     * after is never told. A folder's own watcher is told of every file in it.
     */
    private readonly eachFolder = process.platform === 'linux',
    /** What became of a folder's watcher, for the load log: failed, let go, opened again. */
    private readonly note: (key: string, what: string, path: string) => void = () => undefined
  ) {}

  /**
   * Watch a set of directories under one key. Re-calling with the same key
   * watches what it lists now, which is how a rescan picks up new collections.
   *
   * A directory watched already is left watched, never closed and opened
   * again: a change not yet told when the call is made would be lost with the
   * watcher closed (on macOS, with any watcher closed), and a rescan calls this
   * as it shows its view, so a change made just then would never be shown. One
   * no longer listed is let go; a new one, or one made again in place of one
   * deleted, is watched from now. Where one of those was listed before, it may
   * have changed since the rescan calling this read it: it is rescanned.
   * A rescan already due still happens: the change behind it may have come
   * after the rescan now watching again read the files.
   */
  watch(key: string, targets: Array<string | WatchTarget>): void {
    const before = this.watched.get(key)
    const now: Watched = { listed: new Set(), folders: new Map() }
    let appeared = false
    for (const target of targets) {
      const { path, recursive } =
        typeof target === 'string' ? { path: target, recursive: true } : target
      const listed = nameOf(path, recursive)
      now.listed.add(listed)
      const each =
        recursive && this.eachFolder
          ? foldersIn(path).map((folder) => ({ path: folder, recursive: false }))
          : [{ path, recursive }]
      for (const one of each) {
        const what = nameOf(one.path, one.recursive)
        if (now.folders.has(what)) continue
        const folder = folderOf(one.path)
        // Missing or unreadable: nothing to watch until a rescan finds it there.
        if (folder === null) continue
        const kept = before?.folders.get(what)
        if (kept && !kept.failed && kept.folder === folder) {
          now.folders.set(what, kept)
          continue
        }
        const opened = this.open(key, one.path, one.recursive, folder)
        if (!opened) continue
        now.folders.set(what, opened)
        if (before?.listed.has(listed)) appeared = true
      }
    }
    // What is no longer listed, or is watched anew, once its replacement watches.
    for (const [what, watching] of before?.folders ?? []) {
      if (now.folders.get(what) === watching) continue
      watching.watcher.close()
      this.note(key, now.folders.has(what) ? 'Watching again' : 'Stopped watching', watching.path)
    }
    this.watched.set(key, now)
    if (appeared) this.schedule(key)
  }

  private open(key: string, path: string, recursive: boolean, folder: string): Watching | null {
    try {
      const watching: Watching = {
        watcher: fs.watch(path, { recursive, persistent: false }, (_event, name) => {
          if (watching.failed) return
          // On Windows a folder deleted for good while watched is told of as itself, by its
          // full path, over and over for as long as it is watched (libuv before 1.53,
          // nodejs/node#61398). Let go of, its handle no longer keeps it, and it is rescanned.
          if (name && isAbsolute(name)) {
            watching.failed = true
            watching.watcher.close()
            this.note(key, 'Deleted while watched:', path)
            this.schedule(key, path)
            return
          }
          this.schedule(key, name ? join(path, name) : path)
        }),
        path,
        folder,
        failed: false
      }
      // A watched directory being deleted surfaces here rather than crashing.
      watching.watcher.on('error', (cause: NodeJS.ErrnoException) => {
        watching.failed = true
        this.note(key, `Watcher failed (${cause.code ?? cause.message})`, path)
        this.schedule(key, path)
      })
      return watching
    } catch (cause) {
      // Unreadable or missing directory: skip it, keep the others.
      this.note(key, `Could not watch (${(cause as NodeJS.ErrnoException).code ?? cause})`, path)
      return null
    }
  }

  private schedule(key: string, path?: string): void {
    if (path !== undefined) {
      const told = this.told.get(key) ?? new Set<string>()
      if (told.size < MAX_TOLD) told.add(path)
      this.told.set(key, told)
    }
    const now = Date.now()
    const since = this.since.get(key) ?? now
    this.since.set(key, since)
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(
        () => {
          this.timers.delete(key)
          this.since.delete(key)
          const told = [...(this.told.get(key) ?? [])]
          this.told.delete(key)
          this.onChange(key, told)
        },
        Math.max(0, Math.min(this.debounceMs, since + MAX_WAIT_MS - now))
      )
    )
  }

  /** Stop watching under a key, and drop any rescan due for it. */
  unwatch(key: string): void {
    this.close(key)
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.since.delete(key)
    this.told.delete(key)
  }

  private close(key: string): void {
    for (const { watcher } of this.watched.get(key)?.folders.values() ?? []) watcher.close()
    this.watched.delete(key)
  }

  dispose(): void {
    for (const key of [...this.watched.keys()]) this.unwatch(key)
  }
}

const nameOf = (path: string, recursive: boolean) => `${recursive ? 'all of' : 'in'} ${path}`

/** A folder and every folder in it, at any depth. */
function foldersIn(root: string): string[] {
  const found = [root]
  for (let i = 0; i < found.length; i++) {
    const folder = found[i]!
    try {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) found.push(join(folder, entry.name))
      }
    } catch {
      // Not there, or not readable: its watcher, if any, says so.
    }
  }
  return found
}

/**
 * Which folder is at a path, or null when none can be found there. Made again
 * in place of one deleted, it is another: on Linux the old watcher sees nothing
 * of the new one, and its inode number may be reused, but not with its birth time.
 */
function folderOf(path: string): string | null {
  try {
    const stat = fs.statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
  } catch {
    return null
  }
}
