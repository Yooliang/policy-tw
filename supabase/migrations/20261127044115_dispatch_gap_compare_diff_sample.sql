-- 派工缺口雙軌比對：把 missing／extra／changed 的樣本鍵與差異欄位存進 dispatch_gap_reconcile_runs.diff_sample
--
-- 背景：dispatch_gap_shadow_compare()／dispatch_gap_reconcile_all() 只存數量，正式庫 issue_too_broad 臂每小時 changed＝1～4，
-- 查不出是哪幾筆、差在哪個欄位。兩支入口都經 dispatch_gap_reconcile_arm() 寫 reconcile_runs（INSERT 只在那一處），
-- 所以只換 reconcile_arm 一支（同簽名 CREATE OR REPLACE），shadow_compare／reconcile_all／shadow_run 本體一字不動、自動帶上樣本。
--
-- diff_sample 形狀（三類各最多 20 個，依鍵排序；三類合計為 0 時整欄 NULL）：
--   {"missing":[<gap_key>…], "extra":[<gap_key>…],
--    "changed":[{"key":<gap_key>, "table":<常駐表 payload 中有差異的欄位>, "live":<即時輸出 payload 中對應欄位>}…]}
--   「比對欄位」＝現行 changed 判定實際比的 payload（diff_loaded 比 g.payload IS DISTINCT FROM f.payload，scope_key 不在內）；
--   table／live 只放 payload 裡「值不同」的頂層鍵，不存整列；某一邊沒有該鍵時那邊的值是 JSON null。
--   missing／extra／changed 的判定條件與 dispatch_gap_diff_loaded 逐字同一套（含 extra／changed 的 p_grace），樣本在 apply 之前取。
--
-- 新增物件：欄位 dispatch_gap_reconcile_runs.diff_sample JSONB（可 NULL）、函式 dispatch_gap_payload_diff(JSONB, JSONB)；
--           被取代的函式 dispatch_gap_reconcile_arm(TEXT, BOOLEAN, TEXT, INTERVAL)（原版無 SET 子句）。
-- 回滾：重貼 20261126170000_dispatch_gaps_phase0.sql 的 dispatch_gap_reconcile_arm 定義，
--       再 DROP FUNCTION dispatch_gap_payload_diff(JSONB, JSONB); ALTER TABLE dispatch_gap_reconcile_runs DROP COLUMN diff_sample;
--       （先換回函式再刪欄位；加欄位本身可留著，無人讀就無害）
-- 風險：只在三類計數合計大於 0 時多跑三個小查詢（每類 LIMIT 20）；雙軌比對平常 changed 0～4，成本可忽略。派工輸出不變。

ALTER TABLE dispatch_gap_reconcile_runs ADD COLUMN IF NOT EXISTS diff_sample JSONB;
COMMENT ON COLUMN dispatch_gap_reconcile_runs.diff_sample IS '三類差異的樣本鍵（20261127044115）：{"missing":[鍵],"extra":[鍵],"changed":[{"key","table","live"}]}，各最多 20；全 0 時為 NULL。';

-- 兩份 payload 只留「值不同」的頂層鍵：回 {"table":{…},"live":{…}}
CREATE OR REPLACE FUNCTION dispatch_gap_payload_diff(p_table JSONB, p_live JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  WITH t AS (SELECT CASE WHEN jsonb_typeof(p_table) = 'object' THEN p_table ELSE '{}'::JSONB END AS j),
       l AS (SELECT CASE WHEN jsonb_typeof(p_live)  = 'object' THEN p_live  ELSE '{}'::JSONB END AS j),
       k AS (SELECT DISTINCT u.key
               FROM (SELECT jsonb_object_keys(t.j) AS key FROM t UNION ALL SELECT jsonb_object_keys(l.j) FROM l) u, t, l
              WHERE t.j -> u.key IS DISTINCT FROM l.j -> u.key)
  SELECT jsonb_build_object(
    'table', COALESCE((SELECT jsonb_object_agg(k.key, COALESCE(t.j -> k.key, 'null'::JSONB)) FROM k, t), '{}'::JSONB),
    'live',  COALESCE((SELECT jsonb_object_agg(k.key, COALESCE(l.j -> k.key, 'null'::JSONB)) FROM k, l), '{}'::JSONB));
$$;
REVOKE ALL ON FUNCTION dispatch_gap_payload_diff(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- 單臂：與 20261126170000 的版本相同，只在 diff 算完、套用之前多取一份樣本並寫進 diff_sample
CREATE OR REPLACE FUNCTION dispatch_gap_reconcile_arm(p_arm TEXT, p_apply BOOLEAN, p_mode TEXT, p_grace INTERVAL DEFAULT '0 seconds')
RETURNS dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_t0     TIMESTAMPTZ := clock_timestamp();
  d        RECORD;
  v_row    dispatch_gap_reconcile_runs;
  v_did    BOOLEAN := false;
  v_sample JSONB;
BEGIN
  PERFORM dispatch_gap_load_fresh(p_arm, NULL);
  SELECT * INTO d FROM dispatch_gap_diff_loaded(p_arm, p_grace);
  IF (d.missing + d.extra + d.changed) > 0 THEN
    SELECT jsonb_build_object(
      'missing', COALESCE((SELECT jsonb_agg(m.gap_key ORDER BY m.gap_key)
                             FROM (SELECT f.gap_key FROM _dg_fresh f
                                    WHERE NOT EXISTS (SELECT 1 FROM dispatch_gaps g WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.gap_key = f.gap_key)
                                    ORDER BY f.gap_key LIMIT 20) m), '[]'::JSONB),
      'extra',   COALESCE((SELECT jsonb_agg(e.gap_key ORDER BY e.gap_key)
                             FROM (SELECT g.gap_key FROM dispatch_gaps g
                                    WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.recomputed_at <= now() - p_grace
                                      AND NOT EXISTS (SELECT 1 FROM _dg_fresh f WHERE f.gap_key = g.gap_key)
                                    ORDER BY g.gap_key LIMIT 20) e), '[]'::JSONB),
      'changed', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', c.gap_key, 'table', c.df -> 'table', 'live', c.df -> 'live') ORDER BY c.gap_key)
                             FROM (SELECT g.gap_key, dispatch_gap_payload_diff(g.payload, f.payload) AS df
                                     FROM dispatch_gaps g JOIN _dg_fresh f ON f.gap_key = g.gap_key
                                    WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.recomputed_at <= now() - p_grace
                                      AND g.payload IS DISTINCT FROM f.payload
                                    ORDER BY g.gap_key LIMIT 20) c), '[]'::JSONB))
      INTO v_sample;
  END IF;
  IF p_apply AND (d.missing + d.extra + d.changed) > 0 THEN
    PERFORM dispatch_gap_apply_fresh(p_arm, NULL, 'reconcile');
    v_did := true;
  END IF;
  INSERT INTO dispatch_gap_reconcile_runs (arm, mode, live_count, table_count, missing, extra, changed, applied, duration_ms, diff_sample)
  VALUES (p_arm, p_mode, d.live_count, d.table_count, d.missing, d.extra, d.changed, v_did,
          round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::INTEGER, v_sample)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_reconcile_arm(TEXT, BOOLEAN, TEXT, INTERVAL) FROM PUBLIC, anon, authenticated;
