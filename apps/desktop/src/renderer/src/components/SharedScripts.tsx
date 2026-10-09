import { useState } from 'react'
import type { IgnoredPath, RunResult } from '@schwabyio/gravity-core/model'
import type { CheckFileView, EditorTarget } from '@shared/ipc.js'
import { checkLines, madeIn, type ScriptOf } from '../checkLines.js'
import { calledChecks, checkFileName } from '../checkSources.js'
import type { InheritedLayer } from '../inheritance.js'
import CodeEditor from './CodeEditor.js'
import OpenInEditor from './OpenInEditor.js'

type Kind = 'pre-request' | 'tests'

interface Props {
  kind: Kind
  /** The layers around the step, outermost first; those with a script of this kind run first. */
  layers: InheritedLayer[]
  onOpen: (layer: InheritedLayer) => void
  /** The step's own script, for the check files it calls. */
  own: string
  checkFiles: CheckFileView[]
  result: RunResult | null
  /** The step's collection file: where the collection's own scripts are written. */
  collectionPath: string | null
  /** The check selected, and what a click on a check's mark does: as in the step's own. */
  selected?: number | null
  onPickCheck?: (about: number[]) => void
}

/** Where a layer's script is written, for the external editor: its file, and the step it is in. */
export function layerScriptTarget(
  layer: InheritedLayer,
  script: Kind,
  collectionPath: string | null
): EditorTarget | null {
  if (layer.kind === 'endpoint' && layer.endpoint) {
    return {
      path: layer.endpoint.filePath,
      step: { list: 'steps', index: layer.endpoint.index },
      script
    }
  }
  const path =
    layer.kind === 'endpoint-file'
      ? layer.endpoint?.filePath
      : layer.kind === 'base'
        ? layer.path
        : collectionPath
  return path ? { path, script } : null
}

const NOTHING = (): void => {}

/**
 * The scripts that run around a step's own, shown where its own is written
 * (SPEC.md §2.6): each layer's `before.script` or `tests`, in the order they
 * run, then the check files any of them call — each folded to a line that says
 * how its checks went, opened to read its code, marked line by line as the
 * step's own is. One with a failure or an error opens by itself.
 */
export default function SharedScripts(props: Props) {
  const { kind, result } = props
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  /** "Open in …" for a script written elsewhere: an icon, its name on hover. */
  const external = (what: string, target: EditorTarget | null) => (
    <OpenInEditor what={what} target={target} />
  )
  const scriptOf = (layer: InheritedLayer) =>
    (kind === 'pre-request' ? layer.before?.script : layer.tests) ?? ''
  const running = props.layers.filter((layer) => scriptOf(layer).trim() !== '')
  const called = calledChecks([props.own, ...running.map(scriptOf)].join('\n'))
  const files = called.flatMap((name) => props.checkFiles.filter((file) => file.name === name))
  if (running.length === 0 && files.length === 0) return null

  const what = kind === 'pre-request' ? 'pre-request script' : 'tests'
  const yields = kind === 'tests' && running.some((layer) => layer.endpoint && layer.used)
  const assertions = result?.assertions ?? []
  const ignored: IgnoredPath[] = result?.ignored ?? []

  /** What a script's own checks came to, and where its error stopped it. */
  const verdict = (of: ScriptOf) => {
    const made = kind === 'tests' ? madeIn(assertions, of) : []
    const error =
      result?.error?.phase === kind && typeof of === 'string' && result.error.script === of
        ? result.error
        : null
    return { made, failed: made.filter((a) => a.status === 'fail').length, error }
  }

  const row = (
    key: string,
    of: ScriptOf,
    code: string,
    label: React.ReactNode,
    extra?: React.ReactNode
  ) => {
    const { made, failed, error } = verdict(of)
    const open = toggled[key] ?? (failed > 0 || error !== null)
    return (
      <>
        <div className="shared-script-head">
          <button
            type="button"
            className="shared-script-toggle"
            aria-expanded={open}
            onClick={() => setToggled({ ...toggled, [key]: !open })}
          >
            {label}
          </button>
          {error ? (
            <span className="script-chip error" title={error.message}>
              !
            </span>
          ) : made.length > 0 ? (
            <span
              className={`script-chip ${failed > 0 ? 'fail' : 'pass'}`}
              title={
                failed > 0
                  ? `${failed} of ${made.length} checks failed`
                  : `${made.length} check${made.length === 1 ? '' : 's'} passed`
              }
            >
              {failed > 0 ? `✕ ${failed} of ${made.length}` : `✓ ${made.length}`}
            </span>
          ) : null}
          {extra}
        </div>
        {open && (
          <CodeEditor
            readOnly
            kind={kind}
            checkFile={typeof of === 'object'}
            value={code}
            onChange={NOTHING}
            ariaLabel={`${key}, read only`}
            {...(kind === 'tests'
              ? {
                  checks: checkLines(assertions, of, ignored),
                  selected: props.selected ?? null,
                  ...(props.onPickCheck ? { onPickCheck: props.onPickCheck } : {})
                }
              : {})}
            errorLine={error?.line}
          />
        )}
      </>
    )
  }

  return (
    <div className="shared-scripts">
      {running.length > 0 && (
        <div
          className="collection-script-note"
          role="note"
          aria-label={
            kind === 'pre-request' ? 'Scripts before this step’s' : 'Tests before this step’s'
          }
        >
          {kind === 'pre-request'
            ? 'Before this step’s script, these run in order:'
            : 'After the response, before this step’s tests, these run in order:'}
          <ol>
            {running.map((layer) => (
              <li key={layer.kind} className={layer.used ? '' : 'unused'}>
                {row(
                  `The ${layer.title}’s ${what}`,
                  layer.kind,
                  scriptOf(layer),
                  <>
                    the {layer.title}&rsquo;s
                    {layer.name && (
                      <>
                        {' '}
                        <code className="layer-name">{layer.name}</code>
                      </>
                    )}
                    {layer.shared && <span className="shared-tag">shared</span>}
                    {!layer.used && <span className="layer-off">not used by this step</span>}
                  </>,
                  <>
                    <button
                      type="button"
                      className="link"
                      onClick={() => props.onOpen(layer)}
                      aria-label={`Open the ${layer.title}’s ${what}`}
                    >
                      Open
                    </button>
                    {external(
                      `the ${layer.title}’s ${what}`,
                      layerScriptTarget(layer, kind, props.collectionPath)
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {yields && (
            <span>
              The endpoint base&rsquo;s checks give way to this step&rsquo;s own checks of the same
              thing.
            </span>
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="collection-script-note" role="note" aria-label="Check files called">
          {kind === 'pre-request'
            ? 'Check files these scripts call:'
            : 'Check files these tests call:'}
          <ol>
            {files.map((file) => (
              <li key={file.filename}>
                {row(
                  `The check file ${checkFileName(file.filename)}`,
                  { file: file.filename },
                  file.code,
                  <>
                    <code className="layer-name">{checkFileName(file.filename)}</code>
                    {file.shared && <span className="shared-tag">shared</span>}
                  </>,
                  external(checkFileName(file.filename), { path: file.path })
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
