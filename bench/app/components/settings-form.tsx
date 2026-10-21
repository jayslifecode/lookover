'use client';

import { useActionState } from 'react';
import { type SettingsFormState, saveSettingsAction } from '@/app/settings/actions';
import { TIME_ZONES } from '@/lib/validation';
import { InputField, SelectField } from './field';
import { BUTTON_PRIMARY_NO_RING } from './styles';

export function SettingsForm({ initialState }: { initialState: SettingsFormState }) {
  const [{ values, errors, status }, formAction, isPending] = useActionState(
    saveSettingsAction,
    initialState,
  );
  return (
    <form action={formAction} className="max-w-lg space-y-5">
      <InputField
        id="workspaceName"
        name="workspaceName"
        label="Workspace name"
        type="text"
        required
        defaultValue={values.workspaceName}
        error={errors.workspaceName}
      />
      <InputField
        id="contactEmail"
        name="contactEmail"
        label="Contact email"
        type="email"
        autoComplete="email"
        required
        defaultValue={values.contactEmail}
        error={errors.contactEmail}
      />
      <SelectField
        id="timeZone"
        name="timeZone"
        label="Time zone"
        required
        options={TIME_ZONES}
        defaultValue={values.timeZone}
        error={errors.timeZone}
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          data-testid="settings-save"
          className={BUTTON_PRIMARY_NO_RING}
          disabled={isPending}
        >
          Save
        </button>
        <p role="status" className="text-sm text-slate-700">
          {status}
        </p>
      </div>
    </form>
  );
}
