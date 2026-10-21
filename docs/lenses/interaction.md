# The interaction lens and the observers

The interaction lens looks at how each screen's controls look and behave: what happens when you hover
over them, focus them and press Tab, whether their text can be read, whether they are big enough to
tap, and whether the page fits a phone. The observers run beside it on every screen and watch the
browser console, the network and the text the page shows.

Everything here is a measurement. No model is involved, and each result is a **candidate**: the judge
that confirms or rejects candidates arrives in a later release. When a measurement cannot be trusted,
the lens skips it and records why, rather than guess. Every rule, with its severity and the standard
behind it, is in [the rules catalogue](../rules.md).

The source is `packages/lenses/src/interaction/` (the lens) and `packages/core/src/observers/` (the
observers). Each section below names the seeded issue in `bench/` that exercises the rule, or the lens
test fixture under `packages/lenses/test/fixtures/` when the bench has no seed for it yet.

## What the lens may do

On each screen the lens may force CSS pseudo-classes, move keyboard focus, press Tab, resize the
viewport and reload the screen's own URL. It never clicks, types into a field, submits a form or
navigates to another URL, so it is safe whether the config says `full` or `safe` interaction. It
works on the page the crawler has just captured, after the observers have collected what they saw.

## How a screen is inspected

**The elements.** The lens judges the screen's interactive elements as the App Map lists them: the
nodes of Chromium's accessibility tree (CDP `Accessibility.getFullAXTree`) with an interactive role
(button, link, textbox, checkbox, combobox, option, switch, tab and the others in `INTERACTIVE_ROLES`),
in reading order, at most 500 per screen. Each one has a selector that finds exactly that element, its
role, accessible name, border box in document coordinates, whether it is disabled, whether it can take
focus (the accessibility tree's `focusable`, which includes `tabindex="-1"`), and its backend node id.
The forced states and the static measures judge only these elements, so text that is not part of a
control, such as a paragraph, is not judged for contrast.

**The steps.** They run in this order, each on the whole screen:

1. **Forced states**: hover, focus and pressed states of each control (`focus-visible-missing`,
   `focus-indicator-contrast`, `hover-state-missing`).
2. **Static measures**: text contrast, target size, keyboard reachability and positive tabindex
   (`text-contrast-fail`, `text-contrast-low`, `target-size`, `keyboard-unreachable`,
   `positive-tabindex`).
3. **The Tab walk**: the focus order (`focus-hidden`, `focus-trap`).
4. **The viewport sweep**: each configured viewport (`horizontal-overflow`, `text-clipped`).

**The time budget.** The lens has 10 seconds per screen (`PER_SCREEN_BUDGET_MS`). A step that would
start after that is skipped whole and recorded as `time-budget:states`, `time-budget:static`,
`time-budget:tab-walk` or `time-budget:viewports`. A step that has started checks the deadline as it
goes and records what it did not reach: `time-budget` in the forced states (elements left), the Tab
walk (presses not made) and the sweep (viewports left), and `time-budget:text-contrast`,
`time-budget:target-size` and `time-budget:keyboard-reachability` in the static measures (elements
left). Because the plain `time-budget` count adds elements, presses and viewports together, read it as
"something was cut short", not as a number of anything.

**Skips.** Every skip has a reason and a count. The counts of one screen are added up per reason and
written to the run log in the screen's `screen.inspected` event (`skipped`). A skip never becomes a
finding.

**The state gallery.** The lens writes one gallery per screen to the run's evidence folder as
`gallery-<screenId>-<hash>.json`: `{ screenId, viewport, entries, focusOrder }`. Each entry is one
control (`selector`, `role`, `name`, `componentName`) with its computed styles in each state it was put
in (`states.rest`, `hover`, `focus`, `active`), the cropped screenshots of those states (`crops`), why it
was not put in every state (`skipped`: `disabled`, `no-backend-node` or `gone`, else `null`), where
its focus shows (`focusMarkOn`: `self`, `ancestor:<n>` or `null`) and how that was found
(`focusMarkVia`: `forced`, `real` or `null`, see "Focus set by script" below). `focusOrder` is the Tab
walk's list of stops.

**React component names.** In a React development build each finding's target carries the name of the
component that rendered the element (`componentName`), which the fix prompt passes on. It is read from
the element's React fiber (the `__reactFiber$…` property): the nearest function or class component going
up, by `displayName` or `name`, passing over React's own wrappers (`Fragment`, `Suspense`) and names that
start with a lowercase letter or `_`. A `forwardRef` component is an object, not a function, so an
element rendered by one is attributed to the component around it. Production builds have no
development fibers and minified names, so `componentName` is `null` there.

**Findings and "worth a look".** Every rule produces candidates in `findings`, except
`hover-state-missing`, whose results go to the separate `worthALook` list: a hover effect written in
JavaScript (a `mouseenter` handler) changes nothing that forcing `:hover` can see, so a missing hover
state is less certain than the other measurements.

## The forced states

Each control among the screen's first 60 elements (`MAX_STATE_ELEMENTS`; the rest are counted as
`state-elements-cap`) is captured at rest and then with each state forced in turn: `:hover`, `:focus`
together with `:focus-visible`, and `:active`. Before anything is forced, keyboard focus is moved off
whatever has it, so no control's rest state shows its focus ring.

- **How.** Each control's DOM node is pushed to the protocol once (CDP
  `DOM.pushNodesByBackendIdsToFrontend`), states are forced with CDP `CSS.forcePseudoState` and cleared
  after each state, and the styles are read in the page with `getComputedStyle` through CDP
  `Runtime.callFunctionOn` on the node. Running CSS transitions are finished first
  (`element.getAnimations({ subtree: true })`, `CSSTransition.finish()`), so a colour that fades in is
  read at its end value.
- **What is read.** 23 computed properties (`STATE_STYLE_PROPERTIES`): outline style, width, colour and
  offset; box shadow; the four border colours and the top border width; background colour and image;
  text colour; text decoration line, colour and thickness; `transform`, `scale`, `translate`,
  `rotate`; opacity; filter; cursor. They are read on the control itself and on its `::before` and
  `::after` pseudo-elements, which is where many focus rings are drawn. At rest and with focus, the
  same properties are also read on the control's three nearest ancestors.
- **What changes.** A state "shows" when any of those properties differs from rest on the control or
  one of its pseudo-elements. The outline's width, colour and offset only count when its style is not
  `none` in at least one of the two states: with `outline-style: none` in both, nothing is painted
  whatever they do. (Tailwind's `focus:outline-none` under an app-wide `:focus-visible` outline rule
  changes the width, colour and offset and still draws nothing.)
- **Focus set by script.** Forcing a pseudo-class dispatches no event, so a focus style that a focus
  listener sets (Headless UI's `data-focus`, React Aria's `data-focus-visible`, MUI's
  `.Mui-focusVisible`) does not show under forced focus. When forced focus shows no mark on a control
  that can take focus, the control is also focused for real (CDP `DOM.focus` by its backend node id)
  while `:focus` and `:focus-visible` stay forced, its transitions are finished and the same styles are
  read again, on it and its three nearest ancestors; then it is blurred and the forced states cleared,
  whatever happens. When the real focus shows a mark, that look is the gallery's focus state (and its
  crop), and `focusMarkVia` is `real`; a mark found with focus forced is `forced`. Only the controls the
  forced path found nothing on are focused this way, so the extra work stays bounded.
- **Crops.** The controls of the first 12 class signatures (`MAX_GALLERY_ELEMENTS`; a signature is the
  tag and the sorted class list) are cropped in every state, with 8 px around them so an outline shows
  (`page.screenshot` with a clip, after scrolling the control into view).
- **Skips.** A disabled control cannot be hovered, focused or pressed: it is recorded at rest only
  (`disabled` in its gallery entry). A control without a backend node id is not forced
  (`no-backend-node`), and one that leaves the page while it is being captured is `gone`. Past the
  deadline the remaining controls are counted as `time-budget`.

### `interaction.focus-visible-missing` (high)

- **Measured:** for each control that can take focus, whether forced focus changes anything.
- **Threshold:** a finding when none of the tracked properties of the control, its `::before` or its
  `::after` changes under `:focus` and `:focus-visible`, and none of its three nearest ancestors
  changes either (`MAX_FOCUS_WITHIN_DEPTH`), both with focus forced and once the control is focused for
  real (see "Focus set by script" above).
- **Exemptions:** a focus mark on one of the three nearest ancestors counts (the input-group pattern,
  where a wrapper's `:focus-within` draws the ring). The forced-state skips above.
- **Bench:** `interaction-001`, the Settings Save button with `focus:outline-none` and nothing in its
  place. Control `control-001`, the Sign in button, keeps the shared ring and is not reported.

### `interaction.focus-indicator-contrast` (medium)

- **Measured:** the contrast of the focus mark the control draws itself, against the colour next to it.
- **How:** the mark's colour is the `outline-color` when focus gives the control a visible outline that
  differs from its rest outline (style neither `none` nor `auto`, width above 0, colour not fully
  transparent); otherwise the colour of the outermost crisp `box-shadow` layer (no blur) that focus adds
  and that can be seen (not transparent, not `inset`, reaching past the box), so the white offset layer
  of a ring, the empty layers Tailwind writes and a drop shadow that reaches further than the ring
  (`focus:ring-2 focus:shadow-lg`, about 22 px of 10 % black) are passed over. The background is the
  effective background of the control's parent, because an outline or ring sits outside the control's
  box (see "Backgrounds" below). The mark's colour is blended over that background and the WCAG 2.x
  contrast ratio is taken, rounded once to two decimals.
- **Threshold:** a finding under 3:1 (WCAG 2.2 1.4.11). A ratio that rounds to 3.00 passes.
- **Not judged:** a mark that is a fill or text colour change, an inset ring, or a ring drawn on
  `::before` or `::after`: there is no single colour next to them to compare.
- **Skips:** `focus-indicator-ua-ring` when focus gives the browser's own ring (`outline-style: auto`),
  which Chromium paints in two tones that depend on the platform, so it is exempt;
  `focus-indicator-on-ancestor` when the mark is on an ancestor (its presence counts for the rule above,
  its contrast is only judged on the control itself); `focus-indicator-blurred-only` when the only mark
  focus adds around the control is blurred shadow (`focus:shadow-lg` alone), whose edge fades into the
  background, so there is no one colour next to it; `focus-indicator-background:<why>` when the
  background cannot be trusted; `focus-indicator-colour-unreadable` when the mark's colour or the
  background's cannot be read. The mark's colour is read straight from the computed style, and colours
  computed in `lab()` (for example Tailwind 4.3's palette) are not read yet, so such rings are skipped
  with that reason.
- **Bench:** no seed yet. Fixtures `states/ring.html` (`#faint`, 1.24:1), `states/dark.html`,
  `states/shadow.html` (a ring with a drop shadow) and `states/js-focus.html` (`#js-faint`, a mark set
  by a focus listener).

### `interaction.hover-state-missing` (low, worth a look)

- **Measured:** for each button and link, whether forced `:hover` changes anything, the cursor
  included.
- **Threshold:** an entry in `worthALook` when nothing tracked changes on the control or its
  pseudo-elements.
- **Bench:** no seed. Control `control-003`, the Reports "Open summary report" button
  (`hover:bg-primary/90`), is not reported.

## The static measures

These read each element as the page is now, with no state forced. Each rule goes through the
screen's elements in order and stops at the deadline, counting the ones it did not reach.

**Text colours.** The text colour is the element's computed `color`. Chromium keeps the colour space a
colour was written in (`lab()`, `oklch()`, `oklab()`, `color(display-p3 …)`), so the colour is read in
the page through a 1×1 sRGB canvas (`OffscreenCanvas`): an sRGB colour with alpha is kept as Chromium
writes it back from the canvas's `fillStyle` (`rgba(…)`), and anything else is painted into a pixel and
read back with `getImageData`. A wide-gamut colour is judged as the sRGB colour Chromium paints.

**Backgrounds.** The background is found in the page by going up from the element to `<html>` and
compositing each `background-color` under the ones above it (source-over), read through the same
canvas, until the stack is opaque (alpha at least 0.999). That walk sees the element's ancestors only,
so before it the element is scrolled into view (to the middle of the viewport) and the elements at its
centre are listed with `document.elementsFromPoint`. The background cannot be trusted, and the
measurement is skipped with the first reason met on the way up (the walk's reasons come before
`overlapped`), when:

- `background-image`: a layer has an image or a gradient before the stack is opaque;
- `backdrop-filter`: a layer has a backdrop filter before the stack is opaque;
- `opacity`: the element or any ancestor has `opacity` below 1;
- `mix-blend-mode`: the element or any ancestor blends;
- `filter`: the element or any ancestor has a filter;
- `never-opaque`: no layer up to `<html>` is opaque, so the browser's own canvas colour shows through,
  and that depends on the colour scheme;
- `overlapped`: something that is not one of the element's ancestors is painted under it, above the
  layer that made the stack opaque: an element listed beneath it at its centre (a positioned sibling,
  a `next/image` hero, a portal), or a replaced element (`img`, `video`, `canvas`, `picture`, `svg`,
  `iframe`, `object`, `embed`) inside that layer, not inside the element itself, whose box meets the
  element's (hit-testing passes over a decoration with `pointer-events: none`). Text on an opaque card
  is still judged, whatever is painted under the card, and so is a control beside its own icon;
- `off-viewport`: the element's centre is outside the viewport even once it is scrolled into view (a
  `position: fixed` element placed off the page), so nothing can be listed under it.

### `interaction.text-contrast-fail` (high) and `interaction.text-contrast-low` (medium)

- **Measured:** the contrast of each element's text against the background behind it (WCAG 2.2
  1.4.3), for the first 200 elements of the screen (`MAX_CONTRAST_ELEMENTS`; the rest are counted as
  `contrast-elements-cap`).
- **How:** the element's text as shown (`innerText`, whitespace collapsed, the first 80 characters),
  its computed font size and weight, its text colour and its background as above. The text colour is
  blended over the background, the WCAG 2.x contrast ratio is taken and rounded once to two decimals,
  and that rounded value is what is compared, printed and stored. Large text is at least 24 px, or at
  least 18.66 px and bold (weight 700 or more).
- **Thresholds:** `text-contrast-fail` under 3:1, whatever the size. `text-contrast-low` from 3:1 up to
  the minimum for the text's size: under 4.5:1 for normal text (large text needs 3:1, so it can only
  fail). An element with no text has nothing to judge.
- **Exemptions:** a disabled element (`disabled`): WCAG puts no contrast requirement on the text of an
  inactive component.
- **Descendant text:** the colour and font read are the element's own, but its text may sit in child
  elements. When any descendant that holds text has a different computed colour, a background colour,
  a background image or an opacity below 1, the text is painted in colours the sample does not
  describe, and the element is skipped (`text-colour-uncertain:descendant`). Descendants inside shadow
  roots are not looked at.
- **Skips:** `disabled`, `text-colour-uncertain:descendant`, `background-uncertain:<why>` (the reasons
  under "Backgrounds", `background-uncertain:overlapped` for text over a photo among them),
  `colour-unparseable` (the page's canvas rejects the text or background colour, or what it gives back
  cannot be read; a guard, since a computed colour is one the canvas paints), `gone` (the element left
  the page), `contrast-elements-cap`, `time-budget:text-contrast`.
- **Fixtures:** `static/contrast-overlap.html` (white text over a dark `<img>` beside it: skipped as
  `overlapped`) and `measure/overlap.html`.
- **Bench:** `interaction-002`, the Reports Export CSV button, `text-slate-400` on `bg-slate-100`
  (2.40:1). `text-contrast-low` has no seed yet; fixture `static/contrast.html` (`#low`, 4.23:1).

### `interaction.target-size` (medium)

- **Measured:** each element's border box from the App Map against WCAG 2.2 2.5.8 (Target Size,
  Minimum), with the boxes of every other element on the screen as its neighbours.
- **Threshold:** a target at least 24 by 24 px passes. A smaller one (narrower or shorter than 24 px)
  passes by the spacing exception only when the 24 px circle centred on it (radius 12 px) meets no
  other target's box (the distance from its centre to every other box is at least 12 px; a box exactly
  12 px away only touches the circle) **and** does not overlap the circle of any other undersized target
  (their centres are at least 24 px apart). Otherwise it is a finding.
- **Which boxes count:** a box that contains the target (a listbox around its options) or that the
  target contains (an icon inside its button) is not a neighbour and counts for neither condition. A
  box that only overlaps it does. Exempt targets still count as neighbours: an exempt undersized target
  still has a box and a circle that can crowd the others.
- **What "nearest" says:** the finding reads `16×16 px, nearest other target 12 px away`, where
  `nearest` is the smallest distance from the target's centre to another box (0 when the centre is
  inside one). A target 12 px from its neighbour's box passes the first condition and can still fail
  the second, so "12 px away" can describe a failure of the circle condition.
- **Exemptions:** a disabled element; a native checkbox or radio button (an `<input>` whose role is
  `checkbox` or `radio`), a `<select>` and an `<option>`, which the browser draws itself; a link or other
  inline element in a line of text (its computed `display` starts with `inline` and its parent has a
  text node with something other than whitespace beside it; asked only of a target that is too small).
  The native-control exemption keys on the role, so `<input type="checkbox" role="switch">` is judged.
- **Skips:** `gone` (the element left the page before the inline check), `time-budget:target-size`.
- **Bench:** `interaction-003`, the 16 px Edit icon link 4 px from the 16 px Copy email button in each
  row of Organisations (24 findings, two per row). Control `control-002`, the organisation name links,
  are inline text links and are not reported.

### `interaction.keyboard-unreachable` (high)

- **Measured:** whether a control that must be reachable with Tab can take focus at all (WCAG 2.2
  2.1.1).
- **Threshold:** a finding for an element whose role is `button`, `link`, `textbox`, `searchbox`,
  `checkbox`, `switch`, `combobox`, `slider` or `spinbutton` (`MUST_BE_FOCUSABLE_ROLES`) that is not
  focusable (no `tabindex` and not focusable by nature). `tabindex="-1"` counts as focusable: a roving
  tabindex widget moves focus to it by script.
- **Exemptions:** a disabled element; an element inside (not itself) an element with
  `aria-activedescendant` (a listbox, a combobox popup or a toolbar keeps focus on itself and points at
  its active child, so the child is never focused). The exemption applies to ancestors only: an element
  that names an active descendant itself is the widget and must be focusable.
- **Skips:** `gone`, `time-budget:keyboard-reachability`.
- **Bench:** `interaction-004`, the dashboard stat cards, `<div role="button" onClick>` with no
  `tabIndex`.

### `interaction.positive-tabindex` (low)

- **Measured:** every element of the page with a `tabindex` above 0, wherever it is
  (`document.querySelectorAll('[tabindex]')` and the element's `tabIndex`), not only the App Map's.
- **Threshold:** a finding when any element has one: one occurrence finding per screen (key: the
  route), with one occurrence per element and its `tabindex`, in document order.
- **Bench:** `interaction-005`, the Settings Workspace name input with `tabIndex={1}`.

## The Tab walk

The lens presses Tab from the top of the page and records where focus lands after each press.

- **How.** Focus is first reset: the active element is blurred, then the body is given a temporary
  `tabindex`, focused and blurred (blurring alone does not reset Chromium's starting point for Tab), its
  attribute is put back and the page is scrolled to the top. Each press is Playwright's
  `page.keyboard.press('Tab')`; after it, the running transitions are finished and
  `document.activeElement` is read in the page: its tag, its border box, a selector that finds it again,
  where focus is inside its open shadow roots, and why it cannot be seen. Each press that lands on
  something is one stop in the gallery's `focusOrder`, with `index` the number of presses it took
  (stops in the development overlay are left out, see the skips below).
- **Budget.** At most `2 × focusable controls + 5` presses (the focusable controls the App Map lists),
  and never more than 300 (`MAX_TAB_PRESSES`). Presses that stay on a native control the browser draws
  in parts (see the trap exemptions) are not counted against the first number, so a page of date
  inputs is walked to the end; they still count against the 300.
- **Where it ends.** When focus leaves the document (the active element is the body), when it comes
  back round to the first stop, when the same control keeps focus for three presses in a row, when the
  presses run out (`tab-presses-cap`, count 1) or at the deadline (`time-budget`, counting the presses
  not made). A walk stopped on a trap records `tab-walk-stopped` with the presses not made, so the rest
  of the page is known to be unwalked.
- **Afterwards.** Focus is moved off the last stop and the page scrolled back to the top, so the sweep
  and the next screen start from there.
- **Skips.** `focus-stop-unaddressable`: a stop whose selectors do not find the element again (one in a
  shadow tree) is kept in the order without a selector but cannot be reported. `dev-overlay`: a stop on
  an element that is, or is inside, a `nextjs-portal` element (`DEV_OVERLAY_TAGS`) is pressed through
  like any other, then left out of the order and the findings: it is Next.js's development overlay (the
  issues badge `next dev` shows once the page has logged an error), not the app. `tab-presses-cap`,
  `tab-walk-stopped`, `time-budget`.

### `interaction.focus-hidden` (medium)

- **Measured:** whether a person can see the element focus lands on, read once the focus has landed
  and its transitions have finished.
- **Threshold:** a finding when its box has no width or no height (`zero-size`), it is not
  `visibility: visible` (`visibility`), it or an ancestor has `opacity: 0` (`opacity`), or its box lies
  entirely outside the document (`offscreen`: right edge at or left of 0, bottom at or above 0, left edge
  at or past the document's scroll width, or top at or past its scroll height, for example
  `left: -9999px`). One finding for each element, at its first stop.
- **The skip-link rule:** because the check runs after focus lands and transitions finish, a skip link
  that sits off the page until it has focus and then slides in is read where it settles, in view, and is
  not reported.
- **Not measured yet:** an element covered by another one.
- **Bench:** no seed yet. Fixture `tab/order.html` (`#faint`, `#away`).

### `interaction.focus-trap` (high)

- **Measured:** whether Tab can move focus on.
- **Threshold:** a finding when the same element keeps focus for three presses in a row
  (`TRAP_REPEATS`), on a screen with more than one focusable control. "The same" means the same
  selector and the same control inside its open shadow roots, so the controls inside a web component
  with an open shadow root are told apart.
- **Exemptions** (focus moves while the active element stays the same, which is not a trap): an
  `<iframe>`, whose own controls Tab moves through; a native control the browser draws in parts
  (a `date`, `time`, `datetime-local`, `month` or `week` input, and a `<video>` or `<audio>` with
  controls); a custom element (a tag with a hyphen), whose closed shadow root hides where focus is; the
  development overlay.
- **Bench:** no seed yet. Fixture `tab/trap.html`.

## The viewport sweep

The sweep measures the screen at each viewport in `viewports` in the config (by default `desktop`
1440×900, then `mobile` 390×844). Viewport names must be unique: a finding's key holds the name.

- **How.** The first viewport is the one the screen was captured at: it is measured as the page is,
  without a reload. For each further viewport the page is resized (`page.setViewportSize`) and the
  screen's own URL reloaded (`page.reload`, waiting for `load`). Before each measurement the page's
  fonts are given up to 2 s to load and its transitions are finished. The measurement runs in the page
  over the first 5000 elements in `<body>`, reading `document.documentElement.scrollWidth` and
  `clientWidth`, each element's `getBoundingClientRect()`, its computed overflow, white-space and
  text-overflow, and its `scrollWidth` and `clientWidth`. If the page was reloaded at a further viewport,
  the first viewport is put back and the page reloaded at it once the sweep is done, so whatever measures
  next finds it as it was captured.
- **Only the screen's own URL.** If a reload lands on another URL (the session expired, the screen
  moved), or the URL changed in the page while it was being measured (a client-side route change, which
  counts at the capture viewport too), what was measured there is dropped and that viewport and every
  one after it are counted as `viewport-reload-redirected`. The sweep then stops: only the first
  viewport's size is put back, and the page is not reloaded again. URLs are compared without their
  hash or a trailing slash, with the query parameters in any order.
- **Skips:** `viewport-reload-redirected`, and `time-budget` for the viewports the deadline left out.

### `interaction.horizontal-overflow` (high)

- **Threshold:** a finding for the viewport when the document is wider than it by more than 1 px
  (`scrollWidth > clientWidth + 1`).
- **Occurrences:** the 5 elements whose border box reaches furthest past the viewport's width (by more
  than 1 px), furthest first. An element is passed over when the page does not scroll for its overflow:
  it is inside a box that scrolls or clips sideways itself (`overflow-x` other than `visible`, such as a
  table's scrolling wrapper or a carousel track), or it is `position: fixed` or inside a fixed box. When
  no element's box reaches past (a pseudo-element, say), the finding has one occurrence for the page.
- **One finding per viewport** (key `<route>|<viewport name>`), with a full-page screenshot taken at
  that viewport as evidence.
- **Wording:** the finding says the page "scrolls sideways". When the root has `overflow-x: hidden`,
  the page cannot scroll and the content past the edge is cut off instead; the measurement is the same.
- **Bench:** `interaction-006`, the Organisations table (at least 720 px wide in a wrapper that no
  longer scrolls), at the `mobile` viewport.

### `interaction.text-clipped` (medium)

- **Threshold:** a finding for the viewport when an element cuts its own text off without saying so:
  `overflow-x` `hidden` or `clip`, `white-space: nowrap`, no `text-overflow: ellipsis`, text of its own
  (text nodes directly inside it), and content wider than its box (`scrollWidth > clientWidth + 1`). The
  first 10 such elements are the occurrences.
- **Exemptions:** text hidden for screen readers only, which nobody sees cut off: an element whose
  border box is at most 1×1 px, or that has a `clip` other than `auto`, or a `clip-path` other than
  `none` (the `sr-only` utilities).
- **One finding per viewport** (key `<route>|<viewport name>|clipped`): text clipped at every width is
  reported once for each viewport.
- **Bench:** no seed yet. Fixtures `viewports/overflow.html` and `viewports/clipped-desktop.html`.

## Not measured yet

- **Disabled and loading states.** Disabled controls are recorded at rest only, and a loading state
  needs an action to show. Both wait for the behaviour lens.
- **Persisted state.** Comparing what a screen shows after a reload with what it claimed, and whether
  the screen agreed with the answers to its requests, need an action to compare against; they wait for
  the behaviour lens too.
- **Focus covered by another element**, and text contrast of text that is not part of a control.
- **Elements in iframes**, which are not in the main frame's accessibility tree.

## The observers

The observers run on every screen, before the lens, with no model: they report what the page did while
the screen loaded. Their source is `packages/core/src/observers/`.

**What a screen's record is.** Each observer keeps what the page reports in a buffer that is emptied at
every main-frame document navigation: what arrived before it belongs to a page that is gone (a lens
reload, a redirect, the previous screen). The navigation counts once the `framenavigated` event lands on
the URL that was requested (the hash aside). A same-document navigation (`pushState`, `replaceState`, a
hash change) keeps what was recorded. The page being left can still navigate within itself while the
next document loads (Next.js's router replaces its own history entry once a page has hydrated, and a
mount effect may log after `load`); the buffer waits for the requested document's own commit, so what
that page logs meanwhile is dropped with the rest of it instead of being reported on the next screen.
The answer to the document request itself is held across the commit, since a page that answers 500 is
the page. The observers collect each screen as soon as it is captured, before the lens runs, so what
the lens's reloads produce is never reported.

### Console

- **Rules:** `observers.console-error` for `console.error`, `observers.page-error` for an uncaught
  exception (Playwright's `pageerror`, reported as `name: message` without the stack), and
  `observers.console-warning` for `console.warn`, which is worth a look only.
- **Grouping:** messages that say the same thing are one finding. The key is the message with URLs
  replaced by `<url>`, numbers by `#` and runs of whitespace by one space, cut to 200 characters. The
  same message on one screen is one occurrence with a `count`; on several screens, one finding with an
  occurrence per screen.
- **Noise that is never reported** (`IGNORED_CONSOLE_PATTERNS`): messages starting `[Fast Refresh]`,
  `Download the React DevTools`, `[HMR]` or `%cNext.js`; anything logged from a `chrome-extension://`
  location (a password manager, an ad blocker); and Chromium's own `Failed to load resource: …` line
  for every failed request, which the request observer reports with the method, URL and status (the
  console would report each failure twice, and report the requests Lookover blocks itself as the app's).
- **Next.js's development overlay.** After a page logs an error, `next dev` shows an issues badge
  inside a `nextjs-portal` element, even with `devIndicators: false`. Its controls are the dev server's,
  not the app's, so the Tab walk leaves them out (`dev-overlay`, above).
- **Limits:** 500 entries per screen (the rest are counted as `dropped`), 2000 characters per message,
  redacted before it is cut. Evidence: `console-<screenId>.json` with every entry kept.

### Requests

- **Rules:** `observers.request-server-error` for an answer of 500 or more,
  `observers.request-client-error` for 400 to 499, `observers.request-network-error` for a request that
  never got an answer.
- **Not reported:** the requests Lookover aborts itself, whose failure is `net::ERR_ABORTED`,
  `net::ERR_BLOCKED_BY_CLIENT` or `net::ERR_FAILED`, with or without the `.Inspector` suffix a request
  aborted through the protocol carries (`net::ERR_ABORTED` is also what the page's own cancelled request
  reports, which is no failure); a 4xx for `/favicon.ico` or anything under `/.well-known/`, which the
  browser and its tooling ask for on their own.
- **Grouping:** the key is the method, the host (with its port) and the URL's path as a route pattern,
  then the status or the failure (`GET localhost:3123/api/stats → 500`), so `/api/items/1` and
  `/api/items/2` are one finding.
- **Evidence:** every screen gets its complete request record, `requests-<screenId>.json`, the requests
  that are no finding included: method, URL (redacted, then cut to 2000 characters), status, resource
  type, failure and duration. At most 500 requests per screen; the rest are counted as `dropped`.

### Rendered text

The text observer reads the text nodes of `<body>` in document order once the screen has loaded,
passing over text inside `code`, `pre`, `kbd`, `samp`, `textarea` and `option`, inside `script`,
`style`, `noscript` and `template`, and text nobody can see (`checkVisibility` with visibility and
opacity). Each text node is trimmed and tested whole:

- **`observers.raw-value`:** the text is exactly `undefined`, `null`, `NaN`, `[object Object]`,
  `Infinity` or `-Infinity`; or it contains `[object Object]` or the word `NaN`; or it ends with the
  word `undefined` (`Last edited by undefined`). `undefined` counts only at the end of a text, so prose
  that uses the word is left alone.
- **`observers.unresolved-placeholder`:** the text contains a placeholder in either of two forms:
  double braces around a name or dotted path (`{{name}}`, `{{ user.name }}`), or single braces around a
  name that starts with a letter or `_` and is not preceded by a letter, digit, `_` or `$` (`{count}`, but
  not `${count}`).
- **`observers.raw-i18n-key`:** the whole text is a translation key: it matches
  `^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$` (three or more dot-separated parts, each starting
  with a letter, the first in lowercase, so `v1.2.3` is not one), and its last part is not one of
  `com`, `org`, `net`, `io`, `dev`, `app`, `co`, `uk`, `de`, `kr`, `mn`, `jp`, `js`, `ts`, `jsx`, `tsx`,
  `json`, `md`, `html`, `css`, `png`, `jpg`, `jpeg`, `svg`, `gif` (so `docs.example.com` and
  `app.config.json` are left alone).
- **Grouping:** the key is the kind and the first 120 characters of the text; the occurrence's selector
  is the text node's parent element. At most 50 hits per screen, each stored redacted and cut to 500
  characters. Evidence: `text-<screenId>.json`.

### Bench seeds for the observers

| Seed | Rule | What the bench does |
| --- | --- | --- |
| `observers-001` | `observers.console-error` | `/reports` logs `Report locale missing: falling back to en` when its report dialog mounts |
| `observers-002` | `observers.raw-i18n-key` | `/settings` shows `settings.timezone.hint` as the time zone hint |
| `observers-003` | `observers.raw-value` | `/organisations/[id]` shows `Last edited by undefined` |
| `observers-004` | `observers.request-server-error` | `/` asks `/api/stats` for live stats and gets a 500 |
