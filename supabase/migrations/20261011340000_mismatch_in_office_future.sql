-- 任內施政掛在還沒投票的選舉（2026-10-13）
--
-- 起因：蔣萬安「公私立國中小營養午餐全面免費」（policies 386940db…）原本掛 2022（任內施政，status In Progress），
-- 臂 mismatch 派出「提出日期晚於投票日」的任務後，一筆 correction 把 election_id 改成 2026 並通過驗證；人物頁「過往政績與追蹤」
-- 依 status（不是 Campaign Pledge）收它，再依屆別分組，於是一條 2026 年大選出現在過往政績裡。正式庫同樣情形 35 筆（2026-10-13 唯讀實測）。
--
-- 這支只改臂 mismatch 本體（不碰總表、activity_arm_names、規則，task_type 與 task_id 前綴不變，既有的 38 件一件不少）：
--   多一個來源 by_future：status 不是 Campaign Pledge、掛的選舉投票日在 activity_today() 之後；新來源的列 target 多 kind＝in_office_future，
--   what_we_need 請代理改回當選那屆、或把 status 改成 Campaign Pledge。原有兩個來源的文字只在尾端多一句「任內施政不要改掛到還沒投票的選舉」。
-- 正式庫唯讀實測（2026-10-13，新本體＝現行 38 件＋by_future 33 件＝71 件；by_future 共 34 件，其中 1 件原本就在，target 只多 kind；原有的沒有少）。
-- 交件端（contribution-schema.ts 的 policy、contribute-handler.ts 的 correction）同一個 PR 擋住新的這種寫法（policy-term-guard.ts）。

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
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev UNION SELECT id FROM by_future)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', policy_primary_url(pl.id),
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END)
           -- 只有新來源的列多 kind，原有的 target 一個字不變（seed 不會因此重寫既有派工列）
           || CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN jsonb_build_object('kind', 'in_office_future') ELSE '{}'::jsonb END AS target,
         CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN
           '政見「' || pl.title || '」（' || p.name || '）狀態是 ' || pl.status::TEXT || '（任內施政或已在推動），卻掛在 ' || e.election_date::TEXT
           || ' 才投票、還沒舉行的那場選舉，人物頁會把它當成過往政績、標成那場選舉。請打開來源確認：'
           || '它是任內宣布的施政 → 用 correction 把 policies.election_id 改成他這一任當選的那屆（已經投過票的那場；參選紀錄看 /next 的 current.elections）；'
           || '它其實是這次選舉的競選承諾 → 用 correction 把 policies.status 改成 Campaign Pledge；'
           || '分不出來就用 no_change 回報你查了什麼。提出日期晚於當選那屆的投票日是任內施政的正常情形，不是屆別錯了。'
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
$function$;
