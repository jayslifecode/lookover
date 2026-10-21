import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { saveOrganisationAction } from '@/app/organisations/actions';
import { OrganisationForm } from '@/components/organisation-form';
import { HEADING } from '@/components/styles';
import { getOrganisation } from '@/lib/store';
import { parseId } from '@/lib/validation';

export const metadata: Metadata = { title: 'Edit organisation' };

interface EditOrganisationPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditOrganisationPage({ params }: EditOrganisationPageProps) {
  const id = parseId((await params).id);
  const organisation = id === null ? null : await getOrganisation(id);
  if (organisation === null) {
    notFound();
  }
  const { id: organisationId, ...values } = organisation;
  return (
    <div className="space-y-6">
      <h1 className={HEADING}>Edit {organisation.name}</h1>
      <OrganisationForm
        action={saveOrganisationAction.bind(null, organisationId)}
        initialState={{ values, errors: {} }}
      />
      <p id="last-edited" className="text-sm text-slate-600">
        {`Last edited by ${organisation.editor}`}
      </p>
    </div>
  );
}
