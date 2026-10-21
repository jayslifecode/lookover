# Lookover

Lookover is an open-source design-and-QA reviewer that drives a web app in a real browser the way a senior front-end reviewer would, and reports what it can prove. It is built for people who came to coding through AI tools and ship real sites without anyone experienced checking their work.

**Status: v0 in progress — the interaction lens and observers report candidate findings; the judge, replay and report arrive next.** Today Lookover maps your app, opening every screen it can reach in a real browser and recording what is on each one in `.lookover/app-map.json`, and inspects each screen as it goes: how its controls look when hovered and focused, whether a keyboard can reach them, whether their text can be read and they are big enough to tap, whether the page fits a phone, and what the console, the network and the page's text give away. What it finds goes to `.lookover/findings.json` as **candidates**: measured, but not yet judged or reproduced. The plans are in [docs/superpowers/plans](docs/superpowers/plans); [how a run works](docs/how-it-works.md) describes the pipeline as built.

## Getting started

You need Node 22.12 or later and your app running locally. Next.js apps get their routes read from the filesystem as well; other apps are mapped by following links.

```sh
cd your-app
pnpm add -D @jayslifecode/lookover
pnpm lookover init   # a few questions; writes lookover.config.json and ignores .lookover/
pnpm lookover run    # opens and inspects each screen in Chromium; writes .lookover/app-map.json and findings.json
```

To try it once without adding a dependency: `pnpm dlx @jayslifecode/lookover init`, then `pnpm dlx @jayslifecode/lookover run`.

Lookover drives Chromium through Playwright. If Playwright's Chromium is not on your machine yet, install it once with `pnpm dlx playwright@1.64.1 install chromium`.

> **Not on npm yet.** Until the first release, build Lookover from a clone of this repository and use
> `node <clone>/packages/cli/dist/index.js` wherever this page says `pnpm lookover` or `lookover`:
>
> ```sh
> pnpm install
> pnpm --filter "./packages/**" build
> pnpm --filter @jayslifecode/lookover-core exec playwright install chromium
> ```

`init` asks for the URL your app runs at, its framework, whether every piece of data the app can reach is disposable, and how to log in. Only a "yes" to the disposable-data question unlocks **full** interaction (Lookover may click anything and submit any form); otherwise the config says **safe**. In scripts, pass the answers as flags: `pnpm lookover init --non-interactive --base-url http://localhost:3000`, adding `--interaction full --acknowledge-disposable-data` only when the data really is disposable.

A form login reads its credentials from `LOOKOVER_USERNAME` and `LOOKOVER_PASSWORD`; the config stores only the names of those variables, never the values.

To use a session you saved with Playwright instead, set `"auth": { "type": "storageState", "path": "state.json", "loginUrl": "/login" }` in `lookover.config.json`. A saved session cannot log in again, so if the app ends it during a run, Lookover stops with `E_AUTH_FAILED` and asks you to save it again. It can only tell from `loginUrl`: without it, a lost session goes unnoticed. The login page is mapped once, under its own URL (the screen it was reached from is recorded as `redirectedFrom`), and every later screen that redirects to it is skipped as a duplicate; a login URL that differs by query each time is mapped at most as often as one dynamic route is (two by default).

`lookover run` prints a line per screen, a summary, and the candidates it found, one line per rule. Against the seeded bench app in this repository (`lookover run --max-screens 12`):

```text
Mapping http://localhost:3123 (run 20261022-054037-bayi)
✓ /  12 elements · 0 forms · 3 candidates
✓ /login  9 elements · 1 form · 0 candidates
✓ /organisations  43 elements · 0 forms · 25 candidates
✓ /organisations/new  12 elements · 1 form · 0 candidates
✓ /reports  8 elements · 0 forms · 2 candidates
✓ /settings  10 elements · 1 form · 3 candidates
✓ /organisations/[id]  12 elements · 1 form · 1 candidate
✓ /organisations/[id]  12 elements · 1 form · 1 candidate

  Screens           8
  Elements          118
  Forms             5
  Backend hosts     none
  Blocked requests  0
  Run dir           .lookover/runs/20261022-054037-bayi
  App map           .lookover/app-map.json
  Duration          17.0 s
  Candidates        34
  Worth a look      0
  Skipped           dev-overlay 2 · text-colour-uncertain:descendant 2
  Findings          .lookover/findings.json

  high    interaction.keyboard-unreachable    2  / button "Organisations 12"
  high    interaction.focus-visible-missing   1  /settings button "Save"
  high    interaction.horizontal-overflow     1  5 occurrences on 1 screen
  high    interaction.text-contrast-fail      1  /reports button "Export CSV"
  high    observers.raw-value                 1  2 occurrences on 2 screens
  high    observers.request-server-error      1  1 occurrence on 1 screen
  medium  interaction.target-size            24  /organisations link "Edit Northwind Logistics"
  medium  observers.console-error             1  1 occurrence on 1 screen
  medium  observers.raw-i18n-key              1  1 occurrence on 1 screen
  low     interaction.positive-tabindex       1  1 occurrence on 1 screen

Candidates are measured but not yet judged or reproduced; the judge arrives in the next release.
```

Each candidate line gives the severity, the rule, how many candidates there are, and where to look first. The `Skipped` row names the reasons the lenses most often left a measurement out for, with how many times (the full tally is `skipped` in `.lookover/findings.json`): a skip is a measurement that could not be trusted or was not reached, never a finding. The bench's issues are seeded on purpose (they are listed in [bench/README.md](bench/README.md)); the 24 target-size candidates are the Edit and Copy email icons in the twelve rows of one table. Every candidate is in `.lookover/findings.json` with what was expected and measured, its evidence, and a fix prompt to paste into your coding agent ([the finding contract](docs/findings.md)).

| Flag                    | What it does                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `--headed`              | Shows the browser window.                                                                            |
| `--max-screens <n>`     | Captures at most `n` screens this run, instead of `maxScreens` from the config (default 40).         |
| `--allow-host <host>`   | Lets the browser load this host without asking, for this run only (CDNs, fonts). Repeatable.         |
| `--confirm-host <host>` | Confirms a backend as a development or disposable instance and saves it to the config. Repeatable.   |
| `--yes`                 | Never prompts. A backend that is not confirmed stops the run instead.                                |
| `--map-only`            | Only maps the app: runs no lens and no observer, so there are no candidates.                         |
| `--lens <name>`         | Inspects each screen with this lens (repeatable). Today the only lens is `interaction`, the default. |

Each host flag takes one host: repeat it for more (`--confirm-host a.dev.test --confirm-host b.dev.test`), since a comma-separated list is refused.

Exit codes: `0` done, `1` the run failed, `2` the config or a flag is invalid, `3` refused (the disposable-data acknowledgement is missing, or a backend is not confirmed).

### What `.lookover/app-map.json` contains

- **`routes`**: every route pattern, in Next.js syntax (`/organisations/[id]`), from the filesystem or from links.
- **`screens`**: one per page visited (at the first viewport in the config, and by default at most two instances of one dynamic route), each with its URL, route pattern (matched on the path below the app's base path), title, whether it loaded (`status` is `captured`, or `navigation-failed` with the reason in `error` and nothing else captured), a screenshot, the interactive elements (role, accessible name, a selector, position, whether it is disabled or focusable), the forms (each field's label and where the label came from, type, required, pattern and length limits, and the submit button), the design tokens it renders (colours, font sizes and families, radii, spacing, with how often each appears) and the links to other screens of the app. When the app redirects a page to another screen of itself, the screen is recorded once, under the URL it landed on, and `redirectedFrom` holds the URL that was asked for (it is `null` otherwise). A selector is one that finds the element in the live page and that redaction leaves unchanged.

`.lookover/app-map.json` and `.lookover/findings.json` are always the latest run's. Each run also keeps its own copies, an append-only event log (`run.jsonl`) and its screenshots and other evidence under `.lookover/runs/<run id>/`. Values that look like secrets are redacted in the map, the findings, the evidence and the log, and nothing in `.lookover/` leaves your machine.

### Backends and other hosts

The browser only opens your app: `localhost`, `127.0.0.1`, `::1`, any `*.local` or `*.localhost` name, and the hosts in `allowHosts`. Requests to payment, email and SMS providers are blocked unless you add them to `allowHosts`. Any other host the app itself calls (a hosted database, an auth service, an API) is treated as a backend. Before logging in, Lookover opens a few pages without submitting anything; the app's own requests from those pages do reach its backends, which is how Lookover learns what they are. It then lists those backends, none of them selected, and asks you to select each one that is a development or disposable instance; pressing Enter without selecting confirms nothing. The run does not go on until every backend on the list is confirmed, and from then on every request to a backend that is not confirmed is blocked; one first called later in the run is listed at the end.

- **Confirming backends.** Answer the prompt, or pass `--confirm-host <host>` (once per host) to confirm them from the start, which is what `--yes` and CI need. Confirmed hosts are saved to `confirmedBackendHosts` in `lookover.config.json`, so later runs do not ask again; you can also edit that list by hand.
- **CDNs and fonts.** Images, scripts and fonts from another host count as calls to a backend too. Add hosts such as `fonts.gstatic.com` or `*.your-cdn.com` to `allowHosts` in `lookover.config.json` (or pass `--allow-host` for one run); otherwise Lookover asks you to confirm them, and blocks them when they first appear after that step. A host the app only loaded such static assets from is listed as `(static assets — consider allowHosts)`. A host in `allowHosts` is never asked about at all, so real backends do not belong there: confirm them instead.

## What it finds

Every candidate names a rule from [the rules catalogue](docs/rules.md), and its severity is the rule's. [The interaction lens and the observers](docs/lenses/interaction.md) describes what each check measures, its exact threshold and every exemption.

**The interaction lens**, on each screen's controls:

- Keyboard focus is not visible
- The focus indicator is too faint
- No hover feedback on a clickable control (listed under "worth a look", not as a candidate)
- Text is unreadable against its background
- Text contrast is below the minimum
- Tap target is smaller than 24 by 24 pixels
- Control cannot be reached with the keyboard
- A positive tabindex forces a custom focus order
- Keyboard focus lands on something that cannot be seen
- Keyboard focus gets stuck
- The page scrolls sideways at this screen size
- Text is cut off without an ellipsis

**The observers**, on everything the page does while it loads:

- The page threw an error that nothing caught
- The page logged an error to the console
- The page logged a warning (worth a look)
- A request the page made failed on the server
- A request the page made was rejected
- A request the page made never got an answer
- A placeholder value leaked into the page (`undefined`, `NaN`, `[object Object]`)
- A template placeholder was not filled in (`{{name}}`, `{count}`)
- A translation key is shown instead of its text (`settings.timezone.hint`)

Candidates are measurements: when one cannot be trusted (text over a background image, a photo or anything else painted under it, a colour that cannot be read, an element that left the page) it is skipped and the reason recorded, never guessed. The judge that re-runs each candidate before it reaches a report comes next, with a replay that runs without Lookover.

## What it will not do

- Call a candidate proven. Candidates are measured, but nothing has judged or reproduced them yet; the CLI says so wherever it prints them.
- Act on data while it inspects. The interaction lens forces hover and focus styles, moves focus, presses Tab, resizes the window and reloads the screen it is on; it never clicks, types, submits a form or opens another page.
- Act on data you have not declared disposable: full interaction needs the acknowledgement in the config. Before you confirm the backends, Lookover only opens a few pages, logged out and without submitting anything (the app's own requests from them do reach its backends); after that, every backend you have not confirmed is blocked.
- Store or log your credentials: they are read from environment variables, kept out of errors and logs, and the saved session is readable only by you.
- Send your data to anyone: in v0 Lookover itself calls no outside service; the only requests that leave your machine are the ones your app makes to its own backends. When the judge arrives, Lookover's only outside calls will be model calls, documented in full.
- Test apps you do not run yourself. There is no hosted mode.

## Licence

[MIT](LICENSE)
