'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type MemoryState = { error?: string; success?: string } | null;

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function updateMemory(_prev: MemoryState, formData: FormData): Promise<MemoryState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const parsed = z
    .object({
      id: z.string().uuid(),
      content: z.string().trim().min(3, 'Too short').max(2000),
      kind: z.enum(['fact', 'preference', 'event', 'topic', 'promise', 'relationship']),
      provenance: z.enum(['inferred', 'confirmed']),
    })
    .safeParse({
      id: formData.get('id'),
      content: formData.get('content'),
      kind: formData.get('kind'),
      provenance: formData.get('provenance'),
    });

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };

  // A user edit is ground truth now — pin confidence to 1 and confirm provenance
  // whenever they explicitly mark it confirmed.
  const { error } = await supabase
    .from('memories')
    .update({
      content: parsed.data.content,
      kind: parsed.data.kind,
      provenance: parsed.data.provenance,
      confidence: parsed.data.provenance === 'confirmed' ? 1 : 0.5,
      normalized: parsed.data.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .eq('user_id', user.id);

  if (error) return { error: 'Could not save that memory.' };

  revalidatePath('/memory');
  return { success: 'Memory updated.' };
}

export async function confirmMemory(
  memoryId: string,
  _prev: MemoryState,
  _formData: FormData,
): Promise<MemoryState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const { error } = await supabase
    .from('memories')
    .update({ provenance: 'confirmed', confidence: 1, updated_at: new Date().toISOString() })
    .eq('id', memoryId)
    .eq('user_id', user.id);

  if (error) return { error: 'Could not confirm that memory.' };

  revalidatePath('/memory');
  return { success: 'Marked confirmed.' };
}

export async function deleteMemory(
  memoryId: string,
  _prev: MemoryState,
  _formData: FormData,
): Promise<MemoryState> {
  const { supabase, user } = await requireUser();
  if (!user) return { error: 'Session expired. Sign in again.' };

  const { error } = await supabase.from('memories').delete().eq('id', memoryId).eq('user_id', user.id);
  if (error) return { error: 'Could not delete that memory.' };

  revalidatePath('/memory');
  return { success: 'Memory deleted.' };
}
