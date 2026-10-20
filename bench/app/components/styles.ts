/*
 * The class lists every screen shares, so the app keeps one look: one primary colour, one radius,
 * one control height. The focus ring is not here; `app/globals.css` gives every control the same one.
 *
 * Control borders are slate-500 (about 4.8:1 on white): the border is the only visible edge of an
 * input, so it needs 3:1 non-text contrast (WCAG 1.4.11). Links stay underlined at rest so they do
 * not rely on colour alone.
 */

export const BUTTON_PRIMARY =
  'inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-60';

export const BUTTON_SECONDARY =
  'inline-flex items-center rounded-md border border-slate-500 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100';

export const CONTROL =
  'block w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-sm text-slate-900 aria-[invalid=true]:border-red-700';

export const LINK = 'font-medium text-primary underline underline-offset-2 hover:decoration-2';

export const HEADING = 'text-2xl font-semibold tracking-tight';
