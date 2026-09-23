-- 派工省磁碟讀寫（小良哥 2026-09-24 凌晨：Disk IO 額度耗盡，全站逾時）
--
-- Supabase 請求紀錄實數（UTC，每 15 分鐘）：每次 /next 呼叫 contribution_auto_tasks（全站缺口重算，約 1.5 秒）、
-- contribution_auto_task_counts（又重算一次）、contribution_verify_pool（逐筆算目標分數，約 1.9 秒）。
-- 平常 60～90 次／15 分，15:45 衝到 140 次；額度 16:00 耗盡。另有 AI 讀取計數每讀一次寫一次（每小時 1,400～1,600 次）。
--
-- 1. 缺口改成排程每 10 分鐘算一次存進 auto_task_snapshot，/next 只讀這張表（本來就要等排程收進佇列才派，時間軸不變）
-- 2. 目標分數與投過票的機器數存進 contributions（計票時順手寫），驗證池不再逐筆呼叫函式
-- 3. AI 讀取計數改成批次寫入（Worker 累加一分鐘寫一次）
-- 4. 撤回的三樣照原設計加回（Jev 屆別判定、高風險型別兩台機器、讀備註排程）——它們的成本原本就在每次派工裡，
--    現在搬到十分鐘一次的排程，已經不在熱路徑上。

-- ============================================================
-- 1. 缺口快照
-- ============================================================
CREATE TABLE IF NOT EXISTS auto_task_snapshot (
  task_id      TEXT PRIMARY KEY,
  task_type    TEXT NOT NULL,
  target       JSONB,
  what_we_need TEXT,
  hint_sources TEXT[],
  reward       INTEGER,
  region       TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE auto_task_snapshot IS '自動缺口的快照：refresh_auto_task_snapshot() 每 10 分鐘（seed_auto_task_queue）重算一次；/next、/tasks 只讀這張表。';
CREATE INDEX IF NOT EXISTS auto_task_snapshot_type_idx ON auto_task_snapshot (task_type);
ALTER TABLE auto_task_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auto_task_snapshot_public_read ON auto_task_snapshot;
CREATE POLICY auto_task_snapshot_public_read ON auto_task_snapshot FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION refresh_auto_task_snapshot() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT * FROM contribution_auto_tasks_arms();
  DELETE FROM auto_task_snapshot s WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = s.task_id);
  INSERT INTO auto_task_snapshot (task_id, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at)
  SELECT DISTINCT ON (g.task_id) g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now() FROM _gaps g
  ON CONFLICT (task_id) DO UPDATE SET task_type = EXCLUDED.task_type, target = EXCLUDED.target, what_we_need = EXCLUDED.what_we_need,
    hint_sources = EXCLUDED.hint_sources, reward = EXCLUDED.reward, region = EXCLUDED.region, refreshed_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION refresh_auto_task_snapshot IS '重算全站自動缺口存進 auto_task_snapshot（重，只給排程用）';

-- 缺口一被補上（貢獻落庫）就從快照拿掉，不必等下一輪排程
CREATE OR REPLACE FUNCTION auto_task_snapshot_drop_applied() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'applied' AND NEW.task_id IS NOT NULL AND NEW.task_id LIKE 'auto:%' THEN
    DELETE FROM auto_task_snapshot WHERE task_id = NEW.task_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contributions_drop_snapshot ON contributions;
CREATE TRIGGER contributions_drop_snapshot AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied') EXECUTE FUNCTION auto_task_snapshot_drop_applied();

CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER;
BEGIN
  PERFORM refresh_auto_task_snapshot();
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT g.task_id, now(), now(), 0
    FROM auto_task_snapshot g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的（例如觸發器上線前就 pending 的）補進來
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  RETURN v_new + v_verify;
END;
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM auto_task_snapshot),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  -- 內連接，不是左連接：**沒被排程收進佇列的缺口就還沒進佇列，不派。**
  -- 使用者 2026-09-21：「我們自動缺口…要從排程裡面把它加到佇列裡面來，
  -- 加入排程的時間就是它的現在時間。」用 COALESCE 給個預設值就等於繞過佇列，
  -- 那條規則會變成裝飾。代價是新缺口最多晚 10 分鐘才派得出去，這是對的代價。
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward, d.queue_at
  FROM t
  JOIN task_dispatches d ON d.task_id = t.task_id
  LEFT JOIN inflight f ON f.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (
          CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'
        )::INTERVAL
    )
    AND COALESCE(f.n, 0) < 5
    AND NOT EXISTS (
      SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = t.task_id
    )
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = t.task_id OR l.target_key = task_target_key(t.task_id, t.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = t.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY
    -- Jev 高信心又還沒派過的，那一次插到最前；派過就回到時間軸，不是永久特權
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability()
          AND t.task_id IN ('auto:policy_election_missing:' || j.subject_id, 'auto:policy_election_mismatch:' || j.subject_id))
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 唯一的排序鍵：佇列時間。1980＝使用者指定最先做，排程加進來的當下＝排最後，
    -- 派出去就蓋成 now() 回到隊尾。
    d.queue_at ASC,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

-- 撤回前的版本（000011）：Jev 判成別屆也開任務。現在只在排程裡跑
CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH jev AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.probability
    FROM jev_decisions j
    WHERE j.subject_type = 'policy' AND j.question = 'election'
    ORDER BY j.subject_id, j.asked_at DESC
  ),
  by_date AS (
    SELECT pl.id
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.proposed_date IS NOT NULL
      AND pl.proposed_date > e.election_date
      -- 2026-09-22 #5：當選者任內提出的施政掛在當選那一屆是對的
      AND NOT EXISTS (
        SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.election_result = 'elected'
      )
  ),
  by_jev AS (
    SELECT pl.id
    FROM policies pl
    JOIN jev ON jev.subject_id = pl.id::TEXT
    WHERE pl.removed_at IS NULL
      AND pl.election_id IS NOT NULL
      AND jev.choice ~ '^\d{4}$'
      AND jev.choice <> pl.election_id::TEXT
      AND jev.probability >= 0.8
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', pl.source_url,
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END) AS target,
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。' AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
$fn$;

-- ============================================================
-- 2. 目標分數、投過票的機器數存進 contributions
-- ============================================================
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS target_score INTEGER;
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS voter_ips INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN contributions.target_score IS '目標分數（contribution_effective_agree 的快取），contribution_apply_consensus 計票時寫入；NULL＝還沒計過票';
COMMENT ON COLUMN contributions.voter_ips IS '投過 agree／disagree 的來源 IP 數，contribution_apply_consensus 計票時寫入';

CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_new TEXT; v_target INTEGER; v_reject INTEGER;
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
  v_reject := contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
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
    target_score = v_target,
    voter_ips = v_ips,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 等票中的先補一次（其餘等下次計票時寫）
UPDATE contributions SET target_score = contribution_effective_agree(id),
  voter_ips = (SELECT COUNT(DISTINCT v.verifier_ip_hash) FROM contribution_votes v WHERE v.contribution_id = contributions.id AND v.verdict IN ('agree', 'disagree'))
WHERE status = 'pending';

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
         COALESCE(c.target_score, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, contribution_effective_agree(c.id))
                   AND c.contribution_type IN ('merge_politician', 'candidacy', 'removal') AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, contribution_effective_agree(c.id)) END AS target_score,
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
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, contribution_effective_agree(c.id))
         OR (c.contribution_type IN ('merge_politician', 'candidacy', 'removal') AND c.voter_ips < 2))
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

-- ============================================================
-- 3. AI 讀取計數批次寫入：[{agent, kind, path_type, n}, ...]
-- ============================================================
CREATE OR REPLACE FUNCTION ai_read_hits(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r JSONB; v_n INTEGER; v_done INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LIMIT 200 LOOP
    CONTINUE WHEN (r->>'agent') IS NULL OR (r->>'agent') !~ '^[A-Za-z0-9._-]{1,40}$';
    CONTINUE WHEN (r->>'kind') NOT IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral');
    CONTINUE WHEN (r->>'path_type') NOT IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'other');
    v_n := LEAST(GREATEST(COALESCE((r->>'n')::INTEGER, 1), 1), 100000);
    INSERT INTO ai_reads_daily (day, agent, kind, path_type, hits)
    VALUES ((now() AT TIME ZONE 'Asia/Taipei')::DATE, r->>'agent', r->>'kind', r->>'path_type', v_n)
    ON CONFLICT (day, agent, kind, path_type) DO UPDATE SET hits = ai_reads_daily.hits + EXCLUDED.hits;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION ai_read_hits(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_read_hits(JSONB) TO anon, authenticated;
COMMENT ON FUNCTION ai_read_hits IS 'Worker 累加一分鐘後批次寫入 AI 讀取計數（2026-09-24，取代每讀一次呼叫一次 ai_read_hit）';

-- ============================================================
-- 4. 撤回的排程加回（成本不在派工熱路徑上）
-- ============================================================
SELECT cron.unschedule('system-one-followups-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-followups-10min');
SELECT cron.schedule(
  'system-one-followups-10min',
  '5,15,25,35,45,55 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=followups&since_hours=1&limit=60',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);

-- 第一次快照（排程下一輪也會做）
SELECT refresh_auto_task_snapshot();
