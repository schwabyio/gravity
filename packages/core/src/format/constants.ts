/**
 * Directory holding collections. Every collection lives under one of these.
 *
 * Having a named home is what lets discovery be exact: there is no guessing
 * whether a `.yml` somewhere in a repository is a collection or a CI config.
 */
export const COLLECTIONS_DIR = 'collections'

/** Directory holding `<name>.yml` environment files, a sibling of `collections/`. */
export const ENVIRONMENTS_DIR = 'environments'

/** Request sets — collections with `params` — that steps run with `use:` (SPEC.md §2.5). */
export const REQUESTS_DIR = 'requests'

/** Endpoint bases: what every request to a method + path gets (SPEC.md §2.6). */
export const ENDPOINTS_DIR = 'endpoints'

/** Base collections a collection `extends:` (SPEC.md §2.7). */
export const BASES_DIR = 'bases'

/** JavaScript check functions every script can call as `checks.<file>` (SPEC.md §5). */
export const CHECKS_DIR = 'checks'

/** A project's optional settings file, at its root (SPEC.md §1.1). */
export const PROJECT_FILE = 'project.yml'

/** How the `gta` CLI runs a project, beside `project.yml` (SPEC.md §1.3). */
export const SETTINGS_FILE = 'settings.yml'

/** A project's rules: how its files are laid out and written (SPEC.md §1.4). */
export const RULES_FILE = 'rules.yml'

/** File extension for every document in the format. */
export const DOC_EXTENSION = '.yml'

/** Directory names never searched. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'reports',
  'test-results',
  'out',
  'dist'
])

/** The kinds of document the format has. */
export type DocumentKind = 'collection' | 'environment'
