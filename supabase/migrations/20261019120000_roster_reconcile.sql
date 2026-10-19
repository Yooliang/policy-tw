-- 名冊比對表：登記彙總表唯一對上由系統建參選紀錄，對不上才派代理（#678 第一階段：兩方對帳；2026-10-19 維護者「好，作」）
-- ============================================================
--
-- 維護者 10-19 的裁決（更正 10-05「資料一律走流程」對「建人物、建參選紀錄」的部分，**只限唯一對上**）：
--   * 名冊比對表＝每個人一列，記錄「登記彙總表 cec_registrations（19,695 人）／名單公告（11/17 才有，第二階段）／我們的 2026 參選紀錄」
--     各對到誰、判定哪一類；
--   * 登記彙總表唯一對上、我們沒有 → 系統直接建參選紀錄（必要時建人物）；同名多筆、對不到既有人物或對到多個、兩份來源對不起來、我們多出來 → 才派代理；
--   * 「官方資料比對得上的由系統寫入，對不上的才是缺口」：系統寫入要記來源（登記彙總表那一列）、進 edit_history（agent_name＝system:roster-reconcile）、可整筆還原。
--
-- 這支 migration **不寫任何人物或參選紀錄**（只建表、視圖、函式、排程）。真正建人物、建參選紀錄的是 Edge Function roster-reconcile：
-- 部署之後由 pg_cron 每 10 分鐘呼叫，落庫走跟代理交件同一套邏輯（_shared/apply-contribution.ts 的 applyCandidacy：身份、選區、結果欄位、出處，不另寫一套），
-- 每一輪最多 roster_reconcile_settings.batch_limit 筆；settings.enabled 設 false 就停。
--
-- ── 1. 對帳表怎麼算：視圖 roster_reconcile（函式 roster_reconcile_rows() 的外殼；為什麼不物化，見下）──
-- 一列＝登記彙總表現行版的一位登記者，加上「我們有、名冊沒有」的參選紀錄。比對沿用 roster_registration_gap 的做法，不自創：
--   同一屆、同一種選舉、同一個縣市，姓名鍵（cec_name_key，退回 cec_name_norm；跟 cec_candidates.name_norm 同一套）相同；
--   我們的紀錄有鄉鎮市區、名冊那一列也有，鄉鎮市區也要相同（臺→台）；議員的 regions.sub_region 是「第NN選舉區」不是鄉鎮，去掉選舉區就是空的、不比鄉鎮。
--   村里、選舉區不比（造字與寫法太雜；錯判成「沒有」只讓人多看一眼，錯判成「有」卻讓那個人永遠不在清單上）。
-- category：
--   both               都對上：名冊這位剛好對到我們一筆，那一筆也只對到他（登記後才退選的 withdrawn_after_filing 算對上）
--   missing_creatable  我們漏了（唯一可建）：名冊這位我們一筆都沒有，而且同一屆、同種選舉、同縣市名冊上沒有第二位同名者，
--                      而且人物也不含糊（person_action：new＝全庫沒有同名者；attach＝全庫剛好一位同名者，他在同縣市〔鄉鎮層級的選舉要同鄉鎮〕出現過、這一屆還沒有別筆參選紀錄）
--   missing_ambiguous  我們漏了但不能由系統建：reason＝same_name_multi 同名多筆／person_unclear 人物對不唯一／unreadable_name 名冊姓名抽不出來／
--                      system_unresolved 系統試過建不起來／system_reverted 系統建了又被還原／system_applied_gone 系統建過但那筆已經不在
--   match_ambiguous    兩邊不是一對一（名冊一位對到我們好幾筆，或我們一筆對到名冊好幾位）
--   ours_extra         我們多出來：我們標已表態／登記／選後（declared、filed、elected、not_elected）卻不在名冊上
--   status_mismatch    登記後退選的標記不一致：名冊上有這位，我們標 considering，或標 withdrawn 卻沒標登記後退選；或標了登記後退選卻不在名冊上
-- 派代理的類別＝missing_ambiguous、match_ambiguous、ours_extra、status_mismatch（roster_reconcile_units.needs_agent）。
--
-- ── 為什麼視圖不物化（取捨）──
-- 對帳要即時：系統建好、代理補好、有人改狀態，下一次讀就是新的；物化要有人負責刷新、刷新前的資料會讓系統重複建。算一次約 0.5 秒（19,695 列名冊 × 約 5,800 筆我們的紀錄，
-- 正式庫唯讀 EXPLAIN ANALYZE 實測），但**必須關掉 nested loop**：不關時規劃器把 CTE 的列數估成 1 列，選了巢狀迴圈，同一個查詢 10.6 秒（已量）。
-- 所以本體放在 SQL 函式 roster_reconcile_rows()（SET enable_nestloop = off；帶 SET 的函式不會被內嵌），視圖只是外殼。
-- 派工臂每 10 分鐘 seed、/tasks、/request-task 都會算臂，不能每次多 0.5 秒，所以臂讀的是單位層級的小表 roster_reconcile_units（約 700 列，
-- 由 roster_reconcile_refresh_units() 每 10 分鐘刷新，系統每寫完一輪也刷一次）；表是空的（還沒刷過）或沒有那個單位時，臂照舊派（不更動現況）。
--
-- ── 2. 第二階段的擴充點（11/17 名單公告匯入，加入對帳變三方；兩個模型各讀一次、不一致的行派代理看原檔）──
-- 視圖已留 announce_id（名單公告那一列的 id）、announce_state（both／only_registration／only_announce／disagree）兩欄，現在都是 NULL；
-- 第二階段新增名單公告表後，在 roster_reconcile_rows() 多一個 CTE 把它接進來、把 announce_state 填起來，並把「兩份來源對不起來」加進派代理的類別。
-- 現在的欄位名與類別名不會變。
--
-- ── 3. 系統寫入的記錄與還原 ──
-- roster_reconcile_log：每一位名冊登記者最多一列（reg_id 唯一）＝系統處理過了沒有、結果、建了哪個人物與參選紀錄、哪一輪（run_id）；
-- 還原：roster_reconcile_revert(run_id 或 reg_ids)：刪掉系統建的參選紀錄（以及系統建、沒有別的參選紀錄也沒有政見的人物），
-- 把 edit_history 對應的列標成已還原；別人在那之後動過的參選紀錄不還原（回報 skipped）。還原過的名冊登記者不再被系統重建（歸類 missing_ambiguous：system_reverted）。
--
-- 引用到的既有物件（2026-10-19 唯讀查正式庫確認存在）：cec_registrations、cec_registration_sources（superseded_by）、cec_name_key、cec_name_norm、
-- politicians（merged_into、region、sub_region）、politician_elections（candidacy_status、withdrawn_after_filing、region_id）、regions、edit_history（reverted_at、reverted_by）、
-- source_refs、policies、activity_audit()、politician_election_party_from_candidacy(uuid, jsonb, uuid, text)、extensions pg_cron／pg_net／supabase_vault／pgcrypto。
-- 守門：_shared/roster-reconcile.test.ts（PGlite 各分類、唯一才建、冪等、還原）、roster-reconcile-run.test.ts（落庫邏輯）、roster-reconcile-arms.test.ts（派工臂）。

-- ▼▼ SECTION: tables ▼▼
CREATE TABLE IF NOT EXISTS roster_reconcile_settings (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT false,   -- 預設關：部署後維護者先手動試跑（POST limit=5）、看 roster_reconcile_log，再 UPDATE enabled = true（agy 審查 #689）
  batch_limit INTEGER NOT NULL DEFAULT 100 CHECK (batch_limit BETWEEN 1 AND 500),
  actions     TEXT[] NOT NULL DEFAULT ARRAY['new'] CHECK (actions <@ ARRAY['new', 'attach'] AND cardinality(actions) >= 1),  -- 系統做哪幾種：new＝建新人物，attach＝掛既有人物；預設只放 new，漸進上線
  agent_name  TEXT NOT NULL DEFAULT 'system:roster-reconcile' CHECK (agent_name LIKE 'system:%'),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roster_reconcile_settings (id, enabled, actions, note) VALUES (1, false, ARRAY['new'], '單列參數：enabled＝false 停止系統建立（預設關，上線後手動試跑再開）；batch_limit＝每一輪（pg_cron 每 10 分鐘）最多建幾筆；actions＝做哪幾種（new 建新人物、attach 掛既有人物，預設只 new）。改值＝一行 migration 的 UPDATE（進 edit_history）。2026-10-19')
ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE roster_reconcile_settings IS '名冊對帳系統建立的開關、每輪上限、動作種類（單列）；預設 enabled＝false、actions＝{new}；改值走 migration 的 UPDATE，審計進 edit_history（2026-10-19）';
DROP TRIGGER IF EXISTS trg_roster_reconcile_settings_audit ON roster_reconcile_settings;
CREATE TRIGGER trg_roster_reconcile_settings_audit AFTER INSERT OR UPDATE OR DELETE ON roster_reconcile_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- 執行互斥：同一時間只有一個 roster-reconcile 在跑（手動觸發與排程重疊會對同一批 new 各建一個人物）。
-- 用租約而不是 pg_advisory_lock：Edge Function 的每次 RPC 可能走不同連線，連線層級的鎖鎖不住。租約 5 分鐘，跑完主動釋放。
CREATE TABLE IF NOT EXISTS roster_reconcile_lock (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lock_until TIMESTAMPTZ
);
INSERT INTO roster_reconcile_lock (id, lock_until) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
ALTER TABLE roster_reconcile_lock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_reconcile_lock_read ON roster_reconcile_lock;
CREATE POLICY roster_reconcile_lock_read ON roster_reconcile_lock FOR SELECT USING (true);
CREATE OR REPLACE FUNCTION roster_reconcile_lock(p_minutes INTEGER DEFAULT 5) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH g AS (
    UPDATE roster_reconcile_lock SET lock_until = now() + make_interval(mins => GREATEST(1, LEAST(COALESCE(p_minutes, 5), 30)))
     WHERE id = 1 AND (lock_until IS NULL OR lock_until < now()) RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM g)
$$;
CREATE OR REPLACE FUNCTION roster_reconcile_unlock() RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE roster_reconcile_lock SET lock_until = NULL WHERE id = 1
$$;
COMMENT ON FUNCTION roster_reconcile_lock(INTEGER) IS '搶執行租約：拿到回 true，別人持有中（租約沒到期）回 false；只授權 service_role（2026-10-19）';

CREATE TABLE IF NOT EXISTS roster_reconcile_log (
  id                     BIGSERIAL PRIMARY KEY,
  reg_id                 BIGINT NOT NULL UNIQUE,   -- cec_registrations.id（登記彙總表那一列）；每位登記者最多處理一次
  run_id                 UUID NOT NULL,
  outcome                TEXT NOT NULL CHECK (outcome IN ('applied', 'unresolved', 'error')),
  message                TEXT,
  source_url             TEXT NOT NULL,            -- 名冊 PDF 網址
  row_no                 INTEGER NOT NULL,         -- 在那份 PDF 的列序（來源就是 source_url 這一列）
  person_action          TEXT CHECK (person_action IN ('new', 'attach')),
  politician_id          UUID,
  politician_election_id INTEGER,
  created_politician     BOOLEAN NOT NULL DEFAULT false,
  agent_name             TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at            TIMESTAMPTZ,
  reverted_by            TEXT
);
CREATE INDEX IF NOT EXISTS roster_reconcile_log_run_idx ON roster_reconcile_log (run_id);
COMMENT ON TABLE roster_reconcile_log IS '系統（名冊對帳）處理過的名冊登記者：結果、來源（cec_registrations 那一列）、建了哪個人物與參選紀錄、哪一輪；可用 roster_reconcile_revert 整輪或逐筆還原（2026-10-19）';
ALTER TABLE roster_reconcile_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_reconcile_log_read ON roster_reconcile_log;
CREATE POLICY roster_reconcile_log_read ON roster_reconcile_log FOR SELECT USING (true);
ALTER TABLE roster_reconcile_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_reconcile_settings_read ON roster_reconcile_settings;
CREATE POLICY roster_reconcile_settings_read ON roster_reconcile_settings FOR SELECT USING (true);
-- ▲▲ SECTION: tables ▲▲

-- ▼▼ SECTION: rows ▼▼
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
           r.name, r.name_key, r.party, r.source_url, r.row_no,
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
           COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) AS nn,
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
  -- 人物：全庫同名（姓名鍵相同、未合併）的人有幾位；剛好一位時，他要「看得出是同一個地方的人」（鄉鎮層級的選舉要同縣市同鄉鎮，其餘同縣市）
  -- 而且這一屆還沒有別筆參選紀錄（一人一屆一筆），才能掛上去
  pn AS MATERIALIZED (
    SELECT p.id, COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) AS nn, replace(p.region, '臺', '台') AS pregion, p.party
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) IN (SELECT x.name_key FROM reg x WHERE x.name_key IS NOT NULL)
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
           g.name, g.party, g.source_url, g.row_no, o.pe_id, COALESCE(o.politician_id, pr.one_id) AS politician_id, o.status AS our_status,
           CASE
             WHEN g.name_key IS NULL THEN 'missing_ambiguous'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' OR (o.status = 'withdrawn' AND NOT o.filed_out) THEN 'status_mismatch' ELSE 'both' END
             WHEN rd.n >= 1 THEN 'match_ambiguous'
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
             WHEN ap.reg_id IS NOT NULL THEN
               CASE WHEN ap.reverted_at IS NOT NULL THEN 'system_reverted'
                    WHEN ap.outcome = 'applied' THEN 'system_applied_gone'
                    ELSE 'system_unresolved' END
             WHEN g.dup_n > 1 THEN 'same_name_multi'
             WHEN pr.person_action IS NULL THEN 'person_unclear'
             END AS reason,
           CASE WHEN rd.n IS NULL AND ap.reg_id IS NULL AND g.name_key IS NOT NULL AND g.dup_n = 1 THEN pr.person_action END AS person_action,
           (ap.reg_id IS NOT NULL AND ap.outcome = 'applied' AND ap.reverted_at IS NULL) AS system_applied
      FROM regn g
      LEFT JOIN reg_deg rd ON rd.reg_id = g.reg_id
      LEFT JOIN pe_deg pd ON pd.pe_id = rd.pe_id
      LEFT JOIN ours o ON o.pe_id = rd.pe_id
      LEFT JOIN person pr ON pr.reg_id = g.reg_id
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
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  )
  SELECT x.reg_id, x.election_id, x.election_type, x.county, x.town, x.sub_region, x.village, x.district,
         x.name, x.party, x.source_url, x.row_no, x.pe_id, x.politician_id, x.our_status,
         x.category, x.reason, x.person_action, x.system_applied,
         NULL::BIGINT AS announce_id, NULL::TEXT AS announce_state
    FROM (SELECT * FROM rows_reg UNION ALL SELECT * FROM rows_ours) x
$$;
COMMENT ON FUNCTION roster_reconcile_rows() IS
  '名冊比對表本體（視圖 roster_reconcile 的外殼）：登記彙總表現行版 × 我們的參選紀錄，逐人判定 category／reason。SET enable_nestloop = off 是故意的（不關 10.6 秒，關了 0.5 秒），改前先看檔頭。2026-10-19';

CREATE OR REPLACE VIEW roster_reconcile AS SELECT * FROM roster_reconcile_rows();
COMMENT ON VIEW roster_reconcile IS
  '名冊比對表（#678）：登記彙總表（19,695 人）× 我們的 2026 參選紀錄，一人一列；category＝both／missing_creatable（唯一可建，由系統建）／missing_ambiguous／match_ambiguous／ours_extra／status_mismatch。'
  '派代理的是後四類。announce_id、announce_state 留給第二階段（名單公告，11/17）。公開唯讀。2026-10-19';

CREATE OR REPLACE VIEW roster_reconcile_summary AS
SELECT election_id, election_type, category, reason, count(*) AS n
  FROM roster_reconcile
 GROUP BY election_id, election_type, category, reason;
COMMENT ON VIEW roster_reconcile_summary IS '名冊比對表的彙總：選舉別 × 類別 × 原因的人數（2026-10-19）';
-- ▲▲ SECTION: rows ▲▲

-- ▼▼ SECTION: units ▼▼
-- ── 4. 單位層級的小表：派工臂讀這張，不讀整個對帳 ──
-- 單位＝(屆, 選舉別, 縣市, 鄉鎮市區)；沒有鄉鎮的選舉別（縣市長、議員）town＝''。needs_agent＝這個單位有任何一位落在派代理的類別。
CREATE TABLE IF NOT EXISTS roster_reconcile_units (
  election_id       INTEGER NOT NULL,
  election_type     TEXT NOT NULL,
  county            TEXT NOT NULL,
  town              TEXT NOT NULL DEFAULT '',
  total             INTEGER NOT NULL,   -- 名冊上的人數（現行版）
  both_n            INTEGER NOT NULL,
  creatable_n       INTEGER NOT NULL,   -- 唯一可建、等系統建的
  ambiguous_n       INTEGER NOT NULL,   -- missing_ambiguous ＋ match_ambiguous
  extra_n           INTEGER NOT NULL,   -- 我們多出來
  status_mismatch_n INTEGER NOT NULL,
  needs_agent       BOOLEAN NOT NULL,
  people            JSONB NOT NULL DEFAULT '[]'::JSONB,   -- 要派代理的那幾位（最多 40）：任務帶出來
  refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id, election_type, county, town)
);
COMMENT ON TABLE roster_reconcile_units IS '名冊對帳的單位層級彙總（派工臂 roster_check 讀這張）；由 roster_reconcile_refresh_units() 每 10 分鐘刷新；表空或沒有那個單位＝臂照舊派（2026-10-19）';
ALTER TABLE roster_reconcile_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_reconcile_units_read ON roster_reconcile_units;
CREATE POLICY roster_reconcile_units_read ON roster_reconcile_units FOR SELECT USING (true);

-- 刷新：整份對帳算一次放進暫存表，彙總後 upsert（內容沒變的單位不寫），對帳裡已經沒有的單位刪掉。回傳新增／改寫／刪除的單位數
CREATE OR REPLACE FUNCTION roster_reconcile_refresh_units() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET enable_nestloop = off AS $$
DECLARE v_n INTEGER; v_total INTEGER := 0;
BEGIN
  DROP TABLE IF EXISTS _rr_rows;
  DROP TABLE IF EXISTS _rr_new;
  CREATE TEMP TABLE _rr_rows ON COMMIT DROP AS SELECT * FROM roster_reconcile_rows();
  CREATE TEMP TABLE _rr_new ON COMMIT DROP AS
  WITH ag AS (
    SELECT g.election_id, g.election_type, g.county, g.town,
           (count(*) FILTER (WHERE g.reg_id IS NOT NULL))::INTEGER AS total,
           (count(*) FILTER (WHERE g.category = 'both'))::INTEGER AS both_n,
           (count(*) FILTER (WHERE g.category = 'missing_creatable'))::INTEGER AS creatable_n,
           (count(*) FILTER (WHERE g.category IN ('missing_ambiguous', 'match_ambiguous')))::INTEGER AS ambiguous_n,
           (count(*) FILTER (WHERE g.category = 'ours_extra'))::INTEGER AS extra_n,
           (count(*) FILTER (WHERE g.category = 'status_mismatch'))::INTEGER AS status_mismatch_n,
           COALESCE(bool_or(g.category IN ('missing_ambiguous', 'match_ambiguous', 'ours_extra', 'status_mismatch')), false) AS needs_agent
      FROM _rr_rows g
     GROUP BY g.election_id, g.election_type, g.county, g.town
  ),
  pp AS (
    SELECT q.election_id, q.election_type, q.county, q.town,
           jsonb_agg(jsonb_build_object(
             'name', q.name, 'category', q.category, 'reason', q.reason, 'sub_region', q.sub_region, 'village', q.village,
             'district', q.district, 'party', q.party, 'row_no', q.row_no, 'politician_election_id', q.pe_id, 'our_status', q.our_status)
             ORDER BY q.rn) AS people
      FROM (SELECT x.*, row_number() OVER (PARTITION BY x.election_id, x.election_type, x.county, x.town
                                           ORDER BY x.category, x.row_no NULLS LAST, x.name) AS rn
              FROM _rr_rows x
             WHERE x.category IN ('missing_ambiguous', 'match_ambiguous', 'ours_extra', 'status_mismatch')) q
     WHERE q.rn <= 40
     GROUP BY q.election_id, q.election_type, q.county, q.town
  )
  SELECT ag.*, COALESCE(pp.people, '[]'::JSONB) AS people
    FROM ag LEFT JOIN pp ON pp.election_id = ag.election_id AND pp.election_type = ag.election_type AND pp.county = ag.county AND pp.town = ag.town;

  INSERT INTO roster_reconcile_units AS u (election_id, election_type, county, town, total, both_n, creatable_n, ambiguous_n, extra_n, status_mismatch_n, needs_agent, people)
  SELECT n.election_id, n.election_type, n.county, n.town, n.total, n.both_n, n.creatable_n, n.ambiguous_n, n.extra_n, n.status_mismatch_n, n.needs_agent, n.people FROM _rr_new n
  ON CONFLICT (election_id, election_type, county, town) DO UPDATE
     SET total = EXCLUDED.total, both_n = EXCLUDED.both_n, creatable_n = EXCLUDED.creatable_n, ambiguous_n = EXCLUDED.ambiguous_n,
         extra_n = EXCLUDED.extra_n, status_mismatch_n = EXCLUDED.status_mismatch_n, needs_agent = EXCLUDED.needs_agent,
         people = EXCLUDED.people, refreshed_at = now()
   WHERE (u.total, u.both_n, u.creatable_n, u.ambiguous_n, u.extra_n, u.status_mismatch_n, u.needs_agent, u.people)
         IS DISTINCT FROM (EXCLUDED.total, EXCLUDED.both_n, EXCLUDED.creatable_n, EXCLUDED.ambiguous_n, EXCLUDED.extra_n, EXCLUDED.status_mismatch_n, EXCLUDED.needs_agent, EXCLUDED.people);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_n;
  DELETE FROM roster_reconcile_units u
   WHERE NOT EXISTS (SELECT 1 FROM _rr_new n WHERE n.election_id = u.election_id AND n.election_type = u.election_type AND n.county = u.county AND n.town = u.town);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_total + v_n;
END;
$$;
COMMENT ON FUNCTION roster_reconcile_refresh_units() IS '重算名冊對帳的單位彙總（roster_reconcile_units）：內容沒變的單位不寫；回傳新增＋改寫＋刪除的單位數。pg_cron 每 10 分鐘、系統每寫完一輪各呼叫一次（2026-10-19）';

-- 某個單位（縣市；鄉鎮市區給了就只看那個鄉鎮）的彙總，給派工臂：沒有資料回 NULL（臂照舊派）
CREATE OR REPLACE FUNCTION roster_reconcile_unit(p_election_id INTEGER, p_election_type TEXT, p_county TEXT, p_town TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
           'total', sum(u.total), 'both', sum(u.both_n), 'creatable', sum(u.creatable_n), 'ambiguous', sum(u.ambiguous_n),
           'ours_extra', sum(u.extra_n), 'status_mismatch', sum(u.status_mismatch_n),
           'needs_agent', bool_or(u.needs_agent),
           'truncated', sum(u.ambiguous_n + u.extra_n + u.status_mismatch_n) > (
             SELECT count(*) FROM roster_reconcile_units v, LATERAL jsonb_array_elements(v.people)
              WHERE v.election_id = p_election_id AND v.election_type = p_election_type AND v.county = replace(p_county, '臺', '台')
                AND (p_town IS NULL OR v.town = replace(p_town, '臺', '台'))),
           'people', COALESCE((SELECT jsonb_agg(e.value) FROM (
                       SELECT pe.value FROM roster_reconcile_units v, LATERAL jsonb_array_elements(v.people) AS pe(value)
                        WHERE v.election_id = p_election_id AND v.election_type = p_election_type AND v.county = replace(p_county, '臺', '台')
                          AND (p_town IS NULL OR v.town = replace(p_town, '臺', '台'))
                        ORDER BY pe.value->>'category', (pe.value->>'row_no')::INTEGER NULLS LAST, pe.value->>'name' LIMIT 40) e), '[]'::JSONB))
         END
    FROM roster_reconcile_units u
   WHERE u.election_id = p_election_id AND u.election_type = p_election_type AND u.county = replace(p_county, '臺', '台')
     AND (p_town IS NULL OR u.town = replace(p_town, '臺', '台'))
$$;
COMMENT ON FUNCTION roster_reconcile_unit(INTEGER, TEXT, TEXT, TEXT) IS '名單清查任務用：某個屆別、選舉別、縣市（可加鄉鎮）的對帳彙總 jsonb（total、both、creatable、ambiguous、ours_extra、status_mismatch、needs_agent、people[最多 40 位要派代理的]）；沒有對帳資料回 NULL＝臂照舊派（2026-10-19）';

-- 任務說明裡的「名冊對帳」一段（純中文）
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
COMMENT ON FUNCTION roster_reconcile_text(JSONB) IS '名單清查任務說明裡的「名冊對帳」一段：只列系統對不上的那幾位（2026-10-19）';
-- ▲▲ SECTION: units ▲▲

-- ▼▼ SECTION: run ▼▼
-- ── 5. 系統要建的清單（給 Edge Function roster-reconcile）與還原 ──
CREATE OR REPLACE FUNCTION roster_reconcile_next(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (reg_id BIGINT, election_id INTEGER, election_type TEXT, county TEXT, sub_region TEXT, village TEXT, district TEXT,
               name TEXT, party TEXT, source_url TEXT, row_no INTEGER, person_action TEXT, politician_id UUID)
LANGUAGE sql STABLE SET enable_nestloop = off AS $$
  SELECT r.reg_id, r.election_id, r.election_type, r.county, r.sub_region, r.village, r.district,
         r.name, r.party, r.source_url, r.row_no, r.person_action, r.politician_id
    FROM roster_reconcile_rows() r
   WHERE r.category = 'missing_creatable'
     AND r.person_action IN (SELECT unnest(s.actions) FROM roster_reconcile_settings s WHERE s.id = 1)
   ORDER BY CASE r.election_type WHEN '縣市長' THEN 1 WHEN '縣市議員' THEN 2 WHEN '鄉鎮市長' THEN 3 WHEN '直轄市山地原住民區長' THEN 4
                                 WHEN '鄉鎮市民代表' THEN 5 WHEN '直轄市山地原住民區民代表' THEN 6 ELSE 7 END, r.reg_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
$$;
COMMENT ON FUNCTION roster_reconcile_next(INTEGER) IS '系統這一輪要建的人（category＝missing_creatable）：縣市長、議員、鄉鎮市長…村里長依序，最多 p_limit 筆；只授權 service_role（2026-10-19）';

-- 還原：p_run（一輪）或 p_reg_ids（逐筆）至少給一個。刪掉系統建的參選紀錄（及其出處）；人物是系統建的、而且沒有別的參選紀錄與政見才一起刪；
-- edit_history 對應的列標成已還原。別人在系統建立之後動過那筆參選紀錄（edit_history 有別的 agent_name、未還原的列）就不還原，回報 skipped。
CREATE OR REPLACE FUNCTION roster_reconcile_revert(p_run UUID DEFAULT NULL, p_reg_ids BIGINT[] DEFAULT NULL, p_by TEXT DEFAULT 'maintainer') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l roster_reconcile_log%ROWTYPE;
  v_pe INTEGER := 0; v_pol INTEGER := 0; v_skip INTEGER := 0; v_kept INTEGER := 0;
BEGIN
  IF p_run IS NULL AND p_reg_ids IS NULL THEN
    RAISE EXCEPTION 'roster_reconcile_revert 要指定 p_run（一輪）或 p_reg_ids（逐筆）';
  END IF;
  FOR l IN SELECT * FROM roster_reconcile_log
            WHERE outcome = 'applied' AND reverted_at IS NULL AND politician_election_id IS NOT NULL
              AND (p_run IS NULL OR run_id = p_run) AND (p_reg_ids IS NULL OR reg_id = ANY (p_reg_ids))
            ORDER BY id DESC LOOP
    IF EXISTS (SELECT 1 FROM edit_history h
                WHERE h.table_name = 'politician_elections' AND h.record_id = l.politician_election_id::TEXT
                  AND h.agent_name IS DISTINCT FROM l.agent_name AND h.reverted_at IS NULL) THEN
      v_skip := v_skip + 1;
      CONTINUE;
    END IF;
    DELETE FROM source_refs WHERE target_table = 'politician_elections' AND target_id = l.politician_election_id::TEXT;
    DELETE FROM politician_elections WHERE id = l.politician_election_id;
    v_pe := v_pe + 1;
    IF l.created_politician THEN
      IF NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.politician_id = l.politician_id)
         AND NOT EXISTS (SELECT 1 FROM policies x WHERE x.politician_id = l.politician_id) THEN
        BEGIN
          DELETE FROM politicians WHERE id = l.politician_id;
          v_pol := v_pol + 1;
        EXCEPTION WHEN foreign_key_violation THEN
          v_kept := v_kept + 1;   -- 別的表已經指到這個人（例：人物頁的其他資料）：人物留著，只還原參選紀錄
        END;
      ELSE
        v_kept := v_kept + 1;
      END IF;
    END IF;
    UPDATE edit_history SET reverted_at = now(), reverted_by = p_by
     WHERE agent_name = l.agent_name AND reverted_at IS NULL
       AND ((table_name = 'politician_elections' AND record_id = l.politician_election_id::TEXT)
            OR (l.created_politician AND table_name = 'politicians' AND record_id = l.politician_id::TEXT AND NOT EXISTS (SELECT 1 FROM politicians x WHERE x.id = l.politician_id)));
    UPDATE roster_reconcile_log SET reverted_at = now(), reverted_by = p_by WHERE id = l.id;
  END LOOP;
  PERFORM roster_reconcile_refresh_units();
  RETURN jsonb_build_object('politician_elections_deleted', v_pe, 'politicians_deleted', v_pol, 'politicians_kept', v_kept, 'skipped_touched', v_skip);
END;
$$;
COMMENT ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) IS '還原系統（名冊對帳）建的參選紀錄：整輪（p_run）或逐筆（p_reg_ids）；只授權 service_role；別人動過的不還原（2026-10-19）';

REVOKE ALL ON FUNCTION roster_reconcile_next(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_next(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_lock(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_lock(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_unlock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_unlock() TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_refresh_units() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_refresh_units() TO service_role;
-- ▲▲ SECTION: run ▲▲

-- ▼▼ SECTION: auth ▼▼
-- ── 6. 呼叫者驗證與排程 ──
-- 函式會寫資料，不能公開：照 bulletin-watch——Vault 的 roster_reconcile_cron_secret（沒有才自己產一個隨機值）→ pg_cron 從 Vault 讀出來放 x-cron-secret →
-- 函式用 RPC roster_reconcile_cron_secret_ok 請資料庫比對（函式端不持有密鑰）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'roster_reconcile_cron_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'roster_reconcile_cron_secret',
      'roster-reconcile 的 pg_cron 呼叫憑證（migration 自動產生；函式端用 roster_reconcile_cron_secret_ok 驗，不持有這個值）'
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.roster_reconcile_cron_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_secret IS NOT NULL
     AND length(p_secret) >= 16
     AND EXISTS (
       SELECT 1
         FROM vault.decrypted_secrets s
        WHERE s.name = 'roster_reconcile_cron_secret'
          AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256')
     );
$$;
REVOKE ALL ON FUNCTION public.roster_reconcile_cron_secret_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roster_reconcile_cron_secret_ok(text) TO service_role;
COMMENT ON FUNCTION public.roster_reconcile_cron_secret_ok(text) IS
  'roster-reconcile 驗 x-cron-secret 用（2026-10-19）：拿輸入值跟 Vault 的 roster_reconcile_cron_secret 比對，只授權 service_role';

-- 排程（UTC）：單位彙總每 10 分鐘刷新（純 SQL，錯開在整點後 3 分）；系統建立每 10 分鐘（第 7 分，錯開 roster-batch 2、cand-no 4、results 6、reassign 8）
SELECT cron.unschedule('roster-reconcile-units-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'roster-reconcile-units-10min');
SELECT cron.schedule('roster-reconcile-units-10min', '3,13,23,33,43,53 * * * *', $$SELECT public.roster_reconcile_refresh_units();$$);

SELECT cron.unschedule('roster-reconcile-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'roster-reconcile-10min');
SELECT cron.schedule('roster-reconcile-10min', '7,17,27,37,47,57 * * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/roster-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'roster_reconcile_cron_secret' LIMIT 1), '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
-- ▲▲ SECTION: auth ▲▲

-- ▼▼ SECTION: arms ▼▼
-- ── 7. 名單清查（roster_check）改讀對帳結果，只在有「對不上」的單位才派，任務帶出那幾個人 ──
-- 兩支臂：contribution_auto_tasks_raw（縣市層級各選舉別的 roster_check，定義＝20261019110000 的現行版）、
-- contribution_auto_tasks_roster_villages（村里長，一個鄉鎮市區一件，定義＝20261011310000 的現行版）。
-- 新定義＝現行定義＋四處（raw）／四處（村里長）機械替換，守門 roster-reconcile-arms.test.ts 把替換倒回去必須一字不差回到前一版：
--   ① 多一個 LEFT JOIN LATERAL rr（roster_reconcile_unit：該單位的對帳彙總，沒有資料＝NULL）
--   ② target 多 'reconcile'（彙總＋最多 40 位要處理的人）
--   ③ what_we_need 多一段「名冊對帳」（roster_reconcile_text，只列系統對不上的那幾位）
--   ④ WHERE 多一條：rr.u IS NULL（沒有對帳資料，照舊派）OR needs_agent
-- task_id、reward、hint_sources、其他條件（重查判準、嘗試冷卻）、其他臂、總表、seed 一字不動；輸出只會「少」（唯一對上的單位不再派）與「多」（target、說明）不會「變」task_id。
-- 簽名與屬性不動（CREATE OR REPLACE，不用分兩次上）。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH cur AS MATERIALIZED (
    -- 當屆＝下一場還沒投票的定期選舉（都投完了就是最近投完的那一場）；由 elections 決定（campaign_election_id），不再寫死年份
    SELECT ce.id, election_year_text(ce.id) AS year FROM (SELECT campaign_election_id() AS id) ce
  ),
  -- 規則 mayor_policies 的職位（縣市長）已有政見的人由 mayor_policies 臂派（同一個 task_id），這裡不重複（原本靠「名下 0 筆政見」自然分開）
  mcfg AS MATERIALIZED (
    SELECT ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM activity_rules r
     WHERE r.activity = 'mayor_policies' AND r.priority IS NULL
     ORDER BY r.enabled DESC, r.id LIMIT 1
  ),
  c_cur AS (
    SELECT cur.id AS eid, cur.year AS eyear, p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.candidacy_status AS cs, pe.source_note,
           -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    JOIN cur ON cur.id = pe.election_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n,
           -- 名單缺口用：名冊內人數＝排除 considering（可能參選）與 withdrawn（退選），其餘都算——已登記、已表態，選後的當選／落選也算（只算 filed、declared 的話，選後人數歸零、缺口永遠成立）
           COUNT(*) FILTER (WHERE COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')) AS n_listed
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    GROUP BY 1, 2, 3
  ),
  -- 登記後才退選的人（withdrawn_after_filing 為真）：他們在中選會登記名冊上，但 ours 不收退選的，名冊人數比我們的名冊內人數多出這幾位
  filed_out AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n_filed_out
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS TRUE
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:policy_missing:' || c.id, 'policy_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid, 'election_type', c.election_type),
         c.name || '（' || COALESCE(c.region, '') || ' ' || c.eyear || ' ' || COALESCE(c.election_type, '') || '候選人）目前沒有 ' || c.eyear || ' 這一屆的承諾（候選人在 ' || c.eyear || ' 選舉前提出的政見）' ||
           CASE WHEN EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL)
                THEN '；名下另有 ' || (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL) || ' 筆過去任期或上屆的政見，不算這一屆'
                ELSE '，名下目前 0 筆政見' END ||
           '。請找該候選人有出處的 ' || c.eyear || ' 競選承諾，最多 5 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 ' || c.eid || '；找到幾筆交幾筆，只找到 1 筆就交 1 筆，不要為了湊數交口號、願景或個人表態。先看 current.queued_policies，別人交了還在等票的不要再交。' ||
           '**這件任務只收 ' || c.eyear || ' 這一屆的承諾**：現任任期的施政、上屆或過去選舉的政見不是這一屆的承諾，不要拿來交（交了這件任務也不會結束）；找不到這一屆的承諾就用 no_change 回報你查了什麼',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 1, c.region
  FROM c_cur c
  -- 缺口＝這個人沒有當屆（c.eid）的承諾（is_campaign_pledge）；原本是「名下完全沒有任何政見」，舊屆政見一進來缺口就消失（2026-10-19，#679）
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL
                      AND pl.election_id = c.eid AND is_campaign_pledge(pl.status::TEXT, pl.origin))
    AND NOT (c.cs IN ('declared', 'filed') AND c.election_type = ANY ((SELECT mcfg.election_types FROM mcfg)::TEXT[])
             AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL))
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN current_position_missing(c.current_position) THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN current_position_missing(c.current_position) THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c_cur c
  WHERE c.birth_year IS NULL OR current_position_missing(c.current_position) OR c.avatar_url IS NULL
  UNION ALL
  SELECT 'auto:policy_validity:' || pl.id, 'policy_validity',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region),
         '「' || pl.title || '」（' || p.name || '）掛在政見底下，但我們沒有任何出處。'
           || '**先判斷它是不是政見**：政見是「當選後要做的具體事情」，看得出做什麼、給誰、做到什麼程度。'
           || '競選標語、團隊組成、行程、個人表態、選戰口號都不是政見（例如「母雞帶小雞」「溫暖創新的某某市」）。'
           || '不是政見就用 removal 型別回報（payload 帶 target_table: "policies"、target_id: 這筆政見的 id、reason ≥20 字寫清楚它是哪一類；需 3 票）；'
           || '是政見就找到原始出處，用 correction 型別補 policies.source_url。'
           || '兩邊都查不出來（找不到出處，也無法判定不是政見）就用 no_change 回報你查了什麼。',
         ARRAY['候選人官網政見頁', 'cna.com.tw', 'ltn.com.tw', 'udn.com'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM source_refs sr WHERE sr.target_table = 'policies' AND sr.target_id = pl.id::TEXT AND sr.role = 'primary')
  UNION ALL
  SELECT 'auto:progress_stale:' || pl.id, 'progress_stale',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress,
                            'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'election_id', pl.election_id, 'election_date', e.election_date),
         CASE WHEN pl.status::TEXT = 'Campaign Pledge' THEN
           '競選承諾「' || pl.title || '」（' || p.name || '）所屬的選舉已經在 ' || e.election_date::TEXT
             || ' 投票完畢，這筆卻還停在「競選承諾」。'
             || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，追不出進度也不該追——'
             || '那種用 removal 型別回報（需 3 票），不要為它補欄位。是政見才往下做：請先確認這個人有沒有當選：'
             || '當選就查這項承諾後來有沒有開始執行，用 policy_progress 型別把 status 改成 In Progress／Achieved／Stalled／Failed 並附上進度紀錄；'
             || '落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 型別補那場選舉的 election_result（附中選會網址）——補上之後這筆不會再派。'
             || '真的查不到後續，用 no_change 回報並說明你查了哪些來源。'
         ELSE
           '政見「' || pl.title || '」（' || p.name || '，' || pl.status::TEXT || '）超過 90 天沒有進度紀錄。'
             || '**第一步先判斷它是不是政見**：標語、行程、個人表態不是，那種用 removal 型別回報（需 3 票），不要補欄位。'
             || '是政見就請查施政報告、議會／立法院紀錄或新聞後用 policy_progress 型別回報。查證後確定近期真的沒有新進度，就用 no_change 回報——那也是成果，會讓這筆暫時不再派給別人'
         END,
         CASE WHEN pl.status::TEXT = 'Campaign Pledge'
              THEN ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 查這個人那一屆選上了沒有',
                         '政見本身的 source_url', 'cna.com.tw', '該機關官網施政報告']
              ELSE ARRAY['縣市政府施政報告（*.gov.tw）', 'ly.gov.tw 議事錄', '議會官網', 'cna.com.tw'] END,
         1, p.region
  FROM policies pl
  JOIN politicians p ON p.id = pl.politician_id
  LEFT JOIN elections e ON e.id = pl.election_id
  WHERE pl.removed_at IS NULL
    AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
    AND pl.last_updated < CURRENT_DATE - INTERVAL '90 days'
    AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= CURRENT_DATE - INTERVAL '90 days')
    -- 競選承諾要等那場選舉投票完，才問得出「兌現了嗎」。2026 投票日是 11-28，
    -- 現在問它「90 天沒有進度」，代理只能回 no_change。屆別空著的也一樣問不出來，
    -- 那些先由 policy_election_missing 把屆別補上，補完就會自己流回這裡。
    AND (pl.status::TEXT <> 'Campaign Pledge'
         OR (e.election_date IS NOT NULL AND e.election_date < CURRENT_DATE))
    -- 落選／退選的人的承諾永遠不會有進度，不要每 14 天再派一次
    AND NOT EXISTS (
      SELECT 1 FROM politician_elections pe
      WHERE pe.politician_id = pl.politician_id
        AND pe.election_id = pl.election_id
        AND pe.candidacy_status IN ('not_elected', 'withdrawn')
    )
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
         c.name || '（' || COALESCE(c.region, '') || ' ' || c.eyear || ' ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 已投票的屆別查得到；' || c.eyear || ' 尚未公告',
               '該縣市選舉委員會官網（' || c.eyear || ' 登記名單）', 'cna.com.tw 登記參選名單'], 1, c.region
  FROM c_cur c
  WHERE c.source_note IS NULL OR c.source_note !~ 'https?://'
  UNION ALL
  SELECT 'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type,
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', l.name, 'election_type', s.election_type,
                            'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count,
                            'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on,
                            'reconcile', rr.u),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。把該縣市這個選舉的參選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'
           || roster_reconcile_text(rr.u)
           -- 名單分兩個階段，講清楚現在該補哪一種，否則兩個階段的資料會混在一起
           || CASE WHEN CURRENT_DATE >= s.list_announced_on THEN
                '【現在是審定名單階段】官方候選人名單已於 ' || s.list_announced_on::TEXT
                  || ' 公告，請以公告名單為準：candidacy 的 candidate_status 填 qualified（名單上的人；confirmed 只表示表態參選），查得到號次就一起附上。'
              ELSE
                '【現在是登記階段】'
                  -- 時程句（登記截止、名單公告、資格審查、抽號次）：日期都讀 roster_check_scope，過了日期的不再出現
                  || roster_schedule_text(s.registration_closed_on, s.list_announced_on, s.municipal_mayor_list_on,
                                          s.qualification_review_by, s.ballot_draw_on)
                  || '所以現在補的是「已登記」而不是「已審定」：candidacy 的 candidate_status 填 registered，不要填 confirmed'
                  -- 號次要等抽籤日之後才有；抽完了就不再說「還沒有號次可填」
                  || CASE WHEN s.ballot_draw_on IS NULL OR s.ballot_draw_on >= CURRENT_DATE THEN '，也還沒有號次可填' ELSE '' END
                  || '。'
                  || '另外，登記已經截止，所以我們資料裡還標著 rumored（傳聞參選）或 likely（可能參選）的人，只要不在登記名單上就是沒登記：請用 correction 把他那筆的 candidate_status 改成 not_running。'
              END
           || '最後用 roster_check 型別回報這次清查（名單上共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。'
           -- 前一位代理查不到時，明講不要再去 db.cec.gov.tw：那是舊版把它排在第一個
           -- 造成的，43 個縣市一次都沒清查成功過，不寫清楚下一位會重蹈同一條死路。
           || CASE WHEN rc.last_attempt_without_count IS NOT NULL
                   THEN '注意：前一位代理回報查不到官方名單（見 target.last_failed_attempt）。'
                        || '請不要再去 db.cec.gov.tw 找——那是選舉結果資料庫，它自己標明「投票後 7 日內更新」，'
                        || election_year_text(s.election_id) || ' 的資料要等 ' || to_char((SELECT e.election_date + 7 FROM elections e WHERE e.id = s.election_id), 'FMMM') || ' 月才會進去。改從該縣市選舉委員會官網的登記公告、或媒體的登記名單彙整下手。'
                   ELSE '' END
           || '查不到名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址——那筆不會把縣市標記為已清查，只會讓它隔天再派。',
         CASE WHEN CURRENT_DATE >= s.list_announced_on
              THEN ARRAY['該縣市選舉委員會官網的候選人名單公告', 'bulletin.cec.gov.tw 選舉公報', 'web.cec.gov.tw 中選會公告', 'cna.com.tw 候選人名單彙整']
              ELSE ARRAY['該縣市選舉委員會官網的登記公告', 'web.cec.gov.tw 中選會新聞稿', 'cna.com.tw 登記參選名單彙整', 'ltn.com.tw／udn.com 登記名單'] END,
         2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name
  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）
  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, s.election_type, l.name) AS u) rr ON TRUE
  LEFT JOIN LATERAL (
    -- 兩個時鐘：真的清查完的（cec_count 有值）壓 recheck_days；
    -- 只是試過沒找到的壓 roster_attempt_cooldown_days
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count,
           -- 最近一次真的清查（cec_count 有值）回報的中選會人數
           (array_agg(cec_count ORDER BY checked_at DESC, id DESC) FILTER (WHERE cec_count IS NOT NULL))[1] AS last_cec_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    -- 最近一次回報的 cec_count 比我們現在的名冊內人數多＝缺口還在：不套 recheck_days，繼續派；落差為 0（或我們比較多）才套
    AND (rc.last_checked IS NULL
         -- 登記後才退選的人在名冊上、不在我們的名冊內人數裡：回報的名冊人數先扣掉他們再比（不扣，名冊 88 位、我們 86 位加 2 位登記後退選，會永遠派下去）
         OR COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)
         OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
    -- 名冊對帳：登記彙總表有的單位，只在有「系統對不上」的人時才派（唯一對上的由系統建）；沒有對帳資料的單位照舊派
    AND (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)
  UNION ALL
  SELECT 'auto:policy_election_missing:' || pl.id, 'policy_election_missing',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'source_url', policy_primary_url(pl.id)),
         '政見「' || pl.title || '」（' || p.name || '）沒有標所屬屆別，網站上顯示成「未標註屆別」。'
           || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，那種用 removal 型別回報（需 3 票），不要補屆別。'
           || '是政見就請打開它的來源網址，確認這是哪一場選舉的承諾（或哪一個任期內的施政），'
           || '再用 correction 型別把 policies.election_id 改成該選舉的年份（' || regular_election_years_text() || '）。'
           || '判斷依據是來源本身：競選承諾看那場選舉的年份，施政進度看講話當下的任期。'
           || '來源沒寫清楚、或那個人同時參選過多屆分不出來，就不要猜——用 no_change 回報並說明你查了什麼。',
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁', 'cna.com.tw'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND pl.election_id IS NULL
  UNION ALL
  -- 登記截止之後還標著「傳聞參選」「可能參選」的，一定有結論：不是在登記名單上，就是沒登記。
  -- 這條規則原本只寫在 roster_check 的敘述裡，而名單清查一直清不動（全國性結構化名單要等 11-17
  -- 公告才有），所以 63 筆就這樣掛著。2026-09-17：「傳聞的參選人在名單出來之後，
  -- 他就應該要被確認下來」——拆成一筆一個任務，各自派出去。
  SELECT 'auto:candidate_status_stale:' || pe.id, 'candidate_status_stale',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'election_id', pe.election_id,
                            'election_type', pe.election_type, 'candidate_status', CASE WHEN pe.candidacy_status = 'considering' THEN 'likely' ELSE 'rumored' END,
                             'region', COALESCE(r.region, p.region), 'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '還標著「' || CASE WHEN pe.candidacy_status = 'considering' THEN '可能參選' ELSE '傳聞參選' END || '」，'
           || '但登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，這時候只有兩種可能：'
           || '**在登記名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered（附登記名單網址）；'
           || '**不在名單上** → 改成 not_running（一樣附你查的那份名單，說明找過了沒有他）。'
           || '兩者都要附得出那份名單；查不到該縣市的登記名單就用 no_change 回報，不要用猜的把人留在「傳聞」。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  WHERE (pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')
    -- 登記截止之後才派：移到規則（activity_rules「raw:candidate_status_stale」：登記截止 +0 起，P2 20261008162000）；這裡不再比日期
$function$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_villages()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    -- roc_year：名冊標題的民國年（原本寫死 115）
    SELECT sc.*, (EXTRACT(YEAR FROM e.election_date)::INTEGER - 1911) AS roc_year
      FROM roster_check_scope sc JOIN elections e ON e.id = sc.election_id
     WHERE sc.election_type = '村里長' AND sc.enabled
  ),
  towns AS (
    SELECT DISTINCT replace(a.region, '臺', '台') AS county, a.township
    FROM electoral_district_areas a
    WHERE a.township IS NOT NULL AND btrim(a.township) <> ''
  ),
  ours AS (
    SELECT pe.election_id, per.region AS county, per.sub_region AS township, COUNT(*) AS n
    FROM politician_elections pe
    JOIN regions per ON per.id = pe.region_id
    WHERE pe.election_id IN (SELECT s.election_id FROM s) AND pe.election_type::TEXT = '村里長'  -- 清查範圍那幾屆（原本寫死 2026）
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:roster_check:' || s.election_id || ':' || t.county || t.township || ':村里長',
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', t.county || t.township, 'county', t.county, 'township', t.township,
                            'election_type', '村里長', 'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count, 'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on,
                            'reconcile', rr.u),
         t.county || t.township || ' ' || s.election_id || ' 村里長的名單需要清查。請找這個鄉鎮市區的村里長候選人登記名單'
           || '（中選會「' || s.roc_year || ' 年村里長選舉候選人登記彙總表」PDF，或' || t.county || '選舉委員會的登記公告），跟我們現有的 '
           || COALESCE(o.n, 0) || ' 筆比對。' || roster_reconcile_text(rr.u) || '名單上有、我們沒有的，每位用 candidacy 型別補一筆：region 填「' || t.county
           || '」、sub_region 填「' || t.township || '」、village 填村里名、election_type 填村里長、candidate_status 填 registered，'
           || 'source_urls 附名冊網址（中選會 web.cec.gov.tw/api/file/…pdf 的名冊系統會逐位核對、吻合的一票就過）；一次最多 150 筆（整批都是 candidacy、source_urls 放這份名冊、每一筆都跟名冊逐位吻合才收；其他型別一次最多 20 筆），可分多次交。'
           || '最後用 roster_check 回報：election_id、region、election_type 三欄照任務 target 原樣帶回（region 就是「' || t.county || t.township
           || '」這一串），cec_count 填這個鄉鎮市區名冊上的人數。查不到名冊就不要猜：roster_check 的 cec_count 留空、note 寫你查了哪些網址。',
         ARRAY['web.cec.gov.tw ' || s.roc_year || ' 年村里長選舉候選人登記彙總表', t.county || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         2, t.county
  FROM s
  CROSS JOIN towns t
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county AND o.township = t.township
  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）
  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, '村里長', t.county, t.township) AS u) rr ON TRUE
  LEFT JOIN LATERAL (
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = t.county || t.township AND x.election_type = '村里長'
  ) rc ON TRUE
  -- 名冊對帳：登記彙總表有的鄉鎮市區，只在有「系統對不上」的人時才派；沒有對帳資料的照舊派
  WHERE (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)
    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;
-- ▲▲ SECTION: arms ▲▲
