import { useEffect, useMemo, useState } from 'react'
import type { EndpointView, LibraryFileView, RequestSetView } from '@shared/ipc.js'
import {
  findEndpoint,
  type Collection,
  type HttpMethod,
  type RunResult,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import {
  headerCount as countHeaders,
  inheritedLayers,
  inheritedSettings,
  sentHeaders,
  type InheritedLayer
} from '../inheritance.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { useStoredFlag } from '../hooks/useStoredFlag.js'
import { buildChecks, tabFor } from '../testLinks.js'
import CodeEditor from './CodeEditor.js'
import SettingsTab from './SettingsTab.js'
import InheritedHeaders from './InheritedHeaders.js'
import InheritedScripts from './InheritedScripts.js'
import KeyValueEditor from './KeyValueEditor.js'
import MultipartEditor, { FileBodyEditor } from './MultipartEditor.js'
import QueryParamsEditor from './QueryParamsEditor.js'
import Markdown from './Markdown.js'
import ResponsePane, { type ResponseTab } from './ResponsePane.js'
import TestResultsPane from './TestResultsPane.js'
import Tooltip from './Tooltip.js'
import { UseBar, UseStepEditor } from './UseStep.js'
import VariableInput from './VariableInput.js'
import {
  BODY_MODES,
  HTTP_METHODS,
  readQueryParams,
  toHeaders,
  type EditorState
} from '../requestState.js'

type RequestTab = 'params' | 'headers' | 'body' | 'pre-request' | 'tests' | 'settings' | 'docs'

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
  /** Open a base collection's file. */
  onOpenBase: (path: string) => void

  /** The step's own docs, rendered in a tab when it has any. */
  docs?: string | undefined

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
}

/** One request: where it sits, what it sends, and what came back. */
export default function RequestView(props: Props) {
  const [tab, setTab] = useState<RequestTab>('params')
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')

  // Which assertion is pointed at, shared by the response tabs and the Test Results pane.
  const [selected, setSelected] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [jumpedPath, setJumpedPath] = useState<string | null>(null)

  // The editor steps aside for results: three panes do not fit at full width.
  // Opening it by hand pins it open until it is collapsed by hand again.
  const [requestOpen, setRequestOpen] = useState(true)
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [testResultsHidden, setTestResultsHidden] = useStoredFlag('pane.testResults.hidden')
  const testResultsPane = usePaneWidth('pane.testResults', 360, 240, 720)

  const result = props.result
  const checks = useMemo(() => buildChecks(result?.assertions ?? []), [result])
  const logs = result?.logs ?? []
  const scriptError = result?.error?.phase === 'tests' ? result.error : null
  // Anything worth the pane: checks, console output, or a script that stopped.
  const hasTests = checks.length > 0 || logs.length > 0 || scriptError !== null
  // Mark the failing line in the editor, when the failing script is this step's own.
  const errorLine = (phase: 'tests' | 'pre-request') =>
    result?.error?.phase === phase && result.error.script === 'step' ? result.error.line : undefined

  useEffect(() => {
    setSelected(null)
    setHovered(null)
    setJumpedPath(null)
    const worthRoom = (result?.assertions.length ?? 0) > 0 || (result?.logs?.length ?? 0) > 0
    if (result?.response && worthRoom && !pinnedOpen) setRequestOpen(false)
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

  const showTestResults = result?.response != null
  const columns = [
    requestOpen ? 'minmax(0, 1fr)' : 'var(--strip)',
    'minmax(0, 1fr)',
    ...(showTestResults
      ? [hasTests && !testResultsHidden ? `${testResultsPane.width}px` : 'var(--strip)']
      : [])
  ].join(' ')
  const failed = checks.filter((c) => c.assertion.status === 'fail').length + (scriptError ? 1 : 0)
  const { request } = props

  const showScript = () => {
    setRequestOpen(true)
    setPinnedOpen(true)
    setTab('tests')
  }

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
      ) : (
        <form
          className="url-bar"
          onSubmit={(event) => {
            event.preventDefault()
            props.onSend()
          }}
        >
          <select
            className="method"
            value={request.method}
            onChange={(e) => props.onChange({ method: e.target.value as HttpMethod })}
            aria-label="HTTP method"
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <VariableInput
            className="url"
            value={request.url}
            onChange={(url) => props.onChange({ url })}
            previews={props.previews}
            onCopy={props.onCopyVariable}
            placeholder="https://xtest-demo.httpsim.schwaby.io/responseStatusCode200"
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

      {request.use === null && (
        <EndpointNote
          endpoint={findEndpoint(request.method, request.url, props.endpoints)}
          using={request.base}
          onUse={(base) => props.onChange({ base })}
          onOpen={props.onOpenEndpoints}
        />
      )}

      <div className="panes" style={{ gridTemplateColumns: columns }}>
        {!requestOpen ? (
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
          <section className="pane request-pane">
            <UseStepEditor
              request={request}
              sets={props.sets}
              onChange={props.onChange}
              previews={props.previews}
              onCopyVariable={props.onCopyVariable}
              errorLine={
                result?.error?.phase === 'tests' && result.error.script === 'use'
                  ? result.error.line
                  : undefined
              }
              onCollapse={() => {
                setRequestOpen(false)
                setPinnedOpen(false)
              }}
            />
          </section>
        ) : (
          <section className="pane request-pane">
            <div className="tabs">
              <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>
                Params {paramCount > 0 && <span className="count">{paramCount}</span>}
              </button>
              <button
                className={tab === 'headers' ? 'active' : ''}
                onClick={() => setTab('headers')}
              >
                Headers {headerCount > 0 && <span className="count">{headerCount}</span>}
              </button>
              <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
                Body {request.bodyMode !== 'none' && <span className="count dot">•</span>}
              </button>
              <button
                className={tab === 'pre-request' ? 'active' : ''}
                onClick={() => setTab('pre-request')}
              >
                Pre-request{' '}
                {request.preRequest.trim() !== '' && <span className="count dot">•</span>}
              </button>
              <button className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}>
                Tests {request.tests.trim() !== '' && <span className="count dot">•</span>}
              </button>
              <button
                className={tab === 'settings' ? 'active' : ''}
                onClick={() => setTab('settings')}
              >
                Settings{' '}
                {Object.keys(request.settings).length > 0 && <span className="count dot">•</span>}
              </button>
              {props.docs && (
                <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>
                  Docs
                </button>
              )}
              <Tooltip text="Collapse the request editor to give the response more room">
                <button
                  type="button"
                  className="pane-toggle"
                  onClick={() => {
                    setRequestOpen(false)
                    setPinnedOpen(false)
                  }}
                  aria-label="Hide the request editor"
                >
                  ◂ Hide
                </button>
              </Tooltip>
            </div>

            <div className="tab-body">
              {tab === 'params' && (
                <QueryParamsEditor
                  url={request.url}
                  onUrlChange={(url) => props.onChange({ url })}
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
              )}
              {tab === 'headers' && (
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
              {tab === 'docs' && props.docs && <Markdown source={props.docs} />}
              {tab === 'settings' && (
                <SettingsTab
                  level="step"
                  own={request.settings}
                  inherited={inheritedSettings(layers)}
                  onChange={(settings) => props.onChange({ settings })}
                />
              )}
              {tab === 'tests' && (
                <div className="script-editor">
                  <p className="hint">
                    Runs after the response. xtest is built in as <code>gta</code> — type{' '}
                    <code>gta.</code> for its functions — alongside any JavaScript, <code>res</code>{' '}
                    and <code>assert</code>.
                  </p>
                  <InheritedScripts kind="tests" layers={layers} onOpen={openLayer('tests')} />
                  <CodeEditor
                    kind="tests"
                    value={request.tests}
                    onChange={(tests) => props.onChange({ tests })}
                    ariaLabel="Tests"
                    placeholder={
                      "No tests for this step yet — for example:\n  gta.expectResponseStatusCodeToBe(200)\n  gta.expectResponseBodyToHaveProperty('id', 7)"
                    }
                    errorLine={errorLine('tests')}
                  />
                </div>
              )}
              {tab === 'pre-request' && (
                <div className="script-editor">
                  <p className="hint">
                    Runs before the request is built. Set the variables the request uses with{' '}
                    <code>gta.set(name, value)</code> — for example <code>gta.uuidv7()</code> or{' '}
                    <code>gta.date(…)</code>.
                  </p>
                  <InheritedScripts
                    kind="pre-request"
                    layers={layers}
                    onOpen={openLayer('pre-request')}
                  />
                  <CodeEditor
                    kind="pre-request"
                    value={request.preRequest}
                    onChange={(preRequest) => props.onChange({ preRequest })}
                    ariaLabel="Pre-request script"
                    placeholder={
                      "No pre-request script for this step yet — for example:\n  gta.set('today', gta.date('%Y-%m-%d'))"
                    }
                    errorLine={errorLine('pre-request')}
                  />
                </div>
              )}
              {tab === 'body' && (
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

        <section className="pane">
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
          />
        </section>

        {showTestResults &&
          (hasTests && !testResultsHidden ? (
            <TestResultsPane
              checks={checks}
              selected={selected}
              onSelect={select}
              onHover={(index) => {
                setHovered(index)
                if (index !== null) setJumpedPath(null)
              }}
              onJump={jump}
              pane={testResultsPane}
              onHide={() => setTestResultsHidden(true)}
              logs={logs}
              scriptError={scriptError}
              onShowScript={showScript}
            />
          ) : (
            <button
              type="button"
              className={`pane-strip test-results-strip${failed > 0 ? ' failed' : ''}`}
              onClick={() => setTestResultsHidden(false)}
              disabled={!hasTests}
              aria-label={hasTests ? 'Show test results' : 'No test results'}
            >
              <span>
                {!hasTests
                  ? 'No test results'
                  : scriptError
                    ? '◂ Test Results · tests stopped'
                    : failed > 0
                      ? `◂ Test Results · ${failed} failed`
                      : checks.length > 0
                        ? `◂ Test Results · ${checks.length}/${checks.length}`
                        : '◂ Test Results'}
              </span>
            </button>
          ))}
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
