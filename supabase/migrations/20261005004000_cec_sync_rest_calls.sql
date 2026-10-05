-- cec-sync 接續呼叫：2022 縣市議員、鄉鎮市民代表、縣市長（2026-10-05）
--
-- cec-sync 這次補抓議員與代表的原住民選區（同一個同步單位多打一兩個科目）、嘉義市長改試重行選舉那筆場次，
-- 2022 縣市議員一次呼叫要打的請求從 46 個（清單 2＋22 縣市×2）變成 134 個（清單 2＋22 縣市×3 科目×2），
-- 每個請求前等 0.6 秒，超過函式的 100 秒時間預算，
-- 會停在一半、回應帶 next——但每週排程（cec-sync-2022-weekly，週六 19:00 UTC）不會接著呼叫，
-- 後半的縣市就一直是舊資料。
--
-- 做法跟村里長一樣（cec-sync-2022-village-rest）：同一天 19:05、19:10 各再呼叫一次。
-- 24 小時內同步過的單位會空轉（只查一次最近同步時間、不打中選會），所以等於從上一次停下的地方接著跑；
-- 已經跑完的那幾種再呼叫一次也只是全部空轉。

SELECT cron.unschedule('cec-sync-2022-rest') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cec-sync-2022-rest');
SELECT cron.schedule('cec-sync-2022-rest', '5,10 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', 2022, 'election_type', t), timeout_milliseconds := 150000)
    FROM unnest(ARRAY['縣市議員', '鄉鎮市民代表', '縣市長']) AS t;
$$);
