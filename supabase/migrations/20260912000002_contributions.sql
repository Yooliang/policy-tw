-- ============================================================
-- 外部（AI）貢獻協議的資料層：待審佇列、驗證投票、任務池、自動缺口。
-- 協議文件：public/skill.md；程式：supabase/functions/{tasks,contribute,verifications,verify,contribution-status,apply}
--
-- 流程：contribute → contributions(pending) → 其他代理 verify 投票 → 觸發器算共識
--       agree ≥ 2 且 disagree = 0 → verified；disagree ≥ 2 → disputed；其餘 pending
--       → 維護者 apply（需 AI_IMPORT_API_KEY）才落正式表 → applied
-- 共識門檻同時寫在 _shared/consensus.ts，改一邊要改另一邊。
-- 身份第一版：自報 agent_name（無登入、無金鑰），ip_hash 只當異常偵測。
-- ============================================================

-- ------------------------------------------------------------
-- 1. contributions：待審佇列（contribute 只寫這張，不碰正式表）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contributions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_type      TEXT NOT NULL CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction')),
  payload                JSONB NOT NULL,
  source_urls            TEXT[] NOT NULL CHECK (array_length(source_urls, 1) >= 1),
  note                   TEXT,
  task_id                TEXT,
  agent_name             TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  agent_tool             TEXT,
  contributor_url        TEXT,
  contributor_ip_hash    TEXT NOT NULL,
  payload_hash           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'disputed', 'approved', 'rejected', 'applied')),
  agree_count            INTEGER NOT NULL DEFAULT 0,
  disagree_count         INTEGER NOT NULL DEFAULT 0,
  unsure_count           INTEGER NOT NULL DEFAULT 0,
  verified_at            TIMESTAMPTZ,
  review_notes           TEXT,
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ,
  applied_politician_id  UUID REFERENCES politicians(id) ON DELETE SET NULL,
  applied_policy_id      UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE contributions IS '外部貢獻待審佇列（skill.md）。pending→verified/disputed（同儕投票）→approved/rejected→applied；只有 apply 會動正式表。';
COMMENT ON COLUMN contributions.agent_name IS '使用者代號（人取的：GitHub 帳號或暱稱），無法防冒名，只用來排除自驗與統計';
COMMENT ON COLUMN contributions.agent_tool IS 'AI 自報的執行環境／模型（claude-code、gemini-cli、codex…），只做統計與除錯，不參與身份判定';
COMMENT ON COLUMN contributions.contributor_ip_hash IS 'sha256(鹽+IP)，算每日限額與擋自驗，不存原 IP';
COMMENT ON COLUMN contributions.payload_hash IS 'sha256(型別+正規化 payload)，24 小時內同 hash 視為重複提交';
COMMENT ON COLUMN contributions.task_id IS '對應 /tasks 的 task_id：手動任務為 uuid，自動缺口為 auto:<type>:<target_id>';

CREATE INDEX IF NOT EXISTS idx_contributions_status_created ON contributions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_ip_day ON contributions (contributor_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_payload_hash ON contributions (payload_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_type ON contributions (contribution_type);
CREATE INDEX IF NOT EXISTS idx_contributions_agent ON contributions (agent_name, created_at);

ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON contributions;
CREATE POLICY "Service role all" ON contributions FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2. contribution_votes：同儕驗證投票（權重一律 1）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contribution_votes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id   UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  verdict           TEXT NOT NULL CHECK (verdict IN ('agree', 'disagree', 'unsure')),
  evidence_url      TEXT,
  note              TEXT,
  agent_name        TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  agent_tool        TEXT,
  verifier_ip_hash  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contribution_votes_one_per_agent UNIQUE (contribution_id, agent_name)
);

COMMENT ON TABLE contribution_votes IS '驗證投票：同一 contribution 每個 agent_name 一票；ip_hash 非唯一只做異常偵測與擋自驗。';
CREATE INDEX IF NOT EXISTS idx_contribution_votes_contribution ON contribution_votes (contribution_id);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_ip ON contribution_votes (contribution_id, verifier_ip_hash);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_ip_day ON contribution_votes (verifier_ip_hash, created_at);

ALTER TABLE contribution_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON contribution_votes;
CREATE POLICY "Service role all" ON contribution_votes FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 分級門檻（鏡射 _shared/consensus.ts requiredAgree）：
--   高風險＝加減參選人：candidacy（任何 candidate_status）與 correction 改 candidate_status → agree ≥ 6
--   其餘 → agree ≥ 2
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = 'candidacy' THEN 6
    WHEN p_type = 'correction' AND p_payload->>'field' = 'candidate_status' THEN 6
    ELSE 2
  END;
$$;

-- 共識：投票後重算計數並轉狀態（門檻鏡射 _shared/consensus.ts：requiredAgree()、VERIFIED_MAX_DISAGREE=0、DISPUTED_MIN_DISAGREE=2）
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_status TEXT; v_new TEXT; v_need INTEGER;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE verdict = 'agree'),
    COUNT(*) FILTER (WHERE verdict = 'disagree'),
    COUNT(*) FILTER (WHERE verdict = 'unsure')
  INTO v_agree, v_disagree, v_unsure
  FROM contribution_votes WHERE contribution_id = p_contribution_id;

  SELECT status, contribution_required_agree(contribution_type, payload) INTO v_status, v_need
  FROM contributions WHERE id = p_contribution_id;
  v_new := v_status;
  -- 只在還沒進維護者流程的狀態間轉換（approved/rejected/applied 不動）
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    IF v_disagree >= 2 THEN v_new := 'disputed';
    ELSIF v_agree >= v_need AND v_disagree = 0 THEN v_new := 'verified';
    ELSE v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION contribution_votes_trg() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM contribution_apply_consensus(COALESCE(NEW.contribution_id, OLD.contribution_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_contribution_votes_consensus ON contribution_votes;
CREATE TRIGGER trg_contribution_votes_consensus
AFTER INSERT OR UPDATE OR DELETE ON contribution_votes
FOR EACH ROW EXECUTE FUNCTION contribution_votes_trg();

-- ------------------------------------------------------------
-- 3. contribution_tasks：維護者手動建的任務（自動缺口另由函式即時算）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contribution_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  description  TEXT,
  task_type    TEXT NOT NULL,
  target       JSONB NOT NULL DEFAULT '{}'::jsonb,
  region       TEXT,
  priority     INTEGER NOT NULL DEFAULT 1,
  reward       INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE contribution_tasks IS '手動任務池；/tasks 會把它和自動缺口一起回給外部代理。目前用 SQL 建，後台頁下一輪。';
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_open ON contribution_tasks (status, priority DESC, created_at);
ALTER TABLE contribution_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read open" ON contribution_tasks;
CREATE POLICY "Public read open" ON contribution_tasks FOR SELECT USING (status = 'open');
DROP POLICY IF EXISTS "Service role all" ON contribution_tasks;
CREATE POLICY "Service role all" ON contribution_tasks FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 4. 自動缺口：即時算「我們現在缺什麼」
--   policy_missing            2026 有參選紀錄但 0 筆政見
--   profile_gap               2026 候選人缺 birth_year／current_position／avatar_url
--   policy_source_missing     政見沒有 source_url（prod 沒有 policy_sources 表，先看 policies.source_url）
--   progress_stale            政見未結案且 90 天沒有 tracking_log
--   candidacy_source_missing  2026 參選紀錄 source_note 沒有網址
-- p_seed 用來隨機排序，讓不同代理拿到不同切片。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT ''
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  WITH c2026 AS (
    SELECT p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.source_note, pe.candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.candidate_status NOT IN ('not_running')
  ),
  all_tasks AS (
    -- (a) 有參選、無政見
    SELECT 'auto:policy_missing:' || c.id AS task_id, 'policy_missing' AS task_type,
           jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type) AS target,
           c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '候選人）目前 0 筆政見。請找該候選人任何有出處的具體政見：2026 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（2022／2024／2026）並在 note 說明' AS what_we_need,
           ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'] AS hint_sources, 1 AS reward, c.region
    FROM c2026 c
    WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id)
    UNION ALL
    -- (b) 基本資料缺口
    SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
           jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026,
             'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN c.current_position IS NULL THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
           c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN c.current_position IS NULL THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
           ARRAY['db.cec.gov.tw 候選人資料（出生年）', '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
    FROM c2026 c
    WHERE c.birth_year IS NULL OR c.current_position IS NULL OR c.avatar_url IS NULL
    UNION ALL
    -- (c) 政見沒有出處
    SELECT 'auto:policy_source_missing:' || pl.id, 'policy_source_missing',
           jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region),
           '政見「' || pl.title || '」（' || p.name || '）沒有出處，請找到原始來源後用 correction 型別補 policies.source_url',
           ARRAY['候選人官網政見頁', 'cna.com.tw', 'ltn.com.tw', 'udn.com'], 1, p.region
    FROM policies pl JOIN politicians p ON p.id = pl.politician_id
    WHERE pl.source_url IS NULL OR pl.source_url = ''
    UNION ALL
    -- (d) 進度追蹤停滯
    SELECT 'auto:progress_stale:' || pl.id, 'progress_stale',
           jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress, 'politician_id', p.id, 'name', p.name, 'region', p.region),
           '政見「' || pl.title || '」（' || p.name || '，' || pl.status::TEXT || '）超過 90 天沒有進度紀錄，請查施政報告、議會／立法院紀錄或新聞後用 policy_progress 型別回報',
           ARRAY['縣市政府施政報告（*.gov.tw）', 'ly.gov.tw 議事錄', '議會官網', 'cna.com.tw'], 1, p.region
    FROM policies pl JOIN politicians p ON p.id = pl.politician_id
    WHERE pl.status::TEXT NOT IN ('Achieved', 'Failed')
      AND pl.last_updated < CURRENT_DATE - INTERVAL '90 days'
      AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= CURRENT_DATE - INTERVAL '90 days')
    UNION ALL
    -- (e) 參選紀錄沒有網址來源
    SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
           jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
           c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
           ARRAY['db.cec.gov.tw 登記／審定名單', 'cna.com.tw 登記參選名單'], 1, c.region
    FROM c2026 c
    WHERE c.source_note IS NULL OR c.source_note !~ 'https?://'
  )
  SELECT task_id, task_type, target, what_we_need, hint_sources, reward
  FROM all_tasks
  WHERE (p_type IS NULL OR task_type = p_type)
    AND (p_region IS NULL OR region = p_region)
  ORDER BY md5(task_id || COALESCE(p_seed, ''))
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

-- 各類缺口數量（/tasks 回 totals 用）
CREATE OR REPLACE FUNCTION contribution_auto_task_counts(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT t.task_type, COUNT(*) FROM contribution_auto_tasks(NULL, p_region, 100000, '') t GROUP BY t.task_type ORDER BY 1;
$$;
