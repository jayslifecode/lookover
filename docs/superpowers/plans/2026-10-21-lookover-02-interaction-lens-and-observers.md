# Lookover 02 — Interaction Lens and Observers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lookover run` inspects every captured screen with the interaction lens and the always-on observers while it crawls, and writes **candidate findings** (the finding contract of spec §5, both shapes, with evidence, a step trace or occurrence list, and a fix prompt) to `.lookover/runs/<id>/findings.json`, summarised by the CLI; the bench app gains its first seeded interaction and observer issues and clean controls, and the end-to-end suite checks every seed is found and no control is flagged.

**Architecture:** Plan 01's crawler gains an inspection hook that runs after each screen is captured, on the already-loaded page. Core (`packages/core`) gets the finding contract, the `Lens` plugin interface, the observers (console, requests, rendered text; deterministic, no model) and the inspection pipeline that merges candidates, emits `finding.candidate` events and writes `findings.json`. The interaction lens lives in a new `packages/lenses` package and depends on core; the engine receives lenses by injection (`ReviewOptions.lenses`), so core never imports a lens. Rule heuristics live in JSON catalogues in `packages/rules`, validated with Zod and rendered to `docs/rules.md` by a generator that CI checks. No model calls in this plan: every candidate is measured. The judge (plan 03) later confirms or rejects candidates; until then the CLI labels them as not yet judged.

**Tech Stack:** Node `>=22.12` (dev on 24), pnpm 10, TypeScript `^5.9`, Playwright `1.64.1` (CDP: `CSS.forcePseudoState`, `DOM.pushNodesByBackendIdsToFrontend`, `Runtime.callFunctionOn`), Zod `^4.6`, Vitest `^5.0`, Biome `^2.5`; bench app Next.js `16.4.x` + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-20-lookover-design.md` (§3 constraints, §4 Stage 3 "Interaction lens" and "Observers", §5 the finding contract, §6 architecture, §7 evaluation, §9 v0 build order). Plan 02 of 4; plan 01 (`2026-10-20-lookover-01-foundation-and-app-map.md`) fixed the interfaces this plan consumes, and `2026-10-21-plan-01-backlog.md` lists the "do first" shapes that Tasks 1 and 2 land before any lens code reads the App Map. Base commit: `main` at `3f0c40f`.

## Global Constraints

- Everything in plan 01's Global Constraints and amendments still holds: TypeScript ESM, Node `>=22.12`, pnpm workspace, MIT, the network envelope, the acknowledgement gate, redaction of every stored JSON blob and log line, `.lookover/` layout, conventional commits, green `pnpm check` after every task, no `console` in library code.
- **No model calls.** Every candidate finding in this plan comes from a measurement. The Anthropic SDK is not a dependency of any package yet.
- **Lenses never act on data.** In this plan a lens may: force pseudo-classes over CDP, move keyboard focus, press Tab, resize the viewport and reload the screen's own URL. It never clicks, types into a field, submits, or navigates to another URL, so it is safe in both `full` and `safe` interaction modes. (The behaviour lens, v1, is where interaction policy matters.)
- **Precision over recall (spec §2 anti-goals).** When a measurement cannot be trusted (text over an image or gradient, a background whose alpha never reaches opaque, a selector that no longer resolves), the lens **skips** and records the skip with a reason in the state-gallery data; it never guesses. Each rule's exemptions are written in `docs/lenses/interaction.md` and tested.
- **Every finding names a rule from a catalogue** (`packages/rules`): severity comes from the rule, never from code paths or opinion. A rule id that is not in the catalogue is a test failure.
- **Findings are `status: 'candidate'`** in this plan. The CLI says so wherever it prints them. `.lookover/runs/<id>/findings.json` and `.lookover/findings.json` (latest) are written redacted and atomically, like the App Map.
- **Bounded inspection.** Per screen: at most `MAX_STATE_ELEMENTS = 60` elements get forced states, at most `MAX_GALLERY_ELEMENTS = 12` get cropped screenshots per state, the Tab walk presses at most `MAX_TAB_PRESSES = 300` times, and the whole lens stops at a `PER_SCREEN_BUDGET_MS = 10_000` deadline, recording what it skipped. The bench end-to-end run must finish within 150 s for 12 screens.
- Package names: `@jayslifecode/lookover-rules` (public), `@jayslifecode/lookover-lenses` (public), `@jayslifecode/lookover-test-support` (private). `packages/core` may depend on `-rules`; `-lenses` depends on `-core` and `-rules`; the CLI depends on all three. Core never imports `-lenses`.
- Tests are type-checked from this plan on (`tsconfig.test.json` per package, Task 1).

## Review Focus

1. **A focus ring drawn by a pseudo-element or a sibling** (Tailwind `ring-*` is a `box-shadow`; some design systems draw the ring on `::after`) — must not be reported as "focus not visible". The state snapshot compares the element *and* its `::before`/`::after` computed styles. Test in Task 9.
2. **Text over an image, a gradient or a translucent layer** — contrast is skipped with the reason `background-uncertain`, never computed against a guessed colour. Test in Task 8 (the in-page `effectiveBackground`) and Task 10.
3. **Inline links inside prose smaller than 24 px, and native checkboxes** — exempt from the target-size rule (WCAG 2.5.8's inline and user-agent exceptions); a 16 px icon button crowded against another target is not. Test in Task 10.
4. **Next.js development-mode console noise** (`[Fast Refresh]`, "Download the React DevTools", HMR websocket chatter) — not findings; a React hydration error or an uncaught exception is. Test in Task 6.
5. **A screen with hundreds of controls, or a page that keeps the main thread busy** — inspection ends at the per-screen deadline with `screen.inspected.skipped` saying what was not measured, and the crawl goes on; a lens that throws a non-Lookover error fails only that screen's inspection (recorded in `screen.inspected.error` and printed as a warning), never the run. Test in Task 5 (the pipeline) and Task 12 (the deadline).

---

## File structure

```
lookover/
├─ package.json                         check: biome → build packages/* → typecheck (src + tests) → tests → docs:rules --check
├─ docs/rules.md                        GENERATED from packages/rules/catalogue (Task 3)
├─ docs/findings.md                     the finding contract as implemented (Task 15)
├─ docs/lenses/interaction.md           every check, how it is measured, every exemption (Task 15)
├─ packages/rules/                      @jayslifecode/lookover-rules
│  ├─ catalogue/interaction.json  catalogue/observers.json
│  ├─ src/schema.ts   ruleSchema, catalogueSchema, Rule, Severity, RuleSource
│  ├─ src/index.ts    RULES, ruleById(), RULE_IDS
│  ├─ scripts/generate-docs.ts          `pnpm docs:rules [--check]` → docs/rules.md
│  └─ test/catalogue.test.ts  test/generate-docs.test.ts
├─ packages/test-support/               @jayslifecode/lookover-test-support (private)
│  └─ src/serve.ts                      serveFixture() and helpers, moved from packages/core/test/fixtures/serve.ts
├─ packages/core/src/
│  ├─ errors.ts                         + 'E_USAGE'
│  ├─ config/load.ts                    writeConfig keeps mode + indentation; detectIndent()
│  ├─ util/fs.ts                        writeFileAtomic preserves an existing file's mode
│  ├─ map/frontier.ts                   Frontier (moved out of crawler.ts) + markCaptured()
│  ├─ map/crawler.ts                    inspect/onPage hooks, redirected screens, app-relative route matching
│  ├─ map/selectors.ts  map/elements.ts  map/forms.ts   redaction-stable selectors (path fallback)
│  ├─ map/types.ts                      Screen.redirectedFrom
│  ├─ browser/cdp.ts                    + resolveSelector(), pushNodes(), forcePseudoState()
│  ├─ findings/types.ts                 Finding (step | occurrence), Severity, Step, StepTrace, Occurrence, EvidenceItem, FindingsFile
│  ├─ findings/id.ts                    findingId(), mergeFindings()
│  ├─ findings/fix-prompt.ts            fixPromptFor()
│  ├─ findings/persist.ts               writeFindings(), readLatestFindings(), FINDINGS_FILE
│  ├─ findings/lens.ts                  Lens, LensContext, LensResult, LensSkip
│  ├─ observers/types.ts                Observer, ObserverResult
│  ├─ observers/console.ts              ConsoleObserver
│  ├─ observers/requests.ts             RequestObserver
│  ├─ observers/text.ts                 TextObserver (+ in-page scanText source)
│  ├─ run/events.ts                     + finding.candidate, screen.inspected
│  ├─ run/session-recorder.ts           SessionRecorder, RunLogWriteError, recordFailure (moved out of engine.ts)
│  ├─ run/inspection.ts                 Inspection: observers → lenses → merge → events → FindingsFile
│  └─ run/engine.ts                     runReview() (renamed from runDiscovery), ReviewOptions.lenses/observers, ReviewResult.findings
├─ packages/lenses/                     @jayslifecode/lookover-lenses
│  ├─ src/index.ts                      InteractionLens, INTERACTION_RULES
│  ├─ src/interaction/contrast.ts       parseCssColor (rgb/rgba/color(srgb)/oklch), relativeLuminance, contrastRatio, blendOver, isLargeText, requiredRatio
│  ├─ src/interaction/in-page.ts        self-contained in-page functions as source strings: styleSnapshot, effectiveBackground, componentName, textSample, isInlineInText, positiveTabindexElements, measureOverflow, activeElementInfo
│  ├─ src/interaction/measure.ts        measureOn(cdp, element, source, args) with release
│  ├─ src/interaction/states.ts         captureStates(): forced hover/focus/active, gallery data, crops; focus-visible-missing, focus-indicator-contrast, hover-state-missing
│  ├─ src/interaction/static.ts         text-contrast-fail/-low, target-size, keyboard-unreachable, positive-tabindex
│  ├─ src/interaction/tab-walk.ts       tabWalk(): focus order, focus-hidden, focus-trap
│  ├─ src/interaction/viewports.ts      sweepViewports(): horizontal-overflow, text-clipped
│  ├─ src/interaction/lens.ts           InteractionLens.inspect(): order, deadline, gallery evidence, skips
│  └─ test/…                            one file per module; fixtures under test/fixtures/<check>/*.html served with test-support
├─ packages/cli/src/commands/
│  ├─ run.ts  run-options.ts  run-summary.ts   --map-only, --lens; candidates per screen; findings summary
│  └─ run-findings.ts                   groupCandidates(), candidateLines()
└─ bench/
   ├─ app/…                             seeded issues (Task 14), one commit per seed with its seeds.json entry
   └─ seeds.json                        10 issues + 3 controls
```

---

### Task 1: Shapes A — typed tests, `E_USAGE`, config writes that keep mode and indentation, file splits

**Files:**
- Create: `packages/core/tsconfig.test.json`, `packages/cli/tsconfig.test.json`, `bench/app/tsconfig.test.json` (each `extends` the package tsconfig, `include: ["src", "test"]` — bench: `["app", "components", "lib", "test"]` — `noEmit`, no `rootDir`)
- Create: `packages/core/src/map/frontier.ts`, `packages/core/src/run/session-recorder.ts`
- Modify: `packages/core/src/errors.ts`, `packages/core/src/util/fs.ts`, `packages/core/src/config/load.ts`, `packages/core/src/map/crawler.ts`, `packages/core/src/run/engine.ts`, `packages/cli/src/commands/run-options.ts`, `packages/cli/src/ui.ts`, `packages/cli/src/commands/init.ts` (usage errors), every package's `typecheck` script
- Test: `packages/core/test/fs.test.ts`, `packages/core/test/config.test.ts`, `packages/cli/test/ui.test.ts`, `packages/cli/test/run.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic(path, data, options?)` and `WriteFileAtomicOptions` (`util/fs.ts`); `LookoverError`; `exitCodeFor`.
- Produces: `ErrorCode` gains `'E_USAGE'` (a CLI flag or argument that is not usable; exit code 2 like config errors). `WriteFileAtomicOptions.mode?: number` already exists or is added: when `mode` is absent and the target exists, the existing file's mode is kept (`stat` before, `chmod` on the temp file before rename). `detectIndent(raw: string): string` in `config/load.ts` (the first line that starts with whitespace decides: tabs → `'\t'`, else that many spaces; default two spaces). `writeConfig(cwd, config)` and `saveConfirmedHosts` write with the file's existing indentation and mode. `Frontier` (unchanged API) exported from `map/frontier.ts`; `SessionRecorder`, `RunLogWriteError`, `recordFailure`, `firstLine`, `messageOf`, `codeOf` exported from `run/session-recorder.ts`; `engine.ts` and `crawler.ts` import them. No behaviour change beyond the above.

- [ ] **Step 1: Add the test tsconfigs and switch `typecheck` to them.** Each package's `typecheck` becomes `tsc -p tsconfig.test.json --noEmit` (core's `build` still uses `tsconfig.json`, which includes only `src`). Run `pnpm -r typecheck` and fix every error the ~5k lines of tests surface (expected: implicit `any` in a few mocks, `noUncheckedIndexedAccess` on fixture arrays; fix with narrowing, never with `// @ts-expect-error` or loosened compiler options).
- [ ] **Step 2: Write the failing tests**

```ts
// packages/core/test/fs.test.ts
test('writeFileAtomic keeps the mode of the file it replaces', async () => {
  await writeFile(path, 'a'); await chmod(path, 0o600);
  await writeFileAtomic(path, 'b');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
test('writeFileAtomic uses options.mode over the existing mode', ...0o640 → 0o640);
// packages/core/test/config.test.ts
test('detectIndent reads four spaces, a tab, and defaults to two spaces', () => {
  expect(detectIndent('{\n    "a": 1\n}')).toBe('    ');
  expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
  expect(detectIndent('{}')).toBe('  ');
});
test('writeConfig keeps a four-space file four-spaced and 0600', ...);
// packages/cli/test/ui.test.ts
test('E_USAGE exits 2', () => expect(exitCodeFor(new LookoverError('E_USAGE', 'x'))).toBe(2));
// packages/cli/test/run.test.ts
test('--max-screens 0 is E_USAGE, not E_CONFIG_INVALID', ...);
test('a comma-separated --confirm-host is E_USAGE', ...);
```

- [ ] **Step 3: Run them to verify they fail** — `pnpm --filter @jayslifecode/lookover-core test -- fs config` and `pnpm --filter @jayslifecode/lookover test -- ui run`; expected: the new tests fail (`E_USAGE` not assignable, mode `0o644`, indentation lost).
- [ ] **Step 4: Implement**: `E_USAGE` in `errors.ts`; `ui.exitCodeFor` maps `E_USAGE` → `EXIT_INVALID`; `run-options.ts` and `init.ts` throw `E_USAGE` for flag problems (`--max-screens`, host flags, invalid `--interaction`/`--framework` values); `writeFileAtomic` mode preservation; `detectIndent` + its use in `writeConfig` and `saveConfirmedHosts` (`JSON.stringify(value, null, indent)`); move `Frontier` to `map/frontier.ts` and the recorder family to `run/session-recorder.ts` (pure moves; `engine.ts` must end under 300 lines and `crawler.ts` under 350).
- [ ] **Step 5: Run `pnpm check`** — expected: green, with tests type-checked (introduce a deliberate type error in a test, see `typecheck` fail, revert).
- [ ] **Step 6: Commit** — `refactor: type-check tests, add E_USAGE, keep config mode and indent, split crawler and engine`

### Task 2: Shapes B — redaction-stable selectors, app-relative route matching, redirected screens

**Files:**
- Modify: `packages/core/src/map/selectors.ts`, `packages/core/src/map/elements.ts`, `packages/core/src/map/forms.ts`, `packages/core/src/map/crawler.ts`, `packages/core/src/map/frontier.ts`, `packages/core/src/map/types.ts`, `packages/core/src/run/events.ts`, `packages/core/src/map/persist.ts` (diff ignores `redirectedFrom`), `packages/cli/src/commands/run-summary.ts` (a redirected screen's progress line shows `→ <landed path>`)
- Test: `packages/core/test/selectors.test.ts` (new), `packages/core/test/elements.test.ts`, `packages/core/test/forms.test.ts`, `packages/core/test/crawler.test.ts`, fixtures `packages/core/test/fixtures/site/token-link.html`, `packages/core/test/fixtures/site/redirect/*`

**Interfaces:**
- Consumes: `redact(text)`; `routeKey`, `isSameApp`; `matchRoute`, `routePatternFromPath`; `Frontier.offer/next`.
- Produces:
  - `buildSelector` (in-page) returns `{ selector: string; path: string }` — `path` is the `tag:nth-of-type` chain anchored only on `body` (no ids, no test ids, no attribute values), so it can never hold a secret. `BUILD_SELECTOR_SOURCE` keeps its name; its result type changes. New Node-side `stableSelector(candidate: { selector: string; path: string }): string | null` in `selectors.ts`: returns `selector` when `redact(selector) === selector`, else `path` when `redact(path) === path`, else `null`. `extractElements` and `extractForms` apply it; an element whose selectors are both unstable is dropped (counted in `total`, not in `elements`), a field keeps `path`.
  - `Frontier` ranks routes on the **app-relative** path: `routeOf(url, base, routes)` strips `base.pathname` (as `links.ts`'s `appRelativeKey` does) before `matchRoute`/`routePatternFromPath`, so a Next app served under `basePath: '/app'` labels `/app/organisations/1` as `/organisations/[id]`.
  - `Screen.redirectedFrom: string | null` — the requested URL when the page landed somewhere else in the app; `Screen.url` and `Screen.route` are the **landed** URL and its route. `Frontier.markCaptured(url: URL): boolean` records the landed route key as seen and returns `false` when it was already captured. `RunEventBody` `screen.skipped.reason` gains `'redirected-duplicate'` (requested URL; `landed: string` added to that event variant). A redirect out of the app (`!isSameApp`) stays a `navigation-failed` screen with the reason `redirected outside the app to <origin>` (not the full URL).

- [ ] **Step 1: Write the failing tests**

```ts
// selectors.test.ts (page.evaluate against test/fixtures/site/token-link.html, which has
// <a href="/reset?token=eyJhbGciOi.eyJzdWIiOi.c2ln">, <a id="support" href="mailto:a@b.co">, <button data-testid="save">)
test('a link whose href would be redacted gets its body path, not the href', ...expect(selector).toMatch(/^body > /));
test('stableSelector keeps a plain selector and rejects a selector redaction changes', () => {
  expect(stableSelector({ selector: '[data-testid="save"]', path: 'body > main:nth-of-type(1) > button:nth-of-type(1)' })).toBe('[data-testid="save"]');
  expect(stableSelector({ selector: 'a[href="/r?token=eyJ.eyJ.sig"]', path: 'body > a:nth-of-type(1)' })).toBe('body > a:nth-of-type(1)');
  expect(stableSelector({ selector: '#x', path: '#y' })).toBe('#y');  // path never redacts; shape only
});
// elements.test.ts
test('every stored selector survives redaction unchanged', () => { for (const el of elements) expect(redact(el.selector)).toBe(el.selector); });
// crawler.test.ts
test('matches routes below a base path', ...baseUrl 'http://127.0.0.1:PORT/sub/', routes [{pattern:'/page', source:'filesystem'}] → the screen at /sub/page has route '/page');
test('records a redirected screen under the URL it landed on', ...'/' → 302 '/home.html': one screen, url ends with /home.html, redirectedFrom ends with '/', route '/home.html' pattern);
test('skips a redirect to a screen already captured', ...seeds ['/home.html', '/'] → one screen and a screen.skipped {reason:'redirected-duplicate', landed:'…/home.html'});
test('a redirect off the app is a failed screen without the foreign URL', ...);
```

- [ ] **Step 2: Run them** — expected: FAIL (`stableSelector` undefined, route `/sub/page`, two screens for the redirect).
- [ ] **Step 3: Implement** as the Interfaces block says. In `crawler.ts`, `visit` reads `page.url()` after `load`, normalises it, and (a) if it equals the requested key: unchanged; (b) if same-app and `frontier.markCaptured(landed)` is `false`: log `screen.skipped {url: requested, reason: 'redirected-duplicate', landed}` and return no screen (the `run()` loop tolerates `undefined`); (c) same-app and new: capture with `url: landed.href`, `route: routeOf(landed)`, `redirectedFrom: requested.href`; (d) off-app: failed screen. `Screen.id` is computed from the landed URL. Update `writeAppMap`/`diffAppMaps` tests for the new field, and the README's "What `.lookover/app-map.json` contains".
- [ ] **Step 4: `pnpm check` green; `pnpm test:e2e` green** (the bench's `/` is not a redirect, so screen counts do not change).
- [ ] **Step 5: Commit** — `fix: redaction-stable selectors, base-path route labels, redirected screens recorded once`

### Task 3: The rules catalogue package and the generated rules document

**Files:**
- Create: `packages/rules/package.json` (`@jayslifecode/lookover-rules`, `dependencies: { zod: "^4.6" }`, `exports: "./dist/index.js"`, scripts `build`, `typecheck`, `test`, `docs`), `packages/rules/tsconfig.json`, `packages/rules/tsconfig.test.json`, `packages/rules/vitest.config.ts`, `packages/rules/catalogue/interaction.json`, `packages/rules/catalogue/observers.json`, `packages/rules/src/schema.ts`, `packages/rules/src/index.ts`, `packages/rules/scripts/generate-docs.ts`, `docs/rules.md` (generated)
- Modify: root `package.json` (`check` → `biome check . && pnpm --filter "./packages/**" build && pnpm -r typecheck && pnpm -r test && pnpm docs:rules --check`; add `"docs:rules": "pnpm --filter @jayslifecode/lookover-rules docs --"`), `biome.json` (format JSON catalogues too — nothing to exclude), `.github/workflows/ci.yml` (no change needed: `pnpm check` covers it; confirm)
- Test: `packages/rules/test/catalogue.test.ts`, `packages/rules/test/generate-docs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Severity = 'blocker' | 'high' | 'medium' | 'low';
  export type RuleSource = 'interaction' | 'consistency' | 'behaviour' | 'observers';
  export interface Rule {
    id: string;                 // `${source}.${kebab}`, e.g. 'interaction.focus-visible-missing'
    source: RuleSource;
    severity: Severity;
    title: string;              // plain language, sentence case, no trailing full stop
    expected: string;           // one sentence: what a correct app does
    whyItMatters: string;       // one or two sentences for a non-engineer
    fixHint: string;            // one sentence a coding agent can act on; the fix prompt quotes it
    reference: { standard: string; criterion: string; url: string } | null;
  }
  export const RULES: readonly Rule[];           // every catalogue, concatenated, validated at import
  export const RULE_IDS: ReadonlySet<string>;
  export function ruleById(id: string): Rule;    // throws Error(`Unknown rule ${id}`) — a programming error, not a LookoverError
  export const ruleSchema: z.ZodType<Rule>; export const catalogueSchema; // { version: 1, rules: Rule[] }
  ```
  Catalogue ids are unique across files; `source` must equal the id's prefix; the schema enforces both.
- The two catalogues contain exactly these rules (titles are the user-facing wording; the implementer writes `expected`, `whyItMatters`, `fixHint` in the same register as the README):

| id | severity | title | reference |
|---|---|---|---|
| interaction.focus-visible-missing | high | Keyboard focus is not visible | WCAG 2.2 · 2.4.7 Focus Visible |
| interaction.focus-indicator-contrast | medium | The focus indicator is too faint | WCAG 2.2 · 1.4.11 Non-text Contrast |
| interaction.hover-state-missing | low | No hover feedback on a clickable control | null |
| interaction.text-contrast-fail | high | Text is unreadable against its background | WCAG 2.2 · 1.4.3 Contrast (Minimum) |
| interaction.text-contrast-low | medium | Text contrast is below the minimum | WCAG 2.2 · 1.4.3 Contrast (Minimum) |
| interaction.target-size | medium | Tap target is smaller than 24 by 24 pixels | WCAG 2.2 · 2.5.8 Target Size (Minimum) |
| interaction.keyboard-unreachable | high | Control cannot be reached with the keyboard | WCAG 2.2 · 2.1.1 Keyboard |
| interaction.positive-tabindex | low | A positive tabindex forces a custom focus order | WCAG 2.2 · 2.4.3 Focus Order |
| interaction.focus-hidden | medium | Keyboard focus lands on something that cannot be seen | WCAG 2.2 · 2.4.11 Focus Not Obscured (Minimum) |
| interaction.focus-trap | high | Keyboard focus gets stuck | WCAG 2.2 · 2.1.2 No Keyboard Trap |
| interaction.horizontal-overflow | high | The page scrolls sideways at this screen size | WCAG 2.2 · 1.4.10 Reflow |
| interaction.text-clipped | medium | Text is cut off without an ellipsis | null |
| observers.page-error | high | The page threw an error that nothing caught | null |
| observers.console-error | medium | The page logged an error to the console | null |
| observers.console-warning | low | The page logged a warning | null |
| observers.request-server-error | high | A request the page made failed on the server | null |
| observers.request-client-error | medium | A request the page made was rejected | null |
| observers.request-network-error | high | A request the page made never got an answer | null |
| observers.raw-value | high | A placeholder value leaked into the page | null |
| observers.raw-i18n-key | medium | A translation key is shown instead of its text | null |
| observers.unresolved-placeholder | medium | A template placeholder was not filled in | null |

  WCAG URLs are `https://www.w3.org/WAI/WCAG22/Understanding/<slug>.html` (`focus-visible`, `non-text-contrast`, `contrast-minimum`, `target-size-minimum`, `keyboard`, `focus-order`, `focus-not-obscured-minimum`, `no-keyboard-trap`, `reflow`).

- [ ] **Step 1: Write the failing tests**

```ts
// catalogue.test.ts
test('every catalogue validates and ids are unique and prefixed by their source', () => {
  expect(RULES.length).toBe(21);
  expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  for (const rule of RULES) expect(rule.id.startsWith(`${rule.source}.`)).toBe(true);
});
test('ruleById returns the rule and throws for an unknown id', () => {
  expect(ruleById('interaction.target-size').severity).toBe('medium');
  expect(() => ruleById('interaction.nope')).toThrow('Unknown rule interaction.nope');
});
test('the schema rejects a severity outside the four and a title ending in a full stop', ...);
// generate-docs.test.ts
test('renders one table per source with every rule, sorted by severity then id', ...);
test('--check exits 1 and names the file when docs/rules.md is stale', ...spawn with a temp copy...);
```

- [ ] **Step 2: Run them** — expected: FAIL (package missing).
- [ ] **Step 3: Implement** the package (`src/index.ts` reads the JSON files with `createRequire`/`import … with { type: 'json' }` — pick `readFileSync` + `JSON.parse` relative to `import.meta.url` so the build output stays plain ESM — and validates with `catalogueSchema`), the generator (`node --experimental-strip-types scripts/generate-docs.ts [--check]`; the document opens with one paragraph saying it is generated and where from), and the root scripts. Generate `docs/rules.md` and commit it.
- [ ] **Step 4: `pnpm check` green** (now includes `docs:rules --check`); edit a title, see `--check` fail, regenerate.
- [ ] **Step 5: Commit** — `feat(rules): catalogue package with 21 interaction and observer rules, generated docs/rules.md`

### Task 4: The finding contract in core: types, ids, merging, fix prompts, persistence

**Files:**
- Create: `packages/core/src/findings/types.ts`, `packages/core/src/findings/id.ts`, `packages/core/src/findings/fix-prompt.ts`, `packages/core/src/findings/persist.ts`
- Modify: `packages/core/package.json` (`"@jayslifecode/lookover-rules": "workspace:*"`), `packages/core/src/run/events.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/findings-id.test.ts`, `packages/core/test/fix-prompt.test.ts`, `packages/core/test/findings-persist.test.ts`

**Interfaces:**
- Consumes: `EvidenceRef`, `Box`, `Viewport`, `shortId`, `redactDeep`, `writeFileAtomic`, `RunContext`, `Rule`/`ruleById`/`Severity` from `-rules`.
- Produces (`findings/types.ts`, all exported from the barrel):
  ```ts
  export type LensName = 'interaction' | 'consistency' | 'behaviour';
  export type FindingSource = LensName | 'observers';
  export type FindingStatus = 'candidate';            // plan 03 adds 'confirmed' | 'rejected' | 'intended'
  export type ForcedState = 'hover' | 'focus' | 'active';
  export interface RuleRef { id: string; source: 'catalogue' }   // v1 adds { source: 'code'; file; line }
  export interface EvidenceItem { kind: 'screenshot' | 'crop' | 'styles' | 'console' | 'requests' | 'text' | 'measurements' | 'gallery'; label: string; ref: EvidenceRef }
  export interface ElementTarget { selector: string; role: string; name: string; componentName: string | null; box: Box }
  export type Step =
    | { kind: 'navigate'; url: string }
    | { kind: 'set-viewport'; viewport: Viewport }
    | { kind: 'force-state'; selector: string; state: ForcedState }
    | { kind: 'focus'; selector: string }
    | { kind: 'press'; key: 'Tab'; times: number }
    | { kind: 'measure'; what: string };
  export interface StepTrace { route: string; url: string; viewport: Viewport; steps: Step[] }
  export interface Occurrence { screenId: string; route: string; url: string; viewport: Viewport; selector: string | null; measured: Record<string, string | number | boolean | null> }
  interface FindingBase {
    id: string; key: string; source: FindingSource; rule: RuleRef; severity: Severity; status: FindingStatus;
    title: string; expected: string; observed: string; whyItMatters: string;
    evidence: EvidenceItem[]; fixPrompt: string; createdAt: string;
  }
  export type StepFinding = FindingBase & { shape: 'step'; screenId: string; target: ElementTarget | null; trace: StepTrace };
  export type OccurrenceFinding = FindingBase & { shape: 'occurrence'; occurrences: Occurrence[] };
  export type Finding = StepFinding | OccurrenceFinding;
  export interface FindingsFile { version: 1; runId: string; createdAt: string; findings: Finding[]; worthALook: Finding[] }
  ```
  `findings/id.ts`: `findingId(ruleId: string, key: string): string` = `shortId(`${ruleId}|${key}`, 12)`. The key is what makes a finding the same finding next run: for a step finding `${route}|${selector}` (plus `|${viewport.name}` when the rule is viewport-specific); for an occurrence finding the rule's own group key (a normalised console message, a request's `METHOD host/pattern`, a rendered text). `mergeFindings(findings: readonly Finding[]): Finding[]` — same `id` → one finding: occurrence findings union their occurrences (deduplicated on `screenId|selector|viewport.name`) and evidence (deduplicated on `ref.id`); a step finding repeated keeps the first. Input order kept; no input mutated.
  `findings/fix-prompt.ts`: `fixPromptFor(input: { rule: Rule; route: string; url: string; target: ElementTarget | null; observed: string; occurrences?: readonly Occurrence[] }): string` — exact shape:
  ```
  In <route> (<url>), the <role> "<name>" (selector `<selector>`[, React component <componentName>]) <observed>.
  Rule: <title>. Expected: <expected> <whyItMatters>
  Fix: <fixHint> Reference: <standard> <criterion> (<url>).   ← line omitted when reference is null
  Keep the control's accessible name, then tell me which file you changed.
  ```
  With no target the first line is `In <route> (<url>), <observed>.`; with occurrences a line `Occurrences (<n>): <route> <selector or page> — <k=v, …>` per occurrence (at most 10, then `… and <n−10> more`).
  `findings/persist.ts`: `FINDINGS_FILE = 'findings.json'`; `writeFindings(ctx: RunContext, file: FindingsFile): Promise<{ runPath: string; latestPath: string }>` (redacted, atomic, run dir + lookover dir, like `writeAppMap`); `readLatestFindings(lookoverDir: string): Promise<FindingsFile | null>` (shallow validation: `version === 1`, arrays present; else `E_RUN_FAILED` naming the file with the rebuild hint).
  `run/events.ts` gains `| { type: 'finding.candidate'; finding: Finding }` and `| { type: 'screen.inspected'; screenId: string; durationMs: number; candidates: number; worthALook: number; skipped: { reason: string; count: number }[]; error: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
test('findingId is stable and 12 hex characters', () => { expect(findingId('a.b', 'k')).toBe(findingId('a.b', 'k')); expect(findingId('a.b', 'k')).toMatch(/^[0-9a-f]{12}$/); expect(findingId('a.b', 'k')).not.toBe(findingId('a.b', 'k2')); });
test('mergeFindings unions occurrences and evidence of the same id, keeps order, mutates nothing', ...);
test('mergeFindings keeps the first of two step findings with one id', ...);
test('fixPromptFor renders the target line, the rule lines and the reference', () => {
  const prompt = fixPromptFor({ rule: ruleById('interaction.focus-visible-missing'), route: '/settings', url: 'http://localhost:3123/settings',
    target: { selector: 'button[type="submit"]', role: 'button', name: 'Save', componentName: 'SettingsForm', box }, observed: 'shows no change when it receives keyboard focus' });
  expect(prompt).toBe(`In /settings (http://localhost:3123/settings), the button "Save" (selector \`button[type="submit"]\`, React component SettingsForm) shows no change when it receives keyboard focus.\nRule: Keyboard focus is not visible. Expected: ${rule.expected} ${rule.whyItMatters}\nFix: ${rule.fixHint} Reference: WCAG 2.2 2.4.7 Focus Visible (https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).\nKeep the control's accessible name, then tell me which file you changed.`);
});
test('fixPromptFor omits the reference line for a rule without one and lists at most 10 occurrences', ...);
test('writeFindings writes the same redacted bytes to the run dir and the latest, and readLatestFindings reads them back', ...a finding whose observed text holds an email → '[email]' on disk);
test('readLatestFindings is null without a file and E_RUN_FAILED for a file that is not a findings file', ...);
```

- [ ] **Step 2: Run them** — expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the four modules and the event variants; export everything from `src/index.ts`. The `RunEventBody` union now references `Finding`; `events.ts` imports the type only.
- [ ] **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(core): finding contract — step and occurrence shapes, stable ids, merge, fix prompts, findings.json`

### Task 5: The `Lens` interface and the inspection pipeline inside the crawl

**Files:**
- Create: `packages/core/src/findings/lens.ts`, `packages/core/src/observers/types.ts`, `packages/core/src/run/inspection.ts`
- Modify: `packages/core/src/map/crawler.ts` (hooks), `packages/core/src/run/engine.ts` (rename to `runReview`, lenses, findings), `packages/core/src/index.ts`, `packages/cli/src/commands/run.ts` (the rename only; lens wiring is Task 13), `packages/core/test/engine.test.ts` (rename)
- Test: `packages/core/test/crawler.test.ts`, `packages/core/test/inspection.test.ts`, `packages/core/test/engine.test.ts`

**Interfaces:**
- Consumes: `Screen`, `InstrumentedPage`, `RunContext`, `Finding`, `FindingsFile`, `mergeFindings`, `writeFindings`, `Viewport`.
- Produces:
  ```ts
  // findings/lens.ts
  export interface LensSkip { reason: string; count: number }
  export interface LensContext {
    readonly ctx: RunContext; readonly screen: Screen; readonly ipage: InstrumentedPage;
    readonly viewports: readonly Viewport[];      // config.viewports; viewports[0] is the one the screen was captured at
    readonly interaction: 'full' | 'safe';
    readonly deadline: number;                    // performance.now() value; a lens checks it between steps and stops past it
  }
  export interface LensResult { findings: Finding[]; worthALook: Finding[]; gallery: EvidenceRef | null; skipped: LensSkip[] }
  export interface Lens { readonly name: LensName; readonly rules: readonly string[]; inspect(context: LensContext): Promise<LensResult> }
  // observers/types.ts
  export interface ObserverResult { findings: Finding[]; worthALook: Finding[]; evidence: EvidenceItem[] }
  export interface Observer { readonly name: string; attach(ipage: InstrumentedPage): void; collect(screen: Screen): Promise<ObserverResult> }
  // map/crawler.ts
  CrawlOptions.onPage?: (ipage: InstrumentedPage) => void;                       // once, right after newPage(), before any navigation
  CrawlOptions.inspect?: (screen: Screen, ipage: InstrumentedPage) => Promise<void>; // after `screen.captured` of a captured (not failed) screen, before its links are offered
  // run/inspection.ts
  export const PER_SCREEN_BUDGET_MS = 10_000;
  export class Inspection {
    constructor(ctx: RunContext, options: { lenses: readonly Lens[]; observers: readonly Observer[]; viewports: readonly Viewport[]; interaction: 'full' | 'safe' });
    attach(ipage: InstrumentedPage): void;          // observers.attach
    inspect(screen: Screen, ipage: InstrumentedPage): Promise<void>;
    file(): FindingsFile;                            // merged candidates and worth-a-look, in first-seen order
  }
  // run/engine.ts — renamed; `runDiscovery` is gone (nothing outside this repo uses it yet)
  export interface ReviewOptions { cwd: string; headless?: boolean; env?: NodeJS.ProcessEnv; hooks?: ReviewHooks; lenses?: readonly Lens[]; observers?: readonly Observer[] }   // the former DiscoveryOptions plus the last two; both default to [] in this task, Task 7 makes `observers` default to `defaultObservers(ctx)`, Task 13's CLI passes the lenses
  export interface ReviewResult { map: AppMap; confirmedBackendHosts: string[]; blockedUnconfirmedHosts: string[]; findings: FindingsFile }   // the former DiscoveryResult plus `findings`
  export function runReview(ctx: RunContext, opts: ReviewOptions): Promise<ReviewResult>;
  ```
  `Inspection.inspect` order: (1) every observer's `collect(screen)` — before any lens reloads or resizes the page, so a lens cannot double-count console or network entries; (2) each lens in order with `deadline = performance.now() + PER_SCREEN_BUDGET_MS`, restoring `viewports[0]` with `page.setViewportSize` after each lens whatever happened; (3) `mergeFindings` over everything so far, appending `finding.candidate` for each id not seen before; (4) `screen.inspected`. A `LookoverError` from an observer or lens propagates (it is the run's failure); any other error is caught, recorded in `screen.inspected.error` (first line of the message) and the crawl goes on. `runReview` writes `findings.json` after the App Map and returns it; `run.finished` is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// crawler.test.ts
test('calls onPage once before the first navigation and inspect once per captured screen, before offering links', ...fake inspect records (screen.url, page.url()) and asserts page.url() === screen.url; failed screens are not inspected);
// inspection.test.ts (fake lens + fake observer against test/fixtures/site)
test('runs observers before lenses and restores the first viewport after a lens that resized it', ...);
test('emits finding.candidate once per id across screens and merges occurrences', ...two screens, observer returns the same occurrence finding id → one event, file().findings[0].occurrences.length === 2);
test('a lens that throws a plain Error fails only that screen: screen.inspected.error is set and the next screen is inspected', ...);
test('a lens that throws a LookoverError fails the crawl', ...);
test('hands lenses a deadline about PER_SCREEN_BUDGET_MS ahead and the config viewports', ...);
// engine.test.ts
test('runReview writes findings.json to the run dir and as the latest, and returns it', ...);
```

- [ ] **Step 2: Run them** — FAIL (`inspect` never called, `Inspection` missing, `runReview` missing).
- [ ] **Step 3: Implement**; rename across core, CLI and tests with one `sed` pass (`runDiscovery`→`runReview`, `DiscoveryOptions`→`ReviewOptions`, `DiscoveryResult`→`ReviewResult`, `DiscoveryHooks`→`ReviewHooks`); update the engine doc comment (Stage 1 + Stage 3 inspection, step 5b).
- [ ] **Step 4: `pnpm check` and `pnpm test:e2e` green** (the e2e run has no lenses yet; `findings.json` exists with empty arrays).
- [ ] **Step 5: Commit** — `feat(core): lens interface and per-screen inspection pipeline; runDiscovery becomes runReview`

### Task 6: Console and page-error observer

**Files:**
- Create: `packages/core/src/observers/console.ts`, `packages/core/src/observers/noise.ts`
- Test: `packages/core/test/observers-console.test.ts`, fixtures `packages/core/test/fixtures/observers/console.html` (logs one `console.error('Report locale missing for 3 rows')`, one `console.warn`, throws one uncaught `TypeError` in a `setTimeout(…, 0)`, logs `[Fast Refresh] rebuilding` and `Download the React DevTools for a better development experience`), `console-clean.html`

**Interfaces:**
- Consumes: `Observer`, `ObserverResult`, `findingId`, `fixPromptFor`, `ruleById`, `EvidenceStore.putJson`, `redact`.
- Produces: `class ConsoleObserver implements Observer` (`name: 'console'`), `constructor(ctx: RunContext)`. `attach` subscribes `page.on('console')` and `page.on('pageerror')` and buffers entries `{ at: ISO; type: 'error' | 'warning' | 'pageerror'; text: string; location: string | null }` (`location` = `url:line:col` of `msg.location()` when present; `text` for a page error is `error.name: error.message` without the stack). `collect(screen)` drains the buffer: entries matching `IGNORED_CONSOLE_PATTERNS` (`noise.ts`: `/^\[Fast Refresh\]/`, `/^Download the React DevTools/`, `/^\[HMR\]/`, `/^%cNext\.js/`, any `location` starting with `chrome-extension://`) are dropped; the rest are written as one evidence JSON `console-<screenId>.json` (`EvidenceItem.kind: 'console'`) and turned into **occurrence findings**: `pageerror` → `observers.page-error`, `error` → `observers.console-error` (both `findings`), `warning` → `observers.console-warning` (`worthALook`). Group key = `normaliseMessage(text)`: digits → `#`, `https?://\S+` → `<url>`, whitespace collapsed, first 200 characters. `occurrence.measured = { message: first 300 chars, type, location, count }` (count = entries with that key on this screen). `observed` = `logged "<first 120 chars>" <count> time(s)`. `key` for `findingId` is `normaliseMessage(text)` so the same error on every screen is one finding with one occurrence per screen.

- [ ] **Step 1: Write the failing tests**

```ts
test('turns console errors and uncaught exceptions into candidates, warnings into worth-a-look, and drops dev noise', ...3 findings? no: 1 console-error + 1 page-error in findings, 1 console-warning in worthALook; no finding mentions Fast Refresh or DevTools);
test('the same message on two screens is one finding with two occurrences', ...);
test('the message with a number and a URL normalises to one key', () => expect(normaliseMessage('Failed 3 rows at https://a.b/c?x=1')).toBe('Failed # rows at <url>'));
test('writes the screen's console entries as redacted evidence', ...an entry holding an email → [email] on disk);
test('a clean page yields nothing', ...);
```

- [ ] **Step 2: Run them** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(core): console observer — page errors and console errors as candidates, dev noise ignored`

### Task 7: Request observer and rendered-text observer; `defaultObservers`

**Files:**
- Create: `packages/core/src/observers/requests.ts`, `packages/core/src/observers/text.ts`, `packages/core/src/observers/index.ts` (`defaultObservers(ctx): Observer[]` = console, requests, text)
- Modify: `packages/core/src/run/engine.ts` (`observers` default → `defaultObservers(ctx)`), `packages/core/src/index.ts`
- Test: `packages/core/test/observers-requests.test.ts`, `packages/core/test/observers-text.test.ts`, fixtures `packages/core/test/fixtures/observers/requests.html` (fetches `/api/ok` 200, `/api/missing` 404, `/api/boom` 500, `/favicon.ico` 404 via the fixture server routes, and one `fetch` to a port nothing listens on), `text.html` (contains `Last edited by undefined`, `NaN`, `[object Object]`, `settings.timezone.label`, `Hello {{name}}`, `{count}` inside a `<code>` (must not match), `www.example.com`, `v1.2.3`, `index.test.ts`, "an undefined period" in a paragraph (must not match))

**Interfaces:**
- Produces:
  - `class RequestObserver implements Observer` (`name: 'requests'`). `attach`: `page.on('response')` and `page.on('requestfailed')`, buffering `{ method, url, status: number | null, resourceType, failure: string | null, durationMs: number | null }` (duration from `request.timing()` when available), at most `MAX_REQUESTS_PER_SCREEN = 500` per screen. `collect`: evidence `requests-<screenId>.json` (`kind: 'requests'`, URLs redacted by the store); findings: status ≥ 500 → `observers.request-server-error`; 400–499 → `observers.request-client-error` except `/favicon.ico` and `/.well-known/*`; `requestfailed` whose `failure` is not one of Lookover's own abort texts (`net::ERR_ABORTED`, `net::ERR_BLOCKED_BY_CLIENT`, `net::ERR_FAILED`) → `observers.request-network-error`. Group key: `${method} ${host}${routePatternFromPath(pathname)} → ${status ?? failure}`; `measured = { method, url, status, failure, resourceType }`; `observed` = `<METHOD> <path> answered <status>` / `… failed: <failure>`. Lookover-blocked requests therefore never become findings.
  - `class TextObserver implements Observer` (`name: 'text'`; `attach` is a no-op). `collect` runs the in-page `SCAN_TEXT_SOURCE` (self-contained, uses `BUILD_SELECTOR_SOURCE` for the text node's parent): walks visible text nodes (skips `script, style, noscript, template, code, pre, kbd, samp, textarea, option` and elements for which `checkVisibility({ visibilityProperty: true, opacityProperty: true })` is false), trims each node's text `t`, and reports at most `MAX_TEXT_HITS = 50`:
    - `raw-value`: `t` is exactly one of `undefined | null | NaN | [object Object] | Infinity | -Infinity`, **or** `t` contains `[object Object]` or `\bNaN\b` anywhere, **or** `t` ends with `\bundefined` (template strings such as `` `by ${user}` ``). "an undefined period" does not match (the word is not final). → `observers.raw-value`.
    - `unresolved-placeholder`: `/\{\{\s*[\w.]+\s*\}\}/` or `/(?<![\w$])\{[A-Za-z_][\w.]*\}/` → `observers.unresolved-placeholder`.
    - `raw-i18n-key`: `t` matches `/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/`, no segment is digits only, and the last segment is not in `KNOWN_SUFFIXES` (`com org net io dev app co uk de kr mn jp js ts jsx tsx json md html css png jpg jpeg svg gif`) → `observers.raw-i18n-key`.
    Group key: `${kind}|${t.slice(0, 120)}`; occurrence `selector` = the parent's selector (or `null` when `document.querySelector` does not resolve it); `measured = { text: t.slice(0, 120), kind }`; evidence `text-<screenId>.json` with every hit.

- [ ] **Step 1: Write the failing tests**

```ts
// requests
test('4xx and 5xx answers and a connection failure are candidates; 200, favicon and Lookover-blocked requests are not', ...);
test('two screens hitting GET /api/items/1 and /api/items/2 with 500 share one finding (pattern key)', ...);
// text
test('finds the five raw texts and nothing in <code>, prose, versions, domains or file names', ...expected kinds: raw-value ×3 (undefined at end, NaN, [object Object]), raw-i18n-key ×1, unresolved-placeholder ×1; total 5);
test('selectors resolve to the element holding the text', ...);
test('caps hits at MAX_TEXT_HITS', ...fixture generated in-test);
// engine
test('runReview uses the three default observers when none are given', ...the bench-like fixture logs an error → findings.json has observers.console-error);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green; `pnpm test:e2e` green** (the bench app is still clean: assert the e2e `findings.json` has zero findings for now — add that assertion to `bench.test.ts`, to be replaced in Task 15).
- [ ] **Step 5: Commit** — `feat(core): request and rendered-text observers; defaultObservers`

### Task 8: `packages/lenses` scaffold, shared test fixtures, colour and contrast maths, in-page measurement library

**Files:**
- Create: `packages/test-support/package.json` (`@jayslifecode/lookover-test-support`, private, no dependencies beyond `@types/node`; `exports` points at `./src/index.ts` for both `types` and `default`, so it needs no build step: Vitest and `tsc` resolve the source, and it is never published), `packages/test-support/src/serve.ts` (moved from `packages/core/test/fixtures/serve.ts`, same exports), `packages/test-support/src/index.ts`
- Create: `packages/lenses/package.json` (`@jayslifecode/lookover-lenses`; dependencies `@jayslifecode/lookover-core`, `@jayslifecode/lookover-rules`, `playwright: 1.64.1`; devDependency `-test-support`), `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `src/index.ts`, `src/interaction/contrast.ts`, `src/interaction/in-page.ts`, `src/interaction/measure.ts`, `test/helpers/session.ts` (`launchTestSession()`: a `BrowserSession` with `allowHosts: []`, loopback fixtures, events collected)
- Modify: `packages/core/src/browser/cdp.ts` (+ `resolveSelector`, `pushNodes`, `forcePseudoState`), `packages/core/src/index.ts`, `packages/core/package.json` (devDependency `-test-support`), every core test that imported `./fixtures/serve.js` (import from `@jayslifecode/lookover-test-support`)
- Test: `packages/lenses/test/contrast.test.ts`, `packages/lenses/test/in-page.test.ts` (fixtures `test/fixtures/measure/*.html`), `packages/core/test/cdp.test.ts` (new, for the three helpers)

**Interfaces:**
- Produces (core `browser/cdp.ts`):
  ```ts
  export async function resolveSelector(cdp: CDPSession, selector: string): Promise<string | null>;  // DOM.getDocument(depth 0) → DOM.querySelector → DOM.resolveNode → objectId; null when nothing matches
  export async function pushNodes(cdp: CDPSession, backendNodeIds: readonly number[]): Promise<number[]>;   // DOM.pushNodesByBackendIdsToFrontend → DOM nodeIds, same order
  export async function forcePseudoState(cdp: CDPSession, nodeId: number, states: readonly ('hover' | 'focus' | 'focus-visible' | 'active')[]): Promise<void>; // CSS.enable once per session (memoised on a WeakSet), CSS.forcePseudoState; [] clears
  ```
- Produces (`lenses/src/interaction/contrast.ts`, pure, no DOM):
  ```ts
  export interface Rgba { r: number; g: number; b: number; a: number }   // 0–255, alpha 0–1
  export function parseCssColor(value: string): Rgba | null;   // 'rgb(…)', 'rgba(…)', 'transparent', 'color(srgb r g b / a)', 'oklch(L C H / a)' (Tailwind v4 computes to oklch in Chromium); anything else → null
  export function blendOver(fg: Rgba, bg: Rgba): Rgba;          // source-over; result alpha = fg.a + bg.a·(1−fg.a)
  export function relativeLuminance(c: Rgba): number;           // WCAG 2.x formula, sRGB linearisation
  export function contrastRatio(a: Rgba, b: Rgba): number;      // (L1+0.05)/(L2+0.05), ≥ 1
  export function isLargeText(fontSizePx: number, fontWeight: number): boolean;   // ≥ 24px, or ≥ 18.66px and weight ≥ 700
  export function requiredRatio(isLarge: boolean): number;      // 3 or 4.5
  ```
  Reference values for tests: `#ffffff`/`#000000` → 21; `#767676` on white → 4.54; Tailwind blue-700 `oklch(0.488 0.243 264.376)` ≈ `rgb(29, 78, 216)` (±2 per channel), on white ≈ 6.6; `color(srgb 0.5 0.5 0.5)` = `rgb(128,128,128)` (±1).
- Produces (`lenses/src/interaction/in-page.ts`): each a function whose `.toString()` is exported as `*_SOURCE`, self-contained (no module references), `this` bound to the element:
  ```ts
  STYLE_SNAPSHOT_SOURCE: (this: Element) => StyleSnapshot
    // { self: Record<Prop, string>; before: Record<Prop, string>; after: Record<Prop, string> } over
    // STATE_STYLE_PROPERTIES = outline-style outline-width outline-color outline-offset box-shadow border-top-color border-right-color border-bottom-color border-left-color border-top-width background-color color text-decoration-line text-decoration-color transform opacity filter cursor
  EFFECTIVE_BACKGROUND_SOURCE: (this: Element) => { color: string | null; uncertain: string | null }
    // walks from the element up through parents compositing `background-color` with source-over until alpha ≥ 0.999 or <html>; `uncertain` names the first reason found: 'background-image', 'opacity', 'mix-blend-mode', 'filter', 'backdrop-filter', 'never-opaque'; `color` is an `rgb(a)` string the Node side parses
  COMPONENT_NAME_SOURCE: (this: Element) => string | null
    // React dev mode: the `__reactFiber$…` key → walk `.return` to the nearest fiber whose `type` is a function/class with a `displayName` or `name` that is not a host tag and not a React internal (`Fragment`, `Suspense`, names starting with lowercase or `_`); null in production builds
  TEXT_SAMPLE_SOURCE: (this: Element) => { text: string; fontSize: number; fontWeight: number; color: string } | null   // innerText trimmed to 80 chars; null when empty
  IS_INLINE_IN_TEXT_SOURCE: (this: Element) => boolean   // computed display starts with 'inline' and the parent has a non-whitespace text node sibling
  POSITIVE_TABINDEX_SOURCE: () => { selector: string; tabindex: number }[]
  MEASURE_OVERFLOW_SOURCE: () => { scrollWidth: number; clientWidth: number; offenders: { selector: string; right: number; width: number }[]; clipped: { selector: string; text: string; scrollWidth: number; clientWidth: number }[] }
    // offenders: the 5 elements with the largest right edge beyond clientWidth (border boxes, `body *`, cap 5000 elements, skipping elements inside an ancestor that scrolls horizontally itself, i.e. overflow-x auto/scroll); clipped: ≤10 elements with overflow(-x) hidden, white-space nowrap, text-overflow not ellipsis, non-empty own text and scrollWidth > clientWidth + 1
  ACTIVE_ELEMENT_SOURCE: () => { selector: string | null; tag: string; box: Box; isBody: boolean; hidden: string | null }
    // hidden names why focus cannot be seen: 'zero-size', 'visibility', 'opacity', 'offscreen' (box entirely outside the document), else null
  ```
  `lenses/src/interaction/measure.ts`: `measureOn<T>(cdp, element: Pick<ElementRef, 'selector' | 'backendNodeId'>, source: string, args?: readonly unknown[]): Promise<T | null>` — resolves by `backendNodeId` when present else by `resolveSelector`, calls `callOnNode`, releases the object; `null` when the element cannot be resolved (it is gone), rethrows other errors. `evaluateSource<T>(page, source): Promise<T>` for the element-less sources.

- [ ] **Step 1: Move `serve.ts`** into `packages/test-support`, update core's imports, run core tests — green (pure move).
- [ ] **Step 2: Write the failing tests** — contrast (every reference value above; `parseCssColor('hsl(0 0% 0%)')` → `null`; `blendOver` of 50 % black over white → `rgb(128,128,128)` ±1); `cdp.test.ts` (`resolveSelector` finds `#a` and returns `null` for `#nope`; `forcePseudoState(['hover'])` makes `getComputedStyle(el).backgroundColor` change on a fixture with a `:hover` rule, `[]` restores it; `pushNodes` returns one id per backend id); `in-page.test.ts` on `test/fixtures/measure/backgrounds.html` (an opaque card → `color` set, `uncertain` null; text over `background-image` → `uncertain: 'background-image'`; a 50 % translucent layer over white → composited colour; an `opacity: .5` ancestor → `uncertain: 'opacity'`), `measure/inline.html` (an `<a>` inside a `<p>` with text → true; a block button → false), `measure/overflow.html` at width 390 (one offender, one clipped, the horizontally-scrolling table wrapper's cells not listed), `measure/component.html` (a tiny React 19 dev build served from the fixture — `react.development.js` + `react-dom.development.js` copied into the fixture dir from `node_modules` at test time — yields `'SaveButton'`; a plain page yields `null`).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: `pnpm check` green** (`pnpm --filter "./packages/**" build` builds in dependency order, so core and rules build before lenses).
- [ ] **Step 6: Commit** — `feat(lenses): package scaffold, shared fixture server, contrast maths and in-page measurement sources`

### Task 9: Forced states — the state gallery and the focus and hover rules

**Files:**
- Create: `packages/lenses/src/interaction/states.ts`, `packages/lenses/src/interaction/findings.ts` (helpers that build a `StepFinding` from a rule, a screen, a target and a trace: `stepFinding({ rule, screen, target, trace, observed, evidence, viewport })` fills `id`, `key = ${route}|${selector}`, `severity`, `title`, `expected`, `whyItMatters`, `fixPrompt`, `createdAt`)
- Test: `packages/lenses/test/states.test.ts`, fixtures `test/fixtures/states/*.html`: `ring.html` (buttons: `#ok` with `:focus-visible { outline }`, `#shadow` with a `box-shadow` ring, `#after` with the ring on `::after`, `#none` with `outline: none` and nothing else, `#faint` with a `#e5e7eb` outline on white, `#hover` with a `:hover` colour, `#nohover` without; links `#link-plain` with `cursor: pointer` only), `many.html` (80 buttons, 3 class signatures)

**Interfaces:**
- Consumes: `forcePseudoState`, `pushNodes`, `measureOn`, `STYLE_SNAPSHOT_SOURCE`, `EFFECTIVE_BACKGROUND_SOURCE`, `COMPONENT_NAME_SOURCE`, `parseCssColor`, `contrastRatio`, `EvidenceStore.putPng/putJson`.
- Produces:
  ```ts
  export const MAX_STATE_ELEMENTS = 60; export const MAX_GALLERY_ELEMENTS = 12; export const CROP_PADDING_PX = 8;
  export type GalleryState = 'rest' | 'hover' | 'focus' | 'active';
  export interface GalleryEntry { selector: string; role: string; name: string; componentName: string | null; states: Partial<Record<GalleryState, StyleSnapshot>>; crops: Partial<Record<GalleryState, EvidenceRef>>; skipped: string | null }
  export interface StateGallery { screenId: string; viewport: Viewport; entries: GalleryEntry[]; focusOrder: FocusStop[] /* filled by Task 11 */ }
  export async function captureStates(context: LensContext, elements: readonly ElementRef[]): Promise<{ gallery: StateGallery; findings: Finding[]; skipped: LensSkip[] }>;
  export function stateDiffers(rest: StyleSnapshot, forced: StyleSnapshot): boolean;   // any tracked property differs on self, ::before or ::after
  export function focusIndicatorColor(rest: StyleSnapshot, focus: StyleSnapshot): string | null;  // the outline-color when outline-style/width changed to a visible outline, else the first colour of a box-shadow that appeared, else null (the indicator is a fill/text change: contrast not checked)
  ```
  Behaviour: elements in reading order, `disabled` skipped (`skipped: 'disabled'`), stop after `MAX_STATE_ELEMENTS` (`LensSkip { reason: 'state-elements-cap', count }`); each element: `rest` snapshot, then for `hover`, `focus` (forced as `['focus', 'focus-visible']`) and `active`: force → snapshot → clear; crops (`page.screenshot({ clip })` of the element's **viewport** rect padded by `CROP_PADDING_PX` after `scrollIntoViewIfNeeded`) for the first `MAX_GALLERY_ELEMENTS` distinct `tag + sorted class list` signatures, in every state; past the deadline → stop with `LensSkip { reason: 'time-budget', count: remaining }`. Rules:
  - `interaction.focus-visible-missing` when `focusable && !stateDiffers(rest, focus)`; trace `[navigate, set-viewport, force-state focus, measure 'computed styles of the control and its ::before/::after, before and after focus']`; evidence: the rest and focus crops (when cropped) and a `styles` JSON of both snapshots.
  - `interaction.focus-indicator-contrast` when `focusIndicatorColor` is non-null, the element's parent's `effectiveBackground` is certain, and `contrastRatio(indicator, background) < 3`; `observed` = `focus outline <colour> has <ratio>:1 contrast against <background>`; `measured`-style numbers rounded to 2 decimals.
  - `interaction.hover-state-missing` (role `button` or `link`, `!stateDiffers(rest, hover)`) → `worthALook`, not `findings`: a cursor change alone is not a state change (the snapshot tracks `cursor`, so a `cursor: pointer` set only on `:hover` counts as a change).
  The gallery is written by the lens (Task 12) as `gallery-<screenId>.json` (`EvidenceItem.kind: 'gallery'`).

- [ ] **Step 1: Write the failing tests**

```ts
test('reports #none and not #ok, #shadow or #after', ...findings.map(f => f.target?.selector) toEqual ['#none']);
test('reports #faint as a too-faint indicator with the measured ratio', ...observed matches /1\.2\d:1/);
test('#nohover is worth a look; #hover and #link-plain (cursor change) are not', ...);
test('forced states leave no state behind', ...after captureStates, getComputedStyle(#hover).backgroundColor is the rest colour);
test('caps forced states at 60 elements and crops at 12 signatures', ...gallery.entries.length === 60, Object.keys crops across entries ≤ 12 × 4, skipped contains {reason:'state-elements-cap', count: 20});
test('stops at the deadline and says how many it skipped', ...deadline = now);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(lenses): forced hover/focus/active states, state gallery, focus-visible and indicator-contrast rules`

### Task 10: Static measures — text contrast, target size, keyboard reachability, positive tabindex

**Files:**
- Create: `packages/lenses/src/interaction/static.ts`, `packages/lenses/src/interaction/target-size.ts` (pure geometry)
- Test: `packages/lenses/test/target-size.test.ts` (pure), `packages/lenses/test/static.test.ts`, fixtures `test/fixtures/static/contrast.html` (`#fail` grey `#9ca3af` on `#e5e7eb`; `#low` `#767676`-ish 4.2:1; `#large-ok` 20 px bold at 3.2:1; `#on-image` text over a `background-image`; `#ok`), `targets.html` (`#icon` 16×16 button next to another 16×16 button 4 px apart; `#lone` 16×16 button with nothing within 24 px; `<a>` 14 px inline in a paragraph; a native checkbox; `#big` 40×40), `keyboard.html` (`<div role="button">` without tabindex; `<div role="button" tabindex="0">`; `<span role="link">`; an `<li role="option">` in a listbox with `aria-activedescendant`; `<input tabindex="3">`, `<button tabindex="1">`)

**Interfaces:**
- Consumes: `ElementRef[]` (`screen.elements`), `measureOn` with `TEXT_SAMPLE_SOURCE`, `EFFECTIVE_BACKGROUND_SOURCE`, `IS_INLINE_IN_TEXT_SOURCE`, `evaluateSource` with `POSITIVE_TABINDEX_SOURCE`, contrast maths, `stepFinding`, `occurrenceFinding` (add to `findings.ts`: `occurrenceFinding({ rule, key, occurrences, observed, evidence })`).
- Produces:
  ```ts
  export const MIN_TARGET_PX = 24;
  export function passesTargetSize(target: Box, others: readonly Box[]): { ok: true } | { ok: false; nearest: number };
    // ok when width ≥ 24 and height ≥ 24; otherwise ok when the 24 px circle centred on `target` meets no other box (distance from the centre to every other box ≥ 12) — the WCAG 2.5.8 spacing exception; else `nearest` is that smallest distance
  export async function measureStatic(context: LensContext, elements: readonly ElementRef[]): Promise<{ findings: Finding[]; skipped: LensSkip[] }>;
  export const MUST_BE_FOCUSABLE_ROLES: ReadonlySet<string>;   // button link textbox searchbox checkbox switch combobox slider spinbutton
  ```
  Rules (each a step finding on the element, trace `[navigate, set-viewport, measure '<what>']`):
  - text contrast: for elements with a non-empty `TEXT_SAMPLE`, background certain: ratio < 3 → `interaction.text-contrast-fail`; else ratio < `requiredRatio(isLargeText(fontSize, fontWeight))` → `interaction.text-contrast-low`; `observed` = `"<text>" is <colour> on <background>, <ratio>:1 (needs <required>:1)`. Uncertain background → `LensSkip { reason: 'background-uncertain:<why>' }`. Elements past `MAX_STATE_ELEMENTS` are still measured here (cheap), capped at `MAX_CONTRAST_ELEMENTS = 200`.
  - target size: all elements except `input[type=checkbox|radio]`, `select`, `option`, elements for which `IS_INLINE_IN_TEXT` is true, and `disabled` ones; `passesTargetSize(box, boxes of the other elements)`; not ok → `interaction.target-size`, `observed` = `<w>×<h> px, nearest other target <d> px away`. A small target with nothing inside its 24 px circle passes (the spacing exception); `docs/lenses/interaction.md` says so.
  - keyboard: `!focusable && !disabled && MUST_BE_FOCUSABLE_ROLES.has(role)` and the element is not inside an element with `aria-activedescendant` → `interaction.keyboard-unreachable`.
  - positive tabindex: `POSITIVE_TABINDEX_SOURCE` → one occurrence finding per screen (`key = route`, one occurrence per element, `measured { tabindex }`) → `interaction.positive-tabindex`.

- [ ] **Step 1: Write the failing tests** — geometry: `passesTargetSize({x:0,y:0,width:16,height:16}, [{x:19,y:0,width:16,height:16}])` → `{ ok: false, nearest: 11 }` (from the centre (8,8) to a box starting at x=19 is 11 px, inside the 12 px radius); the same with the other box at `x: 21` passes (13 px), lone 16×16 passes, 24×24 passes, 23×24 crowded fails; fixtures: contrast findings exactly `#fail` (fail) and `#low` (low), `#on-image` in `skipped` as `background-uncertain:background-image`, `#large-ok` clean; targets: `#icon` reported, `#lone`, the inline link, the checkbox and `#big` not; keyboard: the first `div[role=button]` and the `span[role=link]` reported, the `tabindex=0` one and the option not; positive tabindex: one occurrence finding with two occurrences.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(lenses): text contrast, target size with the spacing exception, keyboard reachability, positive tabindex`

### Task 11: The Tab walk — focus order, hidden focus, focus traps

**Files:**
- Create: `packages/lenses/src/interaction/tab-walk.ts`
- Test: `packages/lenses/test/tab-walk.test.ts`, fixtures `test/fixtures/tab/order.html` (five controls, one `opacity: 0` link in the middle, one `position: absolute; left: -9999px` link that is *not* an sr-only skip link — plus an sr-only "Skip to content" link that becomes visible on focus, which must **not** be reported), `trap.html` (a `keydown` handler that keeps focus on `#stuck` by calling `focus()` on every Tab)

**Interfaces:**
- Consumes: `page.keyboard.press('Tab')`, `evaluateSource(ACTIVE_ELEMENT_SOURCE)`, `screen.elements` (for `focusableCount`).
- Produces:
  ```ts
  export const MAX_TAB_PRESSES = 300; export const TRAP_REPEATS = 3;
  export interface FocusStop { index: number; selector: string | null; tag: string; box: Box; hidden: string | null }
  export async function tabWalk(context: LensContext, focusableCount: number): Promise<{ focusOrder: FocusStop[]; findings: Finding[]; skipped: LensSkip[] }>;
  ```
  Behaviour: blur the active element and scroll to top; press Tab up to `min(2·focusableCount + 5, MAX_TAB_PRESSES)` times (deadline checked every press); after each, read `ACTIVE_ELEMENT`; stop when the active element is `body` (focus left the document) or the first stop repeats. Rules:
  - `interaction.focus-hidden`: a stop with `hidden !== null`, **measured after the focus landed** (an sr-only link that un-hides on `:focus` reads `hidden: null` then and is not reported) → step finding with trace `[navigate, set-viewport, press Tab ×index, measure 'bounding box and visibility of document.activeElement']`, `target.selector` the stop's selector.
  - `interaction.focus-trap`: the same selector `TRAP_REPEATS` times in a row while `focusableCount > 1` → step finding on that element; the walk stops there.
  The `focusOrder` goes into the gallery (`StateGallery.focusOrder`).

- [ ] **Step 1: Write the failing tests** — `order.html`: focus order lists the five controls in DOM order, exactly two `focus-hidden` findings (`opacity`, `offscreen`), none for the skip link; `trap.html`: one `focus-trap` finding on `#stuck`, the walk ended in under `MAX_TAB_PRESSES` presses; the deadline stops the walk with `skipped [{ reason: 'time-budget', count: 1 }]`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(lenses): Tab walk with focus order, hidden focus and focus-trap rules`

### Task 12: Viewport sweep and the `InteractionLens`

**Files:**
- Create: `packages/lenses/src/interaction/viewports.ts`, `packages/lenses/src/interaction/lens.ts`
- Modify: `packages/lenses/src/index.ts` (`export { InteractionLens, INTERACTION_RULES }`)
- Test: `packages/lenses/test/viewports.test.ts` (fixture `test/fixtures/viewports/overflow.html`: a 600 px-wide fixed-width banner and a nowrap caption clipped without ellipsis; `fine.html` with a horizontally scrolling table wrapper only), `packages/lenses/test/lens.test.ts` (against `test/fixtures/states/ring.html` with two viewports; a `busy.html` whose main thread spins for 3 s after load)

**Interfaces:**
- Produces:
  ```ts
  export async function sweepViewports(context: LensContext): Promise<{ findings: Finding[]; screenshots: EvidenceItem[]; skipped: LensSkip[] }>;
  // for each viewport after the first: setViewportSize → page.reload({ waitUntil: 'load' }) → fonts ready (2 s cap) → MEASURE_OVERFLOW; then the first viewport is restored and the page reloaded once more.
  // interaction.horizontal-overflow when scrollWidth > clientWidth + 1: an occurrence finding, key `${route}|${viewport.name}`, one occurrence per offender (selector, measured { right, width, viewportWidth: clientWidth }), evidence: a full-page screenshot at that viewport (`kind: 'screenshot'`, label `<viewport.name> <w>×<h>`).
  // interaction.text-clipped: an occurrence finding per viewport (key `${route}|${viewport.name}|clipped`) with one occurrence per clipped element (measured { text, scrollWidth, clientWidth }).
  export const INTERACTION_RULES: readonly string[];   // the 12 interaction.* ids, asserted against RULE_IDS in a test
  export class InteractionLens implements Lens {
    readonly name = 'interaction'; readonly rules = INTERACTION_RULES;
    async inspect(context: LensContext): Promise<LensResult>;
  }
  ```
  `inspect` order: `captureStates` → `measureStatic` → `tabWalk` → `sweepViewports`; each step checks `context.deadline` first and is skipped whole (`LensSkip { reason: 'time-budget:<step>', count: 1 }`) once it has passed; results merged; the gallery (entries + focusOrder) written with `putJson('gallery-<screenId>', gallery)` and returned as `gallery`; `hover-state-missing` goes to `worthALook`, everything else to `findings`. Screens with `status: 'navigation-failed'` never reach a lens (the crawler does not inspect them).

- [ ] **Step 1: Write the failing tests** — sweep: `overflow.html` at `[desktop 1440, mobile 390]` → one `horizontal-overflow` finding with the banner as an occurrence and one `text-clipped`; `fine.html` → none; after the sweep the page is at 1440 wide again; lens: `ring.html` yields the Task 9 findings plus a gallery evidence ref whose JSON has `entries` and `focusOrder`; `INTERACTION_RULES` ⊆ `RULE_IDS`; `busy.html` with a 2 s deadline ends with every later step in `skipped` and the lens returning within 4 s.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `feat(lenses): viewport sweep (overflow, clipped text) and the InteractionLens`

### Task 13: CLI — lenses and observers on by default, `--map-only`, `--lens`, candidates in progress and summary

**Files:**
- Create: `packages/cli/src/commands/run-findings.ts`
- Modify: `packages/cli/package.json` (dependencies `@jayslifecode/lookover-lenses`, `@jayslifecode/lookover-rules`), `packages/cli/src/commands/run.ts`, `run-options.ts`, `run-summary.ts`, `packages/cli/src/index.ts` (command description)
- Test: `packages/cli/test/run.test.ts`, `packages/cli/test/run-findings.test.ts`, `packages/cli/test/run-summary.test.ts`

**Interfaces:**
- Produces:
  - Flags: `--map-only` (no lenses, no observers: the plan-01 behaviour) and `--lens <name>` (repeatable; v0 accepts only `interaction`; anything else is `E_USAGE` with the hint `Available lenses: interaction`). `RunOptions` gains `isMapOnly: boolean` and `lenses: readonly LensName[]` (default `['interaction']`). `run.ts` builds `lenses = isMapOnly ? [] : options.lenses.map(createLens)` (`createLens(name: LensName): Lens` in `run-options.ts`; `'interaction'` → `new InteractionLens()`) and `observers = isMapOnly ? [] : undefined` (engine default).
  - Progress line: `✓ /organisations/[id]  12 elements · 1 form · 2 candidates` (`candidates` = `screen.inspected.candidates`, printed when that event arrives; a failed inspection prints `! /route  inspection failed: <error>` as a warning line after the screen's line).
  - `run-findings.ts`: `groupCandidates(file: FindingsFile): { severity: Severity; ruleId: string; title: string; count: number; example: string }[]` (sorted blocker → low, then count desc, then id; `example` = `<route> <role> "<name>"` of the first step finding or `<n> occurrences on <k> screens`), `candidateLines(groups): string[]` (one aligned line per group: `  high    interaction.focus-visible-missing  2  /settings button "Save"`).
  - Summary rows add `Candidates` (count), `Worth a look` (count), `Findings` (path of the run's `findings.json`); after the table the candidate lines, then one info line: `Candidates are measured but not yet judged or reproduced; the judge arrives in the next release.` (`CANDIDATES_NOTE`). With `--map-only` the rows and the note are omitted.
  - The `run` command description: `Open every screen of the app in a real browser, inspect it, and write .lookover/app-map.json and findings.json`.

- [ ] **Step 1: Write the failing tests** (`run.test.ts` mocks `runReview` as before and asserts the lenses passed: default one `InteractionLens`, `--map-only` none and `observers: []`, `--lens nope` exits 2 with the hint; the progress line carries candidates; `run-findings.test.ts` on a hand-built `FindingsFile`; `run-summary.test.ts` for the three new rows and the note).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `pnpm check` green; `pnpm test:e2e` green** (bench still clean → `Candidates 0`; the e2e asserts the three rows and the note exist).
- [ ] **Step 5: Commit** — `feat(cli): run inspects by default; --map-only, --lens; candidates in progress and summary`

### Task 14: Bench seeds — ten issues, three controls

**Files:**
- Modify: `bench/seeds.json`, `bench/README.md` ("Seeds" lists every entry), and per seed the component or page named below
- Create: `bench/app/app/api/stats/route.ts`, `bench/app/components/stat-card.tsx`, `bench/app/test/seeds.test.ts`

**Interfaces:**
- Consumes: the `seeds.json` entry shape fixed in plan 01 (`id, lens, route, selector?, rule, expectedSeverity, control?`); `lens` gains the value `'observers'` (update the README's type).
- Produces, **one commit per row** (code change + its `seeds.json` entry; the message names the id):

| id | route | change | rule | severity |
|---|---|---|---|---|
| interaction-001 | `/settings` | the Save button gets `focus:outline-none` with no replacement (`BUTTON_PRIMARY_NO_RING` in `styles.ts`, used only here) | interaction.focus-visible-missing | high |
| interaction-002 | `/reports` | a second button "Export CSV" (`type="button"`, no handler) styled `bg-slate-100 text-slate-400` | interaction.text-contrast-fail | high |
| interaction-003 | `/organisations` | each row gets a 16×16 "Edit" icon link (`aria-label="Edit <name>"`, an inline SVG pencil, `p-0`) placed 4 px from a 16×16 "Copy email" icon button | interaction.target-size | medium |
| interaction-004 | `/` | the two dashboard stat cards become `<StatCard>`: a `<div role="button" onClick>` that toggles a detail line, with no `tabIndex` | interaction.keyboard-unreachable | high |
| interaction-005 | `/settings` | the "Workspace name" input gets `tabIndex={1}` | interaction.positive-tabindex | low |
| interaction-006 | `/organisations` | the table wrapper loses `overflow-x-auto` and the table gets `min-w-[720px]` (the page scrolls sideways at 390 px) | interaction.horizontal-overflow (viewport `mobile`) | high |
| observers-001 | `/reports` | `ReportDialog` runs `console.error('Report locale missing: falling back to en')` once on mount | observers.console-error | medium |
| observers-002 | `/settings` | the time-zone field's hint renders the literal string `settings.timezone.hint` | observers.raw-i18n-key | medium |
| observers-003 | `/organisations/[id]` | under the form: `<p>{`Last edited by ${org.editor}`}</p>` where `editor?: string` is added to the `Organisation` type but never set in the data, so the template string renders `Last edited by undefined` | observers.raw-value | high |
| observers-004 | `/` | a client component fetches `/api/stats` on mount; the route handler returns `500 { error: 'stats unavailable' }` | observers.request-server-error | high |
| control-001 | `/login` | the Sign in button (unchanged: visible ring) | interaction.focus-visible-missing | — (control) |
| control-002 | `/organisations` | the organisation name links (inline text links; unchanged) | interaction.target-size | — (control) |
| control-003 | `/reports` | the dialog's Close button (unchanged hover and focus) | interaction.hover-state-missing | — (control) |

  Each entry's `selector` is the element's selector **as Lookover builds it** (`button[type="submit"]` on `/settings`, `a[aria-label="Edit Acme Ltd"]`-style selectors are per row: give the selector of the first row, `#…` where ids exist). `bench/test/seeds.test.ts`: every entry validates against a Zod schema of the shape, ids are unique, every `route` is one of the app's routes, every `rule` is in `RULE_IDS` (bench gets `-rules` as a devDependency).

- [ ] **Step 1: Write `seeds.test.ts`** (fails: `lens: 'observers'` and the rules check). **Step 2:** land the rows one commit each (`feat(bench): seed interaction-001 — Save button without a focus ring`, …), running `pnpm --filter @jayslifecode/lookover-bench test` and `typecheck` each time. The plan-01 e2e expectations (`ORGANISATION_FIELDS`, labels, `inputMode: null`) must still hold. **Step 3:** update `bench/README.md` (table of seeds; `lens` values) and run `pnpm check`.
- [ ] **Step 4: Final commit of the task** — `docs(bench): list the seeded issues and controls`

### Task 15: End-to-end recall and precision against the seeds; README and docs

**Files:**
- Modify: `packages/cli/test/e2e/bench.test.ts`, `README.md`, `docs/superpowers/specs/2026-10-20-lookover-design.md` (status line: plan 02 implemented; §4 Stage 3 note that hover feedback is "worth a look" and persisted-state comparison waits for the behaviour lens), `.github/workflows/ci.yml` (upload `findings.json` with the e2e logs: copy it into `E2E_OUTPUT_DIR` in `keepOutput`)
- Create: `docs/findings.md`, `docs/lenses/interaction.md`, `docs/how-it-works.md` (the pipeline as built so far: Stage 1 and Stage 3 interaction + observers, with the run-log events; one Mermaid diagram), `packages/cli/test/e2e/seeds.ts` (reads `bench/seeds.json`, typed)

**Interfaces:**
- Consumes: `FindingsFile`, `seeds.json`.
- Produces: e2e assertions —
  - `RUN_BUDGET_MS = 150_000`, `MAX_SCREENS = '12'` unchanged; the run exits 0.
  - **Recall:** for every entry without `control`, at least one finding (in `findings`, or in `worthALook` when the rule is `interaction.hover-state-missing`) has `rule.id === entry.rule` and is on `entry.route` (step: the screen with `screenId`'s route; occurrence: some occurrence's `route`), and, when `entry.selector` is set, that finding's `target.selector` or an occurrence `selector` equals it; for `interaction-006` the occurrence's `viewport.name` is `mobile`.
  - **Precision:** for every `control` entry, no finding with that rule has that route **and** selector; and no finding at all has a `rule.id` outside `RULE_IDS`.
  - The summary prints `Candidates` ≥ 10, the candidate lines include `interaction.focus-visible-missing`, and the note.
  - `findings.json` round-trips through `readLatestFindings`; every `fixPrompt` is non-empty and mentions its route; every `evidence[].ref.path` exists under the run dir.
  - `changes no bench data` still holds (lenses act on nothing).
- Docs: `README.md` — status line (`v0 in progress — the interaction lens and observers report candidate findings; the judge, replay and report arrive next`), the getting-started output example re-captured from a real run (candidates lines included), the flags table (`--map-only`, `--lens`), a "What it finds" section listing the rules by plain title with a link to `docs/rules.md`, and "What it will not do" updated (candidates are not yet judged; the lens never acts on data). `docs/lenses/interaction.md`: for each of the 12 rules — what is measured, with which CDP call or DOM API, the exact threshold, every exemption and skip reason, and the seed that exercises it. `docs/findings.md`: the contract as implemented, the two shapes, `status`, the id rule, where files live, the fix-prompt shape.

- [ ] **Step 1: Write the e2e assertions** (they fail until the seeds and the CLI wiring from Tasks 13–14 are in; here they must pass). **Step 2: `pnpm test:e2e`** — expected green within 150 s; if a seed is not found, fix the lens or the seed and record which in the ledger (a seed that cannot be detected deterministically is removed, with a backlog note, rather than loosened). **Step 3:** write the docs; regenerate the README example from the real run output. **Step 4: `pnpm check` green.**
- [ ] **Step 5: Commit** — `test(e2e): recall and precision against the bench seeds` then `docs: interaction lens, findings contract, how it works, README for plan 02`

---

## Self-review notes

- **Spec coverage.** §4 Stage 3 "Interaction lens": force `:hover/:focus/:focus-visible/:active` with computed styles and crops → Task 9; "check disabled and loading states where present" → **deferred**: the gallery records disabled controls' rest state (Task 9 skips forcing them) and loading states need an action, so both wait for the behaviour lens (v1); Tab walk with focus order and visibility → Task 11; tap-target size and contrast → Task 10; viewport sweep for overflow, truncation, horizontal scroll → Task 12. "Observers": console errors and warnings → Task 6; every request with status → Task 7 ("whether the screen agreed" is behaviour-lens work: deferred, noted in the spec amendment); rendered text scan → Task 7; "persisted state after reload compared with what the screen claimed" → deferred to the behaviour lens (needs an action to compare against). §5 finding contract → Task 4 (the `mark as intended` control and `lookover replay` are plan 03, where the report and the replay runner exist; `status` is reserved for them). §6 `packages/lenses`, `packages/rules` catalogues → Tasks 3, 8–12. §7 seeds and controls → Task 14; the harness that computes precision/recall numbers is plan 04 (the e2e checks recall and controls directly for now). §8 docs → Task 15 plus the generated rules catalogue (Task 3).
- **Step scan.** Every step names a test with its assertions or a signature with its file; prose bodies appear only where the signature leaves an algorithm open (target-size geometry, the in-page sources' contracts, the Tab-walk stop rules).
- **Type consistency.** `LensContext.viewports[0]` is the capture viewport everywhere; `ElementRef.backendNodeId` is optional, so `measureOn` falls back to `resolveSelector`; `Finding.key` feeds `findingId`; `LensSkip` is shared by lenses and `screen.inspected`; `Observer.collect` runs before lenses (Task 5) and Task 7's text observer relies on that order. `runReview` replaces `runDiscovery` in Task 5 and every later task uses the new name.
- **Review Focus** items 1–5 each have a test: Task 9 (`#after`, `#shadow`), Task 8/10 (`background-uncertain`), Task 10 (inline link, checkbox, `#icon` crowded), Task 6 (dev noise), Tasks 5 and 12 (deadline, throwing lens).
- **Proportion.** The plan fixes decisions (rule list, thresholds, exemptions, shapes, orders) and leaves bodies to the implementer; the longest blocks are the rule table and the in-page source contracts, which are decisions, not code.
- **Calls made in this plan the author can override:** hover feedback is "worth a look" rather than a finding; WCAG 2.5.8 (24 px) rather than 44 px is the target-size threshold; two contrast rules split at 3:1; console warnings are worth-a-look only; redirected screens keep the landed URL; `runDiscovery` renamed to `runReview`; lenses are injected by the CLI (core never imports a lens); ten seeds and three controls.
