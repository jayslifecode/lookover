# Lookover — design

*Working name (repo `lookover`, npm package `@jayslifecode/lookover`). Date: 2026-10-20. Status: approved 2026-10-20; plan 01 (foundation and App Map) implemented 2026-10-21; plan 02 (interaction lens and observers) implemented 2026-10-22 — amendments made during that work are marked "(amended 2026-10-21)" and "(amended 2026-10-22)".*

Lookover is an open-source design-and-QA reviewer that drives a web app in a real browser the way a senior front-end reviewer would, and reports what it can prove. It is built for people who came to coding through AI tools and ship real sites without anyone experienced checking their work.

## 1. Intent and why

### The problem
Code generation got cheap; verification did not. People building with Claude Code, Cursor, Codex and Lovable ship sites that work on the happy path and fail everywhere else: inputs that accept anything, buttons with no hover or focus state, four date formats on one site, contrast that fails accessibility, error messages that show raw translation keys, forms with no empty or loading state, and validation that exists in the form but not in the API. They do not know what a senior reviewer would check, so they cannot ask their coding agent to check it.

Research done for this project (see `reports/Testing pain points and vibe coding.md` in the author's Documents folder) found:
- Developers' main pain in 2026 is trusting code they did not write; 48% trust AI only when they can check its answer themselves (Stack Overflow 2026).
- The documented failures of vibe-coded apps (Lovable CVE-2025-48757, Moltbook, Base44) were found by browsing the app and replaying requests, not by reading code.
- The AI testing market is crowded with "AI writes your Playwright tests" products; the best-known (Octomind) shut down in 2026 for lack of market validation. Reproduction-gated reporting is already common (Momentic, QA Wolf).
- No tool combines measured UI-state inspection, cross-screen consistency analysis, and code-derived behaviour rules, or cites the contradicted source line in a finding.
- Exploratory testing finds about 4.5x more real defects than scripted tests with no more false alarms (Afzal et al.).

### The Lovable lesson
Lovable runs on the same models as everyone else. It won because it removed the terminal, showed results instantly, wired up the infrastructure, and remembered the project. Lookover applies the same lesson to review: encoded expertise, measurement instead of guessing, memory across runs, and a visual report, instead of a prompt.

### Two audiences
1. **The builder** who runs it: someone with a repo and a localhost who uses an AI coding agent and has no senior reviewer. They should see their first confirmed finding within about 60 seconds of their first run (a real requirement, see Stage 6), in plain language, each with a fix prompt they can paste into their coding agent.
2. **The engineer who reads the repo** (hiring managers, open-source contributors). They should find serious engineering: instrumentation below Playwright, static analysis, a persisted app map, separated explorer and judge agents, a benchmark with published numbers, and documentation to a professional standard.

Both audiences must be served. The second one is why this project exists in the author's portfolio.

## 2. Goals, non-goals, anti-goals

### Goals
- Point it at a repo and a running local app; get a visual report of real, reproducible problems across three lenses (interaction, consistency, behaviour).
- Every finding carries measured evidence, the rule it violates, where that rule lives (file and line when it comes from code), a screenshot, and a replay that runs without the tool or a model.
- A builder with no testing knowledge understands every finding and can act on it with the attached fix prompt.
- Runs again after changes and reports drift and regressions against the previous run.
- The report opens as soon as the run starts and fills in live as findings are confirmed; the first confirmed finding on the bench app appears within about 60 seconds.
- Published precision, recall and cost on a seeded-bug benchmark, compared with Claude Code + Playwright MCP.
- Installs in one command as a CLI and as a Claude Code plugin. MIT licence.

### Non-goals (v1)
- Testing apps the user does not own or run locally. No hosted "paste a URL" service.
- Mobile apps (React Native) — planned later; the architecture must not block it.
- Visual regression (pixel diffs), performance testing, load testing.
- Writing or healing conventional test suites. Lookover produces replay scripts for findings, not a test suite.
- Taste judgements ("this design is ugly"). Lookover reports measurable problems and consistency, and offers suggestions grounded in those measurements.
- Fixing code automatically. It produces fix prompts; the user's coding agent fixes.

### Anti-goals (would make it a failure even if it works)
- Noisy reports. A run that produces ten findings of which three are wrong is worse than a run that produces four that are all right. Precision beats recall.
- Findings a reader cannot verify. If a human cannot reproduce it from the report, it is not a finding.
- Anything that touches production, uses discovered credentials, acts outside the environment the user declared disposable, or leaks the user's data to third parties.
- Becoming "another browser agent". The browser substrate is Playwright; the value is above it.
- A report that only an engineer can read.

## 3. Constraints
- **Language and stack:** TypeScript end to end. Node 22.12+ (amended 2026-10-21: the toolchain's own floor). pnpm monorepo. Playwright for browser control, Chrome DevTools Protocol (CDP) for instrumentation Playwright does not expose. ts-morph for TypeScript AST work. Report UI in React with Tailwind CSS and shadcn/ui (decided by the author).
- **Model access:** Anthropic API via the official SDK; the user supplies their key or runs inside Claude Code where the plugin uses the session. Default model Claude Sonnet 5.5 for judgement, Claude Haiku 5.5 for classification; configurable. Every run shows token use and estimated cost.
- **Targets in v1:** web apps on localhost or hosts the user explicitly allows. First-class support for Next.js (App Router and Pages), then Vite + React. Behaviour-lens extractors for Zod and Yup, GraphQL SDL and Apollo documents, and i18n JSON catalogs; server-validator extraction is pluggable and starts with a simple Express/Apollo convention.
- **Interaction policy (decided by the author):** the default mode is **full interaction**: the explorer may click anything and submit any form, including destructive actions, because the user points it at a disposable environment. This is gated: `lookover init` asks the user to confirm that the app's data is disposable and records `interaction: full` plus that acknowledgement in the config; without it the run refuses to start. A `safe` mode exists (navigate, open menus and dialogs, force states, fill forms, never submit, never click actions matching a destructive word list in English, Korean and Mongolian) for people who cannot provide a disposable database.
- **Safety envelope:** the explorer navigates and makes direct API calls only to allowlisted hosts (localhost, 127.0.0.1, `::1`, `*.local`, `*.localhost`, plus explicit `--allow-host`). The app's own calls to other hosts (a hosted Supabase, Firebase, Stripe, an auth provider) are allowed through, because that is how the audience's apps are built, but before the run Lookover lists every backend host it detected and asks the user to confirm each is a development or disposable instance; calls to known payment, email and SMS providers are blocked at the network layer unless the host is allowlisted. (Amended 2026-10-21 after implementation review:) the detection is an unauthenticated probe of the start page, the first static route and the login page, run **before** login so credentials never reach an unconfirmed backend; once confirmation is done the browser session blocks every call to a host that is neither allowlisted nor confirmed, records it, and the run reports those hosts with the exact `--confirm-host` command to re-run with. Providers are also blocked at DNS (`--host-resolver-rules`, trailing-dot variants included), WebSockets go through the same policy, frames that land on a non-allowed host are moved to `about:blank`, service workers are disabled and the system proxy is bypassed. Known gap, documented in code: a redirect from an allowed host to a non-provider, non-allowed host inside a fetch is recorded but not blocked. Test accounts come from config. Discovered secrets are detected by pattern and local decode and never used. All page content, source maps and API responses are treated as untrusted input to the model. Emails, tokens and keys are redacted in stored evidence and before anything is sent to a model.
- **Authentication in v0:** Playwright storage state (a saved logged-in session) and username-and-password form login driven by config. OAuth, magic links and OTP come later.
- **Cost ceiling:** a full run on a 20-screen app should stay under one dollar of model usage at default settings; deterministic code does the bulk of the work.
- **Licence:** MIT.

## 4. How it works

A run is a pipeline. Stage 2 is purely static. In Stage 5 the judge model never holds browser tools; a deterministic harness performs its re-runs and hands back the results.

### Stage 1 — Discover and map
Build the **App Map**: routes (from the framework's file system plus link-following in the browser), screens (route × key state), interactive elements per screen (from the accessibility tree), forms and fields, and the design tokens actually rendered (colours, font sizes, spacing, radii, from computed styles). Authentication uses stored sessions or test accounts from config. The map is persisted in `.lookover/` and diffed between runs.

### Stage 2 — Extract rules (behaviour lens)
A static pass over the repo with ts-morph produces a **Constraint IR**: for each field, the rules each source imposes (Zod/Yup schema, GraphQL input type, server validator, i18n error strings), each with file and line. Disagreement between two sources is already a finding ("conflict"), reported before anything is clicked.

### Stage 3 — Explore
For each screen, the **explorer** (Playwright + CDP, driven by deterministic plans with the model deciding only field type and applicable attack families):
- **Interaction lens:** for every interactive element, force `:hover`, `:focus`, `:focus-visible`, `:active` and capture computed styles and a crop; check disabled and loading states where present; walk the page with Tab and record focus order and visibility; measure tap-target size and contrast; sweep configured viewports for overflow, truncation and horizontal scroll.
- **Behaviour lens:** negate one constraint at a time through the real UI, then directly against the API; compare outcomes; run state macros (double submit, back, refresh mid-flow, second tab, session expiry); run the two-account probe (create object as A, attempt read and edit as B through the UI flow).
- **Observers (always on, no model):** console errors and warnings; every request with status and whether the screen agreed; rendered text scanned for raw i18n keys, `undefined`, `NaN`, `[object Object]`, truncation; persisted state after reload compared with what the screen claimed.

*(amended 2026-10-22: as built in plan 02, a missing hover state is "worth a look" rather than a finding, because a hover effect written in JavaScript does not show under a forced `:hover`. Disabled and loading states, persisted state after a reload compared with what the screen claimed, and whether the screen agreed with a request's answer all need an action to compare against, so they wait for the behaviour lens. Truncation is measured by the interaction lens's viewport sweep (`interaction.text-clipped`), not by the text observer.)*

### Stage 4 — Consistency analysis
Across the whole App Map, cluster and count: colours and their roles, type sizes, spacing values, radii, date/number/currency formats found in rendered text, button and link wording for the same action, error-message phrasing, presence of empty, loading and error states per list and form. Outliers and near-duplicates become findings with every occurrence listed.

### Stage 5 — Judge and prove
A separate **judge** agent that never drove the app reads each evidence bundle, names the oracle that applies (consistency with the code, with the rest of the app, with accessibility standards, with the message catalog, with the claimed result), and asks the reproduction harness to re-run the finding three times in a fresh browser context. For step-based findings the harness replays the minimal step trace; for aggregate findings (consistency lens) it revisits every listed occurrence and re-measures. The judge discards anything that does not reproduce or that it attributes to explorer error or timing. Only reproduced findings reach the report. Judging is pipelined: findings are judged as the explorer produces them, so confirmed findings stream into the report during the run.

### Stage 6 — Report
A local web report (React + Tailwind + shadcn) and a JSON file. The report opens when the run starts and updates live from the append-only run log; the first confirmed finding should appear within about 60 seconds on the bench app, and the run keeps going behind it. Per screen: annotated screenshot with pinned findings, state gallery (each control in each state), a scorecard. Per finding: the contract below. Whole run: fix-first ordering, drift since last run, cost.

## 5. The finding contract
Every finding has: id; lens; severity (blocker, high, medium, low, by rules per lens, not model opinion); title in plain language; the rule that applies and its source (file:line for code rules, catalogue id for heuristic rules); expected; observed; why it matters (one or two sentences for a non-engineer); evidence (screenshots, request/response, console, computed styles) with redaction applied; reproduction count and environment; a replay (`lookover replay <id>` plus an equivalent standalone Playwright script); a fix prompt for the user's coding agent; a "mark as intended" control whose decision persists in `.lookover/` so it does not return.

Findings come in two shapes. A **step finding** carries a minimal step trace (route, actions, input values) and replays by re-running it. An **occurrence finding** (most consistency findings) carries a list of occurrences, each with route, selector and the measured value, and replays by revisiting each one and re-measuring; its standalone script is a loop over the occurrences.

**Fix prompts in v0** contain: the screen route, the element's selector and accessible name, the React component name when the app runs in development mode and exposes it, the measured facts, and the rule. File and line are included only when the rule came from code. Mapping arbitrary DOM elements back to source files (via source maps or a build-time attribute) is a later improvement, not a v0 requirement.

Findings the tool is not sure about are not findings. They can appear in a separate "worth a look" list only if the user enables it.

## 6. Architecture

pnpm monorepo:
- `packages/core` — run engine, App Map, event-sourced run log, observers, CDP helpers, evidence store, replay runner.
- `packages/extractors` — `zod`, `yup`, `graphql`, `i18n`, `express-apollo` (server validators); each produces Constraint IR; adding one is documented.
- `packages/lenses` — `interaction`, `consistency`, `behaviour`; each is a plugin with a manifest, a deterministic plan generator, and a judge prompt; heuristics live in JSON catalogues under `packages/rules`.
- `packages/judge` — oracle definitions, reproduction harness, attribution logic (product defect vs agent error vs timing).
- `packages/report` — the web report (Vite + React + Tailwind + shadcn), built to static files the CLI serves locally.
- `packages/cli` — `lookover init`, `run`, `replay`, `report`, `diff`.
- `packages/plugin-claude-code` — the Claude Code plugin: a skill and commands that call the CLI and surface findings in the session.
- `bench/` — the seeded-bug sample app (Next.js + Zod + GraphQL + i18n, with Supabase-style RLS scenarios behind a local Postgres) and the benchmark harness.
- `docs/` — see section 8.

Agent runtime uses the Anthropic SDK directly, with structured outputs for classification and judgement, token budgets per stage, response caching keyed on evidence hashes, and all page-derived text wrapped as untrusted data. No agent has the ability to run shell commands against the target.

## 7. Evaluation
`bench/` contains a sample app with roughly 30 seeded issues spread across the three lenses (missing focus styles, a 2.8:1 contrast button, three date formats, a raw i18n key, a form rule that the API does not enforce, an IDOR on an edit route, a success toast on a failed mutation, an unhandled rejection on long input, and so on) plus clean controls that must not be flagged. The harness runs Lookover and records precision, recall, reproduction rate, run time and cost. The same corpus is run with Claude Code + Playwright MCP under a fixed prompt and with Playwright's test agents, and the numbers are published in the README and kept current by CI. If Lookover cannot beat the baseline on precision, the thesis is wrong and the README says so.

## 8. Documentation standard
- `README.md`: one measured number first, a 20-second GIF of a run, the 60-second getting started, what it finds, what it will not do, licence.
- `docs/`: getting started; how a run works (this pipeline, with diagrams); the three lenses and every check each performs; the rules catalogue (generated from the JSON); configuration reference; writing an extractor; writing a lens; the finding contract; safety and privacy (what leaves the machine: only model calls, and what is in them); benchmark methodology and results; architecture overview; ADRs under `docs/adr/`; contributing; FAQ; changelog.
- Conventional commits, issue and PR templates, CI that runs lint, types, unit tests, an end-to-end run against the bench app, and the benchmark on a schedule.

## 9. Delivery

### v0 (target: four to six weeks, quality first) — prove the two visual lenses
Interaction and consistency lenses on Next.js apps; App Map with full-interaction exploration; observers; pipelined judge with reproduction harness; the finding contract in both shapes; the live local report with annotated screenshots and state gallery; `init` (with the disposable-data acknowledgement and backend-host confirmation), `run`, `report`, `replay`; bench app with the interaction and consistency seeds and a disposable local database; README, getting-started and how-it-works docs at the standard in section 8. Work-in-progress may be public on GitHub throughout.
Build order: the exit-test path first (crawl and map → interaction lens → observers → judge and replay → basic report → bench app), then the consistency lens, then the state gallery, live updates and documentation polish.
Exit test: on the bench app, precision above 80% and every finding replays; on one of the author's real apps (UB Engineering: Next.js 15, Apollo GraphQL backend on a development host, form login; run privately against a disposable copy of its data), at least five findings a human agrees with.

### v1 — behaviour lens and the public benchmark
Extractors for Zod, Yup, GraphQL, i18n and the Express/Apollo convention; constraint negation through UI and API; frontend/backend mismatch findings with cited lines; two-account probe; bundle and response secret detection with local decode only; `diff` between runs; Claude Code plugin; full benchmark with baselines published; full docs set.

### Later
Vite + React targets beyond Next.js; React Native via a static scan of Expo builds (`EXPO_PUBLIC_*`) then emulator runs over Maestro or mobile-mcp reusing the Constraint IR; a hosted URL-only mode if there is demand; a VS Code or Cursor extension.

## 10. Decisions and who made them

**Decided by the author:** target audience (AI-first builders who have a repo and a localhost, not web-only Lovable users); report UI in Tailwind + shadcn; open source with professional documentation; the project should visibly demonstrate serious engineering; v1 requires own code and local app; **full interaction as the default mode** against a disposable environment; **quality-first v0 in four to six weeks**; keep the name Lookover with a scoped npm package.

**Calls made in this design (the author can override):** TypeScript and pnpm monorepo; Playwright + CDP; ts-morph; Anthropic SDK with Sonnet 5.5 / Haiku 5.5 defaults; MIT; CLI plus Claude Code plugin as the delivery shape; v0 scope limited to the interaction and consistency lenses; precision over recall as the governing rule; Next.js as the first supported framework; the local report as a static Vite build served by the CLI rather than a Next.js app; the finding contract in section 5 with its two shapes; the acknowledgement gate and backend-host confirmation around full interaction, and the `safe` mode as an alternative; blocking payment, email and SMS providers at the network layer unless allowlisted; v0 authentication limited to storage state and form login; fix prompts in v0 grounded in selector, accessible name and component name rather than source file; live streaming of confirmed findings into the report, with the judge pipelined, as a v0 requirement.

**Left to the builder:** internal data formats for the App Map and Constraint IR; the exact heuristics catalogue beyond the examples given (start from Hunter's "You Are Not Done Yet", the Big List of Naughty Strings, BugMagnet, WCAG 2.2 AA, and libphonenumber); crawl and authentication strategy details; how screenshots are stored and deduplicated; the judge's prompts; the bench app's exact seeded issues; CI layout; package naming; whether to use the Claude Agent SDK or the plain Anthropic SDK.

## 11. Report design (decided by the author: dark navy-and-black theme, light and dark modes, glass used as a showcase, not everywhere)

### Principles
- **Glass only where a layer floats over content.** This is how Apple uses it: controls over scrolling material. In the report that means three surfaces: the floating top bar, the finding pins on screenshots, and the finding detail panel. Lists, the sidebar and anything read in bulk are solid, high-contrast surfaces. Never more than three glass layers on screen.
- **Two designed palettes, not an inverted stylesheet.** Dark is deep navy to near-black (`#060a13` → `#0b1222` → `#111b31`) with soft blue and violet glows and an electric-blue accent (`#5b8def`). Light is cool off-white (`#eef1f7` → `#f6f8fc` → `#ffffff`) with the same accent darkened (`#2f6be0`). Severity colours are tuned per theme (dark: coral `#f0616d`, amber `#efb75a`, mint `#7dd3a8`; light: deeper variants). The user's own app screenshots keep their real colours in both themes.
- **Type:** Manrope for interface text, JetBrains Mono for selectors, measurements and code. One scale, weights 400–700.
- **Theme switching** follows the system by default, with a persisted override; tokens are CSS custom properties under `[data-theme]`, mapped into Tailwind v4 via `@theme inline`, and shadcn components consume them.

### How the glass is built (progressive enhancement)
1. Base, everywhere: a translucent tint of the surface colour, `backdrop-filter: blur(18px) saturate(160%)`, a 1px light edge, a specular sheen gradient along the top edge, and a soft drop shadow. This is "frosted glass" and works in current Chrome, Safari and Firefox (`backdrop-filter` is widely supported; verify against caniuse before release).
2. Refraction, Chromium only: an SVG `feDisplacementMap` (optionally with `feSpecularLighting`) applied through `backdrop-filter: url(#lens)` on the finding panel's edge, guarded by `@supports` and feature detection, with the base look as the fallback. Keep it to small surfaces; displacement on large areas is CPU-expensive.
3. Accessibility and performance guards: `prefers-reduced-transparency: reduce` and `prefers-reduced-motion` switch glass surfaces to solid; text on glass is checked for 4.5:1 against both the lightest and darkest content it can float over, and the tint opacity is raised until it passes; no more than three glass layers at once; blur radius capped at 18px; tested with CPU throttling.

### Motion (decided by the author: smooth, physical, "liquid" where it helps)
- **Rule:** motion answers an action or shows a change of state; nothing moves on its own except the live-run indicator. Every animation is off under `prefers-reduced-motion`.
- **Moments:** pins press with a short spring; the finding panel grows out of the pin that was clicked (container transform, below) rather than fading over the old one; the sheen on glass follows the pointer; the theme switch is a circular reveal from the button using the View Transitions API; buttons scale down on press; toasts spring in; the segmented control's selection is a liquid pill (below).
- **The liquid pill (segmented control, mobile tab bar) — settled in the v6–v10 motion study, measured in Playwright:**
  - *Two-edge spring.* The pill's left and right edges are separate critically-damped-ish springs (lead edge stiffness 420 / damping 30, trail edge 230 / 24, semi-implicit Euler, two substeps per frame). The edge facing the destination leads, so the pill stretches on the way and contracts on arrival; peak stretch ≈ 1.5× for a three-tab jump, overshoot < 2 % of travel, settled within ~400 ms (lead) / ~650 ms (trail).
  - *Round caps that never squash.* The pill is a full-width layer clipped to its two edges with `clip-path: inset(0 R 0 L round 999px)` (a nested second layer inset by 1px gives the edge line). Scaling a fixed-width element would flatten the end caps; clipping keeps them circular at any width and only the middle stretches. Measured 60 fps (max 18.7 ms frame) with this approach.
  - *One click selects.* Selection happens on `click`; pointer capture and the follow-the-finger mode start only after a 5 px move. Press-and-hold lifts the pill 6 % and squashes it 4 %; dragging follows the pointer with spring lag; release projects the velocity 80 ms ahead and snaps to the nearest tab. A click during a move redirects from the current position (nothing restarts).
  - *Targets come from layout, not from transformed rects.* Edges are measured with `offsetLeft`/`offsetWidth`, because the content under the pill is bent (neighbours scale up to 4 % and lean toward it) and the whole bar shrinks on scroll; measuring `getBoundingClientRect` produced 1–3 px landing errors, `offsetLeft` lands at 0.0 px, also while scrolled.
  - *Lift while travelling* (4 %, soft `drop-shadow`, lands when both edges are within 1.5 px) and a *specular highlight that trails* the direction of travel by up to 10 px. Hover: the resting pill leans up to 6 px toward the cursor.
- **Pin → panel container transform:** a copy of the panel, already rendered with the new finding, grows out of the clicked pin (transform + `clip-path` round-radius 999px → 18px, 560 ms, content fades in from 28 % to 70 % of the way) while the old panel body fades out in 130 ms; on arrival the real panel is swapped in and the copy fades in 150 ms. There is never an empty panel. Pin labels are tooltips (hover / keyboard focus only; the ring marks selection, the panel carries the detail), flip below the dot when the space above is occupied by another pin, and slide sideways to stay inside the screenshot. Pins sit on the target's top-right corner, measured inside the screenshot's border box.
- **Implementation:** CSS transitions with a spring-like curve for small states, a ~20-line spring integrator driven by `requestAnimationFrame` for the pill and the panel drag (interruptible, velocity-carrying; keyframes cannot do this), the Web Animations API for one-shot sequences (dot bounce, container transform), `motion` (Framer Motion's successor) in the React report for layout and shared-element transitions, View Transitions for theme and route changes. No WebGL and no page-screenshot libraries: `dashersw/liquid-glass-js` (WebGL + html2canvas) was evaluated and rejected because it rasterises the page to refract it, is heavy, and lists its animation system as unfinished. The SVG-displacement-over-live-DOM approach ([samasante/liquid-glass](https://github.com/samasante/liquid-glass), [PallavAg/liquid-glass-web-react](https://github.com/PallavAg/liquid-glass-web-react)) keeps text selectable and works across browsers with a frosted fallback; [benis-me/react-liquid-glass](https://github.com/benis-me/react-liquid-glass) is the reference for spring physics on glass.
- **Smoothness rules (decided by the author: no lag, ever):**
  1. A blurred glass layer never changes size, position, opacity-of-blur or filter while visible. Re-blurring a large backdrop every frame is the main cause of stutter in glass UIs.
  2. Everything that moves is a separate element animated with `transform` and `opacity` only (compositor work, no layout, no paint): the pointer-following highlight is a fixed-size element moved with `translate3d`; selection rings and glows are pseudo-elements faded with opacity, never animated `box-shadow`; panel content settles while the panel's glass stays still.
  3. Each glass surface is isolated into its own layer (`isolation: isolate; contain: paint`), `will-change` only on elements that actually animate, pointer handlers throttled to one update per frame with `requestAnimationFrame`.
  4. The refraction filter is static. Animating `feDisplacementMap` was tried and rejected because it re-filters the backdrop per frame.
  5. Blur radius capped at 18px; at most three glass layers on screen; the toast is the only glass that enters or leaves, and it moves with transform.
  6. Budget: 60 fps on a mid-range laptop with the three glass layers present, including during pointer movement and theme switch; measured in CI with a Playwright trace on the bench report (long-task and dropped-frame counts), and the report ships with an optional frame-rate readout for development. Baseline from the v10 mockup at 1440×900 (Playwright, rAF frame times): pill travel, pill drag, container transform and panel jelly drag all average 16.67 ms with a worst frame of 18.7 ms and zero frames over 20 ms; the theme switch has one ~33 ms frame when the View Transition snapshots the page, at the instant the reveal circle still has zero radius.

### References
- SVG displacement approach and its Chromium-only caveat: [webdesign.tutsplus.com](https://webdesign.tutsplus.com/liquid-glass-effect-svg-filters--cms-109200t), [dev.to: six ways to build liquid glass](https://dev.to/devyatov/liquid-glass-on-the-web-6-ways-to-build-it-with-css-and-svg-3m07), [webtricks.dev](https://webtricks.dev/blog/liquid-glass-css), [html-in-canvas.dev](https://html-in-canvas.dev/liquid-glass-effect/).
- Contrast, reduced transparency and GPU cost of stacked `backdrop-filter`: [neelnetworks](https://www.neelnetworks.com/blog/glassmorphism-web-design-guide-2026/), [euleinstitute](https://euleinstitute.com/en/blog/glassmorphism/), [axonixtools](https://axonixtools.com/blog/glassmorphism-in-2026-css-guide/).
- Tailwind v4 + shadcn theming with OKLCH tokens and `@theme inline`: [designrevision dark theme](https://designrevision.com/shadcn-themes/dark.md), [tailwind-v4-shadcn skill](https://skills.sh/site/smithery.ai/tailwind-v4-shadcn).
- The report should link to these from `docs/report-design.md` and state the fallbacks, so the implementation itself is part of the showcase.

## 12. Open risks
- Prompt injection from page content and source maps; treated as untrusted throughout, but needs tests of its own.
- Authentication is the practical blocker for autonomous exploration; the stored-session and test-account story must work in v0.
- Cost and run time on large apps; sampling strategy for screens may be needed.
- The consistency lens can produce "true but unimportant" findings; severity rules and grouping must keep the report short.
