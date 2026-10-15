import { useRef, useState, type ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  headerItems,
  type Body,
  type Step,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import { inheritedSettings, sentHeaders, type InheritedLayer } from '../inheritance.js'
import { readQueryParams } from '../requestState.js'
import BodyEditor from './BodyEditor.js'
import InheritedHeaders from './InheritedHeaders.js'
import { tokenize, variableState } from './VariableInput.js'

type Tab = 'params' | 'headers' | 'body' | 'settings'

interface Props {
  /** The request, as its file has it. */
  step: Step
  /** Its URL, for its query parameters. */
  url: string
  /** What it inherits: the endpoint base, the collection, its reusable requests file. */
  layers: InheritedLayer[]
  onOpenLayer: (layer: InheritedLayer) => void
  previews: VariablePreviews
}

const NOTHING = (): void => {}

/**
 * A request shown as it is written, not edited: one of a reusable requests
 * file's, seen from a use step that runs it (SPEC.md §2.5). Its params,
 * headers — its own, then those it inherits — body and settings, under the
 * request editor's tabs; the file is where it is changed.
 */
export default function RequestSummary(props: Props) {
  const { step, layers } = props
  // A step reading a connection sends nothing: it has only settings.
  const reads = step.connection !== undefined && !hasMethod(step)
  const [picked, setPicked] = useState<Tab>('params')
  const tab: Tab = reads ? 'settings' : picked
  const params = readQueryParams(props.url)
  const own = ownHeaders(step)
  const sent = Object.keys(sentHeaders(layers, step.headers) ?? {}).length
  const inherited = inheritedSettings(layers)
  const settings = [
    ...Object.entries(step.settings ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ key, value, from: 'this request' })),
    ...Object.entries(inherited)
      .filter(([key]) => step.settings?.[key as keyof typeof step.settings] === undefined)
      .map(([key, found]) => ({ key, value: found!.value, from: `the ${found!.from}` }))
  ]

  return (
    <>
      <div className="tabs">
        {!reads && (
          <>
            <button
              className={tab === 'params' ? 'active' : ''}
              onClick={() => setPicked('params')}
            >
              Params {params.length > 0 && <span className="count">{params.length}</span>}
            </button>
            <button
              className={tab === 'headers' ? 'active' : ''}
              onClick={() => setPicked('headers')}
            >
              Headers {sent > 0 && <span className="count">{sent}</span>}
            </button>
            <button className={tab === 'body' ? 'active' : ''} onClick={() => setPicked('body')}>
              Body {step.body && <span className="count dot">•</span>}
            </button>
          </>
        )}
        <button
          className={tab === 'settings' ? 'active' : ''}
          onClick={() => setPicked('settings')}
        >
          Settings {step.settings && <span className="count dot">•</span>}
        </button>
      </div>

      <div className="tab-body request-summary">
        {tab === 'params' &&
          (params.length === 0 ? (
            <p className="hint">No query parameters.</p>
          ) : (
            <Table
              rows={params.map((param) => ({
                name: param.name,
                value: <Marked text={param.value} previews={props.previews} />
              }))}
            />
          ))}
        {tab === 'headers' && (
          <>
            {own.length === 0 ? (
              <p className="hint">No headers of its own.</p>
            ) : (
              <Table
                label="Its own headers"
                rows={own.map((header) => ({
                  name: header.name,
                  value: <Marked text={header.value} previews={props.previews} />,
                  note: header.on ? '' : 'off',
                  off: !header.on
                }))}
              />
            )}
            <InheritedHeaders layers={layers} own={step.headers} onOpen={props.onOpenLayer} />
          </>
        )}
        {tab === 'body' && <BodyShown body={step.body} previews={props.previews} />}
        {tab === 'settings' && (
          <>
            {step.connection !== undefined && hasMethod(step) && (
              <p className="hint">
                Keeps the event stream it opens as the connection <code>{step.connection}</code>.
              </p>
            )}
            {reads && (
              <p className="hint">
                Reads the events the connection <code>{step.connection}</code> holds.
              </p>
            )}
            {settings.length === 0 ? (
              <p className="hint">Every setting is the default.</p>
            ) : (
              <Table
                label="Settings"
                rows={settings.map((setting) => ({
                  name: setting.key,
                  value: String(setting.value),
                  note: setting.from
                }))}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

const hasMethod = (step: Step): boolean =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].some((method) => method in step)

/** Its own headers, a repeated one a row per value. */
function ownHeaders(step: Step): Array<{ name: string; value: string; on: boolean }> {
  return Object.entries(step.headers ?? {}).flatMap(([name, value]) =>
    headerItems(value).map((item) => ({ name, value: item.value, on: item.enabled }))
  )
}

/** Text with its `{{variables}}` marked, as the URL bar marks them. */
function Marked(props: { text: string; previews: VariablePreviews }) {
  return (
    <>
      {tokenize(props.text).map((segment, index) =>
        segment.name === undefined ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span key={index} className={`var-token ${variableState(props.previews[segment.name])}`}>
            {segment.text}
          </span>
        )
      )}
    </>
  )
}

function Table(props: {
  label?: string
  rows: Array<{ name: string; value: ReactNode; note?: string; off?: boolean }>
}) {
  return (
    <table className="kv readonly" aria-label={props.label}>
      <tbody>
        {props.rows.map((row, index) => (
          <tr key={`${row.name}-${index}`} className={row.off ? 'unused' : ''}>
            <td className="header-name">{row.name}</td>
            <td className="wrap">{row.value}</td>
            {row.note !== undefined && <td className="inherited-note">{row.note}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The body as written: text in the body editor, shown only; a form or multipart as a table. */
function BodyShown(props: { body: Body | undefined; previews: VariablePreviews }) {
  const view = useRef<EditorView | null>(null)
  const { body } = props
  const text = (mode: string, value: string) => (
    <div className="body-editor">
      <BodyEditor
        mode={mode}
        value={value}
        onChange={NOTHING}
        previews={props.previews}
        placeholder=""
        ariaLabel="Request body"
        view={view}
        onBeautify={null}
        readOnly
      />
    </div>
  )
  if (!body) return <div className="placeholder">This request has no body.</div>
  if (body.json !== undefined) return text('json', body.json)
  if (body.xml !== undefined) return text('xml', body.xml)
  if (body.text !== undefined) return text('text', body.text)
  if (body.graphql !== undefined) {
    const variables = body.graphql.variables
    return text(
      'text',
      variables
        ? `${body.graphql.query}\n\n${JSON.stringify(variables, null, 2)}`
        : body.graphql.query
    )
  }
  if (body.form !== undefined) {
    return (
      <Table
        label="Form fields"
        rows={Object.entries(body.form).map(([name, value]) => ({
          name,
          value: <Marked text={value} previews={props.previews} />
        }))}
      />
    )
  }
  if (body.multipart !== undefined) {
    return (
      <Table
        label="Multipart fields"
        rows={Object.entries(body.multipart).flatMap(([name, field]) =>
          (Array.isArray(field) ? field : [field]).map((part) =>
            typeof part === 'string'
              ? { name, value: <Marked text={part} previews={props.previews} />, note: '' }
              : 'file' in part
                ? {
                    name,
                    value: `file ${part.file}${part.filename !== undefined ? ` as ${part.filename}` : ''}`,
                    note: part.contentType ?? ''
                  }
                : {
                    name,
                    value: <Marked text={part.value} previews={props.previews} />,
                    note: part.contentType ?? ''
                  }
          )
        )}
      />
    )
  }
  if (body.file !== undefined) {
    return (
      <p className="hint">
        Sends the file <code>{body.file}</code>.
      </p>
    )
  }
  return <div className="placeholder">This request has no body.</div>
}
