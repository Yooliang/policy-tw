-- policy_election_mismatch 也收「Jev 判的屆別跟現值不同」（小良哥 2026-09-23）
--
-- 原本只有一條日期規則：提出日期晚於所屬選舉投票日。沒填提出日期的就抓不到——
-- 江啟臣「2030 巨蛋」來源是 2026 台中市長參選，標成 2024，proposed_date 空白，一直沒被派。
-- Jev 對每條政見已經在判「屬於哪一屆」（backfill，question='election'），結果只拿來排序。
-- 09-23 實查：6 條驗證者已指出正確屆別的，Jev 6 條全對；已填屆別、Jev 以 ≥0.8 判成別屆的有 11 條，
-- 多數是 2024 當選立委、2026 參選縣市長的人，競選政見被掛在 2024。
--
-- Jev 只負責點出來：任務照舊要代理打開來源判斷、交 correction、同儕投票。任務文字附上 Jev 的判斷當線索。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH jev AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.probability
    FROM jev_decisions j
    WHERE j.subject_type = 'policy' AND j.question = 'election'
    ORDER BY j.subject_id, j.asked_at DESC
  ),
  by_date AS (
    SELECT pl.id
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.proposed_date IS NOT NULL
      AND pl.proposed_date > e.election_date
      -- 2026-09-22 #5：當選者任內提出的施政掛在當選那一屆是對的
      AND NOT EXISTS (
        SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.election_result = 'elected'
      )
  ),
  by_jev AS (
    SELECT pl.id
    FROM policies pl
    JOIN jev ON jev.subject_id = pl.id::TEXT
    WHERE pl.removed_at IS NULL
      AND pl.election_id IS NOT NULL
      AND jev.choice ~ '^\d{4}$'
      AND jev.choice <> pl.election_id::TEXT
      AND jev.probability >= 0.8
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', pl.source_url,
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END) AS target,
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。' AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_mismatch IS '屆別可能標錯的政見 → policy_election_mismatch 任務：提出日期晚於所屬選舉投票日（當選者任內除外），或 Jev 以 ≥0.8 判成別屆';
