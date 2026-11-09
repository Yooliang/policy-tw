-- 驗證票「沒人在做的先派」（2026-11-09，維護者核准；協議 1.124.0）
--
-- 起因：同一張驗證票（需 3 票）在 7 分鐘內被派給 4 個代理，因為它排在佇列第 1，每個 /next 都拿隊頭，
-- 前面的人還在查證、後面的人又被派同一張。
-- 規則：一張驗證票被「握著」＝30 分鐘內（同任務的 LEASE_MINUTES）被派到、且還沒對它投票的不同代號（verify_dispatches ×
-- contribution_votes，同 20261109130000 console_queue_state 的 head.agent 口徑；同一網段的多個代號共用 (貢獻, 網段) 一列，後派的蓋掉前一個，會少算，只會偏鬆）。
-- 握著的人數 >= 還缺的票數（target_score − score）就先不派；/next 先要「p_skip_held=TRUE」的清單，
-- 零人握著的排在只有部分人握著的前面（JS 端穩定排序）；整個池子都被握滿時 /next 再用 FALSE 要一次＝維持原行為（不餓死）。
-- 任務列本來就跳過別人認領中的（contribution_queue_tasks 的 lease 條件，不需改）。
--
-- 簽名：多一個有預設值的參數 p_skip_held，回傳多一欄 held_count，所以要 DROP 舊簽名再建；呼叫端都用具名參數、
-- 舊程式不傳 p_skip_held 就是 FALSE（＝舊行為）、多出的欄位舊程式不讀，部署順序（先 db push 後函式）不會炸。
-- 本體＝20261104130000 的 contribution_verify_pool，只多 held_count 的 LATERAL 與 p_skip_held 一個條件。日本站不動。
-- 排序仍是 d.queue_at、d.task_id（保持走索引提早停），不在 SQL 排「零人握著優先」。
DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL,
  p_actor_id TEXT DEFAULT NULL,
  p_skip_held BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ,
  held_count INTEGER
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id = uuid_if_canonical(c.task_id) AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at,
         h.n AS held_count
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  -- 這張票現在被幾個「別的代理」握著（2026-11-09）：30 分鐘內（同 LEASE_MINUTES）派到、還沒對它投票的不同代號，不含正在要的這一位
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT lower(vd.agent_name))::INTEGER AS n
      FROM verify_dispatches vd
     WHERE vd.contribution_id = c.id
       AND vd.dispatched_at > now() - interval '30 minutes'
       AND vd.agent_name IS NOT NULL
       AND (p_agent_name IS NULL OR lower(vd.agent_name) <> lower(p_agent_name))
       AND NOT EXISTS (SELECT 1 FROM contribution_votes cv
                        WHERE cv.contribution_id = vd.contribution_id AND lower(cv.agent_name) = lower(vd.agent_name))
  ) h
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    -- 投太多輪（20261017020100）：票數超過 平均 × overvoted_stop_multiplier 的不再派（交件會被 contribution_overvoted_escalate 轉裁決）；
    -- 裁決（adjudication）本身不適用。條件在 LIMIT 之前；(SELECT …) 讓規劃器只算一次
    AND (c.contribution_type = 'adjudication'
         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT contribution_overvoted_stop_votes()))
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    -- 自己交的不派給自己：同代號、或同一個 DiTrust 帳號（維護者 2026-11-04：投票不看 IP，不再比來源網段；p_ip_hash／p_legacy_ip_hash 留著相容、不使用）
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND (p_actor_id IS NULL OR c.actor_id IS DISTINCT FROM p_actor_id)
    -- 投過票的排除（維護者 2026-11-04 起以投票人為準：同代號、或同一個 DiTrust 帳號；同網段別的代理投過不算）
    AND (p_actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.actor_id = p_actor_id
    ))
    AND (p_agent_name IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND lower(v.agent_name) = lower(p_agent_name)
    ))
    -- 剛派給這個代號的不要再派（2026-09-21，見 000021；2026-11-04 起只看同網段「同代號」的派發，同網段別的代理不受影響）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND (p_agent_name IS NULL OR lower(vd.agent_name) = lower(p_agent_name))
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
    -- 握著的人數已經 >= 還缺的票數（目標分數 − 目前分數，每票以 1 分算）就先不派（p_skip_held；沒有別的可派時 /next 會用 FALSE 再要一次，不餓死）
    AND (NOT p_skip_held
         OR h.n < GREATEST(1, COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) - c.score))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id = uuid_if_canonical(c.payload->>'contribution_id')
          AND (
            (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR (p_actor_id IS NOT NULL AND o.actor_id = p_actor_id)
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id
                AND ((p_agent_name IS NOT NULL AND lower(v2.agent_name) = lower(p_agent_name))
                     OR (p_actor_id IS NOT NULL AND v2.actor_id = p_actor_id))
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;


COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池（單一佇列，照 queue_at）：自己交的／投過的排除按代號與 DiTrust actor_id；p_skip_held=TRUE 時，被別的代理握著（30 分鐘內派到且未投票）的人數 >= 還缺票數的票先不出（held_count 回握著人數）。2026-11-09。';
