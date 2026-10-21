import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyEmailButton } from '@/components/copy-email-button';
import { BUTTON_PRIMARY, HEADING, ICON_ACTION, LINK } from '@/components/styles';
import { listOrganisations } from '@/lib/store';
import { parseId } from '@/lib/validation';

export const metadata: Metadata = { title: 'Organisations' };

interface OrganisationsPageProps {
  searchParams: Promise<{ saved?: string | string[] }>;
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 14v-2.5L11.5 2 14 4.5 4.5 14z" />
    </svg>
  );
}

export default async function OrganisationsPage({ searchParams }: OrganisationsPageProps) {
  const { saved } = await searchParams;
  const organisations = await listOrganisations();
  const savedId = typeof saved === 'string' ? parseId(saved) : null;
  const savedOrganisation = organisations.find((org) => org.id === savedId);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className={HEADING}>Organisations</h1>
        <Link href="/organisations/new" className={BUTTON_PRIMARY}>
          New organisation
        </Link>
      </div>
      <p role="status" className="text-sm text-slate-700">
        {savedOrganisation === undefined ? null : `Saved ${savedOrganisation.name}.`}
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Phone
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Registered on
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {organisations.map((org) => (
              <tr key={org.id}>
                <td className="px-4 py-2">
                  <Link href={`/organisations/${org.id}`} className={LINK}>
                    {org.name}
                  </Link>
                </td>
                <td className="px-4 py-2">{org.phone}</td>
                <td className="px-4 py-2">{org.email}</td>
                <td className="px-4 py-2">{org.registeredAt}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/organisations/${org.id}`}
                      aria-label={`Edit ${org.name}`}
                      className={ICON_ACTION}
                    >
                      <PencilIcon />
                    </Link>
                    <CopyEmailButton name={org.name} email={org.email} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
