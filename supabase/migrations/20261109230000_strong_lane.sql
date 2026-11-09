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
-- 簽名與回傳型別都不動（contribution_queue_tasks 現行定義機械式替換，只多一個條件）。日本站不跟。

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
-- 1. 一般派工排除強模型任務：contribution_queue_tasks 的「現行（線上）定義」機械式替換，只多一個條件
--    （同 20261107030000 的做法：線上定義已被那支 migration 改過〔多人任務豁免〕，不能拿檔案裡的舊文字重建）
-- ------------------------------------------------------------
DO $do$
DECLARE
  v_old CONSTANT TEXT := $s$AND NOT d.blocked$s$;
  v_new CONSTANT TEXT := $s$AND NOT d.blocked
    -- 強模型待辦（20261109230000）：requires_tier='strong' 的難題不進一般派工，只由持鑰匙者 GET /next?lane=strong 認領
    AND d.target->>'requires_tier' IS DISTINCT FROM 'strong'$s$;
  v_def TEXT; v_n INTEGER;
BEGIN
  v_def := pg_get_functiondef('contribution_queue_tasks(text,text,integer,text,text,text)'::REGPROCEDURE);
  IF strpos(v_def, 'requires_tier') > 0 THEN RETURN; END IF;  -- 已替換過（重跑）
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'contribution_queue_tasks 的 "AND NOT d.blocked" 出現 % 次，預期 1 次——現行定義變了，這個替換要重寫', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$do$;

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
