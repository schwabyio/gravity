import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import type { MultipartField, MultipartPart } from '../model/documents.js'
import type { HeaderEntry } from '../model/run.js'

/**
 * multipart/form-data (RFC 7578), encoded here rather than by a FormData, so
 * the exact bytes sent are known — and can be shown, with each file's content
 * replaced by a marker, in results, reports and `req.body`.
 */

/** A part ready to encode: its text, or a file's bytes and how to show them. */
export interface EncodedPart {
  name: string
  value: string | Uint8Array
  /** For a file: the name sent. */
  filename?: string
  contentType?: string
  /** For a file: what stands in for its bytes where the body is shown. */
  shown?: string
}

/** Every part of a multipart body, in order: a field written as a list is one part per item. */
export function partsOf(multipart: Record<string, MultipartField>): Array<[string, MultipartPart]> {
  return Object.entries(multipart).flatMap(([name, field]) =>
    (Array.isArray(field) ? field : [field]).map((part): [string, MultipartPart] => [name, part])
  )
}

/** What stands in for a file's bytes wherever the body is shown. */
export const fileMarker = (written: string, size?: number): string =>
  size === undefined ? `‹file ${written}›` : `‹file ${written}, ${size} bytes›`

/** A boundary unlikely to occur in any part. */
export const newBoundary = (): string => `----GravityBoundary${randomBytes(12).toString('hex')}`

/** Quotes, CR and LF in a name or filename, escaped as browsers escape them. */
const quoted = (value: string) =>
  `"${value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')}"`

/**
 * Encode the parts: the bytes to send, and the same body as text with each
 * file's bytes replaced by its marker.
 */
export function encodeMultipart(
  parts: EncodedPart[],
  boundary: string
): { bytes: Buffer; text: string } {
  const chunks: Buffer[] = []
  let text = ''
  for (const part of parts) {
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name=${quoted(part.name)}` +
      (part.filename !== undefined ? `; filename=${quoted(part.filename)}` : '') +
      '\r\n' +
      (part.contentType ? `Content-Type: ${part.contentType}\r\n` : '') +
      '\r\n'
    const value = typeof part.value === 'string' ? Buffer.from(part.value) : part.value
    chunks.push(Buffer.from(head), Buffer.from(value), Buffer.from('\r\n'))
    text += `${head}${typeof part.value === 'string' ? part.value : (part.shown ?? '')}\r\n`
  }
  const end = `--${boundary}--\r\n`
  chunks.push(Buffer.from(end))
  return { bytes: Buffer.concat(chunks), text: text + end }
}

const BOUNDARY_PARAM = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i

/**
 * The Content-Type for a multipart body, and the boundary to encode it with.
 *
 * Absent, it is `multipart/form-data` with a boundary of ours. Declared with a
 * boundary, that boundary is used. Declared as a multipart type without one —
 * the usual mistake, and fatal to the request — it gets ours added, so a
 * `multipart/mixed` or `multipart/related` works too. Any other declared type
 * is left as written.
 */
export function multipartHeaders(headers: HeaderEntry[]): {
  headers: HeaderEntry[]
  boundary: string
} {
  const index = headers.findIndex((header) => header.name.toLowerCase() === 'content-type')
  const declared = index === -1 ? undefined : headers[index]!
  const given = declared ? BOUNDARY_PARAM.exec(declared.value) : null
  if (given) return { headers, boundary: (given[1] ?? given[2])! }

  const boundary = newBoundary()
  if (!declared) {
    return {
      headers: [
        ...headers,
        { name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` }
      ],
      boundary
    }
  }
  if (!/^\s*multipart\//i.test(declared.value)) return { headers, boundary }
  return {
    headers: headers.map((header, i) =>
      i === index ? { ...header, value: `${header.value}; boundary=${boundary}` } : header
    ),
    boundary
  }
}

/** Content types by extension, for a file that does not say. */
const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4'
}

/** A file's content type from its extension; application/octet-stream when unknown. */
export function contentTypeFor(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}
