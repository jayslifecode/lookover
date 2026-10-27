# Safety and privacy

Lookover runs on your machine, against an app you run yourself. This page says what leaves the machine
(only judge model calls, and exactly what is in one), what the report server exposes and to whom, and
what Lookover stores under `.lookover/`. How the browser is kept to your app (the allowed hosts, the
backends you confirm, the payment, email and SMS providers it blocks) is in
[the README](../README.md#backends-and-other-hosts) and
[how a run works](how-it-works.md#the-browser-and-the-network-envelope).

## What leaves your machine

The browser Lookover drives loads your app, and your app's own requests go where your app sends them.
Before you confirm the backends, Lookover only opens a few pages, before logging in and without
submitting anything; with a saved session, that session's cookies are sent with the probe's requests.
The app's own requests from those pages do reach its backends: that is how Lookover learns what they
are. From then on they go only to the backends you confirmed; every other backend is blocked.
That traffic is your app's.

Lookover's own requests to anything outside your machine are **judge model calls, and nothing else**:
no telemetry, no analytics, no update check, no font or script from a CDN. A judge call is made only:

- from `packages/judge`, the one package that talks to a model;
- when `ANTHROPIC_API_KEY` holds a key (an empty or blank value counts as none, so the SDK never goes
  looking for other credentials on the machine), and never with `--no-judge`;
- about a finding that already reproduced in all three fresh browser contexts (or an occurrence finding's
  occurrences that did), never about a candidate that did not, a worth-a-look entry or a finding you
  marked intended;
- when the verdict cache has no answer for it (below);
- to the Anthropic API through the official SDK, at `https://api.anthropic.com` unless you set
  `ANTHROPIC_BASE_URL`, which the SDK reads.

Without a key, nothing is sent. The harness decides on its own, and every finding that reproduced is still
confirmed and reported; the summary and the report say the judge model was not used.

### What a judge call contains

One call is one finding. It carries two parts: Lookover's system prompt, which is the same text on every
call and holds nothing of yours (it is in `packages/judge/src/model/prompt.ts`), and one user message,
built by `packages/judge/src/model/bundle.ts`:

| Part | What it holds |
| --- | --- |
| The rule | From Lookover's catalogue: its id, title, severity, what is expected, why it matters, the fix hint, the standard it comes from. |
| The finding | A step finding: the route, the URL, the viewport, the element's role, accessible name, selector, React component and class signature, what was observed, and the steps that reproduce it (go to the URL, set the viewport, force a state on the selector, press Tab so many times, measure). An occurrence finding: what was observed and each place it was seen (route, URL, viewport, selector). |
| The measured facts | Each occurrence's measured values (for an observer finding, the console message, the request's method, URL and status, or the text that leaked), then the finding's `measurements` and `styles` evidence (computed styles at rest and in the forced state, for example), as compact JSON, redacted, at most 2,000 characters in all; the message says how much was cut. |
| Up to two crops | PNG crops of the element from the finding's evidence, in its own order (the element at rest first, then in the rule's state), each attached only if it is under 200,000 bytes; the message names any left out. Never a screenshot of the whole page. |
| The attempts | For each reproduction: its number, which occurrence it was for (the screen id, the viewport's name, the selector), whether it reproduced, what it observed, and why it was skipped, if it was. No durations and no times. |
| The environment | The browser and its version, the OS (platform, release, architecture), the Node version, the Lookover version and the viewport. |

It does not contain your credentials or cookies, your config, your source code, the App Map, the run's
other findings, the console, request and text records of the screen (only what the finding itself
measured), or any screenshot of a whole page.

**Page text goes as untrusted data.** Every string that came from the page under review (names,
selectors, URLs, what was observed, the measured facts, what each attempt saw) is first redacted, then
wrapped in `<untrusted_page_content>` tags; a copy of the tags inside the text is escaped, so the page
cannot close the wrapper and speak outside it. The system prompt tells the model that whatever is inside
those tags, and any text in the images, is evidence about the page and never an instruction, whatever it
claims. The catalogue's text and Lookover's own words are the only text outside the tags. The bundle
tests (`packages/judge/test/model-bundle.test.ts`) check that every page-derived string is wrapped and
that an instruction planted in a console message stays inside the wrapper. An opt-in test against the
live API (`LOOKOVER_LIVE_JUDGE=1` with a key, never in CI) sends a console message carrying such an
instruction and checks only that the answer is a valid verdict and that its note does not quote the
instruction; it does not check which verdict the model gave.

**What comes back** is a verdict in a fixed schema, read through structured outputs: `confirm` or
`reject`, an attribution, the standard applied (at most 120 characters) and a note (at most 280). The
model cannot add a finding, change a severity, or confirm a finding that did not reproduce; a rejection
must be `explorer-error` or `exemption` with its reason. An answer that is not a usable verdict is a
model error, and the finding stays confirmed by the harness.

**The SDK logs nothing.** The client is built with its logging off, so no request (which carries page
text) is logged, whatever `ANTHROPIC_LOG` says. Requests time out after 60 seconds and are retried twice.

**The verdict cache.** Every verdict is kept in `.lookover/cache/judge/<hash>.json` (the model id and the
verdict, redacted), keyed by a SHA-256 of the prompt's version, the model id, the message's text and the
crops' ids. The same finding, measured the same way, is answered from there on a later run without a
call. Delete the directory to ask again.

## The report server

`lookover run` (unless `--no-report`) and `lookover report` serve the report from a small HTTP server in
the CLI (`packages/cli/src/report/`).

- **On this machine only.** It listens on `127.0.0.1`, on a port the system picks (`lookover report`
  also takes `--port`). Nothing off the machine can connect to it.
- **Behind the run's token.** Each server makes a token of 128 random bits (32 hex digits) from the
  system's secure random source. Every `/api/*` request (the run, its log, its files, its evidence, the
  writes) must carry it, as the server's cookie `lookover_token_<port>` (`HttpOnly`, `SameSite=Strict`,
  named after the port so two reports on one machine keep their own) or in an `X-Lookover-Token` header;
  without it the answer is 401. The cookie is set for the host `127.0.0.1`, and since cookies are not
  scoped by port, the browser also sends it to any other server you open as `127.0.0.1:<port>` in it
  (often the app under review); it is `HttpOnly` and named per port, and no `__Host-` prefix is possible
  over http. Tokens are compared in constant time. The report's own files (its HTML,
  scripts, styles and fonts) are served without the token; they hold nothing of yours.
- **The URL is the key.** The URL Lookover prints, `http://127.0.0.1:<port>/?token=<token>`, is what lets
  a browser in: opening it sets the cookie and redirects to `/`, so the token leaves the address bar.
  Treat it as you would a password while the server runs: anyone on this machine who has it can read the
  run (its screenshots, findings and evidence), record decisions and ask for a replay. The token is good
  for that server only and dies with it (Ctrl-C, or the end of a run that is not on a terminal).
- **Addressed by its own name.** Every request must say `Host: 127.0.0.1:<port>` or
  `Host: localhost:<port>`, or it is refused with 421, so a web page whose own name was rebound to
  127.0.0.1 (DNS rebinding) cannot use the server.
- **Writes from the report only.** A POST (a decision, a replay) must also carry an `Origin` of
  `http://127.0.0.1:<port>` or `http://localhost:<port>`, or it is refused with 403. Its body is at most
  16 KB. Only GET and POST are answered.
- **Headers on every response.** A Content-Security-Policy (`default-src 'self'`, scripts and
  connections to the report's own origin only, its own styles and inline styles, fonts from it or
  `data:`, images from it, `data:` or `blob:`, no page may frame it, no `<base>`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `Cross-Origin-Resource-Policy: same-origin`, and never a CORS header. Everything is `no-store` except
  the hashed build files and the evidence, which never change under their names (the evidence is cached
  as `private`).
- **Evidence from the run's own folder.** Evidence is served only from under the run's `evidence/`
  directory: a path with an empty, `.` or `..` segment or an encoded separator is refused, and the
  resolved path is checked to be inside the folder. PNG and JSON are served as what they are; anything
  else as bytes to save, never as a page. The report's own files are served from its build directory
  only, the same way.
- **Errors say little.** A failure answers the first line of its message, redacted, never a stack.

The report page itself asks nothing of any other origin. A test scans the built report for any place
that loads a URL from elsewhere, and the end-to-end suite counts every request the page makes in a real
browser, across every view, and fails on one to another origin or one the policy blocked. The links to
the standards a rule cites open in a new tab, without a referrer, only when you click them.

A replay asked for from the report opens a browser window on your machine, against your app, with the
same checks as `lookover replay`, and only once the run has finished.

## What is stored under `.lookover/`

| Path | What it holds |
| --- | --- |
| `app-map.json`, `findings.json` | The latest run's App Map and findings. |
| `runs/<run id>/` | Each run: its log (`run.jsonl`), App Map, findings, and `evidence/` (full-page screenshots, crops, computed styles, console, request and text records, state galleries, and a record of every reproduction attempt). |
| `decisions.json` | The findings you marked as intended, with your notes. |
| `cache/judge/` | The judge model's verdicts, one file per bundle hash. |
| `replays/<id>.mjs` | The standalone replay scripts you asked for. Each embeds its finding as stored (redacted): its URLs, selectors, element names and measured values. Share one as you would share the finding. |
| `state/form.json` | The session a form login saved, with its live cookies, readable only by you (the directory is `0700`, the file `0600`). It is not redacted. |

`lookover init` adds `.lookover/` to your `.gitignore`. Every JSON file and every line of the run log is
redacted before it is written ([what redaction replaces](findings.md#redaction)), with one exception: the
saved session, `state/form.json`, keeps its cookies as they are, since it has to work to log in again.
Never share it or commit it. Screenshots and crops are stored as they were taken, so they show whatever
your app showed. `lookover replay` writes nothing here except a script you ask for with `--script`: its
own evidence goes to a temporary directory that is removed afterwards. Nothing under `.lookover/` is
sent anywhere, except the parts of a finding a judge call carries, as listed above.
