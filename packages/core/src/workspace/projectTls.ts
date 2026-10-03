import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_FILE } from '../format/constants.js'
import { readCertificates, summarizeCertificate, type CertificateSummary } from '../http/trust.js'
import type { ProjectDoc } from '../model/documents.js'
import type { LoadProblem } from '../model/tree.js'
import { relativePosix, resolveRelative, spellingProblem, toPosix } from '../paths.js'
import type { ProjectInfo } from './project.js'

/** One file listed in `tls.ca` (SPEC.md §1.1). */
export interface CaFile {
  /** As written in `tls.ca`, with `/`. */
  path: string
  /** Whose `project.yml` lists it. */
  source: 'project' | 'global'
  /** Absolute. */
  file: string
  /** What it holds, so a person can tell it is the CA they meant. */
  certificates: CertificateSummary[]
  /** Why it cannot be used; null when it can. */
  problem: string | null
}

/** The certificates a project trusts besides Node's and the operating system's. */
export interface ProjectTrust {
  /** The project's own files, then its global project's. */
  files: CaFile[]
  /** Every certificate those files hold, as PEM. */
  ca: string[]
  /**
   * One for each file that cannot be used. A run sends nothing while any
   * remain, and gta will not start.
   */
  problems: LoadProblem[]
}

export const NO_TRUST: ProjectTrust = { files: [], ca: [], problems: [] }

/**
 * Read the certificate files a project's `tls.ca` lists, then its global
 * project's. Each path is relative to the `project.yml` that lists it. A file
 * that cannot be used is a problem, reported against its path from the
 * project, and never a thrown error.
 */
export async function loadProjectTls(
  root: string,
  info: Pick<ProjectInfo, 'doc' | 'global'>
): Promise<ProjectTrust> {
  const listed = [
    ...entries(info.doc, root, 'project'),
    ...(info.global ? entries(info.global.doc, info.global.root, 'global') : [])
  ]
  if (listed.length === 0) return NO_TRUST

  const trust: ProjectTrust = { files: [], ca: [], problems: [] }
  for (const { base, ...entry } of listed) {
    // Found only because this disk ignores case: Linux, and so CI, would not find it.
    const misspelled = await spellingProblem(base, entry.path)
    const read = misspelled
      ? { pem: [], certificates: [], problem: misspelled }
      : await readCaFile(entry.file)
    trust.files.push({ ...entry, certificates: read.certificates, problem: read.problem })
    trust.ca.push(...read.pem)
    if (read.problem) {
      const listedIn =
        entry.source === 'global'
          ? relativePosix(root, path.join(info.global!.root, PROJECT_FILE))
          : PROJECT_FILE
      trust.problems.push({
        path: relativePosix(root, entry.file),
        message: `${read.problem} (tls.ca in ${listedIn})`
      })
    }
  }
  return trust
}

function entries(
  doc: ProjectDoc | null,
  root: string,
  source: CaFile['source']
): Array<Pick<CaFile, 'path' | 'source' | 'file'> & { base: string }> {
  return (doc?.tls?.ca ?? []).map((written) => ({
    path: toPosix(written),
    source,
    base: root,
    // The schema has already refused an absolute path.
    file: resolveRelative(root, written)
  }))
}

async function readCaFile(
  file: string
): Promise<{ pem: string[]; certificates: CertificateSummary[]; problem: string | null }> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(file)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return {
      pem: [],
      certificates: [],
      problem:
        code === 'ENOENT'
          ? 'no such file'
          : code === 'EISDIR'
            ? 'is a folder, not a certificate file'
            : `cannot be read: ${(cause as Error).message}`
    }
  }
  try {
    const certificates = readCertificates(bytes)
    return {
      pem: certificates.map((certificate) => certificate.toString()),
      certificates: certificates.map(summarizeCertificate),
      problem: null
    }
  } catch (cause) {
    return { pem: [], certificates: [], problem: (cause as Error).message }
  }
}
