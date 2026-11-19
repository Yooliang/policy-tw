-- 驗證先於任務：驗證票排序改成「差一票先 → 層級 → queue_at」，有票的票每被領走只往後排 1 小時（2026-11-19，小良哥拍板）
-- ============================================================
--
-- 規則（/next 端見 _shared/dispatch.ts 的 pickDispatchKind：驗證隊伍有能派給這隻代理的票就先派，沒有才看手動任務／自動缺口）：
--   驗證隊伍內的順序＝ verify_rank（小的先）→ queue_at → task_id。verify_rank ＝ (有票？0：3) ＋ 層級：
--     有票（已有人投、分數 >= 1、尚未達門檻；達門檻的票已離開 pending，不在池裡）＝「差一票就能套用」，排在沒人投過的前面。
--     層級（verify_level）0＝縣市長／縣市議員（含直轄市、總統副總統、立法委員）、1＝鄉鎮市長／鄉鎮市民代表（含原住民區長與代表）、2＝村里長。
--       層級照 lib/election-levels.ts 的 POSITIONS（level：national／county → 0、township → 1、village → 2）；
--       POSITIONS 沒有的「直轄市長」「直轄市議員」依 queue_settings.election_type_priority_days 已有的列（與縣市長／縣市議員同一組）算 0；
--       對不上職位的票（沒有選舉類別，例如網站請求、名冊）算 1（中間，不搶也不墊底）。
--     職位怎麼對上票：payload.election_type，沒有就看母任務列的 target.election_type，再沒有就用 politician_id＋election_id 查 politician_elections
--       （同 election_type_priority_seconds 的查法）。層級在票入列時算一次、存在列上，不隨後續投票改。
--   懲罰：queue_at ＝ 基準 − 14 天 − 插隊秒數 ＋ 步長 × 領走次數。步長原本一律 7 天（no_change 14 天）；
--     現在「有票」的票步長改成 queue_settings.verify_voted_redispatch_seconds（預設 3600＝1 小時），沒人投過的維持 7 天／14 天。
--     票第一次有人投（分數跨過 1）或又掉回 0 時，列上的 verify_has_votes 由 contributions 的觸發器同步，排序鍵與 verify_rank 跟著重算
--     （領走過幾次的 7 天懲罰在有票的那一刻不再計，票會往前回到「基準 ＋ 次數 × 1 小時」）。
--
-- 為什麼排序用列上的欄位、不在池裡查票數：contribution_verify_pool 的 ORDER BY 若要讀 contributions.score 或現算層級（職位要查母任務與 politician_elections），
--   每一次 /next 都得替全部待驗證票（約 2,300 張）各算一遍再排。所以 verify_has_votes／verify_level／verify_rank 存在 task_dispatches 列上，
--   池子的排序鍵只是列上一個 smallint 加 queue_at，排序成本與原本相同（2026-11-19 唯讀實測原本的池子 100～300 毫秒，計畫是掃全部驗證列後 top-N 排序），
--   並備一個部分索引 (verify_rank, queue_at, task_id) WHERE task_id LIKE 'verify:%'，讓規劃器有機會改成順著索引走、湊滿 p_limit 就停。
--   票數變動時才寫（contributions.score 跨過 1 的那一票，WHEN 條件過濾，其餘票數變動不觸發）。
--
-- 這支做的事：
--   1. queue_settings.verify_voted_redispatch_seconds；task_dispatches 三個欄位與部分索引
--   2. 函式：verify_election_type_level、verify_ticket_election_type、verify_ticket_level、verify_ticket_has_votes、verify_ticket_step_seconds(TEXT, BOOLEAN)
--   3. task_dispatches_queue_key（以 20261104120000 為底，只差標 >>> 驗證先於任務 的幾處）與 refresh_verify_ticket_keys（步長改用兩參數版）
--   4. contributions 觸發器：分數跨過 1 時同步 verify_has_votes
--   5. 既有票回填 verify_has_votes／verify_level（觸發器跟著算 verify_rank 與新的 queue_at）；NOTICE 印出有幾張票的位置因懲罰改了而前移
--   6. contribution_verify_pool：以 20261114080000 的現行定義為底，只差 ORDER BY（標 >>> 驗證先於任務）；簽名不動
--
-- 日本站（policy_jp）不跟（沒有職位層級、驗證票排序另有一份）；policy-jp-dispatch-drift.test.ts 登記偏離。
-- 回滾：新 migration 用 CREATE OR REPLACE 把 task_dispatches_queue_key、refresh_verify_ticket_keys、contribution_verify_pool 換回
--   20261104120000／20261114080000 的定義，DROP TRIGGER trg_contributions_verify_has_votes；欄位與索引留著不影響（verify_has_votes 不再被讀），
--   之後要重算票的位置跑 SELECT refresh_verify_ticket_keys()。不刪檔、不改既有 migration。

-- ── 1. 設定、欄位、索引 ────────────────────────────────────────
ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS verify_voted_redispatch_seconds INTEGER NOT NULL DEFAULT 3600
    CHECK (verify_voted_redispatch_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN queue_settings.verify_voted_redispatch_seconds IS '已經有票（分數 >= 1、未達門檻）的驗證票每被領走一次往後排的秒數（預設 3600＝1 小時）；沒人投過的票仍用 verify_redispatch_seconds（7 天）／verify_no_change_redispatch_seconds（14 天）。2026-11-19';

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS verify_has_votes BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS verify_level SMALLINT;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS verify_rank SMALLINT;
COMMENT ON COLUMN task_dispatches.verify_has_votes IS '驗證列：這張票已經有票（contributions.score >= 1）；由 contributions 觸發器同步。影響步長（1 小時）與 verify_rank。任務列恆為 false。2026-11-19';
COMMENT ON COLUMN task_dispatches.verify_level IS '驗證列：職位層級 0＝縣市長／縣市議員、1＝鄉鎮市長／代表（對不上職位也算 1）、2＝村里長；入列時算一次。任務列為 NULL。2026-11-19';
COMMENT ON COLUMN task_dispatches.verify_rank IS '驗證列的排序階：(有票 ? 0 : 3) ＋ verify_level，小的先派；觸發器 task_dispatches_queue_key 維護。任務列為 NULL。2026-11-19';

CREATE INDEX IF NOT EXISTS task_dispatches_verify_rank_idx ON task_dispatches (verify_rank, queue_at, task_id) WHERE task_id LIKE 'verify:%';

-- ── 2. 函式 ────────────────────────────────────────────────────
-- 職位 → 層級（0 縣市級以上、1 鄉鎮級、2 村里）。對照 lib/election-levels.ts 的 POSITIONS（守門測試逐一比對）
CREATE OR REPLACE FUNCTION verify_election_type_level(p_election_type TEXT) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE p_election_type
            WHEN '總統副總統' THEN 0 WHEN '縣市長' THEN 0 WHEN '縣市議員' THEN 0 WHEN '立法委員' THEN 0
            WHEN '直轄市長' THEN 0 WHEN '直轄市議員' THEN 0
            WHEN '鄉鎮市長' THEN 1 WHEN '鄉鎮市民代表' THEN 1 WHEN '直轄市山地原住民區長' THEN 1 WHEN '直轄市山地原住民區民代表' THEN 1
            WHEN '村里長' THEN 2
            ELSE 1 END)::SMALLINT
$$;
COMMENT ON FUNCTION verify_election_type_level IS '職位 → 驗證票層級（20261119100000）：0＝縣市長／縣市議員（含直轄市、總統副總統、立法委員）、1＝鄉鎮市長／鄉鎮市民代表（含原住民區長與代表；對不上職位也是 1）、2＝村里長。對照 lib/election-levels.ts POSITIONS 的 level（national／county → 0、township → 1、village → 2）。2026-11-19';

-- 一張驗證票（task_id＝verify:<貢獻 id>）對應的職位：交件 payload.election_type → 母任務列 target.election_type → politician_elections（同 election_type_priority_seconds）
CREATE OR REPLACE FUNCTION verify_ticket_election_type(p_verify_task_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(b.payload->>'election_type', ''), NULLIF(p.target->>'election_type', ''),
                  (SELECT pe.election_type::TEXT FROM politician_elections pe
                    WHERE pe.politician_id = uuid_or_null(COALESCE(b.payload->>'politician_id', p.target->>'politician_id'))
                      AND pe.election_id = election_id_or_null(COALESCE(b.payload->>'election_id', p.target->>'election_id'))
                    ORDER BY pe.id LIMIT 1))
    FROM contributions b
    LEFT JOIN task_dispatches p ON p.task_id = COALESCE(b.task_id, b.payload->>'task_id')
   WHERE b.id = uuid_or_null(substr(p_verify_task_id, 8))
$$;
COMMENT ON FUNCTION verify_ticket_election_type IS '驗證票那份交件的職位（20261119100000）：payload.election_type → 母任務 target.election_type → politician_elections 查 politician_id＋election_id；都沒有 NULL。2026-11-19';

CREATE OR REPLACE FUNCTION verify_ticket_level(p_verify_task_id TEXT) RETURNS SMALLINT
LANGUAGE sql STABLE AS $$ SELECT verify_election_type_level(verify_ticket_election_type(p_verify_task_id)) $$;
COMMENT ON FUNCTION verify_ticket_level IS '驗證票的層級 0／1／2（20261119100000）：職位對照見 verify_election_type_level；對不上職位＝1。2026-11-19';

-- 這張票現在有沒有票：contributions.score >= 1（每個投票人只算最新一票的加權和，達門檻的票已離開 pending）
CREATE OR REPLACE FUNCTION verify_ticket_has_votes(p_verify_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT c.score >= 1 FROM contributions c WHERE c.id = uuid_or_null(substr(p_verify_task_id, 8))), false)
$$;
COMMENT ON FUNCTION verify_ticket_has_votes IS '驗證票已經有票（contributions.score >= 1）嗎（20261119100000）；找不到貢獻＝false。2026-11-19';

-- 步長（兩參數版）：有票用 verify_voted_redispatch_seconds（1 小時），沒票照舊（一參數版：7 天、no_change 14 天）
CREATE OR REPLACE FUNCTION verify_ticket_step_seconds(p_verify_task_id TEXT, p_has_votes BOOLEAN) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN COALESCE(p_has_votes, false)
              THEN COALESCE((SELECT q.verify_voted_redispatch_seconds FROM queue_settings q WHERE q.id = 1), 3600)
              ELSE verify_ticket_step_seconds(p_verify_task_id) END
$$;
COMMENT ON FUNCTION verify_ticket_step_seconds(TEXT, BOOLEAN) IS '驗證票每被領走一次往後排的秒數（20261119100000）：已有票＝verify_voted_redispatch_seconds（1 小時）；沒人投過＝一參數版（7 天；no_change 14 天）。2026-11-19';

-- ── 3. 排序鍵觸發器（以 20261104120000 為底，只差標 >>> 驗證先於任務） ──────────
CREATE OR REPLACE FUNCTION task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- >>> 驗證票排序（20261104120000）：驗證列的插隊不因派出歸零；任務列派出時先記下派出前的位置（給之後交件的驗證票當基準）再歸零
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count AND NEW.task_id NOT LIKE 'verify:%' THEN
    NEW.dispatch_base_at := task_queue_key(
      COALESCE(OLD.last_dispatched_at, now()),
      CASE WHEN COALESCE((SELECT q.verify_inherit_negative FROM queue_settings q WHERE q.id = 1), false) THEN OLD.priority_seconds ELSE GREATEST(OLD.priority_seconds, 0) END,
      OLD.cool_until, OLD.boost_seconds);
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  -- <<< 驗證票排序
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := verify_ticket_priority_seconds(NEW.task_id);
      -- >>> 驗證先於任務（20261119100000）：入列時記下有沒有票與層級（層級之後不改；有票由 contributions 觸發器同步）
      NEW.verify_has_votes := verify_ticket_has_votes(NEW.task_id);
      NEW.verify_level := COALESCE(NEW.verify_level, verify_ticket_level(NEW.task_id));
      -- <<< 驗證先於任務
    END IF;
    -- verify_follows_task：欄位保留（改簽名要分兩次上），排序鍵已不看它；照舊記「領走過」
    IF (TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count) OR (TG_OP = 'INSERT' AND COALESCE(NEW.dispatch_count, 0) > 0) THEN
      NEW.verify_follows_task := false;
    END IF;
    -- no_change 的 1～2 天延後（20261028140000）不再用：改成 no_change 的步長 14 天；defer_seconds 欄位保留、觸發器不再寫它
    -- >>> 驗證票排序（20261104120000）：入列時凍結基準；遇到沒有基準的舊列（UPDATE）就用現在的 queue_at 反推，不讓票跳位
    IF NEW.dispatch_base_at IS NULL THEN
      IF TG_OP = 'INSERT' THEN
        NEW.dispatch_base_at := COALESCE(verify_ticket_base(NEW.task_id), now());
      ELSE
        NEW.dispatch_base_at := verify_ticket_freeze_base(OLD.queue_at, OLD.dispatch_count, OLD.boost_seconds, verify_ticket_step_seconds(NEW.task_id, OLD.verify_has_votes));
      END IF;
    END IF;
    -- >>> 驗證先於任務（20261119100000）：步長依有沒有票（有票 1 小時、沒票 7 天／14 天）；排序階 verify_rank ＝ (有票 ? 0 : 3) ＋ 層級
    NEW.queue_at := verify_ticket_key(NEW.dispatch_base_at, NEW.dispatch_count, NEW.boost_seconds, verify_ticket_step_seconds(NEW.task_id, NEW.verify_has_votes));
    NEW.verify_rank := (CASE WHEN NEW.verify_has_votes THEN 0 ELSE 3 END) + COALESCE(NEW.verify_level, 1);
    -- <<< 驗證先於任務
    -- <<< 驗證票排序
  ELSE
    NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_queue_key IS
  'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器：queue_at 一律照排序鍵重算（任務列 task_queue_key；驗證列 verify_ticket_key＝入列時凍結的基準 − 14 天 − 自己的插隊秒數 ＋ 步長 × 領走次數，步長：有票 1 小時、沒票 7 天、no_change 14 天）。'
  '任務列派出時記下派出前的位置（dispatch_base_at）、插隊歸零回隊尾；驗證列的插隊不因派出歸零；驗證列另算 verify_rank（有票 0／沒票 3 ＋ 層級）給池子排序。2026-11-04 改、2026-11-19 加驗證先於任務';

-- 還依列上凍結的值與設定重算驗證票（不看母任務）：步長改用兩參數版（有票 1 小時）
CREATE OR REPLACE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE task_dispatches d
     SET queue_at = verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, verify_ticket_step_seconds(d.task_id, d.verify_has_votes))
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NOT NULL
     AND d.queue_at IS DISTINCT FROM verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, verify_ticket_step_seconds(d.task_id, d.verify_has_votes));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION refresh_verify_ticket_keys IS '驗證票的 queue_at 依列上凍結的基準與設定重算（2026-11-04 起不看母任務；2026-11-19 起有票的票步長用 verify_voted_redispatch_seconds）；回傳換了位置的張數';

-- ── 4. 分數跨過 1 時同步 verify_has_votes ───────────────────────
-- 只在「有沒有票」這個布林變了才動（WHEN）；UPDATE 走主鍵，task_dispatches 的 BEFORE 觸發器負責重算 queue_at 與 verify_rank
CREATE OR REPLACE FUNCTION contribution_sync_verify_has_votes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE task_dispatches SET verify_has_votes = (NEW.score >= 1)
   WHERE task_id = 'verify:' || NEW.id::TEXT AND verify_has_votes IS DISTINCT FROM (NEW.score >= 1);
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION contribution_sync_verify_has_votes IS '貢獻的分數跨過 1（有票／沒票）時，同步驗證列的 verify_has_votes（20261119100000）；列上的 BEFORE 觸發器接手重算 queue_at 與 verify_rank。2026-11-19';
DROP TRIGGER IF EXISTS trg_contributions_verify_has_votes ON contributions;
CREATE TRIGGER trg_contributions_verify_has_votes AFTER UPDATE OF score ON contributions
  FOR EACH ROW WHEN ((OLD.score >= 1) IS DISTINCT FROM (NEW.score >= 1))
  EXECUTE FUNCTION contribution_sync_verify_has_votes();

-- ── 5. 既有的票回填（觸發器跟著算 verify_rank 與新的 queue_at） ─────────────
DO $$
DECLARE v_rows INTEGER; v_voted INTEGER; v_moved INTEGER;
BEGIN
  CREATE TEMP TABLE _verify_first_before ON COMMIT DROP AS SELECT task_id, queue_at FROM task_dispatches WHERE task_id LIKE 'verify:%';
  UPDATE task_dispatches d
     SET verify_has_votes = verify_ticket_has_votes(d.task_id), verify_level = verify_ticket_level(d.task_id)
   WHERE d.task_id LIKE 'verify:%';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT count(*) INTO v_voted FROM task_dispatches WHERE task_id LIKE 'verify:%' AND verify_has_votes;
  SELECT count(*) INTO v_moved FROM _verify_first_before b JOIN task_dispatches d ON d.task_id = b.task_id WHERE d.queue_at IS DISTINCT FROM b.queue_at;
  RAISE NOTICE '驗證先於任務回填：% 張驗證票，其中有票 % 張；因步長改 1 小時而前移位置的 % 張', v_rows, v_voted, v_moved;
END
$$;

-- ── 6. 驗證池：只差 ORDER BY（以 20261114080000 的現行定義為底） ──────────────
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
      WHERE vd.contribution_id = c.id
        -- >>> 只看代號（20261114080000）：同網段別的代號、同代號換網段都算同一個代理；沒有代號才退回比來源網段
        AND ((p_agent_name IS NULL AND vd.ip_hash = p_ip_hash) OR lower(vd.agent_name) = lower(p_agent_name))
        -- <<< 只看代號
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    -- 待指認（needs_identity_pick）的件分數已經夠了、狀態被改回 pending 等人補指認：不能被「分數已達標」濾掉（20261111170000）
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) OR c.needs_identity_pick)
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
    -- >>> 同代理重派冷卻（20261114080000）：同一個代理（只比代號）在 redispatch_cooldown_seconds 內被派過這張票就不再派給它（它投過的前面已排除）；別的代理照樣領得到
    AND (p_agent_name IS NULL OR NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd CROSS JOIN queue_settings qs
      WHERE qs.id = 1 AND vd.contribution_id = c.id AND lower(vd.agent_name) = lower(p_agent_name)
        AND vd.dispatched_at > now() - make_interval(secs => LEAST(qs.redispatch_cooldown_seconds, 86400))
    ))
    -- <<< 同代理重派冷卻
  -- >>> 驗證先於任務（20261119100000）：差一票的先、再依層級（縣市 → 鄉鎮 → 村里）、再 queue_at；verify_rank 在列上、走部分索引，不在池裡算票數
  ORDER BY d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id
  -- <<< 驗證先於任務
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

NOTIFY pgrst, 'reload schema';
