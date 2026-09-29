import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BASES_DIR,
  CHECKS_DIR,
  COLLECTIONS_DIR,
  ENDPOINTS_DIR,
  ENVIRONMENTS_DIR,
  PROJECT_FILE,
  REQUESTS_DIR,
  SETTINGS_FILE
} from '../format/constants.js'
import type { GitRepo } from '../git/repo.js'
import { toLf } from '../model/text.js'
import { relativePosix } from '../paths.js'
import { writeIfUnchanged } from './writeFile.js'

/**
 * Keeping a project's files LF in git (SPEC.md §1.2).
 *
 * The tools write LF, but git on Windows checks files out CRLF unless the
 * repository says otherwise, and a colleague's editor may commit them that way.
 * A `.gitattributes` in the project folder settles it for every clone. It is
 * scoped to gta's own files: a project can be a service's folder, holding source
 * code whose line endings are not ours to decide.
 */

/** Directories gta owns in a project. */
export const GTA_DIRECTORIES = [
  COLLECTIONS_DIR,
  ENVIRONMENTS_DIR,
  REQUESTS_DIR,
  ENDPOINTS_DIR,
  BASES_DIR,
  CHECKS_DIR
]

/** Files gta owns at a project's root. */
export const GTA_FILES = [PROJECT_FILE, SETTINGS_FILE]

export const ATTRIBUTES_FILE = '.gitattributes'

/** The first line of the block the app adds; how it knows the block is there. */
export const LF_MARKER =
  '# Gravity Test Automation: store these files with LF line endings on every platform.'

/** Anchored to the project folder: a `settings.yml` deeper in a service is not ours. */
export const LF_PATTERNS = [
  ...GTA_FILES.map((file) => `/${file}`),
  ...GTA_DIRECTORIES.map((directory) => `/${directory}/**`)
]

/**
 * Files a body uploads (SPEC.md §2.2), by convention in `files/`. They are sent
 * byte for byte, so git keeps them exactly as committed: converted to CRLF on
 * a Windows checkout, a JSON file would send different bytes than on macOS.
 */
export const FILES_DIR = 'files'
export const FILES_LINES = [
  '# Files a request uploads are sent byte for byte: keep them exactly as committed.',
  `/${FILES_DIR}/** -text`
]

export const LF_BLOCK = `${[
  LF_MARKER,
  ...LF_PATTERNS.map((pattern) => `${pattern} text=auto eol=lf`),
  ...FILES_LINES
].join('\n')}\n`

/** True for one of gta's own files, given its path from the project folder (with `/`). */
export function isGtaPath(fromProject: string): boolean {
  if (GTA_FILES.includes(fromProject) || fromProject === ATTRIBUTES_FILE) return true
  const [first, ...rest] = fromProject.split('/')
  return rest.length > 0 && GTA_DIRECTORIES.includes(first ?? '')
}

/**
 * A `.gitattributes` with the block added below what it already says, in the
 * file's own line endings. A block added before upload files were covered
 * gets their lines.
 */
export function appendLfBlock(source: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = (text: string) => text.replace(/\n/g, eol)
  const ended = source.endsWith('\n') ? source : `${source}${eol}`
  if (source.includes(LF_MARKER)) {
    return source.includes(FILES_LINES[1]!)
      ? source
      : `${ended}${lines(`${FILES_LINES.join('\n')}\n`)}`
  }
  if (source.trim() === '') return LF_BLOCK
  return `${ended}${eol}${lines(LF_BLOCK)}`
}

export interface LineEndingState {
  /** True when git stores and checks out every gta file in the project with LF. */
  covered: boolean
  /** True when the project's `.gitattributes` has the block the app adds. */
  hasBlock: boolean
  /** gta files git has stored with CRLF, repo-relative with `/`. */
  crlfFiles: string[]
}

export async function lineEndingState(
  repo: GitRepo,
  projectRoot: string
): Promise<LineEndingState> {
  const prefix = relativePosix(repo.root, projectRoot)
  const inRepo = (file: string) => (prefix === '.' ? file : `${prefix}/${file}`)

  // Paths that need not exist: git answers for where a file would be.
  const samples = [
    ...GTA_FILES,
    ...GTA_DIRECTORIES.map((directory) => `${directory}/gravity-sample.yml`),
    `${COLLECTIONS_DIR}/gravity-sample.csv`,
    `${CHECKS_DIR}/gravity-sample.js`
  ].map(inRepo)
  const upload = inRepo(`${FILES_DIR}/gravity-sample.json`)
  const attributes = await repo.attributes([...samples, upload], ['text', 'eol'])
  // An upload file is the same everywhere kept as committed, or checked out LF.
  const uploads = attributes.get(upload)
  const covered =
    samples.every((sample) => {
      const values = attributes.get(sample)
      return values?.['eol'] === 'lf' && values['text'] !== 'unset'
    }) &&
    (uploads?.['text'] === 'unset' || uploads?.['eol'] === 'lf')

  const existing = await fs
    .readFile(path.join(projectRoot, ATTRIBUTES_FILE), 'utf8')
    .catch(() => '')
  const stored = await repo.storedLineEndings([...GTA_FILES, ...GTA_DIRECTORIES].map(inRepo))
  return {
    covered,
    hasBlock: existing.includes(LF_MARKER),
    crlfFiles: stored
      .filter((file) => file.index === 'crlf' || file.index === 'mixed')
      .map((file) => file.path)
  }
}

/** Add the block to the project's `.gitattributes`, creating it if need be. */
export async function addLfAttributes(projectRoot: string): Promise<string> {
  const file = path.join(projectRoot, ATTRIBUTES_FILE)
  try {
    await fs.writeFile(file, LF_BLOCK, { flag: 'wx' })
    return file
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  const source = await fs.readFile(file, 'utf8')
  const outcome = await writeIfUnchanged(file, source, appendLfBlock)
  if (!outcome.ok)
    throw new Error(`${ATTRIBUTES_FILE} changed while it was being written: try again`)
  return file
}

/**
 * Rewrite files git stored with CRLF as LF, so they show as changed and the
 * next commit stores them LF.
 *
 * git leaves a file committed with CRLF alone under `text=auto` — that is what
 * keeps a new `.gitattributes` from marking half a repository changed — so each
 * one is rewritten here. One already LF on disk is touched, which is enough for
 * git to look at it again.
 */
export async function convertToLf(repo: GitRepo, repoPaths: string[]): Promise<string[]> {
  const converted: string[] = []
  for (const repoPath of repoPaths) {
    const file = repo.absolute(repoPath)
    const content = await fs.readFile(file).catch(() => null)
    // Gone from disk, or binary: nothing to convert.
    if (!content || content.subarray(0, 8000).includes(0)) continue
    const source = content.toString('utf8')
    if (source.includes('\r\n')) {
      const outcome = await writeIfUnchanged(file, source, toLf)
      if (!outcome.ok) continue
    } else {
      const now = new Date()
      await fs.utimes(file, now, now)
    }
    converted.push(repoPath)
  }
  return converted
}
