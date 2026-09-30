import type { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import type { Body } from '../model/documents.js'
import type { HeaderEntry, SentRequest } from '../model/run.js'
import { resolveRelative, spellingProblem } from '../paths.js'
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
 * reads its files from `root`, the folder of the project the step belongs to;
 * a path can use variables too, so a data file row can choose the file.
 *
 * Throws `InterpolationError` for a variable that cannot be resolved, and
 * `BodyFileError` for a file that cannot be read.
 */
export async function prepareRequest(
  written: SentRequest,
  body: Body | undefined,
  scope: VariableScope,
  root: string | null
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
        const bytes = await readBodyFile(root, path, `multipart field ${name}`)
        parts.push({
          name,
          value: bytes,
          filename: part.filename !== undefined ? resolve(part.filename) : baseName(path),
          contentType: part.contentType ? resolve(part.contentType) : contentTypeFor(path),
          shown: fileMarker(path, bytes.byteLength)
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
    const bytes = await readBodyFile(root, path, 'body.file')
    const declared = headers.some((header) => header.name.toLowerCase() === 'content-type')
    return {
      request: {
        ...request,
        headers: declared
          ? headers
          : [...headers, { name: 'Content-Type', value: contentTypeFor(path) }],
        body: fileMarker(path, bytes.byteLength)
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

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A file a body names, from the project folder. */
async function readBodyFile(root: string | null, path: string, what: string): Promise<Buffer> {
  if (root === null) {
    throw new BodyFileError(
      `${what}: ${path} — files are read from the project folder, so save the collection in a project first`
    )
  }
  let file: string
  try {
    file = resolveRelative(root, path)
  } catch (cause) {
    throw new BodyFileError(`${what}: ${(cause as Error).message}`)
  }
  // Found only because this disk ignores case: Linux, and so CI, would not find it.
  const misspelled = await spellingProblem(root, path)
  if (misspelled) throw new BodyFileError(`${what}: ${misspelled}`)
  try {
    return await fs.readFile(file)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    const reason =
      code === 'ENOENT'
        ? 'no such file in the project folder'
        : code === 'EISDIR'
          ? 'is a directory, not a file'
          : (cause as Error).message
    throw new BodyFileError(`${what}: ${path} — ${reason}`)
  }
}
