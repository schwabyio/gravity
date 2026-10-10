# Setup and teardown

A collection can hold two more lists of steps beside `steps`: `setup`, run once before
them, and `teardown`, run once after. Setup gets a run ready, with an account to act as
or data to work on. Teardown puts things back afterwards.

```yaml
id: approved-domains
setup: # once, before the first row
  - name: log in as an admin
    POST: '{{baseUrl}}/login'
    body:
      json: '{"user": "{{adminUser}}", "password": "{{adminPassword}}"}'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.set('adminToken', res.body.token)
  - name: grant the role
    POST: '{{baseUrl}}/admins'
    headers:
      Authorization: 'Bearer {{adminToken}}'
    tests: |
      gta.expectResponseStatusCodeToBe(201)
      gta.set('adminId', res.body.id)
steps: # once per row of approved-domains.csv
  - name: approve the domain
    PUT: '{{baseUrl}}/orgs/{{orgId}}/domains/{{domain}}'
    headers:
      Authorization: 'Bearer {{adminToken}}'
    tests: gta.expectResponseStatusCodeToBe(200)
teardown: # once, after the last row, whatever happened
  - name: remove the role
    DELETE: '{{baseUrl}}/admins/{{adminId}}'
    headers:
      Authorization: 'Bearer {{adminToken}}'
```

The rules are in [SPEC.md §2.10](./SPEC.md#210-setup-teardown-and-values-that-last-the-run).
This page is about what they are for.

## How they run

- **Setup, then the steps, then teardown.** With a data file the steps run once per row,
  but setup and teardown run once for the whole run.
- **What setup sets lasts the run.** Every value setup sets or saves is there for every
  row and for teardown. Setup and teardown run without a data row, so a row's columns
  are not variables there.
- **Setup stops at its first failing step**, with `bail` or without, since each setup step
  counts on the ones before it. The setup steps after it, and the steps, are reported as
  skipped instead of each failing for the same reason.
- **Teardown always runs, every step of it.** It runs after failures, after a failed
  setup, after `bail` stops the run, and after a cancel or `timeoutCollection`. After a
  cancel or a timeout it has up to 60 seconds of its own. A run stopped before anything
  ran has nothing to clean up, so no teardown runs.
- **Tags do not apply.** Setup and teardown steps have no tags. They run whenever the
  collection does, whichever steps a tag filter picks.
- **The collection applies to them** as to any step: its headers, settings, `before`,
  `tests` and flags. Their steps can be `use:` steps
  ([below](#reusable-requests-in-setup-and-teardown)).
- **Only they repeat a request for each item of a list**, with `forEach`
  ([below](#cleaning-up-after-the-rows)).
- **Reports name them** `setup › log in as an admin` and `teardown › remove the role`.

## When to use them

- **You have a data file, and something to do once.** A login step in `steps` logs in
  once per row, so 200 rows means 200 logins. In setup it logs in once, and every row
  uses the token.
- **Something has to be cleaned up.** This means deleting what the run created, or
  revoking what it granted. A last step in `steps` doesn't run when `bail` stops the run,
  runs once per row with a data file, and dies with the run on a timeout. Teardown runs
  in all of those cases.
- **Without one step, the rest are pointless.** When a login in `steps` fails, every step
  after it fails too, for the same reason. In setup, a failed login skips the steps, and
  the report says what went wrong once.
- **You pick steps by tag.** `gta all --tags smoke` (with `stepTags: true` on the
  collection) and the app's tag filter pick steps. Setup and teardown still run around
  them, so a picked step still has its login.

## When not to

- **Each row needs something of its own.** Each row starts with fresh variables. If a row
  needs a resource of its own, a new order for every row say, create it in `steps`.
- **Several collections need it.** That is a reusable requests file, run with `use:`.
  Reusable requests decide what runs; setup decides when. A setup step can itself be a
  `use:` step ([below](#reusable-requests-in-setup-and-teardown)).
- **Every request needs it.** Use collection `headers` or `before.script`, a base
  collection (`extends:`) or an endpoint base for a header, a signature or a trace id.
- **It is what you are testing.** Setup is preparation. Checks that are the point of the
  collection belong in `steps`, where tags can pick them and every row makes them.
- **There is no data file, no `bail`, no tag filtering and nothing to clean up.** Then
  setup and teardown add little beyond skipping the steps when setup fails and the labels
  in reports. Plain steps read just as well.

## Reusable requests in setup and teardown

Any setup or teardown step can be a `use:` step. A login or a cleanup is then written
once, in a reusable requests file, and every collection that needs it runs it:

```yaml
# requests/login.yml
id: login
params:
  saveTokenAs: { required: true }
steps:
  - name: log in
    POST: '{{baseUrl}}/login'
    body:
      json: '{"user": "{{user}}", "password": "{{password}}"}'
    tests: gta.set(params.saveTokenAs, res.body.accessToken)
```

```yaml
# requests/revoke.yml
id: revoke
params:
  token: { required: true }
steps:
  - name: revoke the token
    DELETE: '{{baseUrl}}/tokens/{{params.token}}'
```

```yaml
# collections/orders.yml
id: orders
setup:
  - use: login
    with: { saveTokenAs: token }
steps: # once per row of orders.csv, each with {{token}}
  - name: get the order
    GET: '{{baseUrl}}/orders/{{orderId}}'
    headers:
      Authorization: 'Bearer {{token}}'
teardown:
  - use: revoke
    with: { token: '{{token}}' }
```

- The login runs once, and every row uses the token it saved. Teardown revokes it once,
  at the end.
- What the reusable request saves under the caller's name lasts the run, as anything
  setup sets does.
- The rules above hold inside it. A request in it that fails stops setup there. In
  teardown, its requests run after a failure, a cancel or a timeout.
- A `use:` step cannot have `forEach`, and neither can the requests in a reusable
  requests file. A request that repeats goes in setup or teardown itself. A reusable
  requests file has no setup or teardown of its own.
- In the desktop app, the **+** beside SETUP or TEARDOWN adds one with **Use reusable
  requests**, and a step's ⋯ menu adds one below it.

## Cleaning up after the rows

Teardown sees what setup set, and anything a row set with `{ scope: 'run' }`
([`gta.set`](./FUNCTIONS.md#gtaset)). Anything else a row sets lasts only that row. To
delete what each row created, collect the ids as the rows run:

```yaml
setup:
  - name: log in
    POST: '{{baseUrl}}/login'
    tests: |
      gta.expectResponseStatusCodeToBe(200)
      gta.set('token', res.body.token)
      gta.set('orderIds', []) // each row adds its order
steps:
  - name: create the order
    POST: '{{baseUrl}}/orders'
    body:
      json: '{"sku": "{{sku}}"}'
    tests: |
      gta.expectResponseStatusCodeToBe(201)
      const ids = JSON.parse(gta.get('orderIds'))
      ids.push(res.body.id)
      gta.set('orderIds', ids, { scope: 'run' })
teardown:
  - name: delete the orders
    DELETE: '{{baseUrl}}/orders/{{item}}'
    forEach: '{{orderIds}}' # an empty list skips the step
```

`forEach` sends the request once for each item of the list, as `{{item}}`, and reports
each as its own result: `teardown › delete the orders (item 2 of 3)`. Only a setup or
teardown step can have it. A test's own steps send each request once, and a data file
repeats them for each row.

Teardown runs even when setup failed partway. A teardown step that needs something setup
made can skip itself when it isn't there ([`gta.skip`](./FUNCTIONS.md#gtaskip)):

```yaml
teardown:
  - name: remove the role
    DELETE: '{{baseUrl}}/admins/{{adminId}}'
    before:
      script: if (!gta.get('adminId')) gta.skip('setup never granted it')
```

## In the desktop app

- Setup and teardown are sections above and below the steps. The **+** beside STEPS
  starts them, with **Add setup step** and **Add teardown step**. After that, each has a
  **+** of its own, and a step's ⋯ menu adds a step below it.
- A setup or teardown step's line has a **+ for each** chip, for `forEach`.
- **Run all** runs them around the steps. With a tag filter on, it runs them around the
  steps the filter shows.
- **Sending one step runs only that step**, never setup. A step that needs setup's token
  has no token when sent on its own. To try a few steps with setup, pick them with a tag
  filter and press Run all.
- **Stop** during Run all stops the steps, and teardown still cleans up after them. The
  button then reads **Stop teardown**: press it to stop that too.

## In `gta`

- Every run includes setup and teardown, whether it runs whole collections, steps picked
  by tag, or steps picked by the Playwright library.
- A collection stopped at `timeoutCollection` still runs its teardown, for up to 60
  seconds, and says how it went:
  `Timed out after 3600000 ms (timeoutCollection). Teardown ran after it: 1 of 1 passed.`
- JUnit, JSON and HTML reports list their results as `setup › …` and `teardown › …`.

## Limits

- Setup and teardown steps have no `tags`.
- A reusable requests file, a base collection and an endpoints file have no setup or
  teardown.
- After a cancel or a timeout teardown has 60 seconds. A cancel or a timeout while
  teardown runs stops it where it is.
