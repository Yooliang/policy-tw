-- 派工佇列的「合格條件」全部搬進 SQL、放在 LIMIT 之前（2026-10-17，policy-ops docs/work/2026-10-17-派工隊頭堵塞.md）
-- ============================================================
--
-- 起因（小良哥 10-17：「AI 提議 這種任務有被跑過了嗎」「/next 每次只從隊伍最前面取 30 筆候選 ?????????? 怎麼又來了」）：
-- /next 呼叫 contribution_queue_tasks(…, p_limit 30, …) 拿隊頭，再在程式裡套 filterReportedDeadEnds 等過濾器。
-- 只存在程式裡的過濾器發生在 LIMIT 之後：正式庫唯讀實查，前 30 筆（policy_missing ×1、avatar_choice ×29）每一筆都有一張
-- 查無回報（no_change）pending 在等票（10-11 起，分數 1／目標 2 或 0），filterReportedDeadEnds 把 30 筆全剔掉 → 沒有任務可派、
-- 這些頭沒被派出（不呼叫 task_dispatched）、queue_at 永遠最前，佇列頭被釘死；第一筆真的可派的在第 41 名。
-- 2026-09-20 同一類事故（窗口只有 12 筆）當時只加大窗口＋搬一部分條件，沒有根治；這支把剩下的全搬進來。
--
-- 搬進 SQL 的條件（每一段都有 >>> 合格：… / <<< 合格：… 標記，守門測試 next-eligibility-before-limit.test.ts 用它們對照 /next 的過濾器）：
--   * 合格：認領中            （原本就在 SQL；加標記）別人未過期的認領 ←→ filterLeasedTasks
--   * 合格：同機器交過        （原本就在 SQL；加標記）同機器／同代號在途交過 ←→ filterOwnSubmittedTasks
--   * 合格：查無回報在等票    （新）no_change 在途（pending／verified）且 payload.task_id＝這個任務 ←→ filterReportedDeadEnds。不分誰來領（p_ip_hash 為 NULL 也排）
--   * 合格：在途未額滿        （新）pending／verified／disputed 的貢獻 < 5（TASK_INFLIGHT_CAP＝MAX_POLICIES_PER_TASK）←→ filterSaturatedTasks。不分誰來領
--   * 合格：提問未滿額        （新）已上線 answer_count＋在等票的 question_answer ≥ question_answer_cap() 的提問不派 ←→ filterAnsweredQuestionTasks（滿額那一半）。不分誰來領
--   * 合格：提問這台答過      （新）question_answers 有這個代號、或這個代號／IP 有 question_answer 貢獻（含 applied）的提問不派給他 ←→ filterAnsweredQuestionTasks（答過那一半）。p_ip_hash 非 NULL 才查
--   * 合格：裁決任務          （新）裁決任務：已有 pending／verified 的裁決對這筆原貢獻（不分誰來領）；提交者本人、對原貢獻投過票（p_ip_hash 那一個雜湊）的不派（p_ip_hash 非 NULL 才查）←→ filterAdjudicateTasks
--
-- 留在程式裡的（/next 的過濾器仍保留當第二道保險）：
--   * filterSkippedTasks：跳過的是「這一次呼叫」帶進來的 skip_task_id（單一一筆、只在這次請求有意義），SQL 沒有這個輸入；一次最多剔一筆，不可能把 30 筆窗口清空。
--   * filterAdjudicateTasks 的「過渡期舊雜湊」：投過票的判斷 SQL 只認 p_ip_hash（網段雜湊）；切換前存的單一 IP 舊雜湊（legacyIpHash，#481）SQL 拿不到，仍在程式裡剔。
--     （不加參數：加參數＝新簽名、舊簽名會並存成兩個多載，CLAUDE.md 規定改簽名要分兩次上。）
--   /next 另外在「程式過濾完是空的、但 SQL 給滿一整頁」時 console.error 一行計數，所以日後出現新的缺口不會無聲。
--
-- 對其他讀者的影響（contribution_queue_tasks 以 p_ip_hash＝NULL 呼叫的）：
--   * rebalance_queue 的「可派集合」（_ready）：不再含查無回報在等票、在途額滿、提問滿額、已有裁決在等的任務——它們本來就派不出去，
--     現在排到可派的任務後面（rebalance 對「不在可派集合」的任務本來就是排到後段），隊頭不再被它們卡住；條件解除後下一輪（10 分鐘）重新排回。
--   * queue_preview：本來就自己剔查無回報（20261011330000），這支之後那段變成雙保險；其餘（額滿、提問、裁決）多剔了，預覽跟 /next 看到的更一致。
--   * 以 p_ip_hash 非 NULL 呼叫的只有 /next。
--
-- 日本站：policy_jp.contribution_queue_tasks 是 20261009130000 的複本，走樣守門 policy-jp-dispatch-drift.test.ts 逐字比對「最新的」正見版。
-- 這支改了正見版，日本版先不跟（同 contribution_verify_pool／contribution_effective_agree 的「日本站暫不跟」做法，比對改讀這支之前的版本），日本站 jp-next 的同構問題另開。
--
-- 另外：
--   * 表達式索引 contributions_adjudication_target_idx：裁決任務的「已有裁決在等」要用 payload->>'contribution_id' 找，跟 contributions_no_change_task_idx 同一個做法。
--   * 隊頭監看 queue_head_stale()＋activity_health 的 queue_head_stale 一列（正常是空的）：有可派的隊頭、卻 6 小時沒有任何任務被派出 → 一列。
--
-- 簽名與回傳型別一字不動（CREATE OR REPLACE），可以單獨先上。

CREATE INDEX IF NOT EXISTS contributions_adjudication_target_idx
  ON contributions ((payload->>'contribution_id')) WHERE contribution_type = 'adjudication';

CREATE OR REPLACE FUNCTION contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面所有「合格」條件都在 LIMIT 之前：不合格的列不佔窗口（程式裡的過濾器發生在 LIMIT 之後，會讓窗口被不合格的列塞滿、全部剔掉就沒有任務可派）
    -- >>> 合格：認領中
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target))
    ))
    -- <<< 合格：認領中
    -- >>> 合格：同機器交過
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
    -- <<< 合格：同機器交過
    -- >>> 合格：查無回報在等票
    -- 有人回報查無（no_change）還在等票或已通過、還沒落庫的任務，/next 不派給任何人（filterReportedDeadEnds）；不分誰來領，所以 p_ip_hash 為 NULL 也排
    AND NOT EXISTS (
      SELECT 1 FROM contributions n
      WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
        AND n.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：查無回報在等票
    -- >>> 合格：在途未額滿
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；LIMIT 5 讓計數最多數到 5 筆
    AND (SELECT count(*) FROM (
      SELECT 1 FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed') LIMIT 5
    ) inflight) < 5
    -- <<< 合格：在途未額滿
    -- >>> 合格：提問未滿額
    -- 手動任務裡的公民提問（task_type＝question、不是 auto:）：已上線答案（citizen_questions.answer_count）＋還在等票的 question_answer ≥ question_answer_cap() 就不派（fullQuestionIdsOf）
    AND (d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR uuid_or_null(d.target->>'question_id') IS NULL OR
         COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id = uuid_or_null(d.target->>'question_id')), 0)
         + (SELECT count(*) FROM contributions a
             WHERE a.task_id = d.task_id AND a.contribution_type = 'question_answer' AND a.status IN ('pending', 'verified'))
         < question_answer_cap())
    -- <<< 合格：提問未滿額
    -- >>> 合格：提問這台答過
    -- 這個代號答過這一題（question_answers，含已上線）、或這個代號／IP 交過這個任務的 question_answer（含 applied）就不再派給他（my_answers + filterAnsweredQuestionTasks）
    AND (p_ip_hash IS NULL OR d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR (
      NOT EXISTS (SELECT 1 FROM question_answers qa
                   WHERE qa.question_id = uuid_or_null(d.target->>'question_id') AND lower(qa.agent_name) = lower(COALESCE(p_agent, '')))
      AND NOT EXISTS (SELECT 1 FROM contributions m
                       WHERE m.task_id = d.task_id AND m.contribution_type = 'question_answer' AND m.status = 'applied'
                         AND (m.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND m.agent_name = p_agent)))
    ))
    -- <<< 合格：提問這台答過
    -- >>> 合格：裁決任務
    -- 裁決任務（task_type＝adjudicate，target.contribution_id＝原貢獻）：這筆爭議已有 pending／verified 的裁決在等票就不再派（不分誰來領）；
    -- 原貢獻是他自己交的、或這台機器（p_ip_hash）對原貢獻投過票的不派給他（filterAdjudicateTasks；過渡期的舊雜湊那一半仍在程式裡）
    AND (d.task_type <> 'adjudicate' OR (
      NOT EXISTS (SELECT 1 FROM contributions j
                   WHERE j.contribution_type = 'adjudication' AND j.status IN ('pending', 'verified')
                     AND j.payload->>'contribution_id' = d.target->>'contribution_id')
      AND (p_ip_hash IS NULL OR (
        (p_agent IS NULL OR lower(d.target->>'contributor') IS DISTINCT FROM lower(p_agent))
        AND NOT EXISTS (SELECT 1 FROM contribution_votes v
                         WHERE v.contribution_id = uuid_or_null(d.target->>'contribution_id') AND v.verifier_ip_hash = p_ip_hash)
      ))
    ))
    -- <<< 合格：裁決任務
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_queue_tasks IS
  '/next、rebalance_queue、queue_preview 拿隊頭：task_dispatches 裡所有「任務」列（自動缺口 auto: 與 open 的手動任務 uuid，不含 verify:），照 queue_at 取，跳過 blocked、冷卻中（插隊的除外）、對這台機器不合格的。'
  '所有合格條件都在 LIMIT 之前（20261017000001）：認領中、同機器交過、查無回報在等票、在途額滿（5）、提問滿額／答過、裁決不合格；/next 的過濾器只剩 skip 與舊雜湊投票兩項留在程式裡。'
  'contribution_auto_tasks（/tasks、/request-task 用）仍只回 auto: 列，輸出不變。同 queue_at 內公民提問依 target.stance_up 高的先。2026-10-08、2026-10-17';

-- ------------------------------------------------------------
-- 隊頭監看：有可派的隊頭、卻很久沒有任何任務被派出 → 一列（正常是空的）
-- ------------------------------------------------------------
-- 為什麼看「全站最近一次派出」而不是「隊頭自己的 last_dispatched_at」：健康的佇列裡，隊頭本來就是還沒輪到的那一筆，它自己的派出時間必然很舊，
-- 這個訊號永遠是紅的。10-17 的堵塞是反過來：隊頭永遠不被派出，整個任務佇列停擺。所以：可派的隊頭（合格條件都過了之後的第一筆）存在，
-- 而最近一次任務派出（task_dispatches.last_dispatched_at，verify: 不算）早於門檻 → 一列，附隊頭是誰，方便直接查。
CREATE OR REPLACE FUNCTION queue_head_stale_hours() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;
COMMENT ON FUNCTION queue_head_stale_hours IS '派工佇列隊頭停擺門檻（小時）：有可派的隊頭卻這麼久沒有任務被派出，activity_health 出現 queue_head_stale。改門檻＝新 migration 改這支函式。2026-10-17';

CREATE OR REPLACE FUNCTION queue_head_stale() RETURNS TABLE (head_task_id TEXT, head_task_type TEXT, last_dispatch_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT h.task_id, h.task_type, l.last_at
    FROM (SELECT * FROM contribution_queue_tasks(NULL, NULL, 1, '', NULL, NULL)) h
    CROSS JOIN (SELECT max(d.last_dispatched_at) AS last_at FROM task_dispatches d WHERE d.task_id NOT LIKE 'verify:%') l
   WHERE COALESCE(l.last_at, '-infinity'::timestamptz) < now() - make_interval(hours => queue_head_stale_hours())
$$;
COMMENT ON FUNCTION queue_head_stale IS '派工佇列停擺：可派的隊頭（contribution_queue_tasks 第一筆）存在，但最近一次任務派出早於 queue_head_stale_hours() → 一列；正常沒有列。activity_health 的 queue_head_stale（2026-10-17）';


CREATE OR REPLACE VIEW activity_health AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM activity_rules r GROUP BY r.activity HAVING NOT bool_or(r.enabled)
  UNION ALL
  SELECT 'override_without_rule', o.activity, '有覆寫但這個活動沒有任何規則（拼錯活動名？）'
    FROM activity_overrides o WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = o.activity) GROUP BY o.activity
  UNION ALL
  SELECT 'window_inverted', 'rule ' || r.id || ' / election ' || f.election_id,
         '起日 ' || (f.on_date + r.from_offset) || ' 晚於迄日 ' || (u.on_date + r.until_offset) || '，這條規則在這場選舉永遠不會開'
    FROM activity_rules r
    JOIN election_milestones_all f ON f.kind = r.from_kind
    JOIN election_milestones_all u ON u.kind = r.until_kind AND u.election_id = f.election_id
         AND (u.election_type IS NOT DISTINCT FROM f.election_type OR u.election_type IS NULL OR f.election_type IS NULL)
   WHERE r.enabled AND f.on_date + r.from_offset > u.on_date + r.until_offset
  UNION ALL
  SELECT 'milestone_scope_drift', s.election_id || ' / ' || s.election_type,
         'roster_check_scope 的五個日期欄（登記截止、名單公告、資格審查、抽號次、直轄市長名單公告）與 election_milestones 對不上：它們該由里程碑衍生（觸發器 roster_scope_derive_dates），對不上表示觸發器被停掉或繞過了'
    FROM roster_check_scope s
   WHERE s.registration_closed_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'registration_close', s.election_type)
      OR s.list_announced_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', s.election_type)
      OR s.qualification_review_by IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'qualification_review', s.election_type)
      OR s.ballot_draw_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'draw', s.election_type)
      OR s.municipal_mayor_list_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', '直轄市長', false)
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'bulletin_milestone_missing', e.id::TEXT,
         '選舉有公報資料夾（bulletin_dir）、還沒投票，卻沒有整場的 bulletin_published 里程碑：bulletin-watch 不會偵測它（bulletin_watch_targets 只看有里程碑列的選舉），「公報之前」的降級規則也開不起來。新增選舉時要在 election_milestones 補那一列（預估用 expected／statutory；公報已上架就補 done／official）'
    FROM elections e
   WHERE e.bulletin_dir IS NOT NULL
     AND e.election_date >= activity_today()
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
  UNION ALL
  SELECT 'ballot_number_anomaly', a.election_id || ' / ' || a.election_type,
         count(*) || ' 個號次單位的號次有重複或跳號（重複 ' || count(*) FILTER (WHERE a.kind = 'duplicate') || '、跳號 ' || count(*) FILTER (WHERE a.kind = 'gap') || '）：看視圖 ballot_number_anomalies；名單缺人時也會這樣，派工臂 cand_no_recheck 會請代理對公告重查'
    FROM ballot_number_anomalies a JOIN elections e ON e.id = a.election_id
   WHERE e.election_date >= activity_today()
   GROUP BY a.election_id, a.election_type
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL
  UNION ALL
  SELECT 'queue_clock_overridden', current_setting('app.queue_now', true), '派工時鐘被 app.queue_now 覆寫了：所有固定時段插隊都在用這個假時間（只該出現在測試）'
   WHERE NULLIF(current_setting('app.queue_now', true), '') IS NOT NULL
  UNION ALL
  SELECT 'system_vote_stalled', 'jev_decisions',
         '最近一筆來源核對系統票是 ' || COALESCE(to_char(s.last_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北）', '（沒有）')
           || '，之後有 ' || s.waiting || ' 筆等待中的合格貢獻沒有被判：system-one precheck 可能在失敗（看 net._http_response 的 status_code 與 failures）'
    FROM system_vote_stall() s
  UNION ALL
  SELECT 'queue_head_stale', s.head_task_id,
         '派工佇列隊頭停擺：可派的隊頭是 ' || s.head_task_id || '（' || s.head_task_type || '），但最近一次任務派出是 '
           || COALESCE(to_char(s.last_dispatch_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北）', '（從來沒有）')
           || '，已超過 ' || queue_head_stale_hours() || ' 小時：看 /next 的 log 有沒有「過濾後沒有任務」，或隊頭是不是又被某個條件釘死（10-17 事故）'
    FROM queue_head_stale() s;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 的五個日期與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）'
  '｜20261008165000：加 queue_clock_overridden——app.queue_now 假時鐘被設了（固定時段插隊用的時鐘，只該出現在測試）。'
  '｜2026-10-10：加 system_vote_stalled——來源核對系統票超過 3 小時沒有新的、之後又有等待中的合格貢獻（10-09 寫入失敗無聲停擺 16 小時的教訓）。'
  '｜2026-10-17：加 queue_head_stale——有可派的隊頭卻 6 小時沒有任何任務派出（隊頭堵塞的教訓，queue_head_stale()）。';

NOTIFY pgrst, 'reload schema';
