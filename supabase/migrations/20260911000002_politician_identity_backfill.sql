-- ============================================================
-- 回填 politician_keys：從 politicians + politician_elections 既有欄位，為全部人物產 key。
-- 可重跑：ON CONFLICT (politician_id, key_type, key_value) DO NOTHING。
-- 規模：15,856 人 × 每人約 4~6 key ≈ 7~9 萬列；identity_build_keys 走 PK／FK 索引，預估數十秒內。
-- ============================================================

DO $$
DECLARE
  n_keys INTEGER;
  n_people INTEGER;
BEGIN
  INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source)
  SELECT p.id, k.key_type, k.key_value, k.strength, 'backfill'
  FROM politicians p
  CROSS JOIN LATERAL identity_build_keys(p.id) k
  ON CONFLICT (politician_id, key_type, key_value) DO NOTHING;
  GET DIAGNOSTICS n_keys = ROW_COUNT;

  SELECT COUNT(DISTINCT politician_id) INTO n_people FROM politician_keys;
  RAISE NOTICE 'politician_keys backfill: inserted % keys, % politicians now have keys', n_keys, n_people;
END $$;

-- 驗證用（套完可手動跑）：
--   SELECT key_type, COUNT(*) FROM politician_keys GROUP BY 1 ORDER BY 1;
--   SELECT COUNT(*) FROM politicians p WHERE NOT EXISTS (SELECT 1 FROM politician_keys k WHERE k.politician_id = p.id);
--   SELECT key_type, key_value FROM politician_keys WHERE politician_id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9' ORDER BY 1, 2;
--   期望陳素月（彰化）：birth 陳素月|1966、party 陳素月|民主進步黨、position 陳素月|立法委員、position 陳素月|縣市長、
--                     region_type 陳素月|彰化縣|立法委員、region_type 陳素月|彰化縣|縣市長
