import fs from 'node:fs/promises'
import path from 'node:path'
import {
  applyCollectionEdits,
  applyEnvironmentEdits,
  idOfFile,
  ENVIRONMENTS_DIR,
  parseCollection,
  parseEnvironment,
  projectEnvironments,
  projectRootOf,
  readProject,
  type CollectionEdit,
  type EditOutcome,
  type EnvironmentEdit
} from '@schwabyio/gravity-core'
import type { ReadCollectionResult, ReadEnvironmentResult } from '../shared/ipc.js'

export async function readCollectionFile(file: string): Promise<ReadCollectionResult> {
  const source = await fs.readFile(file, 'utf8')
  const doc = parseCollection(source, path.basename(file)).data
  const root = projectRootOf(file) ?? path.dirname(file)
  const { global } = await readProject(root)
  return {
    doc,
    source,
    environments: await projectEnvironments(root, global),
    environmentsPath: path.join(root, ENVIRONMENTS_DIR),
    name: idOfFile(file)
  }
}

/**
 * Write a batch of edits back to one collection file.
 *
 * The write itself — only against the text the edits were made against, one
 * atomic write, none when nothing changed — is core's `applyCollectionEdits`.
 * What main adds is ordering: one write per file at a time, so an auto save
 * firing while a save is still on its way cannot interleave with it.
 */
export const applyEdits = (
  file: string,
  baseSource: string,
  edits: CollectionEdit[]
): Promise<EditOutcome> => queued(file, () => applyCollectionEdits(file, baseSource, edits))

export async function readEnvironmentFile(file: string): Promise<ReadEnvironmentResult> {
  const source = await fs.readFile(file, 'utf8')
  return { doc: parseEnvironment(source, path.basename(file)).data, source }
}

/** The same, for an environment file. */
export const applyEnvironmentFileEdits = (
  file: string,
  baseSource: string,
  edits: EnvironmentEdit[]
): Promise<EditOutcome> => queued(file, () => applyEnvironmentEdits(file, baseSource, edits))

/** Run one write for a file after any already on its way. */
function queued(file: string, write: () => Promise<EditOutcome>): Promise<EditOutcome> {
  const previous = queues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(write)
  queues.set(file, next)
  // Tidy up either way; the caller handles a failure, this chain must not
  // become a second, unhandled copy of it.
  const forget = () => {
    if (queues.get(file) === next) queues.delete(file)
  }
  next.then(forget, forget)
  return next
}

const queues = new Map<string, Promise<unknown>>()
