'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type ContactState = { error?: string; success?: string; fieldErrors?: Record<string, string> } | null;

const schema = z.object({
  id: z.string().uuid(),
  displayName: z.string().trim().min(1, 'Name is required').max(120),
  relationship: z.string().trim().max(80).optional(),
  relationshipDetail: z.string().trim().max(500).optional(),
  communicationStyle: z.string().trim().max(1000).optional(),
  personalityNotes: z.string().trim().max(2000).optional(),
});

export async function updateContact(_prev: ContactState, formData: FormData): Promise<ContactState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in again.' };

  const parsed = schema.safeParse({
    id: formData.get('id'),
    displayName: formData.get('displayName'),
    relationship: formData.get('relationship') || undefined,
    relationshipDetail: formData.get('relationshipDetail') || undefined,
    communicationStyle: formData.get('communicationStyle') || undefined,
    personalityNotes: formData.get('personalityNotes') || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }

  const { id, displayName, relationship, relationshipDetail, communicationStyle, personalityNotes } = parsed.data;

  // RLS scopes this to the owner; the eq() is a second, explicit guard.
  const { error } = await supabase
    .from('contacts')
    .update({
      display_name: displayName,
      relationship: relationship ?? null,
      relationship_detail: relationshipDetail ?? null,
      communication_style: communicationStyle ?? null,
      personality_notes: personalityNotes ?? null,
    })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return { error: 'Could not save changes.' };

  revalidatePath(`/contacts/${id}`);
  revalidatePath('/contacts');
  return { success: 'Contact updated.' };
}

export async function deleteContact(contactId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  // Conversations, messages and memories cascade from the contact row.
  await supabase.from('contacts').delete().eq('id', contactId).eq('user_id', user.id);

  revalidatePath('/contacts');
  revalidatePath('/conversations');
}
