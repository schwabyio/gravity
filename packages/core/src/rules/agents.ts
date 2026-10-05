import fs from 'node:fs/promises'
import path from 'node:path'
import { renameWithRetry } from '../paths.js'
import { AGENTS_SECTION, AGENTS_SECTION_START } from './model.js'

/**
 * A section of a project's `AGENTS.md` that points coding agents at its rules
 * (SPEC.md §1.4): `gta rules` before writing a test, `gta lint` after. Gravity
 * offers to add it, as it offers a `.gitattributes`; nothing is written until
 * asked. It sits in the project's folder, so it applies to the files there.
 */
export const AGENTS_FILE = 'AGENTS.md'

export interface AgentsState {
  /** The project's `AGENTS.md` exists. */
  exists: boolean
  /** It has the section. */
  hasSection: boolean
}

async function readAgents(root: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, AGENTS_FILE), 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

/** Whether the project at `root` has an `AGENTS.md`, and the section in it. */
export async function agentsState(root: string): Promise<AgentsState> {
  const text = await readAgents(root)
  return { exists: text !== null, hasSection: text?.includes(AGENTS_SECTION_START) ?? false }
}

/**
 * Add the section to the end of the project's `AGENTS.md`, making the file if
 * there is none. Once is enough: a file that has it is left alone. Written in
 * the file's own line endings, and atomically, so a watcher never sees half.
 */
export async function addAgentsSection(root: string): Promise<AgentsState> {
  const file = path.join(root, AGENTS_FILE)
  const text = await readAgents(root)
  if (text?.includes(AGENTS_SECTION_START)) return { exists: true, hasSection: true }

  const newline = text?.includes('\r\n') ? '\r\n' : '\n'
  const section = AGENTS_SECTION.replace(/\n/g, newline)
  const before = text === null || text.trim() === '' ? '' : text.replace(/\s*$/, '')
  const next = before === '' ? section : `${before}${newline}${newline}${section}`

  const temporary = path.join(root, `.${AGENTS_FILE}.${process.pid}.tmp`)
  await fs.writeFile(temporary, next)
  try {
    await renameWithRetry(temporary, file)
  } catch (cause) {
    await fs.rm(temporary, { force: true })
    throw cause
  }
  return { exists: true, hasSection: true }
}
