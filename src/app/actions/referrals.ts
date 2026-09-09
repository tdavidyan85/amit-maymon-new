'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { CreateReferralInput, UpdateReferralInput } from '@/types/database';

// Only OFFICE + CEO touch referrals at all — matches the RLS gate in
// migration 039 and the /closure page's precedent for office-only screens.
async function requireOfficeOrCeo(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'לא מחובר' as const };
  const { data: profileData } = await supabase
    .from('profiles')
    .select('id, role, branch_ids, sees_all_branches')
    .eq('id', user.id)
    .single();
  const profile = profileData as { id: string; role: string; branch_ids: string[]; sees_all_branches?: boolean } | null;
  if (!profile || (profile.role !== 'OFFICE' && profile.role !== 'CEO')) {
    return { error: 'רק משרד או מנכ"ל יכולים לנהל הפניות' as const };
  }
  return { user, profile };
}

export async function createReferral(input: CreateReferralInput) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };
  if (!input.branch_id) return { error: 'סניף לא תקין' };

  const { data, error } = await supabase
    .from('referrals')
    .insert({
      branch_id: input.branch_id,
      customer_name: input.customer_name ?? null,
      insurance_company: input.insurance_company ?? null,
      claim_type: input.claim_type ?? null,
      vehicle_type: input.vehicle_type ?? null,
      vehicle_year: input.vehicle_year ?? null,
      plate_number: input.plate_number ?? null,
      appraiser_name: input.appraiser_name ?? null,
      phone: input.phone ?? null,
      status_note: input.status_note ?? null,
      status: 'ACTIVE',
      created_by: auth.user.id,
    } as never)
    .select('id')
    .single();

  if (error || !data) return { error: error?.message ?? 'שגיאה ביצירת הפנייה' };
  const referralId = (data as { id: string }).id;

  // The initial note (if any) becomes the first row of the status log, so
  // the detail page's "מעקב הפנייה" timeline has no gap before the first
  // real update — everything status-related lives in one place from here on.
  if (input.status_note?.trim()) {
    await supabase.from('referral_status_updates').insert({
      referral_id: referralId,
      status_tag: null,
      note: input.status_note.trim(),
      created_by: auth.user.id,
    } as never);
  }

  revalidatePath('/referrals');
  return { ok: true, referralId, error: null };
}

export async function updateReferral(referralId: string, updates: UpdateReferralInput) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  // Column allow-list, same reasoning as caseDetails.ts — the client passes
  // a plain object, so keep it explicit rather than trusting the shape.
  const ALLOWED = new Set([
    'customer_name', 'insurance_company', 'claim_type', 'vehicle_type',
    'vehicle_year', 'plate_number', 'appraiser_name', 'phone', 'status_note',
  ]);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (ALLOWED.has(k)) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return { ok: true, error: null };

  const { error } = await supabase.from('referrals').update(patch as never).eq('id', referralId);
  if (error) return { error: error.message };

  revalidatePath('/referrals');
  revalidatePath(`/referrals/${referralId}`);
  return { ok: true, error: null };
}

/**
 * Sets (or clears, with date=null) the referral's follow-up reminder date —
 * "לקוח תואם לשבוע הבא לתאריך מסוים". Always resets
 * follow_up_reminder_sent_at so a NEW date gets its own reminder; the caller
 * (the Field component's onBlur) only invokes this when the date actually
 * changed, so this doesn't re-arm a reminder on every unrelated edit.
 */
export async function setReferralFollowUpDate(referralId: string, date: string | null) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase
    .from('referrals')
    .update({ follow_up_date: date || null, follow_up_reminder_sent_at: null } as never)
    .eq('id', referralId);
  if (error) return { error: error.message };

  revalidatePath('/referrals');
  revalidatePath(`/referrals/${referralId}`);
  return { ok: true, error: null };
}

/** Manual cancel — soft (status flip), matches cases' deleted_at pattern. Referral drops out of the active list but stays for history. */
export async function cancelReferral(referralId: string) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase
    .from('referrals')
    .update({ status: 'CANCELLED' } as never)
    .eq('id', referralId);
  if (error) return { error: error.message };

  revalidatePath('/referrals');
  return { ok: true, error: null };
}

/**
 * Called right after a case is successfully created from this referral (see
 * CreateCaseButton's onCreated hook, wired from the referral detail page) —
 * links the two rows and flips status so the referral drops off the active
 * list. Not itself responsible for creating the case.
 */
export async function convertReferral(referralId: string, caseId: string) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase
    .from('referrals')
    .update({ status: 'CONVERTED', case_id: caseId } as never)
    .eq('id', referralId);
  if (error) return { error: error.message };

  revalidatePath('/referrals');
  return { ok: true, error: null };
}

export type ReferralStatusTag = 'AWAITING_REPLACEMENT_CAR' | 'AWAITING_PAPERWORK' | 'AWAITING_SCHEDULING' | 'OTHER';

/**
 * Appends a dated entry to the referral's status log ("מעקב הפנייה") — the
 * replacement for silently overwriting the single status_note field, so
 * "לקוח ממתין לרכב חלופי" today and "השלמת ניירת וטרם תואם" next week both
 * stay visible instead of one erasing the other.
 *
 * When a tag is picked, it's also copied onto referrals.current_status_tag
 * (denormalized) so the list page can color the card without re-querying the
 * whole log for every row. A plain free-text note with no tag selected
 * ("no change") leaves the current tag/color as-is.
 */
export async function addReferralStatusUpdate(referralId: string, statusTag: ReferralStatusTag | null, note: string) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };
  if (!note.trim() && !statusTag) return { error: 'נדרש מצב או הערה' };

  const { error } = await supabase.from('referral_status_updates').insert({
    referral_id: referralId,
    status_tag: statusTag,
    note: note.trim() || null,
    created_by: auth.user.id,
  } as never);
  if (error) return { error: error.message };

  // Denormalize onto referrals so the list page (current_status_tag → color)
  // and card preview (status_note → the 📝 line) both reflect this update
  // without an extra "latest log entry" query per row.
  const patch: Record<string, unknown> = {};
  if (statusTag) patch.current_status_tag = statusTag;
  if (note.trim()) patch.status_note = note.trim();
  if (Object.keys(patch).length > 0) {
    const { error: patchErr } = await supabase.from('referrals').update(patch as never).eq('id', referralId);
    if (patchErr) console.error('[referrals] status sync failed', patchErr);
  }

  revalidatePath('/referrals');
  revalidatePath(`/referrals/${referralId}`);
  return { ok: true, error: null };
}

export async function getReferralStatusUpdates(referralId: string) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { data: [], error: auth.error };

  const { data, error } = await supabase
    .from('referral_status_updates')
    .select('id, status_tag, note, created_at, profiles(full_name)')
    .eq('referral_id', referralId)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as unknown as ReferralStatusUpdateRow[], error: null };
}

export interface ReferralStatusUpdateRow {
  id: string;
  status_tag: ReferralStatusTag | null;
  note: string | null;
  created_at: string;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
}

export async function uploadReferralDocument(formData: FormData) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  const referralId = formData.get('referral_id') as string;
  const file = formData.get('file') as File;
  if (!referralId || !file) return { error: 'חסרים פרטים (referral_id או file)' };
  if (!(file instanceof File) || file.size === 0) return { error: 'הקובץ ריק או לא תקין' };

  const MAX_BYTES = 20 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    return { error: `הקובץ גדול מדי (${(file.size / 1024 / 1024).toFixed(1)} MB). מקסימום 20 MB.` };
  }
  const ACCEPTED = /^(image\/|application\/(pdf|x-pdf|msword|vnd\.openxmlformats|vnd\.ms-excel))/i;
  if (file.type && !ACCEPTED.test(file.type)) {
    return { error: `סוג קובץ לא נתמך: ${file.type}. תמונות + PDF בלבד.` };
  }

  const safeName = file.name.replace(/[^\w.\-א-ת ]/g, '_');
  const path = `${referralId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from('referral-documents')
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (uploadError) return { error: `שגיאה בהעלאת הקובץ ל-Storage: ${uploadError.message}` };

  const { error: insertError } = await supabase
    .from('referral_documents')
    .insert({
      referral_id: referralId,
      file_name: file.name,
      file_path: path,
      file_size: file.size,
      mime_type: file.type || null,
      uploaded_by: auth.user.id,
    } as never);

  if (insertError) {
    await supabase.storage.from('referral-documents').remove([path]);
    return { error: `שגיאה בשמירת פרטי הקובץ: ${insertError.message}` };
  }

  revalidatePath(`/referrals/${referralId}`);
  return { ok: true, error: null };
}

export async function deleteReferralDocument(documentId: string) {
  const supabase = await createClient();
  const auth = await requireOfficeOrCeo(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: doc } = await supabase
    .from('referral_documents')
    .select('id, referral_id, file_path')
    .eq('id', documentId)
    .single();
  if (!doc) return { error: 'קובץ לא נמצא' };
  const docRow = doc as { referral_id: string; file_path: string };

  await supabase.storage.from('referral-documents').remove([docRow.file_path]);
  const { error } = await supabase.from('referral_documents').delete().eq('id', documentId);
  if (error) return { error: `שגיאה במחיקת הקובץ: ${error.message}` };

  revalidatePath(`/referrals/${docRow.referral_id}`);
  return { ok: true, error: null };
}
