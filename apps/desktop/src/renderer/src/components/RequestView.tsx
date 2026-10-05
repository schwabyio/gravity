import { useEffect, useMemo, useRef, useState } from 'react'
import type { CheckFileView, EndpointView, LibraryFileView, RequestSetView } from '@shared/ipc.js'
import {
  findEndpoint,
  type Collection,
  type HttpMethod,
  type RunResult,
  type StepList,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import {
  headerCount as countHeaders,
  inheritedLayers,
  inheritedSettings,
  sentHeaders,
  type InheritedLayer
} from '../inheritance.js'
import { usePaneShare, usePaneWidth } from '../hooks/usePaneWidth.js'
import Resizer from './Resizer.js'
import { useStoredFlag } from '../hooks/useStoredFlag.js'
import { buildChecks, tabFor } from '../testLinks.js'
import SettingsTab from './SettingsTab.js'
import InheritedHeaders from './InheritedHeaders.js'
import KeyValueEditor from './KeyValueEditor.js'
import MultipartEditor, { FileBodyEditor } from './MultipartEditor.js'
import QueryParamsEditor from './QueryParamsEditor.js'
import PaneHead from './PaneHead.js'
import ResponsePane, { type LiveView, type ResponseTab } from './ResponsePane.js'
import { ConnectionField, ReadBar } from './ConnectionStep.js'
import ScriptsPane, { ScriptsStrip, type ScriptKind, type ScriptTab } from './ScriptsPane.js'
import { UseBar, UseStepEditor } from './UseStep.js'
import VariableInput from './VariableInput.js'
import {
  BODY_MODES,
  HTTP_METHODS,
  readQueryParams,
  toHeaders,
  type EditorState
} from '../requestState.js'
import MethodPicker from './MethodPicker.js'

/** The request editor's tabs: what the request is made of. Its scripts have a pane of their own. */
type RequestTab = 'params' | 'headers' | 'body' | 'settings'

/** The least an open request or response pane is given: room for its head, name and Hide. */
const PANE_LEAST = 120

interface Props {
  request: EditorState
  /** Which data file row the result shown came from — `Iteration 2 (Bob) - get user` — if one did. */
  resultCaption?: string | null
  onChange: (changes: Partial<EditorState>) => void

  /**
   * The collection the step is in: its headers, settings and scripts, and the
   * base it `extends:`, which the step inherits with an endpoint base's.
   */
  collection: Pick<Collection, 'headers' | 'settings' | 'before' | 'tests' | 'extends'>
  /** Open the collection's settings at its headers. */
  onEditCollectionHeaders: () => void
  /** Open the collection's settings at one of its scripts. */
  onEditCollectionScript: (kind: 'pre-request' | 'tests') => void
  /** The project's base collections, to find the one the collection `extends:`. */
  bases: LibraryFileView[]
  /** The project's check files, to show those the step's scripts call. */
  checkFiles: CheckFileView[]
  /** Where the step is written, for "Open in …": its collection file, list and index. */
  stepPlace: { path: string; list: StepList; index: number } | null
  /** Open a base collection's file. */
  onOpenBase: (path: string) => void

  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  /** Pick a file for the body to upload, as a path from the project folder. */
  onPickFile?: (() => Promise<string | null>) | undefined

  result: RunResult | null
  error: string | null
  running: boolean
  onSend: () => void
  onCancel: () => void

  conflict: boolean
  onReloadFromDisk: () => void
  onKeepMine: () => void

  /** Request sets, for a use step to pick from. */
  sets: RequestSetView[]
  /** Endpoint bases, to say which one this step's request is under. */
  endpoints: EndpointView[]
  /** Open an endpoints file to edit it. */
  onOpenEndpoints: (endpoint: EndpointView) => void
  /** For a use step: which of its set's requests the response panes show. */
  shownChild: number
  onOpenSet: (set: RequestSetView) => void

  /** While running: an event stream as it is read, and the Stop that ends its reading. */
  live?: LiveView | null
  onStop?: () => void
  /** Names the collection's steps open connections as, for a step reading one. */
  connectionNames?: string[]
}

/** One request: where it sits, what it sends, and what came back. */
export default function RequestView(props: Props) {
  const [tab, setTab] = useState<RequestTab>('params')
  const [scriptTab, setScriptTab] = useState<ScriptTab>('tests')
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')

  // Which assertion is pointed at, shared by the response tabs and the Test Results pane.
  const [selected, setSelected] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [jumpedPath, setJumpedPath] = useState<string | null>(null)

  // The scripts are always beside the request and its response, and three wide panes do
  // not fit: whichever of the editor and the response has nothing to show is a strip.
  // The editor steps aside when a response comes; opening it by hand pins it open until
  // it is collapsed by hand again.
  const [requestOpen, setRequestOpen] = useState(true)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  // Hidden by hand until shown again by hand, whatever comes back meanwhile.
  const [responseHidden, setResponseHidden] = useState(false)
  const [scriptsHidden, setScriptsHidden] = useStoredFlag('pane.scripts.hidden')
  const scriptsPane = usePaneWidth('pane.scripts', 380, 260, 720)

  // The request editor and the response split their room by a share the divider between
  // them sets: measured, since the steps pane and the test results pane take theirs first.
  const requestEl = useRef<HTMLElement>(null)
  const responseEl = useRef<HTMLElement>(null)
  const [room, setRoom] = useState(0)
  const requestPane = usePaneShare('pane.request', 0.5, room, 180)

  const result = props.result
  // A step reading a connection sends nothing: it has no params, headers or body.
  const reads = props.request.reads !== null
  const shownTab: RequestTab =
    reads && (tab === 'params' || tab === 'headers' || tab === 'body') ? 'settings' : tab
  const checks = useMemo(() => buildChecks(result?.assertions ?? []), [result])
  const logs = result?.logs ?? []
  const scriptError = result?.error?.phase === 'tests' ? result.error : null
  // Mark the failing line in an editor, when the failing script is this step's own.
  const own = props.request.use !== null ? 'use' : 'step'
  const errorLine = (phase: ScriptKind) =>
    result?.error?.phase === phase && result.error.script === own ? result.error.line : undefined
  // Before anything is sent, the response has nothing to show; hidden by hand, it gives way.
  const hasResponse =
    result !== null || props.running || props.error !== null || (props.live ?? null) !== null
  const responseShown = hasResponse && !responseHidden
  const editorShown = requestOpen || !responseShown
  const collapseEditor = () => {
    setRequestOpen(false)
    setPinnedOpen(false)
  }
  const editorHead = (
    <PaneHead
      title="Request"
      hide={{
        text: '◂ Hide',
        label: 'Hide the request editor',
        tooltip: 'Collapse the request editor to give the response more room',
        onClick: collapseEditor
      }}
    />
  )

  useEffect(() => {
    setSelected(null)
    setHovered(null)
    setJumpedPath(null)
    if (result?.response && !pinnedOpen) setRequestOpen(false)
    // Keyed on the result alone: a change of pinning must not re-collapse.
  }, [result])

  const select = (index: number | null) => {
    setSelected(index)
    setJumpedPath(null)
    const assertion = index === null ? undefined : checks[index]?.assertion
    const tab = assertion && tabFor(assertion)
    if (tab) setResponseTab(tab)
  }

  /** A marked line or header was clicked; clicking again cycles through them. */
  const pick = (about: number[]) => {
    if (about.length === 0) return
    setJumpedPath(null)
    setSelected(about[(about.indexOf(selected ?? -1) + 1) % about.length]!)
  }

  const jump = (path: string) => {
    setJumpedPath(path)
    setResponseTab('body')
  }

  useEffect(() => {
    const measure = () =>
      setRoom((requestEl.current?.offsetWidth ?? 0) + (responseEl.current?.offsetWidth ?? 0))
    const observer = new ResizeObserver(measure)
    for (const element of [requestEl.current, responseEl.current]) {
      if (element) observer.observe(element)
    }
    measure()
    return () => observer.disconnect()
  }, [editorShown, responseShown, props.request.use])

  // Only with both open is there a split between them to drag.
  const both = editorShown && responseShown
  // An open pane is never narrower than its head, its name and Hide; the scripts pane, at
  // the width it was given where there is room, gives way down to its least first.
  const open = (share: number) => `minmax(${PANE_LEAST}px, ${share}fr)`
  const columns = [
    !editorShown ? 'var(--strip)' : open(both ? requestPane.share : 1),
    !responseShown ? 'var(--strip)' : open(both ? 1 - requestPane.share : 1),
    scriptsHidden ? 'var(--strip)' : `minmax(${scriptsPane.min}px, ${scriptsPane.width}px)`
  ].join(' ')
  const { request } = props

  const paramCount = readQueryParams(request.url).length
  // Everything the step inherits, as a run builds it: endpoint base, base collection, collection.
  const layers = useMemo(
    () =>
      inheritedLayers({
        method: request.method,
        url: request.url,
        useBase: request.base,
        endpoints: props.endpoints,
        bases: props.bases,
        collection: props.collection
      }),
    [request.method, request.url, request.base, props.endpoints, props.bases, props.collection]
  )
  const ownHeaders = useMemo(() => toHeaders(request.headers), [request.headers])
  // What will be sent: every layer's headers the step uses, and its own over them.
  const headerCount = countHeaders(sentHeaders(layers, ownHeaders))
  /** Open where a layer is written: its endpoints file, its base, the collection's settings. */
  const openLayer =
    (part: 'headers' | 'pre-request' | 'tests') =>
    (layer: InheritedLayer): void => {
      if (layer.endpoint) props.onOpenEndpoints(layer.endpoint)
      else if (layer.path) props.onOpenBase(layer.path)
      else if (part === 'headers') props.onEditCollectionHeaders()
      else props.onEditCollectionScript(part)
    }

  return (
    <div className="request-view">
      {props.conflict && (
        <div className="banner" role="alert">
          <strong>Changed on disk.</strong> This request was modified outside the app while you had
          unsaved edits.
          <button type="button" onClick={props.onReloadFromDisk}>
            Reload
          </button>
          <button type="button" onClick={props.onKeepMine}>
            Keep mine
          </button>
        </div>
      )}

      {request.use !== null ? (
        <UseBar
          request={request}
          sets={props.sets}
          onChange={props.onChange}
          onOpenSet={props.onOpenSet}
          running={props.running}
          onRun={props.onSend}
          onCancel={props.onCancel}
          shownChild={props.shownChild}
        />
      ) : request.reads !== null ? (
        <ReadBar
          request={request}
          names={props.connectionNames ?? []}
          onChange={props.onChange}
          running={props.running}
          onSend={props.onSend}
          onCancel={props.onCancel}
        />
      ) : (
        <form
          className="url-bar"
          onSubmit={(event) => {
            event.preventDefault()
            props.onSend()
          }}
        >
          <MethodPicker
            label="HTTP method"
            value={request.method}
            methods={HTTP_METHODS}
            onChange={(method: HttpMethod) => props.onChange({ method })}
          />
          <VariableInput
            className="url"
            value={request.url}
            onChange={(url) => props.onChange({ url })}
            previews={props.previews}
            onCopy={props.onCopyVariable}
            placeholder="https://staging.example.com/sessions"
            ariaLabel="Request URL"
          />
          <button
            type="submit"
            className="send"
            disabled={props.running || request.url.trim() === ''}
          >
            {props.running ? 'Sending…' : 'Send'}
          </button>
          {props.running && (
            <button type="button" className="cancel" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </form>
      )}

      {request.use === null && request.reads === null && (
        <EndpointNote
          endpoint={findEndpoint(request.method, request.url, props.endpoints)}
          using={request.base}
          onUse={(base) => props.onChange({ base })}
          onOpen={props.onOpenEndpoints}
        />
      )}

      <div className="panes" style={{ gridTemplateColumns: columns }}>
        {!editorShown ? (
          <button
            type="button"
            className="pane-strip"
            onClick={() => {
              setRequestOpen(true)
              setPinnedOpen(true)
            }}
            aria-label="Show the request editor"
          >
            <span>Request ▸</span>
          </button>
        ) : request.use !== null ? (
          <section className="pane request-pane" ref={requestEl}>
            {both && <Resizer pane={requestPane} label="Resize the request pane" />}
            {editorHead}
            <UseStepEditor
              request={request}
              sets={props.sets}
              onChange={props.onChange}
              previews={props.previews}
              onCopyVariable={props.onCopyVariable}
            />
          </section>
        ) : (
          <section className="pane request-pane" ref={requestEl}>
            {both && <Resizer pane={requestPane} label="Resize the request pane" />}
            {editorHead}
            <div className="tabs">
              {!reads && (
                <>
                  <button
                    className={shownTab === 'params' ? 'active' : ''}
                    onClick={() => setTab('params')}
                  >
                    Params {paramCount > 0 && <span className="count">{paramCount}</span>}
                  </button>
                  <button
                    className={shownTab === 'headers' ? 'active' : ''}
                    onClick={() => setTab('headers')}
                  >
                    Headers {headerCount > 0 && <span className="count">{headerCount}</span>}
                  </button>
                  <button
                    className={shownTab === 'body' ? 'active' : ''}
                    onClick={() => setTab('body')}
                  >
                    Body {request.bodyMode !== 'none' && <span className="count dot">•</span>}
                  </button>
                </>
              )}
              <button
                className={shownTab === 'settings' ? 'active' : ''}
                onClick={() => setTab('settings')}
              >
                Settings{' '}
                {Object.keys(request.settings).length > 0 && <span className="count dot">•</span>}
              </button>
            </div>

            <div className="tab-body">
              {shownTab === 'params' && (
                <QueryParamsEditor
                  url={request.url}
                  onUrlChange={(url) => props.onChange({ url })}
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
              )}
              {shownTab === 'headers' && (
                <>
                  <KeyValueEditor
                    rows={request.headers}
                    onChange={(headers) => props.onChange({ headers })}
                    previews={props.previews}
                    onCopyVariable={props.onCopyVariable}
                  />
                  <InheritedHeaders
                    layers={layers}
                    own={ownHeaders}
                    onOpen={openLayer('headers')}
                  />
                </>
              )}
              {shownTab === 'settings' && !reads && (
                <ConnectionField
                  value={request.connection}
                  onChange={(connection) => props.onChange({ connection })}
                />
              )}
              {shownTab === 'settings' && (
                <SettingsTab
                  level="step"
                  own={request.settings}
                  inherited={inheritedSettings(layers)}
                  onChange={(settings) => props.onChange({ settings })}
                />
              )}
              {shownTab === 'body' && (
                <div className="body-editor">
                  <select
                    value={request.bodyMode}
                    onChange={(e) =>
                      props.onChange({ bodyMode: e.target.value as EditorState['bodyMode'] })
                    }
                    aria-label="Body type"
                  >
                    {BODY_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                  {request.bodyMode === 'none' ? (
                    <div className="placeholder">This request has no body.</div>
                  ) : request.bodyMode === 'multipart' ? (
                    <MultipartEditor
                      rows={request.bodyParts}
                      onChange={(bodyParts) => props.onChange({ bodyParts })}
                      previews={props.previews}
                      onCopyVariable={props.onCopyVariable}
                      onPickFile={props.onPickFile}
                    />
                  ) : request.bodyMode === 'file' ? (
                    <FileBodyEditor
                      value={request.bodyFile}
                      onChange={(bodyFile) => props.onChange({ bodyFile })}
                      onPickFile={props.onPickFile}
                    />
                  ) : (
                    <textarea
                      value={request.bodyText}
                      spellCheck={false}
                      placeholder={
                        request.bodyMode === 'form'
                          ? 'one name=value pair per line'
                          : 'Request body'
                      }
                      onChange={(e) => props.onChange({ bodyText: e.target.value })}
                      aria-label="Request body"
                    />
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {responseShown ? (
          <section className="pane" ref={responseEl}>
            <PaneHead
              title="Response"
              hide={{
                text: 'Hide',
                label: 'Hide the response',
                tooltip: 'Hide the response to give the request editor more room',
                onClick: () => setResponseHidden(true)
              }}
            />
            {props.resultCaption && result && (
              <p className="result-iteration" aria-label="Result from">
                {props.resultCaption}
              </p>
            )}
            <ResponsePane
              result={result}
              error={props.error}
              running={props.running}
              tab={responseTab}
              onTab={setResponseTab}
              checks={checks}
              focus={hovered ?? selected}
              selected={selected}
              jumpedPath={jumpedPath}
              onPick={pick}
              live={props.live ?? null}
              {...(props.onStop ? { onStop: props.onStop } : {})}
            />
          </section>
        ) : hasResponse ? (
          <button
            type="button"
            className="pane-strip"
            onClick={() => setResponseHidden(false)}
            aria-label="Show the response"
          >
            <span>
              Response
              {result?.response
                ? ` · ${result.response.status}`
                : props.running
                  ? ' · sending…'
                  : props.error || result?.error
                    ? ' · error'
                    : ''}
            </span>
          </button>
        ) : (
          <button type="button" className="pane-strip" disabled aria-label="No response yet">
            <span>No response yet</span>
          </button>
        )}

        {scriptsHidden ? (
          <ScriptsStrip
            checks={result?.response ? checks : []}
            scriptError={scriptError}
            onShow={() => setScriptsHidden(false)}
          />
        ) : (
          <ScriptsPane
            use={request.use !== null}
            request={request}
            onChange={props.onChange}
            tab={scriptTab}
            onTab={setScriptTab}
            layers={layers}
            checkFiles={props.checkFiles}
            stepPlace={props.stepPlace}
            onOpenLayer={openLayer}
            result={result}
            checks={checks}
            logs={logs}
            scriptError={scriptError}
            errorLines={{ 'pre-request': errorLine('pre-request'), tests: errorLine('tests') }}
            selected={selected}
            onSelect={select}
            onHover={(index) => {
              setHovered(index)
              if (index !== null) setJumpedPath(null)
            }}
            onJump={jump}
            pane={scriptsPane}
            onHide={() => setScriptsHidden(true)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Which endpoint base this step's request is under, what it brings, and a way
 * to it — or to not use it for this step (SPEC.md §2.6).
 */
function EndpointNote(props: {
  endpoint: EndpointView | null
  using: boolean
  onUse: (base: boolean) => void
  onOpen: (endpoint: EndpointView) => void
}) {
  const { endpoint } = props
  if (!endpoint) return null
  const brings = [
    endpoint.headers.length > 0 ? `headers ${endpoint.headers.join(', ')}` : null,
    endpoint.hasBefore ? 'a pre-request script' : null,
    endpoint.hasTests ? 'checks' : null
  ].filter((item): item is string => item !== null)
  // "a, b and c"
  const listed =
    brings.length > 1
      ? `${brings.slice(0, -1).join(', ')} and ${brings[brings.length - 1]}`
      : brings[0]
  const name = `${endpoint.method} ${endpoint.path}`
  return (
    <p className={`endpoint-note${props.using ? '' : ' off'}`} role="note">
      {props.using ? (
        <>
          Endpoint base <strong>{name}</strong>
          {endpoint.source === 'global' && <span className="shared-tag">shared</span>}
          {listed && <> — adds {listed}</>}. This step&rsquo;s own checks of the same thing replace
          its checks.
        </>
      ) : (
        <>
          Not using the endpoint base <strong>{name}</strong> here.
        </>
      )}
      <button type="button" className="link" onClick={() => props.onOpen(endpoint)}>
        Open
      </button>
      <button type="button" className="link" onClick={() => props.onUse(!props.using)}>
        {props.using ? 'Don’t use it here' : 'Use it'}
      </button>
    </p>
  )
}
