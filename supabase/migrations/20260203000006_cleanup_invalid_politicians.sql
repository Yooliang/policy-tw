-- ============================================================
-- Cleanup invalid politician names
-- Remove placeholder names like "其他未定人選", "待定", etc.
-- ============================================================

-- Step 1: Delete politician_elections for invalid politicians
DELETE FROM politician_elections pe
WHERE pe.politician_id IN (
  SELECT id FROM politicians
  WHERE name LIKE '%未定%'
    OR name LIKE '%待定%'
    OR name LIKE '%待確認%'
    OR name LIKE '%未知%'
    OR name LIKE '%人選%'
    OR name LIKE '%待公布%'
    OR name = '其他'
    OR LENGTH(name) < 2
    OR LENGTH(name) > 10
);

-- Step 2: Delete policies for invalid politicians
DELETE FROM policies p
WHERE p.politician_id IN (
  SELECT id FROM politicians
  WHERE name LIKE '%未定%'
    OR name LIKE '%待定%'
    OR name LIKE '%待確認%'
    OR name LIKE '%未知%'
    OR name LIKE '%人選%'
    OR name LIKE '%待公布%'
    OR name = '其他'
    OR LENGTH(name) < 2
    OR LENGTH(name) > 10
);

-- Step 3: Delete invalid politicians
DELETE FROM politicians
WHERE name LIKE '%未定%'
  OR name LIKE '%待定%'
  OR name LIKE '%待確認%'
  OR name LIKE '%未知%'
  OR name LIKE '%人選%'
  OR name LIKE '%待公布%'
  OR name = '其他'
  OR LENGTH(name) < 2
  OR LENGTH(name) > 10;

-- Report deleted count
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % invalid politicians', deleted_count;
END $$;
