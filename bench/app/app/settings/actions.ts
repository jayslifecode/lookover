'use server';

import { revalidatePath } from 'next/cache';
import { saveSettings } from '@/lib/store';
import { type FormResult, hasErrors, readSettingsForm, type SettingsField } from '@/lib/validation';

export type SettingsFormState = FormResult<SettingsField> & {
  /** Announced through the form's `role="status"` region; `null` before the first save. */
  status: string | null;
};

export async function saveSettingsAction(
  _previous: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const result = readSettingsForm(formData);
  if (hasErrors(result.errors)) {
    return { ...result, status: null };
  }
  const saved = await saveSettings(result.values);
  revalidatePath('/settings');
  return { values: { ...saved }, errors: {}, status: 'Settings saved.' };
}
