import type { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import type { Body } from '../model/documents.js'
import type { HeaderEntry, SentRequest } from '../model/run.js'
import {
  isInside,
  relativePosix,
  resolveRelative,
  samePath,
  spellingProblem,
  toPosix
} from '../paths.js'
import { interpolateToString } from '../vars/interpolate.js'
import type { VariableScope } from '../vars/scope.js'
import {
  contentTypeFor,
  encodeMultipart,
  fileMarker,
  multipartHeaders,
  partsOf,
  type EncodedPart
} from './multipart.js'

/** A file the body names could not be read: its own phase, never a network problem. */
export class BodyFileError extends Error {
  override name = 'BodyFileError'
}

/** Where a step's body files are read from (SPEC.md §2.2). */
export interface FileRoots {
  /** The folder of the project the step belongs to: a request set's own, for its steps. */
  project: string
  /**
   * The global project's folder, of the collection being run: what `global:`
   * names, and where a file not in `project` is looked for. Null for none.
   */
  global: string | null
}

/** Before a body file's path: the global project's file, and no other. */
export const GLOBAL_FILE = 'global:'

export interface PreparedRequest {
  /** The call as results, reports and `tests` show it: a file's bytes shown by a marker. */
  request: SentRequest
  /** The body's bytes, when they are not `request.body`'s text: a file or multipart body. */
  payload: Buffer | null
}

/**
 * The call about to be made, from the request as written (`toSentRequest`):
 * every `{{variable}}` resolved, and the body built (SPEC.md §2.2).
 *
 * Text bodies are resolved as text. A form's names and values are resolved,
 * then encoded, so a value can hold `&` or `=`. A multipart or file body
 * reads its files from `files`: the folder of the project the step belongs
 * to, else its global project's. A path can use variables too, so a data file
 * row can choose the file.
 *
 * Throws `InterpolationError` for a variable that cannot be resolved, and
 * `BodyFileError` for a file that cannot be read.
 */
export async function prepareRequest(
  written: SentRequest,
  body: Body | undefined,
  scope: VariableScope,
  files: FileRoots | null
): Promise<PreparedRequest> {
  const resolve = (text: string) => interpolateToString(text, scope)
  const headers: HeaderEntry[] = written.headers.map((header) => ({
    name: resolve(header.name),
    value: resolve(header.value)
  }))
  const request = { method: written.method, url: resolve(written.url), headers }

  if (body?.form !== undefined) {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(body.form)) {
      params.append(resolve(name), resolve(value))
    }
    return { request: { ...request, body: params.toString() }, payload: null }
  }

  if (body?.multipart !== undefined) {
    const parts: EncodedPart[] = []
    for (const [field, part] of partsOf(body.multipart)) {
      const name = resolve(field)
      if (typeof part === 'string') {
        parts.push({ name, value: resolve(part) })
      } else if ('file' in part) {
        const path = resolve(part.file)
        const { bytes, shown } = await readBodyFile(files, path, `multipart field ${name}`)
        parts.push({
          name,
          value: bytes,
          filename: part.filename !== undefined ? resolve(part.filename) : baseName(path),
          contentType: part.contentType ? resolve(part.contentType) : contentTypeFor(path),
          shown: fileMarker(shown, bytes.byteLength)
        })
      } else {
        parts.push({
          name,
          value: resolve(part.value),
          ...(part.contentType ? { contentType: resolve(part.contentType) } : {})
        })
      }
    }
    const typed = multipartHeaders(headers)
    const { bytes, text } = encodeMultipart(parts, typed.boundary)
    return { request: { ...request, headers: typed.headers, body: text }, payload: bytes }
  }

  if (body?.file !== undefined) {
    const path = resolve(body.file)
    const { bytes, shown } = await readBodyFile(files, path, 'body.file')
    const declared = headers.some((header) => header.name.toLowerCase() === 'content-type')
    return {
      request: {
        ...request,
        headers: declared
          ? headers
          : [...headers, { name: 'Content-Type', value: contentTypeFor(path) }],
        body: fileMarker(shown, bytes.byteLength)
      },
      payload: bytes
    }
  }

  return {
    request: {
      ...request,
      // In a JSON body a null is JSON's own, not a gap that leaves it malformed.
      body:
        written.body === null
          ? null
          : body?.json !== undefined
            ? interpolateToString(written.body, scope, { nullAs: 'null' })
            : resolve(written.body)
    },
    payload: null
  }
}

const baseName = (path: string) => withoutGlobal(path).split(/[\\/]/).pop() ?? path

const withoutGlobal = (path: string) =>
  path.startsWith(GLOBAL_FILE) ? path.slice(GLOBAL_FILE.length) : path

/** Each file a body names, as written, and how a message names where it is. */
export function bodyFiles(body: Body | undefined): Array<{ what: string; written: string }> {
  if (body?.file !== undefined) return [{ what: 'body.file', written: body.file }]
  if (body?.multipart === undefined) return []
  return partsOf(body.multipart).flatMap(([field, part]) =>
    typeof part !== 'string' && 'file' in part
      ? [{ what: `multipart field ${field}`, written: part.file }]
      : []
  )
}

/** A file a body names, read; `shown` names it as `‹file …›` does. */
async function readBodyFile(
  roots: FileRoots | null,
  written: string,
  what: string
): Promise<{ bytes: Buffer; shown: string }> {
  const { file, shown } = await findBodyFile(roots, written, what)
  try {
    return { bytes: await fs.readFile(file), shown }
  } catch (cause) {
    throw new BodyFileError(`${what}: ${written} — ${(cause as Error).message}`)
  }
}

/**
 * The file a body names (SPEC.md §2.2): `global:path` in the global project
 * only; any other path in the step's project, else — for a path inside that
 * folder — in the global project, as a request set or a base is found.
 * `shown` says which, as `‹file …›` shows it: `global:files/avatar.png` for
 * the global project's. Throws `BodyFileError`, saying why, when there is none.
 */
export async function findBodyFile(
  roots: FileRoots | null,
  written: string,
  what: string
): Promise<{ file: string; shown: string }> {
  const missing = (reason: string) => new BodyFileError(`${what}: ${written} — ${reason}`)
  if (roots === null) {
    throw missing(
      'files are read from the project folder, so save the collection in a project first'
    )
  }
  const relative = withoutGlobal(written)
  if (relative !== written) {
    if (!roots.global) throw missing('this project does not use a global project')
    const file = await fileIn(roots.global, relative, written, what)
    if (file) return { file, shown: written }
    throw missing('no such file in the global project folder')
  }
  const file = await fileIn(roots.project, relative, written, what)
  if (file) return { file, shown: written }
  // A step of the global project's own reads it as its project already.
  const global = roots.global && !samePath(roots.global, roots.project) ? roots.global : null
  if (!global || !isInside(roots.project, resolveRelative(roots.project, relative))) {
    throw missing('no such file in the project folder')
  }
  const shared = await fileIn(global, relative, written, what)
  if (shared) return { file: shared, shown: `${GLOBAL_FILE}${toPosix(relative)}` }
  throw missing(
    `no such file in the project folder, or in its global project's (${relativePosix(roots.project, global)})`
  )
}

/**
 * `relative` beneath `root` when a file is there, and null when nothing is.
 * Anything else that stops it being read — an absolute path, a name spelled
 * in another case, a path out of the global project, a directory — is thrown.
 */
async function fileIn(
  root: string,
  relative: string,
  written: string,
  what: string
): Promise<string | null> {
  let file: string
  try {
    file = resolveRelative(root, relative)
  } catch (cause) {
    throw new BodyFileError(`${what}: ${(cause as Error).message}`)
  }
  if (written.startsWith(GLOBAL_FILE) && !isInside(root, file)) {
    throw new BodyFileError(
      `${what}: ${written} — a global: path stays in the global project folder`
    )
  }
  // Found only because this disk ignores case: Linux, and so CI, would not find it.
  const misspelled = await spellingProblem(root, relative)
  if (misspelled) throw new BodyFileError(`${what}: ${misspelled}`)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new BodyFileError(`${what}: ${written} — ${(cause as Error).message}`)
  }
  if (stat.isDirectory()) throw new BodyFileError(`${what}: ${written} — is a folder, not a file`)
  return file
}
