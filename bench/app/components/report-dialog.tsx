'use client';

import { useEffect, useRef } from 'react';
import type { RegistrationSummary } from '@/lib/summary';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './styles';

export function ReportDialog({ summary }: { summary: RegistrationSummary }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    console.error('Report locale missing: falling back to en');
  }, []);
  return (
    <>
      <button type="button" className={BUTTON_PRIMARY} onClick={() => dialogRef.current?.showModal()}>
        Open summary report
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="report-title"
        className="m-auto w-full max-w-md rounded-lg p-6 text-slate-900 shadow-xl backdrop:bg-slate-900/40"
      >
        <h2 id="report-title" className="text-lg font-semibold">
          Summary report
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-600">Organisations</dt>
          <dd>{summary.organisationCount}</dd>
          <dt className="text-slate-600">First registration</dt>
          <dd>{summary.firstRegistration}</dd>
          <dt className="text-slate-600">Latest registration</dt>
          <dd>{summary.latestRegistration}</dd>
        </dl>
        <div className="mt-6 flex justify-end">
          <button type="button" className={BUTTON_SECONDARY} onClick={() => dialogRef.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
