# gta

The command-line runner of Gravity Test Automation. Tests for HTTP APIs are plain YAML
files that live in your repository beside the code they test, and read and diff as text
in a pull request. `gta` runs them from a terminal or in CI, and writes JUnit, HTML and
JSON reports. Gravity, the desktop app, edits and runs the same files on the same engine.

## Install

You need Node.js 22.12 or later.

```sh
npm install -g @schwabyio/gta
```

Or add it to a project's `package.json`, and run it there with `npx gta`:

```sh
npm install --save-dev @schwabyio/gta
```

The package has no dependencies to install: everything `gta` uses is bundled into it.

## A first project

A project is a folder holding a `collections/` folder, an `environments/` one and a
`settings.yml`. The smallest project `gta` runs is three files:

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
# settings.yml: how gta runs the project
environmentType: local
```

Then, from the project folder:

```sh
gta all
```

## Collections

A collection is a list of requests, called steps. They run in order, and a later step can
use a value an earlier one saved, like `sessionId` here:

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
in a file: it comes from the process environment variable of the same name, or from a
`.env` file that is not committed.

```yaml
# environments/staging.yml
vars:
  baseUrl: https://staging.example.com
  apiKey: { secret: true }
```

## Running

```sh
gta get                          # list what gta all would run
gta all                          # run every collection
gta smoke,checkout               # run these collections, in this order
gta payments                     # run every collection in collections/payments/
gta all --tags smoke --generateJUnitResults
gta all --environmentType staging --limitConcurrency 8
gta all --json                   # print the results as JSON instead of the table
```

Collections run in parallel up to `limitConcurrency`, each in a worker thread of its own.
The steps within a collection always run in order.

The exit code is `0` when everything passed, `1` when something failed, and `2` when
`gta` could not run at all, such as with a bad setting or an unknown collection.
`gta get` exits `1` when a collection is broken, or has a `use:`, an `extends:` or a
file its body sends that a run would stop at.

## Settings

Settings come from `settings.yml`, then `GTA_*` environment variables, then flags on the
command line, each overriding the one before. An unknown setting is an error.
`gta --help` lists them all, and `gta get` shows where each one came from:

| Setting                  | Default        | What it does                                                   |
| ------------------------ | -------------- | -------------------------------------------------------------- |
| `environmentType`        | none           | The environment to run against: `environments/<name>.yml`      |
| `limitConcurrency`       | `1`            | How many collections run at once                               |
| `timeoutCollection`      | `3600000`      | Milliseconds a collection may take before it is stopped        |
| `bail`                   | `false`        | Stop a collection at its first failing step                    |
| `tags`                   | none           | Run only what has one of these tags                            |
| `notTags`                | none           | Leave out what has one of these tags                           |
| `generateJUnitResults`   | `false`        | Write `<testResultsBasePath>/junit/junit.xml`                  |
| `generateJsonResults`    | `false`        | Write `<testResultsBasePath>/json/results.json`                |
| `generateHtmlResults`    | `false`        | Write `<testResultsBasePath>/html/`, a summary and a page each |
| `autoOpenTestResultHtml` | `false`        | Write the HTML report and open it when the run ends            |
| `testResultsBasePath`    | `test-results` | Where reports go: relative to the project folder, or absolute  |

The results folder is emptied before every run, so everything in it is from the last one.
`gta` only ever deletes a folder that holds nothing but its own reports.

In a monorepo, projects that share a global project (`uses:` in `project.yml`) share its
`settings.yml` too. It comes before the project's own, so a project changes a shared
setting by setting it again in its own file. Each project still needs a `settings.yml`,
even an empty one.

## In CI

```yaml
# .github/workflows/api-tests.yml (steps)
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install -g @schwabyio/gta
- run: gta all --environmentType staging --generateJUnitResults
  env:
    apiKey: ${{ secrets.STAGING_API_KEY }}
```

## From Playwright and other code

The package is also a library. A test written in code can run a collection or a request
set, then use the values it saved, such as a token or the id of a user it created, in a
browser test.

### Playwright

`@schwabyio/gta/playwright` gives you Playwright's `test` with a `gta` fixture. Point it
at the project in `playwright.config.ts`:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import type { GravityConfig } from '@schwabyio/gta/playwright'

export default defineConfig<{}, GravityConfig>({
  use: {
    gravity: { project: '../api-tests', environment: 'staging' }
  }
})
```

```ts
// tests/dashboard.spec.ts
import { test, expect } from '@schwabyio/gta/playwright'

test('a new user sees their dashboard', async ({ page, gta }) => {
  // requests/create-user.yml, run as a use: step would run it
  const user = await gta.use('create-user', { plan: 'pro' })

  await page.goto(`/users/${user.values.userId}`)
  await expect(page.getByRole('heading')).toHaveText('Welcome')

  // collections/billing.yml, starting from what create-user saved
  await gta.run('billing', { vars: user.values })
})
```

- Each `gta.run` and `gta.use` call is a step in Playwright's report. Each request is a
  step inside it, linked to its step in the YAML, with the request and response attached.
- A run that fails fails the test at the line that called it, with what failed. With
  `soft: true` the test goes on and fails at the end, as `expect.soft` does.
- `project` is relative to the folder `playwright.config.ts` is in, and defaults to it.
  `environment`, `flags`, `bail` and `timeoutCollection` go beside it. The project opens
  once per worker, so an environment's flag command runs once per worker.
- A run counts toward the test's timeout, and one still going when the test ends is
  stopped.
- To use this `test` with fixtures of your own, combine them with Playwright's
  `mergeTests`.

It needs `@playwright/test` 1.51 or later, which installing `gta` does not install.

### Any other code

```js
import { openProject } from '@schwabyio/gta'

const project = await openProject('api-tests', { environment: 'staging' })
const login = await project.use('login', { username: 'alice' })
const checkout = await project.run('checkout', { vars: login.values })
if (!checkout.passed) throw new Error(checkout.failures)
```

**`openProject(folder, options)`** opens the project in `folder`, the one holding
`collections/`. The options are `environment`, `flags`, `bail` and `timeoutCollection`.
Each one you leave out comes from `settings.yml`, the same way `gta` reads it, but here
the project does not need a `settings.yml`.

**`project.run(collection, options)`** runs a collection the way `gta` runs it: setup,
then the steps once for each data row, then teardown. Name the collection by its id or
its place in `collections/` (`checkout/sessions`). `tags` and `notTags` don't apply,
since you name what runs, and a collection with `exclude: true` runs too. The options:

| Option     | What it does                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `steps`    | Run only these steps, named as reports name them or numbered from 1. They run in the file's order, and setup and teardown still run. |
| `vars`     | Values the run starts with. They sit over the environment and under a data row.                                                      |
| `bail`     | Stop at the first failing step.                                                                                                      |
| `signal`   | An `AbortSignal` that stops the run.                                                                                                 |
| `onResult` | `(result, step) => void`, called as each request finishes.                                                                           |

**`project.use(set, params, options)`** runs a request set as a `use:` step would:
`login` is `requests/login.yml`, in the project or its global project. `params` are what
`with:` gives, and a param you leave out takes its default. The options are those of
`run`, without `steps`.

Both resolve to the same outcome, however the steps fare:

| Field      | What it holds                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`   | `true` when nothing failed or errored and the run finished.                                                                                                     |
| `values`   | Every value the run set or captured, by name: `gta.set`, and checks that save what they read, such as `'setAsCollectionVariable'`. Secrets are not hidden here. |
| `summary`  | Totals, and every request's result as gta's JSON report holds it, with secrets shown as `[secret: NAME]`.                                                       |
| `steps`    | Where each result's step is: its file and line.                                                                                                                 |
| `failures` | What went wrong, as `gta` prints it under Failures. Empty when the run passed.                                                                                  |
| `error`    | Why the run did not start or finish: a file that will not load, `timeoutCollection`, or a cancel. Otherwise `null`.                                             |

They reject only when a collection, step or request set doesn't exist, or a value isn't a
string, number, boolean or null. Types ship with the package.

## The file format

[SPEC.md](https://github.com/schwabyio/gravity/blob/main/SPEC.md) specifies every file,
every key, and every rule that makes a file invalid. It is written for people and coding
agents alike, and ends with a complete project to start from. It also ships in this
package as `dist/SPEC.md`, and `gta`'s messages cite its sections, as in "(SPEC.md §2.5)".

[FUNCTIONS.md](https://github.com/schwabyio/gravity/blob/main/FUNCTIONS.md) documents every
`gta` function that `tests` and `before.script` can call, with examples. It ships as
`dist/FUNCTIONS.md`.

## License

MIT. The packages bundled into `gta` keep their own licenses, collected in
`dist/THIRD_PARTY_NOTICES.txt`.
