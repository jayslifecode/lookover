import { toast } from 'sonner';
import { Glass } from '@/glass/glass';

/*
 * The report's toasts: the third glass layer (with the top bar and the finding panel), and the only glass
 * that enters or leaves. Sonner moves its toasts with `transform` and `opacity` only. Every toast has the
 * same id, so a new message replaces the one on screen instead of stacking under it: sonner keeps one
 * element per id, so there is never a second toast (nor a second glass surface) even while one leaves.
 */

export const TOAST_ID = 'lookover-toast';
const TOAST_DURATION_MS = 4_000;

function GlassToast({ message }: { readonly message: string }) {
  return (
    <Glass className="w-full rounded-[18px] px-4 py-3 font-semibold text-[13px] text-ink leading-5">
      {message}
    </Glass>
  );
}

/** Shows `message` in the toast, in place of whatever it showed. */
export function notify(message: string): void {
  toast.custom(() => <GlassToast message={message} />, { id: TOAST_ID, duration: TOAST_DURATION_MS });
}
