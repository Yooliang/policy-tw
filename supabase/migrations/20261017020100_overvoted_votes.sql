-- 驗證票「投太多輪」：超過平均 2 倍標出、超過 3 倍停派轉裁決（維護者 2026-10-17，policy-ops docs/decisions/2026-10-17-不確定計分與投太多輪.md）
-- ============================================================
--
-- 現象：同一份交件被一票接一票地驗，驗證票一直排在隊裡（查無異動 f708a050 13 票、拖 15 天）。
--
-- 基準＝最近 30 天建立、已結案（狀態不是 pending／disputed）、至少 1 票的交件，平均每件幾票（票數＝agree＋disagree＋unsure 三個計數欄，
-- 即「每個來源 IP 只算最新一票」之後的票數，與計分同一個口徑）。不寫死：函式 contribution_vote_baseline_compute() 現算，
-- 結果存進單列表 vote_baseline（每 10 分鐘由 pg_cron overvoted-tick-10min 重算；每次派工不現算，一次 /next 只讀一列）。
--   票數 > 基準 × queue_settings.overvoted_flag_multiplier（2）→ 標出：主控台隊列頁「投太多輪」區（console_queue_state().overvoted），派工照常。
--   票數 > 基準 × queue_settings.overvoted_stop_multiplier（3）→ 停派：驗證池（contribution_verify_pool）在 LIMIT 之前就不給；
--     並轉裁決：狀態 pending → disputed（現有裁決機制的入口：disputed 就是「等裁決」），建一件 adjudicate 任務（來源 auto_dispute、
--     target.contribution_id＝原貢獻；與 _shared/adjudication.ts 的 buildAdjudicationTask 同一個任務型別與回報格式 uphold／reject），
--     由 /next 派給其他代理、3 票同向定案（apply-contribution.ts applyAdjudication）。冪等：同一份交件只會有一件開著的裁決任務。
--     adjudication 型別本身不停派、不轉裁決（避免遞迴，同 ensureAdjudicationTask）。
-- 兩個倍數在 queue_settings（新欄；改值一行 migration 的 UPDATE，進 edit_history，同其他排序參數）。
--
-- 這支只動正見（public）；日本站複本暫不跟（policy-jp-dispatch-drift.test.ts 登記）。
-- 簽名與回傳型別一字不動（CREATE OR REPLACE），console_queue_state() 只新增 overvoted 一個鍵。

-- ------------------------------------------------------------
-- 1. 設定與基準快取
-- ------------------------------------------------------------
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS overvoted_flag_multiplier NUMERIC(6,2) NOT NULL DEFAULT 2 CHECK (overvoted_flag_multiplier > 0);
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS overvoted_stop_multiplier NUMERIC(6,2) NOT NULL DEFAULT 3 CHECK (overvoted_stop_multiplier > 0);
ALTER TABLE queue_settings DROP CONSTRAINT IF EXISTS queue_settings_overvoted_order;
ALTER TABLE queue_settings ADD CONSTRAINT queue_settings_overvoted_order CHECK (overvoted_stop_multiplier >= overvoted_flag_multiplier);
COMMENT ON COLUMN queue_settings.overvoted_flag_multiplier IS '驗證票票數超過「近 30 天已結案交件的平均票數」× 這個倍數就在主控台標「投太多輪」（2）；派工照常';
COMMENT ON COLUMN queue_settings.overvoted_stop_multiplier IS '超過平均票數 × 這個倍數（3）：驗證票停派、交件轉 disputed 並開一件裁決任務；必須 ≥ 標出倍數';

CREATE TABLE IF NOT EXISTS vote_baseline (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  baseline    NUMERIC,
  sample      INTEGER,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE vote_baseline IS '近 30 天已結案交件的平均票數（單列 id=1）；contribution_vote_baseline_refresh() 每 10 分鐘重算（pg_cron overvoted-tick-10min），派工只讀這一列。不進審計（每 10 分鐘會變）。2026-10-17';
ALTER TABLE vote_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON vote_baseline;
CREATE POLICY "Public read" ON vote_baseline FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION contribution_vote_baseline_compute() RETURNS TABLE (baseline NUMERIC, sample INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT avg(c.agree_count + c.disagree_count + c.unsure_count)::NUMERIC, count(*)::INTEGER
    FROM contributions c
   WHERE c.created_at > now() - INTERVAL '30 days'
     AND c.status NOT IN ('pending', 'disputed')
     AND c.agree_count + c.disagree_count + c.unsure_count >= 1
$$;
COMMENT ON FUNCTION contribution_vote_baseline_compute IS '現算：最近 30 天建立、已結案（狀態不是 pending／disputed）、至少 1 票的交件，平均每件幾票（票數＝agree＋disagree＋unsure 計數欄）。2026-10-17';

CREATE OR REPLACE FUNCTION contribution_vote_baseline_refresh() RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE v_b NUMERIC; v_n INTEGER;
BEGIN
  SELECT baseline, sample INTO v_b, v_n FROM contribution_vote_baseline_compute();
  INSERT INTO vote_baseline (id, baseline, sample, computed_at) VALUES (1, v_b, v_n, now())
  ON CONFLICT (id) DO UPDATE SET baseline = EXCLUDED.baseline, sample = EXCLUDED.sample, computed_at = EXCLUDED.computed_at;
  RETURN v_b;
END;
$$;

-- 基準：讀快取；快取還沒有就現算（只在第一次刷新之前）
CREATE OR REPLACE FUNCTION contribution_vote_baseline() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT b.baseline FROM vote_baseline b WHERE b.id = 1), (SELECT x.baseline FROM contribution_vote_baseline_compute() x))
$$;

-- 標出／停派的票數線；沒有基準（沒有已結案交件）就不標不停（回一個天文數字）
CREATE OR REPLACE FUNCTION contribution_overvoted_flag_votes() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.overvoted_flag_multiplier * contribution_vote_baseline() FROM queue_settings s WHERE s.id = 1), 1000000::NUMERIC)
$$;
CREATE OR REPLACE FUNCTION contribution_overvoted_stop_votes() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.overvoted_stop_multiplier * contribution_vote_baseline() FROM queue_settings s WHERE s.id = 1), 1000000::NUMERIC)
$$;
COMMENT ON FUNCTION contribution_overvoted_stop_votes IS '票數超過這個數（基準 × overvoted_stop_multiplier）的驗證票停派、轉裁決；> 而不是 ≥。沒有基準時回 1000000（不停）。2026-10-17';

SELECT contribution_vote_baseline_refresh();

-- ------------------------------------------------------------
-- 2. 計票：同 20261017020000，多一條「裁決中的投太多輪交件留在 disputed」
--    （disputed 的交件之後任何一次重算——例如排程補上 judge_backed——不能因為分數沒到門檻就被改回 pending，
--      否則 pending → disputed → pending 來回、裁決任務白開）。只限這支函式開的裁決任務（created_by = 'auto-overvoted'），
--      其他來源的 disputed 行為不變。退件門檻照舊優先：分數跌到門檻直接 rejected，並把開著的裁決任務關掉（同 closeAdjudicationTasks）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
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
    ELSIF v_score >= v_target
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多。
      -- 名冊逐位吻合的例外（2026-10-01）：系統已逐位核過中選會名冊，就是另一雙眼睛
      AND (NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)) THEN
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

-- ------------------------------------------------------------
-- 3. 停派轉裁決：每 10 分鐘（與基準重算同一支排程）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_overvoted_escalate() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_stop NUMERIC := contribution_overvoted_stop_votes(); v_mult NUMERIC; v_base NUMERIC := contribution_vote_baseline(); v_n INTEGER;
BEGIN
  SELECT s.overvoted_stop_multiplier INTO v_mult FROM queue_settings s WHERE s.id = 1;
  WITH hit AS (
    UPDATE contributions c SET
      status = 'disputed',
      review_notes = COALESCE(c.review_notes || E'\n', '') || '[系統] 票數 ' || (c.agree_count + c.disagree_count + c.unsure_count)
                     || ' 超過平均 ' || v_mult || ' 倍（基準 ' || round(v_base, 2) || ' 票），停派驗證並轉裁決'
     WHERE c.status = 'pending'
       AND c.contribution_type <> 'adjudication'
       AND c.agree_count + c.disagree_count + c.unsure_count > v_stop
    RETURNING c.id, c.contribution_type, c.payload, c.source_urls, c.agent_name, c.agree_count + c.disagree_count + c.unsure_count AS votes
  ), ins AS (
    INSERT INTO contribution_tasks (title, description, task_type, target, priority, reward, status, source, created_by, hint_sources)
    SELECT left('裁決（投太多輪）：' || h.contribution_type || ' ' || COALESCE(NULLIF(h.payload->>'name', ''), NULLIF(h.payload->>'title', ''), ''), 120),
           '這筆交件已被驗了 ' || h.votes || ' 票（超過近 30 天已結案交件平均票數的 ' || v_mult || ' 倍）仍沒有定案，停止派驗證、改交裁決。原貢獻（' || h.contribution_type
             || '，提交者 ' || COALESCE(h.agent_name, '?') || '）payload：' || left(h.payload::TEXT, 300)
             || '。各票意見：' || COALESCE((SELECT string_agg(COALESCE(v.agent_name, '?') || '（' || v.verdict || '）：' || COALESCE(NULLIF(left(v.note, 160), ''), '（無說明）')
                                                                   || CASE WHEN v.evidence_url IS NOT NULL THEN '［' || v.evidence_url || '］' ELSE '' END, '；' ORDER BY v.created_at)
                                             FROM contribution_votes v WHERE v.contribution_id = h.id), '無')
             || '。請打開 hint_sources 裡的來源，把全部理由讀完後獨立判斷，用 contribution_type=adjudication 回報 {contribution_id, verdict: "uphold"（原貢獻正確）或 "reject"（原貢獻有誤）, reason（≥20 字）, checked_urls}。3 票同向即定案。',
           'adjudicate',
           jsonb_build_object('contribution_id', h.id, 'contribution_type', h.contribution_type, 'contributor', h.agent_name, 'reason', '投太多輪'),
           2, 1, 'open', 'auto_dispute', 'auto-overvoted',
           ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(h.source_urls, ARRAY[]::TEXT[])) AS u
                 UNION SELECT v.evidence_url FROM contribution_votes v WHERE v.contribution_id = h.id AND v.evidence_url IS NOT NULL)
      FROM hit h
     WHERE NOT EXISTS (SELECT 1 FROM contribution_tasks t
                        WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'contribution_id' = h.id::TEXT)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM hit;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION contribution_overvoted_escalate IS
  '投太多輪停派轉裁決（2026-10-17）：等票中、票數 > 基準 × overvoted_stop_multiplier 的交件（adjudication 除外）改 disputed 並開一件 adjudicate 任務（來源 auto_dispute，同 _shared/adjudication.ts 的任務型別與回報格式）；已有開著的裁決任務就不重開（冪等）。回傳轉了幾筆。';

CREATE OR REPLACE FUNCTION contribution_overvoted_tick() RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM contribution_vote_baseline_refresh();
  RETURN contribution_overvoted_escalate();
END;
$$;
COMMENT ON FUNCTION contribution_overvoted_tick IS '排程每 10 分鐘：重算票數基準、把超過停派線的交件轉裁決。pg_cron overvoted-tick-10min。2026-10-17';
REVOKE ALL ON FUNCTION contribution_vote_baseline_refresh() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_overvoted_escalate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_overvoted_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION contribution_vote_baseline_refresh() TO service_role;
GRANT EXECUTE ON FUNCTION contribution_overvoted_escalate() TO service_role;
GRANT EXECUTE ON FUNCTION contribution_overvoted_tick() TO service_role;

SELECT cron.unschedule('overvoted-tick-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'overvoted-tick-10min');
SELECT cron.schedule('overvoted-tick-10min', '3,13,23,33,43,53 * * * *', $$SELECT contribution_overvoted_tick();$$);

-- ------------------------------------------------------------
-- 4. 驗證池：超過停派線的不給（在 LIMIT 之前；同 #643 的教訓：合格條件寫在 SQL、不在程式過濾）
--    以 20261011160000 的現行定義為底，只多這一個條件。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL
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
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
                   AND contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) END AS target_score,
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
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    -- 過渡期（#484）：切換前自己交的（存單一 IP 的舊雜湊）也不派給自己
    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)
    -- 同代號自己交的也不派給自己（policy-ops#70）：以前只有 TS 在 LIMIT 之後才濾，前段集中同代號時別的網段的同代號機器會拿不到
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash
        -- 同代號在別的網段投過的也不派（2026-10-13）：投票有唯一索引 contribution_votes_one_per_agent（貢獻, 代號），
        -- 換了出口網段的同代號拿到也只能 409 already_voted 或 skip，而網站請求的驗證列一直留在前段，會被反覆派回來
        OR (p_agent_name IS NOT NULL AND lower(v.agent_name) = lower(p_agent_name)))
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)
            OR (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND (v2.verifier_ip_hash = p_ip_hash OR v2.verifier_ip_hash = p_legacy_ip_hash)
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。'
  '2026-10-02。2026-10-06（#349）兩台機器的型別改看 contribution_needs_two_ips（多了「中止」交接）。'
  '2026-10-09（#484）多 p_legacy_ip_hash：自交與投過票的排除（含裁決的原貢獻）新舊雜湊一起比；NULL＝與先前相同。'
  '2026-10-10（policy-ops#70）多 p_agent_name：同代號（含裁決原貢獻的代號）在 SQL、LIMIT 之前排除；NULL＝與先前相同。'
  '2026-10-13：同代號已投過票的也排除（投票表唯一索引是（貢獻, 代號），換網段的同代號派到也投不進去）。'
  '2026-10-17：票數超過 平均 × overvoted_stop_multiplier（近 30 天已結案交件的平均票數 × 3）的不派（裁決型別除外），在 LIMIT 之前。';

-- ------------------------------------------------------------
-- 5. 主控台隊列頁：多 overvoted 一個鍵；驗證票的「可派」同驗證池，超過停派線的不算（簽名、權限、既有欄位一字不動）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION console_queue_state() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ov AS (
    SELECT contribution_overvoted_flag_votes() AS flag, contribution_overvoted_stop_votes() AS stop
  ),
  inflight AS (
    SELECT c.task_id, count(*) AS n
      FROM contributions c
     WHERE c.status IN ('pending', 'verified', 'disputed')
     GROUP BY c.task_id
  ),
  -- 停放：任務編號看 task_id 欄，欄是空的看 payload.task_id（同 contribution_queue_tasks 的「合格：任務停放」）
  parkable AS (
    SELECT COALESCE(c.task_id, c.payload->>'task_id') AS task_id, count(*) AS n, count(*) FILTER (WHERE c.status = 'pending') AS waiting
      FROM contributions c
     WHERE c.status IN ('pending', 'verified', 'disputed')
     GROUP BY 1
  ),
  deadend AS (
    SELECT DISTINCT n.payload->>'task_id' AS task_id
      FROM contributions n
     WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
  ),
  qa AS (
    SELECT t2.target->>'question_id' AS qid, count(*) AS n
      FROM contributions c
      JOIN contribution_tasks t2 ON t2.id::TEXT = c.task_id AND t2.task_type = 'question'
     WHERE c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified')
     GROUP BY 1
  ),
  q AS (
    SELECT d.task_id, d.task_type, d.target, d.queue_at, d.dispatch_count, d.last_dispatched_at,
           CASE WHEN d.task_id LIKE 'auto:%' THEN 'auto' ELSE COALESCE(t.source, 'manual') END AS source,
           COALESCE(pk.n, 0) AS inflight_n, COALESCE(pk.waiting, 0) AS waiting_n,
           CASE
             WHEN d.blocked THEN 'blocked'
             WHEN d.cooling AND d.queue_at >= TIMESTAMPTZ '2000-01-01' THEN 'cooling'
             WHEN COALESCE(pk.n, 0) > 0 AND d.task_type NOT IN ('question', 'adjudicate', 'roster_check') THEN 'parked'
             WHEN de.task_id IS NOT NULL THEN 'dead_end'
             WHEN COALESCE(i.n, 0) >= 5 THEN 'saturated'
             WHEN d.task_type = 'question'
                  AND COALESCE(cq.answer_count, 0) + COALESCE(qa.n, 0) >= question_answer_cap() THEN 'question_full'
             ELSE 'ready'
           END AS status
      FROM task_dispatches d
      LEFT JOIN contribution_tasks t ON t.id::TEXT = d.task_id
      LEFT JOIN deadend de ON de.task_id = d.task_id
      LEFT JOIN inflight i ON i.task_id = d.task_id
      LEFT JOIN parkable pk ON pk.task_id = d.task_id
      LEFT JOIN citizen_questions cq ON d.task_type = 'question' AND cq.id::TEXT = d.target->>'question_id'
      LEFT JOIN qa ON d.task_type = 'question' AND qa.qid = d.target->>'question_id'
     WHERE d.task_id NOT LIKE 'verify:%'
  ),
  -- 驗證票：等票中的貢獻；可派＝分數還沒到目標（或兩台機器的型別還差一台），同 contribution_verify_pool 不看呼叫者的那幾條
  vt AS (
    SELECT d.task_id, d.queue_at, d.dispatch_count, d.last_dispatched_at, v.contribution_type, v.payload,
           ((v.score < COALESCE(v.target_score, d.verify_target, contribution_effective_agree(v.id))
             OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2))
            -- 投太多輪（20261017020100）：超過停派線的不算可派（同 contribution_verify_pool）
            AND (v.contribution_type = 'adjudication' OR v.agree_count + v.disagree_count + v.unsure_count <= (SELECT stop FROM ov))) AS ok
      FROM task_dispatches d
      JOIN contributions v ON d.task_id = 'verify:' || v.id AND v.status = 'pending'
     WHERE d.task_id LIKE 'verify:%'
  ),
  -- 投太多輪：等票或等裁決中、票數超過標出線的交件（裁決型別不算）
  over AS (
    SELECT c.id, c.contribution_type, c.payload, c.status, c.agree_count + c.disagree_count + c.unsure_count AS votes
      FROM contributions c
     WHERE c.status IN ('pending', 'disputed') AND c.contribution_type <> 'adjudication'
       AND c.agree_count + c.disagree_count + c.unsure_count > (SELECT flag FROM ov)
  ),
  -- /next 實際順序：queue_at，同一刻驗證票先、任務次之（HEAD_ORDER），再 task_id
  ordered AS (
    SELECT row_number() OVER (ORDER BY m.queue_at, m.tie, m.task_id)::INTEGER AS pos, m.*
      FROM (SELECT 'task'::TEXT AS kind, o.task_id, o.task_type, o.source, o.status, o.target, NULL::JSONB AS payload,
                   o.queue_at, o.dispatch_count, o.last_dispatched_at, 1 AS tie
              FROM q o WHERE o.status NOT IN ('blocked', 'cooling', 'parked')
            UNION ALL
            SELECT 'verify', v.task_id, v.contribution_type, 'verify', 'ready', NULL::JSONB, v.payload,
                   v.queue_at, v.dispatch_count, v.last_dispatched_at, 0
              FROM vt v WHERE v.ok) m
  ),
  real AS (
    SELECT COALESCE(d.task_type, 'verify') AS task_type,
           CASE WHEN d.task_id LIKE 'verify:%' THEN 'verify' WHEN d.task_id LIKE 'auto:%' THEN 'auto' ELSE 'manual' END AS kind
      FROM task_dispatches d
     WHERE d.dispatch_count > 0 AND d.last_dispatched_at > now() - INTERVAL '24 hours'
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'by_type', (SELECT COALESCE(jsonb_agg(jsonb_build_object('task_type', x.task_type, 'source', x.source, 'status', x.status, 'n', x.n)
                                          ORDER BY x.task_type, x.source, x.status), '[]'::JSONB)
                  FROM (SELECT task_type, source, status, count(*) AS n FROM q GROUP BY 1, 2, 3) x),
    'verify', (SELECT jsonb_build_object(
                 'total', COALESCE(sum(x.n), 0),
                 'eligible', COALESCE(sum(x.e), 0),
                 'by_type', COALESCE(jsonb_agg(jsonb_build_object('contribution_type', x.t, 'n', x.n, 'eligible', x.e) ORDER BY x.n DESC, x.t), '[]'::JSONB))
                 FROM (SELECT contribution_type AS t, count(*) AS n, count(*) FILTER (WHERE ok) AS e FROM vt GROUP BY 1) x),
    'head', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'pos', o.pos, 'kind', o.kind, 'task_type', o.task_type, 'source', o.source, 'status', o.status,
                 'subject', CASE WHEN o.kind = 'verify'
                                 THEN COALESCE(NULLIF(o.payload->>'name', ''),
                                               (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(o.payload)),
                                               (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(o.payload->>'policy_id')),
                                               NULLIF(o.payload->>'title', ''), '')
                                 ELSE COALESCE(NULLIF(o.target->>'name', ''), NULLIF(o.target->>'policy_title', ''), NULLIF(o.target->>'title', ''), '') END,
                 'queue_at', o.queue_at, 'dispatch_count', o.dispatch_count, 'last_dispatched_at', o.last_dispatched_at) ORDER BY o.pos), '[]'::JSONB)
               FROM (SELECT * FROM ordered ORDER BY pos LIMIT 60) o),
    'first_ready_pos', (SELECT min(pos) FROM ordered WHERE status = 'ready'),
    'overvoted', (SELECT jsonb_build_object(
                    'baseline', round(contribution_vote_baseline(), 4),
                    'flag_multiplier', s.overvoted_flag_multiplier, 'stop_multiplier', s.overvoted_stop_multiplier,
                    'flag_votes', round(ov.flag, 4), 'stop_votes', round(ov.stop, 4),
                    'total', (SELECT count(*) FROM over),
                    'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                'contribution_id', x.id, 'contribution_type', x.contribution_type,
                                'subject', COALESCE(NULLIF(x.payload->>'name', ''),
                                                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(x.payload)),
                                                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(x.payload->>'policy_id')),
                                                    NULLIF(x.payload->>'title', ''), ''),
                                'status', x.status, 'votes', x.votes, 'stopped', (x.votes > ov.stop OR x.status = 'disputed'),
                                'verdicts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                                'verdict', v.verdict, 'agent', v.agent_name, 'reason', left(COALESCE(v.note, ''), 120)) ORDER BY v.created_at), '[]'::JSONB)
                                               FROM contribution_votes v WHERE v.contribution_id = x.id)) ORDER BY x.votes DESC, x.id), '[]'::JSONB)
                              FROM (SELECT * FROM over ORDER BY votes DESC, id LIMIT 60) x))
                  FROM ov, queue_settings s WHERE s.id = 1),
    'parked_total', (SELECT count(*) FROM q WHERE status = 'parked'),
    'parked', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'task_id', p.task_id, 'task_type', p.task_type, 'source', p.source,
                 'subject', COALESCE(NULLIF(p.target->>'name', ''), NULLIF(p.target->>'policy_title', ''), NULLIF(p.target->>'title', ''), ''),
                 'queue_at', p.queue_at, 'inflight', p.inflight_n, 'verify_waiting', p.waiting_n) ORDER BY p.queue_at, p.task_id), '[]'::JSONB)
               FROM (SELECT * FROM q WHERE status = 'parked' ORDER BY queue_at, task_id LIMIT 60) p),
    'dispatched_24h', (SELECT COALESCE(jsonb_agg(jsonb_build_object('task_type', x.task_type, 'kind', x.kind, 'n', x.n) ORDER BY x.n DESC, x.task_type, x.kind), '[]'::JSONB)
                         FROM (SELECT task_type, kind, count(*) AS n FROM real GROUP BY 1, 2) x),
    'age_buckets', (SELECT jsonb_build_object(
                      'never', count(*) FILTER (WHERE dispatch_count = 0 OR last_dispatched_at IS NULL),
                      'lt_1h', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at >= now() - INTERVAL '1 hour'),
                      'h1_6', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '1 hour' AND last_dispatched_at >= now() - INTERVAL '6 hours'),
                      'h6_24', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '6 hours' AND last_dispatched_at >= now() - INTERVAL '24 hours'),
                      'd1_3', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '24 hours' AND last_dispatched_at >= now() - INTERVAL '3 days'),
                      'gt_3d', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '3 days'))
                      FROM q WHERE status = 'ready')
  )
$$;
COMMENT ON FUNCTION console_queue_state IS '主控台派工隊列頁（唯讀）：投太多輪（overvoted：基準與兩條票數線、超過標出線的交件前 60 筆與各票結論理由；超過停派線的驗證票不算可派）、非驗證列的狀態分布（blocked／cooling／parked／dead_end／saturated／question_full／ready）、隊頭 60 列（任務與可派的驗證票照 /next 順序合成，每列 kind）、停放中的任務與各等幾張驗證票、驗證佇列、24 小時實際派出、可派列的距上次派出分桶。2026-10-17（20261017020100 加 overvoted）';

REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_queue_state() TO anon, authenticated, service_role;
