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

export class DirectoryWatcher {
  private readonly watchers = new Map<string, FSWatcher[]>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly onChange: (key: string) => void,
    private readonly debounceMs = 200
  ) {}

  /**
   * Watch a set of directories under one key. Re-calling with the same key
   * replaces what is watched, which is how a rescan picks up new collections.
   * A rescan already due still happens: the change behind it may have come
   * after the rescan now replacing the watch read the files.
   */
  watch(key: string, targets: Array<string | WatchTarget>): void {
    this.close(key)

    const created: FSWatcher[] = []
    for (const target of targets) {
      const { path, recursive } =
        typeof target === 'string' ? { path: target, recursive: true } : target
      try {
        const watcher = fs.watch(path, { recursive, persistent: false }, () => this.schedule(key))
        // A watched directory being deleted surfaces here rather than crashing.
        watcher.on('error', () => this.schedule(key))
        created.push(watcher)
      } catch {
        // Unreadable or missing directory: skip it, keep the others.
      }
    }
    this.watchers.set(key, created)
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
    for (const watcher of this.watchers.get(key) ?? []) watcher.close()
    this.watchers.delete(key)
  }

  dispose(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key)
  }
}
