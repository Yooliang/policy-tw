-- /verifications 的候選過濾在 LIMIT 之後（2026-09-21，這一族的第三次）。
--
-- 症狀：端點回 total_pending 1,076 卻一筆都不給。
--   limit=3（視窗 12）→ 0 筆
--   limit=20（視窗 80）→ 15 筆
--   limit=100（視窗 400）→ 50 筆
-- 它先抓最舊的 limit*4 筆，再用 TS 把「這台機器投過的」濾掉——而這台機器剛好把最舊的
-- 那幾百筆投完了（400 筆裡 350 筆投過），於是小 limit 直接回空。代理會以為沒東西可驗。
--
-- 跟 #102–#105、#122 是同一個反模式：合格判斷要在 SQL、LIMIT 之前。
-- 修法不是再寫一份過濾，而是改用 /next 早就在用的 contribution_verify_pool——
-- 那支已經把「同 IP 提交的、投過的、已達門檻的、跟原貢獻有關係的裁決」全部下推進 SQL。
-- 唯一缺的是 /verifications 支援的 type 過濾，這支 migration 幫它補上。
--
-- 先 DROP 再 CREATE：加一個有預設值的參數會變成新的多載，兩個版本並存會讓 PostgREST
-- 對三參數的呼叫無所適從。整支 migration 在同一個交易裡，沒有空窗。

DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER);

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
  '/next 與 /verifications 共用的驗證候選池：同 IP 提交／投過的、已達有效門檻的、跟原貢獻有關係的裁決，都在 LIMIT 之前排掉；訪客觸發的先、裁決次之（最多佔窗口三分之一）、其餘最早的 N 筆；p_type 可指定貢獻型別。';
