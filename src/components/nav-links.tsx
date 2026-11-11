'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string; icon: React.ReactNode };

const I = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-5 shrink-0" aria-hidden="true">
    <path d={d} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ITEMS: Item[] = [
  { href: '/dashboard', label: 'Dashboard', icon: I('M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z') },
  { href: '/conversations', label: 'Conversations', icon: I('M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z') },
  { href: '/contacts', label: 'Contacts', icon: I('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8') },
  { href: '/assistant', label: 'AI Assistant', icon: I('M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z') },
  { href: '/memory', label: 'Memory', icon: I('M12 3a4 4 0 0 0-4 4v1a4 4 0 0 0 0 8v1a4 4 0 0 0 8 0v-1a4 4 0 0 0 0-8V7a4 4 0 0 0-4-4Z') },
  { href: '/away', label: 'Away Mode', icon: I('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z') },
  { href: '/integrations', label: 'Integrations', icon: I('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7') },
  { href: '/settings', label: 'Settings', icon: I('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2-1.2L14.6 3H9.4L9 5.7a7.4 7.4 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2 1.2l.4 2.7h5.2l.4-2.7a7.4 7.4 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z') },
];

// Bottom nav shows 5 — more than 5 items in a bottom bar is a usability failure.
const BOTTOM = ['/dashboard', '/conversations', '/contacts', '/assistant', '/settings'];

export function NavLinks({ variant = 'sidebar' }: { variant?: 'sidebar' | 'bottom' }) {
  const pathname = usePathname();
  const items = variant === 'bottom' ? ITEMS.filter((i) => BOTTOM.includes(i.href)) : ITEMS;

  if (variant === 'bottom') {
    return (
      <>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={[
                // 44px minimum touch target — the icon alone is only 20px.
                'flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {item.icon}
              <span>{item.label.split(' ')[0]}</span>
            </Link>
          );
        })}
      </>
    );
  }

  return (
    <nav className="space-y-0.5" aria-label="Main navigation">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary-subtle text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
