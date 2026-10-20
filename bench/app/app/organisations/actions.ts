'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { saveOrganisation } from '@/lib/store';
import { type FormResult, hasErrors, type OrganisationField, readOrganisationForm } from '@/lib/validation';

export type OrganisationFormState = FormResult<OrganisationField>;

/**
 * Bound to the organisation's id on the edit page and to `null` on the new page. Invalid input
 * comes back as field errors; a saved organisation goes back to the list, which confirms it.
 * An id that is not in the store (a tampered bound argument) makes `saveOrganisation` throw.
 */
export async function saveOrganisationAction(
  id: number | null,
  _previous: OrganisationFormState,
  formData: FormData,
): Promise<OrganisationFormState> {
  const result = readOrganisationForm(formData);
  if (hasErrors(result.errors)) {
    return result;
  }
  const saved = await saveOrganisation(id === null ? result.values : { ...result.values, id });
  revalidatePath('/', 'layout');
  redirect(`/organisations?saved=${saved.id}`);
}
