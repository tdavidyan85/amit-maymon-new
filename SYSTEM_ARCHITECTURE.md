# 🏗️ SYSTEM ARCHITECTURE & RLS DEEP DIVE

**Document Version:** 1.0  
**Last Updated:** 2026-09-09  
**Purpose:** Technical reference for developers + prevention of recurring issues

---

## 📚 TABLE OF CONTENTS

1. [Database Schema](#database-schema)
2. [Row-Level Security (RLS)](#row-level-security)
3. [Storage & File Access](#storage--file-access)
4. [Server Actions & Authorization](#server-actions--authorization)
5. [Common Issues & Fixes](#common-issues--fixes)

---

## DATABASE SCHEMA

### profiles Table

**Critical Columns:**
- `id` (UUID PK) — Links to auth.users
- `role` (enum) — SERVICE_MANAGER, OFFICE, CEO, PAINTER, SERVICE_ADVISOR
- `branch_ids` (UUID[]) — **ARRAY** of branch IDs user can access
- `is_active` (boolean) — Soft delete flag

**⚠️ CRITICAL:** `branch_ids` is an **ARRAY**, not a singular UUID!

```typescript
// ✅ CORRECT: Selecting ARRAY column
.select('id, role, branch_ids, is_active')

// ❌ WRONG: Selecting singular column (will be NULL for OFFICE)
.select('id, role, branch_id, is_active')
```

### cases Table

**Key Columns:**
- `branch_id` (UUID FK) — Single branch owning this case
- `created_by` (UUID FK) — Profile ID who created it
- `general_status` (enum) — NEW, IN_PROGRESS, COMPLETED

### referrals Table

**Key Columns:**
- `branch_id` (UUID FK) — Single branch owning this referral
- `created_by` (UUID FK) — Profile ID who created it
- `status` (enum) — ACTIVE, CONVERTED, CANCELLED

---

## ROW-LEVEL SECURITY

### How RLS Works

RLS policies are **database-enforced rules** that filter data based on the current user.

Example: OFFICE can only see cases in their assigned branches.

```sql
-- Applied to: cases table
-- When SELECT: Check if user is CEO or has branch_id in branch_ids
CREATE POLICY cases_select ON public.cases
  FOR SELECT USING (
    (get_my_role() = 'CEO'::user_role) 
    OR 
    (branch_id = ANY(get_my_branch_ids()))
  );
```

### Helper Functions

These functions are **called by RLS policies** to check permissions:

#### `get_my_role()` → Returns user's role
```sql
CREATE FUNCTION get_my_role() RETURNS user_role AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE;
```

#### `get_my_branch_ids()` → Returns user's branch array
```sql
CREATE FUNCTION get_my_branch_ids() RETURNS uuid[] AS $$
  SELECT branch_ids FROM profiles WHERE id = auth.uid()
$$ LANGUAGE sql STABLE;
```

**Usage in RLS policy:**
```sql
-- "Can the user see this branch_id?"
branch_id = ANY(get_my_branch_ids())
```

### RLS Policies by Table

#### cases
```sql
-- SELECT: CEO sees all, others see assigned branches
(role = 'CEO') OR (branch_id = ANY(branch_ids))

-- UPDATE: Same as SELECT
(role = 'CEO') OR (branch_id = ANY(branch_ids))

-- INSERT: CEO can insert anywhere, others only in their branches
(role = 'CEO') OR (branch_id = ANY(branch_ids))
```

#### referrals
```sql
-- SELECT: CEO sees all, OFFICE sees assigned branches
(role = 'CEO') OR (role = 'OFFICE' AND branch_id = ANY(branch_ids))

-- UPDATE: Same as SELECT
(role = 'CEO') OR (role = 'OFFICE' AND branch_id = ANY(branch_ids))

-- INSERT: CEO or OFFICE
(role = 'CEO') OR (role = 'OFFICE' AND branch_id = ANY(branch_ids))
```

---

## STORAGE & FILE ACCESS

### Storage Bucket Structure

Supabase Storage (`storage.objects` table):

```
referral-documents/
  {referral-id}/
    file1.pdf
    photo.jpg

case-documents/
  {case-id}/
    document.pdf
```

### Storage RLS Policies

Storage uses **custom functions** to check file access:

```sql
-- referral-documents read policy:
CREATE POLICY "referral-documents read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'referral-documents' 
    AND _storage_user_can_see_referral(
      _storage_referral_id(name)  -- Extract referral ID from path
    )
  );
```

### Storage Helper Functions

#### `_storage_referral_id(name text)` → Extract referral ID from path

```sql
-- Input: "referrals/550e8400-e29b-41d4-a716-446655440000/file.pdf"
-- Output: "550e8400-e29b-41d4-a716-446655440000"

CREATE FUNCTION _storage_referral_id(name text) RETURNS uuid AS $$
BEGIN
  RETURN (string_to_array(name, '/'))[2]::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
```

#### `_storage_user_can_see_referral(referral_id uuid)` → Check access

```sql
-- User can see referral if:
-- 1. User is CEO, OR
-- 2. User is OFFICE AND referral's branch is in their branch_ids

CREATE FUNCTION _storage_user_can_see_referral(referral_id uuid) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM referrals
    WHERE id = referral_id
    AND (
      get_my_role() = 'CEO'::user_role
      OR (
        get_my_role() = 'OFFICE'::user_role 
        AND branch_id = ANY(get_my_branch_ids())
      )
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;
```

**⚠️ CRITICAL:** This function MUST use `get_my_branch_ids()`, not `branch_id` column!

---

## SERVER ACTIONS & AUTHORIZATION

### How Server Actions Work

Server Actions are Next.js functions that run on the server and can access the database.

```typescript
// src/app/actions/referrals.ts
export async function updateReferral(referralId: string, updates: UpdateReferralInput) {
  const supabase = await createClient();
  
  // 1. Get current user
  const { data: { user } } = await supabase.auth.getUser();
  
  // 2. Get user's profile
  const { data: profileData } = await supabase
    .from('profiles')
    .select('id, role, branch_ids')  // ✅ CORRECT: branch_ids (array)
    .eq('id', user.id)
    .single();
  
  // 3. Check authorization
  const profile = profileData as { role: string; branch_ids: string[] };
  if (profile.role !== 'OFFICE' && profile.role !== 'CEO') {
    return { error: 'Only OFFICE/CEO can manage referrals' };
  }
  
  // 4. Update (RLS policy enforces further at database level)
  const { error } = await supabase
    .from('referrals')
    .update(updates)
    .eq('id', referralId);
}
```

### Authorization Flow

```
User → Server Action → Supabase Auth → RLS Policy
                ↓
         Get User Profile
                ↓
      Check role + branch_ids
                ↓
    Execute Query (RLS filters rows)
```

### Why Dual Authorization?

1. **Server Action checks:** Fast, user-friendly error messages
2. **RLS Policy checks:** Prevents unauthorized access at DB level

Both layers protect the system.

---

## COMMON ISSUES & FIXES

### Issue #1: Column Name Typo (branch_id vs branch_ids)

**Symptom:** OFFICE can't access data even though RLS allows it

**Root Cause:**
```typescript
// ❌ WRONG - will be NULL
const { data } = await supabase
  .from('profiles')
  .select('id, role, branch_id')  // branch_id doesn't exist
  .single();

profile.branch_id  // NULL for OFFICE staff!
```

**Fix:**
```typescript
// ✅ CORRECT
const { data } = await supabase
  .from('profiles')
  .select('id, role, branch_ids')  // Correct column name
  .single();

profile.branch_ids  // [uuid1, uuid2] for OFFICE staff
```

**Prevention:**
- Search for `branch_id` in all Server Actions
- Type check should catch this: `branch_ids: string[]` not `branch_id: string`

---

### Issue #2: Missing Storage Functions

**Symptom:** "database schema mismatch" error on file upload

**Root Cause:** RLS policy calls function that doesn't exist

```sql
-- ❌ Policy tries to call missing function:
WHERE _storage_user_can_see_referral(_storage_referral_id(name))
```

**Fix:** Ensure functions exist:
```sql
-- Check before deploy:
SELECT routine_name FROM information_schema.routines
WHERE routine_name LIKE '_storage%';

-- Should return:
-- _storage_case_id
-- _storage_referral_id
-- _storage_user_can_see_case
-- _storage_user_can_see_referral
```

**Prevention:**
- Migrations must create all `_storage_*` functions
- Run `pre-deploy-validation.sql` before push

---

### Issue #3: Duplicate Accounts

**Symptom:** User has multiple profiles with same name/role

**Root Cause:** User creation/migration bug created duplicates

**Fix:**
```sql
-- Find duplicates:
SELECT full_name, role, COUNT(*)
FROM profiles
WHERE is_active = true
GROUP BY full_name, role
HAVING COUNT(*) > 1;

-- Deactivate old ones:
UPDATE profiles SET is_active = false
WHERE id = 'old-profile-uuid';
```

**Prevention:**
- User management UI should prevent duplicate creation
- Run this check monthly

---

### Issue #4: RLS Policy Using Wrong Column

**Symptom:** Storage policy can't read files

**Root Cause:** Policy function uses wrong column
```sql
-- ❌ WRONG - accessing singular column:
AND p.branch_id = c.branch_id

-- ✅ CORRECT - using array comparison:
AND c.branch_id = ANY(get_my_branch_ids())
```

**Prevention:**
- Always use `get_my_branch_ids()` in RLS policies
- Never access `profiles.branch_id` directly (it doesn't exist)

---

## TESTING CHECKLIST

Before any deployment, verify:

- [ ] All 5 roles can perform their core tasks
- [ ] OFFICE can open + edit referrals + upload files
- [ ] SERVICE_MANAGER can open + edit cases
- [ ] CEO has full access
- [ ] PAINTER is blocked from unauthorized pages
- [ ] SERVICE_ADVISOR has read-only access to cases
- [ ] No console errors (0 red, warnings OK)
- [ ] No "schema mismatch" errors

---

## REFERENCES

- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [Row-Level Security Policies](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Storage Authentication](https://supabase.com/docs/guides/storage/security)

---

**Reviewed By:** Claude Code  
**Last Updated:** 2026-09-09  
**Next Review:** 2026-10-09
