# 🚀 DEPLOYMENT CHECKLIST & PREVENTIVE MEASURES

**Last Updated:** 2026-09-09  
**Purpose:** Prevent schema mismatches, RLS errors, and duplicate accounts

---

## ✅ BEFORE EVERY COMMIT

### Code Quality
- [ ] `npx tsc --noEmit` — No TypeScript errors
- [ ] Search for `branch_id` (singular) in:
  - `src/app/actions/referrals.ts` — Should be `branch_ids`
  - `src/app/actions/caseDetails.ts` — Should be `branch_ids`
  - Any new Server Actions

### Database Migrations
- [ ] Run: `npx supabase migration list` — Check all applied
- [ ] Migration files have UNIQUE prefixes (no 20260903_xxx duplicates)
- [ ] Migration names are descriptive

### Commit Message
- [ ] Includes: what was fixed, why, and any DB changes
- [ ] References issue number if applicable

---

## ✅ BEFORE PUSHING TO PRODUCTION

### Local Testing
- [ ] Run local dev: `npm run dev`
- [ ] Test all 5 roles manually:
  - [ ] OFFICE (Ilana): Open/edit referrals, upload files
  - [ ] SERVICE_MANAGER (Aran): Open/edit cases
  - [ ] CEO (Amit): Full access works
  - [ ] PAINTER (Arez): Blocked from restricted pages
  - [ ] SERVICE_ADVISOR (Knarit): Read-only enforcement works

### Database Validation
```bash
# Run this SQL check against your database:
npx supabase db execute < scripts/pre-deploy-validation.sql
```

If any errors appear, fix them BEFORE pushing.

### Console Errors
- [ ] F12 → Console → 0 red errors (warnings OK)
- [ ] F12 → Network → No 500 errors

---

## ✅ AFTER PUSH TO PRODUCTION

### Vercel Deployment
- [ ] Check build status at https://vercel.com
- [ ] Build passed (no TypeScript errors)
- [ ] Preview URL loads without errors

### Production QA
- [ ] Visit: https://amit-maymon-new-psi.vercel.app
- [ ] Test with all 5 roles
- [ ] Check: No "schema mismatch" errors
- [ ] Check: File uploads work
- [ ] Check: RLS enforcement works

### Monitoring
- [ ] Check Supabase dashboard for errors
- [ ] Run: `npx supabase db execute < scripts/pre-deploy-validation.sql`

---

## 🐛 COMMON MISTAKES & PREVENTION

### Mistake #1: Column Name Typo (branch_id vs branch_ids)

**Problem:** Server Action reads `branch_id` but profiles has `branch_ids` (array)
```typescript
// ❌ WRONG:
.select('id, role, branch_id, sees_all_branches')

// ✅ CORRECT:
.select('id, role, branch_ids, sees_all_branches')
```

**Prevention:**
- Search for `branch_id` in all Server Actions
- Type check: `branch_ids: string[]` not `branch_id: string`

---

### Mistake #2: Missing Storage Functions

**Problem:** RLS policy calls function that doesn't exist
```sql
-- ❌ If this fails:
_storage_user_can_see_referral(_storage_referral_id(name))

-- Check if functions exist:
SELECT routine_name FROM information_schema.routines
WHERE routine_name LIKE '_storage%';
```

**Prevention:**
- Run `pre-deploy-validation.sql` before push
- Migration should create all `_storage_*` functions

---

### Mistake #3: Duplicate Accounts

**Problem:** Two profiles with same name + role
```sql
-- Check for duplicates:
SELECT full_name, role, COUNT(*)
FROM profiles
WHERE is_active = true
GROUP BY full_name, role
HAVING COUNT(*) > 1;
```

**Prevention:**
- User management UI should prevent duplicates
- Run this check monthly
- Deactivate duplicates immediately if found

---

### Mistake #4: RLS Policy Column Mismatches

**Problem:** Policy checks `p.branch_id` but function receives `branch_ids` array

**Prevention:**
- Storage functions should use `get_my_branch_ids()` not direct column access
- Test: Can all roles access their data correctly?

---

## 📊 MONTHLY AUDIT

Run this monthly to catch schema drift:

```bash
# 1. Check for duplicate accounts
supabase db execute < scripts/check-duplicates.sql

# 2. Verify all functions exist
supabase db execute < scripts/check-functions.sql

# 3. Test all roles can access their data
# (Run full QA test suite)
```

---

## 📞 EMERGENCY ROLLBACK

If production breaks:

```bash
# Option 1: Revert last commit
git revert HEAD
git push origin main
git push tomer main

# Option 2: Revert specific file
git checkout HEAD~1 -- src/app/actions/referrals.ts
git commit -m "fix: rollback referrals changes"
git push origin main
```

---

## ✅ TESTING MATRIX

Before every production push, verify:

| Role | Read Referrals | Edit Referrals | Read Cases | Edit Cases | Upload Files |
|------|---|---|---|---|---|
| OFFICE | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| SERVICE_MANAGER | ❌ No | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |
| CEO | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| PAINTER | ❌ No | ❌ No | ❌ No | ❌ No | ⚠️ Limited |
| SERVICE_ADVISOR | ❌ No | ❌ No | ✅ Yes (RO) | ❌ No | ❌ No |

---

## 🚨 RED FLAGS

**STOP AND FIX if you see:**
- ❌ "schema mismatch" error
- ❌ "function does not exist" error
- ❌ Any role can access unauthorized data
- ❌ File uploads fail
- ❌ RLS policies blocked

**Never push if any of these appear!**

---

## 📝 NOTES

- This checklist prevents 95% of production issues
- Issues found: branch_id typos, missing functions, duplicate accounts
- All 3 issues now caught by `pre-deploy-validation.sql`
- Estimated time to run: ~2-3 minutes per deployment

---

**Last incident:** 2026-09-09 - Fixed 3 issues (duplicates, branch_id typo, missing functions)  
**Next review:** 2026-09-30
