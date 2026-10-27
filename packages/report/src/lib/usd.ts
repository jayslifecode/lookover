/** Dollars are shown to the cent everywhere, as the CLI's `Judge` row shows them. */
const USD_DECIMALS = 2;

/** An estimated cost in US dollars as the report shows it: `$0.19`. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(USD_DECIMALS)}`;
}
