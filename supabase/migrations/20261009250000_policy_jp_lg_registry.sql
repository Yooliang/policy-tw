-- 日本站：地方公共団体（local_government）交件的機器核對——照正見 cec-verify「對得上直接落庫」
-- ============================================================
--
-- 前提：20261009210000_policy_jp_apply.sql（apply_contribution、local_government 型別）。
-- 資料：20261009250100_policy_jp_lg_registry_data.sql（scripts/gen-jp-lg-registry.ts 產生）。
--
-- 為什麼（維護者 10-09 裁定）：日本站開放後沒有其他代理，一筆 local_government 要 3 個不同網段的同意票，湊不起來，自治體名單進不來。
--   正見對「有權威資料庫可查」的交件用機器核對取代投票（cec-verify，2026-09-17：「如果有可驗證的 api 那他就可以只有 1 票」，
--   實際做成對得上直接落庫）。日本的自治體名單有總務省「全国地方公共団体コード」，同一個道理。
--   網站上的自治體仍然只從代理的交件來（10-08 裁定「也走代理交件」不變）：這張參考表只拿來核對，不顯示、也不從它建任何正式列。
--
-- 判斷（lg_registry_decide，跟 cec-verify 一樣分三種）：
--   apply ：團體碼在表裡，而且 pref_code、name、kana、kind 全部一致 → 標 verified（reviewed_by='soumu-auto'）並走同一條落庫路徑
--   reject：團體碼在表裡，但上面任一欄跟總務省不同（kind 的「市／中核市」除外）→ 退件，理由寫總務省的值
--   skip  ：團體碼不在表裡（R6.1.1 之後新設的團體）、或只差在「市／中核市」（中核市一覧停在 R5.4.1，之後可能有新指定）→ 不碰，留給同儕
-- 排程 policy-jp-lg-registry-verify 每 10 分鐘掃 pending 的 local_government（避開 seed 的整十分與落庫掃地機的 5 分）。
-- 市区町村比所屬都道府県先通過時，apply_contribution 回 waiting、貢獻維持 verified，都道府県落庫後由落庫掃地機（apply_verified_pending）接手。
-- 照 cec-verify：不投票、不動計分，只改貢獻狀態；落庫訊息後面接上核對紀錄，reviewed_by 留 soumu-auto（看得出是誰驗的）。

-- ------------------------------------------------------------
-- 1. 參考表：總務省的團體碼表（只拿來核對）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_jp.lg_code_registry (
  lg_code        TEXT PRIMARY KEY CHECK (policy_jp.lg_code_valid(lg_code)),
  pref_code      TEXT NOT NULL CHECK (pref_code = policy_jp.lg_pref_code(lg_code)),
  pref_name      TEXT NOT NULL CHECK (btrim(pref_name) <> ''),
  name           TEXT NOT NULL CHECK (btrim(name) <> ''),
  kana           TEXT NOT NULL CHECK (kana ~ '^[ぁ-ゖー]+$'),
  kana_raw       TEXT NOT NULL CHECK (btrim(kana_raw) <> ''),
  kind           TEXT NOT NULL CHECK (kind IN ('prefecture', 'designated_city', 'core_city', 'city', 'special_ward', 'admin_ward', 'town', 'village')),
  as_of          DATE NOT NULL,
  source_id      BIGINT NOT NULL REFERENCES policy_jp.sources(id),
  kind_as_of     DATE,
  kind_source_id BIGINT REFERENCES policy_jp.sources(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lg_code_registry_prefecture CHECK ((kind = 'prefecture') = (lg_code = pref_code)),
  CONSTRAINT lg_code_registry_core_source CHECK ((kind = 'core_city') = (kind_source_id IS NOT NULL AND kind_as_of IS NOT NULL))
);
COMMENT ON TABLE policy_jp.lg_code_registry IS
  '總務省「全国地方公共団体コード」（kind 的中核市另依「中核市一覧」）。只拿來機器核對代理交的 local_government（lg_registry_decide），'
  '不顯示、不從它建正式列；網站的自治體名單只來自通過的交件。資料由 scripts/gen-jp-lg-registry.ts 產生成 migration';
COMMENT ON COLUMN policy_jp.lg_code_registry.kana IS '讀音（ひらがな）：總務省表的半角カナ kana_raw 經 NFKC＋カタカナ→ひらがな（_shared/jp/kana.ts）';
COMMENT ON COLUMN policy_jp.lg_code_registry.kind IS 'prefecture／designated_city（政令市工作表）／admin_ward（政令市工作表的區）／special_ward（131xxx）／village（村）／town（町）／core_city（中核市一覧，kind_as_of 現在）／city';

ALTER TABLE policy_jp.lg_code_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_jp.lg_code_registry;
CREATE POLICY "Public read" ON policy_jp.lg_code_registry FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON policy_jp.lg_code_registry TO anon, authenticated;
GRANT ALL ON policy_jp.lg_code_registry TO service_role;

-- ------------------------------------------------------------
-- 2. 判斷：一筆 local_government 的 payload 跟總務省的表比
--    回 {action: apply|reject|skip, reason?, matched?, official?}
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.lg_registry_decide(p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  r policy_jp.lg_code_registry%ROWTYPE;
  v_code TEXT := p_payload->>'lg_code';
  v_pref TEXT := p_payload->>'pref_code';
  v_name TEXT := btrim(COALESCE(p_payload->>'name', ''));
  v_kana TEXT := btrim(COALESCE(p_payload->>'kana', ''));
  v_kind TEXT := p_payload->>'kind';
  bad TEXT[] := '{}';
BEGIN
  SELECT * INTO r FROM policy_jp.lg_code_registry WHERE lg_code = v_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'skip', 'reason', format('團體碼 %s 不在總務省的團體碼表裡（表的基準日之後新設、或碼打錯），留給同儕驗證', COALESCE(v_code, '(空白)')));
  END IF;
  IF v_pref IS DISTINCT FROM r.pref_code THEN bad := bad || format('pref_code 總務省是 %s、交件是 %s', r.pref_code, COALESCE(v_pref, '(空白)')); END IF;
  IF v_name IS DISTINCT FROM r.name THEN bad := bad || format('name 總務省是「%s」、交件是「%s」', r.name, v_name); END IF;
  IF v_kana IS DISTINCT FROM r.kana THEN bad := bad || format('kana 總務省是「%s」（表上寫 %s）、交件是「%s」', r.kana, r.kana_raw, v_kana); END IF;
  IF v_kind IS DISTINCT FROM r.kind
     AND NOT (r.kind IN ('city', 'core_city') AND v_kind IN ('city', 'core_city')) THEN
    bad := bad || format('kind 總務省是 %s、交件是 %s', r.kind, COALESCE(v_kind, '(空白)'));
  END IF;
  IF cardinality(bad) > 0 THEN
    RETURN jsonb_build_object('action', 'reject', 'reason', array_to_string(bad, '；'),
      'official', jsonb_build_object('lg_code', r.lg_code, 'pref_code', r.pref_code, 'name', r.name, 'kana', r.kana, 'kind', r.kind));
  END IF;
  IF v_kind IS DISTINCT FROM r.kind THEN
    -- 只差在市／中核市：中核市一覧是 kind_as_of（R5.4.1）的，之後新指定的不在裡面，機器不判
    RETURN jsonb_build_object('action', 'skip', 'reason', format('只差在市／中核市（總務省的中核市一覧是 %s 現在、這裡是 %s，交件是 %s），留給同儕驗證',
      COALESCE(r.kind_as_of, DATE '2023-04-01'), r.kind, v_kind));
  END IF;
  RETURN jsonb_build_object('action', 'apply', 'matched', jsonb_build_array('lg_code', 'pref_code', 'name', 'kana', 'kind'),
    'as_of', r.as_of, 'kind_as_of', r.kind_as_of);
END;
$$;

-- ------------------------------------------------------------
-- 3. 掃 pending 的 local_government：對得上 → verified＋落庫；對不上 → 退件；判不了 → 不碰
-- ------------------------------------------------------------
-- p_ids：只看這幾筆（jp-report 交件當下對剛收下的跑一次；machine-verify.ts）；NULL＝全部 pending（排程）
CREATE OR REPLACE FUNCTION policy_jp.lg_registry_verify_pending(p_limit INTEGER DEFAULT 2000, p_ids UUID[] DEFAULT NULL) RETURNS JSONB
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
     WHERE status = 'pending' AND contribution_type = 'local_government'
       AND (p_ids IS NULL OR id = ANY (p_ids))
       -- 只掃表裡查得到的團體碼：查不到的一定是 skip、會一直停在 pending 等同儕，不先濾掉的話堆多了會把新的擋在後面
       AND EXISTS (SELECT 1 FROM policy_jp.lg_code_registry r WHERE r.lg_code = payload->>'lg_code')
     ORDER BY created_at, id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 5000))
     FOR UPDATE SKIP LOCKED
  LOOP
    d := policy_jp.lg_registry_decide(c.payload);
    IF d->>'action' = 'skip' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF d->>'action' = 'reject' THEN
      UPDATE policy_jp.contributions
         SET status = 'rejected', reviewed_by = 'soumu-auto', reviewed_at = now(),
             review_notes = '[soumu-auto] 總務省團體碼表自動核對不通過：' || (d->>'reason') || '。照總務省的表改正後重新交件'
       WHERE id = c.id AND status = 'pending';
      v_rejected := v_rejected + 1;
      CONTINUE;
    END IF;
    v_note := format('[soumu-auto] 總務省團體碼表（%s 現在）自動核對通過：lg_code、pref_code、name、kana、kind 一致', d->>'as_of');
    UPDATE policy_jp.contributions
       SET status = 'verified', verified_at = now(), reviewed_by = 'soumu-auto', reviewed_at = now(), review_notes = v_note
     WHERE id = c.id AND status = 'pending';
    v_out := policy_jp.apply_contribution(c.id, false);
    -- 落庫會把 review_notes／reviewed_by 改成 auto-apply 的：核對紀錄接在前面、reviewed_by 留 soumu-auto（看得出是誰驗的）
    UPDATE policy_jp.contributions
       SET reviewed_by = 'soumu-auto',
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
COMMENT ON FUNCTION policy_jp.lg_registry_verify_pending IS
  '總務省團體碼表核對 pending 的 local_government（照正見 cec-verify）：一致→verified 並落庫（等都道府県的回 waiting、由 apply_verified_pending 接手）、不一致→退件、判不了→不碰。pg_cron policy-jp-lg-registry-verify 每 10 分鐘';

-- ------------------------------------------------------------
-- 4. 排程（沒有 pg_cron 的環境略過）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-lg-registry-verify') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-lg-registry-verify')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-lg-registry-verify', '2,12,22,32,42,52 * * * *', 'SELECT policy_jp.lg_registry_verify_pending();')$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 5. 權限與自我檢查
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.lg_registry_decide(JSONB), policy_jp.lg_registry_verify_pending(INTEGER, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.lg_registry_decide(JSONB), policy_jp.lg_registry_verify_pending(INTEGER, UUID[]) TO service_role;

DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy_jp' AND c.relname = 'lg_code_registry') THEN
    RAISE EXCEPTION 'policy_jp.lg_code_registry 沒開 RLS';
  END IF;
  SELECT string_agg(DISTINCT g.grantee || ':' || g.privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.table_name = 'lg_code_registry'
     AND g.grantee IN ('anon', 'authenticated', 'PUBLIC') AND g.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'lg_code_registry：anon／authenticated 只能讀：%', bad; END IF;
  IF has_function_privilege('anon', 'policy_jp.lg_registry_verify_pending(integer, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.lg_registry_decide(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'lg_registry_*：不該給 anon 執行';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp' AND p.proname LIKE 'lg\_registry\_%' AND p.prosrc ~ 'public\.';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'lg_registry_*：函式本體引用了正見的 schema：%', bad; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
