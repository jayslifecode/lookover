import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';
import { SESSION_COOKIE } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Lookover Bench', template: '%s · Lookover Bench' },
  description: 'The sample app Lookover is measured against.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const isSignedIn = (await cookies()).has(SESSION_COOKIE);
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {isSignedIn && <SiteHeader />}
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
