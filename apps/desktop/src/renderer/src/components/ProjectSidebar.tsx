import { useEffect, useState } from 'react'
import type { CollectionSummary } from '@schwabyio/gravity-core/model'
import type { GitProgress, LibraryKind, ProjectView, WorkspaceSummary } from '@shared/ipc.js'
import { summaryOfFile } from '../reuse.js'
import { filterCollections, filtering, keepsFile } from '../sidebarFilter.js'
import CollectionList from './CollectionList.js'
import NameForm from './NameForm.js'
import ProjectHeading from './ProjectHeading.js'
import Tooltip from './Tooltip.js'

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
  onAddProject: () => void
  /** Search a folder, a monorepo's say, and add every project in it. */
  onAddProjectsIn: () => void
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
  onProjectSettings: (projectId: string) => void
  onReveal: (path: string) => void
}

/** What is being named in the sidebar, if anything. */
type Naming =
  | { kind: 'workspace' }
  | { kind: 'rename-workspace' }
  | { kind: 'directory'; projectId: string }
  | { kind: 'collection'; projectId: string }
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

  useEffect(() => {
    if (!workspaceMenu) return
    const close = () => setWorkspaceMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [workspaceMenu])

  const toggle = (id: string) => setCollapsed((current) => ({ ...current, [id]: !current[id] }))
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
            <span className="project-menu-wrap">
              <button
                type="button"
                className="workspace-menu-button"
                aria-label="Workspace actions"
                aria-haspopup="menu"
                aria-expanded={workspaceMenu}
                onClick={(event) => {
                  event.stopPropagation()
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
                        const question =
                          count === 0
                            ? `Delete the workspace “${active.name}”?`
                            : `Delete the workspace “${active.name}” and its ${count} project${count === 1 ? '' : 's'}? Their files are left alone.`
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
        <button type="button" onClick={props.onAddProject} title="Add a project folder">
          + Project
        </button>
        <button
          type="button"
          onClick={props.onAddProjectsIn}
          title="Add every project in a folder — a monorepo, or a folder of repositories"
        >
          + Monorepo
        </button>
        <button
          type="button"
          onClick={() => setCloning(!cloning)}
          title="Clone a repository"
          disabled={props.cloning !== null}
        >
          + Clone
        </button>
      </div>

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

      <div className="sidebar-body">
        {props.projects.length === 0 && (
          <p className="hint empty">
            No projects in this workspace yet. Add a project — a folder with a{' '}
            <code>collections/</code> directory in it — or, with <strong>+ Monorepo</strong>, every
            project in a folder at once.
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
          const total = project.collections.length + libraries.reduce((n, l) => n + l.all, 0)
          const found = shown.collections.length + libraries.reduce((n, l) => n + l.files.length, 0)
          const nothingFound = filtering(query) && found === 0 && shown.directories.length === 0
          return (
            <section key={project.id} className="project" aria-label={`Project ${project.name}`}>
              <ProjectHeading
                project={project}
                open={open}
                onToggle={() => toggle(project.id)}
                onFetch={() => props.onFetch(project.id)}
                onPull={() => props.onPull(project.id)}
                onPush={() => props.onPush(project.id)}
                onChanges={(tab) => props.onChanges(project.id, tab)}
                onRemove={() => props.onRemoveProject(project.id)}
                onNewCollection={() => setNaming({ kind: 'collection', projectId: project.id })}
                onNewDirectory={() => setNaming({ kind: 'directory', projectId: project.id })}
                onNewSet={() => setNaming({ kind: 'set', projectId: project.id })}
                onNewEndpoints={() => setNaming({ kind: 'endpoints', projectId: project.id })}
                onNewBase={() => setNaming({ kind: 'base', projectId: project.id })}
                onSettings={() => props.onProjectSettings(project.id)}
                onReveal={() => props.onReveal(project.path)}
              />

              {naming?.kind === 'directory' && naming.projectId === project.id && (
                <NameForm
                  label="New directory name"
                  placeholder="Directory name"
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
                  project={project}
                  onSubmit={async (directory, name) =>
                    done(await props.onCreateCollection(project.id, directory, name))
                  }
                  onCancel={() => setNaming(null)}
                />
              )}

              {open && project.available && total + project.directories.length > 0 && (
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
                  <p className="hint">No collections yet.</p>
                ) : (
                  <CollectionList
                    collections={shown.collections}
                    directories={shown.directories}
                    selectedPath={props.selectedRoot}
                    onSelect={(collection) => props.onSelectCollection(project, collection)}
                    expanded={filtering(query)}
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
                          <button
                            key={file.path}
                            type="button"
                            className={`row set-row${file.path === props.selectedRoot ? ' selected' : ''}`}
                            title={file.problem ?? `${home}/${file.name}.yml`}
                            onClick={() =>
                              props.onSelectCollection(project, summaryOfFile(file, home))
                            }
                          >
                            <span className="label">{file.title}</span>
                            {file.source === 'global' && <span className="shared-tag">shared</span>}
                            {file.problem && <span className="problem">!</span>}
                          </button>
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

/** What each kind of library file is called, in a sentence. */
const LIBRARY_NAMES = {
  set: 'request set',
  endpoints: 'endpoints file',
  base: 'base collection'
} as const

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Give a new collection its id — its file name — and pick the directory it goes in. */
function NewCollectionForm(props: {
  project: ProjectView
  onSubmit: (directory: string | null, name: string) => Promise<string | null>
  onCancel: () => void
}) {
  const [directory, setDirectory] = useState('')
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
          aria-label="Directory"
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
