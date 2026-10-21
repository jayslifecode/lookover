# Rules

This file is generated from the catalogues in `packages/rules/catalogue` by `pnpm docs:rules`. Do not edit it by hand: change the catalogue and run the command again, and `pnpm check` fails while the two disagree. Every finding Lookover reports names one of these rules.

## Interaction

| id | severity | title | expected | reference |
| --- | --- | --- | --- | --- |
| `interaction.focus-trap` | high | Keyboard focus gets stuck | Tab always moves focus on and Shift+Tab always moves it back, so no one gets stuck on a single control. | [WCAG 2.2 · 2.1.2 No Keyboard Trap](https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html) |
| `interaction.focus-visible-missing` | high | Keyboard focus is not visible | When you press Tab, the control that receives focus shows a clear outline or highlight. | [WCAG 2.2 · 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) |
| `interaction.horizontal-overflow` | high | The page scrolls sideways at this screen size | The page fits the width of the screen, so you never have to scroll sideways to read it, apart from things like wide tables that scroll inside their own box. | [WCAG 2.2 · 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) |
| `interaction.keyboard-unreachable` | high | Control cannot be reached with the keyboard | Everything you can click can also be reached with the Tab key and used with Enter or Space. | [WCAG 2.2 · 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) |
| `interaction.text-contrast-fail` | high | Text is unreadable against its background | Text has a contrast ratio of at least 4.5 to 1 against its background, or 3 to 1 when the text is large. | [WCAG 2.2 · 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| `interaction.focus-hidden` | medium | Keyboard focus lands on something that cannot be seen | Every control that Tab lands on can be seen on screen, and is not invisible, off screen or covered by something else. | [WCAG 2.2 · 2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) |
| `interaction.focus-indicator-contrast` | medium | The focus indicator is too faint | The focus mark is easy to tell apart from what is behind it, with a contrast ratio of at least 3 to 1. | [WCAG 2.2 · 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |
| `interaction.target-size` | medium | Tap target is smaller than 24 by 24 pixels | Every button, link and field is at least 24 by 24 pixels, or has enough empty space around it to be tapped without hitting a neighbour. | [WCAG 2.2 · 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) |
| `interaction.text-clipped` | medium | Text is cut off without an ellipsis | Text that does not fit its box wraps onto more lines or ends with an ellipsis, so it never just stops. | — |
| `interaction.text-contrast-low` | medium | Text contrast is below the minimum | Text has a contrast ratio of at least 4.5 to 1 against its background, or 3 to 1 when the text is large. | [WCAG 2.2 · 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| `interaction.hover-state-missing` | low | No hover feedback on a clickable control | A button or link looks different when the pointer is over it, for example a new background colour, an underline or a shadow. | — |
| `interaction.positive-tabindex` | low | A positive tabindex forces a custom focus order | Tab moves through the page in the order things appear on screen, with no tabindex above 0 forcing a different order. | [WCAG 2.2 · 2.4.3 Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) |

## Observers

| id | severity | title | expected | reference |
| --- | --- | --- | --- | --- |
| `observers.page-error` | high | The page threw an error that nothing caught | The page runs without throwing an error that nothing handles. | — |
| `observers.raw-value` | high | A placeholder value leaked into the page | The page never shows internal placeholder values such as undefined, null, NaN or [object Object] as text. | — |
| `observers.request-network-error` | high | A request the page made never got an answer | Every request the page makes gets an answer from a server. | — |
| `observers.request-server-error` | high | A request the page made failed on the server | Every request the page makes is answered without a server error, that is, without a status of 500 or higher. | — |
| `observers.console-error` | medium | The page logged an error to the console | The browser console stays free of errors while the page loads and is used. | — |
| `observers.raw-i18n-key` | medium | A translation key is shown instead of its text | The page shows readable text, not translation keys such as settings.timezone.hint. | — |
| `observers.request-client-error` | medium | A request the page made was rejected | Every request the page makes is accepted by the server, with no rejection such as not found (404), not allowed (403) or bad request (400). | — |
| `observers.unresolved-placeholder` | medium | A template placeholder was not filled in | The page never shows template placeholders such as {{name}} or {count} that were meant to be replaced with real values. | — |
| `observers.console-warning` | low | The page logged a warning | The browser console stays free of warnings while the page loads and is used. | — |
