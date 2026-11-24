-- jev 後續任務：建立時去重（同人物＋同政見＋同種類，開著的只能有一筆）
--
-- 為什麼：Jev 從驗證備註／提交說明開「AI 提議」後續任務時，一批 6 張票並行處理，每張先查「有沒有開著的同對象任務」再新增，
--   兩步不是原子操作，同一人的多張票同時通過檢查，結果開出重複任務（開著的 2,274 筆裡 154 組、274 筆重複，97% 是同一分鐘內開出）。
--   contribution_tasks 原本沒有任何 unique 約束，查重只能靠程式。
-- 怎麼改：加一個 partial unique index，鍵＝（人物 id、政見 id、事項種類），條件＝開著、建立者是 jev-followup、有事項種類。
--   人物、政見沒有時用空字串代替 NULL，這樣「只掛人物」「只掛政見」的任務也受約束（NULL 在 unique 裡彼此不衝突，會漏掉）。
--   程式端撞到 23505 會當成「已存在」回傳既有那筆（見 _shared/task-admin.ts 的 createTask）。
-- 只對新建列生效：現存約 274 筆重複還開著，直接建 unique 會失敗，而關閉它們是動資料、另案處理。
--   所以索引條件加 created_at >= 「本 migration 套用當下」。這個時間點在套用時才取（先鎖表再取，避免鎖前剛寫入的列被算進去），
--   所以寫成 EXECUTE format，而不是寫死一個日期（寫死的話，merge 前後新開的重複列會讓建索引失敗）。
--   現存重複另案關閉完之後，再用新 migration 把 created_at 條件拿掉（DROP 再 CREATE 一個沒有時間條件的）。
-- 回滾：DROP INDEX IF EXISTS uq_contribution_tasks_jev_followup_open;

DO $$
DECLARE cutoff timestamptz;
BEGIN
  LOCK TABLE contribution_tasks IN SHARE ROW EXCLUSIVE MODE;
  cutoff := clock_timestamp();
  EXECUTE format(
    $f$CREATE UNIQUE INDEX IF NOT EXISTS uq_contribution_tasks_jev_followup_open
         ON contribution_tasks (
           (COALESCE(target->>'politician_id', '')),
           (COALESCE(target->>'policy_id', '')),
           (target->>'followup_kind')
         )
         WHERE status = 'open' AND created_by = 'jev-followup' AND target->>'followup_kind' IS NOT NULL
           AND created_at >= %L::timestamptz$f$, cutoff);
END $$;
