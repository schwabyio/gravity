import { useEffect, useRef, useState } from 'react'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  stepLabel,
  type RunResult,
  type Step,
  type StepList as ListName
} from '@schwabyio/gravity-core/model'
import type { RequestSetView } from '@shared/ipc.js'
import { resolveSet } from '../reuse.js'
import type { FlagState } from '../flagState.js'
import { formatMs } from '../format.js'
import Tooltip from './Tooltip.js'
import { useMenuDismiss } from '../hooks/useMenuDismiss.js'

/** A button under the list that adds a step. */
export interface AddAction {
  label: string
  onClick: () => void
  disabled?: boolean
  /** What it does, or why it is off. */
  tooltip?: string
}

interface Props {
  /** Which of the collection's lists this is: `steps`, or `setup` or `teardown`. */
  list: ListName
  steps: Step[]
  /** Step indexes to show; the rest are filtered out, but keep their numbers. */
  visible: Set<number>
  /** Show each step's tags: the collection has step tags on. */
  showTags: boolean
  /** The selected step's index when it is in this list; -1 when it is not. */
  selectedIndex: number
  /** Last result per step index, filled in as a run proceeds. */
  results: Record<number, RunResult>
  /** The step currently executing, during a run, if it is in this list. */
  runningIndex: number | null
  /** A run is in flight, whichever list it is in: nothing else may start. */
  busy: boolean
  /** Step indexes with unsaved edits. */
  draftIndexes: Set<number>
  onSelect: (index: number) => void
  onRun: (index: number) => void
  /** The buttons under the list that add steps. */
  adds: AddAction[]
  /** Request sets a use step can run. */
  sets: RequestSetView[]
  /** For each use step, by index: its set's results, one per request. */
  childResults: Record<number, Array<RunResult | undefined>>
  /** For each `forEach` step, by index: one result per item, in order. */
  itemResults: Record<number, RunResult[]>
  /** Which request of a use step is shown, and a way to show another. */
  selectedChild: number
  onSelectChild: (index: number, child: number) => void
  onRename: (index: number, name: string) => void
  onDuplicate: (index: number) => void
  onDelete: (index: number) => void
  onMove: (index: number, to: number) => void
  /** Per step: whether its feature flags skip it, or name a flag nobody declared. */
  flagStates?: Record<number, FlagState>
}

const statusClass = (result: RunResult): string => {
  if (result.status === 'pass') return 'ok'
  if (result.status === 'fail') return 'client'
  if (result.status === 'skipped') return 'skipped'
  return 'server'
}

/** A use step's status, from its requests': an error beats a failure beats a pass. */
function setStatusClass(ran: RunResult[], count: number): string {
  if (ran.some((result) => result.status === 'error')) return 'server'
  if (ran.some((result) => result.status === 'fail')) return 'client'
  return ran.length === count ? 'ok' : 'idle'
}

/**
 * The steps of a collection: each runnable on its own, and the place to add,
 * rename, duplicate, delete and reorder them — by drag, or from each step's
 * menu for the keyboard.
 */
export default function StepList(props: Props) {
  const [renaming, setRenaming] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const count = props.steps.length

  // A click anywhere else, or another menu opening, closes an open step menu.
  const menus = useMenuDismiss(menu !== null, () => setMenu(null))

  const confirmDelete = (index: number) => {
    const step = props.steps[index]
    if (step && window.confirm(`Delete “${stepLabel(step)}”? This removes it from the file.`)) {
      props.onDelete(index)
    }
  }

  return (
    <div className="step-list-wrap">
      <ol
        className="step-list"
        aria-label={props.list === 'steps' ? 'Steps' : `${props.list} steps`}
      >
        {props.steps.map((step, index) => {
          const use = isUseStep(step) ? step : null
          const set = use ? resolveSet(props.sets, use.use) : null
          const { method, url } = use
            ? { method: 'USE', url: set ? set.path : `no request set called ${use.use}` }
            : isReadStep(step)
              ? { method: 'READ', url: `connection ${step.connection}` }
              : readRequestLine(step)
          const children = use ? (props.childResults[index] ?? []) : []
          const ran = children.filter((child): child is RunResult => child !== undefined)
          // A forEach step reports once per item: counted like a use step's requests.
          const items = props.itemResults[index] ?? []
          const itemCount = items[0]?.forEach?.of ?? 0
          // A use step's own result is only ever a reason it could not run.
          const result = use
            ? ran.length > 0
              ? undefined
              : props.results[index]
            : props.results[index]
          const isRunning = props.runningIndex === index
          const flagState = props.flagStates?.[index] ?? null
          const classes = [
            index === props.selectedIndex ? 'selected' : '',
            flagState?.kind === 'skip' ? 'flag-skipped' : '',
            flagState?.kind === 'error' ? 'flag-error' : '',
            dragging === index ? 'dragging' : '',
            dropAt === index && dragging !== null && dragging !== index ? 'drop-before' : ''
          ]

          if (!props.visible.has(index)) return null
          const tags = props.showTags ? (step.tags ?? []) : []

          return (
            <li
              key={index}
              className={classes.join(' ')}
              draggable={renaming === null}
              onDragStart={(event) => {
                setDragging(index)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', String(index))
              }}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                setDropAt(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null && dragging !== index) {
                  props.onMove(dragging, dragging < index ? index - 1 : index)
                }
                setDragging(null)
                setDropAt(null)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
            >
              {renaming === index ? (
                <RenameField
                  initial={step.name ?? ''}
                  placeholder={stepLabel(step)}
                  onDone={(name) => {
                    setRenaming(null)
                    if (name !== null && name !== (step.name ?? '')) props.onRename(index, name)
                  }}
                />
              ) : (
                <button
                  className="step-open"
                  onClick={() => props.onSelect(index)}
                  onDoubleClick={() => setRenaming(index)}
                  title={url}
                >
                  <span className="step-seq">{index + 1}</span>
                  <span className={`method m-${method.toLowerCase()}`}>{method}</span>
                  <span className="step-name">
                    {use && set && !use.name ? set.title : stepLabel(step)}
                    {flagState && (
                      <span
                        className={`step-flag ${flagState.kind}`}
                        title={
                          flagState.kind === 'skip'
                            ? `Skipped: ${flagState.reason}`
                            : flagState.message
                        }
                        aria-label={
                          flagState.kind === 'skip'
                            ? `skipped: ${flagState.reason}`
                            : `flag error: ${flagState.message}`
                        }
                      >
                        {flagState.kind === 'skip' ? 'skipped' : 'flag?'}
                      </span>
                    )}
                    {props.draftIndexes.has(index) && (
                      <span className="step-dirty" title="Unsaved changes">
                        •
                      </span>
                    )}
                  </span>
                </button>
              )}
              {tags.length > 0 && (
                <div className="step-tags">
                  {tags.map((tag) => (
                    <span key={tag} className="tag small">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="step-foot">
                <Tooltip text="Run this step on its own, with a fresh variable scope">
                  <button
                    className="step-run"
                    onClick={() => props.onRun(index)}
                    disabled={props.busy}
                    aria-label={`Run ${stepLabel(step)}`}
                  >
                    ▶
                  </button>
                </Tooltip>

                {isRunning ? (
                  <span className="step-status running">running…</span>
                ) : ran.length > 0 ? (
                  <span className={`step-status ${setStatusClass(ran, children.length)}`}>
                    {`${ran.filter((child) => child.status === 'pass').length} of ${children.length} passed`}
                  </span>
                ) : items.length > 0 ? (
                  <span
                    className={`step-status ${setStatusClass(items, itemCount)}`}
                    title={`One request for each of ${itemCount} item${itemCount === 1 ? '' : 's'}`}
                  >
                    {`${items.filter((item) => item.status === 'pass').length} of ${itemCount} passed`}
                  </span>
                ) : result ? (
                  <span
                    className={`step-status ${statusClass(result)}`}
                    title={result.skipped?.reason ?? result.error?.message}
                  >
                    {result.response
                      ? `${result.response.status} · ${formatMs(result.durationMs)}`
                      : result.skipped
                        ? 'skipped'
                        : (result.error?.message ?? 'failed')}
                  </span>
                ) : (
                  <span className="step-status idle">—</span>
                )}

                <button
                  type="button"
                  className="step-menu-button"
                  aria-label={`More actions for ${stepLabel(step)}`}
                  aria-haspopup="menu"
                  aria-expanded={menu === index}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (menu !== index) menus.opened()
                    setMenu(menu === index ? null : index)
                  }}
                >
                  ⋯
                </button>
                {menu === index && (
                  <div className="step-menu" role="menu">
                    <MenuItem label="Rename" onClick={() => setRenaming(index)} />
                    <MenuItem label="Duplicate" onClick={() => props.onDuplicate(index)} />
                    <MenuItem
                      label="Move up"
                      disabled={index === 0}
                      onClick={() => props.onMove(index, index - 1)}
                    />
                    <MenuItem
                      label="Move down"
                      disabled={index === count - 1}
                      onClick={() => props.onMove(index, index + 1)}
                    />
                    <MenuItem label="Delete" danger onClick={() => confirmDelete(index)} />
                  </div>
                )}
              </div>

              {use && (
                <ol className="use-children" aria-label={`Requests of ${stepLabel(step)}`}>
                  {!set && (
                    <li className="use-missing" role="alert">
                      No request set called {use.use}
                    </li>
                  )}
                  {set?.steps.map((child, number) => {
                    const childResult = children[number]
                    const shown = index === props.selectedIndex && number === props.selectedChild
                    return (
                      <li key={number} className={shown ? 'shown' : ''}>
                        <button
                          type="button"
                          className="use-child"
                          onClick={() => props.onSelectChild(index, number)}
                        >
                          <span className={`method m-${child.method.toLowerCase()}`}>
                            {child.method}
                          </span>
                          <span className="use-child-name">{child.label}</span>
                          {childResult && (
                            <span className={`step-status ${statusClass(childResult)}`}>
                              {childResult.response
                                ? String(childResult.response.status)
                                : childResult.status}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
      <div className="add-steps">
        {props.adds.map((add) => {
          const button = (
            <button
              key={add.label}
              type="button"
              className="add-step"
              onClick={add.onClick}
              disabled={add.disabled}
            >
              {add.label}
            </button>
          )
          return add.tooltip ? (
            <Tooltip key={add.label} text={add.tooltip}>
              {button}
            </Tooltip>
          ) : (
            button
          )
        })}
      </div>
    </div>
  )
}

function MenuItem(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={props.danger ? 'danger' : ''}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

/** Inline rename: Enter or leaving the field keeps it, Escape abandons it. */
function RenameField(props: {
  initial: string
  placeholder: string
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = useState(props.initial)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    props.onDone(name === null ? null : name.trim())
  }

  return (
    <input
      ref={input}
      className="step-rename"
      aria-label="Step name"
      value={value}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}
