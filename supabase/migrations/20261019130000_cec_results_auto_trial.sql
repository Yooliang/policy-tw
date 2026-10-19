-- 開票結果自動寫入：小批試寫（維護者 10-19「小批試寫 go」，#678）
-- 乾跑核對過（10-19）：結果 13,203、政黨 547、不一致 4。先每輪 100 筆，主線核對 cec_results_auto_log／edit_history／任期後再調回 2000。
UPDATE cec_results_auto_settings
   SET enabled = true, batch_limit = 100,
       note = '2026-10-19 維護者「小批試寫 go」：每輪 100 筆試寫；核對無誤後另一支 migration 調回 2000'
 WHERE id = 1;
