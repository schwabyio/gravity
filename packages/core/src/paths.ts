import fs from 'node:fs/promises'
import nodePath from 'node:path'

/**
 * Paths that behave the same on macOS, Linux and Windows.
 *
 * Three rules keep Gravity portable:
 *
 * 1. **Compare with `path.relative`, never with strings.** Windows paths are
 *    case-insensitive and may use either separator; `path.win32.relative`
 *    knows that, `startsWith` does not.
 * 2. **Store canonical paths.** A folder reached through a symlink, a junction or
 *    a substituted drive is resolved once, when it is added, so every later
 *    comparison is between like and like.
 * 3. **Write `/`.** Anything shown to a person or written into a file — a
 *    collection's place in its project, a `uses:` link — uses forward slashes, so
 *    a file committed on one platform reads the same on another. Native
 *    separators are for talking to the filesystem only.
 *
 * Each helper takes the `path` flavour as an optional last argument so the
 * Windows behaviour is tested on every platform.
 */

type PathModule = typeof nodePath.posix

/** Resolve through symlinks; a path that does not exist yet is just resolved. */
export async function canonical(target: string): Promise<string> {
  const absolute = nodePath.resolve(target)
  try {
    return await fs.realpath(absolute)
  } catch {
    return absolute
  }
}

/** True when `child` is `parent` or beneath it — case-insensitively on Windows. */
export function isInside(parent: string, child: string, path: PathModule = nodePath): boolean {
  const relative = path.relative(parent, child)
  // `..data/x` is inside: only a whole `..` part leaves the parent.
  const leaves = relative === '..' || relative.startsWith(`..${path.sep}`)
  return relative === '' || (!leaves && !path.isAbsolute(relative))
}

/** The same place, however it is spelled. */
export const samePath = (a: string, b: string, path: PathModule = nodePath): boolean =>
  path.relative(a, b) === ''

/** A relative path with `/` separators, for display and for files. */
export const toPosix = (relative: string): string => relative.split(/[\\/]+/).join('/')

/** Absolute on any platform: `/x`, `\x`, `C:\x`, `C:/x`, `\\server\share`. */
export const isAbsoluteAnywhere = (target: string): boolean =>
  nodePath.posix.isAbsolute(target) || nodePath.win32.isAbsolute(target)

/**
 * Resolve a relative path written in a file — with `/` or `\` — from `root`.
 * An absolute path is refused: it would only ever work on one machine.
 */
export function resolveRelative(root: string, relative: string, path: PathModule = nodePath) {
  if (isAbsoluteAnywhere(relative)) {
    throw new Error(`"${relative}" must be a relative path, so it works on every machine`)
  }
  return path.resolve(root, ...relative.split(/[\\/]+/).filter(Boolean))
}

/** A relative path from `from` to `to`, written with `/`. */
export const relativePosix = (from: string, to: string, path: PathModule = nodePath): string =>
  toPosix(path.relative(from, to)) || '.'

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// Control characters are exactly what this refuses.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/

/**
 * Why a file or directory name would not work everywhere, or null when it is
 * fine. Windows refuses these characters and names outright, so a name made on
 * a Mac could not even be checked out there.
 */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'A name is needed'
  if (FORBIDDEN.test(name)) return 'A name cannot contain < > : " / \\ | ? * or control characters'
  if (/[. ]$/.test(name)) return 'A name cannot end with a dot or a space'
  if (RESERVED.test(name)) return `"${name}" is reserved on Windows`
  return null
}

/**
 * `relative`, beneath `base`, spelled the way it is on disk — or null when
 * nothing there matches it, even ignoring case. Each part is looked up
 * exactly first, so on a disk holding both `Auth/` and `auth/` the one written
 * wins.
 */
export async function spellingOnDisk(base: string, relative: string): Promise<string | null> {
  const parts = relative.split(/[\\/]+/).filter(Boolean)
  const spelled: string[] = []
  let directory = base
  for (const part of parts) {
    if (part === '.' || part === '..') {
      spelled.push(part)
      directory = nodePath.join(directory, part)
      continue
    }
    let names: string[]
    try {
      names = await fs.readdir(directory)
    } catch {
      return null
    }
    const folded = foldName(part)
    const found = names.includes(part) ? part : names.find((name) => foldName(name) === folded)
    if (found === undefined) return null
    spelled.push(found)
    directory = nodePath.join(directory, found)
  }
  return spelled.join('/')
}

/**
 * A name as macOS compares it: ignoring case, and how an accented letter is
 * encoded. Windows ignores case too. Two names that fold alike cannot both be
 * in one folder there.
 */
export const foldName = (name: string): string => name.normalize('NFC').toLowerCase()

/**
 * Why `relative`, a path written in a file, would not be found on Linux
 * although this disk finds it: a name on disk differs in case, or in how an
 * accented letter is encoded. macOS and Windows find `Auth/login.yml` as
 * `auth/login.yml`; Linux compares names exactly, so the same project would
 * fail in CI. Null when it is spelled as on disk, or is not there at all —
 * the caller reports a missing file its own way.
 */
export async function spellingProblem(base: string, relative: string): Promise<string | null> {
  const written = relative
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  const onDisk = await spellingOnDisk(base, written)
  if (onDisk === null || onDisk === written) return null
  const how =
    onDisk.normalize('NFC') === written.normalize('NFC')
      ? 'with its accented letters encoded differently'
      : 'in a different case'
  return `${written} is spelled ${how} on disk, as ${onDisk}: names must match exactly, as they do on Linux (SPEC.md §1.2)`
}

/**
 * `rename`, retried briefly: on Windows a virus scanner, the search indexer or an
 * editor can hold a file for a moment, and the rename fails with EPERM or EBUSY.
 */
export async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt >= attempts) throw cause
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}
