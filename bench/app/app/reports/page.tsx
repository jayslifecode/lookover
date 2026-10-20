import type { Metadata } from 'next';
import { ReportDialog } from '@/components/report-dialog';
import { HEADING } from '@/components/styles';
import { listOrganisations } from '@/lib/store';
import { summarise } from '@/lib/summary';

export const metadata: Metadata = { title: 'Reports' };

export default async function ReportsPage() {
  const summary = summarise(await listOrganisations());
  return (
    <div className="space-y-6">
      <h1 className={HEADING}>Reports</h1>
      <p className="text-slate-700">The summary report covers every registered organisation.</p>
      <ReportDialog summary={summary} />
    </div>
  );
}
