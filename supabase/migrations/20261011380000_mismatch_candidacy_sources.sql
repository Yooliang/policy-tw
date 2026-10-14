-- 屆別跟參選紀錄對不上的政見（2026-10-14，接 20261011340000）
--
-- 20261011340000 補了「任內施政掛在還沒投票的選舉」。同一條線再唯讀盤點正式庫，還有兩種屆別跟參選紀錄對不上的：
--   pledge_no_candidacy：競選承諾掛在他沒有參選紀錄的那一屆（23 筆；例：吳旭智 4 筆掛 2026，只有 2022 的參選紀錄；
--     周陳曉玟、武清山等掛 2022，只有 2026 的紀錄）——屆別錯，或缺那一屆的參選紀錄，兩種都要有人看。
--   in_office_not_elected：status 不是 Campaign Pledge、選舉已投票，卻掛在他沒當選的那一屆（11 筆；例：呂維胤 2022 落選，3 筆 In Progress 掛 2022；
--     吳瓊華 2022 當選議員，政見掛 2024）。
-- 34 筆裡有 21 筆原本就因提出日期或 Jev 判斷在這支臂裡，但說明只講日期；這一版改給它們對應參選紀錄的說明（target 多 kind），
-- 另外 13 筆是新派的。其餘既有列一個字不變。
-- 只改臂 mismatch 本體，與 20261011340000 的版本逐字比對只差四處替換（守門 mismatch-candidacy-sources.test.ts）。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
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
        WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.candidacy_status = 'elected'
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
  -- 2026-10-13：任內施政（status 不是 Campaign Pledge）掛在還沒投票的選舉。by_date 抓不到（提出日期早於未來的投票日），
  -- 而它正是 by_date 的任務被答反的結果：蔣萬安的營養午餐免費被 correction 從 2022 改成 2026，人物頁就把它列進「過往政績」、標成 2026 年大選
  by_future AS (
    SELECT pl.id
    FROM policies pl
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.status <> 'Campaign Pledge'
      AND e.election_date > activity_today()
  ),
  -- 2026-10-14：屆別跟參選紀錄對不上的兩種。競選承諾掛在他沒有參選紀錄的那一屆；任內施政（已投票的那屆）掛在他沒當選的那一屆
  by_no_candidacy AS (
    SELECT pl.id
    FROM policies pl
    WHERE pl.removed_at IS NULL
      AND pl.status = 'Campaign Pledge'
      AND pl.election_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id)
  ),
  by_not_elected AS (
    SELECT pl.id
    FROM policies pl
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.status <> 'Campaign Pledge'
      AND e.election_date <= activity_today()
      AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id AND pe.candidacy_status = 'elected')
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev UNION SELECT id FROM by_future UNION SELECT id FROM by_no_candidacy UNION SELECT id FROM by_not_elected)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', policy_primary_url(pl.id),
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END)
           -- 只有新來源的列多 kind，原有的 target 一個字不變（seed 不會因此重寫既有派工列）
           || CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN jsonb_build_object('kind', 'in_office_future')
                   WHEN nc.id IS NOT NULL THEN jsonb_build_object('kind', 'pledge_no_candidacy')
                   WHEN ne.id IS NOT NULL THEN jsonb_build_object('kind', 'in_office_not_elected')
                   ELSE '{}'::jsonb END AS target,
         CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN
           '政見「' || pl.title || '」（' || p.name || '）狀態是 ' || pl.status::TEXT || '（任內施政或已在推動），卻掛在 ' || e.election_date::TEXT
           || ' 才投票、還沒舉行的那場選舉，人物頁會把它當成過往政績、標成那場選舉。請打開來源確認：'
           || '它是任內宣布的施政 → 用 correction 把 policies.election_id 改成他這一任當選的那屆（已經投過票的那場；參選紀錄看 /next 的 current.elections）；'
           || '它其實是這次選舉的競選承諾 → 用 correction 把 policies.status 改成 Campaign Pledge；'
           || '分不出來就用 no_change 回報你查了什麼。提出日期晚於當選那屆的投票日是任內施政的正常情形，不是屆別錯了。'
         WHEN nc.id IS NOT NULL THEN
           '政見「' || pl.title || '」（' || p.name || '）是競選承諾、掛在 ' || pl.election_id || ' 那一屆，但我們沒有他參選那一屆的紀錄（參選紀錄看 /next 的 current.elections）。請打開來源確認：'
           || '他其實是在別屆提的 → 用 correction 把 policies.election_id 改成他參選的那一屆；'
           || '他確實參選了那一屆、只是我們缺參選紀錄 → 交 candidacy 補上那一屆的參選紀錄（附中選會或報導），這筆政見不用改；'
           || '它不是競選承諾而是任內施政 → 用 correction 把 status 改成 Proposed、election_id 改成他當選的那屆；分不出來用 no_change。'
         WHEN ne.id IS NOT NULL THEN
           '政見「' || pl.title || '」（' || p.name || '）狀態是 ' || pl.status::TEXT || '（任內施政或已在推動），掛在 ' || pl.election_id
           || ' 那一屆，但我們的參選紀錄沒有他在那一屆當選。任內施政要掛在他當選的那屆。請打開來源確認：'
           || '他當選的是別屆 → 用 correction 把 policies.election_id 改成那一屆；他確實在那一屆當選、只是紀錄缺或錯 → 交 candidacy 補正那一屆的參選紀錄；'
           || '它其實是那一屆的競選承諾 → 用 correction 把 status 改成 Campaign Pledge；'
           || '他沒有公職、這件事是他當議員候選人時的主張或倡議 → 改成那一次參選的競選承諾（status Campaign Pledge、election_id 填那次）；分不出來用 no_change。'
         ELSE
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。'
           || '任內施政不要改掛到還沒投票的選舉（伺服器會擋）。' END AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
  LEFT JOIN by_no_candidacy nc ON nc.id = pl.id
  LEFT JOIN by_not_elected ne ON ne.id = pl.id
$function$;
