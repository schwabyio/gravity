import { useState } from 'react'
import type { CollectionSummary, RuleFinding } from '@schwabyio/gravity-core/model'
import type {
  GitProgress,
  LibraryFileView,
  LibraryKind,
  ProjectView,
  WorkspaceSummary
} from '@shared/ipc.js'
import { summaryOfFile } from '../reuse.js'
import { findingsOf } from '../ruleFindings.js'
import { filterCollections, filtering, keepsFile } from '../sidebarFilter.js'
import CollapseIcon from './CollapseIcon.js'
import GitBadge from './GitBadge.js'
import { gitMarks, MARK_WORDS, type GitMark } from '../gitMarks.js'
import { useExternalEditor } from '../externalEditor.js'
import CollectionList, { type CollectionActions, type FolderDrag } from './CollectionList.js'
import NameForm from './NameForm.js'
import ProjectHeading from './ProjectHeading.js'
import RuleMark from './RuleMark.js'
import Tooltip from './Tooltip.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'

const NO_FINDINGS: RuleFinding[] = []

interface Props {
  /** The divider between this pane and the main one. */
  resizer: React.ReactNode
  workspaces: WorkspaceSummary[]
  active: WorkspaceSummary | undefined
  /** The active workspace's projects. */
  projects: ProjectView[]
  /** Path of the collection file currently shown in the main pane. */
  selectedRoot: string | null
  error: string | null
  onClearError: () => void
  /** What the last git action did, briefly. */
  notice: string | null
  /** A clone in progress, or null. */
  cloning: GitProgress | null
  onSelectCollection: (project: ProjectView, collection: CollectionSummary) => void
  onSetActive: (id: string) => void
  /** Each resolves to a message to show, or null when done. */
  onCreateWorkspace: (name: string) => Promise<string | null>
  onRenameWorkspace: (id: string, name: string) => Promise<string | null>
  onRemoveWorkspace: (id: string) => void
  /** Add a project folder — or, picking a monorepo's root, the projects in it. */
  onAddProject: () => void
  /** Make a scratch pad in the active workspace; resolves to a refusal to show, or null. */
  onCreateScratchPad: (name: string) => Promise<string | null>
  /** What a new scratch pad is called unless renamed: one no scratch pad has. */
  scratchPadName: string
  /** Rename a scratch pad; resolves to a refusal to show, or null. */
  onRenameScratchPad: (projectId: string, name: string) => Promise<string | null>
  onClone: (url: string) => void
  onRemoveProject: (id: string) => void
  onFetch: (id: string) => void
  onPull: (id: string) => void
  onPush: (id: string) => void
  onChanges: (id: string, tab: 'changes' | 'history') => void
  onCreateDirectory: (projectId: string, name: string) => Promise<string | null>
  onCreateCollection: (
    projectId: string,
    directory: string | null,
    name: string,
    kind?: LibraryKind
  ) => Promise<string | null>
  /** Open Project settings; at its rules, when that is what was asked for. */
  onProjectSettings: (projectId: string, at?: 'rules') => void
  onReveal: (path: string) => void
  /** Rename, copy, move and delete a project's collections. */
  collectionActions: Omit<
    CollectionActions,
    'targets' | 'onRenameFolder' | 'onDeleteFolder' | 'onNewCollectionIn'
  >
  /** Rename or delete a folder of a project's `collections/`. */
  onRenameFolder: (projectId: string, folder: string, name: string) => Promise<string | null>
  /** A collection dropped on a folder could not move there: why. */
  onDropRefused: (message: string) => void
  onDeleteFolder: (projectId: string, folder: string) => void
}

/** What is being named in the sidebar, if anything. */
type Naming =
  | { kind: 'workspace' }
  | { kind: 'scratch' }
  | { kind: 'rename-scratch'; projectId: string }
  | { kind: 'rename-workspace' }
  | { kind: 'directory'; projectId: string }
  /** In `folder` of `collections/`, picked to begin with; at its root without one. */
  | { kind: 'collection'; projectId: string; folder?: string }
  | { kind: 'set' | 'endpoints' | 'base'; projectId: string }
  | null

/**
 * The active workspace's projects, and the collections in each.
 *
 * Projects are collapsible headings rather than containers with their own
 * chrome: what you navigate between is collections. Steps live in the
 * collection view, never here.
 */
export default function ProjectSidebar(props: Props) {
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloning, setCloning] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** What each project's files are filtered by, by project id. */
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [naming, setNaming] = useState<Naming>(null)
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  /** A collection being dragged to another folder, and the project it is in. */
  const [dragging, setDragging] = useState<{
    projectId: string
    collection: CollectionSummary
  } | null>(null)
  /** Where a dragged collection would land now: a folder, null for the root, undefined for nowhere. */
  const [over, setOver] = useState<string | null | undefined>(undefined)

  /** Dragging in one project: its collections move between its own folders only. */
  const dragFor = (project: ProjectView): FolderDrag => {
    const here = dragging?.projectId === project.id ? dragging.collection : null
    const takes = (folder: string | null) => here !== null && here.directory !== folder
    return {
      over: here ? over : undefined,
      onStart: (collection) => setDragging({ projectId: project.id, collection }),
      onEnd: () => {
        setDragging(null)
        setOver(undefined)
      },
      zone: (folder) => ({
        onDragOver: (event) => {
          if (!takes(folder)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (over !== folder) setOver(folder)
        },
        onDrop: (event) => {
          if (!here || !takes(folder)) return
          event.preventDefault()
          setDragging(null)
          setOver(undefined)
          void props.collectionActions
            .onMoveToFolder(here, folder)
            .then((refused) => refused && props.onDropRefused(refused))
        }
      })
    }
  }

  const workspaceMenus = useMenuDismiss(workspaceMenu, () => setWorkspaceMenu(false))

  const toggle = (id: string) => setCollapsed((current) => ({ ...current, [id]: !current[id] }))
  /** Every project of the workspace collapsed: the button then opens them all again. */
  const allCollapsed =
    props.projects.length > 0 && props.projects.every((project) => collapsed[project.id])
  const collapseAll = () =>
    setCollapsed((current) => ({
      ...current,
      ...Object.fromEntries(props.projects.map((project) => [project.id, !allCollapsed]))
    }))
  const done = (message: string | null) => {
    if (message === null) setNaming(null)
    return message
  }

  const menuItem = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'danger' : ''}
      onClick={() => {
        setWorkspaceMenu(false)
        action()
      }}
    >
      {label}
    </button>
  )

  return (
    <aside className="sidebar">
      {props.resizer}
      <div className="sidebar-head workspace-head">
        {naming?.kind === 'workspace' || naming?.kind === 'rename-workspace' ? (
          <NameForm
            label={naming.kind === 'workspace' ? 'New workspace name' : 'Workspace name'}
            placeholder="Workspace name"
            initial={naming.kind === 'rename-workspace' ? props.active?.name : ''}
            submitLabel={naming.kind === 'workspace' ? 'Create' : 'Rename'}
            onSubmit={async (name) =>
              done(
                naming.kind === 'workspace'
                  ? await props.onCreateWorkspace(name)
                  : props.active
                    ? await props.onRenameWorkspace(props.active.id, name)
                    : null
              )
            }
            onCancel={() => setNaming(null)}
          />
        ) : (
          <>
            <select
              className="workspace-select"
              aria-label="Workspace"
              value={props.active?.id ?? ''}
              onChange={(e) => props.onSetActive(e.target.value)}
            >
              {props.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <Tooltip text={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}>
              <button
                type="button"
                className="collapse-all-button"
                aria-label={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
                onClick={collapseAll}
                disabled={props.projects.length === 0}
              >
                <CollapseIcon expand={allCollapsed} />
              </button>
            </Tooltip>
            <span className="project-menu-wrap">
              <button
                type="button"
                className="workspace-menu-button"
                aria-label="Workspace actions"
                aria-haspopup="menu"
                aria-expanded={workspaceMenu}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!workspaceMenu) workspaceMenus.opened()
                  setWorkspaceMenu(!workspaceMenu)
                }}
              >
                ⋯
              </button>
              {workspaceMenu && (
                <div className="project-menu" role="menu">
                  {menuItem('New workspace', () => setNaming({ kind: 'workspace' }))}
                  {menuItem('Rename workspace', () => setNaming({ kind: 'rename-workspace' }))}
                  {props.active &&
                    menuItem(
                      'Delete workspace',
                      () => {
                        const active = props.active
                        if (!active) return
                        const count = active.projectIds.length
                        const scratch = props.projects.filter((project) => project.scratch).length
                        const files =
                          scratch === 0
                            ? 'Their files are left alone.'
                            : scratch === count
                              ? 'Their folders go to the Trash.'
                              : `Their files are left alone, except the scratch pads’, whose folders go to the Trash.`
                        const question =
                          count === 0
                            ? `Delete the workspace “${active.name}”?`
                            : `Delete the workspace “${active.name}” and its ${count} project${count === 1 ? '' : 's'}? ${files}`
                        if (window.confirm(question)) props.onRemoveWorkspace(active.id)
                      },
                      true
                    )}
                </div>
              )}
            </span>
          </>
        )}
      </div>

      <div className="sidebar-actions">
        <Tooltip text={ADD_TIPS.project}>
          <button type="button" onClick={props.onAddProject}>
            + Project
          </button>
        </Tooltip>
        <Tooltip text={ADD_TIPS.clone}>
          <button
            type="button"
            onClick={() => setCloning(!cloning)}
            disabled={props.cloning !== null}
          >
            + Clone
          </button>
        </Tooltip>
        <Tooltip text={ADD_TIPS.scratch}>
          <button type="button" onClick={() => setNaming({ kind: 'scratch' })}>
            + Scratch pad
          </button>
        </Tooltip>
      </div>

      {naming?.kind === 'scratch' && (
        <NameForm
          label="New scratch pad name"
          placeholder="Scratch pad name"
          initial={props.scratchPadName}
          submitLabel="Create"
          onSubmit={async (name) => done(await props.onCreateScratchPad(name))}
          onCancel={() => setNaming(null)}
        />
      )}

      {cloning && (
        <form
          className="clone-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (cloneUrl.trim() === '') return
            props.onClone(cloneUrl.trim())
            setCloneUrl('')
            setCloning(false)
          }}
        >
          <input
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="git@github.com:org/repo.git"
            aria-label="Repository URL"
            spellCheck={false}
          />
          <button type="submit">Clone…</button>
        </form>
      )}

      {props.cloning && (
        <p className="sidebar-status" role="status">
          Cloning {props.cloning.target.split(/[\\/]/).pop()}… {props.cloning.phase}
          {props.cloning.percent !== null && ` ${props.cloning.percent}%`}
        </p>
      )}

      {props.notice && !props.error && (
        <p className="sidebar-status" role="status">
          {props.notice}
        </p>
      )}

      {props.error && (
        <div className="sidebar-error" role="alert">
          {props.error}
          <Tooltip text="Dismiss this message">
            <button type="button" onClick={props.onClearError} aria-label="Dismiss">
              ×
            </button>
          </Tooltip>
        </div>
      )}

      <div
        className="sidebar-body"
        onKeyDown={moveInSidebar}
        // Over anything that would not take it, a dragged collection lands nowhere.
        onDragOver={(event) => {
          if (!event.defaultPrevented && over !== undefined) setOver(undefined)
        }}
      >
        {props.projects.length === 0 && (
          <p className="hint empty">
            No projects in this workspace yet. Add a project — a folder with a{' '}
            <code>collections/</code> folder in it, or a monorepo of them. For requests that belong
            in no repository, make a <strong>+ Scratch pad</strong>.
          </p>
        )}

        {props.projects.map((project) => {
          const open = !collapsed[project.id]
          const query = filters[project.id] ?? ''
          const setQuery = (value: string) =>
            setFilters((current) => ({ ...current, [project.id]: value }))
          const libraries = (
            [
              [
                'Request sets',
                'requests',
                project.requestSets.map((set) => ({ ...set, stepCount: set.steps.length }))
              ],
              ['Endpoints', 'endpoints', project.endpointFiles],
              ['Bases', 'bases', project.bases]
            ] as const
          ).map(([title, home, files]) => ({
            title,
            home,
            all: files.length,
            files: files.filter((file) => keepsFile(query, file))
          }))
          const shown = filterCollections(project.collections, project.directories, query)
          const marks = gitMarks(project)
          const total = project.collections.length + libraries.reduce((n, l) => n + l.all, 0)
          const found = shown.collections.length + libraries.reduce((n, l) => n + l.files.length, 0)
          const nothingFound = filtering(query) && found === 0 && shown.directories.length === 0
          return (
            <section key={project.id} className="project" aria-label={`Project ${project.name}`}>
              {/* The project's heading takes a dragged collection to the root of its collections/. */}
              <div
                className={`project-drop${dragFor(project).over === null ? ' drop-target' : ''}`}
                {...dragFor(project).zone(null)}
              >
                <ProjectHeading
                  project={project}
                  open={open}
                  onToggle={() => toggle(project.id)}
                  onFetch={() => props.onFetch(project.id)}
                  onPull={() => props.onPull(project.id)}
                  onPush={() => props.onPush(project.id)}
                  onChanges={(tab) => props.onChanges(project.id, tab)}
                  onRemove={() => {
                    if (!project.scratch) return props.onRemoveProject(project.id)
                    const count = project.collections.length
                    const what =
                      count === 0 ? '' : ` and its ${count} collection${count === 1 ? '' : 's'}`
                    if (
                      window.confirm(
                        `Delete the scratch pad “${project.name}”${what}? Its folder goes to the Trash.`
                      )
                    ) {
                      props.onRemoveProject(project.id)
                    }
                  }}
                  onNewCollection={() => setNaming({ kind: 'collection', projectId: project.id })}
                  onNewDirectory={() => setNaming({ kind: 'directory', projectId: project.id })}
                  onNewSet={() => setNaming({ kind: 'set', projectId: project.id })}
                  onNewEndpoints={() => setNaming({ kind: 'endpoints', projectId: project.id })}
                  onNewBase={() => setNaming({ kind: 'base', projectId: project.id })}
                  onSettings={() => props.onProjectSettings(project.id)}
                  onRules={() => props.onProjectSettings(project.id, 'rules')}
                  onReveal={() => props.onReveal(project.path)}
                  onRename={() => setNaming({ kind: 'rename-scratch', projectId: project.id })}
                />
              </div>

              {naming?.kind === 'rename-scratch' && naming.projectId === project.id && (
                <NameForm
                  label={`New name for ${project.name}`}
                  placeholder="Scratch pad name"
                  initial={project.name}
                  submitLabel="Rename"
                  onSubmit={async (name) => done(await props.onRenameScratchPad(project.id, name))}
                  onCancel={() => setNaming(null)}
                />
              )}

              {naming?.kind === 'directory' && naming.projectId === project.id && (
                <NameForm
                  label="New folder name"
                  placeholder="Folder name"
                  submitLabel="Create"
                  onSubmit={async (name) => done(await props.onCreateDirectory(project.id, name))}
                  onCancel={() => setNaming(null)}
                />
              )}
              {(naming?.kind === 'set' ||
                naming?.kind === 'endpoints' ||
                naming?.kind === 'base') &&
                naming.projectId === project.id && (
                  <NameForm
                    label={`New ${LIBRARY_NAMES[naming.kind]} id`}
                    placeholder={`${capitalise(LIBRARY_NAMES[naming.kind])} id, its file name`}
                    submitLabel="Create"
                    onSubmit={async (name) =>
                      done(await props.onCreateCollection(project.id, null, name, naming.kind))
                    }
                    onCancel={() => setNaming(null)}
                  />
                )}
              {naming?.kind === 'collection' && naming.projectId === project.id && (
                <NewCollectionForm
                  key={naming.folder ?? ''}
                  project={project}
                  folder={naming.folder ?? ''}
                  onSubmit={async (directory, name) =>
                    done(await props.onCreateCollection(project.id, directory, name))
                  }
                  onCancel={() => setNaming(null)}
                />
              )}

              {/* Only where there is enough to look through — and never hiding a filter in use. */}
              {open && project.available && (total >= FILTER_FROM || filtering(query)) && (
                <div className="project-filter" role="search">
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setQuery('')
                    }}
                    placeholder="Filter collections"
                    aria-label={`Filter ${project.name}`}
                    spellCheck={false}
                  />
                  {filtering(query) && (
                    <span className="filter-count" aria-live="polite">
                      {found} of {total}
                    </span>
                  )}
                </div>
              )}
              {open && project.available && nothingFound && (
                <p className="hint filter-empty">Nothing matches “{query.trim()}”.</p>
              )}
              {open &&
                !nothingFound &&
                (!project.available ? (
                  <p className="hint unavailable">Folder is missing — it may have been moved.</p>
                ) : !project.hasCollections ? (
                  <p className="hint shared-project">
                    A shared project, with no collections of its own.
                    {usersOf(project, props.projects).length > 0 &&
                      ` Used by ${usersOf(project, props.projects).join(', ')}.`}
                  </p>
                ) : project.collections.length === 0 && project.directories.length === 0 ? (
                  <p className="hint project-empty">
                    No collections yet.{' '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setNaming({ kind: 'collection', projectId: project.id })}
                    >
                      New collection
                    </button>
                    {' · '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setNaming({ kind: 'directory', projectId: project.id })}
                    >
                      New folder
                    </button>
                  </p>
                ) : (
                  <CollectionList
                    collections={shown.collections}
                    directories={shown.directories}
                    selectedPath={props.selectedRoot}
                    onSelect={(collection) => props.onSelectCollection(project, collection)}
                    expanded={filtering(query)}
                    folders={project.directories}
                    drag={dragFor(project)}
                    marks={marks}
                    findings={project.findings}
                    actions={{
                      ...props.collectionActions,
                      onRenameFolder: (folder, name) =>
                        props.onRenameFolder(project.id, folder, name),
                      onDeleteFolder: (folder) => props.onDeleteFolder(project.id, folder),
                      onNewCollectionIn: (folder) =>
                        setNaming({ kind: 'collection', projectId: project.id, folder }),
                      targets: props.projects.filter(
                        (other) =>
                          other.id !== project.id && other.available && other.hasCollections
                      )
                    }}
                  />
                ))}
              {open &&
                project.available &&
                libraries.map(
                  ({ title, home, files }) =>
                    files.length > 0 && (
                      <div
                        key={home}
                        className="request-sets"
                        role="group"
                        aria-label={`${title} of ${project.name}`}
                      >
                        <div className="request-sets-head">{title}</div>
                        {files.map((file) => (
                          <LibraryRow
                            key={file.path}
                            file={file}
                            home={home}
                            // A shared one's changes are its global project's, marked there.
                            mark={file.source === 'project' ? marks.file(file.path) : null}
                            // Rules check a project's own files; a shared one's are its global project's.
                            findings={
                              file.source === 'project'
                                ? findingsOf(project.findings, `${home}/${file.name}.yml`)
                                : NO_FINDINGS
                            }
                            selected={file.path === props.selectedRoot}
                            onSelect={() =>
                              props.onSelectCollection(project, summaryOfFile(file, home))
                            }
                          />
                        ))}
                      </div>
                    )
                )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

/**
 * A request set, endpoints file or base collection in the sidebar: opens in
 * the app on a click, and from its ⋯ menu — or a right-click — in the
 * external editor.
 */
function LibraryRow(props: {
  file: LibraryFileView
  home: string
  mark: GitMark | null
  findings: RuleFinding[]
  selected: boolean
  onSelect: () => void
}) {
  const { file, mark } = props
  const editor = useExternalEditor()
  const [menu, setMenu] = useState(false)
  const menus = useMenuDismiss(menu, () => setMenu(false))
  const openMenu = () => {
    if (!menu) menus.opened()
    setMenu(true)
  }
  return (
    <div
      className={`collection-item${props.selected ? ' selected' : ''}${menu ? ' menu-open' : ''}`}
      onContextMenu={editor ? onRightClick(openMenu) : undefined}
    >
      <button
        type="button"
        className={`row set-row${props.selected ? ' selected' : ''}`}
        title={[
          file.problem ?? `${props.home}/${file.name}.yml`,
          mark ? MARK_WORDS[mark].toLowerCase() : null
        ]
          .filter(Boolean)
          .join(' — ')}
        onClick={props.onSelect}
      >
        <span className="label">{file.title}</span>
        {file.source === 'global' && <span className="shared-tag">shared</span>}
        {file.problem && <span className="problem">!</span>}
        <RuleMark findings={props.findings} />
        <GitBadge mark={mark} />
      </button>
      {editor && (
        <span className="project-menu-wrap">
          <button
            type="button"
            className="collection-menu-button"
            aria-label={`Actions for ${file.title}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation()
              if (menu) setMenu(false)
              else openMenu()
            }}
          >
            ⋯
          </button>
          {menu && (
            <div className="project-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation()
                  setMenu(false)
                  editor.open({ path: file.path })
                }}
              >
                {editor.label}
              </button>
            </div>
          )}
        </span>
      )}
    </div>
  )
}

/** The sidebar's rows, top to bottom: project headings, folders, collections, library files. */
const ROWS = '.repo-toggle, .row'
/** The rows that open something, as a click on them does. */
const OPENS = '.collection-row, .set-row'

/**
 * The sidebar from the keyboard, as a tree: with a row focused, ↑ and ↓ go to
 * the row above or below — opening a collection or library file as they land
 * on it, as a click would, and only focusing a project or a folder — Home and
 * End the first and last, → opens a closed project or folder and ← closes an
 * open one. Rows in a closed one are not there to land on. A row is a button,
 * so a click leaves it focused; typing in a filter is left alone.
 */
function moveInSidebar(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement
  if (!target.matches(ROWS)) return
  const expanded = target.getAttribute('aria-expanded')
  if (
    (event.key === 'ArrowRight' && expanded === 'false') ||
    (event.key === 'ArrowLeft' && expanded === 'true')
  ) {
    event.preventDefault()
    target.click()
    return
  }
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ROWS)]
  const at = rows.indexOf(target as HTMLButtonElement)
  const to =
    event.key === 'ArrowDown'
      ? at + 1
      : event.key === 'ArrowUp'
        ? at - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : null
  if (to === null) return
  event.preventDefault()
  const row = rows[to]
  if (!row || row === target) return
  row.focus()
  if (row.matches(OPENS)) row.click()
}

/**
 * How many files a project lists — collections, request sets, endpoints files
 * and bases, what its filter looks through — before it offers the filter.
 */
const FILTER_FROM = 5

/** What each kind of library file is called, in a sentence. */
const LIBRARY_NAMES = {
  set: 'request set',
  endpoints: 'endpoints file',
  base: 'base collection'
} as const

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Give a new collection its id — its file name — and pick the folder it goes in. */
function NewCollectionForm(props: {
  project: ProjectView
  /** The folder picked to begin with; '' for the root of `collections/`. */
  folder: string
  onSubmit: (directory: string | null, name: string) => Promise<string | null>
  onCancel: () => void
}) {
  const [directory, setDirectory] = useState(props.folder)
  return (
    <NameForm
      label="New collection id"
      placeholder="Collection id, its file name"
      submitLabel="Create"
      onSubmit={(name) => props.onSubmit(directory === '' ? null : directory, name)}
      onCancel={props.onCancel}
    >
      {props.project.directories.length > 0 && (
        <select
          aria-label="Folder"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
        >
          <option value="">collections/</option>
          {props.project.directories.map((name) => (
            <option key={name} value={name}>
              {name}/
            </option>
          ))}
        </select>
      )}
    </NameForm>
  )
}

/**
 * A path as compared here: `/` for `\`, no trailing slash. Case is kept: a
 * `uses:` spelled in another case than its folder is a problem of its own (SPEC.md §1.2).
 */
const pathKey = (target: string) => target.replace(/\\/g, '/').replace(/\/+$/, '')

/** The projects that `uses:` this one as their global project, by name (SPEC.md §1.1). */
const usersOf = (project: ProjectView, projects: ProjectView[]): string[] =>
  projects
    .filter((other) => other.global && pathKey(other.global.path) === pathKey(project.path))
    .map((other) => other.name)

/** What each way of adding projects does, in a line: the tooltip over its button. */
const ADD_TIPS = {
  project: 'Add a project folder, or every project in a monorepo',
  clone: 'Clone a git repository and add its projects',
  scratch: 'Make a project for ad hoc requests, kept in the app, without git'
}
