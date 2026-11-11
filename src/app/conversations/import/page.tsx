import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOnboardedUser } from '@/lib/auth/guard';
import { AppShell } from '@/components/app-shell';
import { ImportWizard } from './import-wizard';

export const metadata: Metadata = { title: 'Import chat' };

// Auth-gated route: blocking render is intended, so the page never
// prerenders a shell it cannot legitimately produce.
export const instant = false;

export default async function ImportPage() {
  const { user, supabase } = await requireOnboardedUser();

  const { count: existing } = await supabase
    .from('import_batches')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('status', 'confirmed');

  return (
    <AppShell
      title="Import a conversation"
      subtitle="Upload a WhatsApp export. You review everything before it is saved."
    >
      <div className="space-y-6">
        <ImportWizard />

        <div className="rounded-xl border border-border bg-surface-2 p-4 text-sm">
          <p className="font-medium">Importing the same file twice is safe</p>
          <p className="mt-1 text-muted-foreground text-pretty">
            Each message gets a stable fingerprint. Re-importing an export — for example, a chat
            you backed up last month and again today — adds only the new messages and reports the
            rest as duplicates.
          </p>
          {existing ? (
            <p className="mt-2 text-xs text-muted-foreground">
              You have completed {existing} import{existing === 1 ? '' : 's'} so far.
            </p>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
