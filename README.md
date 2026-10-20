# Lookover

Lookover is an open-source design-and-QA reviewer that drives a web app in a real browser the way a senior front-end reviewer would, and reports what it can prove. It is built for people who came to coding through AI tools and ship real sites without anyone experienced checking their work.

**Status: v0 in progress — the lenses, judge and report arrive in the next plans.** Today Lookover maps your app: it opens every screen it can reach in a real browser and records what is on each one in `.lookover/app-map.json`. It does not report findings yet. The plans are in [docs/superpowers/plans](docs/superpowers/plans).

## Getting started

You need Node 22.12 or later and your app running locally. Next.js apps get their routes read from the filesystem as well; other apps are mapped by following links.

```sh
cd your-app
pnpm dlx @jayslifecode/lookover init   # a few questions; writes lookover.config.json and ignores .lookover/
lookover run                           # opens each screen in Chromium and writes .lookover/app-map.json
```

> **Not on npm yet.** Until the first release, build Lookover from a clone of this repository and use
> `node <clone>/packages/cli/dist/index.js` wherever this page says `lookover`:
>
> ```sh
> pnpm install
> pnpm --filter @jayslifecode/lookover-core build
> pnpm --filter @jayslifecode/lookover-cli build
> pnpm --filter @jayslifecode/lookover-core exec playwright install chromium
> ```

`init` asks for the URL your app runs at, its framework, whether every piece of data the app can reach is disposable, and how to log in. Only a "yes" to the disposable-data question unlocks **full** interaction (Lookover may click anything and submit any form); otherwise the config says **safe**. In scripts, pass the answers as flags: `lookover init --non-interactive --base-url http://localhost:3000`, adding `--interaction full --acknowledge-disposable-data` only when the data really is disposable.

A form login reads its credentials from `LOOKOVER_USERNAME` and `LOOKOVER_PASSWORD`; the config stores only the names of those variables, never the values.

`lookover run` prints a line per screen and a summary. Against the bench app in this repository:

```text
Mapping http://localhost:3123 (run 20261021-044428-31vz)
✓ /  10 elements · 0 forms
✓ /login  9 elements · 1 form
✓ /organisations  19 elements · 0 forms
✓ /organisations/new  12 elements · 1 form
✓ /reports  7 elements · 0 forms
✓ /settings  10 elements · 1 form
✓ /organisations/[id]  12 elements · 1 form
✓ /organisations/[id]  12 elements · 1 form

  Screens           8
  Elements          91
  Forms             5
  Backend hosts     none
  Blocked requests  0
  Run dir           .lookover/runs/20261021-044428-31vz
  App map           .lookover/app-map.json
  Duration          9.1 s
```

| Flag                    | What it does                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `--headed`              | Shows the browser window.                                                                          |
| `--max-screens <n>`     | Captures at most `n` screens this run, instead of `maxScreens` from the config (default 40).       |
| `--allow-host <host>`   | Lets the browser load this host too, for this run only. Repeatable.                                |
| `--confirm-host <host>` | Confirms a backend as a development or disposable instance and saves it to the config. Repeatable. |
| `--yes`                 | Never prompts. A backend that is not confirmed stops the run instead.                              |

Exit codes: `0` done, `1` the run failed, `2` the config or a flag is invalid, `3` refused (the disposable-data acknowledgement is missing, or a backend is not confirmed).

### What `.lookover/app-map.json` contains

- **`routes`**: every route pattern, in Next.js syntax (`/organisations/[id]`), from the filesystem or from links.
- **`screens`**: one per page visited (at the first viewport in the config, and by default at most two instances of one dynamic route), each with its URL, route pattern, title, a screenshot, the interactive elements (role, accessible name, a selector, position, whether it is disabled or focusable), the forms (each field's label and where the label came from, type, required, pattern and length limits, and the submit button), the design tokens it renders (colours, font sizes and families, radii, spacing, with how often each appears) and the links to other screens of the app.

`.lookover/app-map.json` is always the latest run's map. Each run also keeps its own copy, an append-only event log (`run.jsonl`) and its screenshots under `.lookover/runs/<run id>/`. Values that look like secrets are redacted in the map and the log, and nothing in `.lookover/` leaves your machine.

### Backends and other hosts

The browser only opens your app: `localhost`, `127.0.0.1`, `::1`, any `*.local` or `*.localhost` name, and the hosts in `allowHosts`. Requests to payment, email and SMS providers are blocked unless you add them to `allowHosts`. Any other host the app itself calls (a hosted database, an auth service, an API) is treated as a backend: before logging in, Lookover opens a few pages, lists the backends the app called, and asks you to confirm that each one is a development or disposable instance. The run does not go on until you have, and a backend first called later in the run is blocked and listed at the end.

- **Confirming backends.** Answer the prompt, or pass `--confirm-host <host>` (once per host) to confirm them from the start, which is what `--yes` and CI need. Confirmed hosts are saved to `confirmedBackendHosts` in `lookover.config.json`, so later runs do not ask again; you can also edit that list by hand.
- **CDNs and fonts.** Images, scripts and fonts from another host count as calls to a backend too. Add hosts such as `fonts.gstatic.com` or `*.your-cdn.com` to `allowHosts` in `lookover.config.json` (or pass `--allow-host` for one run); otherwise Lookover asks you to confirm them, and blocks them when they first appear after that step.

## What it finds

Nothing yet: the first lenses (interaction and consistency) come in the next plans, built on the App Map above. Each finding will carry measured evidence, the rule it breaks, a screenshot and a replay that runs without Lookover.

## What it will not do

- Touch anything you have not declared disposable: full interaction needs the acknowledgement in the config, and every backend must be confirmed first.
- Store or log your credentials: they are read from environment variables, kept out of errors and logs, and the saved session is readable only by you.
- Send your data anywhere: in v0 nothing leaves your machine. When the judge arrives, the only outside calls will be model calls, documented in full.
- Test apps you do not run yourself. There is no hosted mode.

## Licence

[MIT](LICENSE)
