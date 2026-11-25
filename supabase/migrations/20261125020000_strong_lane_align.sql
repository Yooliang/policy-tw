-- 強模型待辦：list／sweep／auto_enqueue 三者對「原貢獻還活著」對齊（2026-11-25）
-- ============================================================
--
-- 現象：主控台「強模型待辦」有 4 件 open 任務一直沒人處理。
--   - 3 件（原貢獻 applied／rejected）：原貢獻已結案，strong_adjudications_auto_enqueue 只排 pending／disputed 的交件→永遠不會被排；
--     但 strong_lane_list() 與 strong_lane_sweep() 只看任務 open、不看原貢獻狀態→一直掛在清單上、沒人知道它們是殭屍。
--   - 1 件（原貢獻 pending）：兩筆作業都 finalize_failed（/report 400 correction_invalid：強模型的 corrected_fields 把政見 description
--     改成 11 字，不到交件驗證的 20 字下限），撞 auto_enqueue 累計 2 筆的上限→也永遠不會再排，而清單上看起來跟正常待辦一樣。
--
-- 做法：
--   1. strong_lane_contribution_live(contribution_id)：共用判斷。原貢獻狀態是 pending／disputed→true；已結案→false；
--      查不到原貢獻→true（沒有證據證明它結案，維持 auto_enqueue 原行為，list 會另標 contribution_missing）。
--   2. strong_adjudications_auto_enqueue：只把原本內嵌的「原貢獻已結案」子查詢換成共用判斷，邏輯不變。
--      （原定義在 20261120110000_strong_adjudications_auto_enqueue.sql，正式庫現行定義與它逐字一致；那支的守門測試照舊跑那份檔。）
--   3. strong_lane_sweep：開頭多一段「收殭屍」——原貢獻已結案、又沒有作業在排隊／執行／等定案的 open 強模型任務，關掉並記
--      closed_reason='contribution_resolved:<原貢獻狀態>'。開任務的邏輯不變；任務說明多一條④，提醒更正後整份 payload 仍要過交件驗證。
--   4. strong_lane_list：排除原貢獻已結案的任務（total 同步；但還有作業在排隊／執行／等定案的照列）；每件多四個欄位（只增不減，既有讀者不受影響）：
--        stalled_reason  卡住原因：contribution_missing／retry_cap_finalize_failed／retry_cap_failed／returned_to_human；正常為 null
--        job_count       累計作業筆數
--        last_job_status 最新一筆作業狀態
--        last_job_error  最新一筆作業的失敗代碼（report_response.error，如 correction_invalid；沒有就取 error 前 80 字）
--      「卡住」＝沒有作業在排隊／執行／等定案，且（累計 ≥2 筆而最新不是 finalized，或最新一筆已退回人工）。
-- 簽名與回傳型別都不動。日本站不跟。

-- 1. 共用判斷
CREATE OR REPLACE FUNCTION strong_lane_contribution_live(p_contribution_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM contributions c WHERE c.id::TEXT = p_contribution_id AND c.status NOT IN ('pending', 'disputed'))
$fn$;
COMMENT ON FUNCTION strong_lane_contribution_live IS '強模型待辦共用判斷（2026-11-25）：原貢獻還沒結案（pending／disputed）或查不到→true；已結案（applied／rejected…）→false。strong_lane_list／strong_lane_sweep／strong_adjudications_auto_enqueue 三者共用，避免各寫各的又漂開。';
REVOKE ALL ON FUNCTION strong_lane_contribution_live(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION strong_lane_contribution_live(TEXT) TO anon, authenticated, service_role;

-- 2. auto_enqueue（＝20261120110000 的定義，只換一處子查詢）
CREATE OR REPLACE FUNCTION strong_adjudications_auto_enqueue(p_limit INTEGER DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_on BOOLEAN; v_cap INTEGER; v_lim INTEGER; v_n INTEGER := 0; v_ins INTEGER; r RECORD;
BEGIN
  SELECT s.enabled AND s.auto_enqueue_enabled, s.auto_enqueue_limit INTO v_on, v_cap FROM strong_lane_settings s WHERE s.id = 1;
  IF NOT COALESCE(v_on, false) THEN RETURN 0; END IF;
  v_lim := COALESCE(p_limit, v_cap);
  IF v_lim < 1 OR v_lim > 200 THEN RAISE EXCEPTION 'p_limit 要是 1～200 的整數（收到 %）', v_lim; END IF;
  FOR r IN
    SELECT t.id::TEXT AS task_id, NULLIF(t.target->>'contribution_id', '') AS contribution_id
      FROM contribution_tasks t
     WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'
       -- 原貢獻已被一般驗證結案（狀態不是 pending／disputed）就不排：強模型任務只為還沒定案的交件開（共用判斷，list／sweep 同一份）
       AND strong_lane_contribution_live(t.target->>'contribution_id')
       -- busy：排隊中、執行中，或 30 分鐘內剛出爐（previewed／finalizing）
       AND NOT EXISTS (SELECT 1 FROM strong_adjudications a WHERE a.task_id = t.id::TEXT
                          AND (a.status IN ('queued', 'running')
                               OR (a.status IN ('previewed', 'finalizing') AND COALESCE(a.completed_at, a.created_at) >= now() - interval '30 minutes')))
       -- returned：最新一筆是人退回的，不自動再跑
       AND COALESCE((SELECT a.status FROM strong_adjudications a WHERE a.task_id = t.id::TEXT ORDER BY a.created_at DESC LIMIT 1), '') <> 'returned'
       -- retry_cap：累計已有 2 筆作業（任何狀態）就不再排
       AND (SELECT count(*) FROM strong_adjudications a WHERE a.task_id = t.id::TEXT) < 2
     ORDER BY t.created_at, t.id
     LIMIT v_lim
  LOOP
    -- created_at 用 clock_timestamp()：同一輪排入的列各有先後，執行者 oldestQueued 才會照最舊任務先領
    INSERT INTO strong_adjudications (task_id, contribution_id, requested_by, created_at) VALUES (r.task_id, r.contribution_id, 'auto-enqueue', clock_timestamp())
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    v_n := v_n + v_ins;
  END LOOP;
  RETURN v_n;
END;
$fn$;
COMMENT ON FUNCTION strong_adjudications_auto_enqueue IS '強模型任務自動排入作業表（規則同主控台 enqueue_all：busy／returned／retry_cap 跳過，最舊先，每輪上限；原貢獻已結案的不排，判斷同 strong_lane_contribution_live）。pg_cron 每 10 分鐘呼叫；開關 strong_lane_settings.auto_enqueue_enabled／auto_enqueue_limit。回傳這輪排入幾件。2026-11-20；2026-11-25 改用共用判斷';
REVOKE ALL ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION strong_adjudications_auto_enqueue(INTEGER) TO service_role;

-- 3. sweep（＝20261111170000 的定義，開頭多收殭屍、說明多一條④）
CREATE OR REPLACE FUNCTION strong_lane_sweep() RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE
  v_flag NUMERIC := contribution_overvoted_flag_votes();
  v_stop NUMERIC := contribution_overvoted_stop_votes();
  v_days INTEGER; v_pick INTEGER; v_on BOOLEAN; v_n INTEGER := 0; r RECORD; v_votes TEXT; v_hints TEXT[];
BEGIN
  SELECT s.stale_dispute_days, s.enabled INTO v_days, v_on FROM strong_lane_settings s WHERE s.id = 1;
  IF NOT COALESCE(v_on, false) THEN RETURN 0; END IF;
  -- 收殭屍（20261125020000）：原貢獻已被一般驗證結案（不是 pending／disputed）、又沒有作業在排隊／執行／等定案的 open 強模型任務，
  -- 永遠不會被 strong_adjudications_auto_enqueue 排進去，留著只會讓主控台「強模型待辦」虛胖——關掉並記原因。冪等；回傳值仍只算新開的件數。
  UPDATE contribution_tasks t SET status = 'closed', closed_at = now(),
         closed_reason = 'contribution_resolved:' || COALESCE((SELECT c.status FROM contributions c WHERE c.id::TEXT = t.target->>'contribution_id'), 'missing')
   WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'
     AND NOT strong_lane_contribution_live(t.target->>'contribution_id')
     AND NOT EXISTS (SELECT 1 FROM strong_adjudications a WHERE a.task_id = t.id::TEXT AND a.status IN ('queued', 'running', 'previewed', 'finalizing'));
  SELECT COALESCE(q.identity_pick_timeout_days, 7) INTO v_pick FROM queue_settings q WHERE q.id = 1;
  v_pick := COALESCE(v_pick, 7);
  FOR r IN
    SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.agent_name, c.status, c.review_notes,
           c.agree_count + c.disagree_count + c.unsure_count AS votes,
           CASE WHEN c.agree_count + c.disagree_count + c.unsure_count > v_stop THEN '投太多輪（票數 ' || (c.agree_count + c.disagree_count + c.unsure_count) || ' 超過停派線 ' || round(v_stop, 1) || '）'
                WHEN c.status = 'disputed' AND c.agree_count + c.disagree_count + c.unsure_count > v_flag THEN '爭議中且票數 ' || (c.agree_count + c.disagree_count + c.unsure_count) || ' 超過標出線 ' || round(v_flag, 1)
                WHEN c.needs_identity_pick THEN '同名身分判不出、改回待指認後 ' || v_pick || ' 天沒有人帶指認投票'
                ELSE '爭議超過 ' || v_days || ' 天仍沒有裁決結果' END AS why
      FROM contributions c
     WHERE c.contribution_type <> 'adjudication'
       AND c.status IN ('pending', 'disputed')
       AND ((c.needs_identity_pick AND c.status = 'pending' AND COALESCE(c.needs_identity_pick_at, c.created_at) < now() - make_interval(days => v_pick))
            OR c.agree_count + c.disagree_count + c.unsure_count > v_stop
            OR (c.status = 'disputed' AND c.agree_count + c.disagree_count + c.unsure_count > v_flag)
            OR (c.status = 'disputed'
                AND NOT EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.task_type = 'adjudicate' AND t.status = 'open'
                                   AND t.target->>'contribution_id' = c.id::TEXT AND t.created_at > now() - make_interval(days => v_days))
                AND (EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'contribution_id' = c.id::TEXT)
                     OR c.created_at < now() - make_interval(days => v_days))))
       AND NOT EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.task_type = 'adjudicate' AND t.target->>'requires_tier' = 'strong'
                         AND t.target->>'contribution_id' = c.id::TEXT)
     ORDER BY c.created_at
  LOOP
    SELECT COALESCE(string_agg(COALESCE(v.agent_name, '?') || '（' || COALESCE(v.agent_tool, '?') || '，' || v.verdict || '）：' || COALESCE(NULLIF(left(v.note, 300), ''), '（無說明）')
                               || CASE WHEN v.evidence_url IS NOT NULL THEN '［' || v.evidence_url || '］' ELSE '' END, E'\n' ORDER BY v.created_at), '無')
      INTO v_votes FROM contribution_votes v WHERE v.contribution_id = r.id;
    v_hints := ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(r.source_urls, ARRAY[]::TEXT[])) AS u
                     UNION SELECT v.evidence_url FROM contribution_votes v WHERE v.contribution_id = r.id AND v.evidence_url IS NOT NULL);
    -- 同一筆原有的一般裁決任務由強模型任務取代
    UPDATE contribution_tasks SET status = 'closed', closed_at = now()
     WHERE task_type = 'adjudicate' AND status = 'open' AND target->>'requires_tier' IS DISTINCT FROM 'strong' AND target->>'contribution_id' = r.id::TEXT;
    INSERT INTO contribution_tasks (title, description, task_type, target, priority, reward, status, source, created_by, hint_sources)
    VALUES (
      left('強模型裁決：' || r.contribution_type || ' ' || COALESCE(NULLIF(r.payload->>'name', ''), NULLIF(r.payload->>'title', ''), ''), 120),
      '【強模型專用】' || r.why || '，一般代理投不出共識，改由強模型單獨裁決（一份裁決即定案）。原貢獻 ' || r.id || '（' || r.contribution_type || '，提交者 ' || COALESCE(r.agent_name, '?')
        || '，狀態 ' || r.status || '）payload：' || left(r.payload::TEXT, 1500)
        || E'\n各票（含理由）：\n' || v_votes
        || E'\n請：①逐一打開 hint_sources 與各票 evidence_url，自己查原始來源，不要只信票上的結論；動態網頁（例如 lawmaker.twreporter.org 這類先載空殼再用 JS 載資料的站）不要只看 HTML，改找它背後的 API／JSON；'
        || '②檢查 election_id（是不是對的那一屆）、人物身份（同名不同人、重複建檔）、有沒有重複的既有紀錄、來源是否真的支持每個欄位；'
        || '③交 contribution_type=adjudication {contribution_id, verdict: uphold（原貢獻正確）／reject（原貢獻有誤）／uphold_with_correction（大致正確但要改：另帶 corrected_fields＝{欄位: 改好的值}，null＝刪欄位）, reason（≥20 字）, checked_urls[]}。'
        || '④corrected_fields 套上去後，整份 payload 要仍通過交件驗證才收得下（例如政見 description 至少 20 字、要寫清楚承諾了什麼）：更正後太短或欄位不合就會被拒收（correction_invalid）。只是多了一句推論、刪掉後會不到 20 字時，別硬刪成短句：改寫成有原文依據的完整句子，或直接 uphold／reject 並在 reason 說明。',
      'adjudicate',
      jsonb_build_object('contribution_id', r.id, 'contribution_type', r.contribution_type, 'contributor', r.agent_name, 'reason', r.why, 'requires_tier', 'strong'),
      3, 1, 'open', 'auto_dispute', 'auto-strong', v_hints);
    -- 待指認的件進了強模型待辦就不再留在驗證池（池子只派 pending）：轉 disputed，由強模型裁決（20261111170000）
    UPDATE contributions SET status = 'disputed' WHERE id = r.id AND needs_identity_pick AND status = 'pending';
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$fn$;

-- 4. list
CREATE OR REPLACE FUNCTION strong_lane_list() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH open_tasks AS (
    SELECT t.* FROM contribution_tasks t
     WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'
       -- 原貢獻已結案的不列；但還有作業在排隊／執行／等人定案的照列（主控台才看得到、能 finalize 或退回）
       AND (strong_lane_contribution_live(t.target->>'contribution_id')
            OR EXISTS (SELECT 1 FROM strong_adjudications a WHERE a.task_id = t.id::TEXT AND a.status IN ('queued', 'running', 'previewed', 'finalizing')))
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'total', (SELECT count(*) FROM open_tasks),
    'items', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at', x->>'task_id'), '[]'::JSONB) FROM (
      SELECT jsonb_build_object(
        'task_id', t.id, 'created_at', t.created_at, 'reason', t.target->>'reason',
        'contribution_id', t.target->>'contribution_id', 'contribution_type', c.contribution_type, 'status', c.status,
        'subject', COALESCE(NULLIF(c.payload->>'name', ''), (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(c.payload)),
                            (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(c.payload->>'policy_id')), NULLIF(c.payload->>'title', ''), ''),
        'votes', c.agree_count + c.disagree_count + c.unsure_count,
        'claimed_by', t.target->>'claimed_by', 'claimed_tool', t.target->>'claimed_tool', 'claimed_at', t.target->>'claimed_at',
        'verdicts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('verdict', v.verdict, 'agent', v.agent_name, 'agent_tool', v.agent_tool, 'reason', left(COALESCE(v.note, ''), 300), 'evidence_url', v.evidence_url) ORDER BY v.created_at), '[]'::JSONB)
                       FROM contribution_votes v WHERE v.contribution_id = c.id),
        'stalled_reason', CASE
            WHEN c.id IS NULL THEN 'contribution_missing'
            WHEN j.n = 0 OR j.active THEN NULL
            WHEN j.last_status = 'returned' THEN 'returned_to_human'
            WHEN j.n >= 2 AND j.last_status = 'finalize_failed' THEN 'retry_cap_finalize_failed'
            WHEN j.n >= 2 AND j.last_status = 'failed' THEN 'retry_cap_failed'
            ELSE NULL END,
        'job_count', j.n, 'last_job_status', j.last_status, 'last_job_error', j.last_error
      ) AS x
        FROM open_tasks t LEFT JOIN contributions c ON c.id::TEXT = t.target->>'contribution_id'
        CROSS JOIN LATERAL (
          SELECT count(*)::INTEGER AS n,
                 COALESCE(bool_or(a.status IN ('queued', 'running', 'previewed', 'finalizing')), false) AS active,
                 (array_agg(a.status ORDER BY a.created_at DESC))[1] AS last_status,
                 (array_agg(COALESCE(a.report_response->>'error', left(a.error, 80)) ORDER BY a.created_at DESC))[1] AS last_error
            FROM strong_adjudications a WHERE a.task_id = t.id::TEXT) j
       LIMIT 200) q)
  )
$fn$;
COMMENT ON FUNCTION strong_lane_list IS '強模型待辦清單（公開唯讀）：開著的 requires_tier=strong 裁決任務（原貢獻已結案的不列）、原貢獻、各票理由、認領者（自報，僅供稽核）、作業進度與 stalled_reason（卡住原因，null＝正常）。2026-11-09；2026-11-25 對齊 auto_enqueue 並加 stalled_reason';
REVOKE ALL ON FUNCTION strong_lane_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION strong_lane_list() TO anon, authenticated, service_role;
