-- 2026 開票結果的自動進入路徑：cec-sync 依「投票日」自動換成高頻、再降頻（2026-10-07，維護者同意開工；#332 選前必補第 1 項）
-- ============================================================
--
-- 缺口：cron.job 的 cec-sync 只排 2022（週六 19:00 起）、2024（週六 19:30）、補選與重行選舉（週六 19:45），沒有 2026。
-- 當選／落選（candidacy_status）、任期列建立（sync_politician_office_from_election）、progress_stale 的排除全都先決於結果，
-- 而結果進來的路徑是：cec-sync 把中選會名單與當選記號抓進 cec_candidates → 11-29 起 election_results_missing 派工（依單位整批）
-- → 代理核對交 election_results → 系統票（cec_candidates 比對）＋一張代理同意 → candidacy_status。第一環沒有排程，後面全空轉。
--
-- 勘查（2026-10-07 唯讀）：中選會靜態 JSON 的場次清單（static/elections/list/ELC_<科目>.json）最新一筆還是 111 年（2022），
-- 115 年的場次尚未公布；場次 id（theme_id）是雜湊、事先猜不到，但 cec-sync 本來就不用猜——它讀清單、用「投票日」對場次
-- （_shared/cec-sync.ts 的 pickThemes：vote_date ＝ elections.election_date），elections 表已經有 2026 那一列
-- （2026-11-28_local，七種職位）。用 2022 的投票日假裝是 2026 那一列、實打中選會彩排：台北市長、台北市議員（連原住民選區）、
-- 彰化鄉鎮市長都抓得到、election_id 寫的是 2026 列的 id；用真正的 2026-11-28 去對則回「找不到投票日 2026-11-28 的 theme」，
-- 整個單位跳過、不刪不寫（既有的保護）。所以設定不必另做：場次一出現在清單上就自動接上，缺的只有排程。
--
-- 做了什麼（只加不刪，三條排程＋一支判斷函式＋一個檢查視圖）：
--   1. cec_sync_phase(投票日, 事由, 現在)：這場選舉現在該用哪一層頻率。投票前回 NULL（排程不打中選會）；
--      投票結束（投票日 16:00 台灣時間＝08:00 UTC）起 3 天內 'live'；之後到第 14 天 'settle'；再之後 'weekly'；罷免投票不選人，永遠 NULL。
--      三層的邊界只在這一支函式裡，排程與檢查視圖都叫它。
--   2. cec-sync-live-10min（每 10 分鐘）：'live' 的選舉逐職位各打一次，帶 min_interval_hours=1（同一單位 1 小時內同步過就空轉，
--      所以一輪抓完之後每 10 分鐘只是 DB 查詢，每個單位每小時重抓一次結果；24 小時的預設會讓開票途中抓到的半成品卡一整天）。
--      村里長一屆 1.3 萬人一次呼叫跑不完（100 秒時間預算），每 10 分鐘接著上一輪停下的地方繼續，約 5 次呼叫（50 分鐘）抓完一輪。
--   3. cec-sync-settle-6h（每 6 小時）：'settle'，min_interval_hours=5。
--   4. cec-sync-weekly（週六 19:00～19:20，每 5 分鐘接續）：'weekly'、定期選舉、投票日在 2026 年以後——2022、2024 沿用既有的週排程不動，
--      補選與重行選舉沿用 cec-sync-offcycle-weekly；之後新增的選舉（2028…）不用再加排程。
--   5. 檢查視圖 cec_sync_status：每場選舉×職位一列，現在在哪一層、中選會名單抓到幾人、幾人當選、最後同步時間、我們的參選紀錄還有幾筆結果空白。
--
-- 投票前不會白打：三條排程每次都先過 cec_sync_phase，2026-11-28 08:00 UTC 之前沒有任何一列通過，net.http_post 一次都不會送出。
-- cec-sync 本身也擋：votedElections 以 UTC 日期比，投票日之前叫它會回「還沒投票」。
--
-- 這支 migration 部署時比函式早一點點上線沒有風險：排程要到 11-28 才會送出請求，帶的 min_interval_hours 舊版函式會直接忽略。
--
-- 引用到的既有物件（2026-10-07 唯讀查詢確認）：elections(id, election_key, election_date, election_reason, election_types)、
-- cec_candidates(election_id, election_type, elected, synced_at)、politician_elections(election_id, election_type, candidacy_status)、
-- cron.schedule／cron.unschedule／net.http_post（既有排程同寫法）。

CREATE OR REPLACE FUNCTION cec_sync_phase(p_election_date DATE, p_reason TEXT, p_now TIMESTAMPTZ DEFAULT now())
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_election_date IS NULL OR p_reason = 'recall' THEN NULL
           WHEN p_now < x.polls_close THEN NULL
           WHEN p_now < x.polls_close + INTERVAL '3 days' THEN 'live'
           WHEN p_now < x.polls_close + INTERVAL '14 days' THEN 'settle'
           ELSE 'weekly'
         END
    FROM (SELECT ((p_election_date + TIME '08:00') AT TIME ZONE 'UTC') AS polls_close) x
$$;
COMMENT ON FUNCTION cec_sync_phase IS
  'cec-sync 排程現在該用哪一層頻率（2026-10-07）：投票前 NULL（不打中選會）；投票日 16:00 台灣時間（08:00 UTC）起 3 天內 live、到第 14 天 settle、之後 weekly；罷免投票不選人，永遠 NULL';

SELECT cron.unschedule(j) FROM unnest(ARRAY['cec-sync-live-10min', 'cec-sync-settle-6h', 'cec-sync-weekly']) j
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = j);

SELECT cron.schedule('cec-sync-live-10min', '*/10 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', e.id, 'election_type', t, 'min_interval_hours', 1),
                       timeout_milliseconds := 150000)
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t
   WHERE cec_sync_phase(e.election_date, e.election_reason) = 'live';
$$);

SELECT cron.schedule('cec-sync-settle-6h', '20 */6 * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', e.id, 'election_type', t, 'min_interval_hours', 5),
                       timeout_milliseconds := 150000)
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t
   WHERE cec_sync_phase(e.election_date, e.election_reason) = 'settle';
$$);

SELECT cron.schedule('cec-sync-weekly', '0,5,10,15,20 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', e.id, 'election_type', t),
                       timeout_milliseconds := 150000)
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t
   WHERE cec_sync_phase(e.election_date, e.election_reason) = 'weekly'
     AND e.election_reason = 'regular' AND e.election_date >= DATE '2026-01-01';
$$);

-- ── 檢查視圖：開票那晚只要看這一張 ───────────────────────────────
CREATE OR REPLACE VIEW cec_sync_status AS
SELECT e.id AS election_id, e.election_key, e.election_date, t.election_type,
       cec_sync_phase(e.election_date, e.election_reason) AS phase,
       COALESCE(c.candidates, 0) AS cec_candidates,
       COALESCE(c.elected, 0) AS cec_elected,
       c.last_synced,
       COALESCE(p.total, 0) AS our_candidacies,
       COALESCE(p.result_blank, 0) AS our_result_blank
  FROM elections e
 CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
  LEFT JOIN (
    SELECT election_id, election_type, count(*) AS candidates, count(*) FILTER (WHERE elected) AS elected, max(synced_at) AS last_synced
      FROM cec_candidates GROUP BY election_id, election_type
  ) c ON c.election_id = e.id AND c.election_type = t.election_type
  LEFT JOIN (
    SELECT election_id, election_type, count(*) AS total,
           count(*) FILTER (WHERE COALESCE(candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')) AS result_blank
      FROM politician_elections GROUP BY election_id, election_type
  ) p ON p.election_id = e.id AND p.election_type = t.election_type;
ALTER VIEW cec_sync_status SET (security_invoker = on);
GRANT SELECT ON cec_sync_status TO anon, authenticated;
COMMENT ON VIEW cec_sync_status IS
  '每場選舉×職位一列：cec-sync 現在在哪一層頻率（phase）、中選會名單抓到幾人與幾人當選、最後同步時間、我們的參選紀錄還有幾筆結果空白（2026-10-07）。正常的開票夜：phase=live 之後 cec_candidates 長出來、cec_elected>0；cec_candidates 一直是 0＝中選會場次還沒公布（看 cec-sync 回應的 failed）';

NOTIFY pgrst, 'reload schema';
