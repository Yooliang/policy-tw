-- 驗證池在 SQL 端排除同代號（policy-ops#70，#568 審查時發現）。
--
-- 背景：驗證池 contribution_verify_pool 只排除同網段（p_ip_hash／p_legacy_ip_hash）自己交的；「同代號」是 /next 拿到前 CANDIDATE_POOL 筆之後
-- 才在 TS（filterVerifyCandidates、excludeOwnAdjudications）濾掉。#568 之後前段會留著一批網站請求驗證，若集中在同一個代號，
-- 同代號但不同網段的機器（輪換出口 IP 的代理）前 30 筆全被 TS 濾光，/next 看不到驗證。這跟 #102–#105、#122 同一個反模式：合格判斷要在 SQL、LIMIT 之前。
--
-- 做法：現行定義（20261009060000）多一個有預設值的尾端參數 p_agent_name，兩處多比一個條件，其餘一字不動：
--   1. 貢獻本身的 agent_name（大小寫不分，同 TS 的 toLowerCase）
--   2. 裁決的原貢獻的 agent_name（同 excludeOwnAdjudications）
-- 沒傳（NULL）＝行為與現行完全相同，舊版 /next、/verifications 在部署空檔照常運作。
-- 簽名多一個參數，五參數版本先 DROP（同 20261009060000：留著會讓只傳前幾個參數的 rpc 同時符合兩個版本，PGRST203）。
-- TS 那兩道濾網留著當第二道。日本站的複本停在更早的版本（policy-jp-dispatch-drift 的 before 登記），這支不影響它。

DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT, TEXT);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL
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
                   AND contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
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
    -- 過渡期（#484）：切換前自己交的（存單一 IP 的舊雜湊）也不派給自己
    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)
    -- 同代號自己交的也不派給自己（policy-ops#70）：以前只有 TS 在 LIMIT 之後才濾，前段集中同代號時別的網段的同代號機器會拿不到
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash)
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)
            OR (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND (v2.verifier_ip_hash = p_ip_hash OR v2.verifier_ip_hash = p_legacy_ip_hash)
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。'
  '2026-10-02。2026-10-06（#349）兩台機器的型別改看 contribution_needs_two_ips（多了「中止」交接）。'
  '2026-10-09（#484）多 p_legacy_ip_hash：自交與投過票的排除（含裁決的原貢獻）新舊雜湊一起比；NULL＝與先前相同。'
  '2026-10-10（policy-ops#70）多 p_agent_name：同代號（含裁決原貢獻的代號）在 SQL、LIMIT 之前排除；NULL＝與先前相同。';
