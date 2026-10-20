import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';
import { HEADING } from '@/components/styles';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-sm space-y-6 rounded-lg border border-slate-200 bg-white p-6">
      <h1 className={HEADING}>Sign in to Lookover Bench</h1>
      <LoginForm />
    </div>
  );
}
