import type { Metadata } from 'next';
import Link from 'next/link';
import { HEADING, LINK } from '@/components/styles';
import { listOrganisations } from '@/lib/store';
import { summarise } from '@/lib/summary';

export const metadata: Metadata = { title: 'Dashboard' };

const SHORTCUTS: readonly { href: string; label: string; description: string }[] = [
  { href: '/organisations', label: 'Organisations', description: 'Browse and edit every organisation.' },
  { href: '/organisations/new', label: 'New organisation', description: 'Register another organisation.' },
  { href: '/reports', label: 'Reports', description: 'Open the summary report.' },
  { href: '/settings', label: 'Settings', description: 'Change the workspace settings.' },
];

export default async function DashboardPage() {
  const summary = summarise(await listOrganisations());
  return (
    <div className="space-y-8">
      <h1 className={HEADING}>Dashboard</h1>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <dt className="text-sm text-slate-600">Organisations</dt>
          <dd className="mt-1 text-3xl font-semibold">{summary.organisationCount}</dd>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <dt className="text-sm text-slate-600">Latest registration</dt>
          <dd className="mt-1 text-3xl font-semibold">{summary.latestRegistration}</dd>
        </div>
      </dl>
      <section aria-labelledby="shortcuts-heading" className="space-y-3">
        <h2 id="shortcuts-heading" className="text-lg font-semibold">
          Go to
        </h2>
        <ul className="space-y-2">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.href}>
              <Link href={shortcut.href} className={LINK}>
                {shortcut.label}
              </Link>
              <span className="text-slate-600"> — {shortcut.description}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
