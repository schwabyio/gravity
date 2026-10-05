# Gravity Test Automation

Tests for HTTP APIs, written as plain YAML files that live in your repository beside the
code they test, and read and diff as text in a pull request.

- **Gravity** is the desktop app. Build and send requests, write tests, run a
  collection, and see every assertion marked on the response. Git is built in, so you
  can commit and push from the app.
- **`gta`** is the command-line runner, for terminals and CI. It runs the same files on
  the same engine, and writes JUnit, HTML and JSON reports.

Both run on macOS, Windows and Linux.

> **Status:** early development. `gta` is on npm as
> [`@schwabyio/gta`](https://www.npmjs.com/package/@schwabyio/gta); the desktop app has
> no release yet, so it runs from source.

## Features

**Local, with no account**

- No account, no sign-up and no cloud service. Your tests live in your own repositories,
  and everything else stays on your machine: workspaces, settings and scratch pads.
- Gravity and `gta` contact nothing on their own: no telemetry and no update checks. The
  only traffic is the requests you run, the git remotes your projects use, and any flag
  command you set up.
- The desktop app and `gta` both run on macOS, Windows and Linux, and are tested on all
  three.

**Tests are files, in git**

- Collections, environments and shared pieces are plain YAML. You can write them by
  hand, with a tool or with a coding agent, and review them in a pull request.
- Full git: a project is an ordinary folder in your own repository. Branches, history,
  pull requests and code review work on tests as they do on code, in any git tool.
- [SPEC.md](./SPEC.md) defines every key. An unknown or misspelled key is an error,
  never ignored.
- The desktop app edits files in place. Comments, key order and formatting survive, and
  it never overwrites a file that changed on disk.
- A project reads the same on every platform: names match case exactly, file names are
  Windows-safe and line endings are LF.

**Project rules**

- A `rules.yml` sets how a project's files are named, laid out and written: id styles,
  folders, required docs and step names, allowed tags, and what `tests` may call.
- `gta lint` checks every file against the rules, and fails CI on what it finds.
  `gta rules` lists the rules in effect and where each came from.
- The desktop app marks each file and step that breaks a rule, and flags script code
  the rules don't allow as you type.
- A coding agent can read the rules before it writes, and fix what `gta lint --json`
  finds after.
- Rules never change a run. A global project's rules are shared, and each project can
  change or turn off any of them.

**Requests**

- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS`.
- JSON, XML, text, URL-encoded form, multipart with file uploads, GraphQL, or a file
  sent byte for byte.
- Headers and settings (timeout, redirects, URL encoding) are set once on a collection
  and can be overridden on any step.
- Server-Sent Events: an event stream is read as it arrives and checked as a list of
  events. Reading stops at a number of events, a time limit or a named event.
- A stream can stay open as a connection, so a later step checks the events that the
  steps in between caused.
- `forEach` sends a request once for each item of a list, such as ids an earlier step
  saved.
- Requests trust the operating system's certificate store and any CA files the project
  lists. Verification is never turned off.

**Checks**

- Check functions are built in on `gta` and ready in every `tests` script, with nothing
  to install or import: `gta.expectResponseStatusCodeToBe(201)`,
  `gta.expectResponseBodyToHaveProperty('user.name', 'Ada')`.
- They check the status, headers and any body property by path: exact values, patterns,
  number and date tolerances, array shapes, and array items in any order. JSON, XML and
  event-stream bodies all work.
- The same call can save what it read as a variable for the steps after it.
- `gta.useStrictValidation()` fails a step when any property of the body goes unchecked.
- A failing check says what it expected and what it got.
- [FUNCTIONS.md](./FUNCTIONS.md) documents every `gta` function, with examples.
- When you need more, `gta.test` runs checks of your own in JavaScript, and shared check
  functions live in `checks/*.js`.

**Scripts**

- JavaScript runs in two places: `before.script` before a request is sent, and `tests`
  after its response arrives. Scripts set on a collection run for every step.
- A `before.script` prepares the request. It computes values with `gta.set()`,
  `gta.uuidv7()`, `gta.randomInt()` and `gta.date()`, and can change the headers and
  body.
- Skip from code: `gta.skip()` sends nothing for a step, and `gta.skipRest()` skips the
  steps after it. Each skip is reported with its reason and never fails a run.
- `gta.flag()` reads a feature flag, to check something different when it is on.
- Scripts run in a sandbox with no imports, file system or network, so a collection
  runs the same on every machine.

**Variables and secrets**

- Variables come from the project, the collection, the environment, a data row and
  code, in one documented order.
- An unknown `{{variable}}` fails the step. It is never sent as literal text.
- A secret's value comes from the process environment or an uncommitted `.env`, never
  from a file. Reports, the app and its console show it as `[secret: NAME]`.
- Built-in values need no declaration: `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`
  and `{{$randomInt}}`.

**Reuse**

- Request sets: a login or other sequence of requests, with parameters and defaults,
  that any collection runs with `use:`. A set can save a value under a name its caller
  picks.
- Endpoint bases: headers, settings and checks for every request to a method and path,
  wherever that request is written. A step's own check replaces the base's, so a
  negative test only says what it expects.
- Base collections: shared headers, variables and scripts, with `extends:`.
- Global projects: one folder that every service in a monorepo shares. It holds
  environments, request sets, endpoint bases, base collections, checks, upload files,
  `gta` settings and rules, and each project overrides only what it needs. Its own
  collections test what it shares, in one place.

**Running**

- Steps run in order and share variables. Collections can run in parallel.
- Data-driven runs: a CSV or JSON file beside a collection runs it once per row.
- Setup and teardown run once around all the rows. Teardown runs even after a failure.
- Tags select whole collections, or single steps with `stepTags: true`.
  `exclude: true` keeps work in progress out of group runs.
- Feature flags: a collection or step runs only when its flags hold, and is otherwise
  reported as skipped, not failed. Values come from the environment, from a command
  that asks your flag service, or from overrides.
- `bail` and a per-collection timeout stop a run early.

**The desktop app**

- Send one request, or run a whole collection with live progress and cancel. Event
  streams show as they arrive.
- The response body, headers and timings, with each check marked on the line or header
  it checked, and on the line of the script that made it.
- A console of every request sent and its response, as raw text you can copy, with what
  scripts logged and what went wrong.
- Each step shows what it inherits, layer by layer: headers, scripts and check files
  from its endpoint base, base collection and collection. Each check shows which layer
  it came from.
- A script editor with autocomplete for `gta`, `res`, `req` and `assert`, and lint as
  you type.
- Hover over a `{{variable}}` to see its value.
- Editors for environments, data files (as a grid), feature flag overrides, multipart
  bodies, query parameters and Markdown docs, down to each step.
- Drag steps to reorder them, select several at once, move with the arrow keys, and
  right-click for more.
- Open any file in VS Code, Cursor, IntelliJ IDEA, WebStorm or an editor of your own, at
  the step's line.
- Workspaces of projects. Add one project, every project in a monorepo at once, or
  clone a repository. Filter a project's collections by name, folder or tag.
- Scratch pads, for requests that belong in no repository.
- Git is built in, with nothing to install: clone, branches, history, diff, commit,
  discard, fetch, pull and push. Changed files are marked in the sidebar.
- Picks up changes made on disk by an editor, an agent or git.

**The `gta` CLI**

- The same files, run on the same engine as the app.
- Settings live in a committed `settings.yml`, which a global project can share.
  `GTA_*` environment variables override them, and command-line flags override those.
- JUnit XML and JSON reports, and an HTML report that needs no network.
- `gta get` lists what would run, where each setting came from, and anything that
  would stop a run, such as a missing request set or upload file.
- Exit codes `0`, `1` and `2` for CI. Every report records the feature flag values a
  run used and where each came from.

**From code**

- A Playwright test can run collections and request sets, then use what they saved,
  such as a token or a new user's id, in the browser. Each run and request is a step in
  Playwright's report, and a failing run fails the test.
- Any other Node.js code can do the same with `openProject`, from the same npm package.

## What a test looks like

A project is a folder holding a `collections/` folder and, usually, an
`environments/` one. A collection is a list of requests, called steps. They run in order,
and a later step can use a value an earlier one saved, like `sessionId` here:

```yaml
# collections/checkout.yml
id: checkout
headers:
  Authorization: 'Bearer {{apiKey}}'
steps:
  - name: create session
    POST: '{{baseUrl}}/sessions'
    body:
      json: |
        { "amount": 1200 }
    tests: |
      gta.expectResponseStatusCodeToBe(201)
      gta.expectResponseBodyToHaveProperty('id', 'sessionId', 'setAsCollectionVariable')

  - name: read it back
    GET: '{{baseUrl}}/sessions/{{sessionId}}'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.expectResponseBodyToHaveProperty('amount', 1200)
```

An environment supplies the variables for one target. A secret's value is never written
in a file: it comes from the process environment, or from a `.env` file that is not
committed.

```yaml
# environments/staging.yml
vars:
  baseUrl: https://staging.example.com
  apiKey: { secret: true }
```

## The `gta` CLI

You need Node.js 22.12 or later.

```sh
npm install -g @schwabyio/gta
```

`gta` runs from a project folder. A committed `settings.yml` there says how to run it:

```yaml
# settings.yml
environmentType: staging
```

```sh
gta get                          # list what gta all would run
gta all                          # run every collection
gta smoke,checkout               # run these collections, in this order
gta all --tags smoke --generateJUnitResults
```

The exit code is `0` when everything passed, `1` when something failed, and `2` when
`gta` could not run. `gta --help` lists every setting. Projects that share a global
project share its `settings.yml` too, under their own ([SPEC.md §1.3](./SPEC.md)).

## From Playwright

The same package lets a Playwright test run collections and request sets, then use what
they saved. Each run and each request shows up as a step in Playwright's report, and a
failing run fails the test.

```ts
import { test, expect } from '@schwabyio/gta/playwright'

test('a new user sees their dashboard', async ({ page, gta }) => {
  const user = await gta.use('create-user', { plan: 'pro' }) // requests/create-user.yml
  await page.goto(`/users/${user.values.userId}`)
  await expect(page.getByRole('heading')).toHaveText('Welcome')
})
```

[apps/cli/README.md](./apps/cli/README.md#from-playwright-and-other-code) covers the
setup, and running from any other code with `openProject`.

## Running from source

You need Node.js 22.12 or later.

```sh
git clone https://github.com/schwabyio/gravity.git
cd gravity
npm install
npm run dev        # start the desktop app
```

`npm install` also downloads the copy of git that the desktop app bundles, about 60 MB,
from GitHub's releases.

To put the `gta` built from this repository on your `PATH`, in place of the published
one:

```sh
npm run build -w @schwabyio/gta
npm install -g ./apps/cli
```

## Documentation

[SPEC.md](./SPEC.md) specifies the file format: every file, every key, and every rule
that makes a file invalid. It is written for people and coding agents alike, and ends
with a complete project to start from.

[FUNCTIONS.md](./FUNCTIONS.md) documents every `gta` function that `tests` and
`before.script` can call, with examples.

## Development

| Command                                          | What it does                                     |
| ------------------------------------------------ | ------------------------------------------------ |
| `npm test`                                       | Unit tests                                       |
| `npm run coverage`                               | Unit tests, and how much of the code they reach  |
| `npm run coverage:e2e`                           | The same, end to end too: slow, before a release |
| `npm run typecheck`                              | Type-check every workspace                       |
| `npm run lint`                                   | ESLint                                           |
| `npm run test:e2e -w @schwabyio/gravity-desktop` | Build the desktop app, then drive it end to end  |

## License

[MIT](./LICENSE)
