-- policy_election_mismatch 不再把現任者任內作為判成屆別不符（#5，2026-09-22）
--
-- 原判準：提出日期晚於該屆投票日 → 屆別不符任務。但 2022 當選的首長 2024 提出的施政，掛在 2022 那一屆是對的
--（任期內的作為屬於那場選舉的承諾脈絡）。leatherback 2026-09-21 回報這是系統性誤判：代理領到只能回 no_change，
-- 白跑一趟、佔一票。加一條：該人在那場選舉當選的，任內提出的不算。落選者或沒有當選紀錄的照舊派。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:policy_election_mismatch:' || pl.id, 'policy_election_mismatch',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', pl.source_url),
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；分不出來就用 no_change 回報你查了什麼。',
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'], 1, p.region
  FROM policies pl
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  WHERE pl.removed_at IS NULL
    AND pl.proposed_date IS NOT NULL
    AND pl.proposed_date > e.election_date
    -- 2026-09-22 #5：當選者任內提出的施政掛在當選那一屆是對的，不是屆別標錯（任期內的作為屬於那場選舉的承諾脈絡）。
    -- 沒有這條，每個現任首長任內的每一筆政見都會被派成「屆別不符」，代理只能回 no_change，白跑一趟、佔一票。
    AND NOT EXISTS (
      SELECT 1 FROM politician_elections pe
      WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.election_result = 'elected'
    )
$fn$;
