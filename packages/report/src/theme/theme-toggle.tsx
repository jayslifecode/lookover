import { MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type Theme, useTheme } from './use-theme';

const NEXT_THEME: Readonly<Record<Theme, Theme>> = { dark: 'light', light: 'dark' };
const LABEL: Readonly<Record<Theme, string>> = { dark: 'Dark', light: 'Light' };

/**
 * Switches between the two palettes. A click reveals the new theme in a circle from the pointer (from
 * the button when the keyboard pressed it); the choice is remembered.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, set } = useTheme();
  const next = NEXT_THEME[theme];
  const Icon = next === 'light' ? SunIcon : MoonIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={`Switch to ${next} theme`}
      onClick={(event) => set(next, event)}
      className={cn(
        'h-9 min-w-9 rounded-full border-line-strong px-3 text-[12.5px] text-ink hover:bg-muted hover:text-ink',
        className,
      )}
    >
      <Icon aria-hidden="true" />
      <span className="hidden sm:inline">{LABEL[next]}</span>
    </Button>
  );
}
