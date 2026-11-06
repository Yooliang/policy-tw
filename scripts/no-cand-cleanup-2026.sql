-- ============================================================
-- 2026「已登記但沒號次」一次改狀態（policy-ops#182；小良哥 2026-11-03 裁示的一次性例外，其他資料仍走交件＋驗證）
--
-- 手動執行，不是 migration、沒有排程、沒有觸發器；部署不會跑它。先跑 scripts/no-cand-cleanup-2026-preview.sql（唯讀）看條件。
-- 用法（小良哥確認後，由人執行）：
--   1. 先原樣跑一次（結尾是 ROLLBACK＝演練：條件、對象、數量全部檢查，什麼都不留）
--        npx -y supabase@2 db query --linked -f scripts/no-cand-cleanup-2026.sql
--      任何一個條件不成立就 RAISE EXCEPTION，整段退回，訊息講是哪一項。
--   2. 演練通過，把最後一行 ROLLBACK 改成 COMMIT 再跑第二次。
--   3. 要退回：scripts/no-cand-cleanup-2026-restore.sql。
--
-- 條件（全部成立才改；沒號次的 extra 就是要清的對象，不列入條件）：
--   ① cec_roster_diff() 的 missing＝0     ② dup＝0     ③ 帶號次的 extra＝0
--   ⑥ 同名待合併＝0：2026 非退選的參選紀錄裡，同選舉別、同選舉單位（region_id；沒有就退到縣市）、同姓名鍵（roster_name_key）
--      卻掛在不同人物（politicians，未被合併）的配對數；已被判定「不同人」的配對（politician_pair_resolutions.resolution＝different）不算。
--      這項是「合併完」的條件：配對裡有對象本人也照算，要先合併（不能靠這支把其中一筆改成退選就當處理完）
--   ④ 2026 帶號次人數（非退選、七種名冊涵蓋的選舉別、人物未被合併）＝cec_roster_2026 人數
--   ⑤ 對象＝2026、candidacy_status＝filed、cand_no 空、且是 diff 的 extra；它必須恰好等於「全部已登記沒號次的人」，
--     也必須等於「全部沒號次的 extra」（否則有人不在這次的狀態值範圍，要人判斷，中止）
--
-- 改成什麼（照 not_running 交件套用時的實際寫法，不自創新值）：
--   candidacy_status：filed → withdrawn（協議的 not_running 落庫就是 withdrawn；前端「退選／不參選」，選舉頁與統計排除）
--   withdrawn_after_filing：false（沒登記過）。觸發器 trg_politician_elections_withdrawn_flag 在 filed→withdrawn 時會自動寫 true（登記後退選），
--     但這批人是「中選會名單查無此人」，不是登記後退選，所以第二個 UPDATE 改回 false（該觸發器只聽 candidacy_status，不會再觸發；
--     CHECK 只要求退選才能有值）。要改成 true 就改第 ⑥ 段那一個值。
--   edit_history：每人兩列（candidacy_status、withdrawn_after_filing），agent_name＝'no-cand-cleanup-2026-11'，contribution_id 空——
--     這批不是交件，來源標記靠 agent_name；還原用快照表，不走 edit_history 的 revert（沒有 contribution_id）。
--   contribution_tasks：這批人名下 open 的「查參選狀態」手動任務（candidate_status_stale、origin＝cec_roster_extra）設 closed
--     （比照 20261103010000 收單人任務的做法；任務問的問題已經由這支回答了）。不動 contributions（待驗證交件）。
--
-- 快照（改之前）：
--   politician_elections_no_cand_snapshot_20261103  對象那幾列的整列舊值
--   contribution_tasks_no_cand_snapshot_20261103    被收掉的任務的舊 status／closed_at
--   兩張表有 RLS 沒有 policy（只有 service role 讀得到）；已存在就會在建表時失敗＝這支跑過了，不會重複執行。
-- ============================================================
BEGIN;

-- 一次算好 diff（cec_roster_diff 要掃整張名冊，只算一遍）
CREATE TEMP TABLE _nc_diff ON COMMIT DROP AS SELECT * FROM cec_roster_diff();

-- ---------- 條件檢查 ----------
DO $$
DECLARE
  v_missing BIGINT; v_dup BIGINT; v_extra_no BIGINT; v_extra_nocand BIGINT;
  v_numbered BIGINT; v_roster BIGINT;
  v_filed_nocand BIGINT; v_target BIGINT; v_filed_nocand_not_target BIGINT; v_extra_nocand_not_target BIGINT;
  v_samename BIGINT;
  v_bad TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT count(*) FILTER (WHERE kind = 'missing'),
         count(*) FILTER (WHERE kind = 'dup'),
         count(*) FILTER (WHERE kind = 'extra' AND our_cand_no IS NOT NULL),
         count(*) FILTER (WHERE kind = 'extra' AND our_cand_no IS NULL)
    INTO v_missing, v_dup, v_extra_no, v_extra_nocand
    FROM _nc_diff;

  SELECT count(*) INTO v_numbered
    FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
   WHERE pe.election_id = 2026
     AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
     AND pe.candidacy_status IS DISTINCT FROM 'withdrawn' AND pe.cand_no IS NOT NULL;
  SELECT count(*) INTO v_roster FROM cec_roster_2026;

  SELECT count(*) INTO v_samename
    FROM (SELECT pe.politician_id AS pid, pe.election_type, roster_name_key(p.name) AS nkey,
                 COALESCE(pe.region_id::TEXT, 'c:' || COALESCE(rg.region, p.region, '?')) AS unit
            FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
            LEFT JOIN regions rg ON rg.id = pe.region_id
           WHERE pe.election_id = 2026 AND pe.candidacy_status IS DISTINCT FROM 'withdrawn') a
    JOIN (SELECT pe.politician_id AS pid, pe.election_type, roster_name_key(p.name) AS nkey,
                 COALESCE(pe.region_id::TEXT, 'c:' || COALESCE(rg.region, p.region, '?')) AS unit
            FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
            LEFT JOIN regions rg ON rg.id = pe.region_id
           WHERE pe.election_id = 2026 AND pe.candidacy_status IS DISTINCT FROM 'withdrawn') b
      ON a.nkey = b.nkey AND a.election_type = b.election_type AND a.unit = b.unit AND a.pid < b.pid
   WHERE NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x
                      WHERE x.pair_key = politician_pair_key(a.pid, b.pid) AND x.resolution = 'different');

  IF v_missing <> 0 THEN v_bad := v_bad || format('missing=%s（要 0）', v_missing); END IF;
  IF v_dup <> 0 THEN v_bad := v_bad || format('dup=%s（要 0）', v_dup); END IF;
  IF v_extra_no <> 0 THEN v_bad := v_bad || format('帶號次的 extra=%s（要 0）', v_extra_no); END IF;
  IF v_samename <> 0 THEN v_bad := v_bad || format('同名待合併=%s 對（要 0；同選舉別、同單位、同姓名鍵卻是不同人物）', v_samename); END IF;
  IF v_numbered <> v_roster THEN v_bad := v_bad || format('帶號次人數=%s、中選會名單=%s（要相等）', v_numbered, v_roster); END IF;

  -- 對象
  CREATE TEMP TABLE _nc_target ON COMMIT DROP AS
    SELECT pe.id FROM politician_elections pe
     WHERE pe.election_id = 2026 AND pe.candidacy_status = 'filed' AND pe.cand_no IS NULL
       AND EXISTS (SELECT 1 FROM _nc_diff d WHERE d.kind = 'extra' AND d.pe_id = pe.id);
  SELECT count(*) INTO v_target FROM _nc_target;
  SELECT count(*) INTO v_filed_nocand FROM politician_elections WHERE election_id = 2026 AND candidacy_status = 'filed' AND cand_no IS NULL;
  SELECT count(*) INTO v_filed_nocand_not_target FROM politician_elections pe
   WHERE pe.election_id = 2026 AND pe.candidacy_status = 'filed' AND pe.cand_no IS NULL AND pe.id NOT IN (SELECT id FROM _nc_target);
  SELECT count(*) INTO v_extra_nocand_not_target FROM _nc_diff d
   WHERE d.kind = 'extra' AND d.our_cand_no IS NULL AND d.pe_id NOT IN (SELECT id FROM _nc_target);
  IF v_filed_nocand_not_target <> 0 THEN
    v_bad := v_bad || format('已登記沒號次共 %s 位，其中 %s 位不是 extra（要先補號次或查清楚）', v_filed_nocand, v_filed_nocand_not_target);
  END IF;
  IF v_extra_nocand_not_target <> 0 THEN
    v_bad := v_bad || format('沒號次的 extra 有 %s 位狀態不是 filed（不在這次的狀態值範圍，要人判斷）', v_extra_nocand_not_target);
  END IF;
  IF v_target = 0 THEN v_bad := v_bad || '對象是 0 位（沒有東西要改）'; END IF;

  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION '條件不成立，中止（整段退回）：%', array_to_string(v_bad, '；');
  END IF;
  RAISE NOTICE 'ok 條件全部成立：missing=0 dup=0 帶號次 extra=0 帶號次人數=名單人數=% 對象=% 位', v_roster, v_target;
END;
$$;

-- ---------- 快照 ----------
CREATE TABLE politician_elections_no_cand_snapshot_20261103 AS
  SELECT pe.*, now() AS snapshot_at FROM politician_elections pe WHERE pe.id IN (SELECT id FROM _nc_target);
ALTER TABLE politician_elections_no_cand_snapshot_20261103 ADD PRIMARY KEY (id);
ALTER TABLE politician_elections_no_cand_snapshot_20261103 ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE politician_elections_no_cand_snapshot_20261103 IS
  'policy-ops#182：2026 已登記沒號次、一次改成 withdrawn 之前的整列舊值。還原見 scripts/no-cand-cleanup-2026-restore.sql。確定不需要就 DROP';

CREATE TABLE contribution_tasks_no_cand_snapshot_20261103 AS
  SELECT t.id, t.status, t.closed_at, t.task_type, t.target->>'politician_election_id' AS politician_election_id, now() AS snapshot_at
    FROM contribution_tasks t
   WHERE t.task_type = 'candidate_status_stale' AND t.source = 'manual' AND t.status = 'open'
     AND t.target->>'origin' = 'cec_roster_extra'
     AND t.target->>'politician_election_id' IN (SELECT id::TEXT FROM _nc_target);
ALTER TABLE contribution_tasks_no_cand_snapshot_20261103 ADD PRIMARY KEY (id);
ALTER TABLE contribution_tasks_no_cand_snapshot_20261103 ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE contribution_tasks_no_cand_snapshot_20261103 IS
  'policy-ops#182：被收掉的「查參選狀態」手動任務的舊 status／closed_at。還原見 scripts/no-cand-cleanup-2026-restore.sql';

-- ---------- 改狀態 ----------
DO $$
DECLARE v_n BIGINT; v_target BIGINT;
BEGIN
  SELECT count(*) INTO v_target FROM _nc_target;

  -- ⑥-1 狀態：filed → withdrawn（觸發器會順手把 withdrawn_after_filing 寫成 true）
  UPDATE politician_elections SET candidacy_status = 'withdrawn'
   WHERE id IN (SELECT id FROM _nc_target) AND candidacy_status = 'filed' AND cand_no IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_target THEN RAISE EXCEPTION '改狀態筆數對不上：應 %、實際 %', v_target, v_n; END IF;

  -- ⑥-2 退選前有沒有登記：false＝沒登記過（名單查無此人）。不寫 candidacy_status，所以退選旗標觸發器不會再蓋掉
  UPDATE politician_elections SET withdrawn_after_filing = false
   WHERE id IN (SELECT id FROM _nc_target) AND candidacy_status = 'withdrawn';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_target THEN RAISE EXCEPTION '寫退選旗標筆數對不上：應 %、實際 %', v_target, v_n; END IF;

  -- 異動紀錄（舊值照改之前的樣子：candidacy_status＝filed、withdrawn_after_filing＝空）
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  SELECT 'politician_elections', s.id::TEXT, 'candidacy_status', to_jsonb(s.candidacy_status), to_jsonb('withdrawn'::TEXT), 'no-cand-cleanup-2026-11'
    FROM politician_elections_no_cand_snapshot_20261103 s
  UNION ALL
  SELECT 'politician_elections', s.id::TEXT, 'withdrawn_after_filing', to_jsonb(s.withdrawn_after_filing), to_jsonb(false), 'no-cand-cleanup-2026-11'
    FROM politician_elections_no_cand_snapshot_20261103 s;

  -- 收掉這批人名下 open 的「查參選狀態」手動任務
  UPDATE contribution_tasks SET status = 'closed', closed_at = now()
   WHERE id IN (SELECT id FROM contribution_tasks_no_cand_snapshot_20261103);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'ok 改了 % 位；收掉 % 張查參選狀態任務', v_target, v_n;
END;
$$;

-- ---------- 改完再對一次 ----------
DO $$
DECLARE v_left BIGINT; v_missing BIGINT; v_dup BIGINT; v_extra BIGINT;
BEGIN
  SELECT count(*) INTO v_left FROM politician_elections WHERE election_id = 2026 AND candidacy_status = 'filed' AND cand_no IS NULL;
  SELECT count(*) FILTER (WHERE kind = 'missing'), count(*) FILTER (WHERE kind = 'dup'), count(*) FILTER (WHERE kind = 'extra')
    INTO v_missing, v_dup, v_extra FROM cec_roster_diff();
  IF v_left <> 0 OR v_missing <> 0 OR v_dup <> 0 OR v_extra <> 0 THEN
    RAISE EXCEPTION '改完對帳沒歸零，整段退回：已登記沒號次=% missing=% dup=% extra=%', v_left, v_missing, v_dup, v_extra;
  END IF;
  RAISE NOTICE 'ok 改完對帳：已登記沒號次=0 missing=0 dup=0 extra=0';
END;
$$;

ROLLBACK; -- 演練。通過後改成 COMMIT 再跑第二次
