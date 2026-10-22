import type { Severity } from '@jayslifecode/lookover-core';
import { type ReactNode, useId } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SEVERITY_ORDER } from '@/data/selectors';
import { cn } from '@/lib/utils';
import { SEVERITY_DOT, SEVERITY_LABEL } from '@/screens/severity';
import { type FindingFilters, LENS_FILTERS, type LensFilter, type StatusFilter, toggled } from './filter';

/*
 * The Findings view's filter bar, a solid surface: severity and lens as toggle buttons (several at once;
 * none pressed shows all), the status as a choice of two (Confirmed or Intended), the Worth a look switch,
 * and the search. Every control is at least 28 px tall.
 */

export interface FindingsFiltersProps {
  readonly filters: FindingFilters;
  readonly onChange: (filters: FindingFilters) => void;
  readonly isWorthALookShown: boolean;
  readonly onWorthALookChange: (isShown: boolean) => void;
}

const LENS_LABEL: Readonly<Record<LensFilter, string>> = {
  interaction: 'Interaction',
  observers: 'Observers',
};
const STATUS_LABEL: Readonly<Record<StatusFilter, string>> = { confirmed: 'Confirmed', intended: 'Intended' };
const STATUSES: readonly StatusFilter[] = ['confirmed', 'intended'];
const CHIP =
  'inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] text-ink-2 hover:text-ink aria-pressed:border-accent aria-pressed:bg-[color-mix(in_oklab,var(--accent)_16%,var(--bg-1))] aria-pressed:text-ink';
const GROUP = 'flex flex-wrap items-center gap-1.5';
const GROUP_LABEL = 'mr-1 font-semibold text-[12px] text-ink-2';

function Chip({
  label,
  isPressed,
  marker,
  onPress,
}: {
  readonly label: string;
  readonly isPressed: boolean;
  readonly marker?: string;
  readonly onPress: () => void;
}) {
  return (
    <button type="button" aria-pressed={isPressed} className={CHIP} onClick={onPress}>
      {marker === undefined ? null : (
        <span aria-hidden="true" className={cn('size-2 rounded-full', marker)} />
      )}
      {label}
    </button>
  );
}

/** A row of toggle buttons named by its visible label. */
function ChipGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const labelId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset
    <div role="group" aria-labelledby={labelId} className={GROUP}>
      <span id={labelId} className={GROUP_LABEL}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function FindingsFilters({
  filters,
  onChange,
  isWorthALookShown,
  onWorthALookChange,
}: FindingsFiltersProps) {
  const toggleSeverity = (severity: Severity) =>
    onChange({ ...filters, severities: toggled(filters.severities, severity) });
  const toggleLens = (lens: LensFilter) => onChange({ ...filters, lenses: toggled(filters.lenses, lens) });
  const worthALookId = useId();
  return (
    <section aria-label="Filters" className="grid gap-2.5 rounded-lg border border-line bg-bg-1 p-3">
      <div className="flex flex-wrap gap-x-5 gap-y-2.5">
        <ChipGroup label="Severity">
          {SEVERITY_ORDER.map((severity) => (
            <Chip
              key={severity}
              label={SEVERITY_LABEL[severity]}
              marker={SEVERITY_DOT[severity]}
              isPressed={filters.severities.has(severity)}
              onPress={() => toggleSeverity(severity)}
            />
          ))}
        </ChipGroup>
        <ChipGroup label="Lens">
          {LENS_FILTERS.map((lens) => (
            <Chip
              key={lens}
              label={LENS_LABEL[lens]}
              isPressed={filters.lenses.has(lens)}
              onPress={() => toggleLens(lens)}
            />
          ))}
        </ChipGroup>
        <ChipGroup label="Status">
          {STATUSES.map((status) => (
            <Chip
              key={status}
              label={STATUS_LABEL[status]}
              isPressed={filters.status === status}
              onPress={() => onChange({ ...filters, status })}
            />
          ))}
        </ChipGroup>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Input
          type="search"
          aria-label="Search findings"
          placeholder="Search title, route or selector"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          className="h-8 min-w-0 flex-1 basis-56 bg-bg-2 text-[13px] text-ink"
        />
        <span className="inline-flex min-h-7 items-center gap-2 font-semibold text-[12.5px] text-ink">
          <Switch
            aria-labelledby={worthALookId}
            checked={isWorthALookShown}
            onCheckedChange={onWorthALookChange}
          />
          <span id={worthALookId}>Worth a look</span>
        </span>
      </div>
    </section>
  );
}
