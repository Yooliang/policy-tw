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
--   3. 結案：缺口以 filled 關閉（gap_events closed／filled，補上了或臂算不出來；含貢獻 applied 的 drop_applied）→ 被它覆蓋的請求自動關閉，
--      closed_reason＝'gap_filled:<缺口 task_id>'，訪客看到的跟一般完成一樣（已處理完）。缺口以 window 關閉（窗口關了、沒補上）不關請求，
--      請求不再被覆蓋、下一輪 seed 重新進佇列。缺口還開著（例如縣市長缺口 filled 又重開）時不關。
--   4. 沒有缺口（公報前停放的人）什麼都不變；公報日缺口一開，規則 1、2 自動生效。
-- 機制（不動 seed_auto_task_queue／manual_front_pull，避免牽動日本站複本與一排守門清單）：
--   · 臂本體 contribution_auto_tasks_manual 多一條「沒被覆蓋」
--   · task_dispatches 的觸發器：缺口列出生 → 收回被它覆蓋的請求派工列＋插隊；請求派工列要入列但已被覆蓋 → 不入列（兩種先後順序都接得住，seed 同一個語句裡先後不定）
--   · contribution_tasks 的觸發器：新請求建立 → 覆蓋它的缺口插隊
--   · gap_events 的觸發器：缺口 filled 關閉 → 關被它覆蓋的請求
--   · pg_cron web-request-gap-sync-10min（每 10 分鐘，seed 後 5 分）：安全網，補關近 3 天 filled 事件漏的、收回殘留派工列、補插隊
-- 日本站不動。

-- ------------------------------------------------------------
-- 1. 結案原因欄位、索引
-- ------------------------------------------------------------
ALTER TABLE contribution_tasks ADD COLUMN IF NOT EXISTS closed_reason TEXT;
COMMENT ON COLUMN contribution_tasks.closed_reason IS '任務怎麼結束的（只有系統自動結案的才填）：gap_filled:<缺口 task_id>＝被它覆蓋的缺口任務補完了（網站請求併入缺口，2026-11-11）；其他結案方式留空';

CREATE INDEX IF NOT EXISTS idx_contribution_tasks_web_request_open_politician
  ON contribution_tasks ((target->>'politician_id')) WHERE source = 'web_request' AND status = 'open';

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
-- 收回被覆蓋的請求的派工列（p_gap 有給就只看那個缺口）
CREATE OR REPLACE FUNCTION web_request_drop_covered(p_gap TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH del AS (
    DELETE FROM task_dispatches d USING web_request_coverage c
     WHERE d.task_id = c.task_id::TEXT AND (p_gap IS NULL OR c.gap_task_id = p_gap)
    RETURNING 1)
  SELECT count(*) INTO n FROM del;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION web_request_drop_covered IS '收回被缺口覆蓋的網站請求的派工列（臂已經不輸出，這裡讓它即時消失）。回傳收回幾列。2026-11-11';

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

-- 缺口 filled 關閉後，關掉被它覆蓋過的請求：同人物、請求沒指定選舉或選舉相同、請求在缺口關閉之前就存在，
-- 而且現在沒有別的缺口還覆蓋它（缺口 filled 又重開、還開著的不關）
CREATE OR REPLACE FUNCTION web_request_close_filled(p_gap TEXT, p_election TEXT, p_at TIMESTAMPTZ) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH upd AS (
    UPDATE contribution_tasks t
       SET status = 'closed', closed_at = now(), closed_reason = 'gap_filled:' || p_gap
     WHERE t.source = 'web_request' AND t.task_type = 'policy_missing' AND t.status = 'open'
       AND t.target->>'politician_id' = split_part(p_gap, ':', 3)
       AND (t.target->>'election_id' IS NULL OR p_election IS NULL OR t.target->>'election_id' = p_election)
       AND t.created_at <= p_at
       AND NOT EXISTS (SELECT 1 FROM web_request_coverage c WHERE c.task_id = t.id)
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION web_request_close_filled IS '缺口（auto:policy_missing／auto:term_policy_missing）以 filled 關閉後，關掉被它覆蓋過的網站請求（closed_reason＝gap_filled:<缺口 task_id>）。已有別的缺口覆蓋的不關。回傳關了幾件。2026-11-11';

-- 安全網（pg_cron）：補關近 3 天 filled 事件漏的、收回殘留的派工列、補插隊
CREATE OR REPLACE FUNCTION web_request_gap_sync() RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_closed INTEGER := 0; v_dropped INTEGER; v_boosted INTEGER;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (e.task_id) e.task_id, COALESCE(web_request_gap_election(e.task_id), e.election_id::TEXT) AS eid, e.at
      FROM gap_events e
     WHERE e.event = 'closed' AND e.reason = 'filled' AND web_request_gap_task(e.task_id)
       AND e.at > now() - INTERVAL '3 days'
     ORDER BY e.task_id, e.at DESC
  LOOP
    v_closed := v_closed + web_request_close_filled(r.task_id, r.eid, r.at);
  END LOOP;
  v_dropped := web_request_drop_covered();
  v_boosted := web_request_gap_boost();
  RETURN jsonb_build_object('closed', v_closed, 'dropped', v_dropped, 'boosted', v_boosted);
END;
$$;
COMMENT ON FUNCTION web_request_gap_sync IS '網站請求併入缺口的對帳（pg_cron web-request-gap-sync-10min）：補關近 3 天 filled 事件對應的請求、收回被覆蓋請求的殘留派工列、補缺口插隊。三步都冪等。2026-11-11';

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

-- 請求的派工列要入列，但已被缺口覆蓋：不入列（seed 的新增與缺口出生在同一個語句，誰先誰後不定；缺口先到由這裡擋，請求先到由上面收回）
CREATE OR REPLACE FUNCTION task_dispatches_web_request_covered() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM web_request_coverage c WHERE c.task_id = NEW.task_id::UUID) THEN RETURN NULL; END IF;
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

-- 缺口 filled 關閉：關被它覆蓋的請求
CREATE OR REPLACE FUNCTION gap_events_web_request_close() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM web_request_close_filled(NEW.task_id, COALESCE(web_request_gap_election(NEW.task_id), NEW.election_id::TEXT), NEW.at);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_gap_events_web_request_close ON gap_events;
CREATE TRIGGER trg_gap_events_web_request_close AFTER INSERT ON gap_events
  FOR EACH ROW WHEN (NEW.event = 'closed' AND NEW.reason = 'filled' AND web_request_gap_task(NEW.task_id)) EXECUTE FUNCTION gap_events_web_request_close();

-- ------------------------------------------------------------
-- 7. 排程與一次對帳
-- ------------------------------------------------------------
-- seed 在每 10 分鐘的 0 分，這支晚 5 分
SELECT cron.schedule('web-request-gap-sync-10min', '5-59/10 * * * *', $$SELECT web_request_gap_sync();$$);

-- 現有的：收回已被覆蓋的請求派工列、補缺口插隊、補關近 3 天 filled 的（之後由觸發器與排程維持）
SELECT web_request_gap_sync();

NOTIFY pgrst, 'reload schema';
