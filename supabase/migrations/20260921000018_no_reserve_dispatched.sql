-- 剛派出去的不要重派給同一台機器（2026-09-21，跑任務的伙伴實測回報）。
--
-- 現場：代理做完整套查證（Newtalk 逐字比對、chinatimes 被 Cloudflare 403、
-- wayback 無存檔、改用自由時報交叉驗證），**回報時才吃到 409 already_voted**。
-- 池子本來就排除「這個 IP 投過的」，所以是併發——同一台機器上同時有好幾個代理在跑，
-- /next 派給 A，B 在 A 回報前投掉了同一筆。
--
-- 代價是一整套查證白做。今天這種「工做完才被擋」的形狀已經第三次
-- （前兩次是 source_urls 缺信封、kind 猜成 no_change）。
--
-- 為什麼擋「同 IP」而不是「同代號」：投票本來就以來源 IP 去重，同一台機器的
-- 多個代號合起來只有一票，所以它們互相搶同一筆本來就沒有意義。

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
      AND (p_type IS NULL OR c.contribution_type = p_type)
      AND (p_region IS NULL OR c.payload->>'region' = p_region)
      AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
      AND NOT EXISTS (
        SELECT 1 FROM contribution_votes v
        WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
      )
      -- 剛派給這台機器的不要再派（2026-09-21）：同一台機器上常常有好幾個代理在跑，
      -- /next 派給 A、B 在 A 回報前投掉同一筆，A 做完整套查證才吃到 409 already_voted。
      -- 工白做，而且它不知道自己沒做錯。派發紀錄已經有了，拿來擋這 15 分鐘的窗口。
      AND NOT EXISTS (
        SELECT 1 FROM verify_dispatches vd
        WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
          AND vd.dispatched_at > now() - interval '15 minutes'
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
  '/next 的驗證候選池：同 IP 提交／投過／15 分鐘內剛派過的、已達有效門檻的、跟原貢獻有關係的裁決，都在 LIMIT 之前排掉；訪客觸發的先、裁決次之（最多佔窗口三分之一）、其餘最早的 N 筆。';
