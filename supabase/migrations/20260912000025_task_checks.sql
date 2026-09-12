-- 「查過了，沒有東西可補」也是一種成果，要讓它留下痕跡。
--
-- 目前 applyNoChange 對 auto: 開頭的任務什麼都不做，只回一句「資料補齊後會自行
-- 消失」。但如果代理查證後的結論就是「補不到」——那筆政見的來源根本不存在、
-- 或那個人近期真的沒有新進度——缺口永遠不會消失，同一筆任務會被無限重派給每一個
-- 代理，每個人都白跑一次。外部代理實測回報這件事，稱之為「假性空跑」。
--
-- 修法：記下「這筆自動缺口被查過、結論是無異動」，冷卻期內不再派。
-- 冷卻期過了再出現，因為世界會變——今天查不到進度，三週後可能就有了。

CREATE TABLE IF NOT EXISTS task_checks (
  id              BIGSERIAL PRIMARY KEY,
  task_id         TEXT NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_name      TEXT,
  note            TEXT,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL
);
COMMENT ON TABLE task_checks IS '自動缺口任務被查過、結論是無異動的紀錄；冷卻期內不再派，避免每個代理重複查同一筆死路';
CREATE INDEX IF NOT EXISTS task_checks_task_idx ON task_checks (task_id, checked_at DESC);

ALTER TABLE task_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON task_checks;
CREATE POLICY "Public read" ON task_checks FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON task_checks;
CREATE POLICY "Service role write" ON task_checks FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION task_check_cooldown_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 14 $$;
COMMENT ON FUNCTION task_check_cooldown_days IS '查過且無異動的自動缺口，冷卻幾天後才重新派出';

-- ------------------------------------------------------------
-- 重構：缺口的定義抽成 _raw（沒有過濾、排序、上限），
-- contribution_auto_tasks 變成薄薄一層：套冷卻過濾 → 隨機排序 → 限筆數。
--
-- 這樣做的理由：冷卻過濾必須在 LIMIT 之前，否則會吃掉配額——要 12 筆、
-- 濾掉 3 筆就只剩 9 筆，而且會在還有幾百筆可派時回空。之前把缺口邏輯
-- 跟上限寫在同一支函式裡，已經害我為了改一行複製整支函式三次。
-- 以後改缺口只動 _raw。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH c2026 AS (
    SELECT p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.source_note, pe.candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.candidate_status NOT IN ('not_running')
  ),
  ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidate_status NOT IN ('not_running')
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:policy_missing:' || c.id, 'policy_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '候選人）目前 0 筆政見。請找該候選人任何有出處的具體政見：2026 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（2022／2024／2026）並在 note 說明',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 1, c.region
  FROM c2026 c
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL)
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN c.current_position IS NULL THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN c.current_position IS NULL THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['db.cec.gov.tw 候選人資料（出生年）', '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c2026 c
  WHERE c.birth_year IS NULL OR c.current_position IS NULL OR c.avatar_url IS NULL
  UNION ALL
  SELECT 'auto:policy_source_missing:' || pl.id, 'policy_source_missing',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region),
         '政見「' || pl.title || '」（' || p.name || '）沒有出處，請找到原始來源後用 correction 型別補 policies.source_url',
         ARRAY['候選人官網政見頁', 'cna.com.tw', 'ltn.com.tw', 'udn.com'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND (pl.source_url IS NULL OR pl.source_url = '')
  UNION ALL
  SELECT 'auto:progress_stale:' || pl.id, 'progress_stale',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress, 'politician_id', p.id, 'name', p.name, 'region', p.region),
         '政見「' || pl.title || '」（' || p.name || '，' || pl.status::TEXT || '）超過 90 天沒有進度紀錄，請查施政報告、議會／立法院紀錄或新聞後用 policy_progress 型別回報。查證後確定近期真的沒有新進度，就用 no_change 回報——那也是成果，會讓這筆暫時不再派給別人',
         ARRAY['縣市政府施政報告（*.gov.tw）', 'ly.gov.tw 議事錄', '議會官網', 'cna.com.tw'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL
    AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
    AND pl.last_updated < CURRENT_DATE - INTERVAL '90 days'
    AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= CURRENT_DATE - INTERVAL '90 days')
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
         ARRAY['db.cec.gov.tw 登記／審定名單', 'cna.com.tw 登記參選名單'], 1, c.region
  FROM c2026 c
  WHERE c.source_note IS NULL OR c.source_note !~ 'https?://'
  UNION ALL
  SELECT 'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type,
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', l.name, 'election_type', s.election_type,
                            'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。到中選會把該縣市這個選舉的候選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0)
           || ' 筆。中選會有、我們沒有的，每一位用 candidacy 型別補一筆；最後用 roster_check 型別回報這次清查（中選會共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。查不到官方名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址。',
         ARRAY['db.cec.gov.tw 候選人查詢', 'bulletin.cec.gov.tw 選舉公報', '該縣市選舉委員會官網'], 2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN LATERAL (
    SELECT MAX(checked_at) AS last_checked FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
$fn$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT ''
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM contribution_auto_tasks_raw() t
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻過濾必須在 LIMIT 之前，否則會吃掉配額
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
    )
  ORDER BY md5(t.task_id || COALESCE(p_seed, ''))
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
