# The report's design

The report is the page `lookover run` opens while it works and `lookover report` serves afterwards. It
is built for people who are not engineers as much as for people who are, so it reads like a document
and moves only to answer what you did. This page describes how it looks and moves as built, the numbers
behind it and how they were measured. The design decisions are in
[spec §11](superpowers/specs/2026-10-20-lookover-design.md#11-report-design-decided-by-the-author-dark-navy-and-black-theme-light-and-dark-modes-glass-used-as-a-showcase-not-everywhere);
the motion study they were settled in is
[`2026-10-20-report-motion-study.html`](superpowers/specs/2026-10-20-report-motion-study.html).

![The report in the dark theme: the dashboard screen with a pinned finding open in the panel](images/report-dark.png)

The source is `packages/report/src/`: the tokens in `theme/tokens.css`, the glass in `glass/`, the motion
in `motion/`. The report is React with Tailwind CSS v4 and shadcn components, built by Vite to static
files that the CLI serves; it loads nothing from anywhere but its own server.

## Two palettes

Two designed palettes, not one inverted: deep navy to near-black in the dark theme, cool off-white in the
light one, with the same blue accent darkened for light. The tokens are CSS custom properties under
`[data-theme="dark"]` and `[data-theme="light"]` on `<html>`, mapped into Tailwind with `@theme inline`
(so `bg-bg-1`, or shadcn's `bg-primary`, follows the theme without a `dark:` variant). The screenshots of
your app keep their own colours in both.

| Token | Dark | Light | What it is |
| --- | --- | --- | --- |
| `--bg-0` | `#060a13` | `#eef1f7` | The page |
| `--bg-1` | `#0b1222` | `#f6f8fc` | Solid surfaces |
| `--bg-2` | `#111b31` | `#ffffff` | Raised solid surfaces, popovers, glass made solid |
| `--line` | `rgba(148, 163, 184, 0.14)` | `rgba(15, 23, 42, 0.1)` | Borders |
| `--line-strong` | `rgba(148, 163, 184, 0.26)` | `rgba(15, 23, 42, 0.18)` | Outlined buttons, inputs |
| `--ink` | `#e7ebf3` | `#0f172a` | Text, and the only ink on glass |
| `--ink-2` | `#9aa7bd` | `#475569` | Secondary text on solid surfaces |
| `--ink-3` | `#6b7890` | `#7a879c` | Tertiary text |
| `--accent` | `#5b8def` | `#2f6be0` | The accent, focus rings, links |
| `--accent-ink` | `#0b1222` | `#ffffff` | Text on the accent |
| `--high` | `#f0616d` | `#c8323f` | Severity high (coral) |
| `--medium` | `#efb75a` | `#b4730b` | Severity medium (amber) |
| `--low` | `#7dd3a8` | `#1e8a5a` | Severity low (mint) |
| `--pass` | `#34c38f` | `#1a8a56` | Passed |
| `--on-high` | `#060a13` | `#ffffff` | The number on a high pin (6.3:1 dark, 5.3:1 light) |
| `--on-medium` | `#060a13` | `#060a13` | The number on a medium pin (10.9:1, 5.1:1) |
| `--on-low` | `#060a13` | `#000000` | The number on a low pin (11.1:1, 4.8:1) |
| `--glass-tint` | `rgba(11, 18, 34, 0.8)` | `rgba(255, 255, 255, 0.58)` | The glass fill |
| `--glass-edge` | `rgba(255, 255, 255, 0.14)` | `rgba(255, 255, 255, 0.9)` | The glass's 1 px edge |
| `--glass-sheen` | `rgba(255, 255, 255, 0.08)` | `rgba(255, 255, 255, 0.55)` | The sheen along its top |
| `--glass-spot` | `rgba(255, 255, 255, 0.12)` | `rgba(255, 255, 255, 0.8)` | The highlight under the pointer |
| `--glass-shadow` | `0 24px 70px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(255, 255, 255, 0.05) inset` | `0 24px 60px rgba(15, 23, 42, 0.16), 0 1px 0 rgba(255, 255, 255, 0.9) inset` | The glass's shadow |
| `--glow-a` | `rgba(91, 141, 239, 0.2)` | `rgba(47, 107, 224, 0.16)` | The blue glow behind the page |
| `--glow-b` | `rgba(129, 96, 255, 0.14)` | `rgba(129, 96, 255, 0.12)` | The violet glow |
| `--pill-edge` | the accent at 58 % | the accent at 45 % | The liquid pill's edge (`color-mix`) |
| `--pill-a`, `--pill-b` | the accent at 36 % and 22 % | the accent at 22 % and 14 %, over white | The pill's fill |

Besides the colours, `@theme inline` sets the fonts, three radii (`--radius-sm` 5 px, `--radius-md`
8 px, `--radius-lg` 18 px) and two easings (`--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)` and
`--ease-spring` `cubic-bezier(0.22, 1.25, 0.36, 1)`).

**The theme** follows the system (`prefers-color-scheme`, dark when the browser cannot say) until you
pick one with the toggle in the top bar; your choice is kept in `localStorage` under `lookover.theme`
and holds across reloads.

**The dark glass tint is 0.8, not the study's 0.55.** Text on glass must hold 4.5:1 over the lightest
and the darkest content the glass can float over, and the spec says to raise the tint until it does.
Over pure white, `--ink` on the 0.55 tint measured 3.47:1, and 2.5:1 with the sheen and the pointer's
highlight at full strength; at 0.8 it holds 4.85:1 with both. In the light theme, `--ink` on the 0.58
tint holds 5.9:1 over pure black (16:1 with the sheen and the highlight). Text on glass uses `--ink`
only, which is why the view switcher's unselected tabs are `--ink` rather than a dimmer grey.

## Glass, on three surfaces

Glass is for layers that float over content, never for anything read in bulk. Exactly three surfaces are
glass:

1. **The top bar**, which floats over the page: the run, the view switcher, the run's state, the cost
   readout and the theme toggle.
2. **The finding panel**, which floats beside the screenshot (from 1280 px wide; below that it sits in
   the page's flow).
3. **The toast** ("Fix prompt copied", or why a copy or a decision failed), the only glass that enters
   and leaves. Every toast has the same id, so a new one replaces the one on screen instead of stacking
   a fourth layer.

Everything else is solid: the screen list, the screenshot's frame, the scorecard, the gallery, the
Findings and Drift views, the pins' labels and the cluster popover, the enlarged-picture dialog. The pins
themselves are tinted dots with a light edge and a shadow, without a backdrop blur, and the copy of the
panel that grows out of a pin (below) is a solid tint. The spec first listed the pins as the third glass
surface; but a screen has a pin per pinned finding, and glass pins alone would break the limit of three
layers, so the toast took their place.

**The budget.** In a development build, a watcher (`glass/budget.ts`) counts the mounted glass surfaces
(each marks itself with `data-glass`) and throws as soon as there are more than three. The end-to-end
suite asserts three during its frame measurement.

**How one is built** (`glass/glass.css`, `glass/glass.tsx`):

- The tint, `backdrop-filter: blur(18px) saturate(170%)`, the 1 px edge, a sheen gradient over the top
  42 % of the surface and the shadow. The blur is never above 18 px.
- Each surface is isolated (`isolation: isolate; contain: paint`).
- The highlight that follows the pointer is a fixed 260 × 180 px radial gradient moved with
  `translate3d`, once per animation frame however many pointer events arrive, and faded in on hover.
  The blurred surface under it never re-renders.

### The panel's edge refraction

In Chromium the finding panel also refracts the page behind its top edge, through a static SVG
displacement (`#lens`: fractal noise at a base frequency of 0.010 × 0.018, two octaves, blurred by 1.2
and applied with `feDisplacementMap` at a scale of 7). It is applied with `backdrop-filter: url(#lens)`,
which only Chromium supports, so the report checks `CSS.supports` and shows the frosted look elsewhere.

The refraction covers a 40 px band along the panel's top edge, not the whole panel. Displacing the whole
380 × 800 px panel averaged 26.7 to 27.9 ms per frame during the pin-to-panel transform in CI's
software-rendered Chromium, which drops every other frame; the spec asks for refraction on the edge and
on small surfaces only.

The band is built outside the frosted layer. An element with a backdrop filter is the backdrop root of
everything inside it, so a refracting band inside the frosted panel would bend only the panel's own
blurred picture, which shows nothing. Instead the panel itself filters nothing: two layers under its
content each filter the page behind them, side by side, the 40 px band (blur, saturate and `#lens`) and
the frosted body below it. An end-to-end test proves the band bends the page: it puts black and white
stripes behind the report, screenshots the band with and without `#lens`, and counts the pixels that
flipped (156 of the band's 14,364 in the last measurement; the test asks for more than 50, and two
screenshots without the filter must not differ at all). With the band, the transform averages 17.6 ms
per frame, so the refraction stays.

### How glass degrades

| When | What the glass becomes |
| --- | --- |
| The browser has no `backdrop-filter` | Solid `--bg-2` (an `@supports not` rule, before any script runs); the band and the frosted body are hidden. |
| The browser cannot apply `url(#lens)` (anything but Chromium) | Frosted, without the band. |
| `prefers-reduced-transparency: reduce` | Solid `--bg-2`, no blur, no highlight, no band. |
| `prefers-reduced-motion: reduce` | The same as reduced transparency, and nothing animates (below). |

The end-to-end suite checks both preferences: under reduced transparency every glass surface, the toast
included, reports itself `solid` and draws no backdrop filter; under reduced motion no glass surface
draws one, and nothing animates while a pin is chosen.

### Focus on glass

Every control shows keyboard focus with a 2 px `--accent` outline, 2 px off the control. A control on
glass, or a pin, which can float over any colour, adds a halo of `--bg-2` under the outline
(`box-shadow: 0 0 0 4px var(--bg-2)`), so the ring is two-tone and keeps 3:1 against whatever is behind
the glass.

## Motion

Motion answers an action or shows a change of state. Nothing moves on its own except the dot that pulses
while the run is going. Under `prefers-reduced-motion` nothing animates at all: a global rule turns every
animation and transition off, and each moment below jumps to its end.

| Moment | What moves | Numbers |
| --- | --- | --- |
| The view switcher's pill | A pill under the selected tab, Screens, Findings or Drift, travels to the tab you pick | See "The liquid pill" |
| A pin pressed | The dot bounces | Scale 1 → 0.86 (at 30 %) → 1.18 (at 62 %) → 1, 460 ms, a Web Animation of `transform` |
| A pin selected | A ring around the dot fades in | A pseudo-element's `opacity`, 200 ms |
| A pin hovered or focused | Its label rises into place | 6 px and `opacity`, 200 ms, `--ease-out` |
| A finding chosen from a pin | The panel grows out of the pin | See "The container transform" |
| The theme switched | The new theme is revealed in a circle | See "The theme reveal" |
| Glass under the pointer | The highlight follows it | `translate3d` once per frame; fades in over 250 ms |
| A toast | Slides in and out | Sonner's own `transform` and `opacity`; it stays 4 s |
| The run going on | The live dot pulses | Its own element; none under reduced motion |

### The liquid pill

The view switcher (`motion/use-liquid-pill.ts`) is the motion study's v10 pill, measured in Playwright
before it was built:

- **Two edges, two springs.** The pill's left and right edges are springs of their own, integrated
  semi-implicitly (Euler), two substeps per frame, a frame counted as at most 32 ms. The edge facing the
  destination leads (stiffness 420, damping 30) and the other trails (230, 24), so the pill stretches on
  the way and contracts as it lands. It settles in about 400 ms (lead) and 650 ms (trail).
- **Round caps that never squash.** The pill is a full-width layer clipped to its two edges with
  `clip-path: inset(0 R 0 L round 999px)`, over a fill inset by 1 px for the edge line. Clipping keeps the
  caps round at any width; scaling a fixed-width pill would flatten them.
- **Lift.** While it travels the pill lifts 4 % with a soft `drop-shadow`, and lands when both edges are
  within 1.5 px; a move under 6 px is not a travel. The highlight on it trails the direction of travel by
  up to 10 px. Pressed and held, it lifts 6 % and squashes 4 % (a spring of stiffness 380, damping 22).
- **Drag.** A drag starts after 5 px; the pill follows the pointer, and the release projects its velocity
  80 ms ahead and snaps to the nearest tab. A click selects at once.
- **Hover.** At rest the pill leans toward the pointer, a twelfth of the distance and at most 6 px.
- **Bent content.** The tabs within 80 px of the pill's centre lean up to 2 px toward it, rise up to
  1 px and grow up to 4 %, the nearer the more.
- **Targets from layout.** The edges aim at `offsetLeft` and `offsetWidth`, never at
  `getBoundingClientRect`, because the tabs under the pill are transformed.
- **Only your choice travels.** A tab you click or pick with the keyboard (arrows wrap, Home and End
  work) travels; a change of view that came from elsewhere, such as the back button, jumps.

### The container transform

Choosing a finding from a pin grows the panel out of that pin (`motion/container-transform.ts`), and
the panel is never empty on the way:

1. A copy of the panel, already rendered with the new finding (the ghost, a solid tint with no blur), is
   placed over the panel.
2. The ghost animates `transform` and `clip-path` over 560 ms through three keyframes: from the pin's box
   with `inset(0 round 999px)` (easing `cubic-bezier(.2,.8,.2,1)`); at half time 86 % of the way there,
   at 88 % of the width and 84 % of the height, `round 34px` (easing `cubic-bezier(.22,1.2,.36,1)`); and
   onto the panel, `round 18px`.
3. Its content fades in from 28 % to 70 % of the way, while the panel's old content fades out and rises
   4 px in 130 ms.
4. When the ghost lands, the new finding is swapped into the real panel, the old content's fade is undone
   two frames later, and the ghost fades out in 150 ms.

The panel's glass never moves, resizes or changes its filter during all this: from 1280 px wide it is a
fixed box, 380 px wide and the window's height less 100 px, stuck 84 px from the top, under the top bar,
its body scrolling inside. One transform runs at a time; a new one lands the running one at once. It also runs
from the run summary and from a finding that has no pin, and only where the panel floats.

### The theme reveal

The theme toggle switches with the View Transitions API: the new theme is revealed in a circle growing
from the pointer (or from the middle of the toggle when the keyboard pressed it) to the farthest corner
of the window, over 620 ms with `cubic-bezier(.2,.8,.2,1)`. Without the API, or under reduced motion, the
theme switches at once. The spec's baseline notes one frame of about 33 ms as the transition snapshots
the page, while the circle's radius is still zero.

### Smoothness rules

From spec §11, as the report follows them:

1. A blurred glass layer never changes size, position, blur or filter while it is visible.
2. Everything that moves is a separate element animated with `transform` and `opacity` only: the
   pointer's highlight, the pill, the ghost, the pin's dot. Rings and glows are pseudo-elements faded with
   `opacity`, never animated `box-shadow`.
3. Each glass surface is its own layer (`isolation: isolate; contain: paint`); `will-change` only on what
   animates; pointer handlers update once per frame.
4. The refraction filter is static. Animating `feDisplacementMap` re-filters the backdrop every frame.
5. Blur at most 18 px, at most three glass layers, and the toast the only glass that enters or leaves.
6. The frame budget is measured in CI (below).

### The frame budget, measured

`packages/cli/test/e2e/report-motion.test.ts` serves the report's fixture run through the real report
server, opens it in Chromium at 1440 × 900 with the three glass layers on screen (the top bar, the panel
and a toast), and records the time between `requestAnimationFrame` callbacks, as the motion study
measured its baseline, during two interactions: three travels of the pill from one end of the switcher
to the other, and one pin-to-panel transform.

| | Average frame | Worst frame | Frames over 34 ms | Frames over 60 ms |
| --- | --- | --- | --- | --- |
| Motion study baseline (GPU) | 16.67 ms | 18.7 ms | 0 | 0 |
| Pill travel (headless, software-rendered Chromium) | 16.67 ms | 16.8 ms | 0 | 0 |
| Pin-to-panel transform (the same) | 17.61 ms | 33.3 ms | 0 | 0 |

CI fails an interaction with more than one frame over 34 ms (two frames at 60 Hz, a dropped frame you can
see) or any frame over 60 ms, and keeps the measured frames as the `report-frames` artifact
(`frames.json`) on every run, passing or not. The same suite checks that under reduced motion nothing
animates while a pin is chosen, frame by frame.

## Type

Manrope for the interface, JetBrains Mono for selectors,
measurements, ids and code. Both are self-hosted from `@fontsource-variable` packages, bundled into the
report's build: the report must make no request to any other origin, so it cannot use a font CDN. Two
small subsets are inlined into the stylesheet as `data:` URIs by Vite, which the report server's
Content-Security-Policy allows (`font-src 'self' data:`).

## Lookover reviewing its own report

The report must pass Lookover's own interaction lens. `packages/cli/test/e2e/report-dogfood.test.ts`
serves the fixture run, points a project at it (logged in with a storage state holding the report's
token cookie) and runs `lookover run --no-judge` in `safe` mode against it: 1 screen, 0 candidates, and 2
worth-a-look entries for hover feedback, which is not a finding.

## References

From spec §11:

- The SVG displacement approach and its Chromium-only caveat:
  [webdesign.tutsplus.com](https://webdesign.tutsplus.com/liquid-glass-effect-svg-filters--cms-109200t),
  [dev.to: six ways to build liquid glass](https://dev.to/devyatov/liquid-glass-on-the-web-6-ways-to-build-it-with-css-and-svg-3m07),
  [webtricks.dev](https://webtricks.dev/blog/liquid-glass-css),
  [html-in-canvas.dev](https://html-in-canvas.dev/liquid-glass-effect/).
- Contrast, reduced transparency and the GPU cost of stacked `backdrop-filter`:
  [neelnetworks](https://www.neelnetworks.com/blog/glassmorphism-web-design-guide-2026/),
  [euleinstitute](https://euleinstitute.com/en/blog/glassmorphism/),
  [axonixtools](https://axonixtools.com/blog/glassmorphism-in-2026-css-guide/).
- Tailwind v4 and shadcn theming with tokens and `@theme inline`:
  [designrevision dark theme](https://designrevision.com/shadcn-themes/dark.md),
  [tailwind-v4-shadcn skill](https://skills.sh/site/smithery.ai/tailwind-v4-shadcn).
- SVG displacement over live DOM, which keeps text selectable:
  [samasante/liquid-glass](https://github.com/samasante/liquid-glass),
  [PallavAg/liquid-glass-web-react](https://github.com/PallavAg/liquid-glass-web-react); spring physics
  on glass: [benis-me/react-liquid-glass](https://github.com/benis-me/react-liquid-glass).
  `dashersw/liquid-glass-js` (WebGL and html2canvas) was evaluated and rejected: it rasterises the page
  to refract it.
