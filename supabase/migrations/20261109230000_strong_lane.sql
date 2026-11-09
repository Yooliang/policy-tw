-- 強模型待辦：難題只給持鑰匙者認領、單一裁決即定案（維護者 2026-11-09）
-- ============================================================
--
-- 現象：投太多輪停派的交件（console_queue_state().overvoted 裡 stopped 的）停派後沒有出口——正式庫 45 件只有 2 件有裁決任務、
-- 任務優先 0 從沒被派出、7 天 0 筆裁決（overvoted-tick-10min 10-17 起暫停）。一般代理（Sonnet／MiniMax）對這種題投不出共識
-- （動態網頁讀不到資料、沒人核對 election_id）；Opus 試做 3 件都裁得對。
--
-- 做法：
--   1. 標記：contribution_tasks.target.requires_tier = 'strong'（adjudicate 任務）。這支把它排除在 contribution_queue_tasks 之外
--      （/next、rebalance、預覽都看不到），所以一般派工絕對不會派。認領走 GET /next?lane=strong，要標頭 x-strong-lane-key
--      ＝Edge Function secret STRONG_LANE_KEY；模型名（agent_tool）是自報的、驗不了，只記錄、不授權。
--   2. 自動開：strong_lane_sweep()（pg_cron 每 10 分鐘，部署時先跑一次＝回填）——每一件「停派（票數 > 停派線）、或 disputed 且票數 > 標出線
--      （＝主控台 stopped 的定義）、或 disputed 超過 strong_lane_settings.stale_dispute_days（3）天裁決任務還沒結果」的交件，
--      開一件強模型裁決任務（冪等：同一件交件只會有一件強模型任務，曾經有過就不再開）；該交件原有的一般裁決任務關掉（由它取代）。
--      任務說明帶原貢獻、所有票與理由、查證指示。交件狀態不改（停派的仍 pending）。
--   3. strong_lane_list()：公開唯讀（主控台隊列頁「強模型待辦」分頁與 /next?lane=strong&list=1 用），列開著的任務、原貢獻、各票理由、認領資訊。
-- 簽名與回傳型別都不動（contribution_queue_tasks CREATE OR REPLACE 只多一個條件）。日本站不跟。

CREATE TABLE IF NOT EXISTS strong_lane_settings (
  id                  SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  stale_dispute_days  INTEGER NOT NULL DEFAULT 3 CHECK (stale_dispute_days >= 0),
  note                TEXT
);
INSERT INTO strong_lane_settings (id, note) VALUES (1, '強模型待辦：停派或 disputed 超過 stale_dispute_days 天沒裁決的交件自動開強模型裁決任務。改值＝一行 migration 的 UPDATE。2026-11-09')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE strong_lane_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON strong_lane_settings;
CREATE POLICY "Public read" ON strong_lane_settings FOR SELECT USING (true);
COMMENT ON TABLE strong_lane_settings IS '強模型待辦參數（單列 id=1）。授權不在這裡：認領與交裁決只認 Edge Function secret STRONG_LANE_KEY，不看模型名。2026-11-09';

CREATE INDEX IF NOT EXISTS contribution_tasks_strong_idx
  ON contribution_tasks ((target->>'contribution_id')) WHERE task_type = 'adjudicate' AND target->>'requires_tier' = 'strong';

-- ------------------------------------------------------------
-- 1. 一般派工排除強模型任務（contribution_queue_tasks 以 20261017010000 的現行定義為底，只多一個條件）
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
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target))
    ))
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
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check')
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id = d.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check')
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
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；LIMIT 5 讓計數最多數到 5 筆
    AND (SELECT count(*) FROM (
      SELECT 1 FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed') LIMIT 5
    ) inflight) < 5
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
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_queue_tasks IS
  '/next、queue_preview、contribution_queue_task_counts、queue_head_stale 拿隊頭：task_dispatches 裡所有「任務」列（自動缺口 auto: 與 open 的手動任務 uuid，不含 verify:），照 queue_at 取，跳過 blocked、冷卻中（插隊的除外）、對這台機器不合格的。'
  '所有合格條件都在 LIMIT 之前（20261017000301）：認領中、同機器交過、查無回報在等票、在途額滿（5）、提問滿額／答過、裁決不合格；/next 的過濾器只剩 skip 與舊雜湊投票兩項留在程式裡。'
  '20261017010000：底下有交件在途的任務停放（合格：任務停放；question、adjudicate、roster_check 除外）。'
  'contribution_auto_tasks（/tasks、/request-task 用）仍只回 auto: 列，輸出不變。同 queue_at 內公民提問依 target.stance_up 高的先。2026-10-08、2026-10-17'
  '20261109230000：requires_tier=strong 的強模型任務排除（只能用 /next?lane=strong 認領）。';

-- ------------------------------------------------------------
-- 2. 自動開強模型裁決任務（冪等；部署時跑一次＝回填，之後每 10 分鐘）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION strong_lane_sweep() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_flag NUMERIC := contribution_overvoted_flag_votes();
  v_stop NUMERIC := contribution_overvoted_stop_votes();
  v_days INTEGER; v_on BOOLEAN; v_n INTEGER := 0; r RECORD; v_votes TEXT; v_hints TEXT[];
BEGIN
  SELECT s.stale_dispute_days, s.enabled INTO v_days, v_on FROM strong_lane_settings s WHERE s.id = 1;
  IF NOT COALESCE(v_on, false) THEN RETURN 0; END IF;
  FOR r IN
    SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.agent_name, c.status, c.review_notes,
           c.agree_count + c.disagree_count + c.unsure_count AS votes,
           CASE WHEN c.agree_count + c.disagree_count + c.unsure_count > v_stop THEN '投太多輪（票數 ' || (c.agree_count + c.disagree_count + c.unsure_count) || ' 超過停派線 ' || round(v_stop, 1) || '）'
                WHEN c.status = 'disputed' AND c.agree_count + c.disagree_count + c.unsure_count > v_flag THEN '爭議中且票數 ' || (c.agree_count + c.disagree_count + c.unsure_count) || ' 超過標出線 ' || round(v_flag, 1)
                ELSE '爭議超過 ' || v_days || ' 天仍沒有裁決結果' END AS why
      FROM contributions c
     WHERE c.contribution_type <> 'adjudication'
       AND c.status IN ('pending', 'disputed')
       AND (c.agree_count + c.disagree_count + c.unsure_count > v_stop
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
        || '③交 contribution_type=adjudication {contribution_id, verdict: uphold（原貢獻正確）／reject（原貢獻有誤）／uphold_with_correction（大致正確但要改：另帶 corrected_fields＝{欄位: 改好的值}，null＝刪欄位）, reason（≥20 字）, checked_urls[]}。',
      'adjudicate',
      jsonb_build_object('contribution_id', r.id, 'contribution_type', r.contribution_type, 'contributor', r.agent_name, 'reason', r.why, 'requires_tier', 'strong'),
      3, 1, 'open', 'auto_dispute', 'auto-strong', v_hints);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION strong_lane_sweep IS '強模型待辦自動開任務（2026-11-09）：停派（票數>停派線）、disputed 且票數>標出線（主控台 stopped）、或 disputed 超過 stale_dispute_days 天裁決沒結果的交件，各開一件 requires_tier=strong 的 adjudicate 任務；冪等（同一交件曾有過強模型任務就不再開），原有的一般裁決任務關掉由它取代。回傳新開幾件。pg_cron strong-lane-sweep-10min';
REVOKE ALL ON FUNCTION strong_lane_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION strong_lane_sweep() TO service_role;

-- ------------------------------------------------------------
-- 3. 公開清單：開著的強模型任務（隊列頁分頁與 /next?lane=strong&list=1）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION strong_lane_list() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'total', (SELECT count(*) FROM contribution_tasks t WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'),
    'items', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at', x->>'task_id'), '[]'::JSONB) FROM (
      SELECT jsonb_build_object(
        'task_id', t.id, 'created_at', t.created_at, 'reason', t.target->>'reason',
        'contribution_id', t.target->>'contribution_id', 'contribution_type', c.contribution_type, 'status', c.status,
        'subject', COALESCE(NULLIF(c.payload->>'name', ''), (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(c.payload)),
                            (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(c.payload->>'policy_id')), NULLIF(c.payload->>'title', ''), ''),
        'votes', c.agree_count + c.disagree_count + c.unsure_count,
        'claimed_by', t.target->>'claimed_by', 'claimed_tool', t.target->>'claimed_tool', 'claimed_at', t.target->>'claimed_at',
        'verdicts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('verdict', v.verdict, 'agent', v.agent_name, 'agent_tool', v.agent_tool, 'reason', left(COALESCE(v.note, ''), 300), 'evidence_url', v.evidence_url) ORDER BY v.created_at), '[]'::JSONB)
                       FROM contribution_votes v WHERE v.contribution_id = c.id)
      ) AS x
        FROM contribution_tasks t LEFT JOIN contributions c ON c.id::TEXT = t.target->>'contribution_id'
       WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'requires_tier' = 'strong'
       LIMIT 200) q)
  )
$$;
COMMENT ON FUNCTION strong_lane_list IS '強模型待辦清單（公開唯讀）：開著的 requires_tier=strong 裁決任務、原貢獻、各票理由、認領者（自報，僅供稽核）。2026-11-09';
REVOKE ALL ON FUNCTION strong_lane_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION strong_lane_list() TO anon, authenticated, service_role;

SELECT cron.unschedule('strong-lane-sweep-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'strong-lane-sweep-10min');
SELECT cron.schedule('strong-lane-sweep-10min', '8,18,28,38,48,58 * * * *', $$SELECT strong_lane_sweep();$$);

-- 回填：既有的停派／爭議交件一次開齊（冪等）
SELECT strong_lane_sweep();
