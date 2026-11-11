'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'nexora-theme';

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  root.classList.toggle('dark', dark);
}

/**
 * Three-state theme control: light / dark / follow-system.
 *
 * The initial class is applied by an inline script in the root layout so there
 * is no flash of the wrong theme. This component only takes over afterwards.
 * State is read inside an effect, never during render, so server and client
 * markup always match.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
    setTheme(stored);
    setMounted(true);

    // Keep following the OS while in "system" mode.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if ((localStorage.getItem(STORAGE_KEY) as Theme | null) === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  const options: { id: Theme; label: string; icon: React.ReactNode }[] = [
    {
      id: 'light',
      label: 'Light theme',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'dark',
      label: 'Dark theme',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'system',
      label: 'Match system theme',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4" aria-hidden="true">
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={[
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5',
        compact ? '' : 'w-full',
      ].join(' ')}
    >
      {options.map((o) => {
        const active = mounted && theme === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => choose(o.id)}
            className={[
              'inline-flex items-center justify-center rounded-md transition-colors duration-150',
              compact ? 'size-8' : 'size-9 flex-1',
              active
                ? 'bg-primary-subtle text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}
