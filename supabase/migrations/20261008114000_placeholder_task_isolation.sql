-- 測試資料人物的任務只走 placeholder_politician，不再從別的臂派出去；placeholder_politician 排前段（2026-10-08）
-- ============================================================
--
-- 起因（正式庫 2026-10-08 唯讀盤點）：2024 台東縣立委的「測試候選人ABC／XYZ／QQQ」（人物＋參選紀錄 34401～34403，2026-01 早期匯入殘留）
-- 資料庫觸發器 politician_name_is_placeholder 本來就認得這三個名字，placeholder_politicians 臂也抓到了——**ABC、XYZ 各有一件 placeholder_politician 任務，
-- 自 2026-09-24 起排在佇列第 733、736 位，dispatch_count＝0，從來沒被領走**（QQQ 沒有，因為已經有人交了 removal 在等票，臂的設計就是這樣）。
-- 同一時間，**別的臂把這三個人當真候選人派出去**：election_result_missing 三件（auto:election_result_missing:34401～34403），10-07 被領走了三次，
-- 代理查完交 no_change(not_found) 兩筆、removal 一筆（QQQ）——花了真代理的工，也冒著有人把一個真落選人的結果硬配給測試資料的風險。
-- 所以洞不在「認不認得」，在兩處：
--   1. 抓到之後沒有排前面：placeholder_politician 任務在預設層（中段），前面排了好幾百件；
--   2. 測試人物的其他任務沒有被擋：每一支臂各自寫條件，沒有一支知道「這個人是測試資料」。
--
-- 做了什麼（只改派工，不動任何一筆正式資料；測試資料本身照主線裁定走 removal 貢獻＋投票移除，不直接刪）：
--   1. contribution_auto_tasks_arms()：在總表統一擋——target 裡任何地方出現測試名人物（politician_name_is_placeholder）的 id 的任務，
--      除了臂 placeholder_politicians 本身，一律不出現。擋在總表而不是改 28 支臂：一處、同簽名、不碰各臂本體（其他 PR 正在改 raw 等臂）。
--      「任何地方」：各臂把人物放在不同的鍵（politician_id、dup 的 a／b、handover 的 from_／to_politician_id、lineage_roles 的 people 陣列……），
--      所以不挑鍵，比對整份 target 的文字有沒有含測試人物的 uuid（uuid 夠長，不會誤中別的字）。election_results 批次任務放的是參選紀錄 id
--      （target.politician_election_ids 陣列，另有單一 politician_election_id），不是人物 id，所以另外比測試人物的參選紀錄 id（用 jsonb 包含比對，不做文字子字串）。
--      副作用：整批任務裡只要有一位是測試人物，整批先不派（同批的真人要等測試資料移除才回來）；dup 任務的另一方是真人時也一樣。測試人物很少，且 removal 通過就解除。
--      測試名人物一旦被移除（或改成正常名字），他的其他任務自然回來／消失，不用另外收回——seed 本來就會收回「缺口不存在了」的派工列。
--      代價：總表多算一次「測試名人物」集合並對每一列的 target 文字比對。**兩個 CTE 必須 MATERIALIZED**：比對是 strpos（不是等號），不會變成雜湊比對，
--      沒有 MATERIALIZED 時每一列都重掃一遍 politicians 的姓名正則，正式庫 EXPLAIN ANALYZE 直接撞 statement timeout；加了之後同樣的過濾對 7,913 列的 task_dispatches 177 毫秒（總表約 4 秒，約 4%）。
--   2. 優先層規則（#443）：活動 priority:placeholder_politicians 永遠在前段（層 1）。任務很少（現在 2 件）、做完資料就乾淨，沒理由等 700 件；
--      前段不是插隊（queue_at 不動），只是進加權交錯的前段。想改回預設層就刪這一條規則（它是 activity_rules 的一列，走 migration）。
--      **已知限制**：activity_priority() 同時有多條規則相符時取「號碼最大（最後面）」的那一條。這條規則是 always、不掛選舉，
--      而 placeholder_politicians 臂目前的 target 沒有 election_id（人物層級），所以選舉通則（priority:*，前段／後段）對它不成立、只有這一條相符。
--      日後若測試人物任務的 target 帶上 election_id，選舉通則會跟著相符（例如投票日後 181 天起的「後段」層 3），號碼最大的取到通則的層，
--      這條規則就被蓋掉、任務掉回後段。要處理得改 activity_priority()（例如允許規則「釘住」層）或讓臂不帶 election_id；這次不改 activity_priority()。
--
-- 不做：
--   * 不改 politician_name_is_placeholder 的規則：ABC／XYZ／QQQ 都含「測試」，三個都認得；10-06 量過線上人物 16,233 位只命中這三位。
--   * 不改 placeholder_politicians 臂：它已經對（merged_into 空、沒有等票中的 removal 才派）。
--   * 不碰 8 筆標題「TEST」的政見：2026-09-16 已經軟刪除（removed_at 有值、removed_reason 寫明測試資料），不出現在網站也不產生任務；要不要硬刪由維護者決定（見 PR 說明）。
--
-- 守門：supabase/functions/_shared/placeholder-isolation.test.ts（總表＝P1 定義＋一處機械替換；PGlite 回放分支輸出，改前改後逐件比、差集剛好是測試人物的非 placeholder 任務；
--   優先層解析；每條守門都有還原驗證）；scripts/arms-parity-placeholder.ts（正式庫唯讀快照，不進 CI）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：politicians(id, name)、函式 politician_name_is_placeholder(text)（20261006140000）、
-- contribution_auto_tasks_arms() 現行版＝P1（20261008060000）、activity_rules.priority 欄位與 task_priority_tiers（#443，20261008090000；層 1＝前段）、activity_priority()。
-- 總表回傳型別不變（9 欄），所以 CREATE OR REPLACE 即可，不用 DROP、也不用分兩次上。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       tagged AS (
  SELECT 'raw:' || r.task_type AS arm, r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END AS what_we_need,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE activity_require_rule(x.arm) OFFSET 0) k  -- 每組（約 84 組）檢查一次；OFFSET 0 擋住檢查被推到 7 千多列上去
    CROSS JOIN LATERAL (
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on)) AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
   WHERE g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT))
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '全站自動缺口總表：28 個分支 UNION，每個分支貼臂名（arm），再依 activity_rules／activity_overrides 過濾（沒有開窗的規則＝濾掉；P1 規則都是永遠開，輸出與前一版逐件相同）。'
  'opened_by＝開窗的規則＋里程碑（seed 寫進 task_dispatches.opened_by）。seed_auto_task_queue() 每 10 分鐘算一次（約 1.5 秒）。2026-10-08｜'
  '2026-10-08：target 裡任何地方出現測試名人物（politician_name_is_placeholder）的 id（整份 target 文字含人物 uuid，或 politician_election_ids／politician_election_id 含他的參選紀錄 id）的任務，只留臂 placeholder_politicians 的，其他臂的一律不出現——測試資料只走 removal 流程，不再被當真候選人派工';

-- ------------------------------------------------------------
-- 優先層（#443）：placeholder_politician 永遠在前段
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, priority, note)
SELECT 'priority:placeholder_politicians', 'always', 1,
       '前段：測試資料人物的移除任務很少（2026-10-08 只有 2 件）、做完資料就乾淨，不必排在幾百件之後（ABC／XYZ 的任務自 09-24 排了兩週沒被領走）。永遠開、不指名選舉；想改回預設層就刪這一列'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'priority:placeholder_politicians');

NOTIFY pgrst, 'reload schema';
