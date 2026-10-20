'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { OrganisationFormState } from '@/app/organisations/actions';
import { DATE_FORMAT, DATE_PATTERN, PHONE_PATTERN } from '@/lib/validation';
import { InputField } from './field';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './styles';

type SaveAction = (state: OrganisationFormState, formData: FormData) => Promise<OrganisationFormState>;

interface OrganisationFormProps {
  action: SaveAction;
  initialState: OrganisationFormState;
}

/** The four fields of an organisation, then Save and Cancel; used by the edit and the new pages. */
export function OrganisationForm({ action, initialState }: OrganisationFormProps) {
  const [{ values, errors }, formAction, isPending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="max-w-lg space-y-5">
      <InputField
        id="name"
        name="name"
        label="Name"
        type="text"
        autoComplete="organization"
        required
        defaultValue={values.name}
        error={errors.name}
      />
      <InputField
        id="phone"
        name="phone"
        label="Phone"
        type="tel"
        inputMode="numeric"
        pattern={PHONE_PATTERN}
        autoComplete="tel"
        required
        hint="8 digits, for example 99112233."
        defaultValue={values.phone}
        error={errors.phone}
      />
      <InputField
        id="email"
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        defaultValue={values.email}
        error={errors.email}
      />
      <InputField
        id="registeredAt"
        name="registeredAt"
        label="Registered on"
        type="text"
        placeholder={DATE_FORMAT}
        pattern={DATE_PATTERN}
        maxLength={DATE_FORMAT.length}
        required
        hint={`Format: ${DATE_FORMAT}`}
        defaultValue={values.registeredAt}
        error={errors.registeredAt}
      />
      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON_PRIMARY} disabled={isPending}>
          Save
        </button>
        <Link href="/organisations" className={BUTTON_SECONDARY}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
