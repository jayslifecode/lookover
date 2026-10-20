import Link from 'next/link';
import { LINK } from './styles';

const NAV_LINKS: readonly { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/organisations', label: 'Organisations' },
  { href: '/reports', label: 'Reports' },
  { href: '/settings', label: 'Settings' },
];

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="text-lg font-semibold text-slate-900">
          Lookover Bench
        </Link>
        <nav aria-label="Main">
          <ul className="flex flex-wrap items-center gap-4 text-sm">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={LINK}>
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              {/* A plain link: <Link> may prefetch, and prefetching /logout would sign the user out. */}
              <a href="/logout" className={LINK}>
                Sign out
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
