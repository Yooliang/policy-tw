-- 投票不看 IP（維護者本人 2026-11-04 裁定；工作單 Yooliang/policy-ops#199）
--
-- 裁定：全部型別不再要求 2 個不同來源；同一網段的兩個代理各算一票。IP 只用在投票當下限制票數（每時段額度 per_ip_*，不動）。
-- 一人一票的單位：DiTrust 帳號按 actor_id（'ditrust:%'），匿名按代號 lower(agent_name)。取代 2026-09-19「身份是來源 IP」的裁決。
--
-- 改了什麼（正見 public 與日本 policy_jp 兩份一起）：
--   1. contribution_needs_two_ips 恆回 FALSE（函式留著：佇列預覽、console_queue_state 等呼叫端本來就看它，條件自動失效，不必逐支重寫）。
--   2. contribution_apply_consensus：每個投票人只算最新一票（原本每個 verifier_ip_hash 一票）；拿掉「v_ips >= 2／名冊吻合」條件；voter_ips 改記「不同投票人數」。
--   3. contribution_verify_pool：自己交的／投過的排除改按代號與 DiTrust actor_id（新參數 p_actor_id；日本站也補 p_agent_name），不再比來源網段；
--      「15 分鐘內派過」只看同網段的同一個代號；拿掉 voter_ips < 2 的優先條件。p_ip_hash、p_legacy_ip_hash 留著相容、不使用。
--   4. verify_dispatch_claim：15 分鐘內已派給同網段「同一個代號」才回 false；同網段別的代理認領得到同一筆。
--      派工綁定（verify_dispatches 的 (貢獻, 網段) 列）保留：它只是「這筆是 /next 派的」的證明，不是投票條件。
--
-- 上線當下的影響（2026-11-04 正式庫唯讀模擬，新舊計票比對）：正見 pending／verified／disputed 4248 件、日本 360 件，分數變動 0 件，
--   「分數已達標、只因單一網段卡住」0 件。沒有任何交件會因此過關或改狀態，不需回填。舊票（一網段一票）原樣沿用；
--   既有 voter_ips 值不重算，下次有人投票時才改成新的口徑。
-- TS 鏡像：consensus.ts（voterKey／tallyByVoter／needsTwoIps／scoreStatus）。

-- 1. contribution_needs_two_ips 恆為 FALSE
CREATE OR REPLACE FUNCTION contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT FALSE $$;
COMMENT ON FUNCTION contribution_needs_two_ips IS '已取消（維護者 2026-11-04：全部型別不再要求兩個不同來源）；恆為 FALSE，函式留著給呼叫端相容';
CREATE OR REPLACE FUNCTION policy_jp.contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT FALSE $$;
COMMENT ON FUNCTION policy_jp.contribution_needs_two_ips IS '已取消（維護者 2026-11-04：全部型別不再要求兩個不同來源）；恆為 FALSE，函式留著給呼叫端相容';

-- 2. 計票：正見
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個投票人只算最新那一票（維護者 2026-11-04：投票不看 IP，同網段的兩個代理各算一票）。
  -- 投票人的鍵：DiTrust 帳號＝actor_id，匿名＝小寫代號（TS 鏡像 consensus.ts 的 voterKey）。
  WITH latest AS (
    SELECT DISTINCT ON (voter_key) voter_key, verdict, COALESCE(weight, contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM (SELECT *, CASE WHEN actor_id LIKE 'ditrust:%' THEN actor_id ELSE lower(agent_name) END AS voter_key
            FROM contribution_votes WHERE contribution_id = p_contribution_id) vv
    ORDER BY voter_key, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;
  -- 不確定的罰則（2026-10-17）：第 1 張 0 分、第 2 張起每張 −1；只看張數、不看順序，weight 欄不動
  v_score := v_score - contribution_unsure_penalty(v_unsure);

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM contributions WHERE id = p_contribution_id;
  v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);
  v_reject := contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_status = 'disputed' AND EXISTS (
            SELECT 1 FROM contribution_tasks t
             WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.created_by = 'auto-overvoted'
               AND t.target->>'contribution_id' = p_contribution_id::TEXT) THEN
      -- 投太多輪轉來的裁決（20261017020100）：裁決任務開著就留在 disputed，由裁決定案；重算不能把它改回 pending
      -- （保持原狀態，不是「計分產生 disputed」：分數制不產生 disputed 的規則照舊，thresholds.test.ts 盯著）
      v_new := v_status;
    ELSIF v_score >= v_target THEN
      -- 不再要求兩個不同來源（維護者 2026-11-04）：分數到了就過；v_ips 只記不同投票人數
      v_new := 'verified';
    ELSIF (SELECT batch_verified_by FROM contributions WHERE id = p_contribution_id) IS NOT NULL THEN
      -- 隨名冊整批驗證通過（2026-09-24）：系統逐位核對過、名冊那筆也過了，不再逐筆湊票
      v_new := 'verified';
    ELSE
      v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    score = v_score,
    target_score = v_target,
    voter_ips = v_ips,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                             || CASE WHEN v_unsure >= 2 THEN '（含不確定 ' || v_unsure || ' 張，第 2 張起每張 −1）' ELSE '' END
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  -- 裁決中的交件被分數退件了：原貢獻已定案，開著的裁決任務沒有意義（同 _shared/adjudication.ts closeAdjudicationTasks）
  IF v_new = 'rejected' AND v_status = 'disputed' THEN
    UPDATE contribution_tasks SET status = 'closed', closed_at = now()
     WHERE task_type = 'adjudicate' AND status = 'open' AND target->>'contribution_id' = p_contribution_id::TEXT;
  END IF;
  RETURN v_new;
END;
$$;

-- 2. 計票：日本
CREATE OR REPLACE FUNCTION policy_jp.contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個投票人只算最新那一票（維護者 2026-11-04：投票不看 IP，同網段的兩個代理各算一票）。
  -- 投票人的鍵：DiTrust 帳號＝actor_id，匿名＝小寫代號（TS 鏡像 consensus.ts 的 voterKey）。
  WITH latest AS (
    SELECT DISTINCT ON (voter_key) voter_key, verdict, COALESCE(weight, policy_jp.contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM (SELECT *, CASE WHEN actor_id LIKE 'ditrust:%' THEN actor_id ELSE lower(agent_name) END AS voter_key
            FROM policy_jp.contribution_votes WHERE contribution_id = p_contribution_id) vv
    ORDER BY voter_key, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;
  -- 不確定的罰則（2026-10-17）：第 1 張 0 分、第 2 張起每張 −1；只看張數、不看順序，weight 欄不動
  v_score := v_score - policy_jp.contribution_unsure_penalty(v_unsure);

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM policy_jp.contributions WHERE id = p_contribution_id;
  v_target := COALESCE(policy_jp.contribution_effective_agree(p_contribution_id), 2);
  v_reject := policy_jp.contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_status = 'disputed' AND EXISTS (
            SELECT 1 FROM policy_jp.contribution_tasks t
             WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.created_by = 'auto-overvoted'
               AND t.target->>'contribution_id' = p_contribution_id::TEXT) THEN
      -- 投太多輪轉來的裁決（20261017020100）：裁決任務開著就留在 disputed，由裁決定案；重算不能把它改回 pending
      -- （保持原狀態，不是「計分產生 disputed」：分數制不產生 disputed 的規則照舊，thresholds.test.ts 盯著）
      v_new := v_status;
    ELSIF v_score >= v_target THEN
      -- 不再要求兩個不同來源（維護者 2026-11-04）：分數到了就過；v_ips 只記不同投票人數
      v_new := 'verified';
    ELSE
      v_new := 'pending';
    END IF;
  END IF;

  UPDATE policy_jp.contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    score = v_score,
    target_score = v_target,
    voter_ips = v_ips,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                             || CASE WHEN v_unsure >= 2 THEN '（含不確定 ' || v_unsure || ' 張，第 2 張起每張 −1）' ELSE '' END
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  -- 裁決中的交件被分數退件了：原貢獻已定案，開著的裁決任務沒有意義（同 _shared/adjudication.ts closeAdjudicationTasks）
  IF v_new = 'rejected' AND v_status = 'disputed' THEN
    UPDATE policy_jp.contribution_tasks SET status = 'closed', closed_at = now()
     WHERE task_type = 'adjudicate' AND status = 'open' AND target->>'contribution_id' = p_contribution_id::TEXT;
  END IF;
  RETURN v_new;
END;
$$;

-- 3. 驗證池：正見（簽名多一個參數，舊簽名先拿掉避免重載歧義；呼叫端用具名參數，不傳 p_actor_id 照舊可用）
DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL,
  p_actor_id TEXT DEFAULT NULL
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
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id = uuid_if_canonical(c.task_id) AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS target_score,
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

-- 3. 驗證池：日本（補 p_agent_name、p_actor_id）
DROP FUNCTION IF EXISTS policy_jp.contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION policy_jp.contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL,
  p_actor_id TEXT DEFAULT NULL
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
         COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM policy_jp.contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id)) AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM policy_jp.task_dispatches d
  JOIN policy_jp.contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    -- 投太多輪（20261017020100 の日本版）：票數超過 平均 × overvoted_stop_multiplier 的不再派；裁決（adjudication）本身不適用。
    -- 日本站沒有裁決流程，不自動轉 disputed（見檔頭）。條件在 LIMIT 之前；(SELECT …) 讓規劃器只算一次
    AND (c.contribution_type = 'adjudication'
         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT policy_jp.contribution_overvoted_stop_votes()))
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    -- 自己交的、投過票的不派給自己：同代號、或同一個 DiTrust 帳號（維護者 2026-11-04：投票不看 IP；p_ip_hash 留著相容、不使用）
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND (p_actor_id IS NULL OR c.actor_id IS DISTINCT FROM p_actor_id)
    AND (p_agent_name IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contribution_votes v
      WHERE v.contribution_id = c.id AND lower(v.agent_name) = lower(p_agent_name)
    ))
    AND (p_actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contribution_votes v
      WHERE v.contribution_id = c.id AND v.actor_id = p_actor_id
    ))
    -- 剛派給這個代號的不要再派（2026-09-21，見 000021；2026-11-04 起只看同網段「同代號」的派發）
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND (p_agent_name IS NULL OR lower(vd.agent_name) = lower(p_agent_name))
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND c.score < COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM policy_jp.contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR (p_actor_id IS NOT NULL AND o.actor_id = p_actor_id)
            OR EXISTS (
              SELECT 1 FROM policy_jp.contribution_votes v2
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

-- 4. 驗證派工認領：同網段不同代號各自認領
CREATE OR REPLACE FUNCTION verify_dispatch_claim(p_contribution_id UUID, p_ip_hash TEXT, p_agent_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    INSERT INTO verify_dispatches AS vd (contribution_id, ip_hash, agent_name, dispatched_at)
    VALUES (p_contribution_id, p_ip_hash, p_agent_name, now())
    ON CONFLICT (contribution_id, ip_hash) DO UPDATE
      SET agent_name = EXCLUDED.agent_name, dispatched_at = EXCLUDED.dispatched_at
      WHERE vd.dispatched_at <= now() - interval '15 minutes'
         OR lower(vd.agent_name) IS DISTINCT FROM lower(EXCLUDED.agent_name)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
COMMENT ON FUNCTION verify_dispatch_claim(UUID, TEXT, TEXT) IS
  '驗證派工的原子認領：15 分鐘內已派給同網段「同一個代號」回 false（/next 換下一筆），否則寫 verify_dispatches 回 true。2026-11-04：同網段不同代號各自認領得到同一筆（投票不看 IP）。';
CREATE OR REPLACE FUNCTION policy_jp.verify_dispatch_claim(p_contribution_id UUID, p_ip_hash TEXT, p_agent_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    INSERT INTO policy_jp.verify_dispatches AS vd (contribution_id, ip_hash, agent_name, dispatched_at)
    VALUES (p_contribution_id, p_ip_hash, p_agent_name, now())
    ON CONFLICT (contribution_id, ip_hash) DO UPDATE
      SET agent_name = EXCLUDED.agent_name, dispatched_at = EXCLUDED.dispatched_at
      WHERE vd.dispatched_at <= now() - interval '15 minutes'
         OR lower(vd.agent_name) IS DISTINCT FROM lower(EXCLUDED.agent_name)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
COMMENT ON FUNCTION policy_jp.verify_dispatch_claim(UUID, TEXT, TEXT) IS
  '驗證派工的原子認領：15 分鐘內已派給同網段「同一個代號」回 false，否則寫 verify_dispatches 回 true。2026-11-04：同網段不同代號各自認領得到同一筆。';
