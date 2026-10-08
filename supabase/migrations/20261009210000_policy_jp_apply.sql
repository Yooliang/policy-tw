-- 日本站落庫（apply）：local_government／regional_stat／election 三種貢獻通過同儕驗證後寫進正式表（policy-jp #41 ④）
-- ============================================================
--
-- 前提：20261009130000_policy_jp_dispatch.sql（派工與計分）、20261009130100_policy_jp_election_discovery.sql（election 型別與臂）。
-- 這支只在 policy_jp 裡動手，不碰 public、ditrust，也不碰正見既有的函式、cron、Edge Function。
--
-- 維護者 10-08 的定案：日本站的資料一律走「代理交件 → 同儕驗證 → 落庫」，沒有人手寫 migration 補資料。
--   (1) 地方公共団体（都道府県・市区町村）→ 新交件型別 local_government，寫進 local_governments（目前是空表）
--   (2) 地域統計（人口・面積・歳出・高齢化率）→ 新交件型別 regional_stat，寫進新表 regional_stats
--   (3) 查到的選舉（election 型別，上一支 migration 已收）→ 落庫寫進 elections
--   (4) no_change（查過沒有異動／查無）→ 落庫就是記一筆 task_checks（冷卻），不動任何正式資料：
--       沒有這一步，通過驗證的 no_change 永遠停在 verified，refresh_dispatch_blocked 的 nochange 分支會把那個任務永遠擋住（#503）。
--   task_suggestion、correction 這輪不落庫（維持 verified）：沒有人要求，也沒有東西可寫。
--
-- 做法：SQL 函式（policy_jp.apply_contribution），不是 TS 模組。理由：
--   * 一筆貢獻的落庫要寫的東西（正式列、sources、source_refs、edit_history、貢獻狀態）在同一個交易裡成功或失敗，不會留下寫了一半的資料；
--     TS 版（正見 apply-contribution.ts）要靠 PostgREST 一次一個請求，失敗要自己補償。
--   * pg_cron 直接呼叫 SQL 函式就能重試，不需要再多一支 Edge Function；PGlite 測試能把整條路徑跑真的。
--   * jp-report 在票數讓狀態變 verified 的那一刻，用 rpc 呼叫它（_shared/jp/apply-contribution.ts，verify-handler 的 applyFn）。
--   正見的 TS 版有一套規矩，這裡照搬：衝突或失敗就不硬建（資料不如不建）——失敗 → apply_failed，10 分鐘後重試，連續 3 次失敗退件，
--   缺口會回到派工佇列重做；已經有一樣的資料就當成功（冪等）；已經有不一樣的資料不覆蓋、退件（沒有人工介入點）。
--
-- 等團體到了再落（#503 c）：elections.lg_code、regional_stats.lg_code、local_governments.pref_code 都有外鍵。團體還沒進來時不是「失敗」：
--   apply_blocker() 回傳等待原因，apply_contribution 回 waiting、不動貢獻的任何欄位（狀態仍是 verified），排程每次掃描只挑「不再被擋」的列；
--   等 local_government 落庫，下一輪排程（最多約 15 分鐘）就會把它們落下去。**不繞過外鍵**。等待中的清單看視圖 apply_waiting。
--
-- 守門：supabase/functions/_shared/policy-jp-apply.test.ts（PGlite 實跑整條路徑）。
-- 權限：新表 regional_stats 開 RLS、anon／authenticated 只讀 published（同 20261009000000 的慣例）；所有新函式只給 service_role。

-- ------------------------------------------------------------
-- 1. 共用的小函式
-- ------------------------------------------------------------
-- 縣市（pref_code）：團體碼前 2 碼＋000＋檢查碼（公式同 lg_code_valid；TS 版在 _shared/jp/lg-code.ts，兩邊有對齊測試）
CREATE OR REPLACE FUNCTION policy_jp.lg_pref_code(p_code TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN p_code ~ '^[0-9]{6}$' THEN
           substr(p_code, 1, 2) || '000' || ((11 - ((substr(p_code, 1, 1)::INT * 6 + substr(p_code, 2, 1)::INT * 5) % 11)) % 10)::TEXT
         END
$$;

-- 網址存進 slug：
--   * 市區町村直接用團體碼，不翻成羅馬字（翻譯會撞名：府中市、伊達市都不只一個）；
--   * 47 都道府県用固定的羅馬字（JIS 01〜47 的順序，跟 policy-jp src/lib/prefectures.ts 同一份）：畫面在資料庫還沒有那一列時
--     就用這個網址（/pref/tokyo），列進來後畫面改用這一欄——兩邊不同的話網址會在列進來的那一刻變掉。
--   規則只在這一支，之後要換一處改完
CREATE OR REPLACE FUNCTION policy_jp.local_government_slug(p_lg_code TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN p_lg_code ~ '^(0[1-9]|[1-3][0-9]|4[0-7])000[0-9]$'
              THEN (ARRAY[
                 'hokkaido', 'aomori', 'iwate', 'miyagi', 'akita', 'yamagata', 'fukushima', 'ibaraki', 'tochigi',
                 'gunma', 'saitama', 'chiba', 'tokyo', 'kanagawa', 'niigata', 'toyama', 'ishikawa', 'fukui',
                 'yamanashi', 'nagano', 'gifu', 'shizuoka', 'aichi', 'mie', 'shiga', 'kyoto', 'osaka', 'hyogo',
                 'nara', 'wakayama', 'tottori', 'shimane', 'okayama', 'hiroshima', 'yamaguchi', 'tokushima',
                 'kagawa', 'ehime', 'kochi', 'fukuoka', 'saga', 'nagasaki', 'kumamoto', 'oita', 'miyazaki',
                 'kagoshima', 'okinawa']::TEXT[])[substr(p_lg_code, 1, 2)::INT]
              ELSE p_lg_code
         END
$$;

-- 地域統計的單位：一個 stat_key 只有一種單位（人、km2、千円、%），交件要明寫單位，落庫時對這張表
CREATE OR REPLACE FUNCTION policy_jp.regional_stat_unit(p_stat_key TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_stat_key WHEN 'population' THEN '人' WHEN 'area_km2' THEN 'km2' WHEN 'budget_expenditure' THEN '千円' WHEN 'aging_rate' THEN '%' END
$$;

-- 落庫重試規則（同正見 consensus.ts 的 APPLY_MAX_RETRIES／APPLY_RETRY_DELAY_MINUTES；測試對齊）
CREATE OR REPLACE FUNCTION policy_jp.apply_max_retries() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
CREATE OR REPLACE FUNCTION policy_jp.apply_retry_delay_minutes() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

-- 這輪會落庫的型別（task_suggestion、correction 維持 verified）
CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'no_change']::TEXT[]
$$;

-- 出處網址的等級（依網域，只有這幾種；TS 版在 _shared/jp/source-kind.ts，兩邊有對齊測試）：
--   statistics＝e-Stat、統計局；regional_stat 的 soumu.go.jp 也算（総務省の統計）／official＝*.go.jp、*.lg.jp、city./town./vill./pref./ward. 開頭的 .jp／other＝其餘
CREATE OR REPLACE FUNCTION policy_jp.source_kind_for_url(p_url TEXT, p_contribution_type TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN x.h IS NULL THEN 'other'
           WHEN x.h ~ '(^|\.)(e-stat|stat)\.go\.jp$' THEN 'statistics'
           WHEN x.h ~ '(^|\.)soumu\.go\.jp$' AND p_contribution_type = 'regional_stat' THEN 'statistics'
           WHEN x.h ~ '\.(go|lg)\.jp$' THEN 'official'
           WHEN x.h ~ '(^|\.)(city|town|vill|village|pref|ward)\.[a-z0-9.-]+\.jp$' THEN 'official'
           ELSE 'other'
         END
    FROM (SELECT substring(lower(p_url) FROM '^https?://([^/:?#@]+)') AS h) x
$$;

-- 選舉的預設名稱（交件沒給 name 時用）：<団体名>＋長／知事／議会議員＋選挙（補欠・増員・再は接尾が変わる）
CREATE OR REPLACE FUNCTION policy_jp.election_default_name(p_type TEXT, p_reason TEXT, p_lg_name TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_type = 'national_lower' THEN '衆議院議員' || CASE WHEN p_reason IN ('regular', 'dissolution') THEN '総選挙' WHEN p_reason = 'by_election' THEN '補欠選挙' WHEN p_reason = 'rerun' THEN '再選挙' ELSE '選挙' END
           WHEN p_type = 'national_upper' THEN '参議院議員' || CASE WHEN p_reason = 'regular' THEN '通常選挙' WHEN p_reason = 'by_election' THEN '補欠選挙' WHEN p_reason = 'rerun' THEN '再選挙' ELSE '選挙' END
           ELSE COALESCE(p_lg_name, '')
                || CASE p_type WHEN 'governor' THEN '知事' WHEN 'pref_assembly' THEN '議会議員' WHEN 'muni_assembly' THEN '議会議員' ELSE '長' END
                || CASE WHEN p_reason = 'by_election' THEN '補欠選挙' WHEN p_reason = 'increase' THEN '増員選挙' WHEN p_reason = 'rerun' THEN '再選挙' ELSE '選挙' END
         END
$$;

-- ------------------------------------------------------------
-- 2. 表：地域統計 regional_stats
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_jp.regional_stats (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lg_code       TEXT NOT NULL REFERENCES policy_jp.local_governments(lg_code) CHECK (policy_jp.lg_code_valid(lg_code)),
  stat_key      TEXT NOT NULL CHECK (stat_key IN ('population', 'area_km2', 'budget_expenditure', 'aging_rate')),
  year          INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  value         NUMERIC NOT NULL,
  unit          TEXT NOT NULL,
  as_of         DATE CHECK (as_of IS NULL OR as_of BETWEEN DATE '1947-01-01' AND DATE '2100-12-31'),
  source_id     BIGINT NOT NULL REFERENCES policy_jp.sources(id),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'published', 'rejected', 'not_found')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT regional_stats_unique UNIQUE (lg_code, stat_key, year),
  CONSTRAINT regional_stats_unit_matches CHECK (unit = policy_jp.regional_stat_unit(stat_key)),
  CONSTRAINT regional_stats_value_range CHECK (
    value >= 0
    AND (stat_key <> 'aging_rate' OR value <= 100)
    AND (stat_key <> 'area_km2' OR value > 0)
    AND (stat_key NOT IN ('population', 'budget_expenditure') OR value = trunc(value)))
);
CREATE INDEX IF NOT EXISTS regional_stats_key_year_idx ON policy_jp.regional_stats (stat_key, year);
COMMENT ON TABLE policy_jp.regional_stats IS
  '地域統計（市区町村・都道府県の人口、面積、歳出、高齢化率）。一律走代理交件（contribution_type=regional_stat）→ 同儕驗證 → 落庫。'
  'year＝西暦（歳出は会計年度の開始年）、as_of＝基準日（例：国勢調査 2020-10-01）。source_id＝主要出處（e-Stat・総務省など）；'
  '一併附的其他網址留在 contributions.source_urls，edit_history.contribution_id 可以追回去';
COMMENT ON COLUMN policy_jp.regional_stats.unit IS '單位固定：population＝人／area_km2＝km2／budget_expenditure＝千円（決算カードの単位）／aging_rate＝%（65 歳以上人口の割合）';

DROP TRIGGER IF EXISTS trg_regional_stats_touch ON policy_jp.regional_stats;
CREATE TRIGGER trg_regional_stats_touch BEFORE UPDATE ON policy_jp.regional_stats FOR EACH ROW EXECUTE FUNCTION policy_jp.touch_updated_at();

ALTER TABLE policy_jp.regional_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read published" ON policy_jp.regional_stats;
CREATE POLICY "Public read published" ON policy_jp.regional_stats FOR SELECT TO anon, authenticated USING (review_status = 'published');
GRANT SELECT ON policy_jp.regional_stats TO anon, authenticated;
GRANT ALL ON policy_jp.regional_stats TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA policy_jp TO service_role;

-- ------------------------------------------------------------
-- 3. 交件型別：local_government、regional_stat（名字沿用上一支 migration 取的 policy_jp_contributions_type_check）
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat'));

-- ------------------------------------------------------------
-- 4. 出處：登記 sources、掛 source_refs（第一個官方／統計網址當主要，其餘佐證；已經有主要出處的一律記佐證）
--    回傳主要出處的 id（沒有任何有效網址回 NULL）。p_target_table 空＝只登記 sources、不掛引用（regional_stats 用自己的 source_id）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.source_write(
  p_target_table TEXT, p_target_id TEXT, p_urls TEXT[], p_contribution_type TEXT, p_origin TEXT DEFAULT 'contribution'
) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_url TEXT; v_kind TEXT; v_id BIGINT; v_first BIGINT; v_primary BIGINT; v_ids BIGINT[] := '{}';
BEGIN
  FOREACH v_url IN ARRAY COALESCE(p_urls, '{}'::TEXT[]) LOOP
    v_url := btrim(v_url);
    CONTINUE WHEN v_url !~* '^https?://[^/[:space:]]+';
    v_kind := policy_jp.source_kind_for_url(v_url, p_contribution_type);
    -- 擷取時間不知道就留空，不編造；選管的告示類登記 doc_kind（視圖 source_archive_missing 會列出還沒存檔的）
    INSERT INTO policy_jp.sources (url, source_kind, doc_kind, origin)
    VALUES (v_url, v_kind, CASE WHEN p_contribution_type = 'election' AND v_kind = 'official' THEN 'election_notice' END, p_origin)
    ON CONFLICT (url) DO NOTHING;
    SELECT s.id, s.source_kind INTO v_id, v_kind FROM policy_jp.sources s WHERE s.url = v_url;  -- 以庫裡既有的為準，不改舊列的等級
    v_ids := v_ids || v_id;
    v_first := COALESCE(v_first, v_id);
    IF v_primary IS NULL AND v_kind IN ('official', 'statistics') THEN v_primary := v_id; END IF;
  END LOOP;
  v_primary := COALESCE(v_primary, v_first);
  IF v_primary IS NULL THEN RETURN NULL; END IF;
  IF p_target_table IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, role, origin)
      VALUES (v_id, p_target_table, p_target_id,
              CASE WHEN v_id = v_primary
                    AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = p_target_table AND r.target_id = p_target_id
                                       AND r.role = 'primary' AND r.source_id <> v_id)
                   THEN 'primary' ELSE 'supporting' END,
              p_origin)
      ON CONFLICT (target_table, target_id, source_id) DO NOTHING;
    END LOOP;
  END IF;
  RETURN v_primary;
END;
$$;

-- ------------------------------------------------------------
-- 5. 等待條件：外鍵指到的團體還沒進來（回等待原因；NULL＝不用等）
--    payload 的團體碼本身不合格（不是 6 碼數字、檢查碼不對）時回 NULL：交給落庫函式判成 invalid 退件，不要讓打錯的團體碼永遠「等待」
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_blocker(p_type TEXT, p_payload JSONB) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_type = 'local_government'
                AND p_payload->>'kind' IS DISTINCT FROM 'prefecture'
                AND policy_jp.lg_code_valid(p_payload->>'pref_code')
                AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = p_payload->>'pref_code')
             THEN 'prefecture_missing:' || (p_payload->>'pref_code')
           WHEN p_type IN ('election', 'regional_stat')
                AND policy_jp.lg_code_valid(p_payload->>'lg_code')
                AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = p_payload->>'lg_code')
             THEN 'local_government_missing:' || (p_payload->>'lg_code')
         END
$$;

-- ------------------------------------------------------------
-- 6. 各型別的落庫（每支回 {outcome, message, table_name, record_id}；outcome：
--      applied＝寫了新資料／unchanged＝庫裡已經有一樣的（冪等，當成功）／conflict＝庫裡有不一樣的（不覆蓋，退件）／invalid＝內容本身不合格（退件）
--    真正的錯誤（外鍵、CHECK）直接丟例外，由 apply_contribution 記成 apply_failed 重試）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_local_government(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_code TEXT := p->>'lg_code';
  v_kind TEXT := p->>'kind';
  v_pref TEXT := p->>'pref_code';
  v_name TEXT := btrim(COALESCE(p->>'name', ''));
  v_kana TEXT := btrim(COALESCE(p->>'kana', ''));
  v_row policy_jp.local_governments%ROWTYPE;
  v_src BIGINT;
BEGIN
  IF v_code IS NULL OR NOT policy_jp.lg_code_valid(v_code) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lg_code 不是有效的全国地方公共団体コード（6 碼，檢查碼要對）');
  END IF;
  IF v_pref IS DISTINCT FROM policy_jp.lg_pref_code(v_code) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'pref_code 要是 lg_code 前 2 碼＋000＋檢查碼（所屬都道府県的團體碼）');
  END IF;
  IF COALESCE(v_kind, '') NOT IN ('prefecture', 'designated_city', 'core_city', 'city', 'special_ward', 'admin_ward', 'town', 'village') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'kind 不是 local_governments 的合法種類');
  END IF;
  IF (v_kind = 'prefecture') <> (v_code = v_pref) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'kind=prefecture 才能是都道府県的團體碼（XX000＋檢查碼），其他種類不能');
  END IF;
  IF v_name = '' OR v_kana = '' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'name、kana 不能是空的');
  END IF;

  SELECT * INTO v_row FROM policy_jp.local_governments WHERE lg_code = v_code;
  IF FOUND THEN
    IF (v_row.kind, v_row.pref_code, v_row.name, v_row.kana) IS DISTINCT FROM (v_kind, v_pref, v_name, v_kana) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'local_governments', 'record_id', v_code,
        'message', format('庫裡已有 %s（%s・%s・%s・%s），與提交的（%s・%s・%s・%s）不同，不覆蓋', v_code, v_row.kind, v_row.pref_code, v_row.name, v_row.kana, v_kind, v_pref, v_name, v_kana));
    END IF;
    v_src := policy_jp.source_write('local_governments', v_code, c.source_urls, 'local_government');
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'local_governments', 'record_id', v_code, 'message', format('%s（%s）已在庫裡，內容一致', v_name, v_code));
  END IF;

  v_src := policy_jp.source_write('local_governments', v_code, c.source_urls, 'local_government');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls 沒有可用的 http(s) 網址');
  END IF;
  INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug)
  VALUES (v_code, v_kind, v_pref, v_name, v_kana, policy_jp.local_government_slug(v_code))
  RETURNING * INTO v_row;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('local_governments', v_code, '*', NULL, to_jsonb(v_row), c.id, 'auto-apply');
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'local_governments', 'record_id', v_code, 'message', format('新增團體 %s（%s）', v_name, v_code));
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.apply_regional_stat(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_code TEXT := p->>'lg_code';
  v_key TEXT := p->>'stat_key';
  v_year INTEGER;
  v_value NUMERIC;
  v_unit TEXT := p->>'unit';
  v_as_of DATE;
  v_row policy_jp.regional_stats%ROWTYPE;
  v_src BIGINT;
  v_id TEXT;
BEGIN
  IF v_code IS NULL OR NOT policy_jp.lg_code_valid(v_code) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lg_code 不是有效的全国地方公共団体コード（6 碼，檢查碼要對）');
  END IF;
  IF policy_jp.regional_stat_unit(v_key) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'stat_key 要是 population／area_km2／budget_expenditure／aging_rate 之一');
  END IF;
  IF v_unit IS DISTINCT FROM policy_jp.regional_stat_unit(v_key) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s 的 unit 要是「%s」', v_key, policy_jp.regional_stat_unit(v_key)));
  END IF;
  IF jsonb_typeof(p->'year') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'value') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'year、value 要是數字');
  END IF;
  v_year := (p->>'year')::NUMERIC::INTEGER;
  v_value := (p->>'value')::NUMERIC;
  IF v_year <> (p->>'year')::NUMERIC OR v_year NOT BETWEEN 1900 AND 2100 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'year 要是 1900～2100 的整數（西暦）');
  END IF;
  IF p->>'as_of' IS NOT NULL THEN
    IF p->>'as_of' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'as_of 要是 YYYY-MM-DD');
    END IF;
    BEGIN
      v_as_of := (p->>'as_of')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'as_of 不是真的有這一天');
    END;
    IF v_as_of NOT BETWEEN DATE '1947-01-01' AND DATE '2100-12-31' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'as_of 要在 1947～2100 年之間');
    END IF;
  END IF;
  -- 值的範圍（同 regional_stats 的 CHECK）：先在這裡判，壞資料直接退件，不要拿去重試三次
  IF v_value < 0 OR (v_key = 'aging_rate' AND v_value > 100) OR (v_key = 'area_km2' AND v_value <= 0)
     OR (v_key IN ('population', 'budget_expenditure') AND v_value <> trunc(v_value)) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('value 超出 %s 的合理範圍（人口・歳出は 0 以上の整數、面積は正の數、高齢化率は 0～100）', v_key));
  END IF;
  v_id := v_code || '/' || v_key || '/' || v_year;

  SELECT * INTO v_row FROM policy_jp.regional_stats WHERE lg_code = v_code AND stat_key = v_key AND year = v_year;
  IF FOUND THEN
    IF v_row.value <> v_value OR v_row.unit <> v_unit THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'regional_stats', 'record_id', v_id,
        'message', format('庫裡已有 %s %s 年的 %s ＝ %s %s，與提交的 %s %s 不同，不覆蓋', v_code, v_year, v_key, v_row.value, v_row.unit, v_value, v_unit));
    END IF;
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'regional_stats', 'record_id', v_id, 'message', format('%s 已在庫裡，數值一致', v_id));
  END IF;

  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'regional_stat');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls 沒有可用的 http(s) 網址');
  END IF;
  INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, as_of, source_id, review_status)
  VALUES (v_code, v_key, v_year, v_value, v_unit, v_as_of, v_src, 'published')
  RETURNING * INTO v_row;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('regional_stats', v_id, '*', NULL, to_jsonb(v_row), c.id, 'auto-apply');
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'regional_stats', 'record_id', v_id, 'message', format('新增統計 %s ＝ %s %s', v_id, v_value, v_unit));
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.apply_election(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_type TEXT := p->>'election_type';
  v_reason TEXT := p->>'election_reason';
  v_lg TEXT := NULLIF(p->>'lg_code', '');
  v_date DATE;
  v_notice DATE;
  v_id TEXT;
  v_name TEXT;
  v_lg_name TEXT;
  e policy_jp.elections%ROWTYPE;
  v_src BIGINT;
BEGIN
  IF v_type IS NULL OR policy_jp.election_level(v_type) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_type 不是 elections 的合法種類');
  END IF;
  IF COALESCE(v_reason, '') NOT IN ('regular', 'resignation', 'death', 'recall', 'dissolution', 'by_election', 'increase', 'rerun') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_reason 不是 elections 的合法事由');
  END IF;
  IF (policy_jp.election_level(v_type) = 'national') <> (v_lg IS NULL) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '國政選舉（national_lower／national_upper）不帶 lg_code，地方選舉一定要帶');
  END IF;
  IF v_lg IS NOT NULL AND NOT policy_jp.lg_code_valid(v_lg) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lg_code 不是有效的全国地方公共団体コード（6 碼，檢查碼要對）');
  END IF;
  IF v_reason IN ('by_election', 'increase') AND v_type NOT IN ('pref_assembly', 'muni_assembly', 'national_lower', 'national_upper') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '補欠選挙・増員選挙只有議員選舉');
  END IF;
  -- 日期：形狀、真的有這一天、年份在 1947～2100（PostgreSQL 不收 0000 年）
  IF p->>'election_date' IS NULL OR p->>'election_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_date 要是 YYYY-MM-DD');
  END IF;
  BEGIN
    v_date := (p->>'election_date')::DATE;
    IF p->>'notice_date' IS NOT NULL THEN
      IF p->>'notice_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'notice_date 形狀不對'; END IF;
      v_notice := (p->>'notice_date')::DATE;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_date／notice_date 不是真的有這一天');
  END;
  IF v_date NOT BETWEEN DATE '1947-01-01' AND DATE '2100-12-31' OR (v_notice IS NOT NULL AND v_notice NOT BETWEEN DATE '1947-01-01' AND DATE '2100-12-31') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '日期要在 1947～2100 年之間');
  END IF;
  IF v_notice IS NOT NULL AND v_notice > v_date THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'notice_date（告示日）不能晚於 election_date（投票日）');
  END IF;

  v_id := to_char(v_date, 'YYYY-MM-DD') || '_' || v_type || '_' || COALESCE(v_lg, 'national');
  SELECT * INTO e FROM policy_jp.elections WHERE id = v_id;
  IF FOUND THEN
    IF (e.election_date, e.election_type, e.lg_code, e.election_reason) IS DISTINCT FROM (v_date, v_type, v_lg, v_reason)
       OR e.review_status IN ('rejected', 'not_found')
       OR (e.notice_date IS NOT NULL AND v_notice IS NOT NULL AND e.notice_date <> v_notice) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'elections', 'record_id', v_id,
        'message', format('庫裡已有 %s（事由 %s・告示日 %s・%s），與提交的（事由 %s・告示日 %s）不同或已被退回，不覆蓋', v_id, e.election_reason, COALESCE(e.notice_date::TEXT, '未記'), e.review_status, v_reason, COALESCE(v_notice::TEXT, '未記')));
    END IF;
    -- 一樣的選舉：補上缺的告示日、待查核的升成上線（共識已經通過），其餘不動
    IF (e.notice_date IS NULL AND v_notice IS NOT NULL) OR e.review_status <> 'published' THEN
      UPDATE policy_jp.elections SET notice_date = COALESCE(notice_date, v_notice), review_status = 'published' WHERE id = v_id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('elections', v_id, '*', to_jsonb(e), (SELECT to_jsonb(x) FROM policy_jp.elections x WHERE x.id = v_id), c.id, 'auto-apply');
    END IF;
    v_src := policy_jp.source_write('elections', v_id, c.source_urls, 'election');
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'elections', 'record_id', v_id, 'message', format('%s 已在庫裡，內容一致', v_id));
  END IF;

  v_src := policy_jp.source_write('elections', v_id, c.source_urls, 'election');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls 沒有可用的 http(s) 網址');
  END IF;
  IF v_lg IS NOT NULL THEN SELECT g.name INTO v_lg_name FROM policy_jp.local_governments g WHERE g.lg_code = v_lg; END IF;
  v_name := COALESCE(NULLIF(btrim(p->>'name'), ''), policy_jp.election_default_name(v_type, v_reason, v_lg_name));
  -- 層級由種類決定（elections_level_matches_type）；團體不在表裡會被外鍵擋下（apply_blocker 已經先擋掉，不會走到這裡）
  INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, lg_code, review_status)
  VALUES (v_id, v_name, v_date, v_notice, v_type, v_reason, policy_jp.election_level(v_type), v_lg, 'published')
  RETURNING * INTO e;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('elections', v_id, '*', NULL, to_jsonb(e), c.id, 'auto-apply');
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'elections', 'record_id', v_id, 'message', format('新增選舉 %s（%s）', v_id, v_name));
END;
$$;

-- no_change：查過、沒有要改的。落庫＝記一筆 task_checks（冷卻：confirmed／not_found 14 天、unreachable 2 天），不動任何正式資料
CREATE OR REPLACE FUNCTION policy_jp.apply_no_change(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_task TEXT := COALESCE(NULLIF(c.payload->>'task_id', ''), c.task_id);
  v_outcome TEXT := c.payload->>'outcome';
BEGIN
  IF v_task IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'no_change 沒有 task_id，不知道是查哪個任務');
  END IF;
  IF COALESCE(v_outcome, '') NOT IN ('confirmed', 'unreachable', 'not_found') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'outcome 要是 confirmed／unreachable／not_found');
  END IF;
  INSERT INTO policy_jp.task_checks (task_id, agent_name, note, contribution_id, outcome)
  VALUES (v_task, c.agent_name, left(c.payload->>'finding', 1000), c.id, v_outcome);
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'task_checks', 'record_id', v_task, 'message', format('記下 %s 的查核（%s），進入冷卻', v_task, v_outcome));
END;
$$;

-- ------------------------------------------------------------
-- 7. 落庫主函式：verified（或到期的 apply_failed）→ applied／rejected／apply_failed；
--    回 {status: applied|rejected|apply_failed|waiting|unsupported|skipped|not_found, message, ...}
--    · 鎖住這一列（FOR UPDATE），行內落庫與排程撞在一起也只有一個會做
--    · 任何例外都被攔在子交易裡：這次寫的東西整個回滾，只更新貢獻的狀態與重試欄位
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_contribution(p_id UUID, p_retry BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  c policy_jp.contributions%ROWTYPE;
  v_blocker TEXT;
  v_out JSONB;
  v_err TEXT;
  v_count INTEGER;
  v_msg TEXT;
BEGIN
  SELECT * INTO c FROM policy_jp.contributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF NOT (c.status = 'verified'
          OR (p_retry AND c.status = 'apply_failed' AND c.retry_count < policy_jp.apply_max_retries() AND c.next_retry_at IS NOT NULL AND c.next_retry_at <= now())) THEN
    RETURN jsonb_build_object('status', 'skipped', 'contribution_status', c.status);
  END IF;
  IF NOT (c.contribution_type = ANY (policy_jp.apply_types())) THEN
    RETURN jsonb_build_object('status', 'unsupported', 'contribution_type', c.contribution_type);
  END IF;
  v_blocker := policy_jp.apply_blocker(c.contribution_type, c.payload);
  IF v_blocker IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'waiting', 'reason', v_blocker, 'message', '外鍵指到的團體還沒落庫，等它進來再落（貢獻維持 ' || c.status || '）：' || v_blocker);
  END IF;

  BEGIN
    v_out := CASE c.contribution_type
               WHEN 'local_government' THEN policy_jp.apply_local_government(c)
               WHEN 'regional_stat' THEN policy_jp.apply_regional_stat(c)
               WHEN 'election' THEN policy_jp.apply_election(c)
               ELSE policy_jp.apply_no_change(c)
             END;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_count := c.retry_count + 1;
    IF v_count >= policy_jp.apply_max_retries() THEN
      -- 連續失敗：不硬建，退件；缺口還在，派工佇列之後會重新派出去（正見 auto-apply.ts 的 GAP_RETURNS）
      UPDATE policy_jp.contributions SET status = 'rejected', retry_count = v_count, last_error = v_err, next_retry_at = NULL,
             review_notes = '[auto] 落庫連續 ' || v_count || ' 次失敗，退件：' || v_err || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
             reviewed_by = 'auto-apply', reviewed_at = now()
       WHERE id = c.id;
      RETURN jsonb_build_object('status', 'rejected', 'message', v_err, 'retry_count', v_count);
    END IF;
    UPDATE policy_jp.contributions SET status = 'apply_failed', retry_count = v_count, last_error = v_err,
           next_retry_at = now() + make_interval(mins => policy_jp.apply_retry_delay_minutes()),
           review_notes = '[auto] 落庫失敗（第 ' || v_count || ' 次，' || policy_jp.apply_retry_delay_minutes() || ' 分鐘後重試）：' || v_err,
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'apply_failed', 'message', v_err, 'retry_count', v_count);
  END;

  v_msg := v_out->>'message';
  IF v_out->>'outcome' IN ('conflict', 'invalid') THEN
    UPDATE policy_jp.contributions SET status = 'rejected', last_error = NULL, next_retry_at = NULL,
           review_notes = '[auto] ' || v_msg || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'rejected', 'outcome', v_out->>'outcome', 'message', v_msg);
  END IF;
  -- applied／unchanged：狀態轉 applied 會觸發 contributions_drop_dispatch，自動缺口的派工列立刻收回
  UPDATE policy_jp.contributions SET status = 'applied', applied_at = now(), last_error = NULL, next_retry_at = NULL,
         review_notes = '[auto] ' || v_msg, reviewed_by = 'auto-apply', reviewed_at = now()
   WHERE id = c.id;
  RETURN jsonb_build_object('status', 'applied', 'outcome', v_out->>'outcome', 'message', v_msg, 'table_name', v_out->>'table_name', 'record_id', v_out->>'record_id');
END;
$$;

-- 排程掃地機：行內落庫漏掉的 verified（超過寬限）與到期的 apply_failed。只挑「不再被擋」的列，被擋的（等團體）不佔額度
CREATE OR REPLACE FUNCTION policy_jp.apply_verified_pending(p_limit INTEGER DEFAULT 20, p_grace_minutes INTEGER DEFAULT 5) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  r RECORD;
  v JSONB;
  v_applied INTEGER := 0;
  v_rejected INTEGER := 0;
  v_failed INTEGER := 0;
  v_scanned INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id, c.status FROM policy_jp.contributions c
     WHERE c.contribution_type = ANY (policy_jp.apply_types())
       AND policy_jp.apply_blocker(c.contribution_type, c.payload) IS NULL
       AND ((c.status = 'verified' AND COALESCE(c.verified_at, c.created_at) <= now() - make_interval(mins => p_grace_minutes))
         OR (c.status = 'apply_failed' AND c.retry_count < policy_jp.apply_max_retries() AND c.next_retry_at <= now()))
     ORDER BY COALESCE(c.verified_at, c.created_at), c.id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  LOOP
    v_scanned := v_scanned + 1;
    v := policy_jp.apply_contribution(r.id, r.status = 'apply_failed');
    IF v->>'status' = 'applied' THEN v_applied := v_applied + 1;
    ELSIF v->>'status' = 'rejected' THEN v_rejected := v_rejected + 1;
    ELSIF v->>'status' = 'apply_failed' THEN v_failed := v_failed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('scanned', v_scanned, 'applied', v_applied, 'rejected', v_rejected, 'apply_failed', v_failed);
END;
$$;

-- 等團體到了才能落的：正常會有幾筆（團體表在補），久了才是問題。service_role 用
CREATE OR REPLACE VIEW policy_jp.apply_waiting WITH (security_invoker = true) AS
  SELECT c.id, c.contribution_type, c.status, COALESCE(c.verified_at, c.created_at) AS since,
         policy_jp.apply_blocker(c.contribution_type, c.payload) AS waiting_for,
         now() - COALESCE(c.verified_at, c.created_at) AS waited
    FROM policy_jp.contributions c
   WHERE c.status IN ('verified', 'apply_failed')
     AND c.contribution_type = ANY (policy_jp.apply_types())
     AND policy_jp.apply_blocker(c.contribution_type, c.payload) IS NOT NULL;
COMMENT ON VIEW policy_jp.apply_waiting IS '通過驗證、卻在等外鍵指到的團體（local_governments）落庫才能落庫的貢獻。團體進來後，排程下一輪自動落；待很久的看 waited（團體碼打錯的、真的不存在的會一直在這裡）。service_role 用';

-- ------------------------------------------------------------
-- 8. 排程：每 10 分鐘掃一次（避開 seed 的 */10 整點）。pg_cron 不在的環境（本機、測試）略過，不讓 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-apply-verified') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-apply-verified')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-apply-verified', '5,15,25,35,45,55 * * * *', 'SELECT policy_jp.apply_verified_pending();')$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 9. 權限：新函式一律不給 PUBLIC／anon／authenticated，只給 service_role；視圖同
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  policy_jp.lg_pref_code(TEXT), policy_jp.local_government_slug(TEXT), policy_jp.regional_stat_unit(TEXT), policy_jp.apply_max_retries(),
  policy_jp.apply_retry_delay_minutes(), policy_jp.apply_types(), policy_jp.source_kind_for_url(TEXT, TEXT), policy_jp.election_default_name(TEXT, TEXT, TEXT),
  policy_jp.source_write(TEXT, TEXT, TEXT[], TEXT, TEXT), policy_jp.apply_blocker(TEXT, JSONB),
  policy_jp.apply_local_government(policy_jp.contributions), policy_jp.apply_regional_stat(policy_jp.contributions),
  policy_jp.apply_election(policy_jp.contributions), policy_jp.apply_no_change(policy_jp.contributions),
  policy_jp.apply_contribution(UUID, BOOLEAN), policy_jp.apply_verified_pending(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  policy_jp.lg_pref_code(TEXT), policy_jp.local_government_slug(TEXT), policy_jp.regional_stat_unit(TEXT), policy_jp.apply_max_retries(),
  policy_jp.apply_retry_delay_minutes(), policy_jp.apply_types(), policy_jp.source_kind_for_url(TEXT, TEXT), policy_jp.election_default_name(TEXT, TEXT, TEXT),
  policy_jp.source_write(TEXT, TEXT, TEXT[], TEXT, TEXT), policy_jp.apply_blocker(TEXT, JSONB),
  policy_jp.apply_local_government(policy_jp.contributions), policy_jp.apply_regional_stat(policy_jp.contributions),
  policy_jp.apply_election(policy_jp.contributions), policy_jp.apply_no_change(policy_jp.contributions),
  policy_jp.apply_contribution(UUID, BOOLEAN), policy_jp.apply_verified_pending(INTEGER, INTEGER)
  TO service_role;
-- CHECK 約束裡呼叫的函式要讓寫入的角色（service_role）和讀表的角色都能求值：regional_stat_unit 在 CHECK 裡，anon 讀表不需要執行權限（約束只在寫入時檢查）
REVOKE ALL ON policy_jp.apply_waiting FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.apply_waiting TO service_role;

-- ------------------------------------------------------------
-- 10. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy_jp' AND c.relname = 'regional_stats') THEN
    RAISE EXCEPTION 'policy_jp.regional_stats 沒開 RLS';
  END IF;
  SELECT string_agg(DISTINCT g.table_name || ':' || g.grantee || ':' || g.privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
     AND ((g.table_name = 'regional_stats' AND g.privilege_type <> 'SELECT') OR g.table_name = 'apply_waiting');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 落庫：anon／authenticated 的權限不對：%', bad; END IF;
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp'
     AND p.proname IN ('lg_pref_code', 'local_government_slug', 'regional_stat_unit', 'apply_max_retries', 'apply_retry_delay_minutes', 'apply_types',
                       'source_kind_for_url', 'election_default_name', 'source_write', 'apply_blocker', 'apply_local_government', 'apply_regional_stat',
                       'apply_election', 'apply_no_change', 'apply_contribution', 'apply_verified_pending')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 落庫：anon／authenticated 不該能執行這些函式：%', bad; END IF;
  -- 沒有任何函式本體提到 public.（獨立於正見）
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp' AND p.proname LIKE 'apply\_%' AND p.prosrc ~ 'public\.';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 落庫：函式本體提到 public.：%', bad; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
