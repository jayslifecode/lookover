# Lookover 01 — Foundation and App Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lookover init` + `lookover run` against the bench app: gate the run on the disposable-data acknowledgement and backend-host confirmation, log in, crawl the app over an allowlisted network, and write a persisted App Map (routes, screens, interactive elements, forms, rendered design tokens, screenshots) plus an append-only run log — Stage 1 of the pipeline, end to end.

**Architecture:** pnpm monorepo. `packages/core` holds the run engine (config → run context → event-sourced JSONL run log → evidence store), the browser layer (Playwright + a CDP session per page, network policy enforced with `context.route`), and the App Map (Next.js filesystem routes + link-following crawl; elements come from the CDP accessibility tree, not from DOM queries). `packages/cli` wraps it with `init` and `run`. `bench/app` is the Next.js sample app every later plan seeds with bugs. No model calls in this plan: Stage 1 is deterministic.

**Tech Stack:** Node ≥ 22 (dev on 24), pnpm 10, TypeScript 5.9 (`^5.9`; TypeScript 7 is out but the toolchain is pinned to 5.x until Vitest/Biome document 7 support), Playwright `1.64.1`, Zod `^4.6`, Vitest `^5.0`, Biome `^2.5`, commander `^15`, `@clack/prompts` `^1.8`; bench app Next.js `16.4.x` + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-20-lookover-design.md` (sections 3, 4 Stage 1, 6, 9 v0). This is plan 1 of 4 for v0; plans 02 (interaction lens + observers), 03 (judge, replay, report) and 04 (consistency lens, bench seeds, docs, CI) follow and build on the interfaces fixed here.

## Global Constraints

- TypeScript end to end, ESM only (`"type": "module"`), Node `>=22` in every `engines` field. pnpm workspace; no npm/yarn lockfiles.
- MIT licence file at the root from the first commit; package names `@jayslifecode/lookover-core`, `@jayslifecode/lookover-cli` (the published CLI package is `@jayslifecode/lookover`; the bin is `lookover`).
- The explorer navigates only to allowlisted hosts: `localhost`, `127.0.0.1`, `::1`, `*.local`, plus `allowHosts` from config / `--allow-host`. The app's own calls to other hosts pass through but are recorded and must be confirmed before a run; calls to payment, email and SMS providers are blocked at the network layer unless allowlisted.
- Full interaction is the default and is gated: config must contain `interaction: "full"` **and** `acknowledgement.disposableData: true`; without it the run refuses to start (`E_ACK_REQUIRED`). `safe` mode needs no acknowledgement.
- Secrets never live in config: credentials are referenced by environment-variable name. Emails, JWTs, API keys and bearer tokens are redacted in every stored JSON blob and log line.
- Everything a run produces goes under `.lookover/` in the user's project: `.lookover/runs/<runId>/{run.jsonl,app-map.json,evidence/}`, `.lookover/app-map.json` (latest), `.lookover/state/` (storage states). `.lookover/` is git-ignored by `init`.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). Every task ends green on `pnpm check` (Biome + `tsc --noEmit` + unit tests).
- No `console.log` in library code; the CLI prints through its own `ui` module.

## Review Focus

1. **Pages that never reach `networkidle`** (SSE, long polling, analytics beacons) — the crawl must still capture the screen within a bounded time. Test in Task 11.
2. **Links that end the session or change data during discovery** (`/logout`, `/signout`, `?action=delete`, buttons are not followed, but `<a>` to such paths are) — the crawler must not follow them; it records them as skipped. Test in Task 11.
3. **A list page with hundreds of links to the same dynamic route** (`/organisations/1 … /200`) — at most two instances per route pattern are visited, so a run stays bounded. Test in Task 11.
4. **A screen with thousands of interactive elements** (a data grid) — element extraction is capped at 500 per screen and says so, instead of taking minutes or exhausting memory. Test in Task 8.
5. **`baseUrl` with a path prefix or trailing slash, and junk links** (`#`, `mailto:`, `tel:`, `javascript:`, cross-origin) — URL normalisation must keep the crawl inside the app. Test in Task 11.

---

## File structure

```
lookover/
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  vitest.workspace.ts
├─ .gitignore  .nvmrc  LICENSE  README.md
├─ packages/core/                      @jayslifecode/lookover-core
│  ├─ package.json  tsconfig.json  vitest.config.ts
│  ├─ src/index.ts                     public exports
│  ├─ src/errors.ts                    LookoverError + ErrorCode
│  ├─ src/config/schema.ts             Zod schema, LookoverConfig type, defaults
│  ├─ src/config/load.ts               loadConfig / writeConfig, acknowledgement gate
│  ├─ src/util/redact.ts               redact()
│  ├─ src/util/hash.ts                 sha256(), shortId()
│  ├─ src/util/url.ts                  normaliseUrl(), isSameApp(), isJunkLink()
│  ├─ src/run/events.ts                RunEvent union
│  ├─ src/run/run-log.ts               RunLog (JSONL, append-only, subscribe)
│  ├─ src/run/run-context.ts           createRun() → RunContext, runId format
│  ├─ src/run/engine.ts                runDiscovery(): routes → auth → probe → crawl → persist
│  ├─ src/evidence/store.ts            EvidenceStore (sha256-deduplicated PNG/JSON)
│  ├─ src/browser/network-policy.ts    classifyRequest(), BLOCKED_PROVIDERS, isAllowedHost()
│  ├─ src/browser/session.ts           BrowserSession (Playwright + CDP + route enforcement)
│  ├─ src/browser/cdp.ts               getAXTree(), boxFor(), resolveBackendNode()
│  ├─ src/browser/auth.ts              ensureAuth(): storageState / form login
│  ├─ src/map/types.ts                 AppMap, Screen, ElementRef, FormInfo, FieldInfo, TokenSample, RouteInfo
│  ├─ src/map/next-routes.ts           discoverNextRoutes(), matchRoute()
│  ├─ src/map/selectors.ts             BUILD_SELECTOR_SOURCE (in-page function as string)
│  ├─ src/map/elements.ts              extractElements() via CDP accessibility tree
│  ├─ src/map/forms.ts                 extractForms()
│  ├─ src/map/tokens.ts                collectTokens()
│  ├─ src/map/crawler.ts               crawl()
│  ├─ src/map/persist.ts               writeAppMap(), readLatestAppMap(), diffAppMaps()
│  └─ test/…                           one test file per module + test/fixtures/serve.ts (static fixture server)
├─ packages/cli/                       @jayslifecode/lookover-cli, bin "lookover"
│  ├─ src/index.ts  src/ui.ts  src/commands/init.ts  src/commands/run.ts
│  └─ test/init.test.ts  test/run.test.ts  test/e2e/bench.test.ts
└─ bench/
   ├─ app/                             Next.js 16 App Router sample app (login, dashboard, organisations, settings, reports)
   ├─ seeds.json                       seeded-issue manifest (schema fixed here, entries added in plans 02/04)
   └─ scripts/reset.ts                 resets bench/app/data/*.json
```

---

### Task 1: Monorepo scaffold and toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.workspace.ts`, `.gitignore`, `.nvmrc`, `LICENSE`, `README.md`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/src/errors.ts`, `packages/core/test/errors.test.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`, `packages/cli/src/index.ts`

**Interfaces:**
- Produces: `LookoverError` (`src/errors.ts`): `class LookoverError extends Error { constructor(readonly code: ErrorCode, message: string, readonly hint?: string) }`; `type ErrorCode = 'E_CONFIG_NOT_FOUND' | 'E_CONFIG_INVALID' | 'E_ACK_REQUIRED' | 'E_HOSTS_UNCONFIRMED' | 'E_AUTH_FAILED' | 'E_NAVIGATION_BLOCKED' | 'E_RUN_FAILED'`.
- Root scripts: `pnpm check` = `biome check . && pnpm -r typecheck && pnpm -r test`; `pnpm test:e2e` = `pnpm --filter @jayslifecode/lookover-cli test:e2e`.

- [ ] **Step 1: Write the root workspace files**

`pnpm-workspace.yaml`: `packages: ['packages/*', 'bench/app']`. Root `package.json`: `"private": true`, `"type": "module"`, `"packageManager": "pnpm@10.8.0"`, `engines.node ">=22"`, devDependencies `typescript ^5.9`, `@biomejs/biome ^2.5`, `vitest ^5.0`, `@types/node ^24`; scripts `check`, `test`, `test:e2e`, `typecheck` (`pnpm -r typecheck`), `lint` (`biome check .`), `format` (`biome format --write .`). `tsconfig.base.json`: `strict`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2023`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `skipLibCheck`. `biome.json`: recommended rules, 2-space indent, single quotes, line width 110, `noConsole: error` for `packages/core/src/**`. `.gitignore`: `node_modules`, `dist`, `.lookover`, `bench/app/.next`, `bench/app/data/*.json` except `bench/app/data/seed/`. `.nvmrc`: `24`. `LICENSE`: MIT, "Copyright (c) 2026 Munkhjavkhlan Enkhbaatar". `README.md`: title, one-paragraph description from the spec's opening sentence, a "Status: v0 in progress — see docs/superpowers/plans" line.

- [ ] **Step 2: Write the two package manifests**

`packages/core/package.json`: name `@jayslifecode/lookover-core`, `exports: { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`, scripts `build: tsc -p tsconfig.json`, `typecheck: tsc -p tsconfig.json --noEmit`, `test: vitest run`; dependencies `playwright 1.64.1`, `zod ^4.6`. `packages/cli/package.json`: name `@jayslifecode/lookover-cli`, `bin: { "lookover": "./dist/index.js" }`, dependencies `@jayslifecode/lookover-core: workspace:*`, `commander ^15`, `@clack/prompts ^1.8`; scripts as core plus `test:e2e: vitest run --config vitest.e2e.config.ts`. Both `tsconfig.json` extend the base with `rootDir: src`, `outDir: dist`, `include: ['src']`.

- [ ] **Step 3: Write the failing test**

`packages/core/test/errors.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { LookoverError } from '../src/errors.js';

describe('LookoverError', () => {
  test('carries a stable code and an optional hint', () => {
    const err = new LookoverError('E_ACK_REQUIRED', 'Run refused', 'Run `lookover init`');
    expect(err.code).toBe('E_ACK_REQUIRED');
    expect(err.hint).toBe('Run `lookover init`');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LookoverError');
  });
});
```

- [ ] **Step 4: Install and run the test to verify it fails**

Run: `pnpm install && pnpm exec playwright install chromium` then `pnpm --filter @jayslifecode/lookover-core test`
Expected: FAIL — cannot find module `../src/errors.js`.

- [ ] **Step 5: Implement `src/errors.ts` and `src/index.ts`**

`index.ts` re-exports `LookoverError` and `ErrorCode` (later tasks append their exports here). `packages/cli/src/index.ts` is a stub `#!/usr/bin/env node` that prints `lookover 0.0.0`.

- [ ] **Step 6: Run `pnpm check` to verify everything passes**

Run: `pnpm check`
Expected: Biome clean, both packages typecheck, 1 test passed.

- [ ] **Step 7: Commit (includes the design doc and this plan)**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with core and cli packages"
```

---

### Task 2: Config schema, loader and the acknowledgement gate

**Files:**
- Create: `packages/core/src/config/schema.ts`, `packages/core/src/config/load.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces: `configSchema` (Zod) and `type LookoverConfig = z.infer<typeof configSchema>`:
  - `baseUrl: string (url)`, `root: string = '.'`, `framework: 'next' | 'vite-react' | 'unknown' = 'next'`
  - `interaction: 'full' | 'safe'`
  - `acknowledgement?: { disposableData: true; acknowledgedAt: string (ISO); by?: string }`
  - `allowHosts: string[] = []`, `confirmedBackendHosts: string[] = []`
  - `viewports: { name: string; width: number; height: number }[] = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]`
  - `maxScreens: number = 40`, `maxPerRoute: number = 2`
  - `auth: { type: 'none' } | { type: 'storageState'; path: string } | { type: 'form'; loginUrl: string; usernameSelector: string; passwordSelector: string; submitSelector: string; usernameEnv: string = 'LOOKOVER_USERNAME'; passwordEnv: string = 'LOOKOVER_PASSWORD'; successUrl: string }` (default `{ type: 'none' }`)
  - `model: { judge: string = 'claude-sonnet-5-5'; classify: string = 'claude-haiku-5-5' }`
- `CONFIG_FILENAME = 'lookover.config.json'`
- `loadConfig(cwd: string): Promise<{ config: LookoverConfig; path: string }>` — throws `E_CONFIG_NOT_FOUND`, `E_CONFIG_INVALID` (message lists Zod issues as `path: message` lines), `E_ACK_REQUIRED` when `interaction === 'full'` and `acknowledgement?.disposableData !== true`.
- `writeConfig(cwd: string, config: LookoverConfig): Promise<string>` — pretty JSON, 2 spaces, trailing newline.

- [ ] **Step 1: Write the failing tests**

`test/config.test.ts` (uses `fs.mkdtemp` per test):
```ts
test('applies defaults to a minimal safe-mode config', async () => {
  await write({ baseUrl: 'http://localhost:3000', interaction: 'safe' });
  const { config } = await loadConfig(dir);
  expect(config.maxScreens).toBe(40);
  expect(config.viewports).toEqual([{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]);
  expect(config.auth).toEqual({ type: 'none' });
  expect(config.model.judge).toBe('claude-sonnet-5-5');
});
test('refuses full interaction without the disposable-data acknowledgement', async () => {
  await write({ baseUrl: 'http://localhost:3000', interaction: 'full' });
  await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_ACK_REQUIRED' });
});
test('accepts full interaction with the acknowledgement', async () => {
  await write({ baseUrl: 'http://localhost:3000', interaction: 'full', acknowledgement: { disposableData: true, acknowledgedAt: '2026-10-20T10:00:00.000Z' } });
  await expect(loadConfig(dir)).resolves.toBeTruthy();
});
test('reports every invalid field', async () => {
  await write({ baseUrl: 'not a url', interaction: 'loud', maxScreens: -1 });
  await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_CONFIG_INVALID', message: expect.stringMatching(/baseUrl[\s\S]*interaction[\s\S]*maxScreens/) });
});
test('missing file', async () => { await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'E_CONFIG_NOT_FOUND' }); });
test('form auth defaults the env var names', async () => {
  await write({ baseUrl: 'http://localhost:3000', interaction: 'safe', auth: { type: 'form', loginUrl: '/login', usernameSelector: '#u', passwordSelector: '#p', submitSelector: 'button', successUrl: '/' } });
  const { config } = await loadConfig(dir);
  expect(config.auth).toMatchObject({ usernameEnv: 'LOOKOVER_USERNAME', passwordEnv: 'LOOKOVER_PASSWORD' });
});
test('writeConfig round-trips', async () => { const p = await writeConfig(dir, cfg); expect((await loadConfig(dir)).path).toBe(p); });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @jayslifecode/lookover-core test -- config`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `schema.ts` and `load.ts`**

Zod 4: use `z.url()` for `baseUrl`, `z.iso.datetime()` for `acknowledgedAt`, `z.discriminatedUnion('type', …)` for `auth`. The gate lives in `loadConfig`, after parsing, so the schema stays reusable for `init`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @jayslifecode/lookover-core test -- config`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config packages/core/test/config.test.ts packages/core/src/index.ts
git commit -m "feat(core): config schema with the disposable-data acknowledgement gate"
```

---

### Task 3: Redaction, hashing and URL helpers

**Files:**
- Create: `packages/core/src/util/redact.ts`, `packages/core/src/util/hash.ts`, `packages/core/src/util/url.ts`
- Test: `packages/core/test/redact.test.ts`, `packages/core/test/url.test.ts`

**Interfaces:**
- `redact(text: string): string` — replaces: emails → `[email]`; JWTs (`eyJ[\w-]+\.[\w-]+\.[\w-]+`) → `[jwt]`; `Bearer <token>` → `Bearer [token]`; `AKIA[0-9A-Z]{16}` → `[aws-key]`; `(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}` → `[api-key]`; `sb_(publishable|secret)_[A-Za-z0-9_-]{8,}` and `sbp_[a-f0-9]{40}` → `[api-key]`; `(?i)(api[_-]?key|secret|token|password)(["']?\s*[:=]\s*["']?)([^\s"',;]+)` → keeps the key name, value → `[redacted]`.
- `redactDeep<T>(value: T): T` — applies `redact` to every string in a JSON-like value (new object; input untouched).
- `sha256(data: Buffer | string): string` (hex), `shortId(data: Buffer | string, length = 12): string`.
- `normaliseUrl(href: string, base: URL): URL | null` — resolves relative hrefs, drops the hash, lowercases host, removes a trailing slash except for `/`, sorts query parameters; returns `null` for junk (`#`, `mailto:`, `tel:`, `javascript:`, `data:`, `blob:`).
- `isSameApp(url: URL, base: URL): boolean` — same origin and `url.pathname` starts with `base.pathname` (base path prefix respected, `http://localhost:3000/app` ⇒ only `/app/**`).
- `routeKey(url: URL): string` — `pathname + search`.

- [ ] **Step 1: Write the failing tests** — `redact.test.ts`: one `test.each` row per pattern above with an exact input and expected output (e.g. `'contact jay@example.com now' → 'contact [email] now'`, `'Authorization: Bearer abc.def' → 'Authorization: Bearer [token]'`, `'apiKey: "sk_live_1234567890abcd"' → 'apiKey: "[redacted]"'`), plus `redactDeep` on `{ a: ['x@y.z'], b: { c: 'ok' } }` returning a new object and leaving the input unchanged. `url.test.ts`: `normaliseUrl('#top', base) === null`, `mailto:` null, `'/orgs/'` → `/orgs`, `'/orgs?b=2&a=1'` → `/orgs?a=1&b=2`, hash dropped, `isSameApp` true/false for origin and path-prefix cases (`base = http://localhost:3000/app`, `/app/x` true, `/other` false, `http://localhost:3001/app` false).

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @jayslifecode/lookover-core test -- redact url` → FAIL (modules not found).

- [ ] **Step 3: Implement the three modules** — `redactDeep` must not mutate (build new arrays/objects).

- [ ] **Step 4: Run to verify they pass** — same command, all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): redaction, hashing and url normalisation helpers"`

---

### Task 4: Event-sourced run log and run context

**Files:**
- Create: `packages/core/src/run/events.ts`, `packages/core/src/run/run-log.ts`, `packages/core/src/run/run-context.ts`
- Test: `packages/core/test/run-log.test.ts`, `packages/core/test/run-context.test.ts`

**Interfaces:**
- `events.ts`: `type RunEventBody =`
  `| { type: 'run.started'; baseUrl: string; interaction: 'full' | 'safe'; viewports: Viewport[] }`
  `| { type: 'route.discovered'; route: RouteInfo }`
  `| { type: 'auth.completed'; method: 'none' | 'storageState' | 'form'; statePath?: string }`
  `| { type: 'auth.lost'; url: string }`
  `| { type: 'host.observed'; host: string; kind: 'navigation' | 'app-call' }`
  `| { type: 'request.blocked'; url: string; reason: 'provider' | 'host-not-allowed' }`
  `| { type: 'screen.discovered'; url: string; from: string | null }`
  `| { type: 'screen.skipped'; url: string; reason: 'destructive-link' | 'route-cap' | 'max-screens' | 'not-same-app' }`
  `| { type: 'screen.captured'; screen: Screen }`
  `| { type: 'screen.truncated'; screenId: string; elements: number; kept: number }`
  `| { type: 'run.finished'; screens: number; durationMs: number }`
  `| { type: 'run.failed'; error: { code: string; message: string } }`;
  `type RunEvent = RunEventBody & { seq: number; at: string; runId: string }`. (`Viewport`, `RouteInfo`, `Screen` are imported from `map/types.ts`, created in Task 7; until then `events.ts` may declare them as `import type` placeholders — Task 7 replaces nothing, it only adds the file.)
- `run-log.ts`: `class RunLog { static async open(file: string, runId: string): Promise<RunLog>; append(body: RunEventBody): Promise<RunEvent>; subscribe(fn: (e: RunEvent) => void): () => void; static async read(file: string): Promise<RunEvent[]>; get file(): string }`. One JSON object per line; `seq` starts at 1 and continues from the last line when reopening an existing file; `at` is ISO; each string in the body passes through `redactDeep` before writing; appends are serialised (a promise chain) so concurrent `append` calls never interleave lines.
- `run-context.ts`: `interface RunContext { runId: string; dir: string; lookoverDir: string; log: RunLog; evidence: EvidenceStore; config: LookoverConfig; startedAt: Date }`; `createRun(opts: { cwd: string; config: LookoverConfig; now?: Date; random?: () => string }): Promise<RunContext>` — `runId` = `YYYYMMDD-HHmmss-xxxx` (local time, 4 lowercase base36 chars); creates `.lookover/runs/<runId>/evidence/` and opens `run.jsonl`. (`EvidenceStore` comes from Task 5; implement Task 4's test with a stub type and wire the real one in Task 5's final step.)

- [ ] **Step 1: Write the failing tests** — `run-log.test.ts`: appends three events and reads them back with `seq` 1..3, ISO `at`, `runId`; reopening continues at `seq` 4; `subscribe` receives the appended event synchronously after the write resolves and the unsubscribe function stops delivery; a body containing `'jay@example.com'` is stored as `'[email]'`; 50 concurrent appends produce 50 well-formed lines (`JSON.parse` each). `run-context.test.ts`: with `now = new Date(2026, 9, 20, 12, 44, 55)` and `random = () => 'ab12'`, `runId === '20261020-124455-ab12'`; directories exist; `log.file` ends with `run.jsonl`.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @jayslifecode/lookover-core test -- run-log run-context` → FAIL.

- [ ] **Step 3: Implement the three modules** — use `fs.promises.appendFile`; keep a `tail: Promise<void>` to serialise appends.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): append-only jsonl run log and run context"`

---

### Task 5: Evidence store

**Files:**
- Create: `packages/core/src/evidence/store.ts`
- Modify: `packages/core/src/run/run-context.ts` (construct the real store)
- Test: `packages/core/test/evidence.test.ts`

**Interfaces:**
- `interface EvidenceRef { id: string; path: string; bytes: number; kind: 'png' | 'json' }` — `id` = first 16 hex chars of the sha256 of the stored bytes; `path` relative to the run dir (`evidence/<id>.png`).
- `class EvidenceStore { constructor(runDir: string); putPng(buffer: Buffer): Promise<EvidenceRef>; putJson(name: string, value: unknown): Promise<EvidenceRef>; resolve(ref: EvidenceRef): string /* absolute path */; list(): Promise<EvidenceRef[]> }` — identical PNG bytes are written once (second call returns the same ref without rewriting); JSON is `redactDeep`ed, pretty-printed, stored as `evidence/<name>-<id>.json`.

- [ ] **Step 1: Write the failing tests** — same buffer twice → same `ref.id`, one file on disk; two different buffers → two files; `putJson('page', { email: 'a@b.c' })` → file contents contain `[email]` and not `a@b.c`; `resolve(ref)` is absolute and exists; `list()` returns both kinds.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `store.ts`; replace the stub in `run-context.ts` with `new EvidenceStore(dir)`.**

- [ ] **Step 4: Run the whole core suite to verify it passes** — `pnpm --filter @jayslifecode/lookover-core test`.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): content-addressed evidence store with redaction"`

---

### Task 6: Network policy and the browser session

**Files:**
- Create: `packages/core/src/browser/network-policy.ts`, `packages/core/src/browser/session.ts`, `packages/core/src/browser/cdp.ts`, `packages/core/test/fixtures/serve.ts`
- Test: `packages/core/test/network-policy.test.ts`, `packages/core/test/session.test.ts`

**Interfaces:**
- `network-policy.ts`:
  - `const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']`; `isAllowedHost(host: string, allowHosts: string[]): boolean` — true for `LOCAL_HOSTS`, any `*.local`, exact matches in `allowHosts`, and glob `*.suffix` entries (`*.ngrok.app`).
  - `const BLOCKED_PROVIDERS: readonly string[]` — host suffixes: payments `stripe.com`, `paypal.com`, `braintreegateway.com`, `adyen.com`, `checkout.com`, `tosspayments.com`, `kakaopay.com`, `iamport.kr`, `portone.io`, `qpay.mn`, `socialpay.mn`; email `sendgrid.net`, `api.sendgrid.com`, `mailgun.net`, `postmarkapp.com`, `resend.com`, `sparkpostmail.com`, `mandrillapp.com`, `email.us-east-1.amazonaws.com` (and every `email.*.amazonaws.com`, matched by regex); SMS `twilio.com`, `nexmo.com`, `vonage.com`, `messagebird.com`, `sns.*.amazonaws.com`, `sens.apigw.ntruss.com`, `coolsms.co.kr`, `apis.aligo.in`, `solapi.com`.
  - `isBlockedProvider(host: string): boolean`.
  - `type RequestKind = 'navigation' | 'fetch' | 'subresource'`; `type Verdict = { kind: 'allow' } | { kind: 'observe'; host: string } | { kind: 'block'; reason: 'provider' | 'host-not-allowed' }`.
  - `classifyRequest(url: URL, kind: RequestKind, policy: { allowHosts: string[] }): Verdict` — navigation to a non-allowed host → block `host-not-allowed`; any request to a blocked provider not in `allowHosts` → block `provider`; fetch/subresource to an allowed host → allow; fetch/subresource elsewhere → observe (let through, report host).
- `cdp.ts`: `getAXTree(cdp: CDPSession): Promise<AXNode[]>` (enables `Accessibility`, `DOM`; `Accessibility.getFullAXTree`); `type AXNode = { nodeId: string; role: string; name: string; ignored: boolean; backendDOMNodeId?: number; properties: Record<string, unknown> }`; `boxFor(cdp, backendDOMNodeId): Promise<Box | null>` (border quad from `DOM.getBoxModel`, `null` when it throws or has zero area); `resolveBackendNode(cdp, backendDOMNodeId): Promise<string /* objectId */>`; `callOnNode<T>(cdp, objectId, fnSource: string, args?: unknown[]): Promise<T>` (`Runtime.callFunctionOn`, `returnByValue: true`).
- `session.ts`: `interface SessionOptions { headless?: boolean; viewport: Viewport; storageStatePath?: string; allowHosts: string[]; onEvent: (e: { type: 'host.observed'; host: string; kind: 'navigation' | 'app-call' } | { type: 'request.blocked'; url: string; reason: 'provider' | 'host-not-allowed' }) => void }`; `interface InstrumentedPage { page: Page; cdp: CDPSession; close(): Promise<void> }`; `class BrowserSession { static launch(opts: SessionOptions): Promise<BrowserSession>; newPage(): Promise<InstrumentedPage>; observedHosts(): string[]; close(): Promise<void> }` — enforces `classifyRequest` through `context.route('**/*')`, aborting blocked requests with `'blockedbyclient'`, and emits one `host.observed` per distinct host.
- `test/fixtures/serve.ts`: `serveFixture(dir: string): Promise<{ url: string; close(): Promise<void> }>` — a tiny `node:http` static server on an ephemeral port (used by Tasks 6–13).

- [ ] **Step 1: Write the failing tests** — `network-policy.test.ts`: `isAllowedHost` rows (`localhost` ✓, `app.local` ✓, `api.example.com` ✗, with `allowHosts: ['*.ngrok.app']` → `x.ngrok.app` ✓); `isBlockedProvider('api.stripe.com')` ✓, `'email.eu-west-1.amazonaws.com'` ✓, `'xyz.supabase.co'` ✗; `classifyRequest` rows: navigation to `https://example.com` → block host-not-allowed; fetch to `https://api.stripe.com/v1/charges` → block provider; fetch to `https://xyz.supabase.co/rest/v1/orgs` → observe `xyz.supabase.co`; fetch to `http://localhost:3000/api` → allow; fetch to `https://api.stripe.com` with `allowHosts: ['api.stripe.com']` → allow. `session.test.ts` (Playwright, real Chromium): serve a fixture page that `fetch()`es `http://127.0.0.1:<port>/ok.json` and `https://api.stripe.com/v1/x` and has a link to `https://example.com`; assert the stripe fetch failed in-page (the fixture writes `window.__results`), `onEvent` received `request.blocked` with reason `provider`, clicking the external link does not leave the fixture origin and emits `request.blocked` `host-not-allowed`, `observedHosts()` lists `127.0.0.1`; `getAXTree` returns a node with role `button` and name `Save` for `<button>Save</button>`; `boxFor` returns a positive-area box for it.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @jayslifecode/lookover-core test -- network-policy session`.

- [ ] **Step 3: Implement the modules** — `BrowserSession.launch` uses `chromium.launch({ headless })` and `browser.newContext({ viewport, storageState })`; create the CDP session with `context.newCDPSession(page)`.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): network policy and instrumented browser session"`

---

### Task 7: App Map types and Next.js route discovery

**Files:**
- Create: `packages/core/src/map/types.ts`, `packages/core/src/map/next-routes.ts`
- Test: `packages/core/test/next-routes.test.ts`

**Interfaces:**
- `types.ts`:
  - `interface Viewport { name: string; width: number; height: number }`
  - `interface Box { x: number; y: number; width: number; height: number }`
  - `interface RouteInfo { pattern: string; source: 'filesystem' | 'link'; file?: string }` — pattern keeps Next syntax (`/organisations/[id]`, `/docs/[...slug]`).
  - `interface ElementRef { selector: string; role: string; name: string; tag: string; box: Box; backendNodeId: number; disabled: boolean; focusable: boolean }`
  - `interface FieldInfo { selector: string; name: string | null; label: string | null; labelSource: 'label' | 'aria-label' | 'aria-labelledby' | 'placeholder' | null; type: string; required: boolean; pattern: string | null; minLength: number | null; maxLength: number | null; min: string | null; max: string | null; inputMode: string | null }`
  - `interface FormInfo { selector: string; action: string | null; method: string; fields: FieldInfo[]; submit: ElementRef | null }`
  - `type TokenProperty = 'color' | 'background-color' | 'font-size' | 'font-family' | 'border-radius' | 'padding' | 'margin'`; `interface TokenSample { property: TokenProperty; value: string; count: number }`
  - `interface Screen { id: string; url: string; route: string; title: string; viewport: Viewport; screenshot: EvidenceRef; elements: ElementRef[]; forms: FormInfo[]; tokens: TokenSample[]; links: string[]; discoveredFrom: string | null; capturedAt: string }`
  - `interface AppMap { version: 1; runId: string; createdAt: string; baseUrl: string; routes: RouteInfo[]; screens: Screen[] }`
- `next-routes.ts`: `discoverNextRoutes(root: string): Promise<RouteInfo[]>` — scans `app/` or `src/app/` for `page.{tsx,ts,jsx,js,mdx}`: strips route groups `(name)`, parallel slots `@name`, skips `_folders` and `api/`; scans `pages/` or `src/pages/` for page files: skips `_app`, `_document`, `_error`, `api/`, maps `index` to the directory; returns sorted, deduplicated, `source: 'filesystem'`, `file` relative to root. Returns `[]` when neither directory exists. `matchRoute(pathname: string, routes: RouteInfo[]): RouteInfo | null` — static patterns first, then dynamic (`[x]` → `[^/]+`, `[...x]` → `.+`, `[[...x]]` → `(?:/.*)?`); `routePatternFromPath(pathname: string): string` — fallback that replaces numeric, UUID and 20+-char base64url segments with `[param]`.

- [ ] **Step 1: Write the failing tests** — build a tree in a temp dir: `app/page.tsx`, `app/(marketing)/pricing/page.tsx`, `app/organisations/page.tsx`, `app/organisations/[id]/page.tsx`, `app/organisations/[id]/@modal/page.tsx`, `app/_private/page.tsx`, `app/api/route.ts`, `app/docs/[...slug]/page.mdx`; expect exactly `['/', '/docs/[...slug]', '/organisations', '/organisations/[id]', '/pricing']`. A second tree with `pages/index.tsx`, `pages/about.tsx`, `pages/_app.tsx`, `pages/api/x.ts`, `pages/blog/[slug].tsx` → `['/', '/about', '/blog/[slug]']`. `matchRoute('/organisations/42', routes).pattern === '/organisations/[id]'`, `matchRoute('/organisations', …) === '/organisations'`, `matchRoute('/docs/a/b', …) === '/docs/[...slug]'`, `matchRoute('/nope', …) === null`. `routePatternFromPath('/orders/550e8400-e29b-41d4-a716-446655440000/items/12') === '/orders/[param]/items/[param]'`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement both modules** (recursive `fs.readdir` with `withFileTypes`; no globbing dependency).

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): app map types and next.js route discovery"`

---

### Task 8: Selector builder and element extraction from the accessibility tree

**Files:**
- Create: `packages/core/src/map/selectors.ts`, `packages/core/src/map/elements.ts`, `packages/core/test/fixtures/elements/index.html`, `packages/core/test/fixtures/elements/grid.html`
- Test: `packages/core/test/elements.test.ts`

**Interfaces:**
- `selectors.ts`: `const BUILD_SELECTOR_SOURCE: string` — the source of an in-page function `(el: Element) => string` that returns the first **unique** selector (`document.querySelectorAll(sel).length === 1`) from: `[data-testid="…"]` → `#id` (unless the id matches `/^(:r|radix-|headlessui-|mui-|react-aria)/` or is digits only) → `tag[name="…"]` → `tag[aria-label="…"]` → `a[href="…"]` → a `tag:nth-of-type(n)` path up to the nearest ancestor with a `data-testid`/stable `id` or `body`. Exported as a string so it runs through CDP `Runtime.callFunctionOn` and in `page.evaluate` alike.
- `elements.ts`: `const INTERACTIVE_ROLES: ReadonlySet<string>` = button, link, textbox, searchbox, checkbox, radio, combobox, listbox, option, menuitem, menuitemcheckbox, menuitemradio, slider, spinbutton, switch, tab; `const MAX_ELEMENTS_PER_SCREEN = 500`; `extractElements(ipage: InstrumentedPage): Promise<{ elements: ElementRef[]; total: number }>` — walks `getAXTree`, keeps non-ignored nodes whose role is interactive, resolves each `backendDOMNodeId`, builds the selector with `BUILD_SELECTOR_SOURCE`, measures `boxFor`, drops nodes without a box, reads `disabled`/`focusable` from AX properties, stops after `MAX_ELEMENTS_PER_SCREEN` (returns `total` so the caller can emit `screen.truncated`).

- [ ] **Step 1: Write the fixtures and the failing tests** — `index.html`: a `<button data-testid="save">Save</button>`, `<button id=":r1:">Generated id</button>` (must fall back to a path selector), `<a href="/orgs">Organisations</a>`, `<label for="phone">Phone</label><input id="phone" name="phone">`, a `<div role="button" tabindex="0">Custom</div>`, a hidden `<button hidden>Nope</button>`, a `<button disabled>Off</button>`. Tests: selectors are `[data-testid="save"]`, `#phone`, `a[href="/orgs"]`; the generated-id button's selector does not contain `:r1:` and resolves to exactly one element (`page.locator(sel).count() === 1`); every returned selector resolves to exactly one element; the hidden button is absent; `Off` has `disabled: true`; roles and names match (`Custom` → role `button`); boxes have positive size. `grid.html` renders 1,200 buttons via inline script: `elements.length === 500`, `total === 1200`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement both modules.**

- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @jayslifecode/lookover-core test -- elements`.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): interactive element extraction via the cdp accessibility tree"`

---

### Task 9: Forms and fields

**Files:**
- Create: `packages/core/src/map/forms.ts`, `packages/core/test/fixtures/forms/index.html`
- Test: `packages/core/test/forms.test.ts`

**Interfaces:**
- `extractForms(ipage: InstrumentedPage): Promise<FormInfo[]>` — one `FormInfo` per `<form>` plus, when any field lives outside a form, one virtual form with `selector: 'body'`, `action: null`, `method: 'none'`. Fields are `input` (except `hidden`, `submit`, `button`, `reset`, `image`), `select`, `textarea`, and elements with `role="textbox"|"combobox"`. Label resolution order: `<label for>` / wrapping `<label>` → `aria-label` → `aria-labelledby` → `placeholder`, recorded in `labelSource`; `null` when none. Attributes copied verbatim (`pattern`, `minlength`, `maxlength`, `min`, `max`, `inputmode`, `required`). `submit` is the `ElementRef` of the first `button[type=submit]`, `input[type=submit]` or `button` without `type` inside the form (selector via `BUILD_SELECTOR_SOURCE`, box via `getBoundingClientRect` in-page), else `null`.

- [ ] **Step 1: Write the fixture and failing tests** — a form with phone (`<label for>`, `required`, `pattern="\d{8}"`, `maxlength="8"`, `inputmode="numeric"`), email (`aria-label`), date (`type="date"`, `min`, `max`), a select with a wrapping label, a textarea with only a placeholder, a submit button; one stray `<input name="search">` outside any form. Assert field count, each label and `labelSource`, the attributes above, `submit.name === 'Save'`, the virtual form exists with one field and `method: 'none'`.

- [ ] **Step 2: Run to verify it fails.** · **Step 3: Implement.** · **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): form and field extraction"`

---

### Task 10: Rendered design tokens

**Files:**
- Create: `packages/core/src/map/tokens.ts`, `packages/core/test/fixtures/tokens/index.html`
- Test: `packages/core/test/tokens.test.ts`

**Interfaces:**
- `collectTokens(page: Page): Promise<TokenSample[]>` — in-page walk of at most 5,000 elements with a non-empty border box and `visibility !== 'hidden'`; samples `getComputedStyle` for each `TokenProperty`: `color` and `background-color` (skip `rgba(0, 0, 0, 0)` / `transparent`), `font-size`, `font-family` (first family only, quotes stripped), `border-radius` (skip `0px`), `padding` and `margin` (skip `0px`); counts identical values; returns at most 60 samples per property, sorted by `count` descending then value.

- [ ] **Step 1: Write the fixture and failing tests** — 20 elements with `color: rgb(47, 107, 224)`, 2 with `rgb(45, 102, 214)`, 3 font sizes, radii `6px` ×5 and `8px` ×1, one hidden element with a unique colour. Assert the two blues with counts 20 and 2 in that order, the hidden colour absent, `0px` radii absent, `font-family` values carry no quotes.

- [ ] **Step 2: Run to verify it fails.** · **Step 3: Implement.** · **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): rendered design token sampling"`

---

### Task 11: The crawler

**Files:**
- Create: `packages/core/src/map/crawler.ts`, `packages/core/test/fixtures/site/` (`index.html`, `orgs.html`, `org.html?id=…` served by a small dynamic handler in `serve.ts`, `logout.html`, `sse.html`)
- Modify: `packages/core/test/fixtures/serve.ts` (route `/orgs/:id` to `org.html`, `/events` as a never-ending SSE stream, `/logout` sets a flag)
- Test: `packages/core/test/crawler.test.ts`

**Interfaces:**
- `const DESTRUCTIVE_LINK_PATTERN = /(^|\/)(logout|log-out|signout|sign-out|delete|remove|destroy|reset)(\/|$|\?)|[?&](action|op)=(delete|remove|destroy)/i`
- `interface CrawlOptions { baseUrl: string; seeds: string[]; routes: RouteInfo[]; maxScreens: number; maxPerRoute: number; viewport: Viewport; settleMs?: number /* default 800 */; navigationTimeoutMs?: number /* default 15000 */ }`
- `crawl(session: BrowserSession, ctx: RunContext, opts: CrawlOptions): Promise<Screen[]>` — BFS from `seeds` (each resolved against `baseUrl`); dedupes by `routeKey`; per URL: `screen.discovered` → `page.goto(url, { waitUntil: 'load', timeout })`, then wait up to `settleMs` for network quiet (`page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => {})`), `await page.evaluate(() => document.fonts.ready)`; capture `title`, full-page PNG into `ctx.evidence`, `extractElements`, `extractForms`, `collectTokens`, same-app links (`normaliseUrl` + `isSameApp`, junk dropped); enqueue new links unless `DESTRUCTIVE_LINK_PATTERN` (→ `screen.skipped destructive-link`), route pattern already seen `maxPerRoute` times (→ `route-cap`), or the screen budget is spent (→ `max-screens`); `route` = `matchRoute(pathname, routes)?.pattern ?? routePatternFromPath(pathname)`; `id` = `shortId(route + '|' + routeKey + '|' + viewport.name, 10)`; emits `screen.captured` with the full `Screen` and `screen.truncated` when `total > elements.length`. One page is reused for the whole crawl; a navigation error logs `screen.skipped` with reason `not-same-app`… no: a navigation error is a captured screen with `title: '(navigation failed: <message>)'`, zero elements and no screenshot — the lenses must see dead links later. (Decision: the `Screen.screenshot` type becomes `EvidenceRef | null`; update `types.ts`.)

- [ ] **Step 1: Write the fixtures and failing tests** — `index.html` links to `/orgs.html`, `/orgs.html#top`, `mailto:x@y.z`, `https://example.com`, `/logout`, `/sse.html`; `orgs.html` links to `/orgs/1` … `/orgs/6`; `sse.html` opens `new EventSource('/events')`. Tests: screens captured for `/`, `/orgs.html`, `/sse.html`, exactly two `/orgs/<id>` instances and four `screen.skipped route-cap` events; `/logout` never requested (server flag false) and one `screen.skipped destructive-link`; `/sse.html` captured in under 5 s (timer around the crawl of that single seed with `settleMs: 800`); with `maxScreens: 2` exactly two `screen.captured` and the rest `max-screens`; `routeKey` dedupe means `/orgs.html#top` does not create a second screen; with `baseUrl` `http://127.0.0.1:<port>/sub/` links outside `/sub/` are skipped (`not-same-app`); every captured screen has a `screenshot` ref whose file exists.

- [ ] **Step 2: Run to verify they fail.** · **Step 3: Implement `crawler.ts`** (queue of `{ url, from, depth }`; `seenRouteKeys: Set`, `perRoute: Map<string, number>`). · **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): bounded same-app crawler with destructive-link and route caps"`

---

### Task 12: App Map persistence and diff

**Files:**
- Create: `packages/core/src/map/persist.ts`
- Test: `packages/core/test/persist.test.ts`

**Interfaces:**
- `writeAppMap(ctx: RunContext, map: AppMap): Promise<{ runPath: string; latestPath: string }>` — writes `.lookover/runs/<runId>/app-map.json` and copies it to `.lookover/app-map.json`.
- `readLatestAppMap(lookoverDir: string): Promise<AppMap | null>`.
- `interface AppMapDiff { addedScreens: string[]; removedScreens: string[]; changedScreens: { screenId: string; addedElements: string[]; removedElements: string[] }[] }`; `diffAppMaps(prev: AppMap, next: AppMap): AppMapDiff` — screens keyed by `route + '|' + viewport.name`, elements by `selector`.

- [ ] **Step 1: Write the failing tests** — write then read back equals the input; `readLatestAppMap` on an empty dir → `null`; diff of two hand-built maps reports one added screen, one removed, one changed with the right selectors.
- [ ] **Step 2: Run to verify they fail.** · **Step 3: Implement.** · **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(core): persist and diff app maps"`

---

### Task 13: Authentication (storage state and form login)

**Files:**
- Create: `packages/core/src/browser/auth.ts`, `packages/core/test/fixtures/login/` (`login.html`, `home.html`; `serve.ts` gains a cookie check: `/home.html` returns 302 → `/login.html` without the `session` cookie, and `POST /login` sets it when `user=demo&pass=demo-password`)
- Test: `packages/core/test/auth.test.ts`

**Interfaces:**
- `ensureAuth(session: BrowserSession, auth: LookoverConfig['auth'], opts: { baseUrl: string; stateDir: string; env?: NodeJS.ProcessEnv }): Promise<{ method: 'none' | 'storageState' | 'form'; statePath?: string }>` — `none`: no-op; `storageState`: validates the file exists (else `E_AUTH_FAILED` with hint); `form`: opens a page, `goto(loginUrl)` resolved against `baseUrl`, fills `usernameSelector`/`passwordSelector` from `env[usernameEnv]`/`env[passwordEnv]` (missing → `E_AUTH_FAILED`, hint names the variable), clicks `submitSelector`, `waitForURL(successUrl glob, { timeout: 15000 })` (timeout → `E_AUTH_FAILED` "still on the login page"), saves `context.storageState` to `<stateDir>/form.json`, returns its path. The engine (Task 14) relaunches the session with that `storageStatePath`.
- `isLoginUrl(url: URL, auth: LookoverConfig['auth'], baseUrl: string): boolean` — true for form auth when `url.pathname` equals the login path; used by the crawler's caller to detect a lost session (Task 14).

- [ ] **Step 1: Write the fixtures and failing tests** — form login with `env = { LOOKOVER_USERNAME: 'demo', LOOKOVER_PASSWORD: 'demo-password' }` resolves with a `statePath` whose JSON contains a cookie named `session`; a new `BrowserSession` launched with that `storageStatePath` can `goto('/home.html')` without being redirected; wrong password → `E_AUTH_FAILED`; missing env var → `E_AUTH_FAILED` with hint containing `LOOKOVER_PASSWORD`; `storageState` type with a missing file → `E_AUTH_FAILED`.

- [ ] **Step 2: Run to verify they fail.** · **Step 3: Implement.** · **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): storage-state and form-login authentication"`

---

### Task 14: The discovery engine

**Files:**
- Create: `packages/core/src/run/engine.ts`
- Modify: `packages/core/src/index.ts` (export everything a CLI needs)
- Test: `packages/core/test/engine.test.ts`

**Interfaces:**
- `interface DiscoveryHooks { confirmHosts?: (hosts: string[]) => Promise<string[]> /* returns the confirmed subset */; onEvent?: (e: RunEvent) => void }`
- `interface DiscoveryOptions { cwd: string; headless?: boolean; env?: NodeJS.ProcessEnv; hooks?: DiscoveryHooks }`
- `runDiscovery(ctx: RunContext, opts: DiscoveryOptions): Promise<{ map: AppMap; confirmedBackendHosts: string[] }>`:
  1. `run.started`; `discoverNextRoutes(path.resolve(cwd, config.root))` when `framework === 'next'` → `route.discovered` each.
  2. Launch a session (desktop viewport = `config.viewports[0]`), `ensureAuth` → `auth.completed`; relaunch with the storage state when one was produced.
  3. **Probe:** visit `baseUrl` and the first filesystem route that is not the login route; collect `session.observedHosts()` minus allowed hosts. Hosts not in `config.confirmedBackendHosts` go to `hooks.confirmHosts`; without a hook, or if any host is left unconfirmed, throw `E_HOSTS_UNCONFIRMED` (message lists the hosts; hint: `lookover run --confirm-host <host>`). Confirmed hosts are returned so the CLI can persist them.
  4. `crawl` with seeds = `['/']` + static filesystem routes (dynamic patterns are reached through links). If a captured screen's URL `isLoginUrl` while its seed was not the login route → `auth.lost`, `ensureAuth` again once, relaunch, re-crawl that URL; a second loss → `E_AUTH_FAILED`.
  5. Build `AppMap`, `writeAppMap`, `run.finished` (or `run.failed` with the error code and rethrow). The session is always closed.

- [ ] **Step 1: Write the failing tests** (against the login fixture from Task 13 extended with one page that `fetch`es `https://xyz.supabase.co/rest/v1/x`, which the test intercepts at the network level by allowing it to fail — only the host observation matters): without a `confirmHosts` hook → rejects `E_HOSTS_UNCONFIRMED` and the run log ends with `run.failed`; with a hook that confirms `xyz.supabase.co` → resolves, `confirmedBackendHosts` contains it, `app-map.json` exists with ≥ 3 screens, the log contains `run.started`, `auth.completed { method: 'form' }`, `route.discovered`s are absent (no Next root) and `run.finished`; a session that is cleared server-side after the second page (fixture flag) produces exactly one `auth.lost` followed by `auth.completed`.

- [ ] **Step 2: Run to verify they fail.** · **Step 3: Implement `engine.ts`.** · **Step 4: Run the full core suite.**

- [ ] **Step 5: Commit** — `git commit -m "feat(core): discovery engine with host confirmation and session recovery"`

---

### Task 15: Bench app skeleton

**Files:**
- Create: `bench/app/` — Next.js 16 App Router, TypeScript, Tailwind v4: `app/layout.tsx`, `app/login/page.tsx` (+ `app/login/actions.ts` server action), `app/page.tsx` (dashboard), `app/organisations/page.tsx`, `app/organisations/[id]/page.tsx` (edit form: name, phone, email, registered date, save/cancel), `app/organisations/new/page.tsx`, `app/settings/page.tsx`, `app/reports/page.tsx` (opens a dialog), `app/logout/route.ts`, `middleware.ts` (redirects to `/login` without the `bench_session` cookie), `lib/store.ts` (JSON file store under `bench/app/data/`, seeded from `bench/app/data/seed/organisations.json` with 12 organisations), `package.json` (`name: "@jayslifecode/lookover-bench"`, scripts `dev: next dev -p 3123`, `build`, `start -p 3123`, `reset`), `next.config.ts`, `postcss.config.mjs`, `app/globals.css`
- Create: `bench/seeds.json`, `bench/scripts/reset.ts`, `bench/README.md`
- Test: `bench/app/test/store.test.ts`

**Interfaces:**
- Credentials: `BENCH_USER` (default `demo@lookover.dev`) and `BENCH_PASSWORD` (default `demo-password`), read on the server; the login form fields are `input[name="email"]`, `input[name="password"]`, `button[type="submit"]`; success redirects to `/`.
- `bench/seeds.json`: `{ "version": 1, "app": "bench/app", "issues": [] }`; each future entry: `{ id: string; lens: 'interaction' | 'consistency' | 'behaviour'; route: string; selector?: string; rule: string; expectedSeverity: 'blocker' | 'high' | 'medium' | 'low'; control?: boolean }` — documented in `bench/README.md` so plans 02 and 04 only add entries.
- `lib/store.ts`: `listOrganisations()`, `getOrganisation(id)`, `saveOrganisation(org)`, `resetStore()`; `bench/scripts/reset.ts` calls `resetStore()`.

- [ ] **Step 1: Write the failing store test** — `resetStore()` then `listOrganisations()` has 12 entries; `saveOrganisation({ ...first, name: 'X' })` persists and `resetStore()` restores the seed.
- [ ] **Step 2: Scaffold the app** (`pnpm create next-app@latest` is not used — write the files so the structure is known: App Router only, `src/` not used). Clean, plain UI: this app receives its seeded bugs in plans 02 and 04, so build it correct first (visible focus styles, one date format, labelled fields).
- [ ] **Step 3: Run the store test and the app** — `pnpm --filter @jayslifecode/lookover-bench test` passes; `pnpm --filter @jayslifecode/lookover-bench dev` serves `/login`; logging in with the defaults lands on `/`; `/organisations/1` shows the edit form; `/logout` clears the cookie.
- [ ] **Step 4: Commit** — `git commit -m "feat(bench): next.js sample app skeleton with form login and json store"`

---

### Task 16: CLI `init`

**Files:**
- Create: `packages/cli/src/ui.ts`, `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/init.test.ts`

**Interfaces:**
- `lookover init [--non-interactive] [--base-url <url>] [--root <dir>] [--interaction full|safe] [--acknowledge-disposable-data] [--framework next|vite-react|unknown]` — interactive mode uses `@clack/prompts`: base URL (default `http://localhost:3000`), framework (auto-detected: `next` when `package.json` in `root` depends on `next`, `vite-react` when on `vite` and `react`), then the acknowledgement prompt with this exact copy:
  > **Lookover will click anything and submit any form in this app, including actions that delete or change data.**
  > Is every piece of data this app can reach disposable — a local or development database you can recreate?
  `Yes` → `interaction: 'full'` + `acknowledgement: { disposableData: true, acknowledgedAt: now, by: os.userInfo().username }`; `No` → `interaction: 'safe'` and a one-line note that safe mode never submits forms. Then optional form-login setup (login URL, three selectors, success URL; prints the two env var names it will read). Writes `lookover.config.json` via `writeConfig`, appends `.lookover/` to `.gitignore` (creates it if missing, no duplicate line), prints next steps. Non-interactive mode requires `--base-url`; `--interaction full` without `--acknowledge-disposable-data` exits with code 3 and the `E_ACK_REQUIRED` message. Exit codes: 0 ok, 2 invalid flags, 3 refused.
- `ui.ts`: `info()`, `success()`, `warn()`, `fail(err: unknown): never` (prints `code`, message and hint for `LookoverError`, maps codes to exit codes: `E_CONFIG_*` → 2, `E_ACK_REQUIRED`/`E_HOSTS_UNCONFIRMED` → 3, else 1), `table(rows)`.

- [ ] **Step 1: Write the failing tests** (spawn `node dist/index.js` after `pnpm --filter @jayslifecode/lookover-cli build`, cwd = temp dir with a `package.json` depending on `next`): non-interactive full + acknowledge → config has `interaction: 'full'`, `acknowledgement.disposableData === true`, `framework: 'next'`, `.gitignore` contains `.lookover/`; non-interactive full without the flag → exit 3, stderr contains `E_ACK_REQUIRED`; `--interaction safe` → config without `acknowledgement`; running twice does not duplicate the `.gitignore` line.
- [ ] **Step 2: Run to verify they fail.** · **Step 3: Implement.** · **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): init with the disposable-data acknowledgement"`

---

### Task 17: CLI `run` and the bench end-to-end test

**Files:**
- Create: `packages/cli/src/commands/run.ts`, `packages/cli/vitest.e2e.config.ts`, `packages/cli/test/e2e/bench.test.ts`, `packages/cli/test/e2e/global-setup.ts`
- Modify: `packages/cli/src/index.ts`, `README.md` (getting started), `.github/workflows/ci.yml` (create)

**Interfaces:**
- `lookover run [--headed] [--max-screens <n>] [--allow-host <host>...] [--confirm-host <host>...] [--yes]` — `loadConfig(cwd)` (errors → `ui.fail`), merges `--allow-host` into `allowHosts` for this run, `createRun`, `runDiscovery` with `hooks.confirmHosts`: interactive → a clack multiselect pre-filled with all hosts titled "These backends were called by the app. Confirm each one is a development or disposable instance"; non-interactive (`--yes` or no TTY) → the subset given by `--confirm-host`; confirmed hosts are written back into `lookover.config.json` (`confirmedBackendHosts`, deduplicated). Prints progress lines from `onEvent` (one per `screen.captured`: `✓ /organisations/[id]  18 elements · 1 form`), then a summary table: screens, elements, forms, backend hosts, blocked requests, run dir, `app-map.json` path, duration. Exit codes as in `ui.fail`.
- `test/e2e/global-setup.ts`: runs `bench/scripts/reset.ts`, starts `pnpm --filter @jayslifecode/lookover-bench dev` (port 3123) and waits for `GET /login` to return 200 (60 s), tears it down after the suite.
- `bench.test.ts`: in a temp project dir, `lookover init --non-interactive --base-url http://localhost:3123 --root <abs path to bench/app> --interaction full --acknowledge-disposable-data`; patches the config with form auth (`loginUrl: '/login'`, `usernameSelector: 'input[name="email"]'`, `passwordSelector: 'input[name="password"]'`, `submitSelector: 'button[type="submit"]'`, `successUrl: 'http://localhost:3123/'`); runs `lookover run --yes --max-screens 12` with `LOOKOVER_USERNAME=demo@lookover.dev LOOKOVER_PASSWORD=demo-password`; asserts exit 0; `app-map.json` has routes including `/organisations/[id]` from the filesystem, ≥ 6 screens, a screen whose `route === '/organisations/[id]'` with a form of 4 fields whose phone field has `label === 'Phone'`, no screen whose URL ends with `/login` except the login route itself, `/logout` absent, and the log ends with `run.finished`; the run takes under 90 s.
- `ci.yml`: Node 24, pnpm 10, `pnpm install`, `pnpm exec playwright install --with-deps chromium`, `pnpm check`, `pnpm test:e2e`.

- [ ] **Step 1: Write the e2e test and global setup** (it fails: no `run` command).
- [ ] **Step 2: Implement `run.ts`, wire `index.ts`.**
- [ ] **Step 3: Run `pnpm check` then `pnpm test:e2e`** — expected: all unit suites green; e2e passes in under 90 s.
- [ ] **Step 4: README getting started** — the 60-second path: `pnpm dlx @jayslifecode/lookover init`, `lookover run`, what `.lookover/app-map.json` contains, and a clear "v0 in progress: the lenses, judge and report arrive in the next plans" line. Keep the spec's section 8 order for later sections.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): run command, bench end-to-end test and ci"`

---

## Self-review notes

- **Spec coverage (plan scope):** §3 stack ✓ (T1); interaction policy + acknowledgement ✓ (T2, T16); safety envelope: allowlist + provider blocklist + host confirmation ✓ (T6, T14, T17), secret redaction ✓ (T3–T5), credentials from env ✓ (T2, T13); auth v0 storage state + form ✓ (T13); §4 Stage 1 routes + screens + elements + forms + tokens + persisted map + diff ✓ (T7–T12); §6 `core`, `cli`, `bench/` ✓; §9 build order step "crawl and map" ✓. Deferred by design to plans 02–04: the lenses, observers, judge, replay, report, Claude Code plugin, benchmark numbers, full docs set, `safe` mode's destructive word list (the config value exists; enforcement belongs to the explorer in plan 02), viewport sweep (crawl is desktop-only here; mobile screens are captured by the interaction lens).
- **Type consistency:** `Screen.screenshot` is `EvidenceRef | null` (T11 note) — T7 must declare it that way from the start; `InstrumentedPage` is consumed by T8/T9/T11; `RunEventBody.screen.captured` carries the full `Screen`; `ensureAuth` returns `{ method, statePath? }` and T14 relaunches with it.
- **Review Focus → tests:** 1 → T11 (`/sse.html` under 5 s); 2 → T11 (`/logout` never requested); 3 → T11 (route cap); 4 → T8 (1,200 buttons → 500); 5 → T3 + T11 (junk links, base path).
- **Proportion:** ~17 tasks for one pipeline stage plus the bench skeleton; code blocks are tests and signatures only.
