-- 網站請求併入既有缺口任務（2026-11-11，維護者 2026-11-10 裁決）
--
-- 起因：開著的網站請求 1,578 件、缺政見 1,396 件；其中 1,314 件因公報還沒上架停放（web_request_parked，20261028130000）。
-- 公報上架日，村里長、鄉鎮市民代表的缺政見自動缺口（auto:policy_missing／auto:term_policy_missing）會對幾乎同一批人開出約 1,300 件——
-- 同一件事派兩次（一次網站請求、一次缺口）。現在已有 57 件網站請求跟開著的缺口是同一個人。
--
-- 做法（一句話：缺口是主任務，網站請求只是「有人想看」的訊號）：
--   1. 覆蓋：開著的缺政見網站請求，它的人物（請求有指定選舉就連選舉）有開著的缺口列（task_dispatches 裡 auto:policy_missing:<人物>
--      或 auto:term_policy_missing:<人物>:<選舉>）→ 視為「被缺口覆蓋」：不單獨派（跟停放一樣從派工臂 manual_visitor 拿掉），任務本身仍是 open。
--      視圖 web_request_coverage 列出每一組（請求 × 缺口）。
--   2. 提高優先：覆蓋它的缺口至少拿到網站請求的待遇——插隊一次（queue_settings.visitor_front_seconds，10 年；GREATEST，不疊加）。
--      插隊秒數派出就歸零，所以標記記在缺口列 opened_by.web_request_boost_ids（已算過的請求 id）：同一份請求不重複算、seed 不會每 10 分鐘重加；
--      之後又有新請求覆蓋同一缺口才再插一次。缺口在查核冷卻中（cool_until 未到、或 task_in_check_cooldown）不插（插了會蓋掉冷卻），冷卻過了下一輪補。
--   3. 結案：只有「這個人現在真的有承諾了」才自動關。條件全部要成立：①請求存在期間這個人（同選舉）出現過缺口事件（gap_events 任何事件，證明請求真的被缺口覆蓋過，
--      不是一般的「再多查一點」請求）②現在沒有任何開著的缺口覆蓋它 ③人物現在有未移除的政見（請求有指定選舉就那一屆；沒指定就用缺口那一屆、再沒有就當屆；
--      當屆須是 is_campaign_pledge，同 raw 臂的缺口定義）。滿足就關，closed_reason＝'gap_filled:<缺口 task_id>'，訪客看到的跟一般完成一樣（已處理完）。
--      **絕不單憑 gap_events 的 closed／filled 關**：auto: 派工列的任何刪除都記 filled（非政見貢獻 applied 的 drop_applied、seed 重建、人物合併、臂條件改動、
--      11/29 policy_missing → term_policy_missing 交接都會），那不代表補上了。關閉只在 10 分鐘對帳（web_request_gap_sync）做，不在觸發器裡同步做。
--      缺口以 window 關閉（窗口關了、沒補上）→ 沒有承諾 → 不關，請求不再被覆蓋、下一輪 seed 重新進佇列，並接回原本的派出次數、進隊時間、冷卻與插隊（見下）。
--   4. 沒有缺口（公報前停放的人）什麼都不變；公報日缺口一開，規則 1、2 自動生效。
-- 機制（不動 seed_auto_task_queue／manual_front_pull，避免牽動日本站複本與一排守門清單）：
--   · 臂本體 contribution_auto_tasks_manual 多一條「沒被覆蓋」
--   · task_dispatches 的觸發器：缺口列出生 → 收回被它覆蓋的請求派工列＋插隊；請求派工列要入列但已被覆蓋 → 不入列（兩種先後順序都接得住，seed 同一個語句裡先後不定）
--   · contribution_tasks 的觸發器：新請求建立 → 覆蓋它的缺口插隊
--   · pg_cron web-request-gap-sync-10min（每 10 分鐘，seed 後 5 分）：關已有承諾的請求、收回殘留派工列、補插隊
--   · 被覆蓋而收回派工列時，派出次數、進隊時間、冷卻、插隊記在 web_request_dispatch_memory，重新入列時接回（不從隊尾重來、不再拿一次出生插隊）
-- 日本站不動。

-- ------------------------------------------------------------
-- 1. 結案原因欄位、索引
-- ------------------------------------------------------------
ALTER TABLE contribution_tasks ADD COLUMN IF NOT EXISTS closed_reason TEXT;
COMMENT ON COLUMN contribution_tasks.closed_reason IS '任務怎麼結束的（只有系統自動結案的才填）：gap_filled:<缺口 task_id>＝被它覆蓋的缺口任務補完了（網站請求併入缺口，2026-11-11）；其他結案方式留空';

CREATE INDEX IF NOT EXISTS idx_contribution_tasks_web_request_open_politician
  ON contribution_tasks ((target->>'politician_id')) WHERE source = 'web_request' AND status = 'open';

-- 缺口列的人物索引：覆蓋視圖、請求入列的 BEFORE INSERT 觸發器、臂的 NOT EXISTS 都靠它（task_dispatches 約 8 千列，建索引的鎖是瞬間的，不用 CONCURRENTLY）
CREATE INDEX IF NOT EXISTS idx_task_dispatches_gap_politician
  ON task_dispatches ((target->>'politician_id'))
  WHERE task_id LIKE 'auto:policy\_missing:%' OR task_id LIKE 'auto:term\_policy\_missing:%';

-- 被覆蓋而收回的請求派工列的歷史（重新入列時接回）；私有表，只有 SECURITY DEFINER 函式與 service_role 碰
CREATE TABLE IF NOT EXISTS web_request_dispatch_memory (
  task_id            UUID PRIMARY KEY,
  dispatch_count     INTEGER NOT NULL DEFAULT 0,
  last_dispatched_at TIMESTAMPTZ,
  cool_until         TIMESTAMPTZ,
  boost_seconds      BIGINT NOT NULL DEFAULT 0,
  dispatch_base_at   TIMESTAMPTZ,
  saved_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE web_request_dispatch_memory ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE web_request_dispatch_memory IS '網站請求被缺口覆蓋、派工列被收回時，記下那一列的派出次數、進隊時間、冷卻、插隊與驗證基準；請求重新入列（缺口以 window 關閉等）時由 BEFORE INSERT 觸發器接回，不從隊尾重來。對帳時清掉已入列或已結束的。2026-11-11';

-- ------------------------------------------------------------
-- 2. 缺口 task_id 的拆解（政見缺口兩種：auto:policy_missing:<人物>、auto:term_policy_missing:<人物>:<選舉>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION web_request_gap_task(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_task_id LIKE 'auto:policy\_missing:%' OR p_task_id LIKE 'auto:term\_policy\_missing:%'
$$;
COMMENT ON FUNCTION web_request_gap_task IS '是不是「缺政見」的自動缺口（policy_missing／term_policy_missing）：網站請求併入缺口的對象。2026-11-11';

CREATE OR REPLACE FUNCTION web_request_gap_election(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_task_id LIKE 'auto:term\_policy\_missing:%' THEN NULLIF(split_part(p_task_id, ':', 4), '') END
$$;
COMMENT ON FUNCTION web_request_gap_election IS 'term_policy_missing 缺口 task_id 末段的選舉 id；policy_missing 缺口沒有（選舉記在 target／gap_events.election_id）。2026-11-11';

-- ------------------------------------------------------------
-- 3. 視圖：被缺口覆蓋的網站請求（一列＝一個請求 × 一個覆蓋它的缺口）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW web_request_coverage AS
SELECT t.id AS task_id,
       t.target->>'politician_id' AS politician_id,
       t.target->>'election_id' AS election_id,
       t.created_at AS requested_at,
       d.task_id AS gap_task_id,
       split_part(d.task_id, ':', 2) AS gap_arm,
       d.opened_at AS gap_opened_at,
       d.boost_seconds AS gap_boost_seconds,
       d.queue_at AS gap_queue_at,
       COALESCE(d.opened_by->'web_request_boost_ids' ? t.id::TEXT, false) AS boost_counted,
       web_request_parked(t.id) AS parked
  FROM contribution_tasks t
  JOIN task_dispatches d
    ON web_request_gap_task(d.task_id)
   AND d.target->>'politician_id' = t.target->>'politician_id'
   AND (t.target->>'election_id' IS NULL OR d.target->>'election_id' = t.target->>'election_id')
 WHERE t.source = 'web_request' AND t.task_type = 'policy_missing' AND t.status = 'open';
COMMENT ON VIEW web_request_coverage IS '被既有缺口任務（auto:policy_missing／auto:term_policy_missing）覆蓋的開著的網站請求：同一個人物、請求有指定選舉就同一場選舉。覆蓋中的請求不單獨派（派工臂 manual_visitor 不輸出），缺口拿到網站請求的插隊；boost_counted＝這份請求已算進缺口的插隊標記。2026-11-11';

-- ------------------------------------------------------------
-- 4. 臂本體：同 20261028130000，多一條「沒被缺口覆蓋」
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN, p_id UUID DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT t.id::TEXT, t.task_type,
         jsonb_strip_nulls(jsonb_build_object(
           'title', t.title, 'region', t.region,
           'stance_up', CASE WHEN t.task_type = 'question'
                             THEN COALESCE((SELECT q.stance_up FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0) END)) || t.target,
         COALESCE(NULLIF(t.description, ''), t.title), t.hint_sources, t.reward, t.region
    FROM contribution_tasks t
   WHERE t.status = 'open' AND manual_task_is_visitor(t.source, t.task_type) = p_visitor
     AND (p_id IS NULL OR t.id = p_id)
     -- >>> 停放（20261028130000）：村里長／鄉鎮市民代表缺政見、公報還沒上架
     AND NOT web_request_parked(t.id)
     -- <<< 停放
     -- >>> 併入既有缺口（20261111010000）：同一個人（與選舉）已有開著的缺政見缺口，這份請求由缺口處理
     AND NOT EXISTS (SELECT 1 FROM web_request_coverage wc WHERE wc.task_id = t.id)
     -- <<< 併入既有缺口
     AND NOT (t.task_type = 'question' AND t.target->>'question_id' IS NOT NULL
              AND COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0)
                  + (SELECT count(*) FROM contributions c
                      WHERE c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified')
                        AND c.task_id IN (SELECT t2.id::TEXT FROM contribution_tasks t2 WHERE t2.task_type = 'question' AND t2.target->>'question_id' = t.target->>'question_id'))
                  >= question_answer_cap())
$$;
COMMENT ON FUNCTION contribution_auto_tasks_manual IS
  '派工臂 manual_visitor（p_visitor＝true：網站請求與公民提問）／manual_open（false：維護者建、裁決、外部提議…）：contribution_tasks 裡 open 的任務。task_id＝任務 id（uuid 文字）。'
  '2026-10-28 起停放中的網站請求（web_request_parked）不出現；2026-11-11 起被既有缺口覆蓋的網站請求（web_request_coverage）也不出現；target 在原 target 之外補 title、region 與公民提問的 stance_up；已收滿答案的公民提問不出現。';

-- ------------------------------------------------------------
-- 5. 動作：收回被覆蓋的請求派工列、缺口插隊、關被補完的請求
-- ------------------------------------------------------------
-- 收回被覆蓋的請求的派工列（p_gap 有給就只看那個缺口）；收回前把歷史記進 web_request_dispatch_memory
CREATE OR REPLACE FUNCTION web_request_drop_covered(p_gap TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INTEGER;
BEGIN
  WITH del AS (
    DELETE FROM task_dispatches d USING web_request_coverage c
     WHERE d.task_id = c.task_id::TEXT AND (p_gap IS NULL OR c.gap_task_id = p_gap)
    RETURNING c.task_id AS tid, d.dispatch_count, d.last_dispatched_at, d.cool_until, d.boost_seconds, d.dispatch_base_at),
  mem AS (
    INSERT INTO web_request_dispatch_memory (task_id, dispatch_count, last_dispatched_at, cool_until, boost_seconds, dispatch_base_at)
    SELECT DISTINCT ON (tid) tid, dispatch_count, last_dispatched_at, cool_until, boost_seconds, dispatch_base_at FROM del ORDER BY tid
    ON CONFLICT (task_id) DO UPDATE SET dispatch_count = EXCLUDED.dispatch_count, last_dispatched_at = EXCLUDED.last_dispatched_at, cool_until = EXCLUDED.cool_until,
      boost_seconds = EXCLUDED.boost_seconds, dispatch_base_at = EXCLUDED.dispatch_base_at, saved_at = now()
    RETURNING 1)
  SELECT count(*) INTO n FROM del;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION web_request_drop_covered IS '收回被缺口覆蓋的網站請求的派工列（臂已經不輸出，這裡讓它即時消失），收回前把派出次數、進隊時間、冷卻、插隊記進 web_request_dispatch_memory。回傳收回幾列。2026-11-11';

-- 缺口拿到網站請求的待遇：插隊一次（GREATEST 不疊加）。標記 opened_by.web_request_boost_ids 記已算過的請求 id，所以冪等；
-- 冷卻中的缺口不插（不標記，冷卻過了再補）。p_gap／p_req 可限縮範圍（觸發器用），都空＝全部（安全網用）
CREATE OR REPLACE FUNCTION web_request_gap_boost(p_gap TEXT DEFAULT NULL, p_req UUID DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH s AS (SELECT q.visitor_front_seconds AS secs FROM queue_settings q WHERE q.id = 1),
  fresh AS (
    SELECT c.gap_task_id, jsonb_agg(c.task_id::TEXT ORDER BY c.requested_at, c.task_id) AS ids
      FROM web_request_coverage c
     WHERE NOT c.boost_counted AND (p_gap IS NULL OR c.gap_task_id = p_gap) AND (p_req IS NULL OR c.task_id = p_req)
     GROUP BY c.gap_task_id),
  upd AS (
    UPDATE task_dispatches d
       SET boost_seconds = GREATEST(d.boost_seconds, s.secs),
           opened_by = jsonb_set(COALESCE(d.opened_by, '{}'::JSONB), '{web_request_boost_ids}',
                                 COALESCE(d.opened_by->'web_request_boost_ids', '[]'::JSONB) || f.ids)
      FROM fresh f CROSS JOIN s
     WHERE d.task_id = f.gap_task_id
       AND (d.cool_until IS NULL OR d.cool_until <= now())
       AND NOT task_in_check_cooldown(d.task_id)
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION web_request_gap_boost IS '覆蓋網站請求的缺口列至少拿到 visitor_front_seconds 的插隊（一次、冪等：opened_by.web_request_boost_ids 記已算過的請求；查核冷卻中的缺口不插）。回傳被插隊的缺口列數。2026-11-11';

-- 這個人（那一屆）現在有承諾嗎：未移除的政見；那一屆是當屆（campaign_election_id）時要是 is_campaign_pledge（同 raw 臂缺口的定義：沒有當屆承諾），
-- 其他屆（term_policy_missing：沒有那一屆的政見）任何未移除的政見都算。p_election 空＝當屆
CREATE OR REPLACE FUNCTION web_request_has_pledges(p_politician TEXT, p_election TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  WITH e AS (SELECT COALESCE(election_id_or_null(NULLIF(p_election, '')), campaign_election_id()) AS id)
  SELECT EXISTS (
    SELECT 1 FROM policies pl, e
     WHERE pl.politician_id::TEXT = p_politician AND pl.removed_at IS NULL AND pl.election_id = e.id
       AND (e.id IS DISTINCT FROM campaign_election_id() OR is_campaign_pledge(pl.status::TEXT, pl.origin)))
$$;
COMMENT ON FUNCTION web_request_has_pledges IS '人物在那一屆（空＝當屆）現在有沒有承諾：未移除的政見，當屆要 is_campaign_pledge。網站請求併入缺口後自動結案的條件之一。2026-11-11';

-- 自動結案：請求存在期間這個人出現過缺口事件（證明請求真的被缺口覆蓋過）、現在沒有缺口覆蓋它、而且人物現在有承諾。絕不單憑 gap_events 的 filled 關
CREATE OR REPLACE FUNCTION web_request_close_satisfied() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH ev AS (
    SELECT split_part(e.task_id, ':', 3) AS pid, COALESCE(web_request_gap_election(e.task_id), e.election_id::TEXT) AS eid,
           max(e.at) AS last_at, (array_agg(e.task_id ORDER BY e.at DESC))[1] AS gap_task_id
      FROM gap_events e
     WHERE web_request_gap_task(e.task_id)
       AND e.at >= COALESCE((SELECT min(r.created_at) FROM contribution_tasks r WHERE r.source = 'web_request' AND r.task_type = 'policy_missing' AND r.status = 'open'), now())
     GROUP BY 1, 2),
  pick AS (
    SELECT DISTINCT ON (r.id) r.id, ev.gap_task_id
      FROM contribution_tasks r
      JOIN ev ON ev.pid = r.target->>'politician_id' AND ev.last_at >= r.created_at
       AND (r.target->>'election_id' IS NULL OR ev.eid IS NULL OR ev.eid = r.target->>'election_id')
     WHERE r.source = 'web_request' AND r.task_type = 'policy_missing' AND r.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM web_request_coverage c WHERE c.task_id = r.id)
       AND web_request_has_pledges(r.target->>'politician_id', COALESCE(r.target->>'election_id', ev.eid))
     ORDER BY r.id, ev.last_at DESC),
  upd AS (
    UPDATE contribution_tasks t SET status = 'closed', closed_at = now(), closed_reason = 'gap_filled:' || pick.gap_task_id
      FROM pick WHERE t.id = pick.id AND t.status = 'open'
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION web_request_close_satisfied IS '關掉「被缺口覆蓋過、缺口已不覆蓋、人物現在有承諾」的網站請求（closed_reason＝gap_filled:<缺口 task_id>）。只在 web_request_gap_sync 裡跑；缺口被收回（非政見貢獻 applied、seed 重建、人物合併、臂條件改動）不代表補上了，所以不能單憑 gap_events。回傳關了幾件。2026-11-11';

-- 對帳（pg_cron）：關已有承諾的、收回殘留的派工列、補插隊、清記憶
CREATE OR REPLACE FUNCTION web_request_gap_sync() RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_closed INTEGER; v_dropped INTEGER; v_boosted INTEGER;
BEGIN
  v_closed := web_request_close_satisfied();
  v_dropped := web_request_drop_covered();
  v_boosted := web_request_gap_boost();
  DELETE FROM web_request_dispatch_memory m
   WHERE EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = m.task_id::TEXT)
      OR NOT EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id = m.task_id AND t.status = 'open');
  RETURN jsonb_build_object('closed', v_closed, 'dropped', v_dropped, 'boosted', v_boosted);
END;
$$;
COMMENT ON FUNCTION web_request_gap_sync IS '網站請求併入缺口的對帳（pg_cron web-request-gap-sync-10min）：關已有承諾的請求（web_request_close_satisfied）、收回被覆蓋請求的殘留派工列、補缺口插隊；清掉已入列或已結束的 web_request_dispatch_memory。都冪等。2026-11-11';

-- ------------------------------------------------------------
-- 6. 觸發器
-- ------------------------------------------------------------
-- 缺口列出生：收回被它覆蓋的請求派工列、缺口插隊
CREATE OR REPLACE FUNCTION task_dispatches_web_request_gap() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM web_request_drop_covered(NEW.task_id);
  PERFORM web_request_gap_boost(NEW.task_id, NULL);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_task_dispatches_web_request_gap ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_web_request_gap AFTER INSERT ON task_dispatches
  FOR EACH ROW WHEN (web_request_gap_task(NEW.task_id)) EXECUTE FUNCTION task_dispatches_web_request_gap();

-- 請求的派工列要入列：已被缺口覆蓋就不入列（seed 的新增與缺口出生在同一個語句，誰先誰後不定；缺口先到由這裡擋，請求先到由上面收回）；
-- 沒被覆蓋而記憶裡有它的歷史（以前被覆蓋收回過）就接回派出次數、進隊時間、冷卻、插隊（排序鍵由後面的 queue_key 觸發器照這些重算）
CREATE OR REPLACE FUNCTION task_dispatches_web_request_covered() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m web_request_dispatch_memory%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM web_request_coverage c WHERE c.task_id = NEW.task_id::UUID) THEN RETURN NULL; END IF;
  SELECT * INTO m FROM web_request_dispatch_memory WHERE task_id = NEW.task_id::UUID;
  IF FOUND THEN
    NEW.dispatch_count := m.dispatch_count;
    NEW.last_dispatched_at := COALESCE(m.last_dispatched_at, NEW.last_dispatched_at);
    NEW.cool_until := m.cool_until;
    NEW.boost_seconds := m.boost_seconds;
    NEW.dispatch_base_at := COALESCE(m.dispatch_base_at, NEW.dispatch_base_at);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_task_dispatches_a_web_request_covered ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_a_web_request_covered BEFORE INSERT ON task_dispatches
  FOR EACH ROW WHEN (NEW.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') EXECUTE FUNCTION task_dispatches_web_request_covered();

-- 新的缺政見網站請求：覆蓋它的缺口插隊
CREATE OR REPLACE FUNCTION contribution_tasks_web_request_boost() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM web_request_gap_boost(NULL, NEW.id);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_contribution_tasks_web_request_boost ON contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_web_request_boost AFTER INSERT ON contribution_tasks
  FOR EACH ROW WHEN (NEW.source = 'web_request' AND NEW.task_type = 'policy_missing' AND NEW.status = 'open') EXECUTE FUNCTION contribution_tasks_web_request_boost();

-- ------------------------------------------------------------
-- 7. 排程與一次對帳
-- ------------------------------------------------------------
-- seed 在每 10 分鐘的 0 分，這支晚 5 分
SELECT cron.unschedule('web-request-gap-sync-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-request-gap-sync-10min');
SELECT cron.schedule('web-request-gap-sync-10min', '5-59/10 * * * *', $$SELECT web_request_gap_sync();$$);

-- 現有的：收回已被覆蓋的請求派工列、補缺口插隊、關已有承諾的（之後由觸發器與排程維持）
SELECT web_request_gap_sync();

NOTIFY pgrst, 'reload schema';
