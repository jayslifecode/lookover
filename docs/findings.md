# The finding contract

A finding is one problem Lookover measured and reproduced: what it expected, what it saw, where, the
evidence, how it was judged, and a prompt you can paste into your coding agent to fix it. This page
describes findings as they are written today. The types are in `packages/core/src/findings/types.ts`.

A finding starts as a **candidate**, a measurement nothing has judged. The judge measures it again in
three fresh browser contexts and **confirms** it only when all three see it; anything less is
**rejected**. A finding you marked as **intended** is left out of later runs. Only confirmed findings
are listed as findings. [How a run works](how-it-works.md#stage-5-the-judge) describes the judge.

## Where findings live

| File | What it holds |
| --- | --- |
| `.lookover/findings.json` | The latest run's findings. |
| `.lookover/runs/<run id>/findings.json` | The same file for that run (the two hold the same bytes). |
| `.lookover/runs/<run id>/evidence/` | The screenshots, crops and JSON evidence the findings and their reproductions point to. |
| `.lookover/runs/<run id>/run.jsonl` | The run log: each new candidate is a `finding.candidate` event, each decision a `finding.judged` event. |
| `.lookover/decisions.json` | Your decisions: the findings you marked as intended (see "Decisions"). |
| `.lookover/replays/<id>.mjs` | The standalone replay scripts `lookover replay --script` wrote. |

Both `findings.json` files are written atomically (to a temporary file, then renamed), so a reader
never sees half a file, and they are redacted (see below). A run with `--map-only` writes a file with
no findings. Nothing in `.lookover/` leaves your machine.

`readLatestFindings(lookoverDir)` in `@jayslifecode/lookover-core` reads `.lookover/findings.json`
back, and `readFindingsAt(path)` reads one run's. `readLatestFindings` returns `null` when no run has
written one yet; both fail with `E_RUN_FAILED` when the file is not JSON, is not version 1 or 2, or
lacks its lists.

## The file

```ts
interface FindingsFile {
  version: 2;
  runId: string;           // e.g. "20261022-034634-lkv1"
  createdAt: string;       // ISO 8601
  findings: Finding[];     // confirmed findings, or the candidates of a run that was not judged
  worthALook: Finding[];   // lower-confidence candidates, kept apart, never judged
  skipped?: { reason: string; count: number }[];  // what the lenses left out, per reason
  rejected: Finding[];     // judged and not reproduced, or explained away; never listed as findings
  intended: Finding[];     // marked intended by you; never listed as findings
  judge: JudgeTotals | null;          // what the judge model cost; null for a run that was not judged
  environment: Environment | null;    // where the judge ran; null for a run that was not judged
}
```

In a judged run, `findings` holds the confirmed findings (a candidate never handed to the judge would
stay there as a candidate; the summary and the report count only the confirmed ones). A run with
`--no-judge` lists its candidates in `findings`, as measured, less the ones your decisions mark
intended, which go to `intended`; its `judge` and `environment` are `null`. `rejected` and `intended`
are kept so you can see what was set aside and why, but they are never listed or counted as findings.

`skipped` adds up what the lenses skipped on every screen (each screen's `screen.inspected.skipped` in
the run log), one entry per reason, the most frequent first and then by reason. A skip is a measurement
that could not be trusted or was not reached (`background-uncertain:overlapped`, `time-budget`, …; the
reasons are listed in [the interaction lens](lenses/interaction.md)); it never becomes a finding. The
summary `lookover run` prints shows the three most frequent in its `Skipped` row (`none` when there are
none). The field is optional: a file written before it existed has none.

`worthALook` holds what is less certain than a candidate: missing hover feedback
(`interaction.hover-state-missing`), which a hover effect written in JavaScript would not show, and
console warnings (`observers.console-warning`). They are neither reproduced nor judged. The summary
counts them but does not list them; the report shows them behind its Worth a look switch.

`judge` is the run's model totals:

```ts
interface JudgeTotals {
  model: string | null;   // the judge model; null when the harness decided alone
  calls: number;          // successful model calls (a cached verdict is not one)
  cacheHits: number;      // verdicts served from .lookover/cache/judge/
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };  // tokens
  estimatedUsd: number | null;  // null when there was no model to ask, or for one the price table does not know
  unavailable: 'no-api-key' | 'disabled' | 'api-error' | null;  // why the model was not used, when it was not
}
```

`environment` is where the judge ran, at the first configured viewport (each judgement has its own, at
its finding's viewport): `{ browser, os, node, lookover, viewport }`, for example `chromium 156.0.8078.4`,
`darwin 25.0.0 arm64`, `v24.15.0`, the Lookover version, and `{ name, width, height }`.

**Version 1.** Files written before the judge existed are version 1: no `judgement` on the findings and
no `rejected`, `intended`, `judge` or `environment`. They are still read: `readLatestFindings` and
`readFindingsAt` upgrade one in memory to the version 2 shape (every finding a candidate with
`judgement: null`, the new lists empty, `judge` and `environment` `null`) and leave the file on disk as
it is. Any other version fails with `E_RUN_FAILED`.

## Fields every finding has

| Field | What it is |
| --- | --- |
| `id` | The finding's identity, the same on every run (see "The id"). |
| `key` | What makes this the same problem next run (see "The key"). |
| `shape` | `"step"` or `"occurrence"` (see "The two shapes"). |
| `source` | Who found it: `"interaction"` (the lens) or `"observers"`. |
| `rule` | `{ id, source: "catalogue" }`: the rule it breaks, always one of [the catalogue](rules.md). |
| `severity` | `blocker`, `high`, `medium` or `low`: the rule's own severity, never a guess. |
| `status` | `candidate`, `confirmed`, `rejected` or `intended` (see "`status`"). |
| `judgement` | How the judge or you decided, or `null` while it is a candidate (see "`judgement`"). |
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
give the same id on every run, which is what lets a decision ("mark as intended") hold on later runs and
lets the report compare a run with the one before it. (The judge's verdict cache does not go by the id:
it recognises the same measured bundle, whatever the finding's id.)

Within a run, findings with the same id are merged, in the order each id was first seen. An occurrence
finding gains the occurrences and evidence of the later ones (an occurrence is told apart by its
screen, selector and viewport name, a piece of evidence by its `ref.id`; the first one seen wins), and
when that adds an occurrence its fix prompt is built again to list them all. `observed` stays the first
one's. Any other repeat is dropped in favour of the first.

## `status`

| Status | Who sets it | When | Where it is written |
| --- | --- | --- | --- |
| `candidate` | The lens or observer that measured it | As it is measured; it stays one in a run with `--no-judge`, as a worth-a-look entry, and in a judged run if it was never handed to the judge | `findings`, `worthALook` |
| `confirmed` | The judge: the harness, or the judge model | It reproduced on all three attempts (a step finding), or at least one of its occurrences did, and the model, when asked, did not reject it | `findings` |
| `rejected` | The judge: the harness (`timing`) or the judge model (`explorer-error`, `exemption`) | It reproduced on fewer than three attempts, or the model explained it away | `rejected` |
| `intended` | You, with `lookover mark` or the report's Mark intended | Its id is in `.lookover/decisions.json` when a run inspects it | `intended` |

A finding that is intended is not reproduced, not sent to a model and not listed as a finding, on this
run or any later one, until you clear the decision.

## `judgement`

`judgement` says how a finding was decided. It is `null` while the finding is a candidate.

| Field | What it is |
| --- | --- |
| `reproduced` | Step finding: the attempts that reproduced it. Occurrence finding: the occurrences that reproduced on every attempt. |
| `of` | Step finding: the attempts made (3). Occurrence finding: the occurrences tried. `0` for your decision. |
| `attempts` | Every attempt, in order (an occurrence finding's occurrence by occurrence; see below). Empty for your decision. |
| `decidedBy` | `harness` (reproduction alone), `model` (the judge model gave the verdict) or `user` (your decision). |
| `attribution` | Why it is what it is: `product-defect` (confirmed), `timing` (did not reproduce every time), `explorer-error` or `exemption` (rejected by the model). `null` for your decision. |
| `oracle` | The standard or rule the model applied, at most 120 characters; `null` unless the model decided. |
| `note` | Plain language for the report, at most 280 characters: the model's reason, the harness's timing note, why the model was not used, or your note. Often `null` for a harness confirmation. |
| `model` | The model id, when the model decided. |
| `usage` | The tokens the call used (`input`, `output`, `cacheRead`, `cacheWrite`); `null` without a call (a cached verdict included). |
| `estimatedUsd` | What the call cost; `0` for a cached verdict, `null` without a call or for a model the price table does not know. |
| `cached` | The verdict came from `.lookover/cache/judge/`. |
| `droppedOccurrences` | Occurrence finding: the occurrences that did not reproduce every time (a confirmed finding keeps only the others). |
| `environment` | Where it was judged: `{ browser, os, node, lookover, viewport }`, at the finding's viewport. `null` for your decision. |
| `judgedAt` | When it was decided, ISO 8601. |

An **attempt** is one measurement in a fresh browser context:

| Field | What it is |
| --- | --- |
| `index` | 1, 2, 3. |
| `occurrence` | For an occurrence finding, which one this attempt was for: `{ screenId, selector, viewport }` (the viewport's name); `null` for a step finding. |
| `reproduced` | Whether the measurement saw the same finding again. |
| `observed` | The re-measured finding's `observed`, when it reproduced. |
| `skipped` | Why the lens could not measure it, when it could not (`gone` when nothing on the fresh page has the selector, `error:<message>` when the attempt failed). |
| `durationMs` | The page load and the measure. |
| `evidence` | First the attempt's own record, `reproduction-<finding id>-<hash>.json` (labelled `reproduction <n>`), then the evidence the re-measurement produced. |

From the report's fixture run (a bench run without `ANTHROPIC_API_KEY`), the judgement of the
`interaction.keyboard-unreachable` finding on the dashboard's `Organisations 12` card, with the second
and third attempts left out:

```json
{
  "reproduced": 3,
  "of": 3,
  "attempts": [
    {
      "index": 1,
      "occurrence": null,
      "reproduced": true,
      "observed": "cannot receive keyboard focus",
      "skipped": null,
      "durationMs": 928,
      "evidence": [
        {
          "kind": "measurements",
          "label": "reproduction 1",
          "ref": { "id": "212d2c146c1117c8", "path": "evidence/reproduction-da77d007d373-212d2c146c1117c8.json", "bytes": 744, "kind": "json" }
        },
        {
          "kind": "measurements",
          "label": "whether the element can receive focus",
          "ref": { "id": "54daa05e1eaf4778", "path": "evidence/measurements-54daa05e1eaf4778.json", "bytes": 115, "kind": "json" }
        }
      ]
    }
  ],
  "decidedBy": "harness",
  "attribution": "product-defect",
  "oracle": null,
  "note": null,
  "model": null,
  "usage": null,
  "estimatedUsd": null,
  "cached": false,
  "droppedOccurrences": [],
  "environment": {
    "browser": "chromium 156.0.8078.4",
    "os": "darwin 25.0.0 arm64",
    "node": "v24.15.0",
    "lookover": "0.0.0",
    "viewport": { "name": "desktop", "width": 1440, "height": 900 }
  },
  "judgedAt": "2026-10-22T12:28:08.992Z"
}
```

A finding the timing rule rejected has `decidedBy: "harness"`, `attribution: "timing"` and the note
`Reproduced <n> of 3 times; a problem that comes and goes is not reported` (for an occurrence finding,
`<n>` is the best any one occurrence did). A finding the model rejected has `decidedBy: "model"`, its
`attribution`, `oracle` and `note`, and the call's `usage` and `estimatedUsd`. A finding the harness
confirmed because the model failed has the note `The judge model was unavailable (<why>), so this finding
is confirmed by reproduction alone.` A finding you marked has `decidedBy: "user"`, `of: 0`, no attempts
and your note.

## Decisions

Some findings are on purpose: a control that is meant to be decorative, a page that scrolls sideways by
design. Mark one as **intended** and later runs leave it out. The decisions live in
`.lookover/decisions.json`, by finding id:

```json
{
  "version": 1,
  "decisions": {
    "3f44e15e94c4": {
      "status": "intended",
      "at": "2026-10-25T09:36:47.702Z",
      "note": "The focus ring is drawn by the parent card"
    }
  }
}
```

Mark one from the terminal with `lookover mark`, or with Mark intended in the report's finding panel
(which also takes a note, and offers Undo). The id can be shortened to its start when only one finding's
id starts that way; any finding of `.lookover/findings.json` can be marked, whatever its status:

```sh
lookover mark 3f44e1 intended --note "The focus ring is drawn by the parent card"
lookover mark 3f44e1 clear    # forget the decision: the next run judges the finding again
```

`lookover mark` fails with exit code 2, writing nothing, for a status other than `intended` or `clear`,
`--note` with `clear`, an id no finding has, or a start of an id that several findings share. Clearing a
finding that has no decision says so and changes nothing.

A decision applies from the next run on, since the finding's id is the same on every run. A decision
recorded in the report while the run is still going is recorded for the next run; the run under way
keeps its findings as its judge decides them. The file is replaced atomically and redacted like every
file Lookover stores; delete it to forget every decision. A file that cannot be read fails the next run
with `E_RUN_FAILED`.

## Replaying a finding

`lookover replay` measures one finding again, as the judge does, in a browser of its own: the finding's
screen loaded in a fresh context, the lens that reported it (or the observers) measuring it again.

```sh
lookover replay 3f44e1                       # once, in a browser window you can watch
lookover replay 3f44e1 --times 3 --headless  # three fresh contexts, no window
lookover replay 3f44e1 --run 20261025-183458-ffhu   # a finding of an earlier run
```

It finds the finding by its id, or the start of it, among the latest findings (with `--run <run id>`,
among that run's), whatever its status, and prints one line per attempt and the tally. Against the bench:

```text
Replaying 3f44e15e94c4 (interaction.focus-visible-missing) on http://localhost:3123/settings, 3 attempts
1  reproduced  shows no change when it receives keyboard focus  1.0 s
2  reproduced  shows no change when it receives keyboard focus  0.9 s
3  reproduced  shows no change when it receives keyboard focus  0.9 s
reproduced 3/3
```

The browser window shows unless `--headless`; `--times <n>` (default 1) sets the fresh contexts. A replay
uses the project's config as a run does: the disposable-data acknowledgement and the allowed hosts are
checked before anything launches, the confirmed backends are enforced (any other is blocked), and the
session logs in as `auth` says. It writes nothing under `.lookover/` (its evidence goes to a temporary
directory that is removed afterwards). Exit codes: `0` when every attempt reproduced the finding, `1`
when any did not (or the replay failed), `2` for a bad flag or an id that names no one finding, `3` when
the acknowledgement is missing. The report's Replay button does the same, once, in a browser window,
after the run has finished.

### The standalone script

`--script` writes a script that replays the finding without Lookover, instead of replaying it:

```sh
lookover replay 3f44e1 --script               # writes .lookover/replays/3f44e15e94c4.mjs
lookover replay 3f44e1 --script replay.mjs    # or where you say
```

The script is one ES module of about 0.9 MB: a header comment (what it replays, how to run it, its
environment variables), the finding itself as stored in `findings.json` (redacted), and Lookover's
replay runner (core, the interaction lens and the rules catalogue) bundled with esbuild, Playwright left
out. It needs only Playwright 1.64.1 and its Chromium:

```sh
npm i playwright@1.64.1
npx playwright install chromium
node 3f44e15e94c4.mjs
```

| Variable | What it does |
| --- | --- |
| `LOOKOVER_BASE_URL=<url>` | Replays on this origin instead, the same paths (default: the config's base URL when the script was written). |
| `HEADED=1` | Shows the browser window. |
| `TIMES=<n>` | Measures it in `n` fresh browser contexts (default 1). |
| `STORAGE_STATE=<path>` | Starts from this Playwright storage state, for a page behind a login (a form login's session is saved in `.lookover/state/form.json`). |

It prints what `lookover replay` prints and exits 0 only when every attempt reproduced the finding (1
otherwise, an error included). It reads no config: only the base URL's host is allowed (the loopback
always is), no backend is confirmed, so the app's calls to any other host are blocked, and it measures in
`safe` mode, which a replay never needs more than.

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

The prompt is written when the finding is measured, while it is still a candidate; judging does not
change it, except that an occurrence finding whose judge dropped some occurrences gets its prompt built
again to list only the kept ones. The report's Copy fix prompt copies it as it is.

For example, from the bench:

```text
In /settings (http://localhost:3123/settings), the button "Save" (selector `[data-testid="settings-save"]`, React component SettingsForm) shows no change when it receives keyboard focus.
Rule: Keyboard focus is not visible. Expected: When you press Tab, the control that receives focus shows a clear outline or highlight. People who get around with a keyboard instead of a mouse need to see where they are on the page. Without a visible mark they cannot tell which button or link the next key press will use.
Fix: Give this control a `:focus-visible` style such as a 2px outline, and remove any `outline: none` that has no replacement. Reference: WCAG 2.2 2.4.7 Focus Visible (https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).
Keep the control's accessible name, then tell me which file you changed.
```

File and line appear only for rules that come from code, which arrive with the behaviour lens.

## Redaction

Every JSON file Lookover stores (the findings, the evidence, the App Map, the decisions, the judge's
verdict cache) and every line of the run log is redacted before it is written, and so is the finding a
standalone replay script embeds. Every string is checked for secrets: `Bearer` tokens, JWTs, AWS
access keys, Stripe-style and Supabase keys and e-mail addresses are replaced by a placeholder
(`Bearer [token]`, `[jwt]`, `[aws-key]`, `[api-key]`, `[email]`), and so is the value in a
`key: value` or `key=value` pair whose key contains `api_key` (or `api-key`, `apikey`), `secret`,
`token` or `password`. A string under a sensitive key (`password`, `token`, `authorization`, `cookie`,
`set-cookie`, `secret`, keys ending in `password`, `secret`, `token` or `apikey`, and the like) is
replaced outright with `[redacted]`. Console messages, request URLs and page text are redacted before
they are cut to their length limits, so a secret that straddles the cut cannot survive it. Selectors
are chosen so that redaction leaves them unchanged, so a stored selector always finds its element again.
Screenshots and crops are stored as they were taken. One JSON file is not redacted: the session a form
login saves, `.lookover/state/form.json`, keeps its cookies as they are so that it can log in again; it
is readable only by you and must never be shared or committed.
