-- PRE-DEPLOYMENT VALIDATION SCRIPT
-- Run this before every production push to catch schema issues
-- Checks for: missing functions, RLS policy errors, duplicate accounts, column mismatches

-- 1. CHECK: All required storage functions exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name = '_storage_user_can_see_case') THEN
    RAISE EXCEPTION 'MISSING FUNCTION: _storage_user_can_see_case';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name = '_storage_user_can_see_referral') THEN
    RAISE EXCEPTION 'MISSING FUNCTION: _storage_user_can_see_referral';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name = '_storage_case_id') THEN
    RAISE EXCEPTION 'MISSING FUNCTION: _storage_case_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name = '_storage_referral_id') THEN
    RAISE EXCEPTION 'MISSING FUNCTION: _storage_referral_id';
  END IF;
  RAISE NOTICE '✅ All storage functions exist';
END $$;

-- 2. CHECK: profiles table has correct columns (branch_ids not branch_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'branch_ids'
  ) THEN
    RAISE EXCEPTION 'COLUMN ERROR: profiles.branch_ids does not exist (check for branch_id typo)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'branch_id' AND data_type != 'ARRAY'
  ) THEN
    RAISE NOTICE '⚠️  WARNING: profiles has both branch_id and branch_ids - check for typos in code';
  END IF;
  RAISE NOTICE '✅ profiles table columns correct';
END $$;

-- 3. CHECK: No duplicate accounts (same role + name)
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT full_name, role, COUNT(*)
    FROM profiles
    WHERE is_active = true
    GROUP BY full_name, role
    HAVING COUNT(*) > 1
  ) t;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'DUPLICATE ACCOUNTS FOUND: % active users have duplicates', dup_count;
  END IF;
  RAISE NOTICE '✅ No duplicate accounts';
END $$;

-- 4. CHECK: RLS policies reference existing functions
DO $$
BEGIN
  -- Check if storage policies reference functions that exist
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects'
    AND policyname LIKE 'referral%'
    AND qual LIKE '%_storage_user_can_see%'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.routines
      WHERE routine_name = '_storage_user_can_see_referral'
    ) THEN
      RAISE EXCEPTION 'RLS POLICY ERROR: referral storage policy references missing function _storage_user_can_see_referral';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects'
    AND policyname LIKE 'case%'
    AND qual LIKE '%_storage_user_can_see%'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.routines
      WHERE routine_name = '_storage_user_can_see_case'
    ) THEN
      RAISE EXCEPTION 'RLS POLICY ERROR: case storage policy references missing function _storage_user_can_see_case';
    END IF;
  END IF;

  RAISE NOTICE '✅ All RLS policies reference valid functions';
END $$;

-- 5. CHECK: All required RLS policies exist
DO $$
BEGIN
  -- Cases
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cases' AND policyname = 'cases_select') THEN
    RAISE EXCEPTION 'MISSING RLS: cases_select policy';
  END IF;

  -- Referrals
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'referrals_select') THEN
    RAISE EXCEPTION 'MISSING RLS: referrals_select policy';
  END IF;

  RAISE NOTICE '✅ All required RLS policies exist';
END $$;

-- SUMMARY
SELECT
  '✅ PRE-DEPLOYMENT VALIDATION PASSED' as status,
  NOW() as checked_at,
  version() as database_version;
