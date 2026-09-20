-- 驗證池：裁決排第二順位（小良哥 2026-09-21 裁）。
-- 裁決線是死的：75 件 adjudicate 任務開著、87 份裁決等票平均 0.1 票、歷來只定案 4 份。
-- 原因是裁決的驗證跟一般貢獻擠同一條隊伍、又按提交時間先舊後新，前面排著上千筆機器缺口，
-- 裁決進去就出不來，原貢獻跟著永遠卡在 disputed。
-- 訪客觸發的（提問回答、web_request）仍然最優先——那是頁面上寫著「AI 代理正在查證」的那些；
-- 裁決插在它後面，其餘照舊按提交時間。TS 鏡像：next/index.ts serveVerify。

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
    -- 已經湊夠「有效」門檻的不用再驗（系統票折進去了；之前用原門檻會把 not_supported 的那筆永久卡住）
    AND c.agree_count < contribution_effective_agree(c.id)
  -- 訪客觸發的先驗：提問的回答排在千筆機器缺口後面，訪客就永遠看到「AI 正在查證」（2026-09-20 那題 Facebook 提問）
  -- 裁決第二：爭議件不解，原貢獻永遠停在 disputed（2026-09-21）
  ORDER BY (c.contribution_type = 'question_answer'
            OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) DESC,
           (c.contribution_type = 'adjudication') DESC,
           c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '/next 的驗證候選池：同 IP 提交／投過的、已達有效門檻的都在 LIMIT 之前排掉；訪客觸發的（提問回答、web_request 任務）先、裁決次之，其餘最早的 N 筆；effective_required 是這筆現在要幾張同意票。';
