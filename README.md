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

| Command                                          | What it does                                    |
| ------------------------------------------------ | ----------------------------------------------- |
| `npm test`                                       | Unit tests                                      |
| `npm run typecheck`                              | Type-check every workspace                      |
| `npm run lint`                                   | ESLint                                          |
| `npm run test:e2e -w @schwabyio/gravity-desktop` | Build the desktop app, then drive it end to end |

## License

[MIT](./LICENSE)
