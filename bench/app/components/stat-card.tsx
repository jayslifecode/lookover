'use client';

import { useState } from 'react';

interface StatCardProps {
  /** Becomes `data-testid`, so the card has a selector that survives layout changes. */
  testId: string;
  label: string;
  value: string | number;
  /** Shown under the figure while the card is open. */
  detail: string;
}

/** A dashboard figure that shows or hides a line of detail when it is clicked. */
export function StatCard({ testId, label, value, detail }: StatCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    // Seeded issue (interaction-004): a click target with no `tabIndex` and no key handler, so a keyboard
    // user cannot reach it. Biome's accessibility rules name the same defect, hence the suppressions.
    // biome-ignore lint/a11y/useFocusableInteractive: seeded issue interaction-004
    // biome-ignore lint/a11y/useKeyWithClickEvents: seeded issue interaction-004
    // biome-ignore lint/a11y/useSemanticElements: seeded issue interaction-004
    <div
      role="button"
      data-testid={testId}
      aria-expanded={isOpen}
      onClick={() => setIsOpen((open) => !open)}
      className="cursor-pointer rounded-lg border border-slate-200 bg-white p-4 hover:bg-slate-50"
    >
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-3xl font-semibold">{value}</p>
      {isOpen && <p className="mt-2 text-sm text-slate-600">{detail}</p>}
    </div>
  );
}
