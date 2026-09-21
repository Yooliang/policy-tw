-- 共識從票數改成分數（使用者 2026-09-21 裁示；規劃見 docs/PLAN-weighted-consensus.md §2、§8.1）
--
--   目標分數 = 既有的有效門檻 contribution_effective_agree()（型別×來源矩陣，系統票已折進去）
--   每一票   = −2 ～ +2，看它帶了多少證據：
--              agree +1；agree 且 evidence_url 經 Jev 核過（judge_backed）+2
--              disagree −1；disagree 且反證經 Jev 核過 −2；unsure 0
--   累計 ≥ 目標   → verified（高風險型別另要求 ≥2 個不同來源 IP）
--   累計 ≤ −目標  → rejected（直接清出去）
--   其餘         → pending
--
-- 裁決退場。裁決之所以存在，是因為固定票數下兩張反對會卡死、需要一條特殊出路；
-- 分數制裡反對本身就是往下的力道，特例不必存在。現實佐證：裁決是全系統最壞的一段——
-- 86 筆 pending、平均 0.1 票、歷來只定案 6 筆。
--
-- 使用者：「前端看到票數不是正確的，因為你動態評分沒有上。」既有的待驗證件全部用新規則
-- 重算，不留兩套規則並行。

ALTER TABLE contributions ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN contributions.score IS '累計分數（每個來源 IP 只算最新一票的 weight 之和）。≥ 目標上線、≤ −目標退件。目標見 contribution_effective_agree()。';
ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS weight SMALLINT;
COMMENT ON COLUMN contribution_votes.weight IS '這一票值幾分（−2～+2），由 verdict 與 judge_backed 決定，觸發器自動填。';

-- 一票值幾分：唯一的定義，TS 的 voteWeight() 是它的鏡像（守門測試盯兩邊一致）
CREATE OR REPLACE FUNCTION contribution_vote_weight(p_verdict TEXT, p_judge_backed BOOLEAN) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_verdict = 'agree'    THEN CASE WHEN COALESCE(p_judge_backed, false) THEN 2 ELSE 1 END
    WHEN p_verdict = 'disagree' THEN CASE WHEN COALESCE(p_judge_backed, false) THEN -2 ELSE -1 END
    ELSE 0 END)::SMALLINT
$$;

UPDATE contribution_votes SET weight = contribution_vote_weight(verdict, judge_backed) WHERE weight IS NULL;

CREATE OR REPLACE FUNCTION contribution_votes_set_weight() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.weight := contribution_vote_weight(NEW.verdict, NEW.judge_backed);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contribution_votes_weight ON contribution_votes;
-- BEFORE：要在既有的 AFTER 觸發器（trg_contribution_votes_consensus → contribution_apply_consensus）算分之前填好
CREATE TRIGGER trg_contribution_votes_weight
BEFORE INSERT OR UPDATE OF verdict, judge_backed ON contribution_votes
FOR EACH ROW EXECUTE FUNCTION contribution_votes_set_weight();

-- 計分：取代票數制的 contribution_apply_consensus
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_new TEXT; v_target INTEGER;
BEGIN
  -- 每個來源 IP 只算最新那一票（沿用「代理票依來源 IP 去重」的精神）
  WITH latest AS (
    SELECT DISTINCT ON (verifier_ip_hash) verifier_ip_hash, verdict, COALESCE(weight, contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM contribution_votes WHERE contribution_id = p_contribution_id
    ORDER BY verifier_ip_hash, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;

  SELECT status, contribution_type INTO v_status, v_type FROM contributions WHERE id = p_contribution_id;
  v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    IF v_score <= -v_target THEN
      v_new := 'rejected';
    ELSIF v_score >= v_target
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多
      AND (v_type NOT IN ('merge_politician', 'candidacy', 'removal') OR v_ips >= 2) THEN
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
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −目標 ' || v_target || '，依分數制退件'
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;
COMMENT ON FUNCTION contribution_apply_consensus IS
  '分數制（2026-09-21）：每個來源 IP 只算最新一票的 weight，總分 ≥ 目標→verified（高風險型別另要求 ≥2 IP）、≤ −目標→rejected、其餘 pending。目標＝contribution_effective_agree()。不再產生 disputed。';

-- 派工池：達標判斷改看分數，並把 score／target_score 回給呼叫端
DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT);
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
  target_score INTEGER
)
LANGUAGE sql STABLE AS $$
  WITH eligible AS (
    SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
           c.agent_name, c.contributor_ip_hash, c.status,
           c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
           contribution_effective_agree(c.id) AS effective_required,
           c.score,
           contribution_effective_agree(c.id) AS target_score,
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
      -- 分數已達目標的不用再驗（2026-09-21 分數制；系統票折進目標裡）
      AND c.score < contribution_effective_agree(c.id)
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
         r.effective_required, r.visitor_facing, r.adjudication_facing, r.score, r.target_score
  FROM ranked r
  -- 裁決最多佔三分之一；訪客觸發與其他型別不設限
  WHERE r.bucket <> 1 OR r.rn <= GREATEST(1, COALESCE(p_limit, 30) / 3)
  ORDER BY r.bucket ASC, r.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

-- ------------------------------------------------------------
-- 切換：既有的待驗證與爭議件全部用新規則重算（不留兩套規則並行）
-- ------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE status IN ('pending', 'disputed') LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;

-- 裁決退場：開著的裁決任務關掉；還在等票的裁決貢獻標 withdrawn（不計入任何人的退件）
UPDATE contribution_tasks SET status = 'closed', closed_at = now()
 WHERE task_type = 'adjudicate' AND status = 'open';
UPDATE contributions
   SET status = 'withdrawn',
       review_notes = COALESCE(review_notes || E'\n', '') || '[系統] 裁決退場（2026-09-21 改分數制），此件不再需要'
 WHERE contribution_type = 'adjudication' AND status IN ('pending', 'verified', 'disputed');
