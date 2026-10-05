# The `gta` functions

Code in a collection runs in two places: `before.script`, before a request is sent, and
`tests`, after its response arrives. Both have a `gta` object, with nothing to import or
load. This document lists every function on it.

```yaml
- name: get user
  GET: '{{baseUrl}}/users/7'
  before:
    script: |
      gta.set('traceId', gta.uuidv7())
  tests: |
    gta.expectResponseStatusCodeToBe(200)
    gta.expectResponseBodyToHaveProperty('user.name', 'Ada')
    gta.expectResponseBodyToHaveProperty('user.email', 'userEmail', 'setAsCollectionVariable')
```

[SPEC.md](./SPEC.md) specifies the files this code lives in. §5 there covers where code
goes, the order it runs in, and the other globals: `res`, `req`, `assert`, `params`,
`endpoint` and `checks`.

---

## At a glance

| Function                                                                                                     | What it does                                       | `tests` | `before.script` |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | :-----: | :-------------: |
| [`expectResponseStatusCodeToBe`](#gtaexpectresponsestatuscodetobe)                                           | Check the status code                              |    ✓    |                 |
| [`expectResponseToHaveHeader`](#gtaexpectresponsetohaveheader)                                               | Check a header                                     |    ✓    |                 |
| [`expectResponseBodyToHaveProperty`](#gtaexpectresponsebodytohaveproperty)                                   | Check a property of the body                       |    ✓    |                 |
| [`expectResponseBodyToHaveUnorderedArray`](#gtaexpectresponsebodytohaveunorderedarray)                       | Check an array holds items, in any order           |    ✓    |                 |
| [`expectResponseBodyToHaveUnorderedArrayNotThisItem`](#gtaexpectresponsebodytohaveunorderedarraynotthisitem) | Check an array holds none of some items            |    ✓    |                 |
| [`sortResponseBodyArrays`](#gtasortresponsebodyarrays)                                                       | Sort arrays before the checks after it             |    ✓    |                 |
| [`useStrictValidation`](#gtausestrictvalidation)                                                             | Fail when any body property goes unchecked         |    ✓    |                 |
| [`ignoreResponseBodyProperty`](#gtaignoreresponsebodyproperty)                                               | Leave a property out of strict validation          |    ✓    |                 |
| [`ignoreResponseBodyArrayObjectProperty`](#gtaignoreresponsebodyarrayobjectproperty)                         | The same, for a property of every item of an array |    ✓    |                 |
| [`test`](#gtatest)                                                                                           | A named check of your own                          |    ✓    |                 |
| [`get`](#gtaget)                                                                                             | Read a variable                                    |    ✓    |        ✓        |
| [`set`](#gtaset)                                                                                             | Set a variable for the steps after                 |    ✓    |        ✓        |
| [`skip`](#gtaskip)                                                                                           | Send nothing for this step                         |         |        ✓        |
| [`skipRest`](#gtaskiprest)                                                                                   | Skip the steps after this one                      |    ✓    |        ✓        |
| [`flag`](#gtaflag)                                                                                           | Read a feature flag                                |    ✓    |        ✓        |
| [`uuid`](#gtauuid)                                                                                           | A random UUID                                      |    ✓    |        ✓        |
| [`uuidv7`](#gtauuidv7)                                                                                       | A time-ordered UUID                                |    ✓    |        ✓        |
| [`randomInt`](#gtarandomint)                                                                                 | A random whole number                              |    ✓    |        ✓        |
| [`date`](#gtadate)                                                                                           | A formatted date, now or offset from now           |    ✓    |        ✓        |

## How calls behave

- **Every `tests` script of a step feeds one list of checks**: the collection's, the
  step's, and those of an endpoint base, a base collection or reusable requests it runs
  under (SPEC.md §2.5–§2.7). Strict validation counts them all together.
- **A check that fails does not stop the script.** The checks after it still run, and
  the step fails.
- **A mistake in how a check is called is a failed check** that says what is wrong: an
  unknown `specialHandling`, a length that is not a number, a path that is neither text
  nor a list. The checks after it still run.
- **Any other error stops the script**: a misspelled function name, a call that belongs
  in the other script, or a JavaScript error. The step is marked errored, with the line,
  and checks made before it are kept.
- **A script is stopped after 10 seconds.**
- **Check files** in `checks/` call `gta` too, and what they check is reported on the
  step that called them (SPEC.md §5).

---

## Checking the response

These run in `tests`. Calling one in `before.script` is an error, since nothing has been
received yet.

### Paths

A path finds a property in the body:

| Path                                    | Finds                                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| `user.name`                             | A property of a property                                        |
| `groups.0.name` or `groups[0].name`     | A property of an array's first item                             |
| `sessions[].id`                         | The property of every item of an array                          |
| `jwt.payload["https://x.io/id"]`        | A key holding `.`, `[` or `]`, written in brackets as JSON text |
| `modules[""].edition`                   | An empty key                                                    |
| `['jwt', 'payload', 'https://x.io/id']` | A list of keys: each item is one key, whatever it holds         |

In a list of keys a number is its digits, so `['groups', 0, 'name']` reads an index.
Every function that takes a path takes a list too, and so does `pathToProperty`.

The body is read as checks need it. JSON is used as it is. XML is converted: the root
element is the one top-level key, an element holding only text becomes that text, and a
repeated element becomes an array. A text or HTML body is one property, `plaintext`.
An event stream (`text/event-stream`) is a list with one item per event, holding its
`data` and, when the event set them, its `event` and `id`: `[1].data.price` is the
second event's price. SPEC.md §3 has the full rules.

### Values

- **A body property compares with its type.** `'12345'` does not equal `12345`, and the
  failure says which is which.
- **The status and headers compare as text**, so `200` and `'200'` are the same.
- **A `RegExp` is a pattern**, flags included, tested against the value as text.

### `specialHandling`

The last argument of a check may be one of these strings, to change what it asks:

| String                     | Means                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| _(none, and no value)_     | The property or header is present.                                                  |
| `notThisExpectedKey`       | It must not be present. Pass `null` as the value.                                   |
| `notThisExpectedValue`     | It must be present, and not equal the value or match the `RegExp`.                  |
| `setAsCollectionVariable`  | Save it into the variable the value names, for the steps after. It must be present. |
| `setAsEnvironmentVariable` | The same. Nothing is written to the environment file.                               |
| `dateAsEpoch`              | Epoch milliseconds, on the calendar day the value names (below).                    |
| `dateWithin<X>Sec`         | A date within X seconds of the value, as in `dateWithin5Sec`.                       |
| `integerWithin<X>`         | A number within X of the value, as in `integerWithin2`.                             |
| `isArray`                  | An array. What it holds is not checked. Pass `null` as the value.                   |
| `isArrayAndEmpty`          | An empty array. Pass `null` as the value.                                           |
| `isArrayAndNotEmpty`       | An array with at least one item. Pass `null` as the value.                          |
| `isArrayAndHasLength`      | An array of exactly the value's length.                                             |

- The status takes `notThisExpectedValue` and the two `setAs…` strings. A header takes
  those and `notThisExpectedKey`. The rest are for body properties.
- **`dateAsEpoch`**: the property holds epoch milliseconds, as a number or as digits.
  The value is a number of seconds from now (`0` is today, `86400` tomorrow), or a date
  whose first ten characters, `2026-10-01`, must match. Days are the calendar days of
  the machine running the test.
- **`dateWithin<X>Sec`**: the property and the value are each an ISO 8601 date or epoch
  milliseconds.
- **Saving** keeps a string, number, boolean or null as it is. An object or array is
  saved as its JSON text.

### `gta.expectResponseStatusCodeToBe`

```js
gta.expectResponseStatusCodeToBe(expected, specialHandling?)
```

The status code is `expected`, or matches it.

```js
gta.expectResponseStatusCodeToBe(201)
gta.expectResponseStatusCodeToBe(/^2\d\d$/) // any 2xx
gta.expectResponseStatusCodeToBe(500, 'notThisExpectedValue') // anything but 500
gta.expectResponseStatusCodeToBe('lastStatus', 'setAsCollectionVariable')
```

### `gta.expectResponseToHaveHeader`

```js
gta.expectResponseToHaveHeader(name, expected?, specialHandling?)
```

The header is present, and with `expected`, equals it or matches it.

```js
gta.expectResponseToHaveHeader('X-Request-Id')
gta.expectResponseToHaveHeader('Content-Type', /^application\/json/)
gta.expectResponseToHaveHeader('Cache-Control', 'no-store')
gta.expectResponseToHaveHeader('X-Debug', null, 'notThisExpectedKey')
gta.expectResponseToHaveHeader('Server', /nginx/, 'notThisExpectedValue')
gta.expectResponseToHaveHeader('X-Request-Id', 'requestId', 'setAsCollectionVariable')
```

- The name matches in any case.
- A header sent more than once is its values joined with `, `, as in `a=1, b=2`.

### `gta.expectResponseBodyToHaveProperty`

```js
gta.expectResponseBodyToHaveProperty(path, expected?, specialHandling?)
```

The property at [`path`](#paths) is present, and with `expected`, equals it or matches
it.

```js
gta.expectResponseBodyToHaveProperty('user.id')
gta.expectResponseBodyToHaveProperty('user.name', 'Ada')
gta.expectResponseBodyToHaveProperty('user.email', /@example\.com$/)
gta.expectResponseBodyToHaveProperty('user.nickname', null, 'notThisExpectedKey')
gta.expectResponseBodyToHaveProperty('user.score', 100, 'integerWithin2')
gta.expectResponseBodyToHaveProperty('user.roles', 2, 'isArrayAndHasLength')
gta.expectResponseBodyToHaveProperty('user.token', 'token', 'setAsCollectionVariable')
gta.expectResponseBodyToHaveProperty('items[].status', 'active') // every item
```

- **`expected` is a string, number, boolean, `null` or `RegExp`.** An object or array
  never equals one. Check its properties one by one, use
  [`expectResponseBodyToHaveUnorderedArray`](#gtaexpectresponsebodytohaveunorderedarray)
  for an array, or compare it in [`gta.test`](#gtatest) with `assert.deepEqual`.
- **A property whose value is `null` is present.**
- **A path that runs into a `null` before its end**, such as `phone.number` when `phone`
  is `null`, reads as `null` for a check that the value is `null`. For any other check,
  the property is not present.
- **A path with `[]` checks every item**, and passes only when each one does. An empty
  array has no items, so the property is not present. Saving one saves every item's
  value, as a JSON list.

### `gta.expectResponseBodyToHaveUnorderedArray`

```js
gta.expectResponseBodyToHaveUnorderedArray(path, list)
```

The array at `path` holds what `list` describes, in any order. `list` takes one of two
forms.

**A list of values.** Each must be in the array, which may hold others too. A `RegExp`
is a pattern, which some item must match:

```js
gta.expectResponseBodyToHaveUnorderedArray('roles', ['admin', 'editor'])
gta.expectResponseBodyToHaveUnorderedArray('roles', [/^admin/, 'editor'])
gta.expectResponseBodyToHaveUnorderedArray('users', [{ name: 'Ada' }, { name: /^Grace/ }])
```

An object in the list matches an item holding each of its properties with that value, or
matching it when the value is a `RegExp`. The item may have others. A property that is
itself an object is matched the same way, so `{ data: { status: 'reversed' } }` finds an
item whose `data` has that status, whatever else `data` holds. An array compares whole.
A pattern is tested against the value as text, so it never matches an item that is an
object or an array.

**A list of `{ pathToProperty, expectedValue, specialHandling? }` entries.** Together
they describe **one** item, property by property, and some item must match every entry.
Call the function once for each item:

```js
gta.expectResponseBodyToHaveUnorderedArray('users', [
  { pathToProperty: 'name', expectedValue: 'Ada' },
  { pathToProperty: 'role', expectedValue: /^admin/ },
  { pathToProperty: 'nickname', expectedValue: null, specialHandling: 'notThisExpectedKey' },
  { pathToProperty: 'id', expectedValue: 'adaId', specialHandling: 'setAsCollectionVariable' }
])
```

- `pathToProperty` is a path inside the item. `specialHandling` is any of the strings
  above, and a save takes its value from the item that matched.
- A property may be named twice: once to check it, and once to save it.
- **Each call prefers items an earlier call did not match.** Two calls with the same
  description find two items when there are two, so each saves from, and strict
  validation counts, a different one. A sort starts this over.
- **A list of one `notThisExpectedValue` entry depends on strict validation.** Without
  it, the entry means no item has that value, so an empty array passes. With it, the
  entry means one item whose value is something else, as any list does. The step's last
  call to `useStrictValidation` decides.

### `gta.expectResponseBodyToHaveUnorderedArrayNotThisItem`

```js
gta.expectResponseBodyToHaveUnorderedArrayNotThisItem(path, list)
```

No item of the array at `path` matches what `list` describes.

```js
gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', ['owner', /^guest/])
gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('users', [
  { pathToProperty: 'status', compareValue: 'deleted' },
  { pathToProperty: 'email', compareValue: /@test\.invalid$/ }
])
```

- A list of values: none of them may be in the array, and no item may match a `RegExp`
  among them. An object in the list may hold patterns too, as above.
- A list of `{ pathToProperty, compareValue }` entries describes one item. The check
  fails when some item matches every entry. `compareValue` may be a `RegExp`.
- **The key is `compareValue`, not `expectedValue`.** An entry without it matches no
  item, so the check always passes.

### `gta.sortResponseBodyArrays`

```js
gta.sortResponseBodyArrays(property)
```

Sorts every array of objects that holds `property`, anywhere in the body, for the
checks after it. Use it when an API returns a list in no fixed order and a check names
an index.

```js
gta.sortResponseBodyArrays('id')
gta.expectResponseBodyToHaveProperty('accounts[0].id', 'acct-100')
```

- `property` may be a path inside each item, such as `id.value`. Arrays inside the items
  are sorted too.
- Items without the property go last. Values compare alphanumerically, so `Group 2`
  comes before `Group 10`.
- Checks made before the call see the order as received, and so does `res.body`.
- Calling it again sorts by the new property first, and by the earlier ones where that
  ties.
- Called with no property, it sorts nothing and writes a warning to the step's console.

---

## Strict validation

### `gta.useStrictValidation`

```js
gta.useStrictValidation(enabled?)
```

Fails the step unless every property of the body is checked, ignored or saved. It
catches a response that gained a field no test looks at. `enabled` is `true` when left
out.

```js
gta.useStrictValidation()
gta.expectResponseBodyToHaveProperty('id', 'orderId', 'setAsCollectionVariable')
gta.expectResponseBodyToHaveProperty('status', 'open')
gta.ignoreResponseBodyProperty('createdAt')
```

- It adds one check, `Strict: every body property is asserted`, which lists each
  property left over.
- It is judged after every `tests` script of the step has run, over what any of them
  checked. Put it in the collection's `tests` to cover every step.
- `null`, `""`, and empty arrays and objects never need a check of their own.
- A check of a value's content accounts for it and everything inside it. A check of
  shape only (`isArray`, `isArrayAndHasLength`, or that an object is present) does not
  vouch for what is inside.
- `false` turns it off. The last call wins, so a step can turn off what the collection
  turned on. `'true'` as text counts as `true`, so a variable can decide:
  `gta.useStrictValidation(gta.get('strictValidation'))`.
- A binary or HTML body has no properties, so strict validation passes.

### `gta.ignoreResponseBodyProperty`

```js
gta.ignoreResponseBodyProperty(path)
```

Counts the property at `path`, and everything inside it, as checked, without checking
it. For values that change on every call, such as timestamps.

```js
gta.ignoreResponseBodyProperty('meta')
gta.ignoreResponseBodyProperty('items[].updatedAt')
```

It changes nothing unless strict validation is on.

### `gta.ignoreResponseBodyArrayObjectProperty`

```js
gta.ignoreResponseBodyArrayObjectProperty(arrayPath, propertyPath)
```

The same, for one property of every item of an array.
`gta.ignoreResponseBodyArrayObjectProperty('items', 'updatedAt')` is
`gta.ignoreResponseBodyProperty('items[].updatedAt')`.

---

## Checks of your own

### `gta.test`

```js
gta.test(name, fn)
```

A named check, for anything the functions above do not cover. It passes unless `fn`
throws, or the promise it returns rejects, and then the error's message is the reason.

```js
gta.test('ids are unique', () => {
  const ids = res.body.items.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
})

gta.test('total is the sum of the lines', () => {
  const sum = res.body.lines.reduce((total, line) => total + line.amount, 0)
  assert.equal(res.body.total, sum)
})
```

- `assert` is Node's strict `assert`, also reachable as `gta.assert`.
- `fn` may be `async`. The step waits for it, whether or not the script does.
- An endpoint base's named checks are never replaced by a step's own (SPEC.md §2.6).

---

## Variables

### `gta.get`

```js
gta.get(name)
```

A variable's current value, from whichever layer sets it: the project, the collection,
the environment, a data file row, or a value saved or set earlier in the run.
`undefined` when no layer does.

```js
gta.expectResponseStatusCodeToBe(gta.get('expectedStatus'))
```

A value comes back with its type. Every value from a CSV data file is text.

### `gta.set`

```js
gta.set(name, value, options?)
```

Sets a variable, which `{{name}}` and `gta.get(name)` read from then on: in this step's
request when it is set in `before.script`, and in every step after.

```js
gta.set('traceId', gta.uuidv7())
gta.set(
  'ids',
  res.body.items.map((item) => item.id)
) // saved as '["a","b"]'
gta.set('adminId', res.body.id, { scope: 'run' })
```

- **Anything computed goes here**, since `vars` in a file hold plain values only
  (SPEC.md §4). A collection's `before.script` runs before every step, so a value set
  there is fresh for each.
- A string, number, boolean or `null` is kept as it is. An object or array is saved as
  its JSON text, so `{{ids}}` writes the list into a JSON body, and `forEach: '{{ids}}'`
  sends a request for each item. Read it back in code with `JSON.parse(gta.get('ids'))`.
  `undefined` is saved as `null`.
- **In a collection with a data file**, a value lasts the rest of its row.
  `{ scope: 'run' }` keeps it for every row after, and for teardown (SPEC.md §2.10).
  Any other `scope` is an error.
- Nothing is written to a file.
- SPEC.md §4 gives the order in which layers win.

---

## Skipping steps

### `gta.skip`

```js
gta.skip(reason?)
```

In `before.script` only. The request is not sent, and the step is reported as skipped,
with the reason. A skipped step never fails a run.

```js
if (!gta.get('adminToken')) gta.skip('no admin account in this environment')
```

- The script runs to its end. No later `before.script` runs for the step: when the
  collection's skips it, the step's own does not run.
- In `tests` it is an error, because the request has been sent. Use `gta.skipRest`
  there.
- To skip a step depending on a feature flag, give it `flags:` (SPEC.md §2.9).

### `gta.skipRest`

```js
gta.skipRest(reason?)
```

Skips the steps after this one, each reported as skipped with the reason.

```js
if (res.status === 404) gta.skipRest('no such account, so nothing more to check')
```

- In `tests`, this step's own result stands. In `before.script`, this step is skipped
  too.
- It skips only the current row. The next row of a data file, and teardown, still run.
- The first reason given stands.

---

## Feature flags

### `gta.flag`

```js
gta.flag(name)
```

A feature flag's value in this run: a string, number or boolean, from the environment,
the flag command or an override (SPEC.md §2.9). Use it to check something different
when a flag is on, rather than skip a step.

```js
if (gta.flag('newCheckout')) {
  gta.expectResponseBodyToHaveProperty('total.currency', 'USD')
}
```

A flag the run does not know is an error, so a misspelled name stops the script rather
than quietly reading as off.

---

## Generated values

### `gta.uuid`

```js
gta.uuid()
```

A random (version 4) UUID, such as `f397d495-8679-42de-8b69-d6ef86b3f5a1`.

### `gta.uuidv7`

```js
gta.uuidv7()
```

A time-ordered (version 7) UUID, such as `01a0f78d-cecb-73c4-ac6e-557141551574`. Ids made
later sort later, which suits a request id or a record that must read in creation
order.

### `gta.randomInt`

```js
gta.randomInt(min, max)
```

A whole number from `min` to `max`, both included: `gta.randomInt(1, 6)` rolls a die.

### `gta.date`

```js
gta.date(format, secondsOffset?, timeZone?)
```

The time now, moved by `secondsOffset` seconds and formatted. `secondsOffset` is `0`
when left out, and `timeZone` is `'local'`.

```js
gta.date('%Y-%m-%d') // today: 2026-10-01
gta.date('%F', 86400, 'utc') // tomorrow, in UTC
gta.date('%FT%T%z', -3600, 'America/New_York') // an hour ago: 2026-10-01T04:15:00-0400
```

| Specifier | Gives                        | Specifier | Gives                        |
| --------- | ---------------------------- | --------- | ---------------------------- |
| `%Y`      | Year: `2026`                 | `%p`      | `AM` or `PM`                 |
| `%y`      | Year, two digits: `26`       | `%b`      | Month, short: `Oct`          |
| `%m`      | Month: `01`–`12`             | `%B`      | Month: `October`             |
| `%d`      | Day: `01`–`31`               | `%a`      | Weekday, short: `Thu`        |
| `%e`      | Day, space-padded: ` 1`–`31` | `%A`      | Weekday: `Thursday`          |
| `%H`      | Hour: `00`–`23`              | `%j`      | Day of the year: `001`–`366` |
| `%I`      | Hour: `01`–`12`              | `%Z`      | Time zone: `PDT`             |
| `%M`      | Minute: `00`–`59`            | `%z`      | Offset from UTC: `-0700`     |
| `%S`      | Second: `00`–`59`            | `%s`      | Epoch seconds                |
| `%L`      | Millisecond: `000`–`999`     | `%F`      | `%Y-%m-%d`                   |
| `%%`      | `%`                          | `%T`      | `%H:%M:%S`                   |

- A specifier not listed is left as written, so `%Q` stays `%Q` and a typo shows.
- A negative `secondsOffset` is in the past.
- `timeZone` is `local`, the time zone of the machine running the test; `utc`; an IANA
  name, such as `America/New_York`; or a military letter. `A` to `M` are 1 to 12 hours
  ahead of UTC, skipping `J`, `N` to `Y` are 1 to 12 hours behind, and `Z` is UTC, so
  `U` is -08:00, not UTC. `IST` is India.
