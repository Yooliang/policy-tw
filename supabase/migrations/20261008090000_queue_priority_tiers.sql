-- 佇列的優先層：由 activity_rules 決定，取代手動加推（/boost）（2026-10-08，docs/PLAN-task-activation.md 第 11 節）
-- ============================================================
--
-- 起因：維護者 10-08「加推自動化」。盤點時所有非驗證任務在同一條先進先出的時間軸上，2022、2024 的歷史補資料（term_policy_missing 約 2,000 件等）
-- 和 2026 選舉任務混排；2026 的 party_roster、村里長 policy_missing、鄉鎮市長補縣市累計 14 天沒被派出過。手動插隊（queue_at＝1980 年段的哨兵值）
-- 是一次性的，領走就回到時間軸——人得一直盯著。這支讓「哪些任務先、哪些後」由規則說了算，人只在要特別插隊時才用 /boost。
--
-- 設計：
--   1. 優先層（priority，整數，越小越前面）放在 activity_rules 的新欄位，不放 params。理由：它要被查、被限制範圍（外鍵指向 task_priority_tiers，
--      寫錯層號進不去）、被 activity_health／activity_open_now 看見；params 是臂自己的參數袋（jsonb），沒有型別與外鍵，優先層放進去只能靠文字約定。
--      有填 priority 的規則「只管排序、不管開關」：它的活動名一律以 'priority:' 開頭（'priority:*'＝所有活動、'priority:<臂名>'＝只對那支臂），
--      所以 activity_open()（P0）、activity_require_rule()（P1）與一切健康檢查原樣不動、不會把它們當成開窗規則——「規則是窗口」這件事的語意沒有被稀釋。
--      窗口怎麼算（里程碑＋偏移、職位／事由／層級範圍、min_status、缺里程碑＝關）與開窗規則完全相同，因為就是同一支 activity_open() 在算。
--   2. activity_priority(臂名, 選舉, 職位, 今天)：回傳這個缺口現在的優先層與依據的規則。同時有多條規則相符時取「號碼最大（最後面）」的那一條——
--      用法是「通則（前段／後段）＋個案降級」，沒有「個案升級」；沒有任何規則相符就是預設層（task_priority_tiers.is_default）。
--      不取最小是因為那會讓個案降級（例如 2026 非縣市長政見要等公報）永遠輸給通則的「前段」。
--   3. 規則值全部在這支 migration 的種子資料裡（task_priority_tiers 三列、activity_rules 三條優先規則），函式裡沒有任何年份、職位、天數、權重：
--        前段(1)：投票日前 180 天起到投票日（2026 九合一現在就在這裡）
--        中段(2)：預設層——沒有選舉的任務、投票後 180 天內的任務；另有一條個案規則：非縣市長的 policy_missing，在公報上架日之前（2026＝11-18）
--                 這些人的政見原文多半要等公報（10-08 盤點 607 筆 not_found），所以先排後面但不關掉（近 7 天仍從其他來源補了 201 筆）
--        後段(3)：投票日後 181 天起（2022、2024 與嘉義市重行的歷史補資料；2026 在 2027-05-28 之後也會自動落到這裡）
--      都是「相對於投票日／公報日的天數」，不指名選舉：2028 年新增一場選舉就自動走同一套。
--   4. 佇列怎麼用優先層（rebalance_queue，每 10 分鐘，seed 最後一步）：
--        * 同一層內維持原本的先進先出（照 queue_at、task_id）；
--        * 三層之間用「加權公平排隊」交錯，權重在 task_priority_tiers.weight（種子 6:3:1）：第 k 個任務的虛擬完成時間＝k／權重，全部照它排，
--          同時間點層號小的先。所以三層都有積壓時，每 10 筆約 6 筆前段、3 筆中段、1 筆後段，而且前段先走。
--        * 防餓死就是這個權重：後段永遠保有 1/10（前段／中段派光時自然流給後面的層），它的第 k 筆最慢排在第 10k 個位置，與前段有多大無關；
--          不是嚴格優先（嚴格優先會讓 2,000 件歷史補資料在 2026 任務永遠有得做的選前三個月完全不動，而且選舉結束後那批任務才發現還欠著）。
--          想調比例改 task_priority_tiers.weight 的種子（migration），不用改函式。
--        * 驗證：任務＝2:1 不變——任務還是從 v_start+1.5 秒起每筆 2 秒、驗證每筆 1 秒，加權只決定「哪一筆任務排在哪個任務位置」，不動位置的間距；
--        * 手動插隊（queue_at 早於 2000 年）仍在最前面：rebalance 本來就不碰它們；領走後 task_dispatched 把它排回隊尾，下一輪依自己的層歸位。
--        * 優先層變了（過了公報日、投票日、投票日後 181 天），seed 每輪都把每一列的 priority 對規則重算，下一輪 rebalance 就反映；
--          換層的任務保留自己的先進先出時間，所以從中段升到前段的政見任務會排在前段的前面（它們等得最久）。
--        * 新缺口排進佇列：seed 的 queue_slot／v_base 只決定「同一層裡的先後」（到達順序），真正落在哪個位置是同一個交易裡緊接著的 rebalance 決定——
--          兩段是同一個交易，所以不存在「新缺口先掉到隊尾、下一輪才歸位」的空窗。task_dispatched（/next 派出後放回隊尾）也不改：回隊尾＝自己這一層的隊尾。
--   5. 記錄：新缺口的 task_dispatches.opened_by 加 priority（出生時的優先層）與 priority_rule_id（依據的規則；沒有是預設層），P0 的觸發器本來就把 opened_by
--      整個抄進 gap_events.detail，所以 gap_events 也有；另外 gap_events.priority 是由 detail 算出來的生成欄位，可以直接 GROUP BY。
--      task_dispatches.priority 是「現在」的層（每輪重算），opened_by.priority 是「出生時」的層，兩者不同就是出生後換過層。
--   6. election_milestones_all 加一段 bulletin_published（讀 elections.bulletin_published_on，單一真相；NULL＝已上架，不產生里程碑；
--      election_milestones 表裡若有同一場選舉整場的 bulletin_published 列，以表為準）。這是前面「公報之前」的座標。
--
-- 不做：不改任何一支臂的內容與窗口（P2）；不改 boost／task_boost 的行為（task_boost 仍是「先 seed、再把符合的 queue_at 設成 1980 年段」）；
--   不改 /next（contribution_auto_tasks 仍照 queue_at 取隊頭，優先層全部在 rebalance 裡折進 queue_at）；不改 queue_slot、task_dispatched。
--
-- 上線順序：套用後 task_dispatches.priority 全是 NULL（＝預設層），rebalance 的輸出與舊版逐件相同；下一次 seed（≤10 分鐘，pg_cron）把每一列的層算出來、
--   同一輪 rebalance 就開始交錯。沒有任何 Edge Function 要配合部署（函式簽名都沒變）。
--
-- 守門：supabase/functions/_shared/queue-priority.test.ts（文字層：rebalance／seed／view 都是前一版加機械式替換、函式本體裡沒有寫死的年份職位天數權重；
--   PGlite：真的 queue_slot／rebalance_queue／contribution_auto_tasks／task_dispatched／seed／總表，多輪 seed＋派出，每條守門都有還原驗證）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：activity_rules／activity_open／activity_audit／activity_touch_updated_at／election_milestones／
-- election_milestones_all（P0）、contribution_auto_tasks_arms 的 arm 欄（P1）、task_dispatches、gap_events、elections.bulletin_published_on（20261008000002）、
-- election_id_or_null、election_term_start／end、queue_slot、contribution_auto_tasks、refresh_dispatch_blocked、refresh_verify_targets、contribution_queue_at、auth.role()。

-- ------------------------------------------------------------
-- 1. 優先層（層號、名稱、權重、預設層）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_priority_tiers (
  id         SMALLINT PRIMARY KEY CHECK (id BETWEEN 1 AND 9),
  label      TEXT NOT NULL,
  weight     INTEGER NOT NULL CHECK (weight > 0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS task_priority_tiers_one_default ON task_priority_tiers ((true)) WHERE is_default;
COMMENT ON TABLE task_priority_tiers IS
  '佇列的優先層：id 越小越前面；weight＝這一層在任務行列裡的份額（rebalance_queue 的加權公平排隊，所有層都有積壓時每一層分到 weight／總和）；'
  'is_default＝沒有任何優先規則相符時的層（只能有一列）。規則與權重只走 migration（流程規則，維護者裁）。2026-10-08（PLAN-task-activation 第 11 節）';
COMMENT ON COLUMN task_priority_tiers.weight IS
  '份額。防餓死就靠它：每一層至少保有 weight／總和（種子 6:3:1＝後段至少 1/10，前段／中段沒東西時自然流給後面的層）。不是嚴格優先';

INSERT INTO task_priority_tiers (id, label, weight, is_default, note) VALUES
  (1, '前段', 6, false, '投票日前 180 天內的選舉任務（2026-10-08 維護者：2026 選舉前先做）'),
  (2, '中段', 3, true,  '預設層：沒有選舉的任務、投票後 180 天內的任務、公報上架前的非縣市長 policy_missing'),
  (3, '後段', 1, false, '投票日後 181 天起的歷史補資料（2022、2024、嘉義市重行）；保有 1/10，不會餓死')
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM task_priority_tiers WHERE is_default) <> 1 THEN
    RAISE EXCEPTION '優先層：必須剛好有一個預設層（task_priority_tiers.is_default）';
  END IF;
END
$$;

ALTER TABLE task_priority_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON task_priority_tiers;
CREATE POLICY "Public read" ON task_priority_tiers FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON task_priority_tiers;
CREATE POLICY "Service role write" ON task_priority_tiers FOR ALL USING (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS trg_task_priority_tiers_touch ON task_priority_tiers;
CREATE TRIGGER trg_task_priority_tiers_touch BEFORE UPDATE ON task_priority_tiers FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_task_priority_tiers_audit ON task_priority_tiers;
CREATE TRIGGER trg_task_priority_tiers_audit AFTER INSERT OR UPDATE OR DELETE ON task_priority_tiers FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 2. 欄位：activity_rules.priority（規則）、task_dispatches.priority（派工列現在的層）、gap_events.priority（出生時的層，由 detail 算）
-- ------------------------------------------------------------
ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority SMALLINT REFERENCES task_priority_tiers(id);
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_priority_namespace;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_priority_namespace CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL));
COMMENT ON COLUMN activity_rules.priority IS
  '優先層（task_priority_tiers.id，越小越前面）。有填的規則只管排序、不管開關：活動名必須是 priority:<臂名> 或 priority:*（所有活動），所以 activity_open() 與健康檢查不會把它當開窗規則；'
  '窗口語意與開窗規則相同（同一支 activity_open 在算）。多條相符取號碼最大的（個案降級＋通則），都不符＝預設層。沒填＝一般的開窗規則。2026-10-08';

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS priority SMALLINT REFERENCES task_priority_tiers(id);
COMMENT ON COLUMN task_dispatches.priority IS
  '這一列現在的優先層（seed 每 10 分鐘依 activity_priority 重算，rebalance_queue 用它交錯）。NULL＝還沒算過／verify: 列／非 auto: 列，一律當預設層。出生時的層看 opened_by.priority。2026-10-08';

ALTER TABLE gap_events ADD COLUMN IF NOT EXISTS priority SMALLINT
  GENERATED ALWAYS AS (COALESCE((detail->>'priority')::SMALLINT, (detail->'opened_by'->>'priority')::SMALLINT)) STORED;
COMMENT ON COLUMN gap_events.priority IS '缺口出生時的優先層（opened／reopened 讀 detail.priority；closed 讀 detail.opened_by.priority）；舊事件沒有。生成欄位，不用寫。2026-10-08';

COMMENT ON COLUMN task_dispatches.opened_by IS
  '缺口是因為哪一筆資料被開出來的：seed 寫 contribution_auto_tasks_arms() 帶來的 {"basis":"rule","arm":臂名,"rule_id":…,"election_id":…,"milestone_kind":…,"milestone_on_date":…,"expected_open_on":…}（沒有的欄位不寫；'
  '覆寫開的是 basis=override＋override_id），再加出生時的優先層 priority 與依據的規則 priority_rule_id（沒有 priority_rule_id＝預設層）；回填的既有列是 {"basis":"backfill"}；/next 的 task_dispatched 新增的列是 {"basis":"insert"}';

-- ------------------------------------------------------------
-- 3. 里程碑：公報上架日（elections.bulletin_published_on，單一真相；NULL＝已上架，不產生里程碑）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW election_milestones_all AS
  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,
         'table'::TEXT AS origin, m.id AS milestone_id
    FROM election_milestones m
  UNION ALL
  SELECT e.id, 'polling'::TEXT, NULL::TEXT, e.election_date, 'official'::TEXT,
         CASE WHEN e.election_date < activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM elections e
   WHERE e.election_date IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_start'::TEXT, t.election_type, election_term_start(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_start(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_start(e.id, t.election_type) IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_end'::TEXT, t.election_type, election_term_end(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_end(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_end(e.id, t.election_type) IS NOT NULL
  UNION ALL
  SELECT e.id, 'bulletin_published'::TEXT, NULL::TEXT, e.bulletin_published_on, 'official'::TEXT,
         CASE WHEN e.bulletin_published_on <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM elections e
   WHERE e.bulletin_published_on IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL);
COMMENT ON VIEW election_milestones_all IS
  '規則讀的里程碑全貌：election_milestones（origin=table）＋投票日 polling（來自 elections.election_date）＋就任日／屆滿日 term_start／term_end（來自 election_term_start／end，一個職位一列；罷免沒有任期不列）'
  '＋公報上架日 bulletin_published（來自 elections.bulletin_published_on，NULL＝已上架不列；表裡有同一場選舉整場的 bulletin_published 列時以表為準）。後三者不重複存。'
  'polling／term／bulletin 的 status：日期已過＝done，否則 announced。2026-10-08';

-- ------------------------------------------------------------
-- 4. 規則種子（規則值只在這裡，函式裡沒有）
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, election_types, priority, note)
SELECT v.activity, 'event', v.from_kind, v.from_offset, v.until_kind, v.until_offset, v.election_types, v.priority, v.note
  FROM (VALUES
    ('priority:*', 'polling', -180, 'polling', 0, NULL::TEXT[], 1::SMALLINT,
     '前段：投票日前 180 天起到投票日（2026-10-08 維護者「加推自動化」：2026 選舉前的任務先做）。通則，對所有活動'),
    ('priority:*', 'polling', 181, NULL, 0, NULL::TEXT[], 3::SMALLINT,
     '後段：投票日後 181 天起（2022、2024、嘉義市重行等歷史補資料）。通則，對所有活動；仍保有 task_priority_tiers 的份額，不會餓死'),
    ('priority:raw:policy_missing', NULL, 0, 'bulletin_published', -1,
     ARRAY['總統副總統', '立法委員', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[], 2::SMALLINT,
     '中段（個案降級）：非縣市長的 policy_missing，公報上架日之前。政見原文多半要等公報（2026-10-08 盤點 607 筆 not_found），先排後面但不關掉（近 7 天仍從其他來源補了 201 筆）；'
     '公報上架日（elections.bulletin_published_on）當天起不再降級，回到前段。elections.bulletin_published_on 是空的＝已上架＝不降級')
  ) AS v(activity, from_kind, from_offset, until_kind, until_offset, election_types, priority, note)
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.priority IS NOT NULL);

-- ------------------------------------------------------------
-- 5. activity_priority：這個缺口現在在哪一層
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_priority(
  p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT activity_today()
) RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)
LANGUAGE sql STABLE AS $$
  WITH hit AS (
    SELECT r.priority AS tier, o.rule_id AS rid, o.milestone_kind AS mk, o.milestone_on_date AS md, o.expected_open_on AS xo
      FROM (SELECT * FROM activity_open('priority:' || p_activity, p_election_id, p_election_type, p_today)
            UNION ALL SELECT * FROM activity_open('priority:*', p_election_id, p_election_type, p_today)) o
      JOIN activity_rules r ON r.id = o.rule_id
     WHERE r.priority IS NOT NULL
     ORDER BY r.priority DESC, o.rule_id
     LIMIT 1
  )
  SELECT h.tier, h.rid, h.mk, h.md, h.xo FROM hit h
  UNION ALL
  SELECT t.id, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE FROM task_priority_tiers t WHERE t.is_default AND NOT EXISTS (SELECT 1 FROM hit)
$$;
COMMENT ON FUNCTION activity_priority IS
  '這個缺口（活動名＝派工臂名、選舉、職位）在 p_today 的優先層：讀 activity_rules 裡 priority 有填的規則（活動名 priority:<臂名>、priority:*，窗口由 activity_open 算，缺里程碑＝不相符），'
  '多條相符取號碼最大（最後面）的那條，都不相符＝預設層（rule_id 空）。永遠回傳剛好一列（除非 task_priority_tiers 沒有預設層）。seed_auto_task_queue 每輪呼叫。2026-10-08';

-- ------------------------------------------------------------
-- 6. rebalance_queue：照 20260924000006 的現行定義（與正式庫 pg_get_functiondef 一字不差，2026-10-08 比對過），
--    只機械式把「可派任務」那一段的排名換成加權交錯（同一層內仍是 queue_at、task_id 的先進先出）；
--    驗證那一段、不可派的任務那一段、起點、回傳值一字不動。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM task_priority_tiers x WHERE x.is_default)) AS tier
      FROM task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k FROM w
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION rebalance_queue IS
  '把佇列重排成 驗證：派得出去的任務＝2:1（seed_auto_task_queue 每 10 分鐘呼叫）；插隊的不動。可派的任務依優先層（task_dispatches.priority，NULL＝預設層）用 task_priority_tiers.weight 加權交錯，'
  '同一層內先進先出；任務位置的間距仍是每筆 2 秒，所以 2:1 不變。2026-10-08（PLAN-task-activation 第 11 節）';

-- ------------------------------------------------------------
-- 7. seed_auto_task_queue：照 P1（20261008060000）的現行定義，只機械式加入（標記起訖）：
--      a. 算完 _gaps 後，依 activity_priority 給每個缺口一個層（每組「臂×選舉×職位」算一次，不是每列算一次）；
--      b. 既有的派工列也跟著規則更新 priority（過了里程碑，下一輪 rebalance 就反映）；
--      c. 新增派工列時多寫 priority，opened_by 多帶出生時的 priority 與 priority_rule_id。
--    其餘（算缺口、收回、更新內容、新缺口排進行列、驗證列、重排、回傳值）一字不動；守門見 queue-priority.test.ts。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

  -- >>> 優先層：每個缺口現在在哪一層（每組「臂×選舉×職位」問一次）
  ALTER TABLE _gaps ADD COLUMN priority SMALLINT, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority = p.priority, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.priority, x.rule_id
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先層

  -- 已經不存在的缺口（補上了）：收回號碼牌
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- >>> 優先層：既有的派工列跟著規則換層（排隊時間不動；下一步的 rebalance 依新的層交錯）
  UPDATE task_dispatches d SET priority = g.priority
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）
  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();

  PERFORM rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;
