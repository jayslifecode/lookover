# Plan 03 backlog — deferred minors and parked items from the per-task and whole-branch reviews

Collected 2026-10-27 from the execution ledger of `2026-10-22-lookover-03-judge-replay-and-report.md`. Every item here was judged non-blocking for merge. The whole-branch review's five Important findings and the deferred items it triaged as fix-before-merge were fixed in the final fix wave (see the plan's amendments section); what remains is below.

## Do first in plan 04 (the consistency lens and the benchmark need these)
- A `Judge.abort()` so a crawl that fails mid-run stops the queued batches (today they finish on a closing session and their `finding.judged` events land after `run.failed`; the report's reducer ignores them).
- Step judgements should record `finding.trace.viewport`, not the screen's viewport (they agree today; a viewport-specific step rule would record the wrong one and show it to the model).
- Share one run per lens step per attempt: today each sweep occurrence reloads on its own and each focus finding re-walks the Tab order; the bench stays within budget, but a 20-screen app with many findings will not.
- A model call can still go out after the first API failure when a batch passed the `modelFailure` check before it; re-check right before `model.judge`.
- Occurrence findings are decided one at a time in `drain`, each possibly a model call after the crawl; a bounded pool that keeps their order.
- Any failure while building a finding's evidence bundle is labelled "evidence unreadable"; narrow the catch to the evidence read itself so a different bug is not mislabelled.
- Contrast on glass is not proven automatically (the interaction lens skips contrast over glass); a Playwright check that samples the report's text over the lightest and darkest content it can float over, as spec §11 asks.
- The consistency lens's occurrence findings have no `box`, so the report lists them without a pin; give occurrences a box (or a crop) so they can be pinned too.
- A live cost tally in the report during the run (sum the per-finding judgements as they arrive) instead of hiding the readout until the run finishes.
- The judge's verdict cache key should include a hash of the system prompt and the schema, not only `JUDGE_PROMPT_VERSION` (a forgotten bump serves stale verdicts); per-model cache-read factors (Opus 5.5 reads at 0.05×, not 0.1×); `readCachedVerdict` does not check the stored model.
- The SDK's schema transform moves enums into descriptions, so the grammar does not constrain `verdict`/`attribution` (the client-side Zod parse does); try `transform: false` or a raw JSON schema.
- Measure the cost: one keyed bench run (`LOOKOVER_E2E_MODEL=1 pnpm test:e2e` prints the Judge row) and record the number in the README, which today says the cost is unmeasured and names the target instead.
- Set the CI frame budget: the 34 ms budget is record-only until a GitHub runner's `frames.json` has been seen; then set `LOOKOVER_FRAME_BUDGET_MS` in the workflow so it is asserted again (the 60 ms hard limit is always asserted).

## Known gaps accepted for v0 (documented in code or docs)
- Without `ANTHROPIC_API_KEY` the harness confirms on its own: a finding that reproduces three times is reported without the model's attribution; the summary, the report and the finding's note say so.
- A finding needs 3 of 3 reproductions; anything that comes and goes is rejected as timing and never reaches the report (it stays in `findings.json` under `rejected`).
- The model may only reject a reproduced finding (as `explorer-error` or `exemption`); it never confirms an unreproduced one and never changes severity.
- Worth-a-look entries are neither reproduced nor judged; the report shows them behind a switch, offers Copy and Replay, and does not let them be marked intended.
- Decisions made while a run is still going are recorded for the next run; replay is unavailable until the run finishes.
- The report server listens on loopback only; the token cookie is per port but, cookies ignoring ports, it is also sent to any other 127.0.0.1 server (the user's dev server receives the token in its `Cookie` header); other same-site pages cannot read evidence (CORP, no CORS, nosniff) nor write (Origin check). The token also travels in the argv of `open`/`xdg-open` (visible via `ps` to other local users; a redirect file would avoid it).
- The report's drift compares findings by id; screens added and removed come from the routes the previous run's findings name, since the previous App Map is not served.
- The standalone replay script needs only Playwright, but a finding behind a login needs a storage state (`STORAGE_STATE`); the script's `environment.lookover` is the judge package's version.
- The pin-to-panel transform runs only from the `xl` breakpoint, where the panel floats; below it the panel is inline and swaps at once.
- The pre-confirmation probe carries the saved session's cookies when `auth.type` is `storageState`; the docs say so.

## Deferred minors by area

### Core shapes and decisions (Task 1)
- `writeDecision` is read-modify-write without serialisation (the report server serialises its own writes per directory; the CLI's `mark` does not).
- A version-2 findings file missing `judge` or `environment` reads as undefined (top-level check only); `readDecisions` rethrows non-ENOENT I/O errors raw.
- `Decision`/`DecisionsFile` are hand-written beside their Zod schemas; `SHAPE_PROBLEM` is declared after its use in persist.ts.

### Isolated pages (Task 2)
- No isolated-page test for frame containment; `serviceWorkers: 'block'` and the viewport mapping are duplicated between `launch` and `newIsolatedPage`; the failure branch of `newIsolatedPage` is untested; `openWithCdp`'s unguarded `page.close()` can mask a CDP-attach error.

### Reproduce (Task 3)
- The reproduce tests do not prove `only` is passed through; an occurrence viewport missing from `context.viewports` fails silently (not reproduced, no reason); `rerunTabWalk` duplicates `walkTabs` and skips its focus/scroll reset; page-wide occurrence rules reproduce or fail together by id; `Lens.reproduce` does not document that it may throw; `skipped` can name a sibling rule's skip for static targets.

### Harness (Task 4)
- `REPLAY_TIMING` duplicates the crawler's private settle/timeout defaults (export from core); the `navigate` option is typed `Promise<unknown>` where `Promise<void>` would make misuse a type error; `reproduce` trusts the batch shape (loads the first target's URL); no tests for an empty batch or a bad `attempts`; a dead browser turns good measurements and every later candidate into `error:` rejections (see `Judge.abort()` above).

### Model judge (Task 5)
- The wrapper escape matches only `<` followed by the tag name (escape every `<` in page text); occurrence findings list every place and attempt unbounded; evidence labels are unwrapped by convention only; `redactDeep` masks only string values under sensitive keys (a numeric secret under such a key passes); the live test has never run and uses a synthetic bundle.

### Pipeline (Task 6)
- `judgeOccurrence` recomputes what `decideOccurrence` computes; the crawl keeps queuing batches after the queue failed; coverage gaps (a step id on two screens, a `LookoverError` from the model, a model failure under concurrency 2, drain with zero batches); `createdAt` is taken before judging (earlier than every `judgedAt`).

### CLI (Task 7)
- Candidates never handed to the judge in a judged run appear in no row and no list (a "Not judged" row); `mark clear` resolves only ids in the latest findings file (resolve against the decisions' keys too); `--judge-model` is silently ignored with `--no-judge` or without a key (warn); decisions are read after `createRun` (a broken decisions.json leaves an orphan run dir); `.lookover` is duplicated in mark.ts; `JUDGE_FLAG_HELP` also holds the report/open help; the `--no-judge` help text does not say decisions still apply; `withIntendedMoved` is O(n²); `run-inspection.test.ts` is 437 lines.

### Replay (Task 8)
- `resolveAuth` and the launch call are copied from the engine (a core helper doing launch + auth resolution); `attemptLines` numbers attempts across targets without naming the occurrence; a missing `playwright` fails with Node's raw ERR_MODULE_NOT_FOUND; the catalogue plugin is silent if the rules package moves its `readFileSync`; `--script` ignores `--times`/`--headless` and overwrites an existing file; the shared base-URL hint names `--allow-host`, which `lookover replay` does not have; test gaps (temp dir removal, non-local hosts, multi-screen occurrence replay, a refused replay leaving no temp directory); bench.test.ts is 477 lines.

### Report shell and theme (Task 9)
- The 2 px accent focus ring on glass can fall under 3:1 over dark content (light theme ≈1.6:1; the two-tone ring from Task 10 mitigates it); `reduced.ts` passes a new subscribe function per render; the dev SSE stops on `req.on('close')` (use `res.on('close')`); `refresh-fixture.ts` can orphan the bench process group; the tokens test pins only a few values; no tests for TopBar, LiveIndicator, the app failure state or the mock API's traversal guard; shadcn's semantic `accent` is mapped to the electric blue; leftovers (`'use client'`, a `box-shadow` transition in scroll-area, an `'18px'` literal, duplicated easing, two `cn` import paths).

### Store and pill (Task 10)
- The stream is never closed when the last reader leaves (HMR opens a second EventSource); `use-liquid-pill.ts` is 397 lines (move the pure helpers out before the mobile tab bar reuses them); `prefersReducedMotion()` calls matchMedia per substep and `getBoundingClientRect` per pointermove; the tabpanel is labelled by its own h1 and `aria-controls` points at a missing id when the error alert replaces it; a deep link to an unknown screen says "no screen X" while still streaming; a click on the default tab does not pin it; `onUp` ignores which pointer released (compare `pointerId`); `!ctrlKey` also skips the press effect for a normal ctrl+click on Windows/Linux; the fix-first doc comment overclaims (rule-id/title ties inside a group can depend on arrival); pill layout is stale when tabs change at the same width; coverage gaps in api.ts and the reducer.

### Screens view (Task 11)
- The gallery fetch has no abort/cleanup and never retries; edge clamping ignores the frame's radius and the ring; popover options read alike when titles repeat (add the target's name); images have no intrinsic size (layout shift); `isEvidenceRef` checks only `path`; `isBroken` resets only when the screen id changes; `scrollIntoView` on the desktop sidebar can nudge the page; dead `routeSummary` screens branch, `NOT_MEASURED` defined twice, `Notice` lives in annotated-screenshot.tsx; test gaps (popover with no room either side, clustering after edge clamping).

### Finding panel and Findings view (Task 12)
- Focus falls to body when the dialog unmounts on Back/Forward (focus the panel heading); the ghost grows from the pin button's rect, the study used the dot's; the actions sit inside the scrolling body (below the fold on a long body); `placeGhost` fixes the ghost's position once (page scroll during the grow drifts it from the sticky panel); a decision POST that times out may still have been written (the UI reverts until the next load); status chips use `aria-pressed` for a one-of-two choice (radio group); `FindingActions` reaches into the page store singleton; the single toast id can drop a message fired within ~200 ms of the previous close; the "first 12" label shows even when fewer; a cached file still shows Loading once; `growFromPin` ≈ 60 lines.

### Drift, cost and live states (Task 13)
- Duplicated solid-button class and `plural` helper; `STREAM_RECONNECTING` imported from the API module into selectors; the panel's scroll margins are tied to the top bar's row count; the tooltip lists the parts but not the total or the cost; the dev mock's `isReplayed` is shared across tabs; `logSoon` in decisions-only.ts replaces `lastWrite` rather than chaining; `withManifest` sets `finished` before the events or findings.json arrive, so Drift can briefly list everything as Fixed if `previous` loads first; on a failed run Fixed/Removed compute from partial data (as ruled); no test that a closed or reconnecting stream after run.finished shows no notice.

### Report server (Task 14)
- The replay 409 "available when the run finishes" persists for a run that died without `run.failed`; the tolerant reader drops an unterminated last line even when it parses; `isRunEvent` duplicates and loosens core's envelope check; `FINISHED_BY` is a plain object looked up by event type; a weaker CSP assertion in one moved test; the prefix checks do not resolve symlinks (acceptable: neither directory is requester-writable); test gaps (backslash/encoded traversal, tail stop on disconnect, non-numeric Last-Event-ID, heartbeat, chunked 413).

### Report end to end (Task 15)
- "Never empty" is checked in DOM text only (sample opacity too); the three pill travels count as one interaction with one over-budget frame in total; nothing checks the pill travelled; reduced motion is checked only via `getAnimations()` on a pin click (click a tab too); the sampler stops silently at 600 frames; duplicated open/afterEach bookkeeping between the two e2e files; partial-failure leaks in `serveFixture`/`openReport`; the lens probe's control (band inside a backdrop root → 0 flips) is a recorded manual check, not a committed test; the probe proves the band filters the page, not the visible magnitude; `expect(noise).toBe(0)` is exact; the lens paints no tint under the 1 px border ring and the band/body seam at y = 40 could show over a non-uniform backdrop.

### Docs (Task 16)
- findings.md's redaction paragraph opens as absolute before naming the exception; the ghost's "84 % of the way from its height" lacks a referent; "never … box-shadow" is stronger than the pill's static drop-shadow toggle; README's "readable only by you" could point at the saved-session note; the spec's line 59 still says "unauthenticated probe".

### Final fix wave re-review (2026-10-27)
- The theme test's "no `data-theme` before the module loads" assertion is partly vacuous (its `beforeEach` already clears the attribute); the `index.html` string check in the same test is the real guard.
- The `judge skipped: evidence unreadable (<reason>)` note quotes the first line of the read error, which is the absolute evidence path (local file, local report).
- `.github/workflows/ci.yml` still comments that CI checks "its frame budget"; CI now records the 34 ms budget and asserts only the 60 ms limit and the minimum frame count.
- `docs/findings.md` lists the harness notes but not the new evidence-unreadable note (`docs/how-it-works.md` documents it).

## Parked from spec §11 and the plan
- The mobile tab bar, the panel's jelly drag and the GIF (plan 04 or later).
- Spec §11's frame-rate readout and CPU throttling (CI's software-rendered run stands in).
- `lookover diff`, the consistency lens and the published benchmark (plan 04 / v1).
- The Opus 5.5 cache factor stays documented as approximate until per-model factors land.
