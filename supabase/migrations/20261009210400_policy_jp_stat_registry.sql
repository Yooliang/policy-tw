-- 日本站：地域統計（regional_stat）交件的機器核對——照正見 cec-verify「對得上直接落庫」，跟自治體（20261009210200）同一個做法
-- ============================================================
--
-- 前提：20261009210000（regional_stats、apply_contribution）、20261009210200（自治體的機器核對；團體碼表）。
-- 資料：20261009210500_policy_jp_stat_registry_data.sql（scripts/gen-jp-stat-registry.ts 從 e-Stat 令和7年国勢調査的檔案產生）。
--
-- 為什麼（維護者 10-09）：日本站沒有其他代理投票，地域統計一筆要 3 個網段的同意票湊不起來。國勢調査有市区町村別的官方檔，
--   跟自治體的團體碼表一樣可以機器比對。參考表只拿來核對、不顯示、不從它建正式列；網站的統計仍然只從代理的交件來。
-- 只比三項：population（総人口，人）、area_km2（面積（参考），km2）、aging_rate（65歳以上人口の構成比，%）。
--   歳出（budget_expenditure）沒有可以整批比對的官方檔：照舊走同儕驗證。
-- 判斷（stat_registry_decide）：
--   apply ：表裡有（lg_code、stat_key、year），單位一致，值在容許差內（人口一致；面積 ±0.005 km2；高齢化率 ±0.05 %——小數一位四捨五入算對），
--           as_of 沒填或跟表一樣
--   reject：表裡有，但值超出容許差、單位不同、或 as_of 不同 → 退件，理由寫國勢調査的值
--   skip  ：表裡沒有（別的年份、歳出、團體不在表裡）→ 不碰，留給同儕。掃描（stat_registry_verify_pending）一開始就只挑表裡查得到的，
--           這種交件不進掃描、不佔每輪的筆數（否則堆多了會把新的擋在後面）
-- 排程 policy-jp-stat-registry-verify 每 10 分鐘（跟自治體的錯開）；jp-report 交件當下也對剛收下的跑一次（_shared/jp/machine-verify.ts）。

-- ------------------------------------------------------------
-- 1. 參考表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_jp.stat_registry (
  lg_code    TEXT NOT NULL CHECK (policy_jp.lg_code_valid(lg_code)),
  stat_key   TEXT NOT NULL CHECK (stat_key IN ('population', 'area_km2', 'aging_rate')),
  year       INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  value      NUMERIC NOT NULL CHECK (value >= 0),
  unit       TEXT NOT NULL,
  as_of      DATE NOT NULL,
  source_id  BIGINT NOT NULL REFERENCES policy_jp.sources(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lg_code, stat_key, year),
  CONSTRAINT stat_registry_unit_matches CHECK (unit = policy_jp.regional_stat_unit(stat_key))
);
COMMENT ON TABLE policy_jp.stat_registry IS
  '國勢調査的市区町村別數值（人口・面積・高齢化率）。只拿來機器核對代理交的 regional_stat（stat_registry_decide），不顯示、不從它建正式列；'
  '資料由 scripts/gen-jp-stat-registry.ts 產生成 migration';

ALTER TABLE policy_jp.stat_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_jp.stat_registry;
CREATE POLICY "Public read" ON policy_jp.stat_registry FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON policy_jp.stat_registry TO anon, authenticated;
GRANT ALL ON policy_jp.stat_registry TO service_role;

-- 容許差：人口一致、面積 0.005（表是小數兩位）、高齢化率 0.05（小數一位四捨五入算對）
CREATE OR REPLACE FUNCTION policy_jp.stat_registry_tolerance(p_stat_key TEXT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_stat_key WHEN 'population' THEN 0 WHEN 'area_km2' THEN 0.005 WHEN 'aging_rate' THEN 0.05 END
$$;

-- ------------------------------------------------------------
-- 2. 判斷：一筆 regional_stat 的 payload 跟國勢調査比；回 {action: apply|reject|skip, reason?, official?}
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.stat_registry_decide(p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  r policy_jp.stat_registry%ROWTYPE;
  v_year INTEGER;
  v_value NUMERIC;
  bad TEXT[] := '{}';
BEGIN
  IF jsonb_typeof(p_payload->'year') IS DISTINCT FROM 'number' OR jsonb_typeof(p_payload->'value') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('action', 'skip', 'reason', 'year、value 不是數字（交件驗證會擋，這裡不判）');
  END IF;
  v_year := (p_payload->>'year')::NUMERIC::INTEGER;
  v_value := (p_payload->>'value')::NUMERIC;
  SELECT * INTO r FROM policy_jp.stat_registry WHERE lg_code = p_payload->>'lg_code' AND stat_key = p_payload->>'stat_key' AND year = v_year;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'skip', 'reason', format('國勢調査的表裡沒有 %s 的 %s（%s 年），留給同儕驗證', p_payload->>'lg_code', p_payload->>'stat_key', v_year));
  END IF;
  IF p_payload->>'unit' IS DISTINCT FROM r.unit THEN bad := bad || format('unit 要是「%s」、交件是「%s」', r.unit, COALESCE(p_payload->>'unit', '(空白)')); END IF;
  IF abs(v_value - r.value) > policy_jp.stat_registry_tolerance(r.stat_key) THEN
    bad := bad || format('value 國勢調査是 %s %s、交件是 %s', r.value, r.unit, v_value);
  END IF;
  IF p_payload->>'as_of' IS NOT NULL AND p_payload->>'as_of' IS DISTINCT FROM r.as_of::TEXT THEN
    bad := bad || format('as_of 國勢調査的基準日是 %s、交件是 %s', r.as_of, p_payload->>'as_of');
  END IF;
  IF cardinality(bad) > 0 THEN
    RETURN jsonb_build_object('action', 'reject', 'reason', array_to_string(bad, '；'),
      'official', jsonb_build_object('lg_code', r.lg_code, 'stat_key', r.stat_key, 'year', r.year, 'value', r.value, 'unit', r.unit, 'as_of', r.as_of));
  END IF;
  RETURN jsonb_build_object('action', 'apply', 'year', r.year, 'as_of', r.as_of);
END;
$$;

-- ------------------------------------------------------------
-- 3. 掃 pending 的 regional_stat（同 lg_registry_verify_pending；reviewed_by estat-auto）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.stat_registry_verify_pending(p_limit INTEGER DEFAULT 2000, p_ids UUID[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  c RECORD;
  d JSONB;
  v_out JSONB;
  v_note TEXT;
  v_applied INTEGER := 0;
  v_waiting INTEGER := 0;
  v_rejected INTEGER := 0;
  v_skipped INTEGER := 0;
  v_other INTEGER := 0;
BEGIN
  FOR c IN
    SELECT id, payload FROM policy_jp.contributions
     WHERE status = 'pending' AND contribution_type = 'regional_stat'
       AND (p_ids IS NULL OR id = ANY (p_ids))
       -- 只掃表裡查得到的（團體・項目・年份）：查不到的（歳出、別的年份）一定是 skip、會一直停在 pending 等同儕，
       -- 不先濾掉的話堆到 p_limit 筆以上，排程每輪都只看到它們、新的對得上的永遠輪不到
       AND EXISTS (SELECT 1 FROM policy_jp.stat_registry r
                    WHERE r.lg_code = payload->>'lg_code' AND r.stat_key = payload->>'stat_key' AND r.year::TEXT = payload->>'year')
     ORDER BY created_at, id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 5000))
     FOR UPDATE SKIP LOCKED
  LOOP
    d := policy_jp.stat_registry_decide(c.payload);
    IF d->>'action' = 'skip' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF d->>'action' = 'reject' THEN
      UPDATE policy_jp.contributions
         SET status = 'rejected', reviewed_by = 'estat-auto', reviewed_at = now(),
             review_notes = '[estat-auto] 國勢調査（e-Stat）自動核對不通過：' || (d->>'reason') || '。照國勢調査的值改正後重新交件'
       WHERE id = c.id AND status = 'pending';
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;
    v_note := format('[estat-auto] 國勢調査（%s 年、基準日 %s）自動核對通過：值在容許差內', d->>'year', d->>'as_of');
    UPDATE policy_jp.contributions
       SET status = 'verified', verified_at = now(), reviewed_by = 'estat-auto', reviewed_at = now(), review_notes = v_note
     WHERE id = c.id AND status = 'pending';
    v_out := policy_jp.apply_contribution(c.id, false);
    UPDATE policy_jp.contributions
       SET reviewed_by = 'estat-auto',
           review_notes = v_note || CASE WHEN review_notes IS NOT NULL AND review_notes <> v_note THEN '／' || review_notes ELSE '' END
     WHERE id = c.id;
    IF v_out->>'status' = 'applied' THEN v_applied := v_applied + 1;
    ELSIF v_out->>'status' = 'waiting' THEN v_waiting := v_waiting + 1;
    ELSE v_other := v_other + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('applied', v_applied, 'waiting', v_waiting, 'rejected', v_rejected, 'skipped', v_skipped, 'other', v_other);
END;
$$;
COMMENT ON FUNCTION policy_jp.stat_registry_verify_pending IS
  '國勢調査核對 pending 的 regional_stat（照正見 cec-verify）：一致→verified 並落庫（團體還沒進來的回 waiting、由 apply_verified_pending 接手）、不一致→退件、表裡沒有→不碰。pg_cron policy-jp-stat-registry-verify 每 10 分鐘';

-- ------------------------------------------------------------
-- 4. 排程（沒有 pg_cron 的環境略過）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-stat-registry-verify') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-stat-registry-verify')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-stat-registry-verify', '3,13,23,33,43,53 * * * *', 'SELECT policy_jp.stat_registry_verify_pending();')$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 5. 權限與自我檢查
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.stat_registry_tolerance(TEXT), policy_jp.stat_registry_decide(JSONB), policy_jp.stat_registry_verify_pending(INTEGER, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.stat_registry_tolerance(TEXT), policy_jp.stat_registry_decide(JSONB), policy_jp.stat_registry_verify_pending(INTEGER, UUID[]) TO service_role;

DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy_jp' AND c.relname = 'stat_registry') THEN
    RAISE EXCEPTION 'policy_jp.stat_registry 沒開 RLS';
  END IF;
  SELECT string_agg(DISTINCT g.grantee || ':' || g.privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.table_name = 'stat_registry'
     AND g.grantee IN ('anon', 'authenticated', 'PUBLIC') AND g.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'stat_registry：anon／authenticated 只能讀：%', bad; END IF;
  IF has_function_privilege('anon', 'policy_jp.stat_registry_verify_pending(integer, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.stat_registry_decide(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stat_registry_*：不該給 anon 執行';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
