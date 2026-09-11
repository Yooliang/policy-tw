-- ============================================================
-- DB 防線：politician_elections 同一人同一場選舉只能一筆。
--
-- 2026-09-11 以 anon key 只讀掃過 prod 全部 16,078 筆 politician_elections：
--   (politician_id, election_id) 重複組數 = 0 → 可直接建索引，不需先清資料。
-- 若日後套用時出現 "could not create unique index"，先跑下面的違反清單查詢清掉再重套：
--   SELECT politician_id, election_id, array_agg(id ORDER BY id) AS ids, COUNT(*)
--   FROM politician_elections GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
-- 註：20260129000003 曾把 (politician_id, election_id) 設成 PK，但 prod 目前 politician_elections
--     有 id 欄位（SERIAL），且 upsert_politician 的 ON CONFLICT (politician_id, election_id) 仍在用，
--     代表某種 unique 已存在或已被換掉；這裡用 DO 區塊檢查 pg_index，已有等價 unique 就跳過。
--     不用 CONCURRENTLY：supabase db push 把 migration 包在 transaction 裡，CONCURRENTLY 會直接失敗；
--     16k 列建索引鎖表不到一秒，可接受。
-- ============================================================

DO $$
DECLARE
  has_unique BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'politician_elections'
      AND i.indisunique
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname::TEXT ORDER BY a.attname)
        FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      ) = ARRAY['election_id', 'politician_id']
  ) INTO has_unique;

  IF has_unique THEN
    RAISE NOTICE 'politician_elections already has a unique index on (politician_id, election_id); skipping';
  ELSE
    CREATE UNIQUE INDEX idx_politician_elections_unique_politician_election
      ON politician_elections (politician_id, election_id);
    RAISE NOTICE 'created idx_politician_elections_unique_politician_election';
  END IF;
END $$;
