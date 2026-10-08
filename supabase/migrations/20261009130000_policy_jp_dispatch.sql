-- 日本站（政策の系譜）派工與交件的 SQL：policy_jp schema（policy-jp 的 PR①a；接在 20261009000000_policy_jp_tables.sql 之後）
-- ============================================================
--
-- 做法：把正見（public）的派工佇列、啟用時間窗、計分共識、系統票的 SQL「抄」到 policy_jp，只做機械式替換——
--   * 函式本體逐字相同，差別只有一份固定清單（走樣守門 supabase/functions/_shared/policy-jp-dispatch-drift.test.ts 會把這裡的本體還原成 public 的現行定義逐字比對）：
--       - 物件名加 policy_jp. 前綴（表、函式、視圖）
--       - plpgsql 函式與觸發器函式：SET search_path = policy_jp, pg_temp（正見是 SECURITY DEFINER 的，這裡也是 SECURITY DEFINER，其餘維持 INVOKER）
--       - 時區 Asia/Taipei → Asia/Tokyo（activity_today 預設、固定時段插隊的時區）
--       - 選舉 id 的型別 integer → TEXT（日本站的 election id 是 election_key 字串）
--       - 每支函式各自的「拿掉台灣專用片段」，在守門測試的對照表裡逐支寫明（例：activity_open 拿掉村里長的排除職位、seed 拿掉流量提層、
--         contribution_effective_agree 拿掉中選會名冊那條路）
--   * 不是複本的（總表骨架、活動名、手動任務臂、里程碑視圖、健康檢查、election_id_or_null／activity_level／activity_jurisdiction）寫在這裡，
--     守門測試註明為什麼不比對。
--   * 台灣專用的都沒搬：中選會名冊／登記彙總（roster_*、cec_*）、號次（cand_no、ballot_numbers）、村里長與頁面流量提層（page_traffic、traffic_boost）、
--     測試名人物隔離（placeholder）、election_task_config、task_cooldown_settings、bulletin_watch、政策脈絡與其他 26 支臂。
--
-- 內容：16 張內部表（RLS 開、不給 anon／authenticated 任何權限、service_role 全權）、派工佇列與時間窗函式、計分共識與系統票（Jev）、
--   gap_events 觸發器、手動任務臂（manual_visitor／manual_open）、每 10 分鐘的 seed、每天一次的派工紀錄清理（pg_cron 不在就略過）。
--   貢獻型別只收 no_change／task_suggestion／correction；沒有 Edge Function、沒有 anon 可呼叫的函式（本 PR 不開放任何 RPC）。
--
-- 獨立於正見：這支 migration 不引用任何 public 物件（守門測試在一個完全沒有正見派工物件的資料庫上跑）。
-- 守門：supabase/functions/_shared/policy-jp-dispatch-drift.test.ts（走樣）、policy-jp-dispatch.test.ts（PGlite 行為）。
-- 函式本體是依正見現行定義機械式抄出來的（沒有留產生器，走樣守門就是檢查器）；之後正見改了這些函式，走樣守門會紅，提醒日本站跟著改。

-- ------------------------------------------------------------
-- 1. 表（全部內部表：開 RLS、不加任何 policy、不給 anon／authenticated 任何權限；寫入由 service_role，它有 BYPASSRLS）
-- ------------------------------------------------------------
-- 優先層（正見 20261008090000）：種子 6:3:1 與正見相同
CREATE TABLE IF NOT EXISTS policy_jp.task_priority_tiers (
  id         SMALLINT PRIMARY KEY CHECK (id BETWEEN 1 AND 9),
  label      TEXT NOT NULL,
  weight     INTEGER NOT NULL CHECK (weight > 0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS task_priority_tiers_one_default ON policy_jp.task_priority_tiers ((true)) WHERE is_default;
COMMENT ON TABLE policy_jp.task_priority_tiers IS '佇列的優先層（同正見）：id 越小越前面；weight＝任務行列裡的份額；is_default＝沒有規則相符時的層（只能一列）。規則與權重只走 migration';
INSERT INTO policy_jp.task_priority_tiers (id, label, weight, is_default, note) VALUES
  (1, '前段', 6, false, '投票日前 180 天內的選舉任務'),
  (2, '中段', 3, true,  '預設層：沒有選舉的任務、投票後 180 天內的任務'),
  (3, '後段', 1, false, '投票日後 181 天起的歷史補資料；保有 1/10，不會餓死')
ON CONFLICT (id) DO NOTHING;

-- 貢獻（待審佇列）：正見 contributions 加上之後所有 ALTER 的最終形狀。
-- 型別只收日本站用得到的三種（no_change、task_suggestion、correction），之後加型別要同時改這條 CHECK、TS 清單、skill.md、task-labels（CLAUDE.md「加新的貢獻型別」）。
-- applied_politician_id／applied_policy_id 在正見是 uuid（人物、政見 id）；日本站的人物與政見 id 是 TEXT，不加外鍵（落庫那一批 PR 再決定）。
-- 沒搬：batch_verified_by（中選會名冊整批驗證，台灣專用）。
CREATE TABLE IF NOT EXISTS policy_jp.contributions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_type     TEXT NOT NULL CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction')),
  payload               JSONB NOT NULL,
  source_urls           TEXT[] NOT NULL CHECK (array_length(source_urls, 1) >= 1),
  note                  TEXT,
  task_id               TEXT,
  agent_name            TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  agent_tool            TEXT,
  contributor_url       TEXT,
  contributor_ip_hash   TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'verified', 'disputed', 'rejected', 'applied', 'apply_failed', 'reverted', 'superseded', 'withdrawn')),
  agree_count           INTEGER NOT NULL DEFAULT 0,
  disagree_count        INTEGER NOT NULL DEFAULT 0,
  unsure_count          INTEGER NOT NULL DEFAULT 0,
  verified_at           TIMESTAMPTZ,
  review_notes          TEXT,
  reviewed_by           TEXT,
  reviewed_at           TIMESTAMPTZ,
  applied_politician_id TEXT,
  applied_policy_id     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at            TIMESTAMPTZ,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  next_retry_at         TIMESTAMPTZ,
  last_activity_at      TIMESTAMPTZ DEFAULT now(),
  last_activity         TEXT,
  actor_id              TEXT,
  via                   TEXT,
  score                 INTEGER NOT NULL DEFAULT 0,
  target_score          INTEGER,
  voter_ips             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contributions_status_created ON policy_jp.contributions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_ip_day ON policy_jp.contributions (contributor_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_payload_hash ON policy_jp.contributions (payload_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_type ON policy_jp.contributions (contribution_type);
CREATE INDEX IF NOT EXISTS idx_contributions_agent ON policy_jp.contributions (agent_name, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_retry ON policy_jp.contributions (next_retry_at) WHERE status = 'apply_failed';
CREATE INDEX IF NOT EXISTS contributions_task_id_status_idx ON policy_jp.contributions (task_id, status) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contributions_no_change_task_idx ON policy_jp.contributions ((payload->>'task_id')) WHERE contribution_type = 'no_change';
COMMENT ON TABLE policy_jp.contributions IS '外部貢獻待審佇列（日本站，正見 contributions 表的日本版）。pending→verified（計分共識）→applied；只有落庫會動正式表';
COMMENT ON COLUMN policy_jp.contributions.task_id IS '對應派工的 task_id：手動任務為 uuid，自動缺口為 auto:<type>:<target_id>';
COMMENT ON COLUMN policy_jp.contributions.score IS '累計分數（每個來源 IP 只算最新一票的 weight 之和）；目標見 contribution_effective_agree()';

CREATE TABLE IF NOT EXISTS policy_jp.contribution_votes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id        UUID NOT NULL REFERENCES policy_jp.contributions(id) ON DELETE CASCADE,
  verdict                TEXT NOT NULL CHECK (verdict IN ('agree', 'disagree', 'unsure')),
  evidence_url           TEXT,
  note                   TEXT,
  agent_name             TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  agent_tool             TEXT,
  verifier_ip_hash       TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_politician_id TEXT,
  actor_id               TEXT,
  judge_backed           BOOLEAN NOT NULL DEFAULT false,
  via                    TEXT,
  weight                 SMALLINT,
  evidence_checked_at    TIMESTAMPTZ,
  evidence_verdict       TEXT,
  CONSTRAINT contribution_votes_one_per_agent UNIQUE (contribution_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_contribution ON policy_jp.contribution_votes (contribution_id);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_ip ON policy_jp.contribution_votes (contribution_id, verifier_ip_hash);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_ip_day ON policy_jp.contribution_votes (verifier_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS contribution_votes_actor_idx ON policy_jp.contribution_votes (actor_id);
CREATE INDEX IF NOT EXISTS idx_contribution_votes_evidence_pending ON policy_jp.contribution_votes (created_at) WHERE evidence_url IS NOT NULL AND evidence_checked_at IS NULL;
COMMENT ON TABLE policy_jp.contribution_votes IS '驗證投票：同一貢獻每個 agent_name 一票；weight 由觸發器依 verdict 與 judge_backed 填';

-- 審計（activity_audit 寫、落庫的還原也用）
CREATE TABLE IF NOT EXISTS policy_jp.edit_history (
  id              BIGSERIAL PRIMARY KEY,
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  field           TEXT NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  contribution_id UUID REFERENCES policy_jp.contributions(id) ON DELETE SET NULL,
  agent_name      TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at     TIMESTAMPTZ,
  reverted_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_edit_history_contribution ON policy_jp.edit_history (contribution_id, id);
CREATE INDEX IF NOT EXISTS idx_edit_history_record ON policy_jp.edit_history (table_name, record_id);
COMMENT ON TABLE policy_jp.edit_history IS '變更紀錄（field=* 代表整列）；里程碑、規則、覆寫、優先層的審計觸發器也寫這裡';

CREATE TABLE IF NOT EXISTS policy_jp.contribution_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  description       TEXT,
  task_type         TEXT NOT NULL,
  target            JSONB NOT NULL DEFAULT '{}'::JSONB,
  region            TEXT,
  priority          INTEGER NOT NULL DEFAULT 1,
  reward            INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggested', 'web_request', 'auto_dispute')),
  suggested_by      TEXT,
  hint_sources      TEXT[] NOT NULL DEFAULT '{}',
  requester_ip_hash TEXT,
  closed_at         TIMESTAMPTZ,
  last_dispatched_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_open ON policy_jp.contribution_tasks (status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_source_status ON policy_jp.contribution_tasks (source, status);
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_requester_day ON policy_jp.contribution_tasks (requester_ip_hash, created_at);
CREATE INDEX IF NOT EXISTS contribution_tasks_adjudicate_idx ON policy_jp.contribution_tasks ((target->>'contribution_id')) WHERE task_type = 'adjudicate';
COMMENT ON TABLE policy_jp.contribution_tasks IS '手動任務池（維護者建、網站請求、外部提議、裁決）；open 的任務是派工臂 manual_visitor／manual_open';

CREATE TABLE IF NOT EXISTS policy_jp.contribution_task_leases (
  task_id      TEXT PRIMARY KEY,
  target_key   TEXT NOT NULL,
  agent_name   TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_leases_target_until ON policy_jp.contribution_task_leases (target_key, leased_until);
CREATE INDEX IF NOT EXISTS idx_task_leases_until ON policy_jp.contribution_task_leases (leased_until);

CREATE TABLE IF NOT EXISTS policy_jp.contribution_task_skips (
  task_id    TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  agent_name TEXT,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS contribution_task_skips_ip_idx ON policy_jp.contribution_task_skips (ip_hash, skipped_at DESC);

CREATE TABLE IF NOT EXISTS policy_jp.verify_dispatches (
  contribution_id UUID NOT NULL REFERENCES policy_jp.contributions(id) ON DELETE CASCADE,
  ip_hash         TEXT NOT NULL,
  agent_name      TEXT,
  dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS verify_dispatches_recent ON policy_jp.verify_dispatches (contribution_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS verify_dispatches_by_ip ON policy_jp.verify_dispatches (ip_hash, dispatched_at DESC);

CREATE TABLE IF NOT EXISTS policy_jp.task_checks (
  id              BIGSERIAL PRIMARY KEY,
  task_id         TEXT NOT NULL,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_name      TEXT,
  note            TEXT,
  contribution_id UUID REFERENCES policy_jp.contributions(id) ON DELETE SET NULL,
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('confirmed', 'unreachable', 'not_found'))
);
CREATE INDEX IF NOT EXISTS task_checks_task_idx ON policy_jp.task_checks (task_id, checked_at DESC);

-- Jev 判決紀錄（正見 jev_decisions 的最終形狀）。系統票（contribution_system_vote）讀它。
-- subject_id 是 TEXT（正見也是），人物、政見的 uuid 在這裡只是字串，沒有外鍵。
CREATE TABLE IF NOT EXISTS policy_jp.jev_decisions (
  id                BIGSERIAL PRIMARY KEY,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'vote', 'politician_election', 'news_item', 'politician')),
  subject_id        TEXT NOT NULL,
  question          TEXT NOT NULL CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience')),
  choice            TEXT NOT NULL,
  probability       NUMERIC(5, 4) NOT NULL CHECK (probability >= 0 AND probability <= 1),
  confidence        NUMERIC(5, 4) CHECK (confidence >= 0 AND confidence <= 1),
  probabilities     JSONB,
  model             TEXT NOT NULL,
  state             JSONB NOT NULL,
  cost_usd          NUMERIC(12, 8),
  asked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_hash        TEXT GENERATED ALWAYS AS (md5(state::TEXT)) STORED,
  requester_ip_hash TEXT,
  CONSTRAINT jev_decisions_once_per_state UNIQUE (subject_type, subject_id, question, model, state_hash)
);
CREATE INDEX IF NOT EXISTS jev_decisions_subject_idx ON policy_jp.jev_decisions (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS jev_decisions_question_prob_idx ON policy_jp.jev_decisions (question, probability DESC);
CREATE INDEX IF NOT EXISTS jev_decisions_requester_idx ON policy_jp.jev_decisions (requester_ip_hash, asked_at DESC);
COMMENT ON TABLE policy_jp.jev_decisions IS 'Jev（TypeSafe System One）判決紀錄；source_support 且機率達門檻的那筆是貢獻的「系統票」（contribution_system_vote）。寫入只走 service_role';

CREATE TABLE IF NOT EXISTS policy_jp.task_dispatches (
  task_id            TEXT PRIMARY KEY,
  last_dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_count     INTEGER NOT NULL DEFAULT 1,
  queue_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_type          TEXT,
  target             JSONB,
  what_we_need       TEXT,
  hint_sources       TEXT[],
  reward             INTEGER,
  region             TEXT,
  refreshed_at       TIMESTAMPTZ,
  blocked            BOOLEAN NOT NULL DEFAULT false,
  cooling            BOOLEAN NOT NULL DEFAULT false,
  verify_target      INTEGER,
  opened_at          TIMESTAMPTZ,
  opened_by          JSONB,
  priority           SMALLINT REFERENCES policy_jp.task_priority_tiers(id)
);
CREATE INDEX IF NOT EXISTS task_dispatches_queue_at_idx ON policy_jp.task_dispatches (queue_at, task_id);
COMMENT ON TABLE policy_jp.task_dispatches IS '派工佇列（同正見）：缺口與待驗證貢獻的唯一時間軸，queue_at 是唯一排序鍵；seed_auto_task_queue 每 10 分鐘對帳';
COMMENT ON COLUMN policy_jp.task_dispatches.opened_by IS '缺口是因為哪一筆資料被開出來的（basis／arm／rule_id／election_id／milestone_*／priority…）';
COMMENT ON COLUMN policy_jp.task_dispatches.priority IS '現在的優先層（seed 每輪重算）；NULL＝預設層';

CREATE TABLE IF NOT EXISTS policy_jp.gap_events (
  id                BIGSERIAL PRIMARY KEY,
  task_id           TEXT NOT NULL,
  task_type         TEXT,
  event             TEXT NOT NULL CHECK (event IN ('opened', 'closed', 'reopened')),
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id           BIGINT,
  election_id       TEXT,
  milestone_kind    TEXT,
  milestone_on_date DATE,
  reason            TEXT CHECK (reason IS NULL OR reason IN ('window', 'filled', 'override', 'rule_change')),
  detail            JSONB,
  priority          SMALLINT GENERATED ALWAYS AS (COALESCE((detail->>'priority')::SMALLINT, (detail->'opened_by'->>'priority')::SMALLINT)) STORED
);
CREATE INDEX IF NOT EXISTS gap_events_task_idx ON policy_jp.gap_events (task_id, at);
CREATE INDEX IF NOT EXISTS gap_events_at_idx ON policy_jp.gap_events (at);
COMMENT ON TABLE policy_jp.gap_events IS '缺口的開關流水，只增不刪（觸發器擋 UPDATE／DELETE／TRUNCATE）；rule_id 不設外鍵';

-- 里程碑：kind 是兩國共用詞彙（docs/PLAN-task-activation.md 第 6 節）扣掉 polling（投票日，來自 elections.election_date）與 term_*（任期起訖，日本版之後由任期表算，這支還沒有）。
-- 職位是日本站 elections.election_type 的八個值。
CREATE TABLE IF NOT EXISTS policy_jp.election_milestones (
  id            BIGSERIAL PRIMARY KEY,
  election_id   TEXT NOT NULL REFERENCES policy_jp.elections(id),
  kind          TEXT NOT NULL CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                              'bulletin_published', 'result_announced', 'certified')),
  election_type TEXT CHECK (election_type IS NULL OR election_type IN ('governor', 'mayor', 'ward_mayor', 'town_mayor', 'national_lower',
                                                                       'national_upper', 'pref_assembly', 'muni_assembly')),
  on_date       DATE NOT NULL,
  basis         TEXT NOT NULL CHECK (basis IN ('statutory', 'official', 'agent', 'override')),
  status        TEXT NOT NULL CHECK (status IN ('expected', 'announced', 'done')),
  source_id     BIGINT REFERENCES policy_jp.sources(id),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS election_milestones_uniq ON policy_jp.election_milestones (election_id, kind, (COALESCE(election_type, '')));
COMMENT ON TABLE policy_jp.election_milestones IS '每場選舉×里程碑一列（日期是當地時區 Asia/Tokyo 的日曆日）。election_type 空＝整場。投票日不存這裡，由視圖 election_milestones_all 併入';

CREATE TABLE IF NOT EXISTS policy_jp.activity_rules (
  id             BIGSERIAL PRIMARY KEY,
  activity       TEXT NOT NULL,
  window_kind    TEXT NOT NULL CHECK (window_kind IN ('event', 'always')),
  from_kind      TEXT CHECK (from_kind IS NULL OR from_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                                                 'bulletin_published', 'polling', 'result_announced', 'certified')),
  from_offset    INTEGER NOT NULL DEFAULT 0,
  until_kind     TEXT CHECK (until_kind IS NULL OR until_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                                                  'bulletin_published', 'polling', 'result_announced', 'certified')),
  until_offset   INTEGER NOT NULL DEFAULT 0,
  min_status     TEXT NOT NULL DEFAULT 'announced' CHECK (min_status IN ('expected', 'announced', 'done')),
  recur_months   INT4RANGE,
  reasons        TEXT[],
  levels         TEXT[],
  election_types TEXT[],
  jurisdictions  TEXT[],
  params         JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority       SMALLINT REFERENCES policy_jp.task_priority_tiers(id),
  CONSTRAINT activity_rules_levels_known CHECK (levels IS NULL OR levels <@ ARRAY['national', 'regional', 'local']::TEXT[]),
  CONSTRAINT activity_rules_positions_known CHECK (
    election_types IS NULL OR election_types <@ ARRAY['governor', 'mayor', 'ward_mayor', 'town_mayor', 'national_lower', 'national_upper', 'pref_assembly', 'muni_assembly']::TEXT[]
  ),
  -- 窗口的形狀（同正見去掉 term／recurring：它們掛 term_start／term_end 里程碑，日本版還沒有）
  CONSTRAINT activity_rules_shape CHECK (
    (window_kind = 'always' AND from_kind IS NULL AND until_kind IS NULL AND recur_months IS NULL)
    OR (window_kind = 'event' AND (from_kind IS NOT NULL OR until_kind IS NOT NULL) AND recur_months IS NULL)
  ),
  CONSTRAINT activity_rules_priority_namespace CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS activity_rules_activity_idx ON policy_jp.activity_rules (activity) WHERE enabled;
COMMENT ON TABLE policy_jp.activity_rules IS '每支派工臂一到多條「里程碑＋偏移天數」的規則（同正見）。規則只走 migration；沒有 except_election_types／requires_traffic（村里長與流量開窗是台灣專用）';

CREATE TABLE IF NOT EXISTS policy_jp.activity_overrides (
  id            BIGSERIAL PRIMARY KEY,
  activity      TEXT NOT NULL,
  election_id   TEXT REFERENCES policy_jp.elections(id),
  election_type TEXT CHECK (election_type IS NULL OR election_type IN ('governor', 'mayor', 'ward_mayor', 'town_mayor', 'national_lower',
                                                                       'national_upper', 'pref_assembly', 'muni_assembly')),
  "force"       TEXT NOT NULL CHECK ("force" IN ('open', 'closed', 'window')),
  open_from     DATE,
  open_until    DATE,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    DATE,
  CONSTRAINT activity_overrides_window_dates CHECK (
    ("force" = 'window' AND (open_from IS NOT NULL OR open_until IS NOT NULL) AND (open_from IS NULL OR open_until IS NULL OR open_from <= open_until))
    OR ("force" <> 'window' AND open_from IS NULL AND open_until IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS activity_overrides_activity_idx ON policy_jp.activity_overrides (activity);
COMMENT ON TABLE policy_jp.activity_overrides IS '例外覆寫（絕對日期只在這裡，reason 必填）：closed 優先於一切、open 一律開、window 取代規則';

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_today(p_tz TEXT DEFAULT 'Asia/Tokyo') RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.activity_today', true), '')::DATE, (now() AT TIME ZONE p_tz)::DATE)
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_status_rank(p_status TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status WHEN 'expected' THEN 1 WHEN 'announced' THEN 2 WHEN 'done' THEN 3 ELSE 0 END
$$;

-- 日本版自己的小函式（不是正見的複本，不進走樣守門）
-- 選舉 id：日本站的 election id 是 TEXT（election_key），正見是 integer；target 裡的 election_id 空字串當沒有
CREATE OR REPLACE FUNCTION policy_jp.election_id_or_null(p_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT NULLIF(btrim(p_id), '')
$$;
COMMENT ON FUNCTION policy_jp.election_id_or_null IS '派工 target 裡的 election_id（TEXT）；空字串＝沒有。正見的同名函式回 integer，日本版 id 是 election_key 字串';

-- 層級：讀 policy_jp.election_level（職位 → national／regional／local，tables migration 的單一真相）
CREATE OR REPLACE FUNCTION policy_jp.activity_level(p_election_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT policy_jp.election_level(p_election_type)
$$;

-- 管轄：日本站的選舉列自己帶 jurisdiction（CHECK 固定 'jp'）；選舉不存在就是 NULL
CREATE OR REPLACE FUNCTION policy_jp.activity_jurisdiction(p_election_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT e.jurisdiction FROM policy_jp.elections e WHERE e.id = p_election_id
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_audit() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(NEW)->>'id', '*', NULL, to_jsonb(NEW), 'activity-audit');
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(NEW)->>'id', '*', to_jsonb(OLD), to_jsonb(NEW), 'activity-audit');
    RETURN NEW;
  ELSE
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(OLD)->>'id', '*', to_jsonb(OLD), NULL, 'activity-audit');
    RETURN OLD;
  END IF;
END;
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 抄自 20261008060000_activity_windows_p1.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_require_rule(p_arm TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = p_arm) THEN
    RAISE EXCEPTION '派工臂「%」在 activity_rules 沒有任何規則：總表加了新分支，要同時加進 policy_jp.activity_arm_names() 並種一條規則（PLAN-task-activation 3.1）', p_arm;
  END IF;
  RETURN true;
END;
$$;

-- 規則讀的里程碑全貌：存的里程碑＋投票日（policy_jp.elections.election_date）。
-- 沒有 term_start／term_end：正見靠 election_term_start／end() 算任期起訖，日本版的任期要從 politician_offices 來（各自治体各職位不同），還沒做；
-- 沒有任期里程碑時，掛 term_* 的規則根本寫不進來（activity_rules 的 CHECK 擋）。timezone 一律 Asia/Tokyo（activity_today 的預設）。
CREATE OR REPLACE VIEW policy_jp.election_milestones_all WITH (security_invoker = true) AS
  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,
         'table'::TEXT AS origin, m.id AS milestone_id
    FROM policy_jp.election_milestones m
  UNION ALL
  SELECT e.id, 'polling'::TEXT, NULL::TEXT, e.election_date, 'official'::TEXT,
         CASE WHEN e.election_date < policy_jp.activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM policy_jp.elections e
   WHERE e.election_date IS NOT NULL;
COMMENT ON VIEW policy_jp.election_milestones_all IS '規則讀的里程碑全貌：election_milestones（origin=table）＋投票日 polling（來自 elections.election_date，不重複存）。日本版還沒有 term_start／term_end';

-- 抄自 20261009010000_village_chief_progress_cooling.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_open(
  p_activity TEXT, p_election_id TEXT DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT policy_jp.activity_today()
) RETURNS TABLE (
  source TEXT, rule_id BIGINT, override_id BIGINT, election_id TEXT, election_type TEXT,
  milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE
)
LANGUAGE sql STABLE AS $$
  WITH el AS (SELECT e.id, e.election_reason FROM policy_jp.elections e WHERE e.id = p_election_id),
  ov AS (
    SELECT o.id, o."force", o.open_from, o.open_until
      FROM policy_jp.activity_overrides o
     WHERE o.activity = p_activity
       AND (o.election_id IS NULL OR o.election_id = p_election_id)
       AND (o.election_type IS NULL OR o.election_type = p_election_type)
       AND (o.expires_at IS NULL OR p_today <= o.expires_at)
  ),
  ov_open AS (
    SELECT o.* FROM ov o
     WHERE o."force" = 'open'
        OR (o."force" = 'window' AND (o.open_from IS NULL OR p_today >= o.open_from) AND (o.open_until IS NULL OR p_today <= o.open_until))
  ),
  rule_rows AS (
    SELECT r.id AS rid, f.kind AS mkind, f.on_date AS mdate,
           CASE WHEN f.on_date IS NOT NULL THEN f.on_date + r.from_offset END AS xopen,
           CASE WHEN u.on_date IS NOT NULL THEN u.on_date + r.until_offset END AS xuntil
      FROM policy_jp.activity_rules r
      LEFT JOIN el ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM policy_jp.election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.from_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM policy_jp.election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.until_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) u ON true
     WHERE r.enabled
       AND r.activity = p_activity
       AND (r.reasons IS NULL OR el.election_reason = ANY (r.reasons))
       AND (r.levels IS NULL OR policy_jp.activity_level(p_election_type) = ANY (r.levels))
       AND (r.election_types IS NULL OR p_election_type = ANY (r.election_types))
       AND (r.jurisdictions IS NULL OR EXISTS (
              SELECT 1 FROM unnest(r.jurisdictions) AS j(x)
               WHERE policy_jp.activity_jurisdiction(p_election_id) = j.x OR policy_jp.activity_jurisdiction(p_election_id) LIKE j.x || ':%'))
       AND (
         r.window_kind = 'always'
         OR (
           (r.from_kind IS NULL OR (f.on_date IS NOT NULL AND p_today >= f.on_date + r.from_offset))
           AND (r.until_kind IS NULL OR (u.on_date IS NOT NULL AND p_today <= u.on_date + r.until_offset))
           AND (r.recur_months IS NULL OR EXTRACT(MONTH FROM p_today)::INTEGER <@ r.recur_months)
           AND policy_jp.activity_status_rank(CASE WHEN r.from_kind IS NOT NULL THEN f.status ELSE u.status END) >= policy_jp.activity_status_rank(r.min_status)
         )
       )
  )
  SELECT x.source, x.rule_id, x.override_id, x.election_id, x.election_type, x.milestone_kind, x.milestone_on_date, x.expected_open_on, x.open_until
    FROM (
      SELECT 'override'::TEXT AS source, NULL::BIGINT AS rule_id, o.id AS override_id, p_election_id AS election_id, p_election_type AS election_type,
             NULL::TEXT AS milestone_kind, NULL::DATE AS milestone_on_date, o.open_from AS expected_open_on, o.open_until AS open_until
        FROM ov_open o
       WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov."force" = 'closed')
      UNION ALL
      SELECT 'rule'::TEXT, rr.rid, NULL::BIGINT, p_election_id, p_election_type, rr.mkind, rr.mdate, rr.xopen, rr.xuntil
        FROM rule_rows rr
       WHERE NOT EXISTS (SELECT 1 FROM ov)
    ) x
   ORDER BY x.expected_open_on NULLS LAST, x.rule_id NULLS LAST, x.override_id NULLS LAST
$$;

-- 抄自 20261008090000_queue_priority_tiers.sql
CREATE OR REPLACE FUNCTION policy_jp.activity_priority(
  p_activity TEXT, p_election_id TEXT DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT policy_jp.activity_today()
) RETURNS TABLE (priority SMALLINT, rule_id BIGINT, milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE)
LANGUAGE sql STABLE AS $$
  WITH hit AS (
    SELECT r.priority AS tier, o.rule_id AS rid, o.milestone_kind AS mk, o.milestone_on_date AS md, o.expected_open_on AS xo
      FROM (SELECT * FROM policy_jp.activity_open('priority:' || p_activity, p_election_id, p_election_type, p_today)
            UNION ALL SELECT * FROM policy_jp.activity_open('priority:*', p_election_id, p_election_type, p_today)) o
      JOIN policy_jp.activity_rules r ON r.id = o.rule_id
     WHERE r.priority IS NOT NULL
     ORDER BY r.priority DESC, o.rule_id
     LIMIT 1
  )
  SELECT h.tier, h.rid, h.mk, h.md, h.xo FROM hit h
  UNION ALL
  SELECT t.id, NULL::BIGINT, NULL::TEXT, NULL::DATE, NULL::DATE FROM policy_jp.task_priority_tiers t WHERE t.is_default AND NOT EXISTS (SELECT 1 FROM hit)
$$;

-- 活動名（派工臂登記）：日本版只有兩支臂，都是手動任務臂。新增臂要三處一起加（同正見）：總表分支、這裡、activity_rules 種一條規則
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open'
  ]::TEXT[]
$$;


-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.queue_now() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.queue_now', true), '')::TIMESTAMPTZ, now())
$$;

-- 抄自 20260924000002_queue_ratio.sql
CREATE OR REPLACE FUNCTION policy_jp.queue_slot(p_kind TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(now(), COALESCE((
           SELECT max(d.queue_at) FROM policy_jp.task_dispatches d
            WHERE d.queue_at >= TIMESTAMPTZ '2000-01-01'
              AND CASE WHEN p_kind = 'verify' THEN d.task_id LIKE 'verify:%' ELSE d.task_id NOT LIKE 'verify:%' END
         ), now()))
         + CASE WHEN p_kind = 'verify' THEN INTERVAL '1 second' ELSE INTERVAL '2 seconds' END
$$;

-- 抄自 20260924000002_queue_ratio.sql
CREATE OR REPLACE FUNCTION policy_jp.task_dispatched(p_task_id TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  VALUES (p_task_id, now(), policy_jp.queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END), 1)
  ON CONFLICT (task_id) DO UPDATE
    SET last_dispatched_at = now(),
        queue_at = policy_jp.queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END),
        dispatch_count = task_dispatches.dispatch_count + 1
$$;

-- 抄自 20260921000021_score_consensus.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_vote_weight(p_verdict TEXT, p_judge_backed BOOLEAN) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_verdict = 'agree'    THEN CASE WHEN COALESCE(p_judge_backed, false) THEN 2 ELSE 1 END
    WHEN p_verdict = 'disagree' THEN CASE WHEN COALESCE(p_judge_backed, false) THEN -2 ELSE -1 END
    ELSE 0 END)::SMALLINT
$$;

-- 抄自 20260923000007_reject_floor.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_reject_floor(p_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 2
    ELSE 3
  END;
$$;

-- 抄自 20261006141600_reassign_candidacy.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('merge_politician', 'candidacy', 'removal', 'reassign_candidacy')
$$;

-- 抄自 20261006141500_election_results_batch.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_risk TEXT;
BEGIN
  v_risk := CASE
    WHEN p_type IN ('task_suggestion', 'no_change') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN 3
    WHEN v_risk = 'light' THEN 2
    ELSE 3
  END;
END;
$$;

-- 抄自 20260919000002_system_one_task_priority.sql
CREATE OR REPLACE FUNCTION policy_jp.system_one_min_probability() RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$ SELECT 0.95::NUMERIC $$;

-- 抄自 20261006141600_reassign_candidacy.sql
CREATE OR REPLACE FUNCTION policy_jp.system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress', 'election_results', 'reassign_candidacy')
$$;

-- 抄自 20260924000010_moi_officials.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_system_vote(p_contribution_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT j.choice
  FROM policy_jp.jev_decisions j
  JOIN policy_jp.contributions c ON c.id = p_contribution_id
  WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT
    AND j.question = 'source_support'
    AND j.choice IN ('supported', 'not_supported')
    AND j.probability >= policy_jp.system_one_min_probability()
    AND (policy_jp.system_vote_eligible(c.contribution_type) OR j.model LIKE 'policy-tw/moi-check%')
  ORDER BY j.asked_at DESC
  LIMIT 1
$$;

-- 抄自 20261001000001_roster_match_target.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_effective_agree(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE v_need INTEGER; v_sys TEXT;
BEGIN
  SELECT policy_jp.contribution_required_agree(contribution_type, payload, source_urls) INTO v_need
  FROM policy_jp.contributions WHERE id = p_contribution_id;
  IF v_need IS NULL THEN RETURN NULL; END IF;
  v_sys := policy_jp.contribution_system_vote(p_contribution_id);
  RETURN CASE WHEN v_sys = 'supported' THEN GREATEST(1, v_need - 1)
              WHEN v_sys = 'not_supported' THEN v_need + 1
              ELSE v_need END;
END;
$$;

-- 抄自 20261006034900_policy_lineages.sql
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

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM policy_jp.contributions WHERE id = p_contribution_id;
  v_target := COALESCE(policy_jp.contribution_effective_agree(p_contribution_id), 2);
  v_reject := policy_jp.contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
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
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 抄自 20260924000002_queue_ratio.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_queue_at(p_contribution_type TEXT, p_task_id TEXT, p_created_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_contribution_type = 'question_answer' THEN TIMESTAMPTZ '1970-01-01'
    WHEN EXISTS (SELECT 1 FROM policy_jp.contribution_tasks t WHERE t.id::TEXT = p_task_id AND t.source = 'web_request') THEN TIMESTAMPTZ '1970-01-01'
    ELSE policy_jp.queue_slot('verify')
  END;
$$;

-- 抄自 20260920000004_task_dispatch_order.sql
CREATE OR REPLACE FUNCTION policy_jp.task_target_key(p_task_id TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_target->>'policy_id' IS NOT NULL THEN 'policy:' || (p_target->>'policy_id')
              WHEN p_target->>'politician_id' IS NOT NULL THEN 'politician:' || (p_target->>'politician_id')
              ELSE 'task:' || p_task_id END
$$;

-- 抄自 20260912000025_task_checks.sql
CREATE OR REPLACE FUNCTION policy_jp.task_check_cooldown_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 14 $$;

-- 抄自 20260921000006_no_change_outcome.sql
CREATE OR REPLACE FUNCTION policy_jp.task_unreachable_cooldown_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;

-- 抄自 20261002000006_queue_pop_head.sql
CREATE OR REPLACE FUNCTION policy_jp.refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  WITH saturated AS (
    SELECT c.task_id FROM policy_jp.contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM policy_jp.contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
  )
  , cool AS (
    SELECT DISTINCT tc.task_id FROM policy_jp.task_checks tc
    WHERE tc.checked_at > now() - (
      CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days'
    )::INTERVAL
  )
  UPDATE policy_jp.task_dispatches d
     SET blocked = EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id),
         cooling = EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id)
   WHERE d.task_id LIKE 'auto:%'
     AND (d.blocked IS DISTINCT FROM EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)
       OR d.cooling IS DISTINCT FROM EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 抄自 20261002000007_verify_pool_from_snapshot.sql
CREATE OR REPLACE FUNCTION policy_jp.refresh_verify_targets() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE policy_jp.task_dispatches d
     SET verify_target = policy_jp.contribution_effective_agree(c.id)
    FROM policy_jp.contributions c
   WHERE d.task_id LIKE 'verify:%'
     AND c.id = substring(d.task_id FROM 8)::uuid
     AND c.status = 'pending'
     AND c.target_score IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM policy_jp.task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面兩項跟「是誰來領」有關，排程算不了；只對照時間走到的那幾筆查，到 p_limit 就停
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = policy_jp.task_target_key(d.task_id, d.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_queue_task_counts(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT t.task_type, COUNT(*) FROM policy_jp.contribution_queue_tasks(NULL, p_region, 100000, '') t GROUP BY t.task_type ORDER BY 1;
$$;

-- 抄自 20261002000006_queue_pop_head.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM policy_jp.task_dispatches d
  WHERE d.task_id LIKE 'auto:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面兩項跟「是誰來領」有關，排程算不了；只對照時間走到的那幾筆查，到 p_limit 就停
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = policy_jp.task_target_key(d.task_id, d.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM policy_jp.contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

-- 抄自 20261006034900_policy_lineages.sql
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

-- 抄自 20260912000005_task_leases.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_task_leases_purge() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM policy_jp.contribution_task_leases WHERE leased_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.visitor_front_slot_hours() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.visitor_front_window_minutes() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.visitor_front_at() RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$ SELECT TIMESTAMPTZ '1970-01-01 00:00:00+00' $$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.visitor_front_slot_start(p_now TIMESTAMPTZ DEFAULT policy_jp.queue_now(), p_tz TEXT DEFAULT 'Asia/Tokyo') RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN extract(hour FROM l.t)::INTEGER % policy_jp.visitor_front_slot_hours() = 0
               AND extract(minute FROM l.t)::INTEGER < policy_jp.visitor_front_window_minutes()
              THEN date_trunc('hour', l.t) AT TIME ZONE p_tz END
    FROM (SELECT p_now AT TIME ZONE p_tz AS t) l
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.manual_task_is_visitor(p_source TEXT, p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_source = 'web_request', false) OR COALESCE(p_task_type = 'question', false) $$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.manual_front_at(p_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN policy_jp.manual_task_is_visitor(t.source, t.task_type) THEN policy_jp.visitor_front_at()
              WHEN t.source IN ('manual', 'auto_dispute') THEN TIMESTAMPTZ '1980-01-01 00:00:00+00' END
    FROM policy_jp.contribution_tasks t WHERE t.id::TEXT = p_task_id
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.manual_task_closes_on_applied(p_task_id TEXT, p_contribution_type TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.contribution_tasks t
                  WHERE t.id::TEXT = p_task_id AND t.status = 'open'
                    AND t.task_type NOT IN ('question', 'adjudicate', 'roster_check')
                    AND p_contribution_type NOT IN ('no_change', 'adjudication', 'task_suggestion', 'question_answer', 'roster_check'))
$$;

-- 臂本體：open 的手動任務（正見版的簡化：日本站沒有公民提問，所以沒有 stance_up 與「已收滿答案」的排除，也沒有 question_answer_cap）
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_manual(p_visitor BOOLEAN, p_id UUID DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT t.id::TEXT, t.task_type,
         jsonb_strip_nulls(jsonb_build_object('title', t.title, 'region', t.region)) || t.target,
         COALESCE(NULLIF(t.description, ''), t.title), t.hint_sources, t.reward, t.region
    FROM policy_jp.contribution_tasks t
   WHERE t.status = 'open' AND policy_jp.manual_task_is_visitor(t.source, t.task_type) = p_visitor
     AND (p_id IS NULL OR t.id = p_id)
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_manual IS '派工臂 manual_visitor（p_visitor＝true：網站請求）／manual_open（false：其餘）：contribution_tasks 裡 open 的任務。task_id＝任務 uuid，關閉＝缺口消失。p_id 只取那一筆';

-- 總表骨架：正見的 contribution_auto_tasks_arms 結構（tagged → keyed → opened → 窗口過濾，含 gap.arms_all 旗標），分支只有兩支手動任務臂。
-- 拿掉的都是台灣專用：測試名人物隔離（ph／phe）、村里長的 needs_etype 與流量開窗（page_traffic_hot）、raw／deadline_due 與 26 支臂。
-- election_id 是 TEXT，所以比對用 COALESCE(…, '') 而不是 -1。
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
  SELECT 'manual_visitor' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(false) t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, policy_jp.election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE policy_jp.activity_require_rule(x.arm) OFFSET 0) k
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM policy_jp.activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, '') = COALESCE(g.eid, '') AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_arms IS '派工總表（日本版骨架）：各臂的缺口貼臂名 → 對「臂×選舉×職位」問 activity_open → 窗口沒開的濾掉（gap.arms_all=on 時多回傳被濾掉的列，opened_by 是 NULL，只有 seed 用）。目前只有兩支手動任務臂';

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_slot TIMESTAMPTZ := policy_jp.visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  UPDATE policy_jp.task_dispatches d SET queue_at = policy_jp.visitor_front_at()
   WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.queue_at <> policy_jp.visitor_front_at();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 抄自 20261009040000_seed_skip_unchanged.sql
CREATE OR REPLACE FUNCTION policy_jp.rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM policy_jp.contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM policy_jp.task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id
     AND d.queue_at IS DISTINCT FROM v_start + v.rn * INTERVAL '1 second'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM policy_jp.task_priority_tiers x WHERE x.is_default)) AS tier
      FROM policy_jp.task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k FROM w
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN policy_jp.task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM policy_jp.task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;

-- 抄自 20261009040000_seed_skip_unchanged.sql
CREATE OR REPLACE FUNCTION policy_jp.seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM policy_jp.contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先層：每個缺口現在在哪一層（每組「臂×選舉×職位」問一次）
  ALTER TABLE _gaps ADD COLUMN priority SMALLINT, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority = p.priority, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.priority, x.rule_id
            FROM (SELECT DISTINCT y.arm, policy_jp.election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL policy_jp.activity_priority(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM policy_jp.election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先層

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE policy_jp.task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先層：既有的派工列跟著規則換層（排隊時間不動；下一步的 rebalance 依新的層交錯）
  UPDATE policy_jp.task_dispatches d SET priority = g.priority
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層

  -- 新缺口排進任務行列
  v_base := policy_jp.queue_slot('task');
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority)
  SELECT g.task_id, now(), COALESCE(CASE WHEN g.arm LIKE 'manual\_%' THEN policy_jp.manual_front_at(g.task_id) END,
                                    v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds'), 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), policy_jp.contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM policy_jp.contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）
  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM policy_jp.refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM policy_jp.refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM policy_jp.manual_front_pull();
  -- <<< 固定時段插隊
  PERFORM policy_jp.rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_gap_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  NEW.opened_at := COALESCE(NEW.opened_at, now());
  NEW.opened_by := COALESCE(NEW.opened_by, jsonb_build_object('basis', COALESCE(NULLIF(current_setting('gap.open_basis', true), ''), 'insert')));
  RETURN NEW;
END;
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_gap_after_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  INSERT INTO policy_jp.gap_events (task_id, task_type, event, at, rule_id, election_id, milestone_kind, milestone_on_date, detail)
  VALUES (NEW.task_id, NEW.task_type,
          CASE WHEN EXISTS (SELECT 1 FROM policy_jp.gap_events e WHERE e.task_id = NEW.task_id) THEN 'reopened' ELSE 'opened' END,
          NEW.opened_at, (NEW.opened_by->>'rule_id')::BIGINT, (NEW.opened_by->>'election_id')::TEXT,
          NEW.opened_by->>'milestone_kind', (NEW.opened_by->>'milestone_on_date')::DATE, NEW.opened_by);
  RETURN NEW;
END;
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_gap_after_delete() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
DECLARE v_reason TEXT; v_extra JSONB;
BEGIN
  v_reason := COALESCE(NULLIF(current_setting('gap.close_reason', true), ''), 'filled');
  v_extra := COALESCE(NULLIF(current_setting('gap.close_detail', true), '')::JSONB, '{}'::JSONB);
  IF v_reason NOT IN ('window', 'filled', 'override', 'rule_change') THEN
    v_extra := v_extra || jsonb_build_object('reason_raw', v_reason);
    v_reason := 'filled';
  END IF;
  INSERT INTO policy_jp.gap_events (task_id, task_type, event, at, rule_id, election_id, milestone_kind, milestone_on_date, reason, detail)
  VALUES (OLD.task_id, OLD.task_type, 'closed', now(), (OLD.opened_by->>'rule_id')::BIGINT, (OLD.opened_by->>'election_id')::TEXT,
          OLD.opened_by->>'milestone_kind', (OLD.opened_by->>'milestone_on_date')::DATE, v_reason,
          jsonb_build_object('opened_at', OLD.opened_at, 'opened_by', OLD.opened_by) || v_extra);
  RETURN OLD;
END;
$$;

-- 抄自 20261008001000_activity_windows_p0.sql
CREATE OR REPLACE FUNCTION policy_jp.gap_events_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'gap_events 只增不刪（PLAN-task-activation 2.5）：不能 %', TG_OP;
END;
$$;

-- 抄自 20260921000030_single_queue_boosts.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_queue_row() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
    VALUES ('verify:' || NEW.id, now(), policy_jp.contribution_queue_at(NEW.contribution_type, NEW.task_id, NEW.created_at), 0)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

-- 抄自 20260912000002_contributions.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_votes_trg() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM policy_jp.contribution_apply_consensus(COALESCE(NEW.contribution_id, OLD.contribution_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 抄自 20260921000021_score_consensus.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_votes_set_weight() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  NEW.weight := policy_jp.contribution_vote_weight(NEW.verdict, NEW.judge_backed);
  RETURN NEW;
END;
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_drop_applied() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND (
       (NEW.task_id LIKE 'auto:%')
       -- 手動任務（task_id＝任務 uuid）：這筆貢獻上線就算做完的才收回（判斷同 TS 的 shouldCloseOnApplied；公民提問、裁決、名單清查是一題多份，不收）
       OR policy_jp.manual_task_closes_on_applied(NEW.task_id, NEW.contribution_type)) THEN
    -- >>> gap_events：收回原因與是哪一筆貢獻，交給 task_dispatches 的 AFTER DELETE 觸發器記進 closed 事件
    PERFORM set_config('gap.close_reason', 'filled', true);
    PERFORM set_config('gap.close_detail', jsonb_build_object('via', 'drop_applied', 'contribution_id', NEW.id)::TEXT, true);
    -- <<< gap_events
    DELETE FROM policy_jp.task_dispatches WHERE task_id = NEW.task_id;
    -- >>> gap_events：用完就清，不影響同一個交易裡之後的刪除
    PERFORM set_config('gap.close_reason', '', true);
    PERFORM set_config('gap.close_detail', '', true);
    -- <<< gap_events
  END IF;
  RETURN NEW;
END;
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_tasks_drop_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM set_config('gap.close_detail', '{"via":"task_closed"}', true);
  DELETE FROM policy_jp.task_dispatches WHERE task_id = OLD.id::TEXT;
  PERFORM set_config('gap.close_detail', '', true);
  RETURN NULL;
END;
$$;

-- 抄自 20261008165000_manual_tasks_as_arm.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority)
  SELECT m.task_id, now(), COALESCE(policy_jp.manual_front_at(m.task_id), policy_jp.queue_slot('task')), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         (SELECT x.priority FROM policy_jp.activity_priority(CASE WHEN policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1)
    FROM policy_jp.contribution_auto_tasks_manual(policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

-- 規則寫錯會讓整類任務無聲消失，所以這個視圖正常是空的；有列就是要看的事（正見 activity_health 的通用幾項，沒有 roster／公報／號次／村里長的檢查）
CREATE OR REPLACE VIEW policy_jp.activity_health WITH (security_invoker = true) AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM policy_jp.elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM policy_jp.activity_rules r GROUP BY r.activity HAVING NOT bool_or(r.enabled)
  UNION ALL
  SELECT 'override_without_rule', o.activity, '有覆寫但這個活動沒有任何規則（拼錯活動名？）'
    FROM policy_jp.activity_overrides o WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = o.activity) GROUP BY o.activity
  UNION ALL
  SELECT 'window_inverted', 'rule ' || r.id || ' / election ' || f.election_id,
         '起日 ' || (f.on_date + r.from_offset) || ' 晚於迄日 ' || (u.on_date + r.until_offset) || '，這條規則在這場選舉永遠不會開'
    FROM policy_jp.activity_rules r
    JOIN policy_jp.election_milestones_all f ON f.kind = r.from_kind
    JOIN policy_jp.election_milestones_all u ON u.kind = r.until_kind AND u.election_id = f.election_id
         AND (u.election_type IS NOT DISTINCT FROM f.election_type OR u.election_type IS NULL OR f.election_type IS NULL)
   WHERE r.enabled AND f.on_date + r.from_offset > u.on_date + r.until_offset
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL
  UNION ALL
  SELECT 'queue_clock_overridden', current_setting('app.queue_now', true), '派工時鐘被 app.queue_now 覆寫了：所有固定時段插隊都在用這個假時間（只該出現在測試）'
   WHERE NULLIF(current_setting('app.queue_now', true), '') IS NOT NULL;
COMMENT ON VIEW policy_jp.activity_health IS '派工時間窗的健康檢查，正常是空的（日本版只有通用幾項）';

-- 規則說「該開」的日子與缺口實際出生的日子差超過 1 天的缺口（Asia/Tokyo 日界）；要看的清單不是警報
CREATE OR REPLACE VIEW policy_jp.gap_open_lateness WITH (security_invoker = true) AS
  SELECT e.task_id, e.task_type, e.event, e.at, e.rule_id, e.election_id, e.milestone_kind, e.milestone_on_date,
         (e.detail->>'expected_open_on')::DATE AS expected_open_on,
         (e.at AT TIME ZONE 'Asia/Tokyo')::DATE - (e.detail->>'expected_open_on')::DATE AS late_days
    FROM policy_jp.gap_events e
   WHERE e.event IN ('opened', 'reopened')
     AND e.detail ? 'expected_open_on'
     AND (e.at AT TIME ZONE 'Asia/Tokyo')::DATE - (e.detail->>'expected_open_on')::DATE > 1;

-- ------------------------------------------------------------
-- 觸發器（照正見的 CREATE TRIGGER；函式本體都在上面，是走樣守門的對象）
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_election_milestones_touch ON policy_jp.election_milestones;
CREATE TRIGGER trg_election_milestones_touch BEFORE UPDATE ON policy_jp.election_milestones FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_activity_rules_touch ON policy_jp.activity_rules;
CREATE TRIGGER trg_activity_rules_touch BEFORE UPDATE ON policy_jp.activity_rules FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_task_priority_tiers_touch ON policy_jp.task_priority_tiers;
CREATE TRIGGER trg_task_priority_tiers_touch BEFORE UPDATE ON policy_jp.task_priority_tiers FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();

DROP TRIGGER IF EXISTS trg_election_milestones_audit ON policy_jp.election_milestones;
CREATE TRIGGER trg_election_milestones_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.election_milestones FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();
DROP TRIGGER IF EXISTS trg_activity_rules_audit ON policy_jp.activity_rules;
CREATE TRIGGER trg_activity_rules_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.activity_rules FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();
DROP TRIGGER IF EXISTS trg_activity_overrides_audit ON policy_jp.activity_overrides;
CREATE TRIGGER trg_activity_overrides_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.activity_overrides FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();
DROP TRIGGER IF EXISTS trg_task_priority_tiers_audit ON policy_jp.task_priority_tiers;
CREATE TRIGGER trg_task_priority_tiers_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.task_priority_tiers FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();

DROP TRIGGER IF EXISTS trg_gap_events_append_only ON policy_jp.gap_events;
CREATE TRIGGER trg_gap_events_append_only BEFORE UPDATE OR DELETE ON policy_jp.gap_events FOR EACH ROW EXECUTE FUNCTION policy_jp.gap_events_append_only();
DROP TRIGGER IF EXISTS trg_gap_events_no_truncate ON policy_jp.gap_events;
CREATE TRIGGER trg_gap_events_no_truncate BEFORE TRUNCATE ON policy_jp.gap_events FOR EACH STATEMENT EXECUTE FUNCTION policy_jp.gap_events_append_only();

-- 缺口出生／收回：所有任務列（不含 verify:），同正見 20261008165000
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_before_insert ON policy_jp.task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_before_insert BEFORE INSERT ON policy_jp.task_dispatches
  FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION policy_jp.task_dispatches_gap_before_insert();
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_after_insert ON policy_jp.task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_after_insert AFTER INSERT ON policy_jp.task_dispatches
  FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION policy_jp.task_dispatches_gap_after_insert();
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_after_delete ON policy_jp.task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_after_delete AFTER DELETE ON policy_jp.task_dispatches
  FOR EACH ROW WHEN (OLD.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION policy_jp.task_dispatches_gap_after_delete();

-- 投票：先填權重（BEFORE），再算共識（AFTER）
DROP TRIGGER IF EXISTS trg_contribution_votes_weight ON policy_jp.contribution_votes;
CREATE TRIGGER trg_contribution_votes_weight BEFORE INSERT OR UPDATE OF verdict, judge_backed ON policy_jp.contribution_votes
  FOR EACH ROW EXECUTE FUNCTION policy_jp.contribution_votes_set_weight();
DROP TRIGGER IF EXISTS trg_contribution_votes_consensus ON policy_jp.contribution_votes;
CREATE TRIGGER trg_contribution_votes_consensus AFTER INSERT OR UPDATE OR DELETE ON policy_jp.contribution_votes
  FOR EACH ROW EXECUTE FUNCTION policy_jp.contribution_votes_trg();

-- 貢獻：一進 pending 就有驗證列；上線（applied）就收回缺口
DROP TRIGGER IF EXISTS trg_contribution_queue_row ON policy_jp.contributions;
CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON policy_jp.contributions
  FOR EACH ROW EXECUTE FUNCTION policy_jp.contribution_queue_row();
DROP TRIGGER IF EXISTS contributions_drop_dispatch ON policy_jp.contributions;
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied') EXECUTE FUNCTION policy_jp.task_dispatches_drop_applied();

-- 手動任務：關閉／刪除立刻收回、新建／重開立刻入列
DROP TRIGGER IF EXISTS trg_contribution_tasks_close_dispatch ON policy_jp.contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_close_dispatch AFTER UPDATE OF status ON policy_jp.contribution_tasks
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status <> 'open') EXECUTE FUNCTION policy_jp.contribution_tasks_drop_dispatch();
DROP TRIGGER IF EXISTS trg_contribution_tasks_delete_dispatch ON policy_jp.contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_delete_dispatch AFTER DELETE ON policy_jp.contribution_tasks
  FOR EACH ROW EXECUTE FUNCTION policy_jp.contribution_tasks_drop_dispatch();
DROP TRIGGER IF EXISTS trg_contribution_tasks_insert_dispatch ON policy_jp.contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_insert_dispatch AFTER INSERT ON policy_jp.contribution_tasks
  FOR EACH ROW WHEN (NEW.status = 'open') EXECUTE FUNCTION policy_jp.contribution_tasks_insert_dispatch();
DROP TRIGGER IF EXISTS trg_contribution_tasks_reopen_dispatch ON policy_jp.contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_reopen_dispatch AFTER UPDATE OF status ON policy_jp.contribution_tasks
  FOR EACH ROW WHEN (OLD.status <> 'open' AND NEW.status = 'open') EXECUTE FUNCTION policy_jp.contribution_tasks_insert_dispatch();

-- ------------------------------------------------------------
-- 規則種子：兩支手動任務臂「永遠開」＋網站請求在優先層前段（同正見 20261008165000）
-- ------------------------------------------------------------
INSERT INTO policy_jp.activity_rules (activity, window_kind, note)
SELECT a.arm, 'always', '手動任務臂：永遠開；任務關閉＝缺口消失'
  FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, note)
SELECT 'priority:manual_visitor', 'always', 1, '前段：有人在網站上等著的請求（同正見）。想改回預設層就刪這條規則（走 migration）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:manual_visitor');

-- ------------------------------------------------------------
-- 排程：每 10 分鐘 seed。pg_cron 不在的環境（本機、測試）略過，不讓 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-seed-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-seed-10min')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-seed-10min', '*/10 * * * *', 'SELECT policy_jp.seed_auto_task_queue();')$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 派工紀錄定時清理（抄自正見 20261009080000_dispatch_records_purge.sql，#485／#493；policy-jp #498 審查補上）
-- ------------------------------------------------------------
-- verify_dispatches、contribution_task_skips 跟正見一樣只進不出，這裡照抄正見的清理：保留天數與批量放設定表（單列），
-- 函式分批刪、用 FOR UPDATE SKIP LOCKED 跳過被鎖住的列，pg_cron 每天一次。
--
-- 日本站這兩張表的讀者與回看期（守門 dispatch-records-purge.test.ts 依 schema 分開從原始碼與本檔抽出來核對，保留天數 ＋ 1 天邊際必須 ≥ 每一處）：
--   verify_dispatches
--     1. jp-next 每台機器 2:1：最近 3 小時、最多 3 筆
--     2. contribution_verify_pool：「剛派給這台機器的不要再派」，interval '15 minutes'
--     3. 日本版 verify-handler 的派工綁定（POST jp-report{kind:"verify"} 沒帶憑證時）：VERIFY_BINDING_DAYS＝7 天（共用 _shared/dispatch.ts 的常數，.gte 明寫時限）
--   contribution_task_skips：沒有任何讀者（jp-next 只 upsert 紀錄）
-- 保留天數同正見：verify_dispatches 14 天（最長回看期 7 天 ＋ 7 天邊際）、skips 7 天；欄位 CHECK 下限 8／2（必須大於派工綁定的 7 天與曾經的 24 小時）。
--
-- 與正見不同的只有三處（函式本體逐字相同，走樣守門 policy-jp-dispatch-drift.test.ts 會還原成正見現行定義比對）：
--   1. 設定表沒有 "Public read"／"Service role write" 兩條 policy：這個 schema 的內部表一律「開 RLS、不加 policy、不給 anon／authenticated 任何權限，
--      service_role 靠 BYPASSRLS 全權」（本檔第 1 節與下面的權限區塊）；正見的設定表是公開唯讀，這裡的參數不對外
--   2. 排程名 policy-jp-dispatch-records-purge、UTC 19:55（正見是 19:50，兩邊的刪除不同時跑）
--   3. 排程只在 pg_cron 存在時建（跟上面的 seed 排程同一個保護；本機與 PGlite 測試沒有 pg_cron）
-- 所有物件都帶 policy_jp. 前綴，函式釘 search_path = policy_jp, pg_temp；表的 RLS／權限在下面「權限」區塊的清單裡。
CREATE TABLE IF NOT EXISTS policy_jp.dispatch_records_settings (
  id                     SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled                BOOLEAN NOT NULL DEFAULT true,
  verify_dispatches_days INTEGER NOT NULL DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 8 AND 365),
  task_skips_days        INTEGER NOT NULL DEFAULT 7  CHECK (task_skips_days BETWEEN 2 AND 365),
  batch_size             INTEGER NOT NULL DEFAULT 5000 CHECK (batch_size BETWEEN 100 AND 50000),
  max_batches            INTEGER NOT NULL DEFAULT 20 CHECK (max_batches BETWEEN 1 AND 200),
  note                   TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_jp.dispatch_records_settings IS
  '派工紀錄清理的參數（單列 id=1，同正見）。改值一行 UPDATE，例：UPDATE policy_jp.dispatch_records_settings SET verify_dispatches_days = 21, note = ''…'' WHERE id = 1;（每次修改進 policy_jp.edit_history，agent_name=activity-audit）。保留天數必須大於程式最長回看期，守門 dispatch-records-purge.test.ts 讀最終值比對';
COMMENT ON COLUMN policy_jp.dispatch_records_settings.enabled IS 'false＝排程照跑但什麼都不刪';
COMMENT ON COLUMN policy_jp.dispatch_records_settings.verify_dispatches_days IS 'verify_dispatches 保留幾天（dispatched_at 超過就刪）。下限 8＝必須大於派工綁定的 VERIFY_BINDING_DAYS（7）；程式端有更長的回看期時守門測試會要求調大';
COMMENT ON COLUMN policy_jp.dispatch_records_settings.task_skips_days IS 'contribution_task_skips 保留幾天（skipped_at 超過就刪）。目前沒有任何程式讀它，只留紀錄；下限 2＝大於曾經的 24 小時';
COMMENT ON COLUMN policy_jp.dispatch_records_settings.batch_size IS '每一批最多刪幾筆（每張表各自分批）';
COMMENT ON COLUMN policy_jp.dispatch_records_settings.max_batches IS '每次排程每張表最多刪幾批；沒刪完的隔天接著刪';
INSERT INTO policy_jp.dispatch_records_settings (id, note) VALUES (1, '初值：派工紀錄 14 天、跳過紀錄 7 天；每批 5,000 筆、最多 20 批（同正見 #485；policy-jp #498 審查補上）') ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_dispatch_records_settings_touch ON policy_jp.dispatch_records_settings;
CREATE TRIGGER trg_dispatch_records_settings_touch BEFORE UPDATE ON policy_jp.dispatch_records_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_dispatch_records_settings_audit ON policy_jp.dispatch_records_settings;
CREATE TRIGGER trg_dispatch_records_settings_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.dispatch_records_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();

-- 抄自 20261009080000_dispatch_records_purge.sql：分批、跳過被鎖住的列，回傳這次各刪了幾筆
CREATE OR REPLACE FUNCTION policy_jp.dispatch_records_purge() RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp
SET lock_timeout = '3s'
SET statement_timeout = '120s'
AS $$
DECLARE
  s policy_jp.dispatch_records_settings%ROWTYPE;
  v_vd BIGINT := 0;
  v_sk BIGINT := 0;
  n BIGINT;
  i INTEGER;
BEGIN
  SELECT * INTO s FROM policy_jp.dispatch_records_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('enabled', false, 'verify_dispatches', 0, 'contribution_task_skips', 0);
  END IF;

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM policy_jp.verify_dispatches d
    USING (
      SELECT contribution_id, ip_hash FROM policy_jp.verify_dispatches
      WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)
      LIMIT s.batch_size
      FOR UPDATE SKIP LOCKED
    ) o
    WHERE d.contribution_id = o.contribution_id AND d.ip_hash = o.ip_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_vd := v_vd + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM policy_jp.contribution_task_skips d
    USING (
      SELECT task_id, ip_hash FROM policy_jp.contribution_task_skips
      WHERE skipped_at < now() - make_interval(days => s.task_skips_days)
      LIMIT s.batch_size
      FOR UPDATE SKIP LOCKED
    ) o
    WHERE d.task_id = o.task_id AND d.ip_hash = o.ip_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_sk := v_sk + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'verify_dispatches', v_vd, 'contribution_task_skips', v_sk);
END;
$$;
COMMENT ON FUNCTION policy_jp.dispatch_records_purge IS
  '刪掉超過保留天數的 policy_jp.verify_dispatches、contribution_task_skips（天數與批量在 policy_jp.dispatch_records_settings）。每張表分批刪、跳過被鎖住的列；回傳各刪幾筆。pg_cron policy-jp-dispatch-records-purge 每天跑一次';
REVOKE ALL ON FUNCTION policy_jp.dispatch_records_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.dispatch_records_purge() TO service_role;

-- 排程：UTC 19:55 每天一次（日本時間 04:55）。pg_cron 不在的環境（本機、測試）略過，不讓 migration 失敗；重跑先 unschedule 再 schedule，只留一條
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-dispatch-records-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-dispatch-records-purge')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-dispatch-records-purge', '55 19 * * *', 'SELECT policy_jp.dispatch_records_purge();')$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 權限
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['task_priority_tiers', 'contributions', 'contribution_votes', 'edit_history', 'contribution_tasks', 'contribution_task_leases',
                           'contribution_task_skips', 'verify_dispatches', 'task_checks', 'jev_decisions', 'task_dispatches', 'gap_events',
                           'election_milestones', 'activity_rules', 'activity_overrides', 'dispatch_records_settings'] LOOP
    EXECUTE format('ALTER TABLE policy_jp.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON policy_jp.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON policy_jp.%I TO service_role', t);
  END LOOP;
END
$$;
REVOKE ALL ON policy_jp.election_milestones_all, policy_jp.activity_health, policy_jp.gap_open_lateness FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.election_milestones_all, policy_jp.activity_health, policy_jp.gap_open_lateness TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA policy_jp TO service_role;

-- 函式一律不給 PUBLIC／anon／authenticated 執行（這支沒有任何要給 anon 的函式）；service_role 與擁有者照舊。
-- 例外：tables migration 明確給 anon／authenticated 的兩支（lg_code_valid、election_level，CHECK 約束與 election_level 會用到），REVOKE 之後原樣補回
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA policy_jp FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA policy_jp TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.lg_code_valid(TEXT), policy_jp.election_level(TEXT) TO anon, authenticated;

-- ------------------------------------------------------------
-- 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'policy_jp' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 派工：這些表沒開 RLS：%', bad; END IF;

  -- 這支新增的內部表：anon／authenticated／PUBLIC 不能有任何權限（連 SELECT 都不行）
  SELECT string_agg(DISTINCT g.table_name || ':' || g.grantee || ':' || g.privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
     AND g.table_name IN ('task_priority_tiers', 'contributions', 'contribution_votes', 'edit_history', 'contribution_tasks', 'contribution_task_leases',
                          'contribution_task_skips', 'verify_dispatches', 'task_checks', 'jev_decisions', 'task_dispatches', 'gap_events',
                          'election_milestones', 'activity_rules', 'activity_overrides', 'dispatch_records_settings', 'election_milestones_all', 'activity_health', 'gap_open_lateness');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 派工：anon／authenticated 不該有任何權限：%', bad; END IF;

  -- 函式：anon／authenticated 只准有 tables migration 給的那兩支
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp' AND p.proname NOT IN ('lg_code_valid', 'election_level')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 派工：anon／authenticated 不該能執行這些函式：%', bad; END IF;

  -- 沒有任何函式本體提到 public.（獨立於正見）
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp' AND p.prosrc ~ 'public\.';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 派工：函式本體提到 public.：%', bad; END IF;

  -- 每支臂都有規則
  IF EXISTS (SELECT 1 FROM policy_jp.activity_health WHERE check_name = 'arm_without_rule') THEN
    RAISE EXCEPTION 'policy_jp 派工：有派工臂沒有規則';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
