-- 高風險型別（參選紀錄、合併、下架）分數到了但只有一台機器投過票時，留在驗證池（agy 審查 2026-09-23）
--
-- 觸發器規定這三型要至少兩個來源 IP 才算通過；但驗證池只派「分數 < 目標」的。
-- 第一台機器一張 +2 把分數推到目標（系統票把目標降到 2 時就會發生），這筆就卡在 pending、又不再派給任何人。
-- 09-23 實查線上 0 筆卡住，但路徑是通的。改法：這種情況留在池裡，並對代理回報「目標＝目前分數 + 1」（還差一票）。

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
         contribution_effective_agree(c.id) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 分數夠了但還缺第二台機器：對代理講「還差一票」（實際門檻由觸發器判，第二個 IP 投同意就通過）
         CASE WHEN c.score >= contribution_effective_agree(c.id) AND (c.contribution_type IN ('merge_politician', 'candidacy', 'removal')
          AND (SELECT COUNT(DISTINCT v3.verifier_ip_hash) FROM contribution_votes v3
               WHERE v3.contribution_id = c.id AND v3.verdict IN ('agree', 'disagree')) < 2)
              THEN c.score + 1 ELSE contribution_effective_agree(c.id) END AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         COALESCE(d.queue_at, c.created_at) AS queue_at
  FROM contributions c
  LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || c.id
  WHERE c.status = 'pending'
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
    -- 分數未達標；或高風險型別分數到了、但看過的機器還不到兩台（agy 09-23：原本會被逐出驗證池、永遠等不到第二台）
    AND (c.score < contribution_effective_agree(c.id)
         OR (c.contribution_type IN ('merge_politician', 'candidacy', 'removal')
          AND (SELECT COUNT(DISTINCT v3.verifier_ip_hash) FROM contribution_votes v3
               WHERE v3.contribution_id = c.id AND v3.verdict IN ('agree', 'disagree')) < 2))
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
  ORDER BY COALESCE(d.queue_at, c.created_at) ASC, c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
