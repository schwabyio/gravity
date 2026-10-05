import { useState } from 'react'
import {
  groupByDirectory,
  type CollectionNode,
  type CollectionSummary,
  type RuleFinding
} from '@schwabyio/gravity-core/model'
import type { ProjectView } from '@shared/ipc.js'
import { MARK_WORDS, type GitMarks } from '../gitMarks.js'
import { findingsOf } from '../ruleFindings.js'
import GitBadge from './GitBadge.js'
import NameForm from './NameForm.js'
import RuleMark from './RuleMark.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'
import { useExternalEditor } from '../externalEditor.js'

/** What can be done to a collection from its row; each resolves to a refusal to show, or null. */
export interface CollectionActions {
  /** The projects a collection can be copied or moved to. */
  targets: ProjectView[]
  onRename: (collection: CollectionSummary, id: string) => Promise<string | null>
  onTransfer: (
    collection: CollectionSummary,
    projectId: string,
    directory: string | null,
    move: boolean
  ) => Promise<string | null>
  onDelete: (collection: CollectionSummary) => void
  /** Move a collection to another folder of its project; null for the root of `collections/`. */
  onMoveToFolder: (collection: CollectionSummary, folder: string | null) => Promise<string | null>
  /** Open the collection with a new step at the end, ready to edit. */
  onNewRequest: (collection: CollectionSummary) => void
  /** Make a request set called `id` in `requests/`, and a step of the collection that uses it. */
  onNewRequestSet: (collection: CollectionSummary, id: string) => Promise<string | null>
  /** Rename a folder of `collections/`, with everything in it. */
  onRenameFolder: (folder: string, name: string) => Promise<string | null>
  /** Delete a folder of `collections/` and everything in it, once confirmed. */
  onDeleteFolder: (folder: string) => void
  /** Start a new collection in a folder: from its menu, or an empty one's shortcut. */
  onNewCollectionIn: (folder: string) => void
}

/**
 * Dragging a collection to another folder of its project: rows start a drag,
 * and every row is somewhere to drop — a folder's row and the collections in
 * it into that folder, a collection at the root into the root.
 */
export interface FolderDrag {
  /** Where it would land now: a folder, null for the root, undefined for nowhere. */
  over: string | null | undefined
  onStart: (collection: CollectionSummary) => void
  onEnd: () => void
  /** What makes an element somewhere to drop into `folder`. */
  zone: (folder: string | null) => Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDrop'>
}

interface Props {
  collections: CollectionSummary[]
  /** Directories inside `collections/`, shown even while empty. */
  directories: string[]
  /** Every folder of the project, whatever a filter shows: where a collection can move. */
  folders: string[]
  /** What git says of each file and folder: changed, new or in conflict. */
  marks: GitMarks
  /** Where the project's files and folders break its rules (SPEC.md §1.4). */
  findings: RuleFinding[]
  drag: FolderDrag
  selectedPath: string | null
  onSelect: (collection: CollectionSummary) => void
  /** Every directory shown open, as while a filter narrows the list. */
  expanded?: boolean
  actions: CollectionActions
}

/** What a folder's dot says of what is in it. */
const FOLDER_WORDS: Record<NonNullable<ReturnType<GitMarks['folder']>>, string> = {
  modified: 'changed since the last commit',
  new: 'new, not committed yet',
  conflicted: 'in conflict'
}

/** A row's menu open, or one of its forms: a collection's by its path, a folder's by `folder:<name>`. */
type Acting = {
  path: string
  kind: 'menu' | 'rename' | 'copy' | 'move' | 'set' | 'folder'
} | null

/**
 * A project's collections: each directory, one level deep, with the
 * collections in it, then those at the root of `collections/`. The
 * `collections/` segment every path shares is never shown. Each row has a
 * menu: a collection's to add a request or a new request set to it, rename
 * it, copy or move it to another project, or delete it; a folder's to make a collection in it, or rename or delete it
 * with everything in it.
 */
export default function CollectionList(props: Props) {
  const [acting, setActing] = useState<Acting>(null)

  // A click anywhere else, or a menu opening elsewhere, closes a row's menu — not its form.
  const menus = useMenuDismiss(acting?.kind === 'menu', () =>
    setActing((current) => (current?.kind === 'menu' ? null : current))
  )

  const row = (summary: CollectionSummary, depth: number) => (
    <CollectionRow
      key={summary.path}
      summary={summary}
      depth={depth}
      selected={summary.path === props.selectedPath}
      onSelect={props.onSelect}
      acting={acting?.path === summary.path ? acting.kind : null}
      onAct={(kind) => {
        if (kind === 'menu') menus.opened()
        setActing(kind ? { path: summary.path, kind } : null)
      }}
      actions={props.actions}
      folders={props.folders}
      drag={props.drag}
      marks={props.marks}
      findings={findingsOf(props.findings, `collections/${summary.relativePath}`)}
    />
  )

  return (
    <>
      {groupByDirectory(props.collections, props.directories).map((node) =>
        node.kind === 'directory' ? (
          <Directory
            key={`dir:${node.name}`}
            node={node}
            expanded={props.expanded ?? false}
            row={row}
            acting={acting?.path === `folder:${node.name}` ? acting.kind : null}
            onAct={(kind) => {
              if (kind === 'menu') menus.opened()
              setActing(kind ? { path: `folder:${node.name}`, kind } : null)
            }}
            actions={props.actions}
            drag={props.drag}
            marks={props.marks}
            findings={findingsOf(props.findings, `collections/${node.name}/`)}
          />
        ) : (
          row(node.summary, 0)
        )
      )}
    </>
  )
}

function CollectionRow(props: {
  summary: CollectionSummary
  depth: number
  selected: boolean
  onSelect: Props['onSelect']
  acting: NonNullable<Acting>['kind'] | null
  onAct: (kind: NonNullable<Acting>['kind'] | null) => void
  actions: CollectionActions
  folders: string[]
  drag: FolderDrag
  marks: GitMarks
  /** Its own rule findings, its steps' too. */
  findings: RuleFinding[]
}) {
  const { summary, actions } = props
  const mark = props.marks.collection(summary)
  const editor = useExternalEditor()
  /** Where it could move in its project: the root, unless it is there, and every other folder. */
  const elsewhere = [
    ...(summary.directory !== null ? [null] : []),
    ...props.folders.filter((folder) => folder !== summary.directory)
  ]
  const item = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'danger' : ''}
      onClick={(event) => {
        event.stopPropagation()
        action()
      }}
    >
      {label}
    </button>
  )

  if (props.acting === 'set') {
    return (
      <NameForm
        label={`New reusable requests file id, used in ${summary.name}`}
        placeholder="Reusable requests file id, its file name"
        submitLabel="Create"
        onSubmit={async (id) => {
          const refused = await actions.onNewRequestSet(summary, id)
          if (refused === null) props.onAct(null)
          return refused
        }}
        onCancel={() => props.onAct(null)}
      />
    )
  }

  if (props.acting === 'rename') {
    return (
      <NameForm
        label={`New id for ${summary.name}`}
        placeholder="Collection id, its file name"
        initial={summary.name}
        submitLabel="Rename"
        onSubmit={async (id) => {
          const refused = await actions.onRename(summary, id)
          if (refused === null) props.onAct(null)
          return refused
        }}
        onCancel={() => props.onAct(null)}
      />
    )
  }

  return (
    <>
      <div
        className={`collection-item${props.selected ? ' selected' : ''}${props.acting === 'menu' ? ' menu-open' : ''}`}
        style={{ paddingLeft: props.depth * 14 }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', summary.relativePath)
          props.drag.onStart(summary)
        }}
        onDragEnd={props.drag.onEnd}
        {...props.drag.zone(summary.directory)}
        onContextMenu={onRightClick(() => props.onAct('menu'))}
      >
        <button
          className={`row collection-row${props.selected ? ' selected' : ''}${summary.excluded ? ' excluded' : ''}`}
          onClick={() => props.onSelect(summary)}
          title={[
            summary.relativePath,
            summary.excluded ? 'excluded from group runs' : null,
            mark ? MARK_WORDS[mark].toLowerCase() : null
          ]
            .filter(Boolean)
            .join(' — ')}
        >
          <span className="label">{summary.name}</span>
          {/* Only a problem, or being left out of group runs, is worth a mark here.
              The step count is on the collection itself, a click away. */}
          {summary.dataFile && (
            <span
              className="data-mark"
              aria-label={`data file, ${summary.dataFile.rows} rows`}
              title={`Runs once per row of ${summary.dataFile.relativePath} (${summary.dataFile.rows})`}
            >
              ×{summary.dataFile.rows}
            </span>
          )}
          {summary.excluded && (
            <span className="excluded-mark" aria-label="excluded from group runs">
              ⊘
            </span>
          )}
          {summary.problems.length > 0 && (
            <span className="problem" title={summary.problems.map((p) => p.message).join('\n')}>
              !
            </span>
          )}
          <RuleMark findings={props.findings} />
          <GitBadge mark={mark} />
        </button>
        <span className="project-menu-wrap">
          <button
            type="button"
            className="collection-menu-button"
            aria-label={`Collection actions for ${summary.name}`}
            aria-haspopup="menu"
            aria-expanded={props.acting === 'menu'}
            onClick={(event) => {
              event.stopPropagation()
              props.onAct(props.acting === 'menu' ? null : 'menu')
            }}
          >
            ⋯
          </button>
          {props.acting === 'menu' && (
            <div className="project-menu" role="menu">
              {item('New request', () => {
                props.onAct(null)
                actions.onNewRequest(summary)
              })}
              {item('New reusable requests file', () => props.onAct('set'))}
              {item('Rename', () => props.onAct('rename'))}
              {editor &&
                item(editor.label, () => {
                  props.onAct(null)
                  editor.open({ path: summary.path })
                })}
              {elsewhere.length > 0 && item('Move to folder…', () => props.onAct('folder'))}
              {actions.targets.length > 0 && item('Copy to project…', () => props.onAct('copy'))}
              {actions.targets.length > 0 && item('Move to project…', () => props.onAct('move'))}
              {item(
                'Delete',
                () => {
                  props.onAct(null)
                  actions.onDelete(summary)
                },
                true
              )}
            </div>
          )}
        </span>
      </div>
      {props.acting === 'folder' && (
        <FolderForm
          summary={summary}
          folders={elsewhere}
          onSubmit={(folder) => actions.onMoveToFolder(summary, folder)}
          onDone={() => props.onAct(null)}
        />
      )}
      {(props.acting === 'copy' || props.acting === 'move') && (
        <TransferForm
          summary={summary}
          move={props.acting === 'move'}
          targets={actions.targets}
          onSubmit={(projectId, directory) =>
            actions.onTransfer(summary, projectId, directory, props.acting === 'move')
          }
          onDone={() => props.onAct(null)}
        />
      )}
    </>
  )
}

/** Move a collection to another folder of its project: which one, or the root. */
function FolderForm(props: {
  summary: CollectionSummary
  /** Where it can go: folders by name, null for the root of `collections/`. */
  folders: Array<string | null>
  onSubmit: (folder: string | null) => Promise<string | null>
  onDone: () => void
}) {
  const [choice, setChoice] = useState(props.folders[0] ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="name-form transfer-form"
      aria-label={`Move ${props.summary.name} to a folder`}
      onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        void props.onSubmit(choice === '' ? null : choice).then((refused) => {
          setBusy(false)
          setProblem(refused)
          if (refused === null) props.onDone()
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onDone()
        }
      }}
    >
      <select
        aria-label="Folder"
        value={choice}
        autoFocus
        onChange={(event) => {
          setChoice(event.target.value)
          setProblem(null)
        }}
      >
        {props.folders.map((folder) => (
          <option key={folder ?? ''} value={folder ?? ''}>
            {folder === null ? 'collections/' : `${folder}/`}
          </option>
        ))}
      </select>
      <div className="name-form-actions">
        <button type="submit" disabled={busy}>
          Move
        </button>
        <button type="button" className="quiet" onClick={props.onDone}>
          Cancel
        </button>
      </div>
      {problem && (
        <p className="name-form-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

/** Copy or move a collection to another project: which one, and which of its directories. */
function TransferForm(props: {
  summary: CollectionSummary
  move: boolean
  targets: ProjectView[]
  onSubmit: (projectId: string, directory: string | null) => Promise<string | null>
  onDone: () => void
}) {
  const [projectId, setProjectId] = useState(props.targets[0]?.id ?? '')
  const [directory, setDirectory] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = props.targets.find((project) => project.id === projectId)
  const verb = props.move ? 'Move' : 'Copy'

  return (
    <form
      className="name-form transfer-form"
      aria-label={`${verb} ${props.summary.name} to a project`}
      onSubmit={(event) => {
        event.preventDefault()
        if (!target || busy) return
        setBusy(true)
        void props.onSubmit(target.id, directory === '' ? null : directory).then((refused) => {
          setBusy(false)
          setProblem(refused)
          if (refused === null) props.onDone()
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onDone()
        }
      }}
    >
      <select
        aria-label="Project"
        value={projectId}
        autoFocus
        onChange={(event) => {
          setProjectId(event.target.value)
          setDirectory('')
          setProblem(null)
        }}
      >
        {props.targets.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
            {project.scratch ? ' (scratch pad)' : ''}
          </option>
        ))}
      </select>
      {target && target.directories.length > 0 && (
        <select
          aria-label="Folder"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
        >
          <option value="">collections/</option>
          {target.directories.map((name) => (
            <option key={name} value={name}>
              {name}/
            </option>
          ))}
        </select>
      )}
      <div className="name-form-actions">
        <button type="submit" disabled={!target || busy}>
          {verb}
        </button>
        <button type="button" className="quiet" onClick={props.onDone}>
          Cancel
        </button>
      </div>
      <p className="hint transfer-hint">
        {props.summary.dataFile ? 'Its data file goes with it. ' : ''}Files it uploads, the base it
        extends and reusable requests it uses do not: that project needs its own.
      </p>
      {problem && (
        <p className="name-form-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

function Directory(props: {
  node: Extract<CollectionNode, { kind: 'directory' }>
  expanded: boolean
  row: (summary: CollectionSummary, depth: number) => React.ReactNode
  acting: NonNullable<Acting>['kind'] | null
  onAct: (kind: NonNullable<Acting>['kind'] | null) => void
  actions: CollectionActions
  drag: FolderDrag
  marks: GitMarks
  /** The folder's own rule findings: its name. */
  findings: RuleFinding[]
}) {
  const [chosen, setOpen] = useState(true)
  // A filter shows what it found, whatever was collapsed; clearing it restores the choice.
  const open = chosen || props.expanded
  const { node, actions } = props
  const folderMark = props.marks.folder(node.name)
  return (
    <>
      {props.acting === 'rename' ? (
        <NameForm
          label={`New name for the folder ${node.name}`}
          placeholder="Folder name"
          initial={node.name}
          submitLabel="Rename"
          onSubmit={async (name) => {
            const refused = await actions.onRenameFolder(node.name, name)
            if (refused === null) props.onAct(null)
            return refused
          }}
          onCancel={() => props.onAct(null)}
        />
      ) : (
        <div
          className={`collection-item folder-item${props.acting === 'menu' ? ' menu-open' : ''}${props.drag.over === node.name ? ' drop-target' : ''}`}
          {...props.drag.zone(node.name)}
          onContextMenu={onRightClick(() => props.onAct('menu'))}
        >
          <button
            className="row group-row"
            style={{ paddingLeft: 14 }}
            onClick={() => setOpen(!chosen)}
            aria-expanded={open}
            title={
              folderMark
                ? `${node.name}/ — something in it is ${FOLDER_WORDS[folderMark]}`
                : undefined
            }
          >
            <span className="chevron">{open ? '▾' : '▸'}</span>
            <span className="label">{node.name}</span>
            <RuleMark findings={props.findings} />
            <GitBadge mark={folderMark} dot />
          </button>
          <span className="project-menu-wrap">
            <button
              type="button"
              className="collection-menu-button"
              aria-label={`Folder actions for ${node.name}`}
              aria-haspopup="menu"
              aria-expanded={props.acting === 'menu'}
              onClick={(event) => {
                event.stopPropagation()
                props.onAct(props.acting === 'menu' ? null : 'menu')
              }}
            >
              ⋯
            </button>
            {props.acting === 'menu' && (
              <div className="project-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onAct(null)
                    actions.onNewCollectionIn(node.name)
                  }}
                >
                  New collection
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onAct('rename')
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onAct(null)
                    actions.onDeleteFolder(node.name)
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </span>
        </div>
      )}
      {open &&
        (node.children.length === 0 ? (
          <p className="hint directory-empty">
            No collections yet.{' '}
            <button
              type="button"
              className="link-button"
              aria-label={`New collection in ${node.name}`}
              onClick={() => actions.onNewCollectionIn(node.name)}
            >
              New collection
            </button>
          </p>
        ) : (
          node.children.map((child) => child.kind === 'collection' && props.row(child.summary, 1))
        ))}
    </>
  )
}
