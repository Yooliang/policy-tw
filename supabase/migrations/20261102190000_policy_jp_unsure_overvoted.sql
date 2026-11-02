-- 日本站跟上正見：「不確定」第 2 張起每張 −1、投太多輪（2 倍標出、3 倍停派）、爭點驗證
-- ============================================================
-- 工作單：policy-ops#178（A）併 #128。正見版：20261017020000（不確定罰則）、20261017020100（投太多輪）、20261017030000（裁決不插隊）、
-- 20261017040000（爭點驗證，協議 1.96.0）。全部是正見現行定義的逐字複本（policy-jp-dispatch-drift.test.ts 的機械式替換比對）。
--
-- 規則（同正見，維護者 2026-10-17／10-18）：
--   1. 不確定：同一份交件第 1 張 unsure 0 分，第 2 張起每張 −1（罰則 = GREATEST(n−1, 0)，扣在 contribution_apply_consensus 計分這一步，
--      不寫進 contribution_votes.weight；每個來源 IP 只算最新一票）。agree／disagree 權重、系統票、目標分數、退件門檻都不變。
--   2. 投太多輪：基準 = 近 30 天已結案、至少 1 票的交件平均票數（policy_jp.vote_baseline，contribution_vote_baseline_refresh() 重算）。
--      票數 > 基準 × queue_settings.overvoted_flag_multiplier（2）→ 標出（派工照常，但驗證票改成爭點驗證，見 3）；
--      票數 > 基準 × queue_settings.overvoted_stop_multiplier（3）→ 驗證池（contribution_verify_pool）在 LIMIT 之前就不給。
--   3. 爭點驗證（協議 1.96.0）：contribution_dispute_votes／contribution_dispute_context 給 jp-next／verify-handler 用。
--
-- 日本站的偏離（寫在這裡、走樣守門有登記）：
--   * 基準的重算排程：正見的重算跟「轉裁決」綁在同一支 overvoted tick，tick 自 10-17 起暫停，正見的基準因此停在 10-17 的值。
--     日本站不照抄這個缺點：只排基準重算（pg_cron policy-jp-vote-baseline-hourly，每小時；pg_cron 不在的環境略過），不排轉裁決。
--   * 停派之後「轉裁決」（contribution_overvoted_escalate：pending → disputed、開 adjudicate 任務）不移植：日本站沒有裁決型別與裁決流程
--     （jp-next 檔頭「拿掉：裁決」），轉過去只會讓交件卡在 disputed。正見也已暫停這一步（20261017030000）。超過停派線的交件只是不再派驗證，
--     等維護者在主控台處理（日本站主控台的「投太多輪」區另案）。
--   * 驗證池只多一個條件（投太多輪那段），其餘維持日本站 130000 的版本（日本站還沒跟 p_legacy_ip_hash／p_agent_name 等）。
--   * 既有等票的交件（不確定 >= 2 張）在這支 migration 裡用同一支函式重算一次，同正見 20261017020000。
-- 只動 policy_jp，不碰 public。

-- ------------------------------------------------------------
-- 1. 設定與基準快取
-- ------------------------------------------------------------
ALTER TABLE policy_jp.queue_settings ADD COLUMN IF NOT EXISTS overvoted_flag_multiplier NUMERIC(6,2) NOT NULL DEFAULT 2 CHECK (overvoted_flag_multiplier > 0);
ALTER TABLE policy_jp.queue_settings ADD COLUMN IF NOT EXISTS overvoted_stop_multiplier NUMERIC(6,2) NOT NULL DEFAULT 3 CHECK (overvoted_stop_multiplier > 0);
ALTER TABLE policy_jp.queue_settings DROP CONSTRAINT IF EXISTS queue_settings_overvoted_order;
ALTER TABLE policy_jp.queue_settings ADD CONSTRAINT queue_settings_overvoted_order CHECK (overvoted_stop_multiplier >= overvoted_flag_multiplier);
COMMENT ON COLUMN policy_jp.queue_settings.overvoted_flag_multiplier IS '驗證票票數超過「近 30 天已結案交件的平均票數」× 這個倍數（2）就標出，並改成爭點驗證；派工照常';
COMMENT ON COLUMN policy_jp.queue_settings.overvoted_stop_multiplier IS '超過平均票數 × 這個倍數（3）：驗證票停派；必須 ≥ 標出倍數';

CREATE TABLE IF NOT EXISTS policy_jp.vote_baseline (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  baseline    NUMERIC,
  sample      INTEGER,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_jp.vote_baseline IS '近 30 天已結案交件的平均票數（單列 id=1）；contribution_vote_baseline_refresh() 重算，派工只讀這一列。不進審計。2026-11-02（正見 20261017020100 的日本版）';
ALTER TABLE policy_jp.vote_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.vote_baseline FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.vote_baseline TO service_role;

-- 抄自 20261017020000_unsure_penalty.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_unsure_penalty(p_unsure INTEGER) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(COALESCE(p_unsure, 0) - 1, 0)
$$;
-- 抄自 20261017020100_overvoted_votes.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_vote_baseline_compute() RETURNS TABLE (baseline NUMERIC, sample INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT avg(c.agree_count + c.disagree_count + c.unsure_count)::NUMERIC, count(*)::INTEGER
    FROM policy_jp.contributions c
   WHERE c.created_at > now() - INTERVAL '30 days'
     AND c.status NOT IN ('pending', 'disputed')
     AND c.agree_count + c.disagree_count + c.unsure_count >= 1
$$;
-- 抄自 20261017020100_overvoted_votes.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_vote_baseline_refresh() RETURNS NUMERIC
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_b NUMERIC; v_n INTEGER;
BEGIN
  SELECT baseline, sample INTO v_b, v_n FROM policy_jp.contribution_vote_baseline_compute();
  INSERT INTO policy_jp.vote_baseline (id, baseline, sample, computed_at) VALUES (1, v_b, v_n, now())
  ON CONFLICT (id) DO UPDATE SET baseline = EXCLUDED.baseline, sample = EXCLUDED.sample, computed_at = EXCLUDED.computed_at;
  RETURN v_b;
END;
$$;
-- 抄自 20261017020100_overvoted_votes.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_vote_baseline() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT b.baseline FROM policy_jp.vote_baseline b WHERE b.id = 1), (SELECT x.baseline FROM policy_jp.contribution_vote_baseline_compute() x))
$$;
-- 抄自 20261017020100_overvoted_votes.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_overvoted_flag_votes() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.overvoted_flag_multiplier * policy_jp.contribution_vote_baseline() FROM policy_jp.queue_settings s WHERE s.id = 1), 1000000::NUMERIC)
$$;
-- 抄自 20261017020100_overvoted_votes.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_overvoted_stop_votes() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.overvoted_stop_multiplier * policy_jp.contribution_vote_baseline() FROM policy_jp.queue_settings s WHERE s.id = 1), 1000000::NUMERIC)
$$;
REVOKE ALL ON FUNCTION policy_jp.contribution_vote_baseline_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_vote_baseline_refresh() TO service_role;

-- 抄自 20261017020100_overvoted_votes.sql（計票：不確定罰則＋裁決中的留守＋退件關裁決任務）；拿掉中選會名冊兩處
CREATE OR REPLACE FUNCTION policy_jp.contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個來源 IP 只算最新那一票（沿用「代理票依來源 IP 去重」的精神）
  WITH latest AS (
    SELECT DISTINCT ON (verifier_ip_hash) verifier_ip_hash, verdict, COALESCE(weight, policy_jp.contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM policy_jp.contribution_votes WHERE contribution_id = p_contribution_id
    ORDER BY verifier_ip_hash, created_at DESC
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
    ELSIF v_score >= v_target
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多。
      -- 名冊逐位吻合的例外（2026-10-01）：系統已逐位核過中選會名冊，就是另一雙眼睛
      AND (NOT policy_jp.contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2) THEN
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

-- 抄自 20261017030000_overvoted_adjudication_pause.sql
CREATE OR REPLACE FUNCTION policy_jp.manual_front_seconds(p_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t.created_by = 'auto-overvoted' THEN 0
              WHEN policy_jp.manual_task_is_visitor(t.source, t.task_type) THEN q.visitor_front_seconds
              WHEN t.source IN ('manual', 'auto_dispute') THEN q.manual_front_seconds
              ELSE 0 END
    FROM policy_jp.contribution_tasks t CROSS JOIN policy_jp.queue_settings q
   WHERE q.id = 1 AND t.id::TEXT = p_task_id
$$;

-- 驗證池：以日本站 130000 的版本為底，只多投太多輪停派一個條件（抄自 20261017020100）
CREATE OR REPLACE FUNCTION policy_jp.contribution_verify_pool(
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
         COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM policy_jp.contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id))
                   AND policy_jp.contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id)) END AS target_score,
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
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, policy_jp.contribution_effective_agree(c.id))
         OR (policy_jp.contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM policy_jp.contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            o.contributor_ip_hash = p_ip_hash
            OR EXISTS (
              SELECT 1 FROM policy_jp.contribution_votes v2
              WHERE v2.contribution_id = o.id AND v2.verifier_ip_hash = p_ip_hash
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

-- 抄自 20261017040000_dispute_focused_verify.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_dispute_votes(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT (c.agree_count + c.disagree_count + c.unsure_count)::INTEGER
    FROM policy_jp.contributions c
   WHERE c.id = p_contribution_id
     AND c.status IN ('pending', 'disputed') AND c.contribution_type <> 'adjudication'
     AND c.agree_count + c.disagree_count + c.unsure_count > policy_jp.contribution_overvoted_flag_votes()
$$;
-- 抄自 20261017040000_dispute_focused_verify.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_dispute_context(p_contribution_id UUID) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH d AS (
    SELECT policy_jp.contribution_dispute_votes(p_contribution_id) AS n
  ), p AS (
    SELECT v.verdict, v.agent_name, left(v.note, 300) AS note, v.evidence_url, v.created_at
      FROM policy_jp.contribution_votes v
     WHERE v.contribution_id = p_contribution_id AND (SELECT n FROM d) IS NOT NULL
     ORDER BY v.created_at DESC
     LIMIT 30
  )
  SELECT jsonb_build_object(
           'votes', d.n,
           'baseline', round(policy_jp.contribution_vote_baseline(), 2),
           'flag', round(policy_jp.contribution_overvoted_flag_votes(), 2),
           'shown', (SELECT count(*) FROM p),
           'prior', COALESCE((SELECT jsonb_agg(jsonb_build_object('verdict', p.verdict, 'agent', p.agent_name, 'note', p.note, 'evidence_url', p.evidence_url, 'at', p.created_at) ORDER BY p.created_at) FROM p), '[]'::JSONB))
    FROM d
   WHERE d.n IS NOT NULL
$$;
REVOKE ALL ON FUNCTION policy_jp.contribution_dispute_votes(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.contribution_dispute_context(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_dispute_votes(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_dispute_context(UUID) TO service_role;

SELECT policy_jp.contribution_vote_baseline_refresh();

-- 排程：每小時重算基準。pg_cron 不在的環境（本機、測試）略過，不讓 migration 失敗；重跑先 unschedule 再 schedule，只留一條
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-vote-baseline-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-vote-baseline-hourly')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-vote-baseline-hourly', '17 * * * *', 'SELECT policy_jp.contribution_vote_baseline_refresh();')$q$;
  END IF;
END $$;

-- 既有等票的交件用新規則重算一次（只有不確定 >= 2 張的分數會變；其餘重算結果不變，不碰）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM policy_jp.contributions WHERE status = 'pending' AND unsure_count >= 2 ORDER BY created_at LOOP
    PERFORM policy_jp.contribution_apply_consensus(r.id);
  END LOOP;
END $$;
