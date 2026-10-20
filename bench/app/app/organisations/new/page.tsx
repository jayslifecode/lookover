import type { Metadata } from 'next';
import { saveOrganisationAction } from '@/app/organisations/actions';
import { OrganisationForm } from '@/components/organisation-form';
import { HEADING } from '@/components/styles';

export const metadata: Metadata = { title: 'New organisation' };

const EMPTY_VALUES = { name: '', phone: '', email: '', registeredAt: '' };

export default function NewOrganisationPage() {
  return (
    <div className="space-y-6">
      <h1 className={HEADING}>New organisation</h1>
      <OrganisationForm
        action={saveOrganisationAction.bind(null, null)}
        initialState={{ values: EMPTY_VALUES, errors: {} }}
      />
    </div>
  );
}
