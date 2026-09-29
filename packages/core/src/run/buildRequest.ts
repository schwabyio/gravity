import type { Body, Collection, Headers, Settings, Step } from '../model/documents.js'
import { mergeHeaders, readRequestLine, SETTINGS_DEFAULTS } from '../model/documents.js'
import type { HeaderEntry, SentRequest } from '../model/run.js'
import { encodeMultipart, fileMarker, partsOf } from './multipart.js'

/** Flatten the authored header map into what goes on the wire (SPEC.md §2). */
export function toHeaderEntries(headers: Headers | undefined): HeaderEntry[] {
  const entries: HeaderEntry[] = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') {
      entries.push({ name, value })
    } else if (Array.isArray(value)) {
      for (const item of value) entries.push({ name, value: item })
    } else if (value.enabled !== false) {
      entries.push({ name, value: value.value })
    }
  }
  return entries
}

/** Content-Type implied by the body form, applied only if none is declared. */
const IMPLIED_CONTENT_TYPE = {
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  form: 'application/x-www-form-urlencoded',
  graphql: 'application/json'
} as const

export interface BuiltBody {
  text: string | null
  contentType: string | undefined
}

/** The boundary a multipart body is shown with before it is sent, and a real one chosen. */
const WRITTEN_BOUNDARY = '----GravityBoundary'

/**
 * Render the body to text, as written.
 *
 * This is the body a `before.script` sees, and a request that fails before
 * sending shows. What is sent is built from it by `prepareRequest`: a form
 * encoded after its values are resolved, and a multipart or file body with
 * the files read from the project. Those carry no implied Content-Type here;
 * `prepareRequest` gives them theirs.
 */
export function toBody(body: Body | undefined): BuiltBody {
  if (!body) return { text: null, contentType: undefined }

  if (body.json !== undefined) return { text: body.json, contentType: IMPLIED_CONTENT_TYPE.json }
  if (body.xml !== undefined) return { text: body.xml, contentType: IMPLIED_CONTENT_TYPE.xml }
  if (body.text !== undefined) return { text: body.text, contentType: IMPLIED_CONTENT_TYPE.text }

  if (body.form !== undefined) {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(body.form)) params.append(name, value)
    return { text: params.toString(), contentType: IMPLIED_CONTENT_TYPE.form }
  }

  if (body.graphql !== undefined) {
    return {
      text: JSON.stringify({
        query: body.graphql.query,
        ...(body.graphql.variables ? { variables: body.graphql.variables } : {})
      }),
      contentType: IMPLIED_CONTENT_TYPE.graphql
    }
  }

  if (body.multipart !== undefined) {
    const parts = partsOf(body.multipart).map(([name, part]) =>
      typeof part === 'string'
        ? { name, value: part }
        : 'file' in part
          ? {
              name,
              value: '',
              filename: part.filename ?? part.file.split(/[\\/]/).pop()!,
              ...(part.contentType ? { contentType: part.contentType } : {}),
              shown: fileMarker(part.file)
            }
          : {
              name,
              value: part.value,
              ...(part.contentType ? { contentType: part.contentType } : {})
            }
    )
    return { text: encodeMultipart(parts, WRITTEN_BOUNDARY).text, contentType: undefined }
  }

  if (body.file !== undefined) return { text: fileMarker(body.file), contentType: undefined }

  return { text: null, contentType: undefined }
}

/** Merge collection, folder and request settings; the most specific wins. */
export function resolveSettings(...layers: Array<Settings | undefined>): Required<Settings> {
  return layers.reduce<Required<Settings>>(
    (merged, layer) => ({ ...merged, ...stripUndefined(layer) }),
    { ...SETTINGS_DEFAULTS }
  )
}

const stripUndefined = (value: Settings | undefined): Settings =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined))

/**
 * Turn a step into the exact call to put on the wire.
 *
 * The collection's headers are merged underneath the step's, so a shared `Accept`
 * applies everywhere while a step that declares its own — in any case — still wins.
 */
export function toSentRequest(step: Step, collection?: Collection): SentRequest {
  const { method, url } = readRequestLine(step)
  const headers = toHeaderEntries(mergeHeaders(collection?.headers, step.headers))
  const { text, contentType } = toBody(step.body)

  const declaresContentType = headers.some((h) => h.name.toLowerCase() === 'content-type')
  if (text !== null && contentType && !declaresContentType) {
    headers.push({ name: 'Content-Type', value: contentType })
  }

  return { method, url, headers, body: text }
}
