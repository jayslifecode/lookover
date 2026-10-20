'use client';

import { useActionState } from 'react';
import { type LoginState, login } from '@/app/login/actions';
import { InputField } from './field';
import { BUTTON_PRIMARY } from './styles';

const INITIAL_STATE: LoginState = { email: '', error: null };

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, INITIAL_STATE);
  return (
    <form action={formAction} className="space-y-5">
      {state.error !== null && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      )}
      <InputField
        id="email"
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        required
        defaultValue={state.email}
      />
      <InputField
        id="password"
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
      />
      <button type="submit" className={BUTTON_PRIMARY} disabled={isPending}>
        Sign in
      </button>
    </form>
  );
}
