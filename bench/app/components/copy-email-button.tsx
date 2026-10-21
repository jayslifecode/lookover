'use client';

import { ICON_ACTION } from './styles';

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error('Could not copy the email address', error);
  }
}

/** A 16 px icon button that copies an organisation's email address. */
export function CopyEmailButton({ name, email }: { name: string; email: string }) {
  return (
    <button
      type="button"
      aria-label={`Copy email for ${name}`}
      className={ICON_ACTION}
      onClick={() => copyToClipboard(email)}
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
      </svg>
    </button>
  );
}
