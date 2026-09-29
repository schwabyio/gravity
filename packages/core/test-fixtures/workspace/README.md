# Format fixtures

A workspace in our own format: collections live under `collections/`, directories
inside it group them, and `environments/` is a sibling. See
[`SPEC.md`](../../../../SPEC.md).

```
workspace/
├── collections/
│   ├── status-codes.yml
│   └── checkout/
│       └── sessions.yml
├── environments/
│   └── demo.yml
└── not-a-collection.yml      never looked at
```

| File | Covers |
| --- | --- |
| `collections/status-codes.yml` | collection `headers`, `settings`, `vars` and `stepTags`, two steps, per-step `settings` and `tags` |
| `collections/checkout/sessions.yml` | a collection in a grouping directory, with `exclude: true`: `docs`, collection `before.script` and `tests`, three steps, disabled and repeated headers, `gta` header and body checks with their modifiers, unordered arrays, a form body, `gta.test` |
| `environments/demo.yml` | typed vars (boolean, number, null), `secret`, object form |
| `not-a-collection.yml` | a YAML file outside `collections/` — discovery must never see it |

`format.test.ts` parses every collection here, re-emits it and asserts the output is
byte-identical, so any change to the serializer that reformats a file fails the build.
