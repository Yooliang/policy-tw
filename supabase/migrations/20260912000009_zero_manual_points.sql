-- 零常態人工點 ＋ 來源等級門檻（2026-09-12）
--   1. contributions.contribution_type 加 adjudication（裁決）；contribution_tasks.source 加 auto_dispute（系統因爭議自動建的任務）
--   2. 門檻改成「型別風險 × 來源等級」：contribution_required_agree(p_type, p_payload, p_source_urls)
--      來源等級 official／media／social／other 用網域字尾比對，清單鏡射 _shared/source-priority.ts（consensus.test.ts 會比對這個檔）
--   3. 卡在 needs_review／approved／apply_failed 的列清票退回 pending；既有 disputed 的補建 adjudicate 任務
--      （2026-09-12 dry-run：prod by_status = {pending:32, rejected:2}，三種各 0 筆、disputed 0 筆，資料段目前 no-op）

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication'));

ALTER TABLE contribution_tasks DROP CONSTRAINT IF EXISTS contribution_tasks_source_check;
ALTER TABLE contribution_tasks ADD CONSTRAINT contribution_tasks_source_check
  CHECK (source IN ('manual', 'suggested', 'web_request', 'auto_dispute'));
COMMENT ON COLUMN contribution_tasks.source IS 'manual＝維護者建；suggested＝task_suggestion 通過；web_request＝網站按鈕；auto_dispute＝貢獻轉 disputed 時系統自動建的裁決任務';
CREATE INDEX IF NOT EXISTS contribution_tasks_adjudicate_idx ON contribution_tasks ((target->>'contribution_id')) WHERE task_type = 'adjudicate';

-- ------------------------------------------------------------
-- 來源等級（鏡射 _shared/source-priority.ts SOURCE_PRIORITY；host = 去掉 www. 的主機名，等於或以 .domain 結尾即命中）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_host_of(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(lower(regexp_replace(regexp_replace(coalesce(p_url, ''), '^https?://', ''), '[/:?#].*$', '')), '^www\.', '');
$$;

CREATE OR REPLACE FUNCTION contribution_host_in(p_host TEXT, p_domains TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(p_domains) AS d WHERE p_host = d OR p_host LIKE '%.' || d);
$$;

CREATE OR REPLACE FUNCTION contribution_source_kind(p_urls TEXT[]) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  WITH ranked AS (
    SELECT CASE
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['cec.gov.tw', 'ly.gov.tw', 'gov.tw', 'gov.taipei', 'judicial.gov.tw']) THEN 3
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['cna.com.tw', 'pts.org.tw', 'twreporter.org', 'rti.org.tw', 'udn.com', 'ltn.com.tw', 'chinatimes.com', 'storm.mg', 'cw.com.tw', 'upmedia.mg', 'newtalk.tw', 'ftvnews.com.tw', 'tvbs.com.tw', 'ettoday.net', 'setn.com']) THEN 2
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['facebook.com', 'instagram.com', 'threads.net', 'youtube.com', 'x.com']) THEN 1
      ELSE 0
    END AS rank
    FROM unnest(coalesce(p_urls, ARRAY[]::TEXT[])) AS u
  )
  SELECT CASE coalesce(max(rank), 0) WHEN 3 THEN 'official' WHEN 2 THEN 'media' WHEN 1 THEN 'social' ELSE 'other' END FROM ranked;
$$;

-- ------------------------------------------------------------
-- 門檻矩陣（鏡射 _shared/consensus.ts AGREE_THRESHOLDS）
--   normal＝politician／policy／policy_progress／correction 一般欄位；high＝candidacy／correction 改 candidate_status；
--   light＝task_suggestion／no_change；adjudication＝裁決（不看來源，一律 4）
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS contribution_required_agree(TEXT, JSONB);
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND p_payload->>'field' = 'candidate_status') THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    ELSE 4
  END;
END;
$$;

-- 共識：改用三參數門檻（既有 pending 的貢獻下一票進來就用新門檻重算）
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

  SELECT status, contribution_required_agree(contribution_type, payload, source_urls) INTO v_status, v_need
  FROM contributions WHERE id = p_contribution_id;
  v_new := v_status;
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

-- ------------------------------------------------------------
-- 資料：卡住的列退回 pending 重驗；既有爭議補建裁決任務
-- ------------------------------------------------------------
DELETE FROM contribution_votes
 WHERE contribution_id IN (SELECT id FROM contributions WHERE status IN ('needs_review', 'approved', 'apply_failed'));
UPDATE contributions
   SET status = 'pending', retry_count = 0, last_error = NULL, next_retry_at = NULL,
       review_notes = concat_ws('；', review_notes, '[migration 000009] 退回 pending 由驗證者重新處理'),
       reviewed_by = NULL, reviewed_at = NULL
 WHERE status IN ('needs_review', 'approved', 'apply_failed');

INSERT INTO contribution_tasks (title, description, task_type, target, priority, reward, status, source, created_by, hint_sources)
SELECT '裁決一筆有爭議的貢獻',
       concat('兩票反對。原貢獻（', c.contribution_type, '，提交者 ', coalesce(c.agent_name, '?'), '）payload：', left(c.payload::text, 300),
              '。請打開 hint_sources 裡正反雙方的來源獨立判斷，用 contribution_type=adjudication 回報 {contribution_id, verdict: uphold|reject, reason, checked_urls}。4 票同向即定案。'),
       'adjudicate',
       jsonb_build_object('contribution_id', c.id, 'contribution_type', c.contribution_type, 'contributor', c.agent_name, 'reason', '兩票反對'),
       2, 1, 'open', 'auto_dispute', 'migration-000009',
       ARRAY(SELECT DISTINCT u FROM unnest(c.source_urls) AS u
             UNION SELECT v.evidence_url FROM contribution_votes v WHERE v.contribution_id = c.id AND v.verdict = 'disagree' AND v.evidence_url IS NOT NULL)
  FROM contributions c
 WHERE c.status = 'disputed' AND c.contribution_type <> 'adjudication'
   AND NOT EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.target->>'contribution_id' = c.id::text);

COMMENT ON COLUMN contributions.status IS 'pending→verified（同儕，門檻依型別×來源等級）→applied（自動落庫）；apply_failed＝落庫出錯，10 分鐘後自動重試最多 3 次；disputed＝裁決中（兩票反對／身份指認衝突／連續落庫失敗，系統自動建 adjudicate 任務，4 票同向定案）；rejected＝裁決或維護者退件；reverted＝維護者整筆還原。沒有常態人工狀態。';
