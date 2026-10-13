-- 派工排序秒數化的第二支：收掉不再影響排序的舊東西（2026-10-13，維護者「a b 都作吧」；第一支是 20261011320000）
-- ============================================================
--
-- 20261011320000 起排序只看秒數（queue_at＝排序鍵，觸發器算），下面這些照舊算、照舊寫，卻沒有任何東西再讀它們：
--
--   刪掉
--     · rebalance_queue()：驗證：任務 2:1 與優先層 6:3:1 的重排；seed 已經不呼叫
--     · activity_priority()：每個缺口在哪一層；改由 activity_priority_seconds() 同時給秒數與相符的規則 id
--     · manual_front_at()：手動任務第一次進佇列排到 1970／1980；已由 manual_front_seconds() 取代、沒有呼叫者
--     · task_dispatches.priority：派工列現在的層（seed 每輪寫、沒人讀）
--     · task_priority_tiers.weight：6:3:1 的權重（只有 rebalance_queue 讀）
--     · traffic_boost_settings.boost_tier：流量提層「壓到第幾層」；改成「優先秒數比 boost_seconds 小的才提」，提到 boost_seconds
--
--   改
--     · seed_auto_task_queue：拿掉算層與寫層的兩段；opened_by 不再寫 priority（gap_events.priority 是生成欄位，舊事件照舊有值、新事件為 NULL），
--       priority_rule_id 改從 activity_priority_seconds 取（同一條規則：兩者都是「相符規則裡最往後的那條」）
--     · contribution_tasks_insert_dispatch：不再寫 priority
--     · traffic_boost_apply：可提層的判斷從「層比 boost_tier 靠後」改成「優先秒數比 boost_seconds 小」（現值 boost_tier＝前段、
--       boost_seconds＝前段的秒數，兩個判斷逐件相同）；只標 opened_by.traffic_boost，秒數照舊由 seed 下一段給
--     · 視圖 page_traffic_boosted_tasks：最後一欄 priority 換成 priority_seconds（欄位換名，DROP＋CREATE；沒有程式讀它，只有測試）
--
--   留著
--     · task_priority_tiers（id、label、seconds、is_default）與 activity_rules.priority：規則沒填 priority_seconds 時退回那一層的秒數、
--       沒有規則相符＝預設層；主控台規則頁也用它分「派工規則」與「排序規則」。要整個拿掉另外裁決
--     · gap_events.priority（生成欄位，歷史事件的層）
--
-- 派工輸出不變：排序鍵、可派與否、流量提層的對象都跟現在一樣（守門 queue-priority-cleanup.test.ts）。
-- 日本站（policy_jp）有自己的一套，這支不碰；日本站跟上秒數是另一支 migration。


CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 優先秒數：流量提層的缺口（opened_by.traffic_boost）至少給 traffic_boost_settings.boost_seconds
  UPDATE _gaps g SET priority_seconds = GREATEST(COALESCE(g.priority_seconds, 0), s.boost_seconds)
    FROM traffic_boost_settings s
   WHERE s.id = 1 AND s.enabled AND g.opened_by->>'traffic_boost' = 'true';
  -- <<< 優先秒數

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
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)),
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE 0 END
         -- <<< 優先秒數
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

  RETURN v_new + v_verify;
END;
$$;
COMMENT ON FUNCTION seed_auto_task_queue IS '排程每 10 分鐘：重算全站缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數（與相符的規則 id）；補驗證列、清掉已定案的；不重排（queue_at＝排序鍵，觸發器算）。2026-10-13';

CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM activity_priority_seconds(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0),
         COALESCE(manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

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
  CREATE TEMP TABLE _tb_hot ON COMMIT DROP AS SELECT h.kind, h.target_id FROM page_traffic_hot h;

  -- 達標頁面的「鍵」：頁面本身的 uuid；人物頁另含他名下政見的 uuid 與他的參選紀錄 id（'pe:<id>'）
  CREATE TEMP TABLE _tb_keys ON COMMIT DROP AS
    SELECT h.kind, h.target_id, h.target_id AS key FROM _tb_hot h
    UNION
    SELECT h.kind, h.target_id, pl.id::TEXT FROM _tb_hot h JOIN policies pl ON pl.politician_id = h.target_id::UUID WHERE h.kind = 'politician'
    UNION
    SELECT h.kind, h.target_id, 'pe:' || pe.id FROM _tb_hot h JOIN politician_elections pe ON pe.politician_id = h.target_id::UUID WHERE h.kind = 'politician';

  -- 每個可提層的缺口（現在的優先秒數比 boost_seconds 小）指到哪些達標頁：target 整份展開成鍵（任何位置的 uuid、參選紀錄 id 陣列與單值），和達標頁的鍵做等值連接
  CREATE TEMP TABLE _tb_pages ON COMMIT DROP AS
    SELECT DISTINCT gk.task_id, k.kind, k.target_id
      FROM (SELECT g.task_id, m[1] AS key
              FROM _gaps g, regexp_matches(g.target::TEXT, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') AS m
             WHERE COALESCE(g.priority_seconds, 0) < s.boost_seconds
            UNION
            SELECT g.task_id, 'pe:' || e
              FROM _gaps g,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.target->'politician_election_ids') = 'array' THEN g.target->'politician_election_ids' ELSE '[]'::JSONB END) AS e
             WHERE COALESCE(g.priority_seconds, 0) < s.boost_seconds
            UNION
            SELECT g.task_id, 'pe:' || (g.target->>'politician_election_id')
              FROM _gaps g
             WHERE g.target->>'politician_election_id' IS NOT NULL AND COALESCE(g.priority_seconds, 0) < s.boost_seconds) gk
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

  -- g. 提層：沒暫停的達標頁名下的缺口標 opened_by.traffic_boost（秒數由 seed 下一段給到 boost_seconds；新缺口出生時 opened_by 帶著這個旗標）
  UPDATE _gaps g SET opened_by = COALESCE(g.opened_by, '{}'::JSONB) || '{"traffic_boost": true}'::JSONB
   WHERE g.task_id IN (SELECT p.task_id FROM _tb_pages p JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id WHERE b.paused_until IS NULL);
  GET DIAGNOSTICS v_lifted = ROW_COUNT;
  RETURN v_lifted;
END;
$$;
COMMENT ON FUNCTION traffic_boost_apply IS
  '頁面流量提層（seed_auto_task_queue 每 10 分鐘呼叫，讀暫存表 _gaps）：達標頁面（page_traffic_hot）名下、優先秒數比 boost_seconds 小的缺口標 opened_by.traffic_boost（seed 接著把秒數提到 boost_seconds）；回傳標了幾件。'
  '狀態在 page_traffic_boosts：no_yield_days 天沒有產出就暫停 pause_days 天。參數全在 traffic_boost_settings。page_traffic 與狀態都是空的就直接回 0。2026-10-13';


DROP VIEW IF EXISTS page_traffic_boosted_tasks;
CREATE VIEW page_traffic_boosted_tasks AS
SELECT b.kind, b.target_id, b.boosted_since, d.task_id, d.task_type, d.priority_seconds
  FROM page_traffic_boosts b
  JOIN page_traffic_hot h ON h.kind = b.kind AND h.target_id = b.target_id
  JOIN traffic_boost_settings s ON s.id = 1
  JOIN task_dispatches d ON d.task_id = ANY (b.lifted_task_ids)
 WHERE s.enabled AND b.paused_until IS NULL AND d.priority_seconds >= s.boost_seconds;
COMMENT ON VIEW page_traffic_boosted_tasks IS '現在因頁面流量而提到 boost_seconds（或更前）的派工列：哪一頁、哪一件。只列現在仍達標（page_traffic_hot）而且功能開著（enabled）的頁面；冷卻、停用、暫停中的不列。2026-10-13 起看優先秒數';
GRANT SELECT ON page_traffic_boosted_tasks TO anon, authenticated;

DROP FUNCTION IF EXISTS rebalance_queue();
DROP FUNCTION IF EXISTS activity_priority(TEXT, INTEGER, TEXT, DATE);
DROP FUNCTION IF EXISTS manual_front_at(TEXT);
ALTER TABLE task_dispatches DROP COLUMN IF EXISTS priority;
ALTER TABLE task_priority_tiers DROP COLUMN IF EXISTS weight;
ALTER TABLE traffic_boost_settings DROP COLUMN IF EXISTS boost_tier;

-- ------------------------------------------------------------
-- 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('rebalance_queue', 'activity_priority', 'manual_front_at')) THEN
    RAISE EXCEPTION '舊的派工函式沒刪乾淨';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public', 'shared')
                AND p.prosrc ~ '(rebalance_queue|activity_priority|manual_front_at)\(|boost_tier') THEN
    RAISE EXCEPTION '還有函式引用已刪掉的派工函式或欄位';
  END IF;
  IF EXISTS (SELECT 1 FROM task_dispatches
              WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;
END;
$$;
