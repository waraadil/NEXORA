import Link from 'next/link';
import { NexoraMark } from '@/components/auth/auth-shell';
import { NavLinks } from './nav-links';
import { UserMenu } from './user-menu';
import { ThemeToggle } from './theme-toggle';
import { CommandPalette, type CommandItem } from './command-palette';

const COMMANDS: CommandItem[] = [
  { id: 'nav-dashboard', label: 'Dashboard', href: '/dashboard', keywords: 'home overview stats' },
  { id: 'nav-conversations', label: 'Conversations', href: '/conversations', keywords: 'chats threads messages history search' },
  { id: 'nav-import', label: 'Import a chat', href: '/conversations/import', keywords: 'whatsapp upload export parse' },
  { id: 'nav-contacts', label: 'Contacts', href: '/contacts', keywords: 'people relationships' },
  { id: 'nav-assistant', label: 'AI Assistant', href: '/assistant', keywords: 'reply draft write compose generate' },
  { id: 'nav-memory', label: 'Memory', href: '/memory', keywords: 'remember facts notes recall' },
  { id: 'nav-away', label: 'Away Mode', href: '/away', keywords: 'auto reply unavailable vacation out of office' },
  { id: 'nav-integrations', label: 'Integrations', href: '/integrations', keywords: 'whatsapp cloud api bridge connect' },
  { id: 'nav-settings', label: 'Settings', href: '/settings', keywords: 'profile account password delete timezone' },
  { id: 'nav-ai', label: 'AI provider & keys', href: '/settings/ai', keywords: 'openai anthropic gemini api key model credential' },
];

export function AppShell({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="nexora-deep relative min-h-dvh">
      {/* A single soft light source behind the whole app, so panels read as glass
          rather than as grey boxes. Decorative and non-interactive. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 hidden h-[46rem] bg-[radial-gradient(60rem_38rem_at_72%_-12%,rgba(124,58,237,0.30),transparent_62%),radial-gradient(40rem_28rem_at_12%_0%,rgba(168,85,247,0.16),transparent_60%)] dark:block"
      />

      {/* Sidebar — desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface/60 px-3 py-4 backdrop-blur-xl lg:flex dark:border-white/8 dark:bg-white/[0.025]">
        <Link href="/dashboard" className="mb-6 flex items-center gap-2.5 rounded-lg px-2 py-1">
          <NexoraMark className="size-8" />
          <span className="font-[family-name:var(--font-display)] text-base font-600 tracking-tight">
            NEXORA
          </span>
        </Link>
        <div className="mb-3">
          <CommandPalette items={COMMANDS} />
        </div>
        <NavLinks />
        <div className="mt-auto space-y-2 border-t border-border pt-3 dark:border-white/8">
          <ThemeToggle />
          <UserMenu />
        </div>
      </aside>

      {/* Top bar — mobile */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-xl lg:hidden dark:border-white/8 dark:bg-[#050208]/80">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/dashboard" className="flex items-center gap-2">
            <NexoraMark className="size-7" />
            <span className="font-[family-name:var(--font-display)] text-sm font-600 tracking-tight">
              NEXORA
            </span>
          </Link>
          <div className="flex items-center gap-1.5">
            <ThemeToggle compact />
            <UserMenu compact />
          </div>
        </div>
      </header>

      <div className="lg:pl-60">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-9">
          <div className="mb-7 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2.1rem)] font-700 leading-[1.06] tracking-[-0.03em] text-balance">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted-foreground text-pretty">
                  {subtitle}
                </p>
              )}
            </div>
            {actions}
          </div>
          {children}
        </div>

        {/* Bottom nav — mobile */}
        <div className="h-16 lg:hidden" aria-hidden="true" />
        <nav
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden dark:border-white/10 dark:bg-[#050208]/88"
          aria-label="Primary"
        >
          <div className="mx-auto flex max-w-md items-center justify-around px-2 py-1">
            <NavLinks variant="bottom" />
          </div>
        </nav>
      </div>
    </div>
  );
}
