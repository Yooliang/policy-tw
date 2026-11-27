-- issue_too_broad 的資料變動整臂事件 '*' 30 分鐘去抖（2026-11-27）
--
-- 為什麼（正式庫實測，2026-11-27）：
--   · seed 的 stage:gap_drain 裡 gap_drain:issue_too_broad 平均 36.7 秒、最高 72 秒，每輪只有 1 筆 '*' 事件（kind='insert'）。
--   · 近 24 小時 policies 異動 2026 Campaign Pledge 2,926 筆（＝臂的條件，95%），issue_too_broad 收到 109 筆 '*'，
--     但 dispatch_gaps 該臂只開 89／關 2、開著 87 列：每小時約 6 次整臂重算，絕大多數輪次結果不變。
--   · 整表函式單獨跑 7.35 秒（EXPLAIN ANALYZE）：87 個縣市×議題各自掃一次 46k 列的物化 CTE sc（見檔尾「計畫觀察」）。
--
-- 讀碼結論（沒有路由問題）：dispatch_gap_load_fresh／apply_fresh 對 '*' 與 NULL 走同一條整臂路徑（v_whole），
--   issue_too_broad 的按鍵版在有 '*' 時根本不會被呼叫，所以慢點不是 '*' 專屬路徑，而是「整臂重算太頻繁」。
--
-- 改了什麼：只改 dispatch_gap_enqueue（所有觸發器的入列出口），其餘本文逐字同 20261126170000：
--   p_arm＝'issue_too_broad'、p_key＝'*'、p_kind 是資料變動（insert／update／delete）時，
--   若該臂近 30 分鐘內已有 '*' 事件（未處理，或 processed_at 在 30 分鐘內）就不入列。
--   不去抖：其他臂、其他鍵、kind 為 config／manual／date_flip 等（規則與設定變動要立刻反映）。
--   新增部分索引 dispatch_gap_events_star_idx 讓這個存在性檢查不掃整張事件表。
--
-- 行為變更（請看這段）：
--   · 該臂的缺口更新可能晚到。上限：被擋掉的那次變動，會在「30 分鐘去抖窗結束後的下一筆 '*'」或
--     每小時 :42 的 live 臂對帳（dispatch_gap_reconcile_arm hourly apply）補上，所以最壞約 1 小時
--     （30 分鐘內沒有後續資料變動時取決於對帳）；一般有新政見持續進來時約 30 分鐘。
--   · 效果：該臂每小時整臂重算 6 次→最多 2 次。
--
-- 計畫觀察（整表函式 7.35 秒，這支不改，建議另案）：
--   contribution_auto_tasks_issue_too_broad()（20261102010000）的 sc 是 MATERIALIZED CTE（issues_scoped 逐縣市展開，約 46k 列）。
--   輸出的每一個縣市×議題（87 個）在 target.policies 的相關子查詢裡都「整份掃 sc 一次」再用
--   WHERE s.county = g.county AND s.issue = g.issue 過濾（計畫 SubPlan 4：CTE Scan on sc，Rows Removed by Filter 45,618，
--   loops=87，Nested Loop 估 1,360 列實際 45,994 列、5.66 秒，並因 DISTINCT ON／ORDER BY 落盤 temp read 76,821）。
--   建議：先把 sc 依 (county, issue) 預先分組（grp 階段用 array_agg／jsonb_agg 一次聚合出每組前 200 筆），
--   或讓 sc 建索引式的 hash 分組後只取該組，不要逐組全掃；或改 C 案縣市級鍵，讓一次事件只重算一個縣市。
--
-- 回滾：重貼 20261126170000_dispatch_gaps_phase0.sql 裡的 dispatch_gap_enqueue 定義（此函式後來沒有別的 migration 改過），
--   索引可留可刪：DROP INDEX IF EXISTS dispatch_gap_events_star_idx;
--
-- 成本影響：gap_drain:issue_too_broad 每小時 6 次×37～72 秒→最多 2 次。每日呼叫量變化：0（沒有新增排程、輪詢、觸發器或對外呼叫）。

CREATE INDEX IF NOT EXISTS dispatch_gap_events_star_idx
  ON dispatch_gap_events (arm, processed_at DESC) WHERE scope_key = '*';

CREATE OR REPLACE FUNCTION dispatch_gap_enqueue(p_arm TEXT, p_key TEXT, p_kind TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN false;
  END IF;
  -- >>> 整臂事件去抖（20261127140000）：issue_too_broad 的資料變動 '*'，30 分鐘內已有一筆（未處理或剛處理完）就不再入列
  IF p_arm = 'issue_too_broad' AND p_key = '*' AND p_kind IN ('insert', 'update', 'delete')
     AND EXISTS (SELECT 1 FROM dispatch_gap_events e
                  WHERE e.arm = p_arm AND e.scope_key = '*'
                    AND (e.processed_at IS NULL OR e.processed_at > now() - INTERVAL '30 minutes')) THEN
    RETURN false;
  END IF;
  -- <<< 整臂事件去抖
  INSERT INTO dispatch_gap_events (arm, scope_key, kind)
  VALUES (p_arm, p_key, p_kind)
  ON CONFLICT (arm, scope_key) WHERE processed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
