# The finding contract

A finding is one problem Lookover measured: what it expected, what it saw, where, the evidence, and a
prompt you can paste into your coding agent to fix it. This page describes findings as they are
written today. The types are in `packages/core/src/findings/types.ts`.

Every finding in this release is a **candidate**: it comes from a measurement and nothing has judged
or reproduced it yet. The judge, `lookover replay` and the report arrive in the next release.

## Where findings live

| File | What it holds |
| --- | --- |
| `.lookover/findings.json` | The latest run's findings. |
| `.lookover/runs/<run id>/findings.json` | The same file for that run (the two hold the same bytes). |
| `.lookover/runs/<run id>/evidence/` | The screenshots, crops and JSON evidence the findings point to. |
| `.lookover/runs/<run id>/run.jsonl` | The run log: each new finding is a `finding.candidate` event. |

Both `findings.json` files are written atomically (to a temporary file, then renamed), so a reader
never sees half a file, and they are redacted (see below). A run with `--map-only` writes a file with
no findings. Nothing in `.lookover/` leaves your machine.

`readLatestFindings(lookoverDir)` in `@jayslifecode/lookover-core` reads `.lookover/findings.json`
back. It returns `null` when no run has written one yet, and fails with `E_RUN_FAILED` when the file
is not JSON or is not version 1 with `findings` and `worthALook` lists.

## The file

```ts
interface FindingsFile {
  version: 1;
  runId: string;           // e.g. "20261022-034634-lkv1"
  createdAt: string;       // ISO 8601
  findings: Finding[];     // the candidates
  worthALook: Finding[];   // lower-confidence candidates, kept apart
  skipped?: { reason: string; count: number }[];  // what the lenses left out, per reason
}
```

`skipped` adds up what the lenses skipped on every screen (each screen's `screen.inspected.skipped` in
the run log), one entry per reason, the most frequent first and then by reason. A skip is a measurement
that could not be trusted or was not reached (`background-uncertain:overlapped`, `time-budget`, …; the
reasons are listed in [the interaction lens](lenses/interaction.md)); it never becomes a finding. The
summary `lookover run` prints shows the three most frequent in its `Skipped` row (`none` when there are
none). The field is optional: a file written before it existed has none, and the version stays 1.

`worthALook` holds what is less certain than a candidate: missing hover feedback
(`interaction.hover-state-missing`), which a hover effect written in JavaScript would not show, and
console warnings (`observers.console-warning`). The summary counts them but does not list them.

## Fields every finding has

| Field | What it is |
| --- | --- |
| `id` | The finding's identity, the same on every run (see "The id"). |
| `key` | What makes this the same problem next run (see "The key"). |
| `shape` | `"step"` or `"occurrence"` (see "The two shapes"). |
| `source` | Who found it: `"interaction"` (the lens) or `"observers"`. |
| `rule` | `{ id, source: "catalogue" }`: the rule it breaks, always one of [the catalogue](rules.md). |
| `severity` | `blocker`, `high`, `medium` or `low`: the rule's own severity, never a guess. |
| `status` | `"candidate"`. |
| `title` | The rule's title in plain language. |
| `expected` | What the rule expects. |
| `observed` | What was measured, as the end of a sentence: `shows no change when it receives keyboard focus`. |
| `whyItMatters` | One or two sentences for someone who is not an engineer. |
| `evidence` | `{ kind, label, ref }[]`: what backs it up (see "Evidence"). |
| `fixPrompt` | The prompt for your coding agent (see "The fix prompt"). |
| `createdAt` | When it was measured, ISO 8601. |

`title`, `expected`, `whyItMatters` and `severity` come from the rule in the catalogue, so the same
rule always reads the same way.

## The two shapes

### Step findings

A step finding is about one element on one screen, and carries the steps that show it again.

```ts
{
  shape: 'step';
  screenId: string;               // the screen in app-map.json
  target: {
    selector: string;             // finds exactly this element; redaction leaves it unchanged
    role: string;                 // its accessibility role, or its tag when the tree does not list it
    name: string;                 // its accessible name
    componentName: string | null; // the React component, in a development build
    signature: string | null;     // its tag and sorted class list joined by ".", e.g. "button.btn.primary"
    box: { x, y, width, height }; // its border box in document coordinates, CSS pixels
  } | null;
  trace: {
    route: string;                // the route pattern, e.g. "/organisations/[id]"
    url: string;
    viewport: { name, width, height };
    steps: Step[];
  };
}
```

`signature` is the element's class signature, the same one the state gallery crops one control of:
controls that share it look alike, so it lets findings about one component be grouped. It is `null`
when the element could not be read in the page when the finding was made.

A step is one of `{ kind: 'navigate', url }`, `{ kind: 'set-viewport', viewport }`,
`{ kind: 'force-state', selector, state: 'hover' | 'focus' | 'active' }`, `{ kind: 'focus', selector }`,
`{ kind: 'press', key: 'Tab', times }` and `{ kind: 'measure', what }`. The forced-state rules use
`navigate`, `set-viewport`, `force-state`, `measure`; the static measures use `navigate`,
`set-viewport`, `measure`; the Tab walk uses `navigate`, `set-viewport`, `press` (as many times as it
took to get there), `measure`.

### Occurrence findings

An occurrence finding is one problem seen in several places: a console message, a failing request, a
raw value in the text, a page that scrolls sideways.

```ts
{
  shape: 'occurrence';
  occurrences: {
    screenId: string;
    route: string;
    url: string;
    viewport: { name, width, height };
    selector: string | null;      // the element, or null for the page as a whole
    measured: Record<string, string | number | boolean | null>;  // what was measured there
  }[];
}
```

The first occurrence is where it was seen first; it leads the fix prompt.

## The key

The key says what makes a finding the same problem. For a step finding it is the route and the
element, `<route>|<selector>`, for example `/settings|[data-testid="settings-save"]`. An occurrence
finding's key is its rule's own grouping:

| Rule | Key |
| --- | --- |
| `observers.console-error`, `observers.console-warning`, `observers.page-error` | the message with URLs as `<url>`, numbers as `#` and whitespace collapsed, at most 200 characters |
| `observers.request-server-error`, `-client-error`, `-network-error` | `<method> <host><route pattern> → <status or failure>`, e.g. `GET localhost:3123/api/stats → 500` |
| `observers.raw-value`, `observers.raw-i18n-key`, `observers.unresolved-placeholder` | `<kind>` and the first 120 characters of the text, joined by `\|` |
| `interaction.positive-tabindex` | the route |
| `interaction.horizontal-overflow` | `<route>\|<viewport name>` |
| `interaction.text-clipped` | `<route>\|<viewport name>\|clipped` |

## The id

`id` is the first 12 hexadecimal characters of the SHA-256 of `<rule id>|<key>`. The same rule and key
give the same id on every run, which is what lets a later release remember a decision ("mark as
intended") about a finding.

Within a run, findings with the same id are merged, in the order each id was first seen. An occurrence
finding gains the occurrences and evidence of the later ones (an occurrence is told apart by its
screen, selector and viewport name, a piece of evidence by its `ref.id`; the first one seen wins), and
when that adds an occurrence its fix prompt is built again to list them all. `observed` stays the first
one's. Any other repeat is dropped in favour of the first.

## `status`

Every finding is `"candidate"` in this release. The next release adds `"confirmed"` and `"rejected"`
(from the judge, which re-runs a finding before it reaches the report) and `"intended"` (your "mark as
intended" decision, kept in `.lookover/`).

## Evidence

Each evidence item is `{ kind, label, ref }`. `kind` is one of `screenshot`, `crop`, `styles`,
`console`, `requests`, `text`, `measurements` and `gallery`; `label` says what it shows (`at rest`,
`focused`, `mobile 390×844`, `Console output on /reports`). `ref` points into the run's evidence
folder:

```ts
{
  id: string;     // the first 16 hex characters of the SHA-256 of the file's bytes
  path: string;   // relative to the run directory, with forward slashes, e.g. "evidence/styles-12e63ab7a992bebd.json"
  bytes: number;
  kind: 'png' | 'json';
}
```

Evidence is stored by content: identical bytes are stored once, so a control that looks the same at
rest and focused has one crop for both. A PNG is `evidence/<id>.png`; a JSON file is
`evidence/<name>-<id>.json`, where the name says what it is (`styles`, `measurements`,
`console-<screenId>`, `requests-<screenId>`, `text-<screenId>`, `gallery-<screenId>`).

## The fix prompt

`fixPrompt` is plain text, one statement per line, written to be pasted into a coding agent:

1. **Where and what.** For a finding on an element:
   ``In <route> (<url>), the <role> "<name>" (selector `<selector>`, React component <component>) <observed>.``
   The component part appears only when the component is known. For a finding with no element (a
   console message, a request): `In <route> (<url>), <observed>.` The route and URL are the first
   occurrence's.
2. **Occurrences**, for an occurrence finding: `Occurrences (<n>):`, then one line per occurrence,
   `<route> <selector, or "page"> — <name>=<value>, …`, at most 10 of them, then `… and <n> more` when
   there are more.
3. **The rule:** `Rule: <title>. Expected: <expected> <why it matters>`
4. **The fix:** `Fix: <the rule's hint>`, followed by `Reference: <standard> <criterion> (<url>).` when
   the rule has one.
5. **The closing line:** `Keep the control's accessible name, then tell me which file you changed.`
   When the finding has no element, there is no control whose name to keep, and the line is
   `Tell me which file you changed.`

For example, from the bench:

```text
In /settings (http://localhost:3123/settings), the button "Save" (selector `[data-testid="settings-save"]`, React component SettingsForm) shows no change when it receives keyboard focus.
Rule: Keyboard focus is not visible. Expected: When you press Tab, the control that receives focus shows a clear outline or highlight. People who get around with a keyboard instead of a mouse need to see where they are on the page. Without a visible mark they cannot tell which button or link the next key press will use.
Fix: Give this control a `:focus-visible` style such as a 2px outline, and remove any `outline: none` that has no replacement. Reference: WCAG 2.2 2.4.7 Focus Visible (https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).
Keep the control's accessible name, then tell me which file you changed.
```

File and line appear only for rules that come from code, which arrive with the behaviour lens.

## Redaction

Every JSON file Lookover stores (the findings, the evidence, the App Map) and every line of the run log
is redacted before it is written. Every string is checked for secrets: `Bearer` tokens, JWTs, AWS
access keys, Stripe-style and Supabase keys and e-mail addresses are replaced by a placeholder
(`Bearer [token]`, `[jwt]`, `[aws-key]`, `[api-key]`, `[email]`), and so is the value in a
`key: value` or `key=value` pair whose key contains `api_key` (or `api-key`, `apikey`), `secret`,
`token` or `password`. A string
under a sensitive key (`password`, `token`, `authorization`, `cookie`, `set-cookie`, `secret`, keys
ending in `password`, `secret`, `token` or `apikey`, and the like) is replaced outright with
`[redacted]`. Console messages, request URLs and page text are redacted before they are cut to their
length limits, so a secret that straddles the cut cannot survive it. Selectors are chosen so that
redaction leaves them unchanged, so a stored selector always finds its element again. Screenshots and
crops are stored as they were taken.
