import type { Metadata } from 'next';
import { SettingsForm } from '@/components/settings-form';
import { HEADING } from '@/components/styles';
import { getSettings } from '@/lib/store';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const settings = await getSettings();
  return (
    <div className="space-y-6">
      <h1 className={HEADING}>Settings</h1>
      <SettingsForm initialState={{ values: settings, errors: {}, status: null }} />
    </div>
  );
}
