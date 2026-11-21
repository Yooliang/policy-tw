-- 派工優先序改制：層級 × 種類帶狀優先（2026-11-21，維護者「這樣改吧」）
-- ============================================================
--
-- 背景（正式庫唯讀實測 2026-11-21）：
--   · 排序鍵只有 queue_at ＝ GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds（task_queue_key，一字不動）；改的只有 priority_seconds 怎麼算。
--   · 原本 priority_seconds ＝ 規則秒數（activity_rules 取秒數最小那條：#37 前段 +3 天、#38 後段 −30 天、#39 公報前壓 0、#44／#40／#50）
--       ＋ 選舉年優先（20261112005000：年後兩碼 × 100 天）＋ 選舉類別提前天數（20261114010000：縣市長 6 … 村里長 0）＋ 流量提層（達 5 人固定 +3 天）＋ 需求疊加。
--   · 同分穿插：2026 的 policy_missing 與 profile_gap 都是前段 +3 天，兩者在隊裡各半穿插（profile_gap 命中率約 8%）；層級之間只差 2～6 天，沒有「種類」這一軸。
--   · 網站請求的插隊（選前 100／選後 50 天）加在「那個人所屬屆」之上：2022 的人物頁被按，永遠排在 2026 自動任務後面。
--
-- 新制（天；越大越先派）：
--   priority_days ＝ 屆基準 ＋ 層級 ＋ 種類 ＋ 流量提層（＋ 需求疊加，旗標開著時）
--   屆基準：年份後兩碼 × 100（election_year_priority_seconds，不動）：2022＝2200、2024＝2400、2026＝2600、2028＝2800。
--   層級（每級 20 天，task_level_days）：
--     縣市長／直轄市長／總統副總統 170、直轄市山地原住民區長 150、縣市議員／直轄市議員／立法委員 130、鄉鎮市長 110、
--     直轄市山地原住民區民代表 90、鄉鎮市民代表 70、村里長 50、無層級 30
--   種類（層內 0～19，task_kind_days）：
--     查證票（verify:*）／adjudicate 19｜policy_missing、policy_election_missing 15｜term_policy_missing 13｜lineage_* 12｜
--     照片（avatar_choice、缺官方照片的 profile_gap）10｜人物基本資料（其餘 profile_gap、profile_detail_gap、party_info_missing、candidacy_source_missing、candidate_status_stale）8｜
--     整理類（duplicate_policy、duplicate_politician、policy_election_mismatch、source_mismatch、policy_source_missing、policy_validity、issue_too_broad、legacy_audit）5｜
--     進度（progress_stale、deadline_due）3｜其他（news_sweep、regional_stat_missing、roster_check、other、沒列到的）0
--   例：2026 縣市長抄公報 ＝ 2600＋170＋15 ＝ 2785 天；2026 村里長照片 ＝ 2600＋50＋10 ＝ 2660；2024 縣市長 policy_missing ＝ 2400＋170＋15 ＝ 2585（輸給 2026 村里長照片）。
--   層級 20 天一格、種類最大 19 天，所以種類不會蓋過層級；屆與屆之間差 200 天，層級＋種類（最多 189 天）也蓋不過屆。
--
-- 每種任務怎麼知道「層級」（task_level_text → election_level_days）：
--   1. lineage_*（脈絡）：target.level 直接對映——county → 縣市長層、national → 縣市長層（與總統副總統同層 170，維護者規格沒寫、本支定的）、township → 鄉鎮市長層、village → 村里長層；沒有或別的值 ＝ 無層級。
--   2. 其他有層級的種類：target.election_type；沒有就用 target.politician_id ＋ target.election_id 查 politician_elections；
--      都沒有（沒帶選舉 id，例如網站請求只帶 politician_id）就取這個人「最近一屆」的職位。
--   3. 其他（news_sweep、regional_stat_missing、other、沒列到的）一律無層級（30）；roster_check 照職位。
--   4. 驗證票：母任務的層級（母任務列的 task_type／target；母任務列已不在就看交件 payload），種類 19。裁決（adjudicate）繼承母交件的層級（target.contribution_id）。
--   ※ election_type_priority_days（11-14 的職位天數設定）被層級取代：欄位與 election_type_priority_seconds() 留著、seed 與手動入列都不再讀；回滾見下。
--
-- 插隊（一律 +200 天，且屆基準改用最新一屆）：
--   插隊 ＝ 網站請求（政見→抄公報 15、人物→人物基本資料 8，各自帶層級）、/boost、維護者建的任務、網站請求／加註併入既有缺口。
--   queue_settings 的 boost_seconds、manual_front_seconds、visitor_front_seconds、visitor_front_pre_election_seconds 都改 17,280,000（200 天）；
--   「是否在插隊」的判斷＝列上 boost_seconds > 0（新缺口＝手動臂且 manual_front_seconds > 0）。插隊中的列屆基準用 latest_election_base_seconds()
--   （elections 裡 election_date 最大的例行選舉，election_reason = 'regular'；不看人物所屬屆），所以 2022 縣市長被按 ＝ 2600＋170＋15 ＋ 200（boost）＝ 2985 天。
--   插隊是一次性的（任務列派出就歸零）：派出後 seed 把屆基準換回人物自己的那一屆。
--   ※ 網站目前只有 政見／人物／進度／驗證／稽核 五個按鈕，沒有獨立的「照片」按鈕；網站請求的 profile_gap 一律算人物基本資料（8 天）。
--     併入既有缺口（work_card_attach、web_request_gap_boost）的插隊照缺口自己的種類：缺官方照片的 profile_gap 缺口是照片（10）。
--
-- 流量提層改比例制（traffic_boost_apply、seed）：
--   加成秒數 ＝ 近 window_days（7）天不重複訪客數 × traffic_boost_settings.per_user_seconds（86400），無門檻、無上限（0 人 ＝ 0 天）；
--   缺口對到多個達標頁（人物頁、他名下的政見頁）取人數最大的那頁。不再是「達 5 人固定 +3 天」，也不再限制「原優先秒數 < boost_seconds」的缺口才提層。
--   no_yield_days／pause_days（14 天沒產出暫停 14 天）與 stale_after_hours 機制保留；min_users 改 1（page_traffic_hot 有人造訪就算，CHECK 要求 ≥ 1）；
--   boost_seconds（259200）欄位保留、不再讀（標 deprecated）。
--
-- 驗證票：queue_at ＝ 基準 − 14 天 − 插隊 ＋ 步長 × 領走次數（verify_ticket_key，一字不動）。
--   「14 天」是 queue_settings.verify_priority_seconds；這支把它設成 0，改把領先折進入列時凍結的基準（verify_ticket_base）。目標：票 ＝ 屆基準 ＋ 母任務層級 ＋ 19，層級不重複算：
--     · 有母任務位置可沿用（一般任務的交件）：母任務位置已含「屆基準＋層級＋母種類」，票只再領先 (19 − 母種類) 天（verify_ticket_parent_lead_seconds）
--     · 新增型、母任務沒有基準（基準是交件建立時間 − 選舉年，不含層級）：領先 層級＋19 天（verify_ticket_band_seconds，層級取母任務或交件 payload 的職位）
--   夾限（verify_ticket_base_floor_seconds）＝最大插隊值（現在 200 天）＋ verify_priority_seconds（0），夾限先做、再減領先。
--   裁決任務（adjudicate）的層級繼承母交件：target.contribution_id → 交件 payload／母任務／applied_politician_id（contribution_level_text），取不到才無層級。
--
-- 規則表：activity_rules #37（前段 +3 天）、#38（後段 −30 天）、#39（公報前降級）設 enabled=false，不刪。
--   #44 manual_visitor、#40 placeholder_politicians、#50 regional_stats_missing 保留 enabled，但它們的 priority_seconds 不再被讀
--   （seed 的優先秒數整個改成上面的新算法，手動入列也不再呼叫 activity_priority_seconds）；插隊由 manual_front_seconds 的 200 天表達。
--
-- 這支做的事：
--   1. 新函式：election_level_days、task_kind_days_by_type、task_has_level、task_target_level_text、task_level_text、task_level_days、task_kind_days、
--      task_band_priority_seconds(level_text, task_type, has_photo_gap)、task_band_seconds、latest_election_base_seconds、task_year_priority_seconds、verify_ticket_band_seconds、verify_ticket_parent_lead_seconds、contribution_level_text
--   2. traffic_boost_settings.per_user_seconds；traffic_boost_apply 改比例制（以 20261011350000 的定義為底，只差標記處）
--   3. contribution_tasks_insert_dispatch（以 20261114010000 為底）、seed_auto_task_queue（以 20261119170000 為底）：只差標 >>> 帶狀優先 的區塊
--   4. verify_ticket_base（以 20261114070100 為底，只差標 >>> 帶狀優先 的兩處）
--   5. 設定：queue_settings 四個插隊值 → 200 天、verify_priority_seconds → 0；activity_rules #37／#38／#39 停用
--   6. 一次性重算（先把改前的值存進 priority_bands_backup；先依 task_id 順序鎖列再改，降低與 /next、seed 的死鎖機會）：現有任務列的 priority_seconds（以及插隊中的列抬到 200 天）、現有驗證票的基準（14 天換成層級帶狀）；前後各印一次隊頭 30 筆（任務型別×層級）
--      冪等：queue_settings.priority_bands_applied_at 有值就整段跳過。重算只給「屆基準＋層級＋種類」；流量與需求疊加在下一輪 seed（10 分鐘內）補上。
--   不升協議版號、不改 TS、不動資料表內容（politicians／policies…）。
--
-- 日本站（policy_jp）：不跟（沒有職位層級與選舉年後兩碼）。drift 守門的 contribution_tasks_insert_dispatch 比對本來就讀 20261112005000 之前的版本（登記「日本站暫不跟」），
--   seed 讀 20261017010000 之前的版本，都不受這支影響。
--
-- 回滾（順序要照這樣）：
--   1. UPDATE activity_rules SET enabled = true WHERE id IN (37, 38, 39);
--   2. UPDATE queue_settings SET boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 4320000, visitor_front_pre_election_seconds = 8640000, verify_priority_seconds = 1209600 WHERE id = 1;
--      UPDATE traffic_boost_settings SET min_users = 5 WHERE id = 1;
--      （verify_priority_seconds 要先設回，下面第 4 步改 dispatch_base_at 時觸發器才用 14 天算回原位置）
--   3. 把 seed_auto_task_queue 換回 20261119170000、contribution_tasks_insert_dispatch 換回 20261114010000、traffic_boost_apply 換回 20261011350000、
--      verify_ticket_base 換回 20261114070100 的定義（CREATE OR REPLACE，內容在那幾支檔案；seed 的兩個 SET 要帶著走）。
--   4. 驗證票基準與插隊：這支套用時把每一列改前的值存在表 priority_bands_backup（task_id、dispatch_base_at、priority_seconds、boost_seconds、queue_at），精確還原用：
--        UPDATE task_dispatches d SET dispatch_base_at = b.dispatch_base_at FROM priority_bands_backup b WHERE d.task_id = b.task_id AND d.task_id LIKE 'verify:%';
--        UPDATE task_dispatches d SET boost_seconds = b.boost_seconds FROM priority_bands_backup b WHERE d.task_id = b.task_id AND d.task_id NOT LIKE 'verify:%' AND d.boost_seconds = 17280000 AND b.boost_seconds < 17280000 AND b.boost_seconds > 0;
--      （套用之後才建的票不在備份裡，不會被還原；任務列的 priority_seconds 下一輪 seed 自己換回。）
--   5. 新函式、per_user_seconds 欄位與備份表留著不影響（不再被讀）。

-- 鎖與逾時：這支是一個交易（含一次性重算約 3.1 萬列）。lock_timeout 5 秒：拿不到鎖（例如 /next 或 seed 正在寫同一批列）就整支失敗重跑，
-- 不是排隊等著把 /next 一起拖住；statement_timeout 給重算足夠的時間。欄位已在前一支加好，這支不再持 ACCESS EXCLUSIVE。
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ------------------------------------------------------------
-- 1. 層級／種類／帶狀函式
-- ------------------------------------------------------------
-- 職位 → 層級天數（每級 20 天）。直轄市長／議員、總統副總統併入同級；對不上的職位＝無層級 30
CREATE OR REPLACE FUNCTION election_level_days(p_election_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_election_type
           WHEN '縣市長' THEN 170 WHEN '直轄市長' THEN 170 WHEN '總統副總統' THEN 170
           WHEN '直轄市山地原住民區長' THEN 150
           WHEN '縣市議員' THEN 130 WHEN '直轄市議員' THEN 130 WHEN '立法委員' THEN 130
           WHEN '鄉鎮市長' THEN 110
           WHEN '直轄市山地原住民區民代表' THEN 90
           WHEN '鄉鎮市民代表' THEN 70
           WHEN '村里長' THEN 50
           ELSE 30 END
$$;
COMMENT ON FUNCTION election_level_days IS '職位 → 層級天數（20261121 層級×種類帶狀優先）：縣市長／總統 170、原住民區長 150、議員／立委 130、鄉鎮市長 110、區民代表 90、鄉鎮市民代表 70、村里長 50、無層級 30。2026-11-21';

-- 種類天數（層內 0～19）。p_has_photo_gap：profile_gap 缺官方照片者走照片（10），其餘人物基本資料（8）
CREATE OR REPLACE FUNCTION task_kind_days_by_type(p_task_type TEXT, p_has_photo_gap BOOLEAN) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_task_type LIKE 'verify%' OR p_task_type = 'adjudicate' THEN 19
           WHEN p_task_type IN ('policy_missing', 'policy_election_missing') THEN 15
           WHEN p_task_type = 'term_policy_missing' THEN 13
           WHEN p_task_type LIKE 'lineage\_%' THEN 12
           WHEN p_task_type = 'avatar_choice' THEN 10
           WHEN p_task_type = 'profile_gap' THEN CASE WHEN COALESCE(p_has_photo_gap, false) THEN 10 ELSE 8 END
           WHEN p_task_type IN ('profile_detail_gap', 'party_info_missing', 'candidacy_source_missing', 'candidate_status_stale') THEN 8
           WHEN p_task_type IN ('duplicate_policy', 'duplicate_politician', 'policy_election_mismatch', 'source_mismatch', 'policy_source_missing',
                                'policy_validity', 'issue_too_broad', 'legacy_audit') THEN 5
           WHEN p_task_type IN ('progress_stale', 'deadline_due') THEN 3
           ELSE 0 END
$$;
COMMENT ON FUNCTION task_kind_days_by_type IS '任務型別 → 種類天數（20261121）：查證票／adjudicate 19、抄公報 15、任內政見 13、脈絡 12、照片 10、人物基本資料 8、整理類 5、進度 3、其他 0。2026-11-21';

-- 這種任務有沒有「層級」：「其他」那一組（news_sweep、regional_stat_missing、other、沒列到的）一律無層級；roster_check 照職位
CREATE OR REPLACE FUNCTION task_has_level(p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_task_type LIKE 'verify%' OR p_task_type LIKE 'lineage\_%' OR p_task_type IN (
    'adjudicate', 'policy_missing', 'policy_election_missing', 'term_policy_missing', 'avatar_choice', 'profile_gap', 'profile_detail_gap',
    'party_info_missing', 'candidacy_source_missing', 'candidate_status_stale', 'duplicate_policy', 'duplicate_politician', 'policy_election_mismatch',
    'source_mismatch', 'policy_source_missing', 'policy_validity', 'issue_too_broad', 'legacy_audit', 'progress_stale', 'deadline_due', 'roster_check')
$$;
COMMENT ON FUNCTION task_has_level IS '這種任務型別有沒有層級（20261121）：「其他」那組（news_sweep、regional_stat_missing、other、沒列到的）沒有，一律算無層級 30 天。2026-11-21';

-- target → 職位：election_type → 這個人在那一屆的參選職位 → 這個人最近一屆的職位；都沒有 NULL
CREATE OR REPLACE FUNCTION task_target_level_text(p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(p_target->>'election_type', ''),
    (SELECT pe.election_type::TEXT FROM politician_elections pe
      WHERE pe.politician_id = uuid_or_null(p_target->>'politician_id') AND pe.election_id = election_id_or_null(p_target->>'election_id')
      ORDER BY pe.id LIMIT 1),
    (SELECT pe.election_type::TEXT FROM politician_elections pe JOIN elections e ON e.id = pe.election_id
      WHERE pe.politician_id = uuid_or_null(p_target->>'politician_id')
      ORDER BY e.election_date DESC, election_level_days(pe.election_type::TEXT) DESC LIMIT 1))
$$;
COMMENT ON FUNCTION task_target_level_text IS 'target 的職位（20261121）：target.election_type → politician_id＋election_id 查 politician_elections → 這個人最近一屆的職位；都沒有 NULL。2026-11-21';

-- 一筆交件的職位（裁決任務繼承母交件的層級）：交件 payload.election_type → 母任務 target → payload 的人物＋選舉 → 落庫後的 applied_politician_id 最近一屆職位
CREATE OR REPLACE FUNCTION contribution_level_text(p_contribution_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(verify_ticket_election_type('verify:' || b.id),
                  task_target_level_text(b.payload),
                  task_target_level_text(jsonb_build_object('politician_id', b.applied_politician_id)))
    FROM contributions b WHERE b.id = p_contribution_id
$$;
COMMENT ON FUNCTION contribution_level_text IS '一筆交件的職位（20261121）：給裁決任務（adjudicate）繼承母交件層級用。payload.election_type → 母任務 target → payload 的人物與選舉 → applied_politician_id 最近一屆；都沒有 NULL。2026-11-21';

-- 任務的層級用職位文字：lineage_* 用 target.level 對映；其餘有層級的型別用 task_target_level_text；沒層級的型別 NULL
CREATE OR REPLACE FUNCTION task_level_text(p_task_type TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN NOT task_has_level(p_task_type) THEN NULL
           WHEN p_task_type = 'adjudicate' THEN COALESCE(contribution_level_text(uuid_or_null(p_target->>'contribution_id')), task_target_level_text(p_target))
           WHEN p_task_type LIKE 'lineage\_%' THEN
             CASE p_target->>'level' WHEN 'county' THEN '縣市長' WHEN 'national' THEN '縣市長'
                                     WHEN 'township' THEN '鄉鎮市長' WHEN 'village' THEN '村里長' END
           ELSE task_target_level_text(p_target) END
$$;
COMMENT ON FUNCTION task_level_text IS '任務的層級職位文字（20261121）：adjudicate 繼承母交件（target.contribution_id）的層級；lineage_* 用 target.level（county／national→縣市長［national 與總統同層 170］、township→鄉鎮市長、village→村里長）；其餘有層級的型別用 task_target_level_text；「其他」組與對不上的 NULL（＝無層級 30 天）。2026-11-21';

CREATE OR REPLACE FUNCTION task_level_days(p_task_type TEXT, p_target JSONB) RETURNS INTEGER
LANGUAGE sql STABLE AS $$ SELECT election_level_days(task_level_text(p_task_type, p_target)) $$;
COMMENT ON FUNCTION task_level_days IS '任務的層級天數（20261121）：election_level_days(task_level_text(task_type, target))。seed 與手動入列共用。2026-11-21';

CREATE OR REPLACE FUNCTION task_kind_days(p_task_type TEXT, p_target JSONB) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT task_kind_days_by_type(p_task_type, p_task_type = 'profile_gap' AND COALESCE((p_target->'missing') @> '["avatar_url"]'::JSONB, false))
$$;
COMMENT ON FUNCTION task_kind_days IS '任務的種類天數（20261121）：task_kind_days_by_type；profile_gap 的 target.missing 含 avatar_url（缺官方照片）走照片 10，其餘 8。seed 與手動入列共用。2026-11-21';

-- 帶狀秒數 ＝ (層級天數 ＋ 種類天數) × 86400（不含屆基準）
CREATE OR REPLACE FUNCTION task_band_priority_seconds(p_level_text TEXT, p_task_type TEXT, p_has_photo_gap BOOLEAN) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT (election_level_days(p_level_text) + task_kind_days_by_type(p_task_type, p_has_photo_gap))::BIGINT * 86400
$$;
COMMENT ON FUNCTION task_band_priority_seconds IS '層級×種類帶狀秒數（20261121）：(election_level_days(職位) ＋ task_kind_days_by_type(型別, 缺照片)) × 86400，不含屆基準。2026-11-21';

CREATE OR REPLACE FUNCTION task_band_seconds(p_task_type TEXT, p_target JSONB) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT (task_level_days(p_task_type, p_target) + task_kind_days(p_task_type, p_target))::BIGINT * 86400
$$;
COMMENT ON FUNCTION task_band_seconds IS '一件任務的帶狀秒數（20261121）：(task_level_days ＋ task_kind_days) × 86400；seed 與手動入列共用。2026-11-21';

-- 最新一屆的屆基準：elections 裡 election_date 最大的例行選舉（election_reason = regular；重行選舉不算）；查無＝2026
CREATE OR REPLACE FUNCTION latest_election_base_seconds() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT ((EXTRACT(YEAR FROM e.election_date)::INTEGER % 100) * 100)::BIGINT * 86400
                     FROM elections e WHERE COALESCE(e.election_reason, 'regular') = 'regular'
                    ORDER BY e.election_date DESC, e.id DESC LIMIT 1),
                  2600::BIGINT * 86400)
$$;
COMMENT ON FUNCTION latest_election_base_seconds IS '最新一屆的屆基準秒數（20261121）：elections 裡 election_date 最大的例行選舉（election_reason=regular）的 (年後兩碼 × 100) 天；插隊一律用它，不看人物所屬屆。2026-11-21';

-- 屆基準：插隊中用最新一屆，否則用 target 自己那一屆（沒有選舉 id＝當 2026，同 election_year_priority_seconds）
CREATE OR REPLACE FUNCTION task_year_priority_seconds(p_target JSONB, p_boosted BOOLEAN) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN COALESCE(p_boosted, false) THEN latest_election_base_seconds()
              ELSE election_year_priority_seconds(election_id_or_null(p_target->>'election_id')) END
$$;
COMMENT ON FUNCTION task_year_priority_seconds IS '一件任務的屆基準秒數（20261121）：插隊中（p_boosted）用 latest_election_base_seconds()；否則 election_year_priority_seconds(target 的選舉 id)。2026-11-21';

-- 驗證票的帶狀秒數：(母任務層級 ＋ 19) × 86400。母任務列的 task_type／target → 交件 payload／母任務的職位 → payload 的人物；都沒有＝無層級 30
CREATE OR REPLACE FUNCTION verify_ticket_band_seconds(p_verify_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT (election_level_days(COALESCE(task_level_text(p.task_type, p.target), verify_ticket_election_type(p_verify_task_id), task_target_level_text(b.payload)))
          + task_kind_days_by_type('verify', false))::BIGINT * 86400
    FROM (SELECT 1) x
    LEFT JOIN contributions b ON b.id = uuid_or_null(substr(p_verify_task_id, 8))
    LEFT JOIN task_dispatches p ON p.task_id = COALESCE(b.task_id, b.payload->>'task_id')
$$;
COMMENT ON FUNCTION verify_ticket_band_seconds IS '驗證票的帶狀領先秒數（20261121，取代 verify_priority_seconds 的 14 天）：(母任務層級天數 ＋ 19) × 86400；母任務列不在時看交件 payload 的職位／人物；都沒有＝無層級 30。2026-11-21';

-- 票相對母任務位置的領先秒數：(19 − 母任務種類天數) × 86400。母任務位置（基準）已含母任務的 屆基準＋層級＋種類，
-- 票再領先「19 − 母種類」，合計 ＝ 屆基準＋母任務層級＋19，層級不重複算（母任務種類最大 19，所以不會是負的）
CREATE OR REPLACE FUNCTION verify_ticket_parent_lead_seconds(p_parent_task_type TEXT, p_parent_target JSONB) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(task_kind_days_by_type('verify', false) - task_kind_days(p_parent_task_type, p_parent_target), 0)::BIGINT * 86400
$$;
COMMENT ON FUNCTION verify_ticket_parent_lead_seconds IS '驗證票對母任務位置的領先秒數（20261121）：(19 − 母任務種類天數) × 86400，不重複算層級（母任務位置已含）。母任務列不在、新增型走 verify_ticket_band_seconds（層級＋19）。2026-11-21';

-- ------------------------------------------------------------
-- 2. 流量提層改比例制
-- ------------------------------------------------------------
-- per_user_seconds 欄位由前一支 20261121192900_priority_bands_columns.sql 先加（只加欄位＋預設值，避免 ACCESS EXCLUSIVE 鎖跟著這支的大交易拖長）
COMMENT ON COLUMN traffic_boost_settings.per_user_seconds IS '流量提層比例制（20261121）：每 1 位近 window_days 天不重複訪客加幾秒優先秒數（86400＝1 天），無門檻、無上限；取代固定的 boost_seconds。2026-11-21';
COMMENT ON COLUMN traffic_boost_settings.boost_seconds IS 'deprecated（20261121）：流量提層改比例制（per_user_seconds × 訪客數），這欄不再被讀。2026-11-21';
COMMENT ON COLUMN traffic_boost_settings.min_users IS '門檻：近 window_days 天不重複訪客至少幾人才算有真實流量。20261121 起比例制無門檻，值＝1（CHECK 要求 ≥ 1；0 人的頁面本來就不會在 page_traffic 裡）';

-- 流量提層（以 20261011350000 的現行定義為底，只差標 >>> 帶狀優先 的幾處）
CREATE OR REPLACE FUNCTION traffic_boost_apply() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE s traffic_boost_settings%ROWTYPE; v_lifted INTEGER := 0;
BEGIN
  SELECT * INTO s FROM traffic_boost_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN RETURN 0; END IF;
  -- 沒有任何流量資料、也沒有狀態列：什麼都不做（上線當下與流量表是空的時候，seed 的輸出與舊版逐件相同）
  IF NOT EXISTS (SELECT 1 FROM page_traffic_hot) AND NOT EXISTS (SELECT 1 FROM page_traffic_boosts) THEN RETURN 0; END IF;

  DROP TABLE IF EXISTS _tb_hot;
  DROP TABLE IF EXISTS _tb_keys;
  DROP TABLE IF EXISTS _tb_pages;
  CREATE TEMP TABLE _tb_hot ON COMMIT DROP AS SELECT h.kind, h.target_id, h.users FROM page_traffic_hot h;  -- >>> 帶狀優先：帶人數（比例制要用）

  -- 達標頁面的「鍵」：頁面本身的 uuid；人物頁另含他名下政見的 uuid 與他的參選紀錄 id（'pe:<id>'）
  CREATE TEMP TABLE _tb_keys ON COMMIT DROP AS
    SELECT h.kind, h.target_id, h.target_id AS key FROM _tb_hot h
    UNION
    SELECT h.kind, h.target_id, pl.id::TEXT FROM _tb_hot h JOIN policies pl ON pl.politician_id = h.target_id::UUID WHERE h.kind = 'politician'
    UNION
    SELECT h.kind, h.target_id, 'pe:' || pe.id FROM _tb_hot h JOIN politician_elections pe ON pe.politician_id = h.target_id::UUID WHERE h.kind = 'politician';

  -- 每個缺口（>>> 帶狀優先：比例制無門檻，不再限定「優先秒數比 boost_seconds 小」的缺口）指到哪些達標頁：target 整份展開成鍵（任何位置的 uuid、參選紀錄 id 陣列與單值），和達標頁的鍵做等值連接
  CREATE TEMP TABLE _tb_pages ON COMMIT DROP AS
    SELECT DISTINCT gk.task_id, k.kind, k.target_id
      FROM (SELECT g.task_id, m[1] AS key
              FROM _gaps g, regexp_matches(g.target::TEXT, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') AS m
            UNION
            SELECT g.task_id, 'pe:' || e
              FROM _gaps g,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.target->'politician_election_ids') = 'array' THEN g.target->'politician_election_ids' ELSE '[]'::JSONB END) AS e
            UNION
            SELECT g.task_id, 'pe:' || (g.target->>'politician_election_id')
              FROM _gaps g
             WHERE g.target->>'politician_election_id' IS NOT NULL) gk
      JOIN _tb_keys k ON k.key = gk.key;

  -- a. 暫停期滿：還達標的開新的一期（重新計時）；已經冷卻的直接清掉，等再次達標才開始計時
  UPDATE page_traffic_boosts b
     SET paused_until = NULL, boosted_since = now(), last_yield_at = NULL, lifted_task_ids = '{}', updated_at = now()
   WHERE b.paused_until IS NOT NULL AND b.paused_until <= now()
     AND EXISTS (SELECT 1 FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id);
  DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NOT NULL AND b.paused_until <= now();

  -- b. 達標就記下時間
  UPDATE page_traffic_boosts b SET last_hot_at = now(), updated_at = now()
    FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id AND b.last_hot_at IS DISTINCT FROM now();

  -- c. 有可提層缺口的達標頁：開新的一期，或接續現在這一期（暫停中的不動）
  INSERT INTO page_traffic_boosts (kind, target_id, boosted_since, last_hot_at, lifted_task_ids)
  SELECT p.kind, p.target_id, now(), now(), array_agg(DISTINCT p.task_id) FROM _tb_pages p GROUP BY p.kind, p.target_id
  ON CONFLICT (kind, target_id) DO UPDATE
    SET boosted_since = CASE WHEN cardinality(page_traffic_boosts.lifted_task_ids) = 0 THEN now() ELSE page_traffic_boosts.boosted_since END,
        lifted_task_ids = ARRAY(SELECT DISTINCT x FROM unnest(page_traffic_boosts.lifted_task_ids || EXCLUDED.lifted_task_ids) AS x ORDER BY x), updated_at = now()
    WHERE page_traffic_boosts.paused_until IS NULL;

  -- d. 產出：這一期提層過的任務上，最近一次型別不是 no_change／task_suggestion、狀態不是 rejected 的交件（查無與冷卻不算）
  -- 每輪依「現在仍有效的交件」重算：先前算進去的交件後來被駁回，就不再算（沒有任何有效交件就清成 NULL）
  UPDATE page_traffic_boosts b
     SET last_yield_at = (SELECT max(c.created_at) FROM contributions c
                           WHERE c.task_id = ANY (b.lifted_task_ids) AND c.created_at >= b.boosted_since
                             AND c.contribution_type NOT IN ('no_change', 'task_suggestion') AND c.status <> 'rejected'),
         updated_at = now()
   WHERE b.paused_until IS NULL
     AND b.last_yield_at IS DISTINCT FROM (SELECT max(c.created_at) FROM contributions c
                                            WHERE c.task_id = ANY (b.lifted_task_ids) AND c.created_at >= b.boosted_since
                                              AND c.contribution_type NOT IN ('no_change', 'task_suggestion') AND c.status <> 'rejected');

  -- e. 暫停：現在達標、但從這一期開始（或最近一次有產出）起已經 no_yield_days 天沒有任何產出
  UPDATE page_traffic_boosts b SET paused_until = now() + make_interval(days => s.pause_days), updated_at = now()
   WHERE b.paused_until IS NULL AND cardinality(b.lifted_task_ids) > 0
     AND EXISTS (SELECT 1 FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id)
     AND GREATEST(b.boosted_since, COALESCE(b.last_yield_at, b.boosted_since)) <= now() - make_interval(days => s.no_yield_days);

  -- f. 距上次達標超過 no_yield_days 的狀態列清掉（暫停中的留到期滿）
  DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NULL AND b.last_hot_at < now() - make_interval(days => s.no_yield_days);

  -- g. 提層：沒暫停的達標頁名下的缺口標 opened_by.traffic_boost（秒數由 seed 下一段給；新缺口出生時 opened_by 帶著這個旗標）
  -- >>> 帶狀優先（20261121）：比例制——同時標 opened_by.traffic_users ＝ 對到的達標頁中近 window_days 天不重複訪客數最大的那頁；seed 給 traffic_users × per_user_seconds
  UPDATE _gaps g SET opened_by = COALESCE(g.opened_by, '{}'::JSONB) || jsonb_build_object('traffic_boost', true, 'traffic_users', u.users)
    FROM (SELECT p.task_id, max(h.users) AS users
            FROM _tb_pages p
            JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id AND b.paused_until IS NULL
            JOIN _tb_hot h ON h.kind = p.kind AND h.target_id = p.target_id
           GROUP BY p.task_id) u
   WHERE g.task_id = u.task_id;
  -- <<< 帶狀優先
  GET DIAGNOSTICS v_lifted = ROW_COUNT;
  RETURN v_lifted;
END;
$$;

-- ------------------------------------------------------------
-- 3. 手動任務進隊（以 20261114010000 的現行定義為底，只差標 >>> 帶狀優先 的一處）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         -- >>> 帶狀優先（20261121）：不再讀規則秒數、選舉年優先、選舉類別提前天數；改成「屆基準 ＋ 層級 ＋ 種類」——有插隊（manual_front_seconds > 0）的用最新一屆的屆基準，其餘用 target 自己那一屆
         task_year_priority_seconds(m.target, COALESCE(manual_front_seconds(m.task_id), 0) > 0) + task_band_seconds(m.task_type, m.target),
         -- <<< 帶狀優先
         COALESCE(manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 4. seed（以 20261119170000 的現行定義為底，只差標 >>> 帶狀優先 的區塊；暫存表瘦身的 SET 設定照舊寫在定義裡）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'  -- 11-19 手動加的現況；CREATE OR REPLACE 會洗掉 ALTER FUNCTION 設的值，所以寫進定義
SET work_mem = '16MB'  -- 暫存表排序／雜湊不再溢出到磁碟（預設 5MB）
AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  -- >>> 暫存表瘦身：_gaps_all 保留總表完整輸出並加列號 rn（只讀、不改）；寬欄（what_we_need、hint_sources、task_type、reward、region）只留在這裡，後面要寫進 task_dispatches 時才用 rn 回來取
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT row_number() OVER ()::INTEGER AS rn, a.* FROM contribution_auto_tasks_arms() a;
  CREATE UNIQUE INDEX ON _gaps_all (rn);
  -- <<< 暫存表瘦身
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  -- >>> 暫存表瘦身：_gaps 只帶後面會讀、會改的欄（task_id、arm、target、opened_by），加 src_rn 指回 _gaps_all 取寬欄。下面五次 UPDATE 每次都整列重寫，列越窄落碟越少
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.task_id, g.rn AS src_rn, g.arm, g.target, g.opened_by, g.task_type FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id, g.rn;
  -- <<< 暫存表瘦身

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  -- >>> 帶狀優先（20261121）：不再呼叫 activity_priority_seconds（規則秒數不再被讀，下面的優先秒數整個重新算）；priority_rule_id 維持 NULL，opened_by 不再記 priority_rule_id
  -- <<< 帶狀優先
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 帶狀優先（20261121）：優先秒數從這裡重新算——先清掉規則秒數（activity_rules 的優先秒數不再疊加），再給流量提層的比例制秒數：
  --     近 window_days 天不重複訪客數（opened_by.traffic_users，traffic_boost_apply 標的）× traffic_boost_settings.per_user_seconds；無門檻、無上限；沒有流量旗標＝0
  UPDATE _gaps g SET priority_seconds = CASE WHEN s.enabled AND g.opened_by->>'traffic_boost' = 'true'
                                             THEN COALESCE(NULLIF(g.opened_by->>'traffic_users', '')::BIGINT, 0) * s.per_user_seconds ELSE 0 END
    FROM traffic_boost_settings s WHERE s.id = 1;
  -- <<< 帶狀優先
  -- >>> 需求疊加（20261112070100）：同一張工作卡被不同人要過就加優先秒數（work_card_demand_seconds：單位數×2 天、上限 14 天、派出沒產出減半、冷卻中／結案為 0）。
  --     快照不論旗標都寫（乾跑視圖用）；demand_enabled 預設 false，關著時 priority_seconds 與前一版逐列相同。疊在流量提層（取最大）之後、選舉年（相加）之前
  BEGIN
    PERFORM work_card_demand_refresh();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'work_card_demand_refresh：%', SQLERRM;  -- 快照失敗不能讓整個 seed 掛掉（旗標關著時更不行）
  END;
  IF COALESCE((SELECT q.demand_enabled FROM queue_settings q WHERE q.id = 1), false) THEN
    UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + c.demand_seconds::INTEGER
      FROM task_dispatches t
      JOIN work_cards c ON c.work_key = t.work_key AND c.demand_seconds > 0
     WHERE t.task_id = g.task_id;
  END IF;
  -- <<< 需求疊加
  -- >>> 帶狀優先（20261121）：優先秒數再加「屆基準 ＋ 層級 ＋ 種類」（task_year_priority_seconds、task_band_seconds）。
  --     屆基準：插隊中的缺口（既有列 boost_seconds > 0；新缺口是手動臂且 manual_front_seconds > 0）用最新一屆（latest_election_base_seconds），其餘用 target 自己那一屆（沒有選舉 id 當 2026）；
  --     層級與種類見 task_level_days／task_kind_days（lineage_* 用 target.level、有選舉類別的用職位、都沒有的查這個人的參選紀錄、「其他」組無層級）。
  --     疊在流量提層與需求疊加之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0)
         + task_year_priority_seconds(g.target, COALESCE((SELECT d.boost_seconds > 0 FROM task_dispatches d WHERE d.task_id = g.task_id),
                                                         g.arm LIKE 'manual\_%' AND COALESCE(manual_front_seconds(g.task_id), 0) > 0))
         + task_band_seconds(g.task_type, g.target);
  -- <<< 帶狀優先

  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, task_rekey_stable_key(x.task_id) AS skey FROM task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE task_dispatches d SET task_type = a.task_type, target = g.target, what_we_need = a.what_we_need,
         hint_sources = a.hint_sources, reward = a.reward, region = a.region, refreshed_at = now()
    FROM _gaps g JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
   WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
    LEFT JOIN _rekey_prev r ON r.skey = task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
    FROM contributions c
   WHERE c.status = 'pending'
     -- >>> 一人一包（20261112065000）：還在包裡、不是載體（bundle_carrier_id）的條目沒有自己的票（票在載體上），不補；載體本身（含移轉後的新載體）照補
     AND NOT (c.bundle_id IS NOT NULL AND c.bundle_released_at IS NULL AND c.id IS DISTINCT FROM bundle_carrier_id(c.bundle_id))
     -- <<< 一人一包
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務

  RETURN v_new + v_verify;
END;
$$;

-- ------------------------------------------------------------
-- 5. 驗證票基準（以 20261114070100 的現行定義為底，只差標 >>> 帶狀優先 的兩處）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id) + verify_ticket_band_seconds(p_verify_task_id))  -- >>> 選舉年優先　>>> 帶狀優先：基準不含層級，領先 層級＋19 天
           ELSE COALESCE((SELECT GREATEST(p.dispatch_base_at,  -- >>> 基準夾限（20261114070100）：不早於母任務不含插隊的位置 − (最大合法插隊 ＋ 14 天)；位置算不出來就不夾
                                          task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - make_interval(secs => COALESCE(verify_ticket_base_floor_seconds(), 0)))
                            - make_interval(secs => verify_ticket_parent_lead_seconds(p.task_type, p.target))  -- >>> 帶狀優先：母任務位置已含層級，票只再領先 (19 − 母種類) 天
                            FROM task_dispatches p
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id) + verify_ticket_band_seconds(p_verify_task_id)))  -- >>> 選舉年優先　>>> 帶狀優先：沒有母任務位置時基準不含層級，領先 層級＋19 天
         END
    FROM (SELECT 1) x LEFT JOIN verify_ticket_parent(p_verify_task_id) t ON true
$$;

-- ------------------------------------------------------------
-- 6. 規則、設定、一次性重算
-- ------------------------------------------------------------
-- 規則表：#37 前段 +3 天、#38 後段 −30 天、#39 公報前降級 停用（不刪）；審計觸發器照寫 edit_history。可重跑：已停用的不再動
UPDATE activity_rules
   SET enabled = false,
       note = COALESCE(note || '｜', '') || '2026-11-21 層級×種類帶狀優先取代：停用（維護者「這樣改吧」）。優先秒數整個改由 task_band_seconds 等函式決定'
 WHERE id IN (37, 38, 39) AND activity IN ('priority:*', 'priority:raw:policy_missing') AND enabled;

-- priority_bands_applied_at 欄位由前一支 20261121192900_priority_bands_columns.sql 先加
COMMENT ON COLUMN queue_settings.priority_bands_applied_at IS '層級×種類帶狀優先（20261121）的一次性設定與重算做完的時間；有值＝已套用，重跑 migration 不再動設定、不再疊加。2026-11-21';
COMMENT ON COLUMN queue_settings.election_type_priority_days IS 'deprecated（20261121）：被層級帶狀（election_level_days）取代，seed 與手動入列不再讀；欄位與 election_type_priority_seconds() 留著。原：依選舉類別的優先提前天數（20261114010000）';
COMMENT ON COLUMN queue_settings.verify_priority_seconds IS '驗證列另加的領先秒數。20261121 起設 0：領先改成「母任務層級 ＋ 19 天」（verify_ticket_band_seconds），折進入列時凍結的基準（verify_ticket_base）。原 14 天（1209600）';
COMMENT ON COLUMN queue_settings.boost_seconds IS '/boost 插隊一次加幾秒（20261121 起 200 天＝17280000；原 30 天）；插隊中的列屆基準改用最新一屆；插兩次加兩份；任務列派出就歸零';
COMMENT ON COLUMN queue_settings.manual_front_seconds IS '維護者建的手動任務與裁決第一次進佇列的插隊秒數（20261121 起 200 天；原 30 天）';
COMMENT ON COLUMN queue_settings.visitor_front_seconds IS '網站請求／公民提問的插隊秒數（選後與對不上選舉的目標用這個值；20261121 起 200 天，原 50 天）；判斷在 visitor_front_seconds_for(target)';
COMMENT ON COLUMN queue_settings.visitor_front_pre_election_seconds IS '網站請求／公民提問的插隊秒數（選前用這個值；20261121 起 200 天，原 100 天，與選後一致）';

DO $$
DECLARE r RECORD; v_n INTEGER; v_old_vs INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM queue_settings WHERE id = 1 AND priority_bands_applied_at IS NOT NULL) THEN
    RAISE NOTICE '層級×種類帶狀優先的一次性設定與重算已套用過，略過';
    RETURN;
  END IF;
  SELECT q.verify_priority_seconds INTO v_old_vs FROM queue_settings q WHERE q.id = 1;

  -- 備份改前的值（精確回滾用，見檔頭回滾第 4 步），並依 task_id 順序先把要改的列鎖住（順序一致，降低與別的寫入互等死鎖的機會；等不到鎖 5 秒就整支失敗重跑）
  CREATE TABLE IF NOT EXISTS priority_bands_backup (task_id TEXT PRIMARY KEY, dispatch_base_at TIMESTAMPTZ, priority_seconds INTEGER, boost_seconds BIGINT, queue_at TIMESTAMPTZ, saved_at TIMESTAMPTZ NOT NULL DEFAULT now());
  ALTER TABLE priority_bands_backup ENABLE ROW LEVEL SECURITY;
  COMMENT ON TABLE priority_bands_backup IS '層級×種類帶狀優先（20261121193000）套用前的 task_dispatches 值備份，只給回滾用；沒有任何 policy＝只有 service_role 讀得到。2026-11-21';
  INSERT INTO priority_bands_backup (task_id, dispatch_base_at, priority_seconds, boost_seconds, queue_at)
    SELECT d.task_id, d.dispatch_base_at, d.priority_seconds, d.boost_seconds, d.queue_at FROM task_dispatches d ORDER BY d.task_id
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM 1 FROM task_dispatches d ORDER BY d.task_id FOR UPDATE;

  -- 前：隊頭 30 筆（任務列：沒被擋的前 30 筆；驗證票：驗證隊伍的前 30 筆）
  CREATE TEMP TABLE _pb_head_before ON COMMIT DROP AS
    SELECT d.task_type, COALESCE(task_level_text(d.task_type, d.target), '無層級') AS lvl
      FROM task_dispatches d WHERE d.task_id NOT LIKE 'verify:%' AND NOT d.blocked ORDER BY d.queue_at, d.task_id LIMIT 30;
  CREATE TEMP TABLE _pb_vhead_before ON COMMIT DROP AS
    SELECT d.verify_level, d.verify_rank FROM task_dispatches d WHERE d.task_id LIKE 'verify:%' ORDER BY d.verify_rank, d.queue_at, d.task_id LIMIT 30;
  FOR r IN SELECT task_type, lvl, count(*) AS n FROM _pb_head_before GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LOOP
    RAISE NOTICE '重算前 任務隊頭30 % ／ %：% 筆', r.task_type, r.lvl, r.n;
  END LOOP;
  FOR r IN SELECT verify_rank, verify_level, count(*) AS n FROM _pb_vhead_before GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '重算前 驗證隊頭30 rank % level %：% 張', r.verify_rank, r.verify_level, r.n;
  END LOOP;

  -- 設定：插隊 200 天（四個值一致）、驗證領先改 0（折進基準）、流量比例制無門檻
  UPDATE queue_settings
     SET boost_seconds = 17280000, manual_front_seconds = 17280000, visitor_front_seconds = 17280000, visitor_front_pre_election_seconds = 17280000,
         verify_priority_seconds = 0,
         note = COALESCE(note || '；', '') || '2026-11-21 層級×種類帶狀優先：插隊四值 → 200 天（17280000）、verify_priority_seconds 14 天 → 0（改由層級＋19 天折進基準）'
   WHERE id = 1;
  UPDATE traffic_boost_settings
     SET min_users = 1, per_user_seconds = 86400,
         note = COALESCE(note || '；', '') || '2026-11-21 比例制：每位近 7 天訪客 +1 天、無門檻無上限（min_users 改 1）'
   WHERE id = 1;

  -- 插隊中的任務列（boost_seconds > 0）抬到 200 天，與新設定一致（舊值 30／50／100 天或其倍數）。驗證票的插隊秒數不動、刻意不抬：驗證隊伍先看 verify_rank，同階才比 queue_at，票的插隊只在同階內有意義（cand_no_front_pull 等另有自己的量級）
  UPDATE task_dispatches d SET boost_seconds = 17280000
   WHERE d.task_id NOT LIKE 'verify:%' AND d.boost_seconds > 0 AND d.boost_seconds < 17280000;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '插隊中的任務列抬到 200 天：% 列', v_n;

  -- 現有驗證票（要在任務列重算之前：要用母任務現在還是舊值的 priority_seconds 算差額）。原排序鍵 ＝ 基準 − 14 天；改成 基準' ＝ 原基準 − 位移，verify_priority_seconds 已是 0：
  --   · 一般任務的交件（母任務列還在）：母任務的新位置比舊位置前 (P新 − P舊)，票再領先 (19 − 母種類) 天；14 天被取代、不是疊加。位移 ＝ (P新 − P舊) ＋ (19 − 母種類) 天
  --   · 新增型、母任務列已不在、沒有母任務：基準不含層級，位移 ＝ 層級 ＋ 19 天（verify_ticket_band_seconds）
  --   沒有基準的舊列先用現在的 queue_at 反推並補回舊的 14 天。
  UPDATE task_dispatches v
     SET dispatch_base_at = COALESCE(v.dispatch_base_at,
                                     verify_ticket_freeze_base(v.queue_at, v.dispatch_count, v.boost_seconds, verify_ticket_step_seconds(v.task_id, v.verify_has_votes))
                                       + make_interval(secs => v_old_vs))
                            - make_interval(secs => s.shift)
    FROM (SELECT t.task_id,
                 CASE WHEN pt.parent_id IS NOT NULL AND NOT COALESCE(pt.is_new, false) AND p.task_id IS NOT NULL
                      THEN (task_year_priority_seconds(p.target, p.boost_seconds > 0) + task_band_seconds(p.task_type, p.target)) - p.priority_seconds
                           + verify_ticket_parent_lead_seconds(p.task_type, p.target)
                      ELSE verify_ticket_band_seconds(t.task_id) END AS shift
            FROM task_dispatches t
            LEFT JOIN LATERAL verify_ticket_parent(t.task_id) pt ON true
            LEFT JOIN task_dispatches p ON p.task_id = pt.parent_id
           WHERE t.task_id LIKE 'verify:%') s
   WHERE v.task_id LIKE 'verify:%' AND s.task_id = v.task_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 張驗證票的基準', v_n;

  -- 任務列：priority_seconds ＝ 屆基準（插隊中用最新一屆）＋ 層級 ＋ 種類；觸發器 task_dispatches_queue_key 跟著重算 queue_at。流量與需求疊加下一輪 seed 補上
  UPDATE task_dispatches d
     SET priority_seconds = (task_year_priority_seconds(d.target, d.boost_seconds > 0) + task_band_seconds(d.task_type, d.target))::INTEGER
   WHERE d.task_id NOT LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 列任務列的 priority_seconds', v_n;

  -- 後：隊頭 30 筆
  FOR r IN SELECT d.task_type, COALESCE(task_level_text(d.task_type, d.target), '無層級') AS lvl, count(*) AS n
             FROM (SELECT x.task_type, x.target FROM task_dispatches x WHERE x.task_id NOT LIKE 'verify:%' AND NOT x.blocked ORDER BY x.queue_at, x.task_id LIMIT 30) d
            GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LOOP
    RAISE NOTICE '重算後 任務隊頭30 % ／ %：% 筆', r.task_type, r.lvl, r.n;
  END LOOP;
  FOR r IN SELECT d.verify_rank, d.verify_level, count(*) AS n
             FROM (SELECT x.verify_rank, x.verify_level FROM task_dispatches x WHERE x.task_id LIKE 'verify:%' ORDER BY x.verify_rank, x.queue_at, x.task_id LIMIT 30) d
            GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '重算後 驗證隊頭30 rank % level %：% 張', r.verify_rank, r.verify_level, r.n;
  END LOOP;

  -- 自我檢查：任務列的 queue_at 仍是排序鍵（觸發器已重算）
  IF EXISTS (SELECT 1 FROM task_dispatches WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;

  UPDATE queue_settings SET priority_bands_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
