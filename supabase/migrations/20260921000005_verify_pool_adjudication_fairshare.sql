-- 驗證池餓死：把裁決的合格判斷下推進 SQL，並限制裁決在窗口的佔比（2026-09-21，修 #119 的回歸）。
--
-- #119 把 ORDER BY 改成「訪客觸發 > 裁決 > 其餘最早」之後，pending 裁決有 86 筆，
-- p_limit=30 的窗口被塞成 28 筆裁決 + 2 筆其他。而 next/index.ts 在 **LIMIT 之後** 才用 TS
-- 篩掉「原貢獻是我交的／我對原貢獻投過票」的裁決（excludeOwnAdjudications），
-- 同一台機器投過很多原貢獻，那 28 筆幾乎全被丟掉 → candidates 趨近 0 →
-- total_pending=0 → /next 只派任務，3:1 輪替消失，1,422 筆 pending 沒人驗。
--
-- 這正是 #102–#105 裁過的反模式：合格判斷要在 SQL、LIMIT 之前。修裁決線時又犯了一次。
--
-- 兩個修法一起下：
--   1. 不合格的裁決在 LIMIT 之前就排掉，窗口裡的每一筆都是真的派得出去的
--   2. 裁決最多佔窗口的三分之一——只靠 (1) 仍可能被 86 筆合格裁決塞滿，
--      裁決該排第二順位，不該獨占。訪客觸發的不設限，那是頁面上等著的，而且量很少。
--
-- TS 鏡像：next/index.ts serveVerify。excludeOwnAdjudications 留著當第二道（它多比對 agent_name），
-- 但正常情況下它已經沒東西可篩。

DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN
)
LANGUAGE sql STABLE AS $$
  WITH eligible AS (
    SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
           c.agent_name, c.contributor_ip_hash, c.status,
           c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
           contribution_effective_agree(c.id) AS effective_required,
           -- 訪客看得到的：提問的回答、網站按鈕觸發的任務（web_request）交的東西
           (c.contribution_type = 'question_answer'
            OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
           (c.contribution_type = 'adjudication') AS adjudication_facing
    FROM contributions c
    WHERE c.status = 'pending'
      AND (p_region IS NULL OR c.payload->>'region' = p_region)
      AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
      AND NOT EXISTS (
        SELECT 1 FROM contribution_votes v
        WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
      )
      -- 已經湊夠「有效」門檻的不用再驗（系統票折進去了）
      AND c.agree_count < contribution_effective_agree(c.id)
      -- 裁決不派給跟原貢獻有關係的人：原貢獻是這個 IP 交的、或這個 IP 對原貢獻投過票。
      -- 投過票的人再去裁決同一件爭議，不是第三方裁決（skill.md §裁決任務）。
      -- 這一段以前在 TS、在 LIMIT 之後，是 #119 餓死驗證池的原因。
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
  ),
  bucketed AS (
    SELECT e.*,
           CASE WHEN e.visitor_facing THEN 0 WHEN e.adjudication_facing THEN 1 ELSE 2 END AS bucket
    FROM eligible e
  ),
  ranked AS (
    SELECT b.*, row_number() OVER (PARTITION BY b.bucket ORDER BY b.created_at ASC) AS rn
    FROM bucketed b
  )
  SELECT r.id, r.contribution_type, r.payload, r.source_urls, r.note, r.task_id,
         r.agent_name, r.contributor_ip_hash, r.status,
         r.agree_count, r.disagree_count, r.unsure_count, r.created_at,
         r.effective_required, r.visitor_facing, r.adjudication_facing
  FROM ranked r
  -- 裁決最多佔三分之一；訪客觸發與其他型別不設限
  WHERE r.bucket <> 1 OR r.rn <= GREATEST(1, COALESCE(p_limit, 30) / 3)
  ORDER BY r.bucket ASC, r.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '/next 的驗證候選池：同 IP 提交／投過的、已達有效門檻的、跟原貢獻有關係的裁決，都在 LIMIT 之前排掉；訪客觸發的先、裁決次之（最多佔窗口三分之一，免得排擠其他型別）、其餘最早的 N 筆。';
