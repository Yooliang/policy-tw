-- 系統票無聲停擺的資料面告警（2026-10-10；起因：10-09 05:13 UTC 起 jev_decisions 寫入全部失敗約 16 小時，cron 照跑回 200 沒人發現，#551 修了原因）
--
-- activity_health 加一條 system_vote_stalled（判斷在函式 system_vote_stall，門檻 system_vote_stall_hours）：最近一筆「來源核對系統票」（jev_decisions，subject_type contribution、question source_support）
-- 超過 3 小時，而且那之後還有新的、等待中的、有系統票資格的貢獻（建立超過 1 小時，precheck 每 10 分鐘一輪早該輪到）→ 一列。
-- 沒有新貢獻就不報（沒東西可判不是停擺）。同一支 PR 另外讓 system-one 在「一輪全部失敗」時回 500（_shared/batch-status.ts）。
-- 視圖其餘內容照 20261008165000 原樣，只在最後加一個 UNION 分支；另加一個部分索引讓 max(asked_at) 不用掃全表。

CREATE INDEX IF NOT EXISTS jev_decisions_source_support_asked_idx
  ON jev_decisions (asked_at DESC) WHERE subject_type = 'contribution' AND question = 'source_support';

-- 停擺門檻（小時）：precheck 每 10 分鐘一輪、一輪最多 60 筆，正常時新貢獻 1 小時內就有系統票；
-- 3 小時＝至少 18 輪都沒寫進任何一筆，不會是偶發的抓不到網頁（那只會讓個別幾筆棄權，不會整段空白）。
-- 改門檻＝新 migration 改這支函式（跟其他營運常數同一個慣例）。
CREATE OR REPLACE FUNCTION system_vote_stall_hours() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

-- 停擺判斷（activity_health 的 system_vote_stalled 讀它；測試單獨打它）：
-- 最近一筆來源核對系統票早於門檻，而且那之後有新的、等待中的、有系統票資格、建立超過 1 小時的貢獻 → 回一列；正常＝沒有列
CREATE OR REPLACE FUNCTION system_vote_stall() RETURNS TABLE (last_at TIMESTAMPTZ, waiting BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT j.last_at, w.n
    FROM (SELECT max(asked_at) AS last_at FROM jev_decisions WHERE subject_type = 'contribution' AND question = 'source_support') j
    CROSS JOIN LATERAL (
      SELECT count(*) AS n FROM contributions c
       WHERE c.status = 'pending' AND system_vote_eligible(c.contribution_type)
         AND c.created_at > COALESCE(j.last_at, '-infinity'::timestamptz) AND c.created_at < now() - interval '1 hour'
    ) w
   WHERE COALESCE(j.last_at, '-infinity'::timestamptz) < now() - make_interval(hours => system_vote_stall_hours())
     AND w.n > 0
$$;
COMMENT ON FUNCTION system_vote_stall IS
  '來源核對系統票停擺：最近一筆早於 system_vote_stall_hours()，而且之後有等待中的合格貢獻（建立超過 1 小時）→ 一列；activity_health 的 system_vote_stalled（2026-10-10）';

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
    FROM system_vote_stall() s;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 的五個日期與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）'
  '｜20261008165000：加 queue_clock_overridden——app.queue_now 假時鐘被設了（固定時段插隊用的時鐘，只該出現在測試）。'
  '｜2026-10-10：加 system_vote_stalled——來源核對系統票超過 3 小時沒有新的、之後又有等待中的合格貢獻（10-09 寫入失敗無聲停擺 16 小時的教訓）。';
