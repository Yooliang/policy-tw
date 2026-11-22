-- 日本站派工：層級 × 種類帶狀優先（台灣 #1026／20261121193000 的日本版；2026-11-22，維護者 17:10 定案）
-- ============================================================
--
-- 排序鍵不動：queue_at ＝ GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds（task_queue_key，policy_jp 自己那份，一字不動，型別仍 INTEGER）。
-- 改的只有 priority_seconds 怎麼算：
--   priority_days ＝ 選舉月基準（20261122190000 已有：未來選舉 (360−M)×200 天、已投完負值）＋ 層級 ＋ 種類（＋ 插隊另加在 boost_seconds）
--   層級（每級 20 天）：國政（衆議院／参議院）170、都道府県（知事／都道府県議会）150、市区町村（首長／議会）130、無層級 30
--     來源：任務對象的選舉種類——target.election_type → target.election_id → target.politician_election_id → 這個人最近一屆（policy_jp.election_level：
--     national_lower／national_upper→national、governor／pref_assembly→regional、mayor／ward_mayor／town_mayor／muni_assembly→local，elections.level 欄同）；
--     lineage_* 看 target.level（日本站的值是 national／regional／local；prefectural／municipal 也接受；沒有→無層級）。
--   種類（層內 0～19，與台灣相同）：查證票／adjudicate 19｜policy_missing 15｜term_policy_missing 13｜lineage_* 12｜照片（avatar_missing）10｜
--     人物基本資料（profile_gap、profile_detail_gap、party_info_missing、party_missing、candidacy_source_missing、candidate_status_stale）8｜
--     整理類（duplicate_*、policy_election_mismatch、source_mismatch、policy_source_missing、policy_validity、issue_too_broad、legacy_audit）5｜進度（progress_stale、deadline_due）3｜
--     其他（election_discovery〔層級用它 target 的〕、roster_check〔層級照職位〕、regional_stats_missing、local_government_missing、election_result_missing、district_seats_missing、news…、沒列到的）0
--   例（2026-12 的選舉，月基準 7,200 天）：國政 policy_missing ＝ 7,200＋170＋15；市区町村 avatar_missing ＝ 7,200＋130＋10；2027-02 的都道府県 profile_detail_gap ＝ 6,800＋150＋8。
--   層級 20 天一格、種類最大 19 天，種類不會蓋過層級；月與月差 200 天，層級＋種類（最多 189 天）蓋不過月。
--
-- 日本站不做的（與台灣 #1026 及之後的差異）：
--   · 台灣 20261122160000 的「抄公報抬到 175 天」不做（日本沒有公報來源）：policy_missing 維持 15。
--   · 流量提層：日本站沒有 page_traffic／traffic_boost 機制（沒有這些表與函式），這支沒有流量項；日後日本站加了流量再做比例制（每不重複訪客 +1 天）。
--   · 層級 target 有的是 election_type 字串（不是台灣的職位中文名），所以另寫 task_target_level_text／task_level_text 等日本版函式（JP_ONLY，不是台灣複本）。
--   · profile_gap 缺的是 birth_year／kana（日本站沒有照片缺口，照片走 avatar_missing），所以 profile_gap 一律 8 天。
--   · 台灣的基準夾限（verify_ticket_base_floor_seconds）日本站沒有，也不需要：日本站插隊現在全是 400 天。
--
-- 插隊：queue_settings 的 boost_seconds、manual_front_seconds、visitor_front_seconds 都改 400 天（34,560,000 秒）。插隊中的列（boost_seconds > 0；
--   手動任務第一次進佇列＝manual_front_seconds > 0）的月基準一律用「最近一場未來選舉的月」，所以任何插隊（400 天）都大於所有一般件（最近的月一般件最多 7,200＋189 天，不同月的更小）；
--   插隊派出後歸零，seed 把月基準換回自己那一屆。
--
-- 驗證票：queue_at ＝ 基準 − verify_priority_seconds（這支設 0）− 插隊 ＋ 步長 × 領走次數；領先折進入列時凍結的基準（verify_ticket_base）：
--   · 有母任務位置可沿用：母任務位置已含「月基準＋層級＋母種類」，票只再領先 (19 − 母種類) 天（verify_ticket_parent_lead_seconds）
--   · 新增型、母任務沒有基準：交件建立時間 − 月基準 − (層級＋19) 天（verify_ticket_band_seconds，層級取交件 payload 或母任務 target）
--   取代 20261122190000 的「14 天」。簡化同台灣 #1030。
--
-- 規則表：priority:<臂> 規則的秒數不再被讀（seed 的優先秒數整個改成帶狀；手動入列也不再呼叫 activity_priority_seconds），規則列不動。
--
-- 這支做的事：
--   1. 新欄位 queue_settings.priority_bands_applied_at；備份表 priority_bands_backup_20261122
--   2. 新函式：election_level_days、level_text_of、task_kind_days_by_type、task_has_level、task_target_level_text、task_level_text、task_band_seconds、
--      contribution_level_text、verify_ticket_band_seconds、verify_ticket_parent_lead_seconds（都是日本專屬，登記 JP_ONLY）
--   3. 重新定義三支複本：contribution_tasks_insert_dispatch、seed_auto_task_queue、verify_ticket_base（逐字比對正見當時版本，差異登記在 drift 守門的 edits）
--   4. 設定與一次性重算（任務列 priority_seconds、插隊降到 400 天、驗證票基準）；自我檢查 queue_at 仍是排序鍵；前後各印一次最小／中位 queue_at
--   型別全不動（INTEGER）：最大約 (7,200＋189)×86400 ＝ 6.4×10^8 秒。不升協議版號、不改 TS。
--
-- 回滾：
--   1. 設定：UPDATE policy_jp.queue_settings SET boost_seconds = 157680000, manual_front_seconds = 157680000, visitor_front_seconds = 315360000, verify_priority_seconds = 1209600, priority_bands_applied_at = NULL WHERE id = 1;
--      （verify_priority_seconds 要先設回，下面還原驗證票基準時觸發器才用 14 天算）
--   2. 函式：seed_auto_task_queue、contribution_tasks_insert_dispatch、verify_ticket_base 換回 20261122190000 的定義（CREATE OR REPLACE，內容在那支檔案）。
--   3. 資料：UPDATE policy_jp.task_dispatches d SET priority_seconds = b.priority_seconds, boost_seconds = b.boost_seconds FROM policy_jp.priority_bands_backup_20261122 b WHERE b.task_id = d.task_id;
--      驗證票再 UPDATE policy_jp.task_dispatches d SET dispatch_base_at = b.dispatch_base_at FROM policy_jp.priority_bands_backup_20261122 b WHERE b.task_id = d.task_id AND d.task_id LIKE 'verify:%';
--      （套用之後才建的票不在備份裡；任務列的 priority_seconds 下一輪 seed 自己換回。）
--   4. 新函式與欄位、備份表留著無害（沒人呼叫）。
--
-- 只動日本站（policy_jp），不碰 public。

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ── 0. 改前備份（回滾用） ──────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_jp.priority_bands_backup_20261122 AS
  SELECT task_id, priority_seconds, boost_seconds, queue_at, dispatch_base_at, now() AS backed_up_at FROM policy_jp.task_dispatches;
ALTER TABLE policy_jp.priority_bands_backup_20261122 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.priority_bands_backup_20261122 FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.priority_bands_backup_20261122 TO service_role;
COMMENT ON TABLE policy_jp.priority_bands_backup_20261122 IS '20261122 層級×種類帶狀優先改前的 task_dispatches 排序欄位（回滾用）；確認沒事後可 DROP';

ALTER TABLE policy_jp.queue_settings ADD COLUMN IF NOT EXISTS priority_bands_applied_at TIMESTAMPTZ;
COMMENT ON COLUMN policy_jp.queue_settings.priority_bands_applied_at IS '層級×種類帶狀優先的一次性重算（20261122）做完的時間；有值＝已套用，重跑 migration 不再重算。2026-11-22';

-- ── 1. 層級／種類／帶狀函式（日本專屬：日本站沒有台灣的職位字串，層級看 elections.level／election_type） ──────────
-- 層級 → 天數（每級 20 天）：國政 170、都道府県 150、市区町村 130、無層級 30
CREATE OR REPLACE FUNCTION policy_jp.election_level_days(p_level TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_level WHEN 'national' THEN 170 WHEN 'regional' THEN 150 WHEN 'local' THEN 130 ELSE 30 END
$$;
COMMENT ON FUNCTION policy_jp.election_level_days IS '層級 → 天數（20261122 層級×種類帶狀優先，日本版）：national（衆議院／参議院）170、regional（知事／都道府県議会）150、local（市区町村の首長／議会）130、無層級 30。層級字串來源見 task_level_text。2026-11-22';

-- 層級字串的正規化：脈絡 target.level 的 national／regional／local（也接受 prefectural／municipal 的寫法）
CREATE OR REPLACE FUNCTION policy_jp.level_text_of(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text = 'national' THEN 'national' WHEN p_text IN ('regional', 'prefectural') THEN 'regional' WHEN p_text IN ('local', 'municipal') THEN 'local' END
$$;
COMMENT ON FUNCTION policy_jp.level_text_of IS '脈絡 target.level → national／regional／local；別的值 NULL（無層級）。2026-11-22';

-- 種類天數（層內 0～19）。台灣的「抄公報 +175」日本站不做（日本沒有公報來源），policy_missing 維持 15
CREATE OR REPLACE FUNCTION policy_jp.task_kind_days_by_type(p_task_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_task_type LIKE 'verify%' OR p_task_type = 'adjudicate' THEN 19
           WHEN p_task_type IN ('policy_missing', 'policy_election_missing') THEN 15
           WHEN p_task_type = 'term_policy_missing' THEN 13
           WHEN p_task_type LIKE 'lineage\_%' THEN 12
           WHEN p_task_type = 'avatar_missing' THEN 10
           WHEN p_task_type IN ('profile_gap', 'profile_detail_gap', 'party_info_missing', 'party_missing', 'candidacy_source_missing', 'candidate_status_stale') THEN 8
           WHEN p_task_type IN ('duplicate_policy', 'duplicate_politician', 'policy_election_mismatch', 'source_mismatch', 'policy_source_missing',
                                'policy_validity', 'issue_too_broad', 'legacy_audit') THEN 5
           WHEN p_task_type IN ('progress_stale', 'deadline_due') THEN 3
           ELSE 0 END
$$;
COMMENT ON FUNCTION policy_jp.task_kind_days_by_type IS '任務型別 → 種類天數（20261122，日本版）：查證票／adjudicate 19、policy_missing 15、term_policy_missing 13、lineage_* 12、照片（avatar_missing）10、人物基本資料（profile_gap／profile_detail_gap／party_info_missing／party_missing／candidacy_source_missing／candidate_status_stale）8、整理類 5、進度 3、其他（election_discovery、roster_check、regional_stats_missing、news…）0。日本站的 profile_gap 缺的是 birth_year／kana，沒有照片缺口（照片走 avatar_missing），所以 profile_gap 一律 8。2026-11-22';

-- 這種任務有沒有層級：「其他」那組（regional_stats_missing、local_government_missing、election_result_missing、district_seats_missing…沒列到的）一律無層級；roster_check 與 election_discovery 照選舉
CREATE OR REPLACE FUNCTION policy_jp.task_has_level(p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_task_type LIKE 'verify%' OR p_task_type LIKE 'lineage\_%' OR p_task_type IN (
    'adjudicate', 'policy_missing', 'policy_election_missing', 'term_policy_missing', 'avatar_missing', 'profile_gap', 'profile_detail_gap',
    'party_info_missing', 'party_missing', 'candidacy_source_missing', 'candidate_status_stale', 'duplicate_policy', 'duplicate_politician',
    'policy_election_mismatch', 'source_mismatch', 'policy_source_missing', 'policy_validity', 'issue_too_broad', 'legacy_audit',
    'progress_stale', 'deadline_due', 'roster_check', 'election_discovery')
$$;
COMMENT ON FUNCTION policy_jp.task_has_level IS '這種任務型別有沒有層級（20261122，日本版）：「其他」那組沒有，一律無層級 30 天；roster_check（照職位）與 election_discovery（照它 target 的選舉種類）有。2026-11-22';

-- target → 層級字串（national／regional／local）：election_type → election_id → politician_election_id → 這個人最近一屆的選舉；都沒有 NULL
--   election_type 對映（policy_jp.election_level）：衆議院／参議院 national、知事／都道府県議会 regional、市区町村長（mayor／ward_mayor／town_mayor）與市区町村議会 local
CREATE OR REPLACE FUNCTION policy_jp.task_target_level_text(p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    policy_jp.election_level(NULLIF(p_target->>'election_type', '')),
    (SELECT e.level FROM policy_jp.elections e WHERE e.id = NULLIF(p_target->>'election_id', '')),
    (SELECT e.level FROM policy_jp.politician_elections pe JOIN policy_jp.elections e ON e.id = pe.election_id WHERE pe.id = NULLIF(p_target->>'politician_election_id', '')),
    (SELECT e.level FROM policy_jp.politician_elections pe JOIN policy_jp.elections e ON e.id = pe.election_id
      WHERE pe.politician_id = NULLIF(p_target->>'politician_id', '') ORDER BY e.election_date DESC LIMIT 1))
$$;
COMMENT ON FUNCTION policy_jp.task_target_level_text IS 'target → 層級字串（20261122，日本版）：election_type（national_lower／national_upper→national、governor／pref_assembly→regional、mayor／ward_mayor／town_mayor／muni_assembly→local，policy_jp.election_level）→ election_id → politician_election_id → 這個人最近一屆。都沒有 NULL（無層級）。2026-11-22';

-- 任務的層級字串：脈絡類用 target.level；有層級的種類看 target；其餘 NULL
CREATE OR REPLACE FUNCTION policy_jp.task_level_text(p_task_type TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_task_type LIKE 'lineage\_%' THEN policy_jp.level_text_of(p_target->>'level')
              WHEN policy_jp.task_has_level(p_task_type) THEN policy_jp.task_target_level_text(p_target) END
$$;
COMMENT ON FUNCTION policy_jp.task_level_text IS '任務的層級字串（20261122，日本版）：lineage_* 看 target.level（日本站的值是 national／regional／local；沒有→無層級）、有層級的種類看 target、其他 NULL。2026-11-22';

-- 帶狀秒數＝(層級天數 ＋ 種類天數) × 86400
CREATE OR REPLACE FUNCTION policy_jp.task_band_seconds(p_task_type TEXT, p_target JSONB) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT ((policy_jp.election_level_days(policy_jp.task_level_text(p_task_type, p_target)) + policy_jp.task_kind_days_by_type(p_task_type)) * 86400)::INTEGER
$$;
COMMENT ON FUNCTION policy_jp.task_band_seconds IS '任務的帶狀秒數（20261122，日本版）：(層級天數＋種類天數)×86400；優先秒數＝選舉月基準＋這個。例：2026-12 國政 policy_missing＝7,200＋170＋15 天、市区町村 avatar_missing＝7,200＋130＋10 天。2026-11-22';

-- 交件／母任務 → 層級字串（驗證票用）：交件 payload 自己帶的（election_type、election_id、politician_election_id、politician_id、脈絡 level）→ 母任務列的 target
CREATE OR REPLACE FUNCTION policy_jp.contribution_level_text(p_payload JSONB, p_parent_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(policy_jp.task_target_level_text(p_payload), policy_jp.level_text_of(p_payload->>'level'),
                  policy_jp.task_target_level_text(p_parent_target), policy_jp.level_text_of(p_parent_target->>'level'))
$$;
COMMENT ON FUNCTION policy_jp.contribution_level_text IS '交件的層級字串（20261122，日本版）：payload 自己帶的選舉（election_type／election_id／politician_election_id／politician_id、脈絡 level）→ 母任務 target。取不到 NULL。2026-11-22';

-- 驗證票的帶狀領先（沒有母任務位置可沿用時）：(層級＋19) 天
CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_band_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT ((policy_jp.election_level_days(policy_jp.contribution_level_text(x.payload, x.tgt)) + 19) * 86400)::INTEGER
    FROM (SELECT 1) s
    LEFT JOIN LATERAL (
      SELECT b.payload, p.target AS tgt
        FROM policy_jp.contributions b
        LEFT JOIN policy_jp.task_dispatches p ON p.task_id = COALESCE(b.task_id, b.payload->>'task_id')
       WHERE b.id = policy_jp.uuid_or_null(substr(p_verify_task_id, 8))) x ON true
$$;
COMMENT ON FUNCTION policy_jp.verify_ticket_band_seconds IS '驗證票的帶狀領先秒數（20261122，日本版）：(層級＋19)×86400，層級取交件 payload 或母任務 target。只給 verify_ticket_base 的「沒有母任務位置可沿用」分支與一次性重算用。2026-11-22';

-- 驗證票沿用母任務位置時的領先：母任務位置已含「月基準＋層級＋母種類」，票只再領先 (19 − 母種類) 天
CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_parent_lead_seconds(p_parent_task_type TEXT, p_parent_target JSONB) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((19 - policy_jp.task_kind_days_by_type(p_parent_task_type)) * 86400)::INTEGER
$$;
COMMENT ON FUNCTION policy_jp.verify_ticket_parent_lead_seconds IS '驗證票對母任務位置的領先秒數（20261122，日本版）：(19 − 母任務種類天數)×86400（p_parent_target 不用，保留簽名同台灣）。2026-11-22';

-- ── 2. 三支複本（逐字比對正見當時的版本，差異登記在 policy-jp-dispatch-drift.test.ts） ──────────────
-- contribution_tasks_insert_dispatch：以 20261122190000 的定義為底，優先秒數那一段換成帶狀（標記處）
CREATE OR REPLACE FUNCTION policy_jp.contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), policy_jp.queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         policy_jp.task_band_seconds(m.task_type, m.target)
           + (CASE WHEN COALESCE(policy_jp.manual_front_seconds(m.task_id), 0) > 0 THEN policy_jp.election_month_seconds(NULL, NULL)
                   ELSE policy_jp.election_month_seconds(policy_jp.election_id_or_null(m.target->>'election_id'), m.target) END),  -- 帶狀優先（20261122，日本站）：優先秒數＝選舉月基準＋層級＋種類；插隊（第一次進佇列）的月基準用最近一場未來選舉的月
         COALESCE(policy_jp.manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM policy_jp.contribution_auto_tasks_manual(policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

-- seed_auto_task_queue：以 20261122190000 的定義為底，「選舉月基準」一段換成「帶狀優先」（標記處）
CREATE OR REPLACE FUNCTION policy_jp.seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 policy_jp.task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM policy_jp.contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, policy_jp.election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL policy_jp.activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM policy_jp.election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 帶狀優先（20261122，日本站；台灣 #1026 的日本版）：優先秒數＝選舉月基準＋層級＋種類（policy_jp.task_band_seconds），取代規則秒數與上一版單獨的選舉月基準一行；
  --     插隊中的列（已有列 boost_seconds > 0，或手動任務的新缺口）月基準一律用最近一場未來選舉的月。台灣的抄公報 +175 不做（日本沒有公報來源）、流量提層日本站沒有
  UPDATE _gaps g SET priority_seconds = policy_jp.task_band_seconds(g.task_type, g.target)
         + policy_jp.election_month_seconds(CASE WHEN x.boosted THEN NULL ELSE policy_jp.election_id_or_null(g.target->>'election_id') END, CASE WHEN x.boosted THEN NULL ELSE g.target END),
         priority_rule_id = NULL
    FROM (SELECT g2.task_id, COALESCE((SELECT d.boost_seconds > 0 FROM policy_jp.task_dispatches d WHERE d.task_id = g2.task_id), g2.arm LIKE 'manual\_%') AS boosted FROM _gaps g2) x
   WHERE x.task_id = g.task_id;
  -- <<< 帶狀優先

  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT policy_jp.task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE policy_jp.task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, policy_jp.task_rekey_stable_key(x.task_id) AS skey FROM policy_jp.task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM policy_jp.queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE policy_jp.task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE policy_jp.task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := policy_jp.queue_slot('task');
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 policy_jp.manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(policy_jp.manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    LEFT JOIN _rekey_prev r ON r.skey = policy_jp.task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
    FROM policy_jp.contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM policy_jp.refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM policy_jp.refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM policy_jp.manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 policy_jp.task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM policy_jp.refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務

  RETURN v_new + v_verify;
END;
$$;

-- verify_ticket_base：以 20261122190000 的定義為底，三處加帶狀領先（標記處）
CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now()) - make_interval(secs => policy_jp.verify_ticket_election_seconds(p_verify_task_id) + policy_jp.verify_ticket_band_seconds(p_verify_task_id))  -- >>> 帶狀優先（月基準＋層級＋19）
           ELSE COALESCE((SELECT p.dispatch_base_at - make_interval(secs => policy_jp.verify_ticket_parent_lead_seconds(p.task_type, p.target)) FROM policy_jp.task_dispatches p  -- >>> 帶狀優先（領先 19 − 母種類 天）
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()) - make_interval(secs => policy_jp.verify_ticket_election_seconds(p_verify_task_id) + policy_jp.verify_ticket_band_seconds(p_verify_task_id)))  -- >>> 帶狀優先（月基準＋層級＋19）
         END
    FROM (SELECT 1) x LEFT JOIN policy_jp.verify_ticket_parent(p_verify_task_id) t ON true
$$;

-- ── 5. 權限：日本站的函式只給 service_role（同 20261009130000） ─────────────────────────────
REVOKE EXECUTE ON FUNCTION
  policy_jp.election_level_days(TEXT), policy_jp.level_text_of(TEXT), policy_jp.task_kind_days_by_type(TEXT), policy_jp.task_has_level(TEXT),
  policy_jp.task_target_level_text(JSONB), policy_jp.task_level_text(TEXT, JSONB), policy_jp.task_band_seconds(TEXT, JSONB),
  policy_jp.contribution_level_text(JSONB, JSONB), policy_jp.verify_ticket_band_seconds(TEXT), policy_jp.verify_ticket_parent_lead_seconds(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  policy_jp.election_level_days(TEXT), policy_jp.level_text_of(TEXT), policy_jp.task_kind_days_by_type(TEXT), policy_jp.task_has_level(TEXT),
  policy_jp.task_target_level_text(JSONB), policy_jp.task_level_text(TEXT, JSONB), policy_jp.task_band_seconds(TEXT, JSONB),
  policy_jp.contribution_level_text(JSONB, JSONB), policy_jp.verify_ticket_band_seconds(TEXT), policy_jp.verify_ticket_parent_lead_seconds(TEXT, JSONB)
  TO service_role;

-- ── 6. 設定與一次性重算 ──────────────────────────────────────
-- 冪等：做完在 queue_settings.priority_bands_applied_at 記時間，有值整段跳過。
--   · 設定：插隊三個值 → 400 天（34,560,000 秒）、verify_priority_seconds 14 天 → 0（領先折進驗證票入列時凍結的基準）
--   · 任務列：priority_seconds ＝ 帶狀秒數 ＋ 月基準（插隊中的列月基準用最近一場未來選舉的月）；插隊中的列 boost_seconds 抬／降到 400 天（原 5 年／10 年）
--   · 驗證票：基準 ＝ 原基準 − 14 天（verify_priority_seconds 歸零要補回） − (層級＋19) 天，位置只比原本多領先層級帶狀；插隊中的票同樣降到 400 天
--   · 改前值存在 priority_bands_backup_20261122
DO $$
DECLARE r RECORD; v_n INTEGER; v_old_vps INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM policy_jp.queue_settings WHERE id = 1 AND priority_bands_applied_at IS NOT NULL) THEN
    RAISE NOTICE '層級×種類帶狀的一次性重算已套用過，略過';
    RETURN;
  END IF;
  LOCK TABLE policy_jp.task_dispatches IN SHARE ROW EXCLUSIVE MODE;
  SELECT verify_priority_seconds INTO v_old_vps FROM policy_jp.queue_settings WHERE id = 1;

  FOR r IN SELECT CASE WHEN task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END AS kind, count(*) AS n, min(queue_at) AS min_q, percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_at) AS med_q
             FROM policy_jp.task_dispatches WHERE boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算前 %：% 件，最小 queue_at %，中位 %', r.kind, r.n, r.min_q, r.med_q;
  END LOOP;

  UPDATE policy_jp.queue_settings
     SET boost_seconds = 34560000, manual_front_seconds = 34560000, visitor_front_seconds = 34560000, verify_priority_seconds = 0,
         note = COALESCE(note || '；', '') || '2026-11-22 層級×種類帶狀：插隊 400 天、驗證票領先改折進基準（verify_priority_seconds 0）'
   WHERE id = 1;

  -- 任務列：先依 task_id 順序鎖列再改，降低與 /next、seed 的死鎖機會
  PERFORM 1 FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%' ORDER BY task_id FOR UPDATE;
  UPDATE policy_jp.task_dispatches d
     SET priority_seconds = policy_jp.task_band_seconds(d.task_type, d.target)
                            + (CASE WHEN d.boost_seconds > 0 THEN policy_jp.election_month_seconds(NULL, NULL)
                                    ELSE policy_jp.election_month_seconds(policy_jp.election_id_or_null(d.target->>'election_id'), d.target) END),
         boost_seconds = CASE WHEN d.boost_seconds > 0 THEN 34560000 ELSE 0 END
   WHERE d.task_id NOT LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 列任務列的 priority_seconds', v_n;

  PERFORM 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%' ORDER BY task_id FOR UPDATE;
  UPDATE policy_jp.task_dispatches v
     SET dispatch_base_at = COALESCE(v.dispatch_base_at, policy_jp.verify_ticket_freeze_base(v.queue_at, v.dispatch_count, v.boost_seconds, policy_jp.verify_ticket_step_seconds(v.task_id)))
                            - make_interval(secs => v_old_vps + policy_jp.verify_ticket_band_seconds(v.task_id)),
         boost_seconds = CASE WHEN v.boost_seconds > 0 THEN 34560000 ELSE 0 END
   WHERE v.task_id LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 張驗證票的基準', v_n;

  FOR r IN SELECT CASE WHEN task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END AS kind, count(*) AS n, min(queue_at) AS min_q, percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_at) AS med_q
             FROM policy_jp.task_dispatches WHERE boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算後 %：% 件，最小 queue_at %，中位 %', r.kind, r.n, r.min_q, r.med_q;
  END LOOP;

  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM policy_jp.task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM policy_jp.verify_ticket_key(dispatch_base_at, dispatch_count, boost_seconds, policy_jp.verify_ticket_step_seconds(task_id))) THEN
    RAISE EXCEPTION '有驗證票的 queue_at 不是排序鍵';
  END IF;

  UPDATE policy_jp.queue_settings SET priority_bands_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
