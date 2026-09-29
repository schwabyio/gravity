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

A project is a folder holding a `collections/` directory, an `environments/` one and a
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

## Settings

Settings come from `settings.yml`, then `GTA_*` environment variables, then flags on the
command line, each overriding the one before. An unknown setting is an error.
`gta --help` lists them all:

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

## The file format

[SPEC.md](https://github.com/schwabyio/gravity/blob/main/SPEC.md) specifies every file,
every key, and every rule that makes a file invalid. It is written for people and coding
agents alike, and ends with a complete project to start from. It also ships in this
package as `dist/SPEC.md`, and `gta`'s messages cite its sections, as in "(SPEC.md §2.5)".

## License

MIT. The packages bundled into `gta` keep their own licenses, collected in
`dist/THIRD_PARTY_NOTICES.txt`.
