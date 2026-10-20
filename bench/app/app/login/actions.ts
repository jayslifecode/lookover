'use server';

import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isValidLogin } from '@/lib/credentials';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '@/lib/session';

export interface LoginState {
  /** Echoed back so a failed attempt keeps what was typed. */
  email: string;
  error: string | null;
}

function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** Checks the posted credentials against `BENCH_USER`/`BENCH_PASSWORD`; on success sets the session cookie and goes to `/`. */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = formText(formData, 'email').trim();
  const password = formText(formData, 'password');
  if (!isValidLogin(email, password)) {
    return { email, error: 'The email or password is incorrect.' };
  }
  (await cookies()).set(SESSION_COOKIE, randomUUID(), SESSION_COOKIE_OPTIONS);
  redirect('/');
}
