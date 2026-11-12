-- 一人一包 PR2（docs/PLAN-bundle-policies.md 第 3 節）：整包投票的扇出函式，加上 PR1 標的兩條必修。
-- 只加新函式與重貼兩支既有函式（簽名不變）；沒有任何程式呼叫 bundle_vote_fanout，也沒有任何列帶 bundle_id，
-- 所以線上行為不變。不改 TS、不改協議。
--
-- 盤點（PR1 標的 'verify:' || 插票／列舉處，以各函式最後一版為準）：
--   seed_auto_task_queue()                    補票段會替所有 pending 補票 → 已排除包內非載體（本檔 2）
--   task_boost_matches()（20261102180000）    列舉 pending 條目當驗證票命中，包內非載體沒有票 → 已排除（本檔 3）
--   cand_no_front_pull()（20261109190000）    只動 candidacy／cand_numbers／no_change 的既有票（UPDATE 只碰 task_dispatches 現有列），
--                                             不會是 policy 包的條目 → 不需動
--   auto-apply.ts 重發驗證票（TS，upsert verify:<id>）  只在條目被重新打開時呼叫，包內非載體若走到會多出一張票；
--                                             本 PR 不改 TS，列給接線的 PR 處理

-- ------------------------------------------------------------
-- 0. bundle_carrier_id：誰是載體（持有整包那一張票的條目）＝仍在包裡、仍 pending、bundle_index 最小的條目
--    bundle_pick_carrier、bundle_vote_fanout 的移轉、seed 補票段、task_boost_matches 共用這一個判斷
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION bundle_carrier_id(p_bundle UUID) RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT c.id
    FROM contributions c
   WHERE c.bundle_id = p_bundle AND c.bundle_released_at IS NULL AND c.status = 'pending'
   ORDER BY c.bundle_index ASC, c.created_at ASC, c.id ASC
   LIMIT 1;
$$;
COMMENT ON FUNCTION bundle_carrier_id IS '一人一包：包的載體＝仍在包裡（bundle_released_at IS NULL）、仍 pending、bundle_index 最小的條目；沒有回 NULL。2026-11-12';
REVOKE ALL ON FUNCTION bundle_carrier_id(UUID) FROM PUBLIC, anon, authenticated;

-- 以 20261112010000 的定義為底，只把「找載體」換成 bundle_carrier_id（鎖與補票不變）
CREATE OR REPLACE FUNCTION bundle_pick_carrier(p_bundle_id UUID) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  -- 同一包的載體移轉一次只有一個交易在做，確保一包只有一張票
  PERFORM pg_advisory_xact_lock(hashtext(p_bundle_id::text));
  v_id := bundle_carrier_id(p_bundle_id);
  IF v_id IS NOT NULL THEN
    PERFORM verify_ticket_enqueue(v_id);
  END IF;
  RETURN v_id;
END $$;

-- ------------------------------------------------------------
-- 1. bundle_vote_fanout：整包投票扇出成逐條 contribution_votes（單一交易）
--    ①bundle_votes 先記一筆（UNIQUE(bundle_id, voter_key) 擋重複）②對還在包裡、pending、不在 except、這位投票人還沒票的條目逐條插票
--    （計分、共識由既有的 contribution_votes 觸發器逐列算，這裡不碰分數）③except 的條目釋放並建自己的票；載體被釋放或已定案就移轉
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION bundle_vote_fanout(
  p_carrier UUID, p_bundle UUID, p_agent TEXT, p_actor TEXT, p_ip TEXT, p_verdict TEXT,
  p_except SMALLINT[], p_reasons JSONB, p_note TEXT, p_evidence TEXT, p_tool TEXT, p_via TEXT
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_key TEXT;
  v_except SMALLINT[] := COALESCE(p_except, '{}');
  v_ins INTEGER;
  v_voted INTEGER := 0;
  v_skipped INTEGER := 0;
  v_released INTEGER := 0;
  v_carrier_released BOOLEAN := false;
  v_new_carrier UUID;
  r RECORD;
BEGIN
  -- 同一包的投票、載體移轉一次只有一個交易在做
  PERFORM pg_advisory_xact_lock(hashtext(p_bundle::text));

  IF NOT EXISTS (SELECT 1 FROM contributions c WHERE c.id = p_carrier AND c.bundle_id = p_bundle) THEN
    RETURN jsonb_build_object('error', 'carrier_not_in_bundle');
  END IF;
  IF cardinality(v_except) > 0 AND p_verdict IS DISTINCT FROM 'agree' THEN
    RETURN jsonb_build_object('error', 'except_need_agree');
  END IF;

  -- 投票人鍵：DiTrust 看 actor_id，匿名看代號（小寫），與 contribution_votes 的 voter_key 算法相同
  v_key := CASE WHEN p_actor LIKE 'ditrust:%' THEN p_actor ELSE lower(p_agent) END;

  INSERT INTO bundle_votes (bundle_id, voter_key, agent_name, verdict, except_indexes, reasons, note)
  VALUES (p_bundle, v_key, p_agent, p_verdict, v_except, COALESCE(p_reasons, '{}'::jsonb), p_note)
  ON CONFLICT (bundle_id, voter_key) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins = 0 THEN
    RETURN jsonb_build_object('error', 'already_voted');
  END IF;

  FOR r IN
    SELECT c.id, c.bundle_index
      FROM contributions c
     WHERE c.bundle_id = p_bundle AND c.bundle_released_at IS NULL AND c.status = 'pending'
     ORDER BY c.bundle_index
  LOOP
    IF r.bundle_index = ANY (v_except) THEN
      -- 例外條：這位投票人不投，釋放成個別條目，走自己的驗證票
      UPDATE contributions SET bundle_released_at = now() WHERE id = r.id;
      PERFORM verify_ticket_enqueue(r.id);
      v_released := v_released + 1;
      IF r.id = p_carrier THEN v_carrier_released := true; END IF;
    ELSIF EXISTS (
      SELECT 1 FROM contribution_votes v
       WHERE v.contribution_id = r.id
         AND ((p_actor LIKE 'ditrust:%' AND v.actor_id = p_actor) OR lower(v.agent_name) = lower(p_agent))
    ) THEN
      v_skipped := v_skipped + 1;
    ELSE
      INSERT INTO contribution_votes (contribution_id, verdict, evidence_url, judge_backed, evidence_checked_at, evidence_verdict,
                                      note, agent_name, agent_tool, verifier_ip_hash, actor_id, via)
      VALUES (r.id, p_verdict, p_evidence, false, NULL, NULL,
              '[包 #' || r.bundle_index || ']' || CASE WHEN p_note IS NULL OR p_note = '' THEN '' ELSE ' ' || p_note END,
              p_agent, p_tool, p_ip, p_actor, 'bundle');
      v_voted := v_voted + 1;
    END IF;
  END LOOP;

  -- 載體被釋放、或投完票已定案（不再是 pending）：票交給包裡下一個
  IF v_carrier_released OR EXISTS (SELECT 1 FROM contributions c WHERE c.id = p_carrier AND c.status <> 'pending') THEN
    v_new_carrier := bundle_pick_carrier(p_bundle);
  END IF;

  RETURN jsonb_build_object('voted', v_voted, 'skipped', v_skipped, 'released', v_released, 'new_carrier', v_new_carrier);
END $$;
COMMENT ON FUNCTION bundle_vote_fanout IS '一人一包：整包投票扇出成逐條 contribution_votes（via=bundle，備註前綴 [包 #idx]），計分共識走既有觸發器；except 的條目釋放並建自己的票，載體被釋放或已定案就移轉（bundle_pick_carrier）。回 {voted, skipped, released, new_carrier} 或 {error: already_voted|carrier_not_in_bundle|except_need_agree}。p_via 目前不寫入（票的 via 固定 bundle，留作端點名稱供之後稽核）。2026-11-12';
REVOKE ALL ON FUNCTION bundle_vote_fanout(UUID, UUID, TEXT, TEXT, TEXT, TEXT, SMALLINT[], JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. seed：以 20261112005000 的現行定義為底，只在補驗證列那段加包內條目的排除（標 >>> 一人一包）
-- ------------------------------------------------------------
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
  -- >>> 選舉年優先（20261112005000）：優先秒數再加「選舉年後兩碼 × 100 天」（election_year_priority_seconds）；缺口 target 沒有選舉 id 的（網站請求、名冊、基本資料、合併…）當 2026。
  --     疊在規則秒數與流量提層之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id'));
  -- <<< 選舉年優先

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
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
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
     -- >>> 一人一包（20261112020000）：還在包裡、不是載體（bundle_carrier_id）的條目沒有自己的票（票在載體上），不補；載體本身（含移轉後的新載體）照補
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
-- 3. 插隊命中：以 20261102180000 的現行定義為底，只在 verify 那一段加同樣的排除（標 >>> 一人一包）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_boost_matches(p_filter jsonb)
RETURNS TABLE(task_id text, kind text)
LANGUAGE sql STABLE AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'regions' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'regions')) END AS regions,
      NULLIF(p_filter->>'election_id', '')::INT AS election_id,
      CASE WHEN p_filter ? 'election_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'election_types')) END AS election_types,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      COALESCE((p_filter->>'missing_avatar')::BOOLEAN, false) AS missing_avatar,
      CASE WHEN p_filter ? 'task_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_ids')) END AS task_ids,
      CASE WHEN p_filter ? 'politician_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'politician_ids')::UUID) END AS politician_ids,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的主角、縣市、屆別、型別
    -- 任務直接讀佇列 task_dispatches（seed 每 10 分鐘把總表寫進來，同一份 task_type／target／region），不再重算整張派工總表：
    -- 總表一次約 3 秒，加上 task_boost 開頭的 seed，插隊超過 8 秒的逾時（OPS #71，2026-10-10）
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           election_id_or_null(g.target->>'election_id') AS election_id,
           g.target->>'election_type' AS election_type
      FROM task_dispatches g WHERE g.task_id NOT LIKE 'verify:%'
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           election_id_or_null(c.payload->>'election_id'),
           c.payload->>'election_type'
      FROM contributions c WHERE c.status = 'pending'
       -- >>> 一人一包（20261112020000）：還在包裡、不是載體（bundle_carrier_id）的條目沒有票，不算進插隊命中（matched_verifies 才不會多算）；載體（含移轉後的新載體）照算
       AND NOT (c.bundle_id IS NOT NULL AND c.bundle_released_at IS NULL AND c.id IS DISTINCT FROM bundle_carrier_id(c.bundle_id))
       -- <<< 一人一包
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
    LEFT JOIN politicians p ON p.id = s.politician_id
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.task_ids IS NULL OR s.task_id = ANY(f.task_ids))
     AND (f.politician_ids IS NULL OR s.politician_id = ANY(f.politician_ids))
     AND (NOT f.missing_avatar OR (p.id IS NOT NULL AND COALESCE(p.avatar_url, '') = ''))
     AND (f.regions IS NULL OR COALESCE(s.region, p.region) = ANY(f.regions))
     AND (f.election_id IS NULL OR s.election_id = f.election_id
          OR (s.election_id IS NULL AND p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = f.election_id)))
     AND (f.election_types IS NULL OR s.election_type = ANY(f.election_types) OR (p.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_type::TEXT = ANY(f.election_types)
               AND (f.election_id IS NULL OR pe.election_id = f.election_id))));
$$;
