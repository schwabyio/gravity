import fs, { type FSWatcher } from 'node:fs'

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
 * If recursive watching proves unreliable on Linux, `chokidar` drops in behind
 * this same interface — nothing outside this file knows how watching works.
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
  /** The folder itself, so one deleted and made again in its place is watched anew. */
  folder: string
  /** Its watcher failed, the folder most likely deleted: it is watched anew. */
  failed: boolean
}

export class DirectoryWatcher {
  /** Each key's watchers, by what they watch. */
  private readonly watchers = new Map<string, Map<string, Watching>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly onChange: (key: string) => void,
    private readonly debounceMs = 200
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
   * deleted, is watched from now.
   * A rescan already due still happens: the change behind it may have come
   * after the rescan now watching again read the files.
   */
  watch(key: string, targets: Array<string | WatchTarget>): void {
    const before = this.watchers.get(key) ?? new Map<string, Watching>()
    const after = new Map<string, Watching>()
    for (const target of targets) {
      const { path, recursive } =
        typeof target === 'string' ? { path: target, recursive: true } : target
      const what = `${recursive ? 'all of' : 'in'} ${path}`
      if (after.has(what)) continue
      const folder = folderOf(path)
      // Missing or unreadable: nothing to watch until a rescan finds it there.
      if (folder === null) continue
      const kept = before.get(what)
      if (kept && !kept.failed && kept.folder === folder) {
        after.set(what, kept)
        before.delete(what)
        continue
      }
      try {
        const watching: Watching = {
          watcher: fs.watch(path, { recursive, persistent: false }, () => this.schedule(key)),
          folder,
          failed: false
        }
        // A watched directory being deleted surfaces here rather than crashing.
        watching.watcher.on('error', () => {
          watching.failed = true
          this.schedule(key)
        })
        after.set(what, watching)
      } catch {
        // Unreadable or missing directory: skip it, keep the others.
      }
    }
    // What is no longer listed, or is watched anew, once its replacement watches.
    for (const { watcher } of before.values()) watcher.close()
    this.watchers.set(key, after)
  }

  private schedule(key: string): void {
    clearTimeout(this.timers.get(key))
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        this.onChange(key)
      }, this.debounceMs)
    )
  }

  /** Stop watching under a key, and drop any rescan due for it. */
  unwatch(key: string): void {
    this.close(key)
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
  }

  private close(key: string): void {
    for (const { watcher } of this.watchers.get(key)?.values() ?? []) watcher.close()
    this.watchers.delete(key)
  }

  dispose(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key)
  }
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
