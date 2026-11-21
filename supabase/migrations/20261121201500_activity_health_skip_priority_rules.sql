-- 活動健康檢查：activity_all_rules_disabled 略過已退役的 priority:* 規則（#1026 後誤報）
--
-- #1026（20261121193000_priority_bands）把 activity_rules 的 priority:*（#37、#38）與 priority:raw:policy_missing（#39）
-- 設成 enabled=false：新制改由 task_band_priority_seconds 算，規則表的 priority:* 系列整個退役。
-- 結果 activity_health 多了兩列 activity_all_rules_disabled（priority:* 與 priority:raw:policy_missing），
-- 但「全部停用」對派工臂是真問題、對 priority: 開頭的規則卻是預期，巡檢因此天天誤報。
--
-- 只改一個條件：activity_all_rules_disabled 分支加 WHERE r.activity NOT LIKE 'priority:%'；其餘分支逐字沿用 20261019040000 的現行定義。
-- 回滾：重貼 20261019040000_rekey_keeps_queue_position.sql 第 5 節的 CREATE OR REPLACE VIEW activity_health。

CREATE OR REPLACE VIEW activity_health AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM activity_rules r WHERE r.activity NOT LIKE 'priority:%' GROUP BY r.activity HAVING NOT bool_or(r.enabled)
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
    FROM queue_head_stale() s
  UNION ALL
  SELECT 'dispatch_chronic_stall', s.arm,
         '派工類型「' || s.arm || '」近 ' || s.window_days || ' 天有 ' || s.closed_rows || ' 列因缺口內容變了被換掉，列的壽命（整串換號合計）中位數只有 ' || s.median_life_hours
           || ' 小時，短於目前的佇列延遲 ' || s.queue_delay_hours || ' 小時，而且這段期間沒有任何交件：還沒輪到就被換掉，幾乎永遠派不出去。看 gap_events 的 closed 事件與派工列 opened_by 的 rekey_of'
    FROM dispatch_chronic_stall() s;

NOTIFY pgrst, 'reload schema';
