# Lookover bench

The bench is how Lookover's precision and recall are measured. `bench/app` is a small Next.js app
with deliberately seeded issues, and `bench/seeds.json` lists those issues so a harness can compare
them with what Lookover reports. The app is built correct (labelled fields, a visible focus ring, one
date format, one primary colour), so every defect in it is one of the ten seeded issues listed under
[Seeds](#seeds), and three things that look like defects but are correct are listed beside them as
controls. Until the benchmark harness exists, the end-to-end suite (`pnpm test:e2e`,
`packages/cli/test/e2e/bench.test.ts`) runs Lookover against the app and fails unless every seeded issue
is found and no control is flagged.

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
| `/`                   | Dashboard: two stat cards (organisation count, latest registration), a live-stats line, links |
| `/organisations`      | Table of organisations; each name links to its edit page, and each row has Edit and Copy email icons |
| `/organisations/[id]` | Edit form: name, phone (8 digits), email, registered on (`YYYY-MM-DD`); Save, Cancel; a "last edited" line |
| `/organisations/new`  | The same form, empty                                                           |
| `/reports`            | A button that opens the summary report in a `<dialog>`, and an Export CSV button |
| `/settings`           | Workspace name, contact email, time zone; Save                                 |

`GET /api/stats` is a Route Handler, not a screen: the dashboard asks it for live stats.

Dates appear in one format everywhere, `YYYY-MM-DD`, including the registered-date field, which is
a text input rather than the browser's date picker (that one renders in the browser's locale). It
keeps the default keyboard: a numeric keypad (`inputMode="numeric"`) has no hyphen on iOS.

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

`bench/seeds.json` lists every seeded issue and control; for example:

```json
{
  "version": 1,
  "app": "bench/app",
  "issues": [
    {
      "id": "interaction-001",
      "lens": "interaction",
      "route": "/settings",
      "selector": "[data-testid=\"settings-save\"]",
      "rule": "interaction.focus-visible-missing",
      "expectedSeverity": "high"
    }
  ]
}
```

Each entry in `issues` has this shape:

```ts
{
  id: string;                 // unique and stable, e.g. "interaction-001"
  lens: 'interaction' | 'consistency' | 'behaviour' | 'observers';
  route: string;              // route pattern as in app-map.json, e.g. "/organisations/[id]"
  selector?: string;          // CSS selector of the affected element, when the issue is on one element
  rule: string;               // the rule Lookover should report the issue under
  expectedSeverity: 'blocker' | 'high' | 'medium' | 'low';
  control?: boolean;          // true for a clean control: looks like the issue but is correct
}
```

A control entry describes something Lookover must **not** flag. It counts towards precision: a
finding that matches a control is a false positive. An entry without `control` is a real seeded
issue and counts towards recall. A control's `expectedSeverity` is its rule's own severity: what a
false positive would have been reported as.

### Seeded issues

| Id | Route | Selector | Rule | Severity | What is wrong |
| --- | --- | --- | --- | --- | --- |
| `interaction-001` | `/settings` | `[data-testid="settings-save"]` | `interaction.focus-visible-missing` | high | The Save button has `focus:outline-none` and nothing in its place (`BUTTON_PRIMARY_NO_RING`) |
| `interaction-002` | `/reports` | `[data-testid="export-csv"]` | `interaction.text-contrast-fail` | high | The Export CSV button is `text-slate-400` on `bg-slate-100`, about 2.4:1 |
| `interaction-003` | `/organisations` | `a[aria-label="Edit Northwind Logistics"]` | `interaction.target-size` | medium | Each row has a 16 px Edit icon link 4 px from a 16 px Copy email icon button (the selector is the first row's) |
| `interaction-004` | `/` | `[data-testid="stat-organisations"]` | `interaction.keyboard-unreachable` | high | The stat cards are `<div role="button" onClick>` with no `tabIndex` (the selector is the first card's) |
| `interaction-005` | `/settings` | `#workspaceName` | `interaction.positive-tabindex` | low | The Workspace name input has `tabIndex={1}` |
| `interaction-006` | `/organisations` | `[data-testid="organisations-table"]` | `interaction.horizontal-overflow` | high | The table is at least 720 px wide and its wrapper no longer scrolls, so the page scrolls sideways; it only does at the `mobile` viewport (390 px), so the occurrence to match has `viewport.name` `mobile` |
| `observers-001` | `/reports` | none | `observers.console-error` | medium | `ReportDialog` logs `Report locale missing: falling back to en` once when it mounts |
| `observers-002` | `/settings` | `#timeZone-hint` | `observers.raw-i18n-key` | medium | The time zone hint reads `settings.timezone.hint` |
| `observers-003` | `/organisations/[id]` | `#last-edited` | `observers.raw-value` | high | "Last edited by undefined": `Organisation.editor` is optional and no organisation has one |
| `observers-004` | `/` | none | `observers.request-server-error` | high | The dashboard asks `/api/stats` for live stats on mount and the route answers `500` |

### Controls

| Id | Route | Selector | Rule | Why it is correct |
| --- | --- | --- | --- | --- |
| `control-001` | `/login` | `body > main:nth-of-type(1) > div:nth-of-type(1) > form:nth-of-type(1) > button:nth-of-type(1)` | `interaction.focus-visible-missing` | The Sign in button shows the shared focus ring |
| `control-002` | `/organisations` | `[data-testid="organisations-table"] > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1) > a:nth-of-type(1)` | `interaction.target-size` | The organisation name links are ordinary inline text links (the selector is the first row's) |
| `control-003` | `/reports` | `[data-testid="open-report"]` | `interaction.hover-state-missing` | The Open summary report button changes on hover (`hover:bg-primary/90`) |

### Selectors

A `selector` is the selector **as Lookover builds it**, never one written by hand: the first of
`[data-testid]`, `#id`, `tag[name]`, `tag[aria-label]` and `a[href]` that matches exactly the one
element, else a path. That is why an element with no id, name or label of its own carries a
`data-testid` in the app. Take it from the `app-map.json` of a map-only run, or, for an element that
is not interactive (the table, a paragraph), from a finding's `target.selector` or occurrence
`selector` in `findings.json`:

```sh
pnpm --filter "./packages/**" build
pnpm --filter @jayslifecode/lookover-bench dev      # in another terminal
# in an empty directory, after `lookover init` and a form login (see packages/cli/test/e2e/bench.test.ts)
LOOKOVER_USERNAME=demo@lookover.dev LOOKOVER_PASSWORD=demo-password \
  node <repo>/packages/cli/dist/index.js run --yes --map-only --max-screens 12
```

When you seed an issue, change the app and add its entry in the same commit, so the code and
`seeds.json` always agree. Where a linter would reject the seeded code (the stat card, the positive
tabindex), a `biome-ignore` comment names the seed. `bench/app/test/seeds.test.ts` checks that every
entry has the shape above, that ids are unique, that every `route` is a page of the app and that
every `rule` is in the rules catalogue.
