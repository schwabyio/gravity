# The Gravity file format

Version 0.9

This document specifies the YAML files that **Gravity**, the desktop app, and **`gta`**,
the command-line runner, read and write. Together they make up Gravity Test
Automation, a tool for testing HTTP APIs. A folder that follows this document works in
both of them.

It is written for people and for coding agents alike. Every key has a table saying its
type, whether it is required and its default. Every rule that makes a file invalid is
stated where it applies, and all of them are collected in
[Appendix A](#appendix-a-validation-rules). [Appendix B](#appendix-b-a-complete-project)
is a complete, valid project to start from.

**Conventions**

- **must**, **must not**, **should** and **may** are used as in RFC 2119.
- Every file is UTF-8 YAML 1.2, one document holding a mapping, with the extension
  **`.yml`**. A `.yaml` file is not read.
- Paths written in files are relative, and use `/`.
- Section numbers are stable. Gravity's error messages cite them, as in
  "(SPEC.md §2.5)".

---

## At a glance

| File                          | Where                                   | What it is                                  | §    |
| ----------------------------- | --------------------------------------- | ------------------------------------------- | ---- |
| `collections/<id>.yml`        | `collections/`, or one folder inside it | A collection: requests run in order         | §2   |
| `collections/<id>.csv\|.json` | Beside its collection                   | A data file: the collection runs once a row | §2.8 |
| `environments/<name>.yml`     | `environments/`                         | Variables, secrets and flags for one target | §6   |
| `project.yml`                 | The project folder                      | Name, global project, variables, trust      | §1.1 |
| `settings.yml`                | The project folder                      | How `gta` runs the project                  | §1.3 |
| `requests/<id>.yml`           | `requests/`, or one folder inside it    | A request set, run by `use:`                | §2.5 |
| `endpoints/<id>.yml`          | `endpoints/`, or one folder inside it   | Defaults and checks per method and path     | §2.6 |
| `bases/<id>.yml`              | `bases/`, or one folder inside it       | A base collection, for `extends:`           | §2.7 |
| `checks/<name>.js`            | `checks/`                               | Shared check functions                      | §5   |
| `.env`                        | The project folder, never committed     | Values for secrets                          | §6   |

The smallest project `gta` runs is three files:

```yaml
# collections/health.yml
id: health
steps:
  - name: service is up
    GET: '{{baseUrl}}/health'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
```

```yaml
# environments/local.yml
vars:
  baseUrl: http://localhost:8080
```

```yaml
# settings.yml: how gta runs the project (§1.3)
environmentType: local
```

The desktop app needs only the first two, and the environment is picked in the app.

**The mistakes that come up most:**

1. **A value that starts with `{{` must be quoted.** YAML reads an unquoted `{` as the
   start of a map, so `GET: {{baseUrl}}/x` is invalid. Write `GET: '{{baseUrl}}/x'`.
2. **A collection's `id` must equal its file name** without `.yml` (§2).
3. **Each step has exactly one method key**, in capitals, whose value is the URL: `GET:`,
   not `get:` or `method: GET` (§2.1).
4. **A JSON body is a string**, not a YAML map: `json: |` followed by the JSON (§2.2).
5. **Code goes in `tests` and `before.script`** as a block (`|`). Checks are calls on `gta`
   (§3, §5).
6. **`vars` hold plain values only**. Anything computed is set in `before.script` with
   `gta.set` (§4).
7. **An unknown `{{variable}}` fails the step.** It is never sent as literal text (§4).
8. **Step tags need `stepTags: true`** on the collection (§2.4).

---

## 1. Layout

A **project** is a folder holding `collections/` and, usually, `environments/`:

```
payments/                     a project
├── project.yml               optional (§1.1)
├── settings.yml              how gta runs it (§1.3)
├── collections/
│   ├── smoke.yml             a collection
│   └── checkout/             a folder grouping collections: one level only
│       ├── sessions.yml
│       ├── sessions.csv      its data file (§2.8)
│       └── refunds.yml
├── environments/
│   ├── local.yml
│   └── staging.yml
├── requests/                 request sets (§2.5)
├── endpoints/                endpoint bases (§2.6)
├── bases/                    base collections (§2.7)
├── checks/                   check files (§5)
├── files/                    anything a body uploads (§2.2); any name will do
└── .env                      secret values; not committed (§6)
```

**Every `.yml` file directly in `collections/`, or in a folder one level down, is a
collection.** Nothing else is. Discovery is exact: no other `.yml` in a repository is
mistaken for a collection. A file that does not parse is reported as a broken
collection, never skipped in silence.

- A folder inside a folder of `collections/` is reported as a problem and not
  read. `requests/`, `endpoints/` and `bases/` are read to the same depth, and
  `checks/` only at its top level.
- Names starting with `.` are ignored, as are the folders `node_modules`, `.git`,
  `reports`, `test-results`, `out` and `dist`.
- Folders carry no configuration and need no file of their own. They group
  collections for display and for running a group.

A project is any folder: the root of a repository, or one service of a monorepo. A
monorepo is several projects, one per service, and they can share a **global project**
(§1.1):

```
platform/                     a repository, not itself a project
├── services/auth/            a project
│   ├── project.yml           uses: ../../shared
│   ├── collections/login.yml
│   └── environments/local.yml
├── services/users/           a project
│   └── collections/users.yml
└── shared/                   a global project
    ├── project.yml
    └── environments/local.yml
```

A project reads nothing above its own folder except the global project it names.

### 1.1 `project.yml` and global projects

```yaml
name: Payments # shown instead of the folder name
uses: ../../shared # a global project, relative to this one
vars: # for every collection in the project
  region: eu
tls:
  ca: # certificate files to trust, besides the system's
    - certs/company-root.pem
```

The file is optional, and so is every key in it. Any other key is an error.

| Key      | Type                   | Default     | Meaning                                               |
| -------- | ---------------------- | ----------- | ----------------------------------------------------- |
| `name`   | string                 | folder name | Display name.                                         |
| `uses`   | string (relative path) | none        | A global project whose files this one shares (below). |
| `vars`   | map of plain values    | none        | Variables for every collection in the project (§4).   |
| `tls.ca` | list of relative paths | none        | Certificate files that requests trust (below).        |

**`uses`** names a **global project**: an ordinary project whose `project.yml`
variables, `environments/`, `requests/`, `endpoints/`, `bases/`, `checks/` and
`settings.yml` every project using it shares.

- It must be a relative path. An absolute path is refused, since it would only work on
  one machine. Write it with `/`; `\` reads the same.
- The folder it names must hold a `project.yml`.
- A global project must not `uses` another: one level, no chains, no loops.
- An environment in the global project merges under the project's environment of the
  same name, key by key, and the project's values win. An environment only the global
  project has is available too.
- The global project's `settings.yml` lies under the project's the same way (§1.3).

**`tls.ca`** lists certificate files that requests trust, for a server whose certificate
a company or local CA signed, or a server's own self-signed certificate. A request
always trusts:

1. Node's bundled Mozilla roots, and any in `NODE_EXTRA_CA_CERTS`.
2. The operating system's trust store: the macOS Keychain, the Windows certificate
   store, or the Linux CA bundle. A CA that IT installed, or that `mkcert -install`
   added, is trusted with nothing written here.
3. `tls.ca`: the project's own files, then its global project's.

- Each entry is a relative path from the `project.yml` that lists it. An absolute path
  is refused.
- A file is PEM (one certificate or a bundle) or a single DER certificate, such as a
  `.cer` exported on Windows. A CA's certificate is public and safe to commit. A private
  key never belongs here.
- A file that is missing or holds no certificate is a problem on the project. Gravity
  sends nothing from the project until it is fixed, and `gta` will not start.
- `tls.ca` only adds trust. Host names and expiry are still checked, and verification
  is never turned off.

### 1.2 Portability

Projects are shared between macOS, Windows and Linux, and read the same on all three:

- Every path written in a file uses `/`. A `\` reads the same, but is never written.
- **Names match exactly, case included.** macOS and Windows find `requests/Auth/login.yml`
  when the file is `requests/auth/login.yml`; Linux does not, so a project that works on a
  laptop would fail in CI. Every name a file refers to must be spelled as it is on disk: a
  `use:` or `extends:` name, `uses`, a `tls.ca` file, a file a body sends, and an
  environment's file name. One that differs only in case is an error on every platform,
  naming the spelling on disk. The folders and files of §1 are lower case.
- **No two names in one folder may differ only in case**, such as `Checkout/` and
  `checkout/`: Linux can hold both, but a macOS or Windows checkout only one. This
  applies in `collections/`, `requests/`, `endpoints/`, `bases/`, `environments/` and
  `checks/`. Collection ids are unique ignoring case too (§2).
- File, folder and environment names must avoid what Windows refuses: the characters
  `< > : " / \ | ? *`, control characters, a trailing dot or space, and the names `CON`,
  `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1`–`COM9` and `LPT1`–`LPT9`, with or
  without an extension. A file with such a name, made on macOS or Linux, is reported.
- Files should use LF line endings. Gravity writes LF, and can add a `.gitattributes`
  scoped to the project's own files so that git keeps them LF on every platform. The same
  block keeps `files/` exactly as committed, so a body sends the same bytes everywhere. A
  global project is a project too: its own block covers its `files/`. For files a body
  sends from another folder, add a `-text` line of your own.
- The process environment is read by exact name on every platform, although Windows
  itself ignores case (§4, §6).

### 1.3 `settings.yml`

How `gta` runs the project. It sits beside `collections/`, is committed, and `gta`
refuses to run without it. The desktop app does not read it.

```yaml
environmentType: staging # environments/<name>.yml
limitConcurrency: 4
timeoutCollection: 3600000
bail: false
tags: [smoke]
notTags: [slow]
generateJUnitResults: true
generateJsonResults: true
generateHtmlResults: true
autoOpenTestResultHtml: false
testResultsBasePath: test-results
```

Every key is optional. **A key not listed here is an error**, so a typo cannot quietly
run with a default.

| Key                      | Type         | Default        | Meaning                                                                     |
| ------------------------ | ------------ | -------------- | --------------------------------------------------------------------------- |
| `environmentType`        | string       | none           | The environment to run against, by name. It must exist (§6).                |
| `limitConcurrency`       | integer ≥ 1  | `1`            | Collections run at once. Steps within a collection always run in order.     |
| `timeoutCollection`      | integer ≥ 1  | `3600000`      | Milliseconds before a collection is stopped and reported failed.            |
| `bail`                   | boolean      | `false`        | Stop a collection at its first failing step; the rest are reported skipped. |
| `tags`                   | list of tags | `[]`           | Run only what these select (§2.4). Empty runs everything.                   |
| `notTags`                | list of tags | `[]`           | Leave out what these name (§2.4).                                           |
| `generateJUnitResults`   | boolean      | `false`        | Write `<testResultsBasePath>/junit/junit.xml`.                              |
| `generateJsonResults`    | boolean      | `false`        | Write `<testResultsBasePath>/json/results.json`.                            |
| `generateHtmlResults`    | boolean      | `false`        | Write `<testResultsBasePath>/html/summary.html` and a page per collection.  |
| `autoOpenTestResultHtml` | boolean      | `false`        | Write the HTML report and open it when the run ends.                        |
| `testResultsBasePath`    | string       | `test-results` | Where reports go: relative to the project folder, or absolute.              |

The results folder is emptied before every run. `gta` refuses to empty one that holds
files it did not write, or one that holds the project itself. Every report replaces
each secret's value with `[secret: NAME]` (§6).

**From the global project.** A global project (§1.1) can have a `settings.yml` too.
Every project that `uses` it runs with those settings under its own: a key the
project's file sets wins, and a key it leaves out comes from the global project's file.

- There is no switch to turn this off. A project undoes a shared setting by setting it
  in its own file, back to the default if need be: `environmentType: null`, `tags: []`.
- A project still needs a `settings.yml` of its own, even an empty one. A global project
  need not have one.
- A relative `testResultsBasePath` is relative to the project being run, whichever file
  set it.

**Overrides.** Each setting can be overridden by an environment variable, then by a
command-line flag: `GTA_LIMIT_CONCURRENCY=8`, then `--limitConcurrency 8`. A list is
comma-separated: `--tags smoke,api`. In all, from lowest to highest: the default, the
global project's `settings.yml`, the project's, the environment variable, the flag.
`gta get` lists each setting that is not a default, and where it came from.

**Running.** `gta` runs from the project folder:

| Command               | Runs                                                        |
| --------------------- | ----------------------------------------------------------- |
| `gta get`             | Nothing. It lists what `gta all` would run.                 |
| `gta all`             | Every collection, except those with `exclude: true` (§2.4). |
| `gta smoke,checkout/` | The collections and folders named, in that order.           |

`gta get` also reports each `use:` and `extends:` that would stop a run, and each file a
body names that is in neither the project nor its global project (§2.2), in every
collection, including those `gta all` leaves out (Appendix A). A file path with
`{{variables}}` is left to the run. It exits `1` when it finds one, or a broken
collection, and `0` otherwise.

A collection is named by its `id`, or by its place (`checkout/sessions`). A folder is
named by its name, and `checkout/` names only the folder. `--flag name=value` sets a
feature flag (§2.9), and `--json` prints the results as JSON. The exit code is `0` when
everything passed, `1` when something failed, and `2` when `gta` could not run.

---

## 2. Collection file

A **collection** is one file holding an ordered list of requests, called **steps**. Its
steps run in list order and share one variable scope, so what one step captures, the
next can use.

```yaml
# collections/checkout.yml
id: checkout
docs: |
  Create a session, capture it, then read it back.
tags: [smoke]
headers: # sent with every step
  Accept: application/json
settings:
  timeout: 10000
vars:
  apiVersion: '2'

steps:
  - name: create session
    POST: '{{baseUrl}}/v{{apiVersion}}/sessions'
    body:
      json: |
        { "amount": 1200 }
    tests: |
      gta.expectResponseStatusCodeToBe(201)
      gta.expectResponseBodyToHaveProperty('id', 'sessionId', 'setAsCollectionVariable')

  - name: read it back
    GET: '{{baseUrl}}/v{{apiVersion}}/sessions/{{sessionId}}'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.expectResponseBodyToHaveProperty('amount', 1200)
```

### Collection keys

Any key not listed here is an error.

| Key        | Type                | Required | Default | Meaning                                                                        |
| ---------- | ------------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `id`       | string              | **yes**  |         | The file name without `.yml` (below).                                          |
| `steps`    | list of steps       | no       | `[]`    | The requests, in run order (§2.1).                                             |
| `setup`    | list of steps       | no       |         | Run once before `steps`; what it sets lasts the run (§2.10).                   |
| `teardown` | list of steps       | no       |         | Run once after the rest, even when a step failed (§2.10).                      |
| `docs`     | string              | no       |         | Markdown.                                                                      |
| `tags`     | list of tags        | no       |         | Tags that select the whole collection (§2.4).                                  |
| `stepTags` | boolean             | no       | `false` | `true` lets steps carry their own tags (§2.4).                                 |
| `exclude`  | boolean             | no       | `false` | `true` leaves it out of group runs (§2.4).                                     |
| `flags`    | map                 | no       |         | Feature flags the whole collection needs (§2.9).                               |
| `headers`  | map                 | no       |         | Sent with every step; a step's own header of the same name wins (§2.3).        |
| `settings` | map                 | no       |         | Defaults for every step (§2.3).                                                |
| `vars`     | map of plain values | no       |         | Collection variables (§4).                                                     |
| `before`   | map                 | no       |         | `script:` run before every step (§5).                                          |
| `tests`    | string              | no       |         | JavaScript run after every step, before the step's own (§5).                   |
| `extends`  | string              | no       |         | A base collection to build on (§2.7).                                          |
| `params`   | map                 | no       |         | The inputs it takes as a request set (§2.5). Only in `requests/`, in practice. |

A collection has no `name` key. Its `id` is its name, and a file with `name:` is
rejected with a message saying so.

### `id`

Every collection file must say its **id**, which is its file name without `.yml`,
exactly. `collections/checkout/sessions.yml` starts `id: sessions`.

- **It must match the file name.** A file whose `id` is missing or different is a
  broken collection. Renaming a file means changing its `id` too.
- **It must be unique in its home, ignoring case.** No two files in a project's
  `collections/` may share an id, including files in different folders of it; the
  same holds for `requests/`, `bases/` and `endpoints/`. Case is ignored because macOS
  and Windows file systems ignore it. Every file sharing an id is broken.
- **It is letters, digits and `- _ .`, starting with a letter or digit**:
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`. It is also typed on a command line.

Because an id is unique, it names the collection everywhere on its own: in the app, on
`gta`'s command line and in reports.

### 2.1 Steps

**List order is run order.** A step is a request: it carries **exactly one HTTP method
key**, in capitals, whose value is the URL as a string.

```yaml
- name: create session
  POST: '{{baseUrl}}/sessions?source=api'
```

Methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.

| Key          | Type         | Required | Meaning                                                                   |
| ------------ | ------------ | -------- | ------------------------------------------------------------------------- |
| `<METHOD>`   | string       | **yes**  | The URL, query string included.                                           |
| `name`       | string       | no       | Display name. Defaults to the method and URL.                             |
| `headers`    | map          | no       | Over the collection's headers (§2.3).                                     |
| `body`       | map          | no       | Exactly one kind of body (§2.2).                                          |
| `settings`   | map          | no       | Over the collection's settings (§2.3).                                    |
| `before`     | map          | no       | `script:` run before the request (§5).                                    |
| `tests`      | string       | no       | The checks, as JavaScript: calls on `gta` (§3) and any other code (§5).   |
| `tags`       | list of tags | no       | The step's own tags. Only with `stepTags: true` on the collection (§2.4). |
| `flags`      | map          | no       | Feature flags the step needs (§2.9).                                      |
| `forEach`    | string       | no       | Send the request once for each item of a list (below).                    |
| `useTests`   | `true`       | no       | In a request set: the use step's `tests` check this response (§2.5).      |
| `connection` | string       | no       | Keep the event stream this request opens as a connection (§2.11).         |
| `base`       | `false`      | no       | `false` leaves the step's endpoint base out (§2.6).                       |
| `docs`       | string       | no       | Markdown.                                                                 |

- A step with two method keys is an error, and so is a step with none, unless it is a
  use step or reads a connection.
- **The URL is authoritative, query string included.** There is no separate block of
  query parameters. Editors show a parameter table as a view over the URL.
- A step may instead run a request set with `use:` (§2.5). A use step has no method
  key.
- A step may also read a connection, an event stream an earlier step keeps open, with
  `connection:` and no method key (§2.11).
- **Any other key is an error**, so a misspelled key such as `heders:` fails at once
  rather than being ignored. A method key in lower case (`get:`) is reported as such.

**`forEach`** sends the request once for each item of a list, each reported as its own
result, `remove grant (item 2 of 3)`:

```yaml
- name: remove grant
  DELETE: '{{baseUrl}}/grants/{{item}}'
  forEach: '{{grantedRoots}}' # a variable holding ["r1", "r2"], or a list written in place
```

- Its `{{variables}}` resolve when the step runs, so an earlier step can make the list,
  as `gta.set('grantedRoots', ids)` does. The result must be a JSON array.
- Each item is `{{item}}` in the request and `item` in its scripts. An item that is an
  object or a list is its JSON in the request.
- An empty list skips the step. Anything that is not a list fails it before anything
  is sent.
- A use step cannot have `forEach`.

### 2.2 `body`

A body declares **exactly one** of these keys. Omit `body` for no body.

```text
body: { json: '{ "a": 1 }' } #        Content-Type: application/json
body: { xml: '<a/>' } #               application/xml
body: { text: hello } #               text/plain
body: { form: { a: '1', b: two } } #  application/x-www-form-urlencoded
body: { multipart: { … } } #          multipart/form-data (below)
body: { graphql: { query: '…', variables: { … } } } # application/json
body: { file: files/order.json } #    the file as it is, typed by its extension
```

| Key         | Type                                 | Sent as                                                    |
| ----------- | ------------------------------------ | ---------------------------------------------------------- |
| `json`      | string                               | The text, as written. It must be a string, not a YAML map. |
| `xml`       | string                               | The text.                                                  |
| `text`      | string                               | The text.                                                  |
| `form`      | map of strings                       | URL-encoded, names and values resolved first.              |
| `multipart` | map of fields (below)                | `multipart/form-data`.                                     |
| `graphql`   | `{ query: string, variables?: map }` | `{"query": …, "variables": …}` as JSON.                    |
| `file`      | string (relative path)               | The file's bytes.                                          |

- The implied `Content-Type` is added only when `headers` does not declare one.
- `{{variables}}` resolve in every kind of body. A form's values are resolved and then
  encoded, so a value may hold `&` or `=`.
- A number in `form` or `multipart` must be quoted: `count: '3'`.

Write JSON as a block, so it needs no escaping:

```yaml
body:
  json: |
    {
      "user": "{{username}}",
      "amount": 1200
    }
```

**`multipart`** is keyed by field name, in order:

```yaml
body:
  multipart:
    description: A photo of {{name}} # text
    metadata: # text with a Content-Type of its own
      value: '{"album": "{{album}}"}'
      contentType: application/json
    avatar: # a file from the project folder
      file: files/avatar.png
      contentType: image/png # optional: else from the extension, else application/octet-stream
      filename: me.png # optional: else the file's own name
    tags: [red, blue] # a list sends the name once for each
```

| A field is                          | Sent as                                          |
| ----------------------------------- | ------------------------------------------------ |
| a string                            | A text part.                                     |
| `{ value, contentType? }`           | A text part with its own `Content-Type`.         |
| `{ file, contentType?, filename? }` | A file part.                                     |
| a list of the above                 | One part for each item, all with the field name. |

`filename: ''` sends an empty name, as a browser does when no file is chosen. Pair it
with an empty file for the whole of that request.

The `Content-Type` is `multipart/form-data` with a boundary chosen for the request. A
declared multipart type without a boundary, such as `multipart/mixed`, gets one added.
A declared boundary is used as written.

**Files**, in `body.file` and a multipart part's `file`, are read from the folder of
the project the step belongs to. For a step of a request set, that is the set's own
project, which may be a global one. The path is the same wherever the collection sits
inside `collections/`.

A file that is not there is looked for in the global project (§1.1), as a request set
or a base collection is, so projects can share one copy of a file. A project's own file
of the same path wins. `global:` before the path reads only the global project's:

```yaml
body:
  multipart:
    avatar: { file: files/test-png.png } # the project's, else the global project's
    terms: { file: global:files/terms.pdf } # the global project's only
```

- It must be a relative path, written with `/`. An absolute path is refused.
- A path out of the project folder, such as `../other/files/a.png`, is read from where
  it points, with no global project to fall back to. A `global:` path stays inside the
  global project folder, and is an error in a project that uses none.
- `{{variables}}` resolve in the path, so a data file row (§2.8) can choose the file.
- A file is sent byte for byte. `{{…}}` inside it is not a variable.
- A file that cannot be read stops the step before anything is sent, in its own `body`
  phase, naming the file and each place it was looked for.
- Where a request is shown (results, reports, `req.body`), a file's bytes appear as
  `‹file files/avatar.png, 1234 bytes›`, and a global project's file as
  `‹file global:files/terms.pdf, 5254 bytes›`, however the step named it.

### 2.3 `settings` and `headers`

**`settings`** on a collection apply to every step; a step's own settings merge over
them. Any other key is an error.

| Key               | Type        | Default | Meaning                                                                                                |
| ----------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `timeout`         | number ≥ 0  | `0`     | Milliseconds for the whole request; `0` means no limit. For an event stream, until its headers arrive. |
| `followRedirects` | boolean     | `true`  | Follow 3xx responses.                                                                                  |
| `maxRedirects`    | integer ≥ 0 | `5`     | The most redirects followed.                                                                           |
| `encodeUrl`       | boolean     | `true`  | Percent-encode what a hand-typed URL left raw, before sending.                                         |
| `maxEvents`       | integer ≥ 0 | `0`     | Stop reading an event stream after this many events; `0` means no limit.                               |
| `streamTimeout`   | number ≥ 0  | `0`     | Stop reading an event stream this many milliseconds after its headers; `0` means no limit.             |
| `untilEvent`      | string      | none    | Stop reading an event stream after the first event of this name, its `event:` line.                    |

**Event streams.** A response whose `Content-Type` is `text/event-stream` (Server-Sent
Events) is read as it arrives, whatever the method, and checked as a list of events
(§3). Nothing in the step marks it as a stream. Reading stops at whichever comes first:

- the server closes the stream
- `maxEvents` events have arrived
- `streamTimeout` milliseconds have passed since its headers arrived
- the first event named `untilEvent` has arrived
- 1,000 events or 10 MB, a limit no setting lifts

```yaml
- name: price stream
  GET: '{{baseUrl}}/prices/stream?symbol=ACME'
  headers:
    Accept: text/event-stream
  settings:
    maxEvents: 3
    streamTimeout: 5000
  tests: |
    gta.expectResponseStatusCodeToBe(200)
    gta.expectResponseBodyToHaveProperty('[0].event', 'subscribed')
    gta.expectResponseBodyToHaveProperty('[1].data.price', 100)
```

- Each way of stopping is a normal end, not an error, and the checks run on the events
  that arrived. A check that wanted more fails with the path it missed.
- Stopped at a number of events, the body ends with the last one.
- Cancel, or a connection that drops mid-stream, is an error, as for any request.
- `maxEvents`, `streamTimeout` and `untilEvent` do nothing to any other response.
- In the desktop app, the events show as they arrive, and Stop ends the reading as
  these do, so the checks run on what came.
- A step that keeps its stream open for later steps is a connection (§2.11).

**Resuming.** A stream is never reconnected: the server closing it ends the step. To
test that a stream resumes, capture the last event's id and send it as `Last-Event-ID`
in a later step:

```yaml
- name: first part
  GET: '{{baseUrl}}/feed'
  tests: |
    gta.set('lastId', res.body.at(-1).id)
- name: the rest
  GET: '{{baseUrl}}/feed'
  headers:
    Last-Event-ID: '{{lastId}}'
  tests: |
    gta.expectResponseBodyToHaveProperty('[0].id', '4')
```

**`headers`** is a map from header name to one of:

```yaml
headers:
  Accept: application/json # a value
  X-Forwarded-For: [10.0.0.1, 10.0.0.2] # a list: sent once per value
  X-Debug: { value: '1', enabled: false, description: turn on to trace } # the long form
```

- A collection's headers are sent with every step. A step header of the same name,
  compared case-insensitively as HTTP does, replaces the collection's for that step.
- A header with `enabled: false` is not sent. On a step it replaces nothing, so
  switching it off brings back the collection's header.

### 2.4 `tags`, `stepTags` and `exclude`

Tags pick what to run. **A collection's `tags` select the whole collection**: every
step, in order, sharing one variable scope.

```yaml
id: checkout
tags: [api, payments] # a run for api or payments runs every step here
```

Some collections have steps that stand alone. There, `stepTags: true` lets each step
carry its own tags, so a run can pick single steps:

```yaml
id: status-codes
stepTags: true
steps:
  - name: not found
    GET: '{{baseUrl}}/status/404'
    tags: [smoke, errors]
```

- **A step must not have `tags` unless its collection has `stepTags: true`.** Most
  collections are a flow, where later steps use what earlier ones set, and running part
  of one fails for reasons that have nothing to do with the API.
- A tag is letters, digits and `- _ . :` with no spaces (`^[A-Za-z0-9._:-]+$`). Tags are
  case-sensitive and have no prefix. A tag is for grouping only: a feature flag is not
  a tag (§2.9).

**Selecting** with `tags`: a collection whose own tags match runs whole. Otherwise, with
`stepTags: true`, its steps whose tags match run, in order. Otherwise nothing in it runs.

**Leaving out** with `notTags`: a collection whose own tags match runs nothing, whatever
else selects it. With `stepTags: true`, its steps whose tags match are dropped from what
was selected.

**`exclude: true`** leaves a collection out of group runs: `gta all`, with or without
tags, and a folder named to `gta`. Named on its own, it still runs. Use it for work in
progress, a manual-only collection, or one waiting on a fix. `gta` lists what it left
out, so a suite never shrinks without saying so.

### 2.5 Request sets and `use:`

A **request set** is a collection in `requests/`, directly or one folder down, with a
`params:` key: the inputs it takes. A step elsewhere runs it with **`use:`**, and passes
values with **`with:`**.

```yaml
# requests/login.yml
id: login
params:
  username: { required: true, description: Account to log in as }
  password: { required: true }
  expectStatus: 200 # a default
steps:
  - name: log in
    POST: '{{baseUrl}}/login'
    body:
      json: '{ "user": "{{params.username}}", "password": "{{params.password}}" }'
    tests: |
      gta.expectResponseStatusCodeToBe(params.expectStatus)
      if (params.expectStatus === 200) {
        gta.expectResponseBodyToHaveProperty('token', 'authToken', 'setAsCollectionVariable')
      }
```

```yaml
# collections/checkout.yml
id: checkout
steps:
  - use: login
    with:
      username: '{{adminUser}}'
      password: '{{adminPassword}}'
  - use: login
    name: rejects a bad password
    with: { username: alice, password: wrong, expectStatus: 401 }
    tests: |
      gta.expectResponseBodyToHaveProperty('error', 'invalid credentials')
  - name: get profile
    GET: '{{baseUrl}}/me'
```

**Params.** Each param is a plain default (`expectStatus: 200`), or
`{ required: true, default, description }`. In a request a param reads as
`{{params.name}}`, and in code as `params.name`, a read-only object holding the real
values. No variable can take the place of a `params.` name.

A default may name variables and other params, as in
`email: '{{params.accountId}}@example.com'`. Like a `with:` value, it is resolved once
for each use, so `accountId: '{{$uuid}}'` is one id wherever the set reads it.

**A use step** holds only `use`, `with`, `name`, `tags`, `flags`, `docs` and `tests`. A
method key, `headers`, `body`, `settings` or `before` on it is an error, and `with`
without `use` is an error too.

- **Finding the set.** `use: login` is `requests/login.yml` in the project, else in its
  global project. `use: auth/login` is one folder down. `use: global:login` looks
  only in the global project.
- **`with:`** gives plain values; a param left out takes its default. A string may hold
  `{{variables}}`, resolved as the set's first request starts, just after the
  collection's `before.script` has run for it: a value that script sets for each step
  (§4) reaches the set. A missing required value, a name the set does not take, or a
  value or default that cannot be resolved stops the set's steps before anything is
  sent.
- **Running.** A use step runs each of the set's steps in turn, in the collection's
  variable scope, so what one sets the next can read, and so can the steps after the use
  step. Each request is reported as its own result. When the use step has a `name`,
  reports use it: `sign in` for a set of one step, `sign in › get profile` for a longer
  one.
- **Layers.** Headers and settings: the collection's, under the set's, under each
  step's own. Scripts run collection, then set, then step: `before.script` before the
  request and `tests` after. The use step's own `tests` run last, on the response of
  the set's step marked `useTests: true`, or else its last step. `params` is the set's
  alone: the collection's scripts, and a base collection's or an endpoint's (§2.6,
  §2.7), never see it. In an endpoint's `before.script`, a segment written as
  `{{params.id}}` reads as written.
- **One level.** A request set must not `use:` another, and has `params`, not `vars`. A
  file in `requests/` without `params` is not a request set.

**Saving under the caller's name.** A set can take the name to save a value under as a
param, save it with `gta.set(params.saveAs, …)`, and read it back in its later steps
with `{{@params.saveAs}}` (§4). The caller then reads it by the name it chose:

```yaml
# requests/create-user.yml
params:
  saveTokenAs: { required: true }
steps:
  - name: create token
    POST: '{{authUrl}}/token'
    tests: gta.set(params.saveTokenAs, res.body.accessToken)
  - name: get profile
    GET: '{{baseUrl}}/profile'
    headers:
      Authorization: Bearer {{@params.saveTokenAs}}
    useTests: true # the use step's tests check this response
  - name: wait for events
    GET: '{{baseUrl}}/wait'
```

```yaml
# a collection
- use: create-user
  name: user 1
  with: { saveTokenAs: token1 }
  tests: gta.expectResponseBodyToHaveProperty('email') # on get profile's response
- GET: '{{baseUrl}}/orders'
  headers: { Authorization: 'Bearer {{token1}}' }
```

Only one step of a set may have `useTests`, and only a set's steps.

### 2.6 Endpoint bases

What every request to one endpoint gets, wherever the request is written. A file in
`endpoints/` (the project's own, or its global project's) is a collection whose steps
are **endpoints**: a method and a **path pattern**, with the headers, settings, scripts
and checks for every request to it.

```yaml
# endpoints/users.yml
id: users
headers:
  X-Api: users # every endpoint in this file
steps:
  - GET: /users/{id}
    headers:
      Accept: application/json
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.expectResponseBodyToHaveProperty('id', endpoint.id)
  - POST: /users
    tests: |
      gta.expectResponseStatusCodeToBe(201)
```

- An endpoint's URL must be a path starting with `/`. An endpoints file must not hold a
  use step.
- **Matching.** A step's request is under the endpoint with its method and a matching
  path. The path is read from the URL as written. The host, or a leading
  `{{variable}}` standing for it, is ignored, and so is the query string, so one base
  serves every environment.
- `{name}` in a pattern stands for one path segment, whether a literal value or a
  `{{variable}}`. A variable never matches a literal segment of a pattern.
- When several endpoints match, the one with the most literal segments wins
  (`/users/me` over `/users/{id}`), then the one listed first. A project's endpoint
  replaces its global project's with the same method and path.
- **`endpoint`** in scripts holds each `{name}`'s value from the step's URL, resolved:
  `endpoint.id` is `42` for `{{baseUrl}}/users/{{userId}}` with `userId: 42`.
- **What applies**, outermost first: the endpoints file's own `headers`, `settings`,
  `before` and `tests`, then the endpoint's, then the base collection's (§2.7), the
  collection's, the request set's (§2.5) and the step's. Nearer headers and settings
  win.
- **A step's own check replaces the base's check of the same thing**: the status, a
  header by name, or a body property by path. A negative test only says what it expects,
  so checking for a 404 replaces the base's 200. Checks of other things stay, and named
  tests (`gta.test`) are never replaced.
- **`base: false`** on a step leaves its endpoint base out altogether.

### 2.7 `extends`: base collections

```yaml
# bases/authenticated.yml
id: authenticated
headers:
  Authorization: Bearer {{token}}
before:
  script: |
    gta.set('requestId', gta.uuidv7())
```

```yaml
# collections/checkout.yml
id: checkout
extends: authenticated
steps:
  - GET: '{{baseUrl}}/cart'
```

A collection that `extends:` a base collection builds on its `headers`, `settings`,
`vars`, `before` and `tests`, with its own on top: nearer headers, settings and
variables win, and scripts run the base's first.

- `extends: name` looks in the project's `bases/`, then its global project's.
  `extends: global:name` looks only in the global project's.
- A base collection must have no `steps` and no `params`, and must not `extends`
  another.
- A base that cannot be used (missing, broken, or breaking these rules) stops every
  step of the collection before anything is sent, saying why.

### 2.8 Data files

A collection can be driven by a **data file**: `<id>.csv` or `<id>.json` beside
`<id>.yml`, with exactly the same name. The whole collection runs once per row, and each
column of the row is a variable for that run: `{{userId}}`, or `gta.get('userId')`.

```
collections/
├── users.yml
└── users.csv
```

```csv
userId,expectedStatus,iterationLabel
1001,200,Happy path
9999,404,Unknown user
```

- **One run per row.** Every step runs for row 1, then every step again for row 2, and
  so on. Each run starts from a fresh variable scope, so nothing one row sets leaks into
  the next, except a value set to last the run (§2.10). Three steps and two rows report
  six results.
- **Precedence.** A row's values sit over the environment and under what code sets
  (§4).
- **`iterationLabel`**, an optional column, names the row in reports, as in
  `Iteration 2 (Unknown user) - get user`. It is a variable like the others.
- **CSV** follows RFC 4180: a header row, then one row per line. A value in double
  quotes may hold commas and line breaks, and `""` is a quote. **Every CSV value is a
  string**: a zip code `01234` stays `01234`. A short row leaves its last columns empty;
  a row with more values than the header is an error.
- **JSON** is an array of objects, one per row. Values keep their type, which must be
  string, number, boolean or null.
- **`.csv` wins** when both exist. The name must match exactly, case included.
- A data file must be at most 10 MB and have at least one row. The header must not have
  an empty or repeated column name. A data file that will not read makes the collection
  broken: `gta` reports it and runs nothing from it.
- With `bail`, a failing step also stops the rows still to come.

In the desktop app, a single step runs with one chosen row. **Run all** runs every row,
as `gta` does.

### 2.9 Feature flags

A collection or a step says which feature flags it needs, and runs only when they hold:

```yaml
id: checkout
flags: { newCheckout: true } # the whole collection runs only when newCheckout is on
steps:
  - name: total (new)
    GET: '{{baseUrl}}/checkout/total'
    flags: { newCheckout: true }
  - name: total (old)
    GET: '{{baseUrl}}/checkout/total'
    flags: { newCheckout: false } # only one of the pair ever runs
  - name: v2 pricing
    GET: '{{baseUrl}}/prices'
    flags: { pricingVersion: v2 } # any value, not just on/off
```

- **Every flag named must have the value given.** A collection's `flags` apply to each
  of its steps, and a use step's to each request of its set. Values compare as text, so
  `true` matches `true` or `"true"`, and `2` matches `"2"`.
- **A step whose flags do not hold is skipped**, not failed. It sends nothing and is
  reported as skipped with the reason, such as `feature flag newCheckout is off`. A
  skipped step never fails a run.
- **A flag the run does not know is an error.** Otherwise a typo, or a flag deleted from
  the flag service, would quietly run or skip the wrong tests.
- **In code, `gta.flag(name)`** returns a flag's value, for checking something
  different rather than skipping a step.
- A flag name is letters, digits and `- _ .` (`^[A-Za-z0-9_][A-Za-z0-9_.-]*$`). A value
  is a string, number or boolean.
- Skipping an early step can make later steps fail, such as a login that sets a token.
  Flags on the whole collection are usually the safer choice.

**Where the values come from.** Each environment file gives its flags (§6):

```yaml
# environments/staging.yml
vars: { baseUrl: https://staging.example.com }
flags:
  command: node scripts/flags.mjs staging # prints the flags as JSON
  values: # used without a command, and for any flag its output leaves out
    newCheckout: false
```

Lowest precedence first: the global project's environment's `values`, the project's
own, what the `command` prints, then overrides.

- **`command`** runs a program once before any test of a run, in the folder of the
  project whose environment file names it. It must print, on standard output, a JSON
  object of flag names to string, number or boolean values, such as
  `{ "newCheckout": true, "pricingVersion": "v2" }`.
- **It runs the same way on every platform, without a shell.** The command is split into
  words at spaces. The first word is the program, found on the `PATH` or given as a path
  from the project folder, and the rest are its arguments. `'…'` or `"…"` keeps spaces
  in a word. Inside `"…"`, `\"` stands for `"` and `\\` for `\`; anywhere else `\` is an
  ordinary character, so a Windows path works as written. Pipes, `&&`, redirection,
  `$VAR` and `%VAR%` mean nothing. Put logic in a script and run it with its interpreter,
  as in `node scripts/flags.mjs staging`. On Windows, a `.cmd` or `.bat` script such as
  `npx` cannot be started this way, so name the program it runs instead.
- It inherits the environment `gta` or the app runs in, so a flag service's API key
  comes from CI or the shell, never from the repository. The desktop app adds the `PATH`
  a terminal would have, so `node` is found however the app was opened.
- If it exits with anything but `0`, prints anything else, or takes longer than 60
  seconds, **nothing runs**, and what it wrote to standard error is shown. A command that
  takes too long is stopped, with anything it started.
- A project's command wins over its global project's for the same environment.
- **Overrides** win over everything: `gta … --flag newCheckout=false` (any number of
  them), or the environment variable `GTA_FLAG_newCheckout=false`. The desktop app has an
  override per flag. `true` and `false` are booleans, a number is a number, and anything
  else is text.

Every report records the flag values a run used and where each came from.

### 2.10 Setup, teardown and values that last the run

`setup` and `teardown` are lists of steps, like `steps`, run once around it:

```yaml
id: approved-domains
setup: # once, before the first row
  - use: seed-admin # log in, grant an admin role, wait for it to land
teardown: # once, after the last row, even when a row failed
  - name: remove the grant
    DELETE: '{{baseUrl}}/admins/{{adminId}}'
steps: # once per row of approved-domains.csv, as before
  - name: approve the domains
    PUT: '{{baseUrl}}/orgs/{{orgId}}/domains'
```

- **Order.** Setup, then the steps once per data row (or once, with no data file), then
  teardown. They work the same with or without a data file.
- **What setup sets lasts the run.** Every value setup sets or captures is there for
  every row and for teardown. It sits over the environment and under a row's values
  (§4).
- **A row keeps a value for the rows after it** with
  `gta.set(name, value, { scope: 'run' })`. Anything else a row sets lasts only that
  row, as §2.8 says.
- **Setup failing stops the rows.** They are not run and count as skipped. Teardown
  still runs.
- **Teardown always runs**, every step of it, after failures and after `bail`. A run that
  is cancelled, or stopped by `timeoutCollection`, stops where it is.
- **The collection applies to them**: its headers, settings, `before`, `tests` and
  flags, as to any step. Their steps may be use steps and may use `forEach`, but carry
  no `tags`: they run whenever the collection does.
- A request set, a base collection and an endpoints file have no setup or teardown.
- Reports name their results `setup › log in` and `teardown › remove the grant`. Running
  a single step in the desktop app does not run them.

### 2.11 Connections: a stream across steps

A request whose response is an event stream (§2.3) can keep it open for later steps, as
a **connection** named by `connection:`. A later step with `connection:` and no method
key sends nothing: it reads the events the connection holds. The steps between can do
what those events are about:

```yaml
steps:
  - name: watch orders
    GET: '{{baseUrl}}/orders/events'
    connection: orders # keep the stream open as "orders"
    settings:
      untilEvent: subscribed # read until the server confirms, then go on
  - name: place order
    POST: '{{baseUrl}}/orders'
    body:
      json: '{ "sku": "ACME-1" }'
    tests: |
      gta.expectResponseBodyToHaveProperty('id', 'orderId', 'setAsCollectionVariable')
  - name: order created
    connection: orders # no method key: reads the connection
    settings:
      untilEvent: order.created
      streamTimeout: 5000
    tests: |
      gta.expectResponseBodyToHaveProperty('[0].event', 'order.created')
      gta.test('the order placed', () => assert.equal(res.body[0].data.id, gta.get('orderId')))
```

- **Opening.** The step sends its request and reads the stream as any step does, until
  its `maxEvents`, `streamTimeout` or `untilEvent`. Then, rather than closing it, it
  keeps reading in the background, holding the events that arrive for the next step
  that reads the connection. With none of the three set, it reads no events and goes
  straight on.
- **Reading.** A reading step takes the events held since the last step read them,
  then waits for more, until its `maxEvents`, `streamTimeout` or `untilEvent`, or the
  server closes the stream. With none of the three set, it takes what is held and ends
  without waiting, as `held`.
- **What a reading step sees.** Its body is the events it took (§3). Its status and
  headers are those of the response that opened the connection, `req` is that request,
  and `res.stream.at` counts from that response's headers.
- A reading step may have `name`, `settings`, `before`, `tests`, `tags`, `flags`,
  `useTests` and `docs`, and nothing that would build a request: no `headers`, `body`,
  `base` or `forEach`. A step opening a connection has no `forEach`, and a use step has
  no `connection`.
- **A connection lasts the run.** One opened in `setup` is read by every data row; one
  opened in a row, by that row's later steps. Every connection closes when the run ends,
  cancelled or not. A step opening a name already open closes the old connection first,
  whatever its own response is.
- A connection the server closes keeps the events it held: the next step reads them,
  then ends with `close`. A connection holds at most 1,000 events or 10 MB; at that it
  stops reading, and the step that reads it ends with `limit`.
- Reading a connection no step has opened is an error, and the step's scripts do not
  run.
- **In the desktop app**, a connection opened by sending a step stays open for the steps
  sent after it, until that step is sent again, the connection is closed from above the
  step list, Run all starts, or the app quits. Run all, like `gta`, opens its own and
  closes them when it ends.

---

## 3. Checking a response

A step's checks are calls to functions on `gta`, in its `tests` (§5 lists them).
[FUNCTIONS.md](./FUNCTIONS.md) documents each one, with examples. This section is the
rules they share.

```yaml
tests: |
  gta.useStrictValidation()
  gta.expectResponseStatusCodeToBe(200)
  gta.expectResponseToHaveHeader('Content-Type', /^application\/json/)
  gta.expectResponseBodyToHaveProperty('user.name', 'Ada')
  gta.expectResponseBodyToHaveProperty('user.score', 100, 'integerWithin2')
  gta.expectResponseBodyToHaveProperty('user.token', 'sessionToken', 'setAsCollectionVariable')
  gta.expectResponseBodyToHaveUnorderedArray('user.roles', ['admin', 'editor'])
  gta.ignoreResponseBodyProperty('user.lastSeen')
```

### Paths

A path addresses the body in dot or bracket notation: `user.name`; `groups.0.name` or
`groups[0].name` for an index; and `sessions[].id` for a property of every item.

A key that holds a `.`, `[` or `]`, or is empty, goes in brackets as a JSON string:
`jwt.payload["https://example.com/id"]`, `modules[""].edition`. Reports show such keys
the same way.

A path can also be a list of keys: `['jwt', 'payload', 'https://example.com/id']`.
Each item is one key, whatever it holds, and a number is its digits, so
`['groups', 0, 'name']` reads an index. Every function that takes a path takes a list
too, and so does `pathToProperty`.

A path that runs into a `null` before its end, such as `phoneNumber.number` when
`phoneNumber` is `null`, reads as that `null` for a check that the value is `null`. For
any other check the property is not present.

### Body conversion

A JSON body is used as it is. An XML body is converted: the root element is the single
top-level key, namespace prefixes and attributes are dropped, an element holding only
text becomes that string (an empty one `""`), and a repeated element becomes an array.
A `text/plain` or HTML body is the single property `plaintext`.

An event stream (§2.3) is a list with one item per event:

- **`data`** is the event's `data:` lines joined with a line feed: their JSON value when
  they parse as JSON, so `[1].data.price` is a number, and otherwise the text, such as
  `[DONE]`.
- **`event`** and **`id`** are there only when that event's own lines set them. Neither
  carries over to the next event.
- Comments (`: heartbeat`) and a block with no `data:` are not events, `retry:` is not
  kept, and an event the stream ended in the middle of is dropped.

```text
event: price
id: 41
data: {"symbol":"ACME","price":100}

: heartbeat

data: [DONE]

```

reads as

```json
[{ "event": "price", "id": "41", "data": { "symbol": "ACME", "price": 100 } }, { "data": "[DONE]" }]
```

The path `''` is the whole list, so `expectResponseBodyToHaveUnorderedArray('', …)` finds
events whose order is not guaranteed. Under strict validation every event's properties
need accounting for, so a small `maxEvents` keeps a busy stream practical.

### Values and patterns

- A value compares with its type: `'12345'` does not equal `12345`.
- A `RegExp` is a pattern, flags included, tested against the value as text.
- Header names match case-insensitively. The status and header values compare as text.

### `specialHandling`

The last argument of a check may be one of these strings:

| String                                   | Means                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| _(none, and no value)_                   | The property or header exists.                                                                                                           |
| `notThisExpectedKey`                     | It must not exist. Pass `null` as the value.                                                                                             |
| `notThisExpectedValue`                   | It must exist and not equal the value (or not match the RegExp).                                                                         |
| `setAsCollectionVariable`                | Capture it into the variable the value names, for the rest of the run.                                                                   |
| `setAsEnvironmentVariable`               | The same. Nothing is written back to the environment file.                                                                               |
| `dateAsEpoch`                            | Compare by calendar day: a number is a seconds offset from when the step started, a string a date whose first ten characters must match. |
| `dateWithin<X>Sec`                       | A date within X seconds of the value, as in `dateWithin5Sec`.                                                                            |
| `integerWithin<X>`                       | A number within X of the value, as in `integerWithin2`.                                                                                  |
| `isArray`                                | An array; its contents are not checked.                                                                                                  |
| `isArrayAndEmpty` / `isArrayAndNotEmpty` | An empty or non-empty array.                                                                                                             |
| `isArrayAndHasLength`                    | An array of exactly the value's length.                                                                                                  |

A mistake in a call, such as an unknown `specialHandling`, is reported as a failed check
saying so, and the checks after it still run.

### Unordered arrays

`gta.expectResponseBodyToHaveUnorderedArray(path, list)` passes when the array holds
every item of a simple `list`, in any order. A `RegExp` in the list is a pattern some item
must match as text, and so is one held by an object in the list:
`[/^admin/, { name: /^Grace/ }]`. A pattern never matches an object or array item.

A list of `{ pathToProperty, expectedValue, specialHandling? }` objects describes **one**
item, property by property; call it once per item. A property may appear twice, once to
check it and once to capture it:

```js
gta.expectResponseBodyToHaveUnorderedArray('users', [
  { pathToProperty: 'name', expectedValue: 'Ada' },
  { pathToProperty: 'id', expectedValue: 'adaId', specialHandling: 'setAsCollectionVariable' }
])
```

`gta.expectResponseBodyToHaveUnorderedArrayNotThisItem(path, list)` passes when no item
matches. A simple list may hold patterns here too, and a `compareValue` may be a
`RegExp`.

- **Each call prefers items an earlier call did not match.** Two calls with the same
  description find two items when there are two, so each capture and strict validation
  see a different one. A sort starts this over, since its indexes name other items.
- **A list of one `notThisExpectedValue` entry depends on strict validation.** Without
  it, the entry means no item has that value, so an empty array passes. With it, the
  entry means one item whose value is something else, as any list does. The step's last
  word on strict validation decides.

### Strict validation

`gta.useStrictValidation()` fails the step unless **every** property of the body is
checked, ignored or captured.

- `null`, `""` and empty arrays or objects never need a check of their own.
- A check on a value's content accounts for that value and everything beneath it. A
  shape-only check (`isArray`, `isArrayAndHasLength`, or an object's existence) does not
  vouch for what is inside.
- It is judged after the collection's and the step's `tests` have both run, over what
  either checked.
- A binary or HTML body has no properties to leave unchecked, so strict validation
  passes. A check on one still fails.

### Sorting

`gta.sortResponseBodyArrays(property)` sorts every array of objects holding the
property, before the checks after it.

- The property may be a path (`id.value`), and nested arrays are sorted too.
- Items without the property go last.
- Values compare alphanumerically, so `Group 2` comes before `Group 10`.
- Indexed paths refer to the sorted order.

---

## 4. Variables

Variables come from `vars` in `project.yml` and in collections, the chosen environment,
a data file's row, and what code sets while a step runs.

```yaml
vars:
  apiVersion: '2' # plain values only: string, number, boolean or null

before:
  script: |
    gta.set('traceId', gta.uuidv7())
    gta.set('today', gta.date('%Y-%m-%d', 0, 'utc'))
```

**`vars` hold plain data.** A value must be a string, number, boolean or null. Anything
computed, such as an id, a date, a random number or a value built from other
variables, is set in `before.script` with `gta.set` (§5). A collection's
`before.script` runs before every step, so a value set there is fresh for each.

### Interpolation

`{{name}}` resolves in the URL, headers and body, and recursively in what it resolves
to. Whitespace inside the braces is ignored. In code, read a variable with
`gta.get(name)` instead.

- **Values keep their type.** A string that is exactly one reference returns the
  variable's own value, so a variable written as `true` arrives as a boolean. Anything
  else is text, and `null` becomes the empty string inside it, except in a `json` body,
  where it is written `null`, so `"website": {{site}}` stays valid JSON.
- **An unknown variable is an error**, never literal text. The step fails in its own
  `interpolate` phase, naming the variable, and nothing is sent. A reference loop, or a
  chain more than 16 deep, fails the same way.
- **`{{@name}}` reads the variable `name` names.** With `saveAs: token1`,
  `{{@saveAs}}` is the value of `token1`. The name may itself be built from variables.
  A name that is not text, or names no variable, fails like an unknown variable. A
  request set uses it to read what it saved under its caller's name (§2.5).
- **In YAML, quote a value that starts with `{{`.** Unquoted, YAML reads `{` as a map.

### Built-in variables

These are usable anywhere a variable is, with no declaration:

| Reference           | Value                                  |
| ------------------- | -------------------------------------- |
| `{{$uuid}}`         | A random UUID, new for each reference. |
| `{{$timestamp}}`    | Epoch milliseconds.                    |
| `{{$isoTimestamp}}` | An ISO-8601 instant.                   |
| `{{$randomInt}}`    | A whole number from 0 to 999.          |

### Resolution order

Lowest precedence first:

```
global project vars → project vars → base collection vars → collection vars
  → environment → what lasts the run → data file row → gta.set and captures
  → process environment
```

The environment is the global project's file of that name, if there is one, with the
project's own over it.

**The process environment only overrides a name that another layer already declares.**
Otherwise `PATH`, `HOME` and every credential on the machine would be reachable from a
request URL. To let CI override a value, declare the variable, usually in an environment
file and often as a secret (§6).

A name is matched exactly, case included, on every platform. Windows ignores case in its
environment, but a variable called `path` or `username` is still not replaced by the
system's `Path` or `USERNAME`.

---

## 5. Code: `tests` and `before.script`

A step, or a collection for every step, carries JavaScript. `before.script` prepares the
request, and `tests` checks the response:

```yaml
- name: get user
  GET: '{{baseUrl}}/users/7'
  before:
    script: |
      gta.set('traceId', gta.uuidv7())
  tests: |
    gta.expectResponseStatusCodeToBe(200)
    gta.expectResponseBodyToHaveProperty('user.name', 'Ada')
    gta.expectResponseBodyToHaveProperty('user.nickname', null, 'notThisExpectedKey')

    const ids = res.body.user.accounts.map((a) => a.id)
    gta.test('account ids are unique', () => assert.equal(new Set(ids).size, ids.length))
```

- `before` must hold only `script`.
- Write code as a block scalar (`|`) so it needs no quoting.
- **Order:** the collection's `before.script`, the step's `before.script`, the request,
  then the collection's `tests` and the step's `tests`. Strict validation is judged last.

### The `gta` object

There is nothing to import or load. [FUNCTIONS.md](./FUNCTIONS.md) documents each
function, with examples.

| Function                                                                                         | In `before.script` |
| ------------------------------------------------------------------------------------------------ | :----------------: |
| `gta.expectResponseStatusCodeToBe(expected, specialHandling?)`                                   |                    |
| `gta.expectResponseToHaveHeader(name, expected?, specialHandling?)`                              |                    |
| `gta.expectResponseBodyToHaveProperty(path, expected?, specialHandling?)`                        |                    |
| `gta.expectResponseBodyToHaveUnorderedArray(path, list)`                                         |                    |
| `gta.expectResponseBodyToHaveUnorderedArrayNotThisItem(path, list)`                              |                    |
| `gta.ignoreResponseBodyProperty(path)`                                                           |                    |
| `gta.ignoreResponseBodyArrayObjectProperty(arrayPath, propertyPath)`                             |                    |
| `gta.sortResponseBodyArrays(property)`                                                           |                    |
| `gta.useStrictValidation(enabled = true)`                                                        |                    |
| `gta.test(name, fn)`: a named check that passes unless `fn` throws or rejects; `fn` may be async |                    |
| `gta.get(name)`: a variable's current value                                                      |         ✓          |
| `gta.set(name, value)`: set a variable for the rest of the run                                   |         ✓          |
| `gta.set(name, value, { scope: 'run' })`: the same, lasting past this data row too (§2.10)       |         ✓          |
| `gta.skip(reason?)`: send nothing for this step, and report it skipped with the reason           |         ✓          |
| `gta.skipRest(reason?)`: skip the rest of this row's steps; in `before.script`, this one too     |         ✓          |
| `gta.flag(name)`: a feature flag's value; an unknown flag is an error                            |         ✓          |
| `gta.uuid()`: a random (version 4) UUID                                                          |         ✓          |
| `gta.uuidv7()`: a time-ordered (version 7) UUID                                                  |         ✓          |
| `gta.randomInt(min, max)`: a whole number, both ends included                                    |         ✓          |
| `gta.date(format, secondsOffset = 0, timeZone = 'local')`                                        |         ✓          |

`gta.set` keeps a string, number, boolean or null as it is, and stores an object or array
as JSON text. `undefined` is stored as `null`, so a variable set to nothing still reads
`== null`, and `{{name}}` resolves as a null does (§4).

Calling a response check in `before.script` is an error, and so is `gta.skip` in
`tests`, where the request has been sent. After `gta.skip` the script runs to its end,
and no later `before.script` runs. `gta.skipRest` skips steps of this row only: the next
row, and teardown, still run.

`gta.date` formats with strftime specifiers: `%Y %y %m %d %e %H %I %M %S %L %p %b %B %a
%A %j %Z %z %s %F %T %%`. An unrecognized specifier is left in the output, so a typo is
visible. `timeZone` is `local`, `utc`, an IANA name such as `America/New_York`, or a
military zone letter (`U` is -08:00, not UTC).

### Other globals

| Global     | What it is                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `res`      | `tests` only: `status`, `statusText`, `headers` (lower-cased names), `header(name)`, `body` (parsed JSON, converted XML, an event stream's events, or text), `text`, `time` (ms), `size` (bytes), and for an event stream `stream` (below). |
| `req`      | `method`, `url`, `headers`, `body`: as sent in `tests`, as written in `before.script`, where a script may change `headers` and `body` (below).                                                                                              |
| `assert`   | Node's strict `assert`, for use inside `gta.test`.                                                                                                                                                                                          |
| `console`  | Captured into the step's result.                                                                                                                                                                                                            |
| `params`   | A request set's params (§2.5), in its own scripts and in the tests of the use step running it.                                                                                                                                              |
| `endpoint` | An endpoint base's `{name}` values (§2.6), in its scripts and in every script of a step under it.                                                                                                                                           |
| `checks`   | The project's check files (below).                                                                                                                                                                                                          |

**`res` for an event stream** (§2.3): `res.body` is its list of events, as checks see it
(§3), `res.text` the stream as received, and `res.time` runs until the reading stopped.
`res.stream` has the rest, and is absent for any other response:

- `endedBy`: what stopped the reading: `close`, `maxEvents`, `streamTimeout`,
  `untilEvent`, `limit`, `stopped` (the desktop app's Stop button), or `held` (a step on
  a connection that waited for nothing, §2.11)
- `at`: for each event, the milliseconds from the response headers to its arrival
- `connection`: for a step that opens or reads a connection, `{ name, open }`: its name,
  and whether it was still open when the step ended

```js
gta.test('first price within 2s', () => assert.ok(res.stream.at[0] < 2000))
```

Also available are the language itself and the web-standard globals: timers, `URL`,
`URLSearchParams`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone` and
`crypto`.

**There is no `require`, `import`, `process`, filesystem or `fetch`.** A collection must
run the same on any machine, and a request belongs in a step, where it is recorded.

- A script that throws stops that script. It is reported with its line, and the step is
  marked as errored. Checks made before it are kept.
- A script that runs for more than 10 seconds is stopped.

**Changing the request in `before.script`.** `req` there is the request as written,
`{{variables}}` still in it. A script may change it before it is sent, and a later
`before.script` sees the change:

```js
const claims = JSON.parse(req.body)
if (!params.crmContactId) delete claims.crm_contact_id // leave the member out
req.body = JSON.stringify(claims)
req.headers['X-Trace'] = '{{traceId}}'
delete req.headers['X-Debug']
```

- `req.body` is text, and can be changed for a `json`, `xml`, `text` or `graphql` body.
  A form, multipart or file body is built from its parts, so it cannot.
- `req.headers` is a map of names to values: add, change or delete them.
- Variables in what the script writes resolve afterwards, as in the file.
- Anything else is a pre-request error, and nothing is sent.

### Check files

`checks/*.js` in a project, and in its global project, hold functions every script can
call as `checks.<file>.<function>`:

```js
// checks/pagination.js
export function expectPage({ size }) {
  gta.expectResponseStatusCodeToBe(200)
  gta.expectResponseBodyToHaveProperty('page.size', size)
}
```

```js
// in a step's tests
checks.pagination.expectPage({ size: 20 })
```

- A function uses the calling script's `gta`, `res`, `req`, `assert` and `params`, so
  what it checks is reported on the step that called it.
- A file exports with `export function name`, `export async function name` or
  `export const name =`.
- The file name, without `.js`, must be a JavaScript identifier
  (`^[A-Za-z_$][\w$]*$`). A file with any other name is not loaded.
- A project's file replaces its global project's file of the same name.

---

## 6. `environments/<name>.yml`

```yaml
name: staging # optional: else the file name
vars:
  baseUrl: https://staging.example.com
  strictValidation: true # a real boolean
  apiKey: { secret: true } # the value comes from the process environment or .env
  region: { value: eu, description: Where the test accounts live }
flags: # feature flags for this environment (§2.9)
  command: node scripts/flags.mjs staging
  values: { newCheckout: true }
```

Any other top-level key is an error.

| Key     | Type   | Meaning                                                                         |
| ------- | ------ | ------------------------------------------------------------------------------- |
| `name`  | string | The environment's name. Defaults to the file name without `.yml`.               |
| `vars`  | map    | Each value is a plain value, or `{ value?, secret?: true, description? }`.      |
| `flags` | map    | `command` (string) and `values` (flag name → string, number or boolean) (§2.9). |

**Secrets.** A variable written `{ secret: true }` never has its value in a file or a
report. Its value is read from the process environment variable of **exactly the same
name**, case included, else from `.env` at the project's root, else from `.env` at its
global project's root.

- A secret with no value anywhere fails the run, naming it. An empty credential is never
  sent.
- Reports replace a secret's value with `[secret: NAME]`, wherever it appears. So does
  the desktop app where it shows a request as sent, or what a script wrote with
  `console`.
- `.env` holds `NAME=value` lines. `#` starts a comment line, `export ` before a name is
  allowed, and a value may be quoted. It must not be committed.

An environment is selected by its `name`, else its file name. A project can use its own
`environments/` and its global project's (§1.1). Two files of the same name are one
environment, with the project's values over the global project's.

---

## 7. Editing files

Files are meant to be written by hand, by tools and by agents, and kept in git.

- **Gravity edits in place.** Saving a file Gravity did not change leaves it as it was,
  byte for byte. Changing one field changes that field. Comments, key order, quoting and
  formatting survive, and so does every step not touched.
- **An edited file is written with LF line endings.**
- **Gravity writes only against what it read.** If a file changed on disk while it was
  being edited, nothing is written, and the change is shown instead.
- Code (`tests`, `before.script`) that Gravity writes is a `|` block, even for one line.

When writing files yourself, especially from a program or an agent:

- Use two-space indentation and block style. Flow style (`[a, b]`, `{ secret: true }`)
  is fine for short values.
- Quote any string that starts with `{`, `[`, `*`, `&`, `!`, `%`, `@` or `` ` ``, or
  that holds `: ` or ` #`.
- Write JSON bodies and code as `|` blocks.
- Keep `id` equal to the file name, and change both together.
- Check the result against [Appendix A](#appendix-a-validation-rules).

---

## Appendix A. Validation rules

A file that breaks one of these rules is reported with a message naming the rule. A
broken collection is shown as broken, and `gta` reports it as failed without running
it. Rules checked at run time fail the step, or the run, before anything is sent.

**Every document**

- It must be YAML that parses, holding a mapping, in a file ending in `.yml`.
- Unknown keys are errors in: a collection's top level, a step, `settings`, `before`,
  `body`, `project.yml`, `tls`, an environment file, an environment's `flags`, a param
  spec and `settings.yml`.

**Collections**

- `id` is present, equals the file name without `.yml`, and matches
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- `id` is unique in its home (`collections/`, `requests/`, `bases/` or `endpoints/`),
  ignoring case.
- There is no `name` key (use `id`).
- A step has `tags` only if the collection has `stepTags: true`.
- With `params`: no step is a use step, and there is no `vars`, `setup` or `teardown`.
- A `setup` or `teardown` step has no `tags`.
- A data file, when present, reads (§2.8).

**Steps**

- A step has exactly one method key, out of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `HEAD` and `OPTIONS`, in capitals, and its value is a string. A use step and a step
  reading a connection have none.
- A step has no key outside the table in §2.1.
- A use step has no method key, `headers`, `body`, `settings` or `before`. `with` is used
  only with `use`.
- `before` holds only `script`. `before.set` is not supported.
- There is no `expect:` key; checks go in `tests`.
- `base` is only ever `false`.
- `forEach` is a string, and a use step has none.
- `useTests` is only ever `true`, only on a request set's step, and on one step at most.
- A step reading a connection has no `headers`, `body`, `base` or `forEach`. A step
  opening one has no `forEach`, and a use step has no `connection` (§2.11).

**Values**

- A variable value, in `vars`, `with` or a param, is a string, number, boolean or null.
- A header is a string, a list of strings, or `{ value, enabled?, description? }`.
- A tag matches `^[A-Za-z0-9._:-]+$`.
- A flag name matches `^[A-Za-z0-9_][A-Za-z0-9_.-]*$`, and a flag value is a string,
  number or boolean.
- A connection name matches `^[A-Za-z0-9_][A-Za-z0-9_.-]*$`.
- A `settings` value has its type in §2.3.

**Bodies**

- A body declares exactly one of `json`, `xml`, `text`, `form`, `multipart`, `graphql`
  and `file`.
- `json`, `xml` and `text` are strings, and `form` is a map of strings.
- A multipart field is a string, `{ value, contentType? }`,
  `{ file, contentType?, filename? }`, or a non-empty list of them.
- `file` paths are relative.

**Library files**

- A request set (`requests/`) has `params`, uses no other set, and has no `vars`.
- A base collection (`bases/`) has no `steps`, `setup`, `teardown` or `params`, and no
  `extends`.
- An endpoint (`endpoints/`) has a URL that is a path starting with `/`, and no use
  steps or connections. An endpoints file has no `setup` or `teardown`.
- A check file's name is a JavaScript identifier; if it isn't, the file is not loaded.
- `collections/`, `requests/`, `endpoints/` and `bases/` hold files at most one folder
  down.

**Portability (§1.2)**

- A name a file refers to is spelled as it is on disk, case included: a `use:` or
  `extends:` name, `uses`, a `tls.ca` file and a file a body sends.
- The folders and files gta looks for in a project are lower case: `collections/`, not
  `Collections/`.
- No two names in `collections/`, `requests/`, `endpoints/`, `bases/`, `environments/`
  or `checks/` differ only in case.
- No file or folder name is one Windows refuses.

**Projects**

- `uses` and `tls.ca` entries are relative paths.
- The folder `uses` names has a `project.yml`, and does not itself `uses` another.
- Each `tls.ca` file exists and holds a PEM or DER certificate.
- `settings.yml` exists for `gta`; a global project's is optional. The `environmentType`
  a run ends up with, if any, names an environment that exists.

**At run time**

- Every `{{variable}}` resolves, with no loop and no chain deeper than 16.
- Every secret has a value.
- Every feature flag named is known to the run.
- The flag `command`, if any, has every quote closed, starts, and exits `0` within 60
  seconds, printing a JSON object.
- Every file a body names can be read from the project folder, or its global
  project's (§2.2).
- Every `use:` and `extends:` names a usable file, and every `with:` suits its set.
  `gta get` checks these, and the body files named without `{{variables}}`, without
  running anything (§1.3).
- A step's `forEach` resolves to a JSON array.
- A step reading a connection finds it open: a step before it in the run opened it.
- In `{{@name}}`, `name` holds text naming a variable that exists.
- A `before.script` sets `req.body` to text, and only for a `json`, `xml`, `text` or
  `graphql` body; `req.headers` stays a map.
- `gta.set`'s `scope`, when given, is `'run'`.

---

## Appendix B. A complete project

```
shop/
├── project.yml
├── settings.yml
├── collections/
│   ├── health.yml
│   └── users/
│       ├── profile.yml
│       ├── profile.csv
│       └── avatar.yml
├── requests/
│   └── login.yml
├── checks/
│   └── common.js
├── files/
│   └── avatar.png
├── environments/
│   └── staging.yml
└── .env                 apiKey=… (not committed)
```

```yaml
# project.yml
name: Shop
vars:
  apiVersion: '2'
```

```yaml
# settings.yml
environmentType: staging
limitConcurrency: 2
generateJUnitResults: true
```

```yaml
# environments/staging.yml
vars:
  baseUrl: https://staging.example.com
  adminUser: admin@example.com
  apiKey: { secret: true }
flags:
  values: { avatars: true }
```

```yaml
# requests/login.yml
id: login
params:
  username: { required: true }
steps:
  - name: log in
    POST: '{{baseUrl}}/v{{apiVersion}}/login'
    headers:
      X-Api-Key: '{{apiKey}}'
    body:
      json: '{ "user": "{{params.username}}" }'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.expectResponseBodyToHaveProperty('token', 'token', 'setAsCollectionVariable')
```

```js
// checks/common.js
export function expectJson() {
  gta.expectResponseToHaveHeader('Content-Type', /^application\/json/)
}
```

```yaml
# collections/health.yml
id: health
tags: [smoke]
steps:
  - name: service is up
    GET: '{{baseUrl}}/health'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      checks.common.expectJson()
```

```yaml
# collections/users/profile.yml
id: profile
steps:
  - use: login # sets token for the steps after it
    with: { username: '{{adminUser}}' }

  - name: get user
    GET: '{{baseUrl}}/v{{apiVersion}}/users/{{userId}}'
    headers:
      Authorization: Bearer {{token}}
    tests: |
      gta.expectResponseStatusCodeToBe(gta.get('expectedStatus'))
```

```csv
userId,expectedStatus,iterationLabel
1001,200,Known user
9999,404,Unknown user
```

```yaml
# collections/users/avatar.yml
id: avatar
flags: { avatars: true } # runs only where the environment turns avatars on
steps:
  - use: login
    with: { username: '{{adminUser}}' }

  - name: upload avatar
    POST: '{{baseUrl}}/v{{apiVersion}}/users/1001/avatar'
    headers:
      Authorization: Bearer {{token}}
    body:
      multipart:
        caption: Profile photo
        image: { file: files/avatar.png }
    tests: |
      gta.expectResponseStatusCodeToBe(201)
```

`gta all` runs `health` and `avatar` once each, and `profile` twice: once for each row
of `profile.csv`.
