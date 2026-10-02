-- 驗證池改從快照驅動、目標分數由排程算好（2026-10-02）
--
-- 量出來的：/next 約 3.8 秒裡，11 個平行查詢共 2.3 秒，而其中 2.3 秒全部是驗證池（contribution_verify_pool）一支；
-- 其餘 9 支都只有約 230 毫秒（一次網路來回）。
-- 驗證池每次被呼叫都對全部待驗證貢獻（約 2,931 筆）逐筆算目標分數再排序取 30 筆。目標分數欄位是計票時才寫，
-- 「還沒計過票的（NULL）才現算」—— 而今天新進的幾百筆提交都還沒人投票，全是 NULL，每筆都要現算 contribution_effective_agree()，
-- 一筆最多三次。待驗證越多、每個人領任務就越慢。這跟自動缺口今天的問題是同一個模式。
--
-- 照維護者的佇列設計：算好放進快照，領的時候只拿隊頭。
-- ① task_dispatches.verify_target：排程每 10 分鐘為「目標分數還是 NULL」的待驗證貢獻算好。
-- ② contribution_verify_pool 從 task_dispatches 照 queue_at 走索引、逐筆主鍵找貢獻、到 p_limit 就停。
--    目標分數取 COALESCE(c.target_score, d.verify_target, 現算)：計過票就用欄位，排程算過就用快照，
--    兩者都沒有（剛進來還不到 10 分鐘）才現算 —— 只有走到的那幾筆會發生。
--    其餘條件（仍是 pending、分數未達標、不是自己交的、沒投過、剛派過、裁決的迴避）全部照舊即時比對。
--    同簽名、同回傳欄位。排序鍵從 COALESCE(d.queue_at, c.created_at) 改成 d.queue_at（每筆都一定有列）。

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS verify_target INTEGER;
COMMENT ON COLUMN task_dispatches.verify_target IS
  '待驗證貢獻的目標分數（verify: 列才有）。排程為 contributions.target_score 還是 NULL 的那些算好，驗證池就不必逐筆現算。';

CREATE OR REPLACE FUNCTION refresh_verify_targets() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE task_dispatches d
     SET verify_target = contribution_effective_agree(c.id)
    FROM contributions c
   WHERE d.task_id LIKE 'verify:%'
     AND c.id = substring(d.task_id FROM 8)::uuid
     AND c.status = 'pending'
     AND c.target_score IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_verify_targets IS
  '為目標分數還沒寫進貢獻的待驗證列算好 verify_target。seed_auto_task_queue 每 10 分鐘呼叫。';

-- 排程裡加一行（其餘照抄 20261002000006）
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

  -- 已經不存在的缺口（補上了）：收回號碼牌
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now()
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

CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
                   AND c.contribution_type IN ('merge_politician', 'candidacy', 'removal') AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) END AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (c.contribution_type IN ('merge_politician', 'candidacy', 'removal') AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            o.contributor_ip_hash = p_ip_hash
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND v2.verifier_ip_hash = p_ip_hash
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。2026-10-02。';

-- 套上就先算一次，不用等下一輪排程
SELECT refresh_verify_targets();
