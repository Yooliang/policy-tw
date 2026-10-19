-- 名冊比對表修正：異體字正規化＋同單位先比對（#678 #689 試跑後修正；2026-10-20）
-- ============================================================
--
-- 試跑（每輪 5 筆、只 new）出了兩筆重複人物（主線已關開關並 roster_reconcile_revert 撤回）：
--   (1) 名冊「張啓楷」（嘉義市長），站上已有「張啟楷」而且已有 2026 嘉義市長參選紀錄——啓／啟 異體字沒正規化，判成「我們漏了」；
--   (2) 名冊「王妃天崩開局穿越整頓霸凌者佀廣洋」（桃園市議員，法定全名），站上已有「佀廣洋」同職位 2026 參選紀錄——全名與暱稱沒處理。
--
-- 兩個修正：
--   1. 姓名鍵加常見異體字對照：roster_name_key(name)＝roster_name_fold(COALESCE(cec_name_key(name), NULLIF(cec_name_norm(name), '')))。
--      為什麼是「疊在 cec_name_key 上」而不是改 cec_name_norm：cec_registrations.name_key 是 GENERATED STORED、cec_candidates.name_norm 由 cec-sync 存了值，
--      改 IMMUTABLE 函式不會重算已存的值，兩邊會對不上；疊一層只用在名冊對帳（名冊那一邊用 roster_name_fold(name_key)），既有的比對一個字不動。
--      對照表 20 組（啓→啟, 峯→峰, 羣→群, 衞→衛, 敎→教, 綫→線, 裏→裡, 着→著, 温→溫, 寛→寬, 彦→彥, 恒→恆, 眞→真, 硏→研, 徳→德, 爲→為, 淸→清, 靑→青, 栢→柏, 銹→鏽；臺→台、黄→黃 cec_name_norm 本來就有），TS 版 FOLD_PAIRS（_shared/identity-normalize.ts）同一份，roster-reconcile-match.test.ts 比對兩邊相同。
--      全庫同名者查詢（person 檢查）、名冊同名多位（dup_n）、對上的比對全部用這個鍵。
--   2. 同單位先比對（sim，優先於全庫同名規則）：名冊這位沒有名字相同的紀錄，但同屆、同職位、同縣市（鄉鎮層級的選舉要同鄉鎮）已有一筆參選紀錄（含已對上名冊別一列的），
--      名字是名冊名的子字串或反過來（較短的至少 2 字）→ 不建，category＝missing_ambiguous、reason＝similar_name_in_unit（派代理確認）；pe_id／politician_id 帶出那一筆，
--      那一筆參選紀錄不再另外列成 ours_extra。正規化後相同的（張啓楷／張啟楷）直接對上＝both。
--
-- 只重定義 roster_reconcile_rows()（簽名與屬性不動）與 roster_reconcile_text()（多一個原因的中文標籤）；不碰設定、不碰任何資料列、不動 roster_reconcile_log。
-- 已撤回的兩位（log 裡 reg_id 唯一、reverted_at 有值）：修好後張啓楷會對上站上的張啟楷（both，不看 log）；佀廣洋全名落在 similar_name_in_unit（派代理），都不會再被建。
-- 守門：_shared/roster-reconcile-match.test.ts（PGlite）。

CREATE OR REPLACE FUNCTION roster_name_fold(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(p, '啓峯羣衞敎綫裏着温寛彦恒眞硏徳爲淸靑栢銹', '啟峰群衛教線裡著溫寬彥恆真研德為清青柏鏽')
$$;
COMMENT ON FUNCTION roster_name_fold(TEXT) IS '常見姓名異體字對照（啓→啟、峯→峰…），疊在 cec_name_key 上給名冊對帳用；TS 版 foldNameVariants 同一份對照（2026-10-20）';

CREATE OR REPLACE FUNCTION roster_name_key(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT roster_name_fold(COALESCE(cec_name_key(p), NULLIF(cec_name_norm(p), '')))
$$;
COMMENT ON FUNCTION roster_name_key(TEXT) IS '名冊對帳的姓名鍵：cec_name_key（退回 cec_name_norm）再做異體字對照（2026-10-20）';

CREATE OR REPLACE FUNCTION roster_reconcile_rows()
RETURNS TABLE (
  reg_id BIGINT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, sub_region TEXT, village TEXT, district TEXT,
  name TEXT, party TEXT, source_url TEXT, row_no INTEGER, pe_id INTEGER, politician_id UUID, our_status TEXT,
  category TEXT, reason TEXT, person_action TEXT, system_applied BOOLEAN, announce_id BIGINT, announce_state TEXT
)
LANGUAGE sql STABLE
SET enable_nestloop = off  -- 見檔頭：不關的話 CTE 列數被估成 1，選巢狀迴圈，10.6 秒；關掉 0.5 秒
AS $$
  WITH reg AS (
    SELECT r.id AS reg_id, r.election_id, r.election_type, replace(r.region, '臺', '台') AS county,
           r.sub_region, replace(r.sub_region, '臺', '台') AS town, r.village, r.district,
           r.name, roster_name_fold(r.name_key) AS name_key, r.party, r.source_url, r.row_no,
           NULLIF(btrim(replace(COALESCE(r.village, ''), '臺', '台')), '') AS village_n
      FROM cec_registrations r
      JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
  ),
  regn AS (
    SELECT g.*, CASE WHEN g.name_key IS NULL THEN NULL
                     ELSE count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.name_key) END AS dup_n
      FROM reg g
  ),
  ours AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type::TEXT AS election_type,
           pe.candidacy_status AS status, COALESCE(pe.withdrawn_after_filing, FALSE) AS filed_out,
           p.name AS pname,
           roster_name_key(p.name) AS nn,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE (pe.election_id, pe.election_type::TEXT) IN (SELECT DISTINCT x.election_id, x.election_type FROM reg x)
  ),
  hit AS (
    SELECT g.reg_id, o.pe_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type
                 AND o.county = g.county AND o.nn = g.name_key
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
  ),
  reg_deg AS (SELECT h.reg_id, count(*) AS n, min(h.pe_id) AS pe_id FROM hit h GROUP BY h.reg_id),
  pe_deg AS (SELECT h.pe_id, count(*) AS n FROM hit h GROUP BY h.pe_id),
  -- 同單位先比對（優先於全庫同名規則）：名冊這位沒有名字相同的紀錄，但同屆、同職位、同縣市（鄉鎮層級的選舉要同鄉鎮）已有一筆
  -- 參選紀錄（含已經對上名冊別一列的：正式庫的名冊真的有「佀廣洋」與長名兩列），名字是名冊名的子字串或反過來（較短的那個至少 2 字）——改過名、暱稱與全名、名冊寫法較長：
  -- 多半是同一個人，系統不建（建了就是重複人物），派代理確認（reason＝similar_name_in_unit）
  sim AS (
    SELECT g.reg_id, min(o.pe_id) AS pe_id, min(o.politician_id::TEXT)::UUID AS politician_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type AND o.county = g.county
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key
       AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
       AND ((length(o.nn) >= 2 AND strpos(g.name_key, o.nn) > 0) OR (length(g.name_key) >= 2 AND strpos(o.nn, g.name_key) > 0))
     GROUP BY g.reg_id
  ),
  -- 人物：全庫同名（姓名鍵相同、未合併）的人有幾位；剛好一位時，他要「看得出是同一個地方的人」（鄉鎮層級的選舉要同縣市同鄉鎮，其餘同縣市）
  -- 而且這一屆還沒有別筆參選紀錄（一人一屆一筆），才能掛上去
  pn AS MATERIALIZED (
    SELECT p.id, roster_name_key(p.name) AS nn, replace(p.region, '臺', '台') AS pregion, p.party
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND roster_name_key(p.name) IN (SELECT x.name_key FROM regn x WHERE x.name_key IS NOT NULL)
  ),
  pn_n AS (SELECT q.nn, count(*) AS n, min(q.id::TEXT)::UUID AS one_id, min(q.pregion) AS pregion, min(q.party) AS party FROM pn q GROUP BY q.nn),
  pplace AS (
    SELECT DISTINCT pe.politician_id, replace(rg.region, '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           NULLIF(btrim(replace(COALESCE(rg.village, ''), '臺', '台')), '') AS village
      FROM politician_elections pe JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  pplace_c AS (SELECT DISTINCT q.politician_id, q.county FROM pplace q),
  pplace_t AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL),
  -- 村里長：既有的參選紀錄在這個鄉鎮「有明確村里」（pv_any）而名冊的村里跟其中任何一個都不同（沒有 pv_eq）→ 不掛（同鄉鎮不同里的同名者是兩個人）
  pv_any AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  pv_eq AS (SELECT DISTINCT q.politician_id, q.county, q.town, q.village FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  p_has AS (
    SELECT DISTINCT pe.politician_id, pe.election_id
      FROM politician_elections pe WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  -- 全部用相等連接（不用相關子查詢：關掉 nested loop 之後，相關子查詢逐列掃整張暫存表，20 秒）
  person AS (
    SELECT g.reg_id,
           CASE WHEN COALESCE(n.n, 0) = 0 THEN 'new'
                WHEN n.n = 1
                 AND h.politician_id IS NULL
                 AND (CASE WHEN g.town IS NULL THEN (n.pregion = g.county OR pc.politician_id IS NOT NULL)
                           ELSE pt.politician_id IS NOT NULL END)
                 AND NOT (g.election_type = '村里長' AND g.village_n IS NOT NULL AND va.politician_id IS NOT NULL AND ve.politician_id IS NULL)
                 -- 政黨互斥（兩邊都不是無黨籍、而且不同黨）不自動掛
                 AND NOT (COALESCE(btrim(g.party), '') NOT IN ('', '無', '無黨籍') AND COALESCE(btrim(n.party), '') NOT IN ('', '無', '無黨籍')
                          AND strpos(n.party, g.party) = 0 AND strpos(g.party, n.party) = 0)
                THEN 'attach' END AS person_action,
           CASE WHEN n.n = 1 THEN n.one_id END AS one_id
      FROM regn g
      LEFT JOIN pn_n n ON n.nn = g.name_key
      LEFT JOIN p_has h ON h.politician_id = n.one_id AND h.election_id = g.election_id
      LEFT JOIN pplace_c pc ON pc.politician_id = n.one_id AND pc.county = g.county
      LEFT JOIN pplace_t pt ON pt.politician_id = n.one_id AND pt.county = g.county AND pt.town = g.town
      LEFT JOIN pv_any va ON va.politician_id = n.one_id AND va.county = g.county AND va.town = g.town
      LEFT JOIN pv_eq ve ON ve.politician_id = n.one_id AND ve.county = g.county AND ve.town = g.town AND ve.village = g.village_n
     WHERE g.name_key IS NOT NULL AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
  ),
  rows_reg AS (
    SELECT g.reg_id, g.election_id, g.election_type, g.county, COALESCE(g.town, '') AS town, g.sub_region, g.village, g.district,
           g.name, g.party, g.source_url, g.row_no, COALESCE(o.pe_id, sm.pe_id) AS pe_id, COALESCE(o.politician_id, sm.politician_id, pr.one_id) AS politician_id, o.status AS our_status,
           CASE
             WHEN g.name_key IS NULL THEN 'missing_ambiguous'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' OR (o.status = 'withdrawn' AND NOT o.filed_out) THEN 'status_mismatch' ELSE 'both' END
             WHEN rd.n >= 1 THEN 'match_ambiguous'
             WHEN sm.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN ap.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN g.dup_n > 1 THEN 'missing_ambiguous'
             WHEN pr.person_action IS NULL THEN 'missing_ambiguous'
             ELSE 'missing_creatable' END AS category,
           CASE
             WHEN g.name_key IS NULL THEN 'unreadable_name'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' THEN 'ours_considering'
                    WHEN o.status = 'withdrawn' AND NOT o.filed_out THEN 'ours_withdrawn_not_after_filing' END
             WHEN rd.n >= 1 THEN 'match_not_one_to_one'
             WHEN sm.reg_id IS NOT NULL THEN 'similar_name_in_unit'
             WHEN ap.reg_id IS NOT NULL THEN
               CASE WHEN ap.reverted_at IS NOT NULL THEN 'system_reverted'
                    WHEN ap.outcome = 'applied' THEN 'system_applied_gone'
                    ELSE 'system_unresolved' END
             WHEN g.dup_n > 1 THEN 'same_name_multi'
             WHEN pr.person_action IS NULL THEN 'person_unclear'
             END AS reason,
           CASE WHEN rd.n IS NULL AND ap.reg_id IS NULL AND sm.reg_id IS NULL AND g.name_key IS NOT NULL AND g.dup_n = 1 THEN pr.person_action END AS person_action,
           (ap.reg_id IS NOT NULL AND ap.outcome = 'applied' AND ap.reverted_at IS NULL) AS system_applied
      FROM regn g
      LEFT JOIN reg_deg rd ON rd.reg_id = g.reg_id
      LEFT JOIN pe_deg pd ON pd.pe_id = rd.pe_id
      LEFT JOIN ours o ON o.pe_id = rd.pe_id
      LEFT JOIN person pr ON pr.reg_id = g.reg_id
      LEFT JOIN sim sm ON sm.reg_id = g.reg_id
      LEFT JOIN roster_reconcile_log ap ON ap.reg_id = g.reg_id
  ),
  rows_ours AS (
    SELECT NULL::BIGINT AS reg_id, o.election_id, o.election_type, o.county, COALESCE(o.town, '') AS town, o.town AS sub_region, NULL::TEXT AS village, NULL::TEXT AS district,
           o.pname AS name, NULL::TEXT AS party, NULL::TEXT AS source_url, NULL::INTEGER AS row_no,
           o.pe_id, o.politician_id, o.status AS our_status,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'ours_extra' ELSE 'status_mismatch' END AS category,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'not_in_registration' ELSE 'filed_flag_no_registration' END AS reason,
           NULL::TEXT AS person_action, FALSE AS system_applied
      FROM ours o
     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)
       AND o.pe_id NOT IN (SELECT s2.pe_id FROM sim s2)   -- 已經由名冊那一列（similar_name_in_unit）帶出來的，不重複列
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  )
  SELECT x.reg_id, x.election_id, x.election_type, x.county, x.town, x.sub_region, x.village, x.district,
         x.name, x.party, x.source_url, x.row_no, x.pe_id, x.politician_id, x.our_status,
         x.category, x.reason, x.person_action, x.system_applied,
         NULL::BIGINT AS announce_id, NULL::TEXT AS announce_state
    FROM (SELECT * FROM rows_reg UNION ALL SELECT * FROM rows_ours) x
$$;


CREATE OR REPLACE FUNCTION roster_reconcile_text(p_unit JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_unit IS NULL THEN '' ELSE
    '【名冊對帳】中選會登記彙總表在這個範圍共 ' || (p_unit->>'total') || ' 位，系統已跟我們的參選紀錄逐位對過：都對上 ' || (p_unit->>'both')
    || ' 位；唯一對上卻缺的 ' || (p_unit->>'creatable') || ' 位由系統自己建（不用你補，也請不要重交）。'
    || '系統對不上、要你處理的有 ' || ((p_unit->>'ambiguous')::INTEGER + (p_unit->>'ours_extra')::INTEGER + (p_unit->>'status_mismatch')::INTEGER)
    || ' 位（完整的在 target.reconcile.people，最多列 40 位）：'
    || COALESCE((SELECT string_agg(
         (e.value->>'name') || '（' || CASE e.value->>'reason'
            WHEN 'same_name_multi' THEN '名冊上同名多位'
            WHEN 'person_unclear' THEN '資料庫的同名人物對不唯一'
            WHEN 'unreadable_name' THEN '名冊姓名抽不出來'
            WHEN 'match_not_one_to_one' THEN '兩邊不是一對一'
            WHEN 'similar_name_in_unit' THEN '同單位已有名字相近的紀錄（可能是同一人：改名、暱稱或全名），請確認'
            WHEN 'system_unresolved' THEN '系統建不起來'
            WHEN 'system_reverted' THEN '系統建了又被還原'
            WHEN 'system_applied_gone' THEN '系統建過但那筆已經不在'
            WHEN 'not_in_registration' THEN '我們有、名冊上沒有'
            WHEN 'ours_considering' THEN '名冊上有、我們標可能參選'
            WHEN 'ours_withdrawn_not_after_filing' THEN '名冊上有、我們標退選卻沒標登記後退選'
            WHEN 'filed_flag_no_registration' THEN '我們標登記後退選、名冊上沒有'
            ELSE COALESCE(e.value->>'reason', '') END
         || COALESCE('，' || NULLIF(concat_ws(' ', e.value->>'sub_region', e.value->>'village', e.value->>'district'), ''), '') || '）', '、'
         ORDER BY e.ord) FROM jsonb_array_elements(p_unit->'people') WITH ORDINALITY AS e(value, ord) WHERE e.ord <= 40), '')
    || CASE WHEN COALESCE((p_unit->>'truncated')::BOOLEAN, false)
            THEN '。**這份名單已截斷（只列了前 40 位，不是全部）**：沒列出來的對不上的人**不是**系統會建的——補完這一批回報後，下一輪會列出下一批；先處理眼前這些'
            ELSE '' END
    || '。名冊上有、我們沒有的，用 candidacy 補（附登記彙總表網址）；我們多出來而名冊上沒有的，查證後用 correction 改狀態；狀態不一致的用 correction 改。'
    || CASE WHEN COALESCE((p_unit->>'truncated')::BOOLEAN, false) THEN '' ELSE '這一段以外的人系統都處理了，不用逐位再查。' END
  END
$$;

COMMENT ON FUNCTION roster_reconcile_rows() IS
  '名冊比對表本體（視圖 roster_reconcile 的外殼）：登記彙總表現行版 × 我們的參選紀錄，逐人判定 category／reason。SET enable_nestloop = off 是故意的（不關 10.6 秒，關了 0.5 秒），改前先看 20261019120000 檔頭。2026-10-20：姓名鍵加異體字正規化（roster_name_key）、同單位先比對（sim，reason＝similar_name_in_unit）';
