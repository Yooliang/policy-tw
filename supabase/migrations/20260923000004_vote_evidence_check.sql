-- 票的 +2／−2 改由系統核 evidence_url 決定（2026-09-23 小良哥）
--
-- 原本 +2 的路是「代理先拿第二來源打 judge 讓 Jev 判、再投票」——實際變成代理把判斷外包給 Jev：不讀原文、照 Jev 的答案投。
-- 系統票（precheck）已經是 Jev 判一次，代理再問一次等於同一個裁判投兩票；Jev 會系統性看走眼（人轉戰別區那型），照它投的會集體投錯。
-- 改法：代理照舊自己讀、自己附 evidence_url，投下去先是 ±1；系統（cron，每 5 分鐘）自己去核那個網址是否支持這票，核得過才把
-- judge_backed 翻成 true → 既有的 BEFORE 觸發器重算 weight（±2）→ AFTER 觸發器重算共識。judge／extract 從代理文件拿掉，端點留給系統用。

ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS evidence_checked_at TIMESTAMPTZ;
ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS evidence_verdict TEXT;
COMMENT ON COLUMN contribution_votes.judge_backed IS '這張票附的 evidence_url 經系統核過且支持它的判定（2026-09-23 起由 system-one?action=evidence 的 cron 填，不再由代理呼叫 judge 取得）';
COMMENT ON COLUMN contribution_votes.evidence_checked_at IS '系統核 evidence_url 的時間；NULL＝還沒核（有 evidence_url 的票會被 cron 撿）';
COMMENT ON COLUMN contribution_votes.evidence_verdict IS '系統核的結果：supported／not_supported／cannot_tell／fetch_failed／no_subject／same_source／not_eligible（<門檻 後綴＝機率不到）';
CREATE INDEX IF NOT EXISTS idx_contribution_votes_evidence_pending ON contribution_votes (created_at) WHERE evidence_url IS NOT NULL AND evidence_checked_at IS NULL;

-- 已經 judge_backed 的票視為核過（那是代理當時親自打 judge 的結果，不重核）
UPDATE contribution_votes SET evidence_checked_at = created_at, evidence_verdict = 'supported'
 WHERE judge_backed = true AND evidence_checked_at IS NULL;

-- jev_decisions 的 subject_type 加 'vote'（核證據的判決掛在票上）；不重寫整個清單，在既有定義上加
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'jev_decisions_subject_type_check';
  IF def IS NOT NULL AND def NOT LIKE '%''vote''%' THEN
    EXECUTE 'ALTER TABLE jev_decisions DROP CONSTRAINT jev_decisions_subject_type_check';
    EXECUTE 'ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check ' || replace(def, '''contribution''', '''contribution'', ''vote''');
  END IF;
END $$;

-- 排程：每 5 分鐘核最多 30 張票（每張抓一頁＋問一次 Jev；40 秒預算，做不完下一輪接）
SELECT cron.unschedule('system-one-evidence-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-evidence-5min');
SELECT cron.schedule(
  'system-one-evidence-5min',
  '1,6,11,16,21,26,31,36,41,46,51,56 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=evidence&limit=30',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
