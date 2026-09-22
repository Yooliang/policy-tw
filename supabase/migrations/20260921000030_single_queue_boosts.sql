-- 單一佇列（驗證也是任務）＋ 插隊（task_boost）（2026-09-22，使用者裁示）
--
-- 1. 驗證不再另外排程。「驗證它本身也是一件任務而已，只是特定類型的任務」（使用者 2026-09-22）。
--    待驗證的貢獻進 task_dispatches，鍵 'verify:<contribution_id>'，跟自動缺口、手動任務同一條 queue_at 時間軸；
--    派出去就蓋 now()（task_dispatched），回到隊尾。3:1 比例退場（DECISIONS 2026-09-22）。
-- 2. 插隊：維護者（或任何代理，端點無金鑰）給一個條件（縣市、屆別、層級、任務型別、缺照片、指定人物），
--    符合的任務——含驗證——一次性排到最前（1980 年＋第幾次插隊的分鐘數，先插的先派）；領走後回到時間軸，
--    沒做完想再推就再插一次。這就是 DECISIONS #23 的「一次性插隊」，只是把「誰可以插」從 Jev 開放給人。
-- 3. 原本硬編碼的「2026 縣市長基本資料與政見 → 1980」改成第一筆插隊紀錄；新出現的缺口一律 now()。

-- ------------------------------------------------------------
-- 驗證項目進佇列：新貢獻一 pending 就發號碼牌；訪客看得到的（提問回答、網站按鈕觸發）給 1980
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_at(p_contribution_type TEXT, p_task_id TEXT, p_created_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_contribution_type = 'question_answer' THEN TIMESTAMPTZ '1980-01-01'
    WHEN EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = p_task_id AND t.source = 'web_request') THEN TIMESTAMPTZ '1980-01-01'
    ELSE p_created_at
  END;
$$;

CREATE OR REPLACE FUNCTION contribution_queue_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
    VALUES ('verify:' || NEW.id, now(), contribution_queue_at(NEW.contribution_type, NEW.task_id, NEW.created_at), 0)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_contribution_queue_row ON contributions;
CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions
  FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();

-- ------------------------------------------------------------
-- 排程：新缺口 now()（不再看 task_priority_tier）；補漏的驗證列；清掉已離開 pending 的驗證列
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER;
BEGIN
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT g.task_id, now(), now(), 0
    FROM contribution_auto_tasks_arms() g
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
COMMENT ON FUNCTION seed_auto_task_queue IS
  '新出現的自動缺口與待驗證貢獻發號碼牌（queue_at=now()；訪客看得到的驗證給 1980）。已經有列的不動；離開 pending 的驗證列清掉。由 pg_cron 每 10 分鐘跑。誰先誰後由 task_boost 決定，不再硬編碼。';

-- ------------------------------------------------------------
-- 驗證池：照 queue_at 排（桶子退場：訪客優先已由 1980 表達；裁決已退場）
-- ------------------------------------------------------------
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
         contribution_effective_agree(c.id) AS target_score,
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
    AND c.score < contribution_effective_agree(c.id)
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

-- ------------------------------------------------------------
-- 插隊
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_boosts (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  filter JSONB NOT NULL,
  agent_name TEXT,
  ip_hash TEXT,
  matched_tasks INTEGER NOT NULL DEFAULT 0,
  matched_verifies INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_boosts IS '插隊紀錄：誰、什麼時候、用什麼條件把哪些任務排到最前（一次性）。filter 的詞彙見 task_boost_matches。';
ALTER TABLE task_boosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_boosts_public_read ON task_boosts;
CREATE POLICY task_boosts_public_read ON task_boosts FOR SELECT USING (true);

/** 字串像 uuid 才轉，不然回 NULL（payload 是代理交的，politician_id 可能是 "unknown" 這種東西；一筆壞的不能讓整次插隊炸掉） */
CREATE OR REPLACE FUNCTION uuid_or_null(p_text TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::UUID ELSE NULL END;
$$;

/** 四位數年份才轉，不然回 NULL（同上：target／payload 裡的 election_id 是代理交的） */
CREATE OR REPLACE FUNCTION year_or_null(p_text TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~ '^\d{4}$' THEN p_text::INTEGER ELSE NULL END;
$$;

/** 一筆貢獻的主角人物（插隊用）：payload.politician_id，或更正對象反查 */
CREATE OR REPLACE FUNCTION contribution_subject_politician(p_payload JSONB) RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    uuid_or_null(p_payload->>'politician_id'),
    CASE p_payload->>'target_table'
      WHEN 'politicians' THEN uuid_or_null(p_payload->>'target_id')
      WHEN 'policies' THEN (SELECT p.politician_id FROM policies p WHERE p.id = uuid_or_null(p_payload->>'target_id'))
      WHEN 'politician_elections' THEN (SELECT pe.politician_id FROM politician_elections pe WHERE pe.id::TEXT = p_payload->>'target_id')
      ELSE NULL
    END,
    uuid_or_null(p_payload->>'keep_id')
  );
$$;

/**
 * 條件 → 符合的佇列鍵。filter 的鍵（全部可省略，同一筆內 AND）：
 *   regions        text[]   縣市（人物的 region 或任務的 region）
 *   election_id    int      屆別（任務 target 的 election_id，或人物在那一屆有參選紀錄）
 *   election_types text[]   層級（縣市長、縣市議員…；人物在 election_id（或任一屆）的參選紀錄）
 *   task_types     text[]   任務型別（驗證項目用 contribution_type 比）
 *   missing_avatar bool     人物沒有頭像
 *   politician_ids uuid[]   指定人物
 *   kinds          text[]   只插 'task'／'verify'（預設兩種都插）
 */
CREATE OR REPLACE FUNCTION task_boost_matches(p_filter JSONB)
RETURNS TABLE (task_id TEXT, kind TEXT)
LANGUAGE sql STABLE AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'regions' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'regions')) END AS regions,
      NULLIF(p_filter->>'election_id', '')::INT AS election_id,
      CASE WHEN p_filter ? 'election_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'election_types')) END AS election_types,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      COALESCE((p_filter->>'missing_avatar')::BOOLEAN, false) AS missing_avatar,
      CASE WHEN p_filter ? 'politician_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'politician_ids')::UUID) END AS politician_ids,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的主角、縣市、屆別、型別
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           year_or_null(g.target->>'election_id') AS election_id
      FROM contribution_auto_tasks_arms() g
    UNION ALL
    SELECT t.id::TEXT, 'task', t.task_type,
           uuid_or_null(t.target->>'politician_id'),
           COALESCE(t.region, t.target->>'region'),
           year_or_null(t.target->>'election_id')
      FROM contribution_tasks t WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           year_or_null(c.payload->>'election_id')
      FROM contributions c WHERE c.status = 'pending'
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
    LEFT JOIN politicians p ON p.id = s.politician_id
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.politician_ids IS NULL OR s.politician_id = ANY(f.politician_ids))
     AND (NOT f.missing_avatar OR (p.id IS NOT NULL AND COALESCE(p.avatar_url, '') = ''))
     AND (f.regions IS NULL OR COALESCE(s.region, p.region) = ANY(f.regions))
     AND (f.election_id IS NULL OR s.election_id = f.election_id
          OR (s.election_id IS NULL AND p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = f.election_id)))
     AND (f.election_types IS NULL OR (p.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_type::TEXT = ANY(f.election_types)
               AND (f.election_id IS NULL OR pe.election_id = f.election_id))));
$$;

/** 插隊：符合條件的排到最前（1980 年＋第 n 次插隊的分鐘數，先插的先派），回 {id, matched_tasks, matched_verifies} */
CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  -- 還沒發號碼牌的先發，不然排不到
  PERFORM seed_auto_task_queue();
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  v_at := TIMESTAMPTZ '1980-01-01' + (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  DELETE FROM _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  -- 手動任務的順序在 TS 用 last_dispatched_at 算（沒派過＝最前），這裡把它清成 NULL 就等於插到最前
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  UPDATE task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

/** 一筆插隊還剩多少沒領：跟當初條件再算一次，只數還在 1980 年那一段的 */
CREATE OR REPLACE FUNCTION task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND d.queue_at < TIMESTAMPTZ '1990-01-01'),
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.queue_at < TIMESTAMPTZ '1990-01-01')
  )
  FROM task_boosts b
  JOIN LATERAL task_boost_matches(b.filter) m ON true
  LEFT JOIN task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ------------------------------------------------------------
-- 切換：現有 pending 貢獻發號碼牌；原本硬編碼的 2026 縣市長優先改成第一筆插隊
-- ------------------------------------------------------------
SELECT seed_auto_task_queue();
SELECT task_boost('2026 縣市長 基本資料與政見（原硬編碼優先）', '{"election_id":2026,"election_types":["縣市長"],"task_types":["profile_gap","policy_missing"],"kinds":["task"]}'::jsonb, 'system', NULL);

DO $$
DECLARE n_verify INTEGER; n_front INTEGER;
BEGIN
  SELECT count(*) INTO n_verify FROM task_dispatches WHERE task_id LIKE 'verify:%';
  SELECT count(*) INTO n_front FROM task_dispatches WHERE queue_at < TIMESTAMPTZ '1990-01-01';
  IF n_verify = 0 THEN RAISE EXCEPTION '驗證項目沒有進佇列'; END IF;
  RAISE NOTICE '單一佇列：驗證列 % 筆；排在 1980 年段的 % 筆', n_verify, n_front;
END $$;
