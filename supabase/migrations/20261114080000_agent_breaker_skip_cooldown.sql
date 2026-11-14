-- 派工兩條規則：代理斷路器＋同一代理重派冷卻（2026-11-14，小良哥「做」；背景：Grok gk01 同兩張驗證票被派 14 次、零投票）
-- ============================================================
--
-- 起因（正式庫唯讀查證）：Grok 那兩張驗證票從沒有 skip 紀錄，它是「領了不投、重打 /next」；驗證票的派出只記在 verify_dispatches
-- （contribution_id, ip_hash, agent_name, dispatched_at），沒有人記得「這個代理上一次拿到它是什麼時候」，池子很小時同一張一直回到同一個代理手上。
--
-- ③' 同一代理重派冷卻：同一個代理（只比 agent_name，不比 ip_hash，大小寫不分）在 redispatch_cooldown_seconds（預設 14400＝4 小時）內被派過某一件、
--    而且那之後沒有對它回報（任務＝交件；驗證票＝投票，投過的本來就排除），就不再派給它；別的代理照樣立刻領得到（不改既有「skip 立刻派給別人」）。
--    skip 同樣涵蓋：skip 前一定先被派過，所以 skip 過的件也在冷卻裡。任務用 lease_events 的 issued（認領建立）算、驗證票用 verify_dispatches 算，
--    不加新表、不碰 contribution_task_skips。驗證池原有的「15 分鐘內剛派過」排除也改成只看代號（原本 ip_hash＋代號一起比）。
--    兩支派工函式各加一段合格條件（在 LIMIT 之前，守門 next-eligibility-before-limit）；全部可派的件都在冷卻裡時，/next 回
--    kind:"none"、redispatch_cooldown:true、retry_after_seconds（最早解凍的秒數）。
-- ② 代理斷路器：近 breaker_window_seconds（預設 2 小時）內「領走」≥ breaker_min_leases（預設 5）件、同期「回報」為 0，暫停派工
--    breaker_pause_seconds（預設 1 小時，從它最後一次領走算起）。領走＝lease_events 的 issued（任務）＋verify_dispatches 的列（驗證票；
--    有了冷卻，同一代理 4 小時內不會再領同一張，所以一張一列不會低估）；回報＝交件、投票、skip 任一種（skip 看 contribution_task_skips 與
--    lease_events 的 released——skip 會釋放認領，released 記得是哪個代理）。狀態現算，不另存：agent_breaker_state()、視圖 agent_breaker_status。
-- 門檻全在 queue_settings 單列；breaker_enabled=false 或 redispatch_cooldown_seconds=0 即關閉。回滾見 docs/decisions/2026-11-14-代理斷路器與skip冷卻.md。

ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS breaker_enabled            BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS breaker_window_seconds     INTEGER NOT NULL DEFAULT 7200  CHECK (breaker_window_seconds BETWEEN 60 AND 86400),
  ADD COLUMN IF NOT EXISTS breaker_min_leases         INTEGER NOT NULL DEFAULT 5     CHECK (breaker_min_leases BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS breaker_pause_seconds      INTEGER NOT NULL DEFAULT 3600  CHECK (breaker_pause_seconds BETWEEN 60 AND 86400),
  ADD COLUMN IF NOT EXISTS redispatch_cooldown_seconds INTEGER NOT NULL DEFAULT 14400 CHECK (redispatch_cooldown_seconds BETWEEN 0 AND 86400);
COMMENT ON COLUMN queue_settings.breaker_enabled IS '代理斷路器開關（20261114080000）：false＝不暫停任何代理';
COMMENT ON COLUMN queue_settings.breaker_window_seconds IS '斷路器回看視窗（預設 7200＝2 小時，上限 86400）：視窗內算領走與回報件數';
COMMENT ON COLUMN queue_settings.breaker_min_leases IS '斷路器門檻（預設 5）：視窗內領走 ≥ 這個數、而且回報為 0（交件／投票／skip 任一種都算回報），暫停派工';
COMMENT ON COLUMN queue_settings.breaker_pause_seconds IS '斷路器暫停秒數（預設 3600）：從這個代理最後一次領走算起';
COMMENT ON COLUMN queue_settings.redispatch_cooldown_seconds IS '同一代理重派冷卻（預設 14400＝4 小時，上限 86400；0＝不冷卻）：同一個代理被派過某一件、之後沒有對它回報，這段時間內不再派給同一個代理（含 skip 過的）；別的代理不受影響';

-- 查詢用索引：斷路器按代理數領走次數（lease_events 已有 (task_id, at)，驗證池的冷卻走 verify_dispatches 既有的 (contribution_id, dispatched_at)）
CREATE INDEX IF NOT EXISTS idx_lease_events_agent_at ON lease_events (agent_name, at DESC);
CREATE INDEX IF NOT EXISTS verify_dispatches_agent_idx ON verify_dispatches (agent_name, dispatched_at DESC);

-- ------------------------------------------------------------
-- 斷路器狀態（現算）：/next 每次呼叫一次；領走不到門檻時只查兩個索引範圍，不碰別的表
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_breaker_state(p_agent TEXT)
RETURNS TABLE (
  agent_name TEXT, enabled BOOLEAN, window_seconds INTEGER, min_leases INTEGER, pause_seconds INTEGER,
  leases INTEGER, reports INTEGER, last_lease_at TIMESTAMPTZ,
  tripped BOOLEAN, paused BOOLEAN, paused_until TIMESTAMPTZ, retry_after_seconds INTEGER
)
LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT s.breaker_enabled AS enabled, LEAST(s.breaker_window_seconds, 86400) AS win, s.breaker_min_leases AS min_leases, s.breaker_pause_seconds AS pause_seconds
      FROM queue_settings s WHERE s.id = 1
  ), tl AS (
    SELECT count(*)::INTEGER AS n, max(e.at) AS last_at
      FROM lease_events e CROSS JOIN q
     WHERE q.enabled AND e.agent_name = p_agent AND e.event = 'issued'
       AND e.at > now() - make_interval(secs => q.win)
  ), vl AS (
    SELECT count(*)::INTEGER AS n, max(vd.dispatched_at) AS last_at
      FROM verify_dispatches vd CROSS JOIN q
     WHERE q.enabled AND vd.agent_name = p_agent
       AND vd.dispatched_at > now() - make_interval(secs => LEAST(q.win, 86400))
  ), l AS (
    SELECT tl.n + vl.n AS n, GREATEST(tl.last_at, vl.last_at) AS last_at FROM tl, vl
  ), r AS (
    -- 回報只在領走達門檻時才數（CASE 讓子查詢在不達門檻時不執行）：交件、投票、skip（紀錄表或釋放認領的事件）任一種都算
    SELECT (CASE WHEN q.enabled AND l.n >= q.min_leases THEN
              (SELECT count(*) FROM contributions c WHERE c.agent_name = p_agent AND c.created_at > now() - make_interval(secs => q.win))
              + (SELECT count(*) FROM contribution_votes v WHERE v.agent_name = p_agent AND v.created_at > now() - make_interval(secs => q.win))
              + (SELECT count(*) FROM contribution_task_skips sk WHERE sk.agent_name = p_agent
                   AND sk.skipped_at > now() - make_interval(secs => LEAST(q.win, 86400)))
              + (SELECT count(*) FROM lease_events rl WHERE rl.agent_name = p_agent AND rl.event = 'released' AND rl.at > now() - make_interval(secs => q.win))
            ELSE 0 END)::INTEGER AS n
      FROM q, l
  )
  SELECT p_agent, q.enabled, q.win, q.min_leases, q.pause_seconds, l.n, r.n, l.last_at,
         (q.enabled AND l.n >= q.min_leases AND r.n = 0) AS tripped,
         (q.enabled AND l.n >= q.min_leases AND r.n = 0 AND l.last_at + make_interval(secs => q.pause_seconds) > now()) AS paused,
         CASE WHEN q.enabled AND l.n >= q.min_leases AND r.n = 0 THEN l.last_at + make_interval(secs => q.pause_seconds) END AS paused_until,
         CASE WHEN q.enabled AND l.n >= q.min_leases AND r.n = 0 AND l.last_at + make_interval(secs => q.pause_seconds) > now()
              THEN CEIL(EXTRACT(EPOCH FROM (l.last_at + make_interval(secs => q.pause_seconds) - now())))::INTEGER ELSE 0 END AS retry_after_seconds
    FROM q, l, r
$$;
COMMENT ON FUNCTION agent_breaker_state IS '代理斷路器狀態（現算，20261114080000）：視窗內領走（lease_events issued＋verify_dispatches 的列）≥ 門檻、且交件／投票／skip 都是 0 ＝ tripped；最後一次領走 ＋ 暫停秒數還沒到 ＝ paused（/next 回 none 與 retry_after_seconds）。門檻在 queue_settings.breaker_*。';
REVOKE ALL ON FUNCTION agent_breaker_state(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agent_breaker_state(TEXT) TO service_role;

-- 給主控台／維運看：視窗內有領走紀錄的每個代理的斷路器狀態
CREATE OR REPLACE VIEW agent_breaker_status WITH (security_invoker = true) AS
SELECT s.*
  FROM (SELECT e.agent_name FROM lease_events e
         WHERE e.event = 'issued'
           AND e.at > now() - make_interval(secs => LEAST((SELECT x.breaker_window_seconds FROM queue_settings x WHERE x.id = 1), 86400))
        UNION
        SELECT vd.agent_name FROM verify_dispatches vd
         WHERE vd.agent_name IS NOT NULL
           AND vd.dispatched_at > now() - make_interval(secs => LEAST((SELECT y.breaker_window_seconds FROM queue_settings y WHERE y.id = 1), 86400))) a
 CROSS JOIN LATERAL agent_breaker_state(a.agent_name) s
 ORDER BY s.paused DESC, s.leases DESC, a.agent_name;
COMMENT ON VIEW agent_breaker_status IS '每個代理目前的斷路器狀態（視窗內有領走紀錄的）：leases／reports／tripped／paused／retry_after_seconds。只給 service_role。2026-11-14';
REVOKE ALL ON agent_breaker_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON agent_breaker_status TO service_role;

-- 這個代理的重派冷卻中，最早解凍的那一件還要幾秒（沒有冷卻中的件回 NULL）：/next 沒有東西可派時，用它告訴代理「X 秒後再來」
-- 冷卻中＝任務：issued 在冷卻期內、之後沒交件；驗證票：派出在冷卻期內、這個代理沒投過（投過的本來就排除、不會等解凍）
CREATE OR REPLACE FUNCTION agent_cooldown_thaw_seconds(p_agent TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(x.t) + make_interval(secs => LEAST(x.cd, 86400)) - now()))))::INTEGER
    FROM (
      SELECT le.at AS t, qs.redispatch_cooldown_seconds AS cd
        FROM lease_events le CROSS JOIN queue_settings qs
       WHERE qs.id = 1 AND le.agent_name = p_agent AND le.event = 'issued'
         AND le.at > now() - make_interval(secs => LEAST(qs.redispatch_cooldown_seconds, 86400))
         AND NOT EXISTS (SELECT 1 FROM contributions rc WHERE rc.task_id = le.task_id AND rc.agent_name = le.agent_name AND rc.created_at >= le.at)
      UNION ALL
      SELECT vd.dispatched_at, qs.redispatch_cooldown_seconds
        FROM verify_dispatches vd CROSS JOIN queue_settings qs
       WHERE qs.id = 1 AND vd.agent_name = p_agent
         AND vd.dispatched_at > now() - make_interval(secs => LEAST(qs.redispatch_cooldown_seconds, 86400))
         AND NOT EXISTS (SELECT 1 FROM contribution_votes cv WHERE cv.contribution_id = vd.contribution_id AND lower(cv.agent_name) = lower(vd.agent_name))
    ) x
   GROUP BY x.cd
$$;
COMMENT ON FUNCTION agent_cooldown_thaw_seconds IS '這個代理的重派冷卻中，最早解凍的那一件還要幾秒；沒有冷卻中的回 NULL。20261114080000';
REVOKE ALL ON FUNCTION agent_cooldown_thaw_seconds(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agent_cooldown_thaw_seconds(TEXT) TO service_role;

-- ------------------------------------------------------------
-- 兩支派工函式：各加一段「同代理重派冷卻」合格條件；驗證池另把「15 分鐘內剛派過」改成只看代號。其餘與上一版逐字相同
--   contribution_queue_tasks 上一版 20261112110000、contribution_verify_pool 上一版 20261111170000
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 強模型待辦（20261109230000）：requires_tier='strong' 的難題不進一般派工，只由持鑰匙者 GET /next?lane=strong 認領
    AND d.target->>'requires_tier' IS DISTINCT FROM 'strong'
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面所有「合格」條件都在 LIMIT 之前：不合格的列不佔窗口（程式裡的過濾器發生在 LIMIT 之後，會讓窗口被不合格的列塞滿、全部剔掉就沒有任務可派）
    -- >>> 合格：認領中
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target)
             -- 工作卡鍵（20261111100000）：同一張卡（跨臂、跨指紋、手動任務與自動缺口）被別人認領中也不派
             OR (d.work_key IS NOT NULL AND l.work_key = d.work_key))
    ))
    -- 工作卡鍵的租約：p_ip_hash 為 NULL（不知道是誰）時視為全部是別人的，也排除；驗證票的租約沒有 work_key（不會擋到這裡）
    AND NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND d.work_key IS NOT NULL AND l.work_key = d.work_key
    )
    -- <<< 合格：認領中
    -- >>> 合格：同機器交過
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
    -- <<< 合格：同機器交過
    -- >>> 合格：任務停放
    -- 底下有任何一份交件還在途（pending／verified／disputed；任務編號看 contributions.task_id，欄是空的看 payload.task_id）的任務就停放：
    -- 派工列還在、排序鍵不動，只是不可派（20261017010000）。任一份通過 → 任務結束（手動任務 shouldCloseOnApplied、auto: 缺口列由觸發器
    -- contributions_drop_dispatch 收回）；全部被退 → 這個條件不成立，任務在原本的位置再派。不分誰來領，所以 p_ip_hash 為 NULL 也排。
    -- 不停放的三型（各有自己的既有規則，下面的標記照舊）：question（一題最多收 3 份答案）、adjudicate（已有裁決在等）、roster_check（一單位會交很多筆、在途額滿 5）
    -- 寫成兩個各自獨立的 NOT EXISTS（欄一個、payload 一個），不用 OR 包起來：OR 會讓規劃器改走逐列的子查詢（正式庫唯讀實測全量版本 5.5 秒），
    -- 分開寫才會變成 anti join、各走各的索引（contributions_task_id_status_idx、contributions_payload_task_inflight_idx）；三型例外放在子查詢裡當外層條件
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check') AND NOT task_target_multi_person(d.target)
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id = d.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check') AND NOT task_target_multi_person(d.target)
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id IS NULL AND f.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：任務停放
    -- >>> 合格：查無回報在等票
    -- 有人回報查無（no_change）還在等票或已通過、還沒落庫的任務，/next 不派給任何人（filterReportedDeadEnds）；不分誰來領，所以 p_ip_hash 為 NULL 也排
    AND NOT EXISTS (
      SELECT 1 FROM contributions n
      WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
        AND n.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：查無回報在等票
    -- >>> 合格：在途未額滿
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；
    -- 一人一包（20261112110000）：同一包只算一筆（DISTINCT coalesce(bundle_id, id)），一包 30 條不會讓任務瞬間額滿
    AND (SELECT count(DISTINCT coalesce(f.bundle_id, f.id)) FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed')) < 5
    -- <<< 合格：在途未額滿
    -- >>> 合格：提問未滿額
    -- 手動任務裡的公民提問（task_type＝question、不是 auto:）：已上線答案（citizen_questions.answer_count）＋還在等票的 question_answer ≥ question_answer_cap() 就不派（fullQuestionIdsOf）
    AND (d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR uuid_or_null(d.target->>'question_id') IS NULL OR
         COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id = uuid_or_null(d.target->>'question_id')), 0)
         + (SELECT count(*) FROM contributions a
             WHERE a.task_id = d.task_id AND a.contribution_type = 'question_answer' AND a.status IN ('pending', 'verified'))
         < question_answer_cap())
    -- <<< 合格：提問未滿額
    -- >>> 合格：提問這台答過
    -- 這個代號答過這一題（question_answers，含已上線）、或這個代號／IP 交過這個任務的 question_answer（含 applied）就不再派給他（my_answers + filterAnsweredQuestionTasks）
    AND (p_ip_hash IS NULL OR d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR (
      NOT EXISTS (SELECT 1 FROM question_answers qa
                   WHERE qa.question_id = uuid_or_null(d.target->>'question_id') AND lower(qa.agent_name) = lower(COALESCE(p_agent, '')))
      AND NOT EXISTS (SELECT 1 FROM contributions m
                       WHERE m.task_id = d.task_id AND m.contribution_type = 'question_answer' AND m.status = 'applied'
                         AND (m.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND m.agent_name = p_agent)))
    ))
    -- <<< 合格：提問這台答過
    -- >>> 合格：裁決任務
    -- 裁決任務（task_type＝adjudicate，target.contribution_id＝原貢獻）：這筆爭議已有 pending／verified 的裁決在等票就不再派（不分誰來領）；
    -- 原貢獻是他自己交的、或這台機器（p_ip_hash）對原貢獻投過票的不派給他（filterAdjudicateTasks；過渡期的舊雜湊那一半仍在程式裡）
    AND (d.task_type <> 'adjudicate' OR (
      NOT EXISTS (SELECT 1 FROM contributions j
                   WHERE j.contribution_type = 'adjudication' AND j.status IN ('pending', 'verified')
                     AND j.payload->>'contribution_id' = d.target->>'contribution_id')
      AND (p_ip_hash IS NULL OR (
        (p_agent IS NULL OR lower(d.target->>'contributor') IS DISTINCT FROM lower(p_agent))
        AND NOT EXISTS (SELECT 1 FROM contribution_votes v
                         WHERE v.contribution_id = uuid_or_null(d.target->>'contribution_id') AND v.verifier_ip_hash = p_ip_hash)
      ))
    ))
    -- <<< 合格：裁決任務
    -- >>> 合格：同代理重派冷卻
    -- 同一個代理（只比代號，大小寫不分）在 redispatch_cooldown_seconds（queue_settings，預設 4 小時）內被派過這個任務、而且那之後沒有交件，就不再派給它
    -- （20261114080000）；skip 也一樣（skip 前一定先被派過）。別的代理照樣領得到。「被派過」＝lease_events 的 issued（認領建立）。
    -- 回看期 LEAST(…, 86400) 是設定的 CHECK 上限，守門抽得出來。
    AND (p_agent IS NULL OR NOT EXISTS (
      SELECT 1 FROM lease_events le CROSS JOIN queue_settings qs
      WHERE qs.id = 1 AND le.task_id = d.task_id AND le.event = 'issued' AND lower(le.agent_name) = lower(p_agent)
        AND le.at > now() - make_interval(secs => LEAST(qs.redispatch_cooldown_seconds, 86400))
        AND NOT EXISTS (SELECT 1 FROM contributions rc WHERE rc.task_id = d.task_id AND rc.agent_name = le.agent_name AND rc.created_at >= le.at)
    ))
    -- <<< 合格：同代理重派冷卻
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

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
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
