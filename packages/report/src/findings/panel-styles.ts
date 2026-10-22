/*
 * The finding panel's control styles. The panel is glass and floats over any content, so every control on
 * it draws the two-tone focus ring (the global 2 px accent outline over a 2 px halo of --bg-2, as on the
 * pins and the top bar), its text is --ink, and every target is at least 24 px tall.
 */

export const ON_GLASS_FOCUS = 'focus-visible:shadow-[0_0_0_4px_var(--bg-2)]';

const BUTTON_BASE = `h-8 rounded-[8px] px-3 font-semibold text-[12.5px] ${ON_GLASS_FOCUS}`;

/** The one main action: the accent fill with its own ink. */
export const PRIMARY_BUTTON = `${BUTTON_BASE} bg-accent text-accent-ink hover:bg-accent/85`;

/** Every other action: an outline in the strong line colour. */
export const SECONDARY_BUTTON = `${BUTTON_BASE} border border-line-strong bg-transparent text-ink hover:bg-muted hover:text-ink`;

/** A link on the glass: --ink, underlined. */
export const GLASS_LINK = `rounded-[3px] text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink ${ON_GLASS_FOCUS}`;

/** A section of the panel under the one above it. */
export const PANEL_SECTION = 'border-line border-t py-2.5';
