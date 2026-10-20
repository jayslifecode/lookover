# Lookover bench

The bench is how Lookover's precision and recall are measured. `bench/app` is a small Next.js app
with deliberately seeded issues, and `bench/seeds.json` lists those issues so a harness can compare
them with what Lookover reports. Right now the app has no seeded issues: it is built correct
(labelled fields, a visible focus ring, one date format, one primary colour), so every seeded bug
added later is a deliberate change.

## Running the app

```sh
pnpm install
pnpm --filter @jayslifecode/lookover-bench dev     # http://localhost:3123
```

The app always runs on port **3123** (`dev` and `start`). `build` runs `next build`.

### Credentials

Every page except `/login` redirects to `/login` until you sign in. The credentials are read on the
server:

| Variable         | Default             |
| ---------------- | ------------------- |
| `BENCH_USER`     | `demo@lookover.dev` |
| `BENCH_PASSWORD` | `demo-password`     |

These are demo values for a local app, not secrets. Signing in sets an `httpOnly` cookie,
`bench_session`, and goes to `/`. `GET /logout` clears it and goes back to `/login`.

The login form's fields are `input[name="email"]`, `input[name="password"]` and
`button[type="submit"]`, which is what Lookover's form-login config points at.

### Screens

| Route                 | What it shows                                                                  |
| --------------------- | ------------------------------------------------------------------------------ |
| `/login`              | Email and password form                                                        |
| `/`                   | Dashboard: organisation count, latest registration, links                      |
| `/organisations`      | Table of organisations; each name links to its edit page                       |
| `/organisations/[id]` | Edit form: name, phone (8 digits), email, registered on (`YYYY-MM-DD`); Save, Cancel |
| `/organisations/new`  | The same form, empty                                                           |
| `/reports`            | A button that opens the summary report in a `<dialog>`                         |
| `/settings`           | Workspace name, contact email, time zone; Save                                 |

Dates appear in one format everywhere, `YYYY-MM-DD`, including the registered-date field, which is
a text input rather than the browser's date picker (that one renders in the browser's locale).

## Data and reset

The store is plain JSON under `bench/app/data/`:

- `data/seed/organisations.json` (12 organisations) and `data/seed/settings.json` are committed.
- `data/organisations.json` and `data/settings.json` are the live copies. They are git-ignored and
  written atomically (temp file, then rename). Until one has been written, reads come from the seed.

To put the data back to the seed:

```sh
pnpm --filter @jayslifecode/lookover-bench reset
# or, from the repo root (the script finds bench/app/data from its own location, not the cwd)
node --experimental-strip-types bench/scripts/reset.ts
```

Lookover runs in `full` interaction mode against the bench, so it will change data. Reset before
each measured run.

## Seeds

`bench/seeds.json` lists every seeded issue:

```json
{
  "version": 1,
  "app": "bench/app",
  "issues": []
}
```

Each entry in `issues` has this shape:

```ts
{
  id: string;                 // unique and stable, e.g. "interaction-001"
  lens: 'interaction' | 'consistency' | 'behaviour';
  route: string;              // route pattern as in app-map.json, e.g. "/organisations/[id]"
  selector?: string;          // CSS selector of the affected element, when the issue is on one element
  rule: string;               // the rule Lookover should report the issue under
  expectedSeverity: 'blocker' | 'high' | 'medium' | 'low';
  control?: boolean;          // true for a clean control: looks like the issue but is correct
}
```

A control entry describes something Lookover must **not** flag. It counts towards precision: a
finding that matches a control is a false positive. An entry without `control` is a real seeded
issue and counts towards recall.

When you seed an issue, change the app and add its entry in the same commit, so the code and
`seeds.json` always agree.
