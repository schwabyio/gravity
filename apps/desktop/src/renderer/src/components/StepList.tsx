import { useEffect, useRef, useState } from 'react'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  stepLabel,
  type RuleFinding,
  type RunResult,
  type Step,
  type StepList as ListName
} from '@schwabyio/gravity-core/model'
import type { RequestSetView } from '@shared/ipc.js'
import { resolveSet } from '../reuse.js'
import type { FlagState } from '../flagState.js'
import { STEP_CHANGE_WORDS, type StepChange } from '../stepChanges.js'
import { movedTo, type StepDrop } from '../stepDrop.js'
import {
  MARK_GLYPHS,
  MARK_NAMES,
  stepOutcome,
  type StepHover,
  type StepOutcome
} from '../stepOutcome.js'
import RuleMark from './RuleMark.js'
import Tooltip from './Tooltip.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'
import { useExternalEditor } from '../externalEditor.js'

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
  /** The file the steps are written in, for each step's "Open in …". */
  path: string
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
  /** Step indexes with unsaved edits. */
  draftIndexes: Set<number>
  /** What changed of each step since the last commit, by index; absent with nothing to compare. */
  changes?: Array<StepChange | null>
  /** How many of the last commit's steps of this list are gone. */
  removed?: number
  onSelect: (index: number) => void
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
  /** Delete several steps of this list at once: those picked together. */
  onDeleteMany: (indexes: number[]) => void
  onMove: (index: number, to: number) => void
  /** Per step: whether its feature flags skip it, or name a flag nobody declared. */
  flagStates?: Record<number, FlagState>
  /** Per step: where it breaks the project's rules (SPEC.md §1.4). */
  findings?: Record<number, RuleFinding[]>
}

const NONE: ReadonlySet<number> = new Set()
const NO_FINDINGS: RuleFinding[] = []

/** The key that picks one more, as the platform has it: ⌘ on a Mac, Ctrl elsewhere. */
const picksWith = (event: React.MouseEvent | React.KeyboardEvent): boolean =>
  navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey

/**
 * The steps of a collection: each one's last result at a glance, and the
 * place to add, rename, duplicate, delete and reorder them — by drag, or from
 * each step's menu for the keyboard; several picked together are deleted at
 * once. A step runs on its own by Send.
 */
export default function StepList(props: Props) {
  const [renaming, setRenaming] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  /** Where a drag would put its step: before or after the step under the pointer. */
  const [dropAt, setDropAt] = useState<StepDrop | null>(null)
  const count = props.steps.length
  const editor = useExternalEditor()

  /**
   * Steps picked together, the selected one among them, for a menu that acts
   * on them all: ⌘- or Ctrl-click adds or drops one, Shift-click a run from
   * the selected step, ⌘A or Ctrl+A every step shown. A plain click, the
   * arrows or Escape leave just the one selected; a step added or removed
   * moves the indexes, so the picks go too.
   */
  const [picked, setPicked] = useState<ReadonlySet<number>>(NONE)
  useEffect(() => setPicked(NONE), [count])
  const shown = () => [...Array(count).keys()].filter((index) => props.visible.has(index))
  const togglePick = (index: number) =>
    setPicked((current) => {
      const next = new Set(
        current.size > 0 ? current : props.selectedIndex >= 0 ? [props.selectedIndex] : []
      )
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const pickRun = (index: number) => {
    const from = props.selectedIndex >= 0 ? props.selectedIndex : index
    const [low, high] = from < index ? [from, index] : [index, from]
    setPicked(new Set(shown().filter((at) => at >= low && at <= high)))
  }
  /** Whether a menu opened on this step acts on every picked step. */
  const forPicked = (index: number) => picked.size > 1 && picked.has(index)

  // A click anywhere else, or another menu opening, closes an open step menu.
  const menus = useMenuDismiss(menu !== null, () => setMenu(null))
  const openMenu = (index: number) => {
    if (!forPicked(index)) setPicked(NONE)
    if (menu !== index) menus.opened()
    setMenu(index)
  }

  const confirmDelete = (index: number) => {
    const step = props.steps[index]
    if (step && window.confirm(`Delete “${stepLabel(step)}”? This removes it from the file.`)) {
      props.onDelete(index)
    }
  }

  const confirmDeleteMany = () => {
    const indexes = [...picked].sort((a, b) => a - b)
    if (window.confirm(`Delete ${indexes.length} steps? This removes them from the file.`)) {
      setPicked(NONE)
      props.onDeleteMany(indexes)
    }
  }

  return (
    <div className="step-list-wrap">
      <ol
        className="step-list"
        aria-label={props.list === 'steps' ? 'Steps' : `${props.list} steps`}
        onKeyDown={(event) => {
          if (!(event.target as HTMLElement).classList.contains('step-open')) return
          if (picksWith(event) && event.key.toLowerCase() === 'a') {
            // Every step shown, not the window's text.
            event.preventDefault()
            setPicked(new Set(shown()))
          } else if (event.key === 'Escape' && picked.size > 0) {
            event.stopPropagation()
            setPicked(NONE)
          } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            setPicked(NONE)
          }
        }}
      >
        {props.steps.map((step, index) => {
          const use = isUseStep(step) ? step : null
          const set = use ? resolveSet(props.sets, use.use) : null
          const { method, url } = use
            ? { method: 'USE', url: set ? set.path : `no reusable requests called ${use.use}` }
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
            picked.has(index) ? 'picked' : '',
            flagState?.kind === 'skip' ? 'flag-skipped' : '',
            flagState?.kind === 'error' ? 'flag-error' : '',
            dragging === index ? 'dragging' : '',
            dropAt?.index === index && dragging !== null && movedTo(dragging, dropAt) !== dragging
              ? dropAt.after
                ? 'drop-after'
                : 'drop-before'
              : ''
          ]

          if (!props.visible.has(index)) return null
          const tags = props.showTags ? (step.tags ?? []) : []

          const change = props.changes?.[index] ?? null
          // A use step's requests count first, then a forEach step's items, then its own result.
          const outcome = stepOutcome({
            running: isRunning,
            result,
            parts: ran.length > 0 ? ran : items,
            expected: ran.length > 0 ? children.length : itemCount,
            partsAre: ran.length > 0 ? 'request' : 'item'
          })
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
                // The lower half of a step drops after it: the only way to the end of the list.
                const { top, height } = event.currentTarget.getBoundingClientRect()
                const after = event.clientY > top + height / 2
                if (dropAt?.index !== index || dropAt.after !== after) setDropAt({ index, after })
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null && dropAt) {
                  const to = movedTo(dragging, dropAt)
                  if (to !== dragging) props.onMove(dragging, to)
                }
                setDragging(null)
                setDropAt(null)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
              onContextMenu={onRightClick(() => openMenu(index))}
            >
              {change && (
                <span
                  className={`step-git ${change}`}
                  role="img"
                  aria-label={STEP_CHANGE_WORDS[change]}
                  title={STEP_CHANGE_WORDS[change]}
                />
              )}
              <div className="step-head">
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
                    onClick={(event) => {
                      if (picksWith(event)) return togglePick(index)
                      if (event.shiftKey) return pickRun(index)
                      setPicked(NONE)
                      props.onSelect(index)
                    }}
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
                      <RuleMark findings={props.findings?.[index] ?? NO_FINDINGS} />
                      {props.draftIndexes.has(index) && (
                        <span className="step-dirty" title="Unsaved changes">
                          •
                        </span>
                      )}
                    </span>
                    <StepResult outcome={outcome} />
                  </button>
                )}
                <span className="step-menu-wrap">
                  <button
                    type="button"
                    className="step-menu-button"
                    aria-label={`More actions for ${stepLabel(step)}`}
                    aria-haspopup="menu"
                    aria-expanded={menu === index}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (menu === index) setMenu(null)
                      else openMenu(index)
                    }}
                  >
                    ⋯
                  </button>
                  {menu === index && forPicked(index) ? (
                    <div className="step-menu" role="menu">
                      <MenuItem
                        label={
                          picked.size === shown().length
                            ? `Delete all ${picked.size} steps`
                            : `Delete ${picked.size} steps`
                        }
                        danger
                        onClick={confirmDeleteMany}
                      />
                    </div>
                  ) : menu === index ? (
                    <div className="step-menu" role="menu">
                      <MenuItem label="Rename" onClick={() => setRenaming(index)} />
                      <MenuItem label="Duplicate" onClick={() => props.onDuplicate(index)} />
                      {editor && (
                        <MenuItem
                          label={editor.label}
                          onClick={() =>
                            editor.open({ path: props.path, step: { list: props.list, index } })
                          }
                        />
                      )}
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
                  ) : null}
                </span>
              </div>
              {tags.length > 0 && (
                <div className="step-tags">
                  {tags.map((tag) => (
                    <span key={tag} className="tag small">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {outcome.detail !== null && (
                <div className="step-foot">
                  <span className="step-status" title={outcome.detail}>
                    {outcome.detail}
                  </span>
                </div>
              )}

              {use && (
                <ol className="use-children" aria-label={`Requests of ${stepLabel(step)}`}>
                  {!set && (
                    <li className="use-missing" role="alert">
                      No reusable requests called {use.use}
                    </li>
                  )}
                  {set?.steps.map((child, number) => {
                    const childResult = children[number]
                    const shown = index === props.selectedIndex && number === props.selectedChild
                    // A run clears its step's results first, so the first without one is running.
                    const childOutcome = stepOutcome({
                      running: isRunning && number === children.indexOf(undefined),
                      result: childResult,
                      parts: [],
                      expected: 0
                    })
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
                          {/* No line under it: an error or a skip's reason is on hover. */}
                          <StepResult outcome={childOutcome} />
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
      {(props.removed ?? 0) > 0 && (
        <p className="hint steps-removed">
          {props.removed} step{props.removed === 1 ? '' : 's'} removed since the last commit
        </p>
      )}
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

/** A step's result, explained on hover: how many of its checks passed, and which failed. */
/**
 * A step's last run, at the end of its line: its status and time, then its
 * verdict, explained on hover. Nothing before it has run.
 */
function StepResult({ outcome }: { outcome: StepOutcome }) {
  if (outcome.summary === null && outcome.mark === null) return null
  return (
    <ResultHover hover={outcome.hover}>
      {/* An empty title keeps the row's own, its URL, from showing too. */}
      <span className="step-result" title="">
        {outcome.summary !== null && <span className="step-summary">{outcome.summary}</span>}
        {outcome.mark ? (
          <span
            className={`step-mark ${outcome.mark}`}
            role="img"
            aria-label={MARK_NAMES[outcome.mark]}
          >
            {MARK_GLYPHS[outcome.mark]}
          </span>
        ) : (
          // No verdict, its place kept, so statuses and times line up down the list.
          <span className="step-mark-space" />
        )}
      </span>
    </ResultHover>
  )
}

function ResultHover(props: {
  hover: StepHover | null
  children: React.ReactElement<Record<string, unknown>>
}) {
  if (!props.hover) return props.children
  const { title, lines } = props.hover
  return (
    <Tooltip
      wide
      text={
        <>
          <strong className="step-hover-title">{title}</strong>
          {lines.map((line, index) => (
            <span key={index} className="step-hover-line">
              {line}
            </span>
          ))}
        </>
      }
    >
      {props.children}
    </Tooltip>
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
