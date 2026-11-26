-- seed 排程變慢：把派工總表兩支最貴的臂縮短（純效能，結果與協議都不變、不升協議版號）
--
-- 背景：pg_cron seed-auto-task-queue-10min 每 10 分鐘呼叫 seed_auto_task_queue()，核心是 contribution_auto_tasks_arms()（派工總表）。
-- 單輪從 11-20 的 27.6 秒漲到 11-24 的 48.1 秒，忙時 57～230 秒。正式庫唯讀 EXPLAIN ANALYZE 逐臂量過（PR 說明有數字）：
-- 總表是約 35 支「缺口臂」，每支都是對整個資料庫的狀態查詢（缺口補上了就要收回），不是對貢獻做增量累加，所以不適合用高水位增量化
-- （貢獻被改回舊狀態、刪除、規則窗口開關都會讓增量漏收回）。改成砍掉兩支臂裡「每天跟著貢獻成長的整表掃描」：
--
--   (1) legacy 臂：對 5.4 萬筆政見逐筆呼叫 policy_primary_url()（約 1.9 秒，38 萬次 buffer 命中），結果只剩 6 筆。
--       改成先用 edit_history／contributions 兩個便宜條件收窄候選（MATERIALIZED，約 15 筆），最後才呼叫 policy_primary_url。
--       另外 edit_history 取 (table_name='policies', field IN ('audit','*')) 要走 5.4 萬筆、1.3 萬個資料頁（冷快取時整批從磁碟讀），
--       加部分索引讓它走 index-only scan。
--   (2) mismatch 臂：jev_decisions（51 萬列、443 MB）取 question='election' AND subject_type='policy' 的每個政見最新一筆（DISTINCT ON）。
--       現況是 bitmap heap scan 讀約 3.1 萬個資料頁再排序（冷快取 6～10 秒、暖 0.7 秒）。加覆蓋式部分索引
--       (subject_id, asked_at DESC) INCLUDE (choice, probability)，規劃器可以直接 index-only scan 取最新一筆、免排序。
--
-- 這兩個表都隨貢獻量成長（edit_history 每筆套用都寫、jev_decisions 每筆判斷都寫），所以這是「每天多慢幾秒」的來源。
-- 函式本體 legacy 與正式庫現行定義逐欄位相同，只重排條件順序（正式庫唯讀 EXCEPT 比對：新舊各 6 筆、雙向差集 0）。
-- mismatch 函式本體一個字沒動，只加索引。
--
-- 索引用一般 CREATE INDEX（不用 CONCURRENTLY：migration 在交易裡跑）。建索引時會短暫擋住這兩表的寫入（掃 443 MB／192 MB 的表，預估數秒）。
--
-- 回滾（一支遷移就夠）：
--   DROP INDEX IF EXISTS idx_edit_history_policies_audited;
--   DROP INDEX IF EXISTS jev_decisions_policy_election_latest_idx;
--   然後把 contribution_auto_tasks_legacy() 換回 20261007110000_sources_stage2b_read_side.sql 的定義（CREATE OR REPLACE，WHERE 條件原本在同一層）。
--   索引與函式互不依賴，可以只回滾其中一個。

CREATE INDEX IF NOT EXISTS idx_edit_history_policies_audited
  ON edit_history (record_id)
  WHERE table_name = 'policies' AND field IN ('audit', '*');

CREATE INDEX IF NOT EXISTS jev_decisions_policy_election_latest_idx
  ON jev_decisions (subject_id, asked_at DESC) INCLUDE (choice, probability)
  WHERE subject_type = 'policy' AND question = 'election';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH cand AS MATERIALIZED (
    -- 先用便宜的條件把候選收窄；MATERIALIZED 讓規劃器不能把 policy_primary_url 推回掃 policies 的那一層
    SELECT pl.id, pl.title, pl.politician_id
      FROM policies pl
     WHERE pl.removed_at IS NULL
       -- 查核過＝有人蓋過 audit 章，或這筆本來就是走貢獻流程建的（edit_history 的整列紀錄 field='*'）。
       -- 原本寫「沒有任何 edit_history 列」，於是只改過一欄的政見也被永久排除：實測 98 筆是這樣消失的，
       -- 多半是 policy_election_missing 只改了 election_id——那次代理打開來源只為了判斷屆別，沒有核對整筆。
       AND NOT EXISTS (
         SELECT 1 FROM edit_history e
         WHERE e.table_name = 'policies' AND e.record_id = pl.id::TEXT AND e.field IN ('audit', '*')
       )
       -- 「是貢獻建出來的」只有新增政見那一種（contribution_type='policy'）。
       -- 原本不看型別，於是任何一筆改到這筆政見的 correction／policy_progress，甚至一筆
       -- 回報「來源打不開」的 no_change，都會把 applied_policy_id 設成它而永久排除——
       -- 線上已有 133 筆落庫的 correction，收窄 edit_history 那條卻不收這條，等於沒改。
       AND NOT EXISTS (
         SELECT 1 FROM contributions c
         WHERE c.applied_policy_id = pl.id AND c.contribution_type = 'policy'
       )
  )
  SELECT 'auto:legacy_audit:' || pl.id, 'legacy_audit',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region, 'source_url', policy_primary_url(pl.id)),
         '「' || pl.title || '」（' || p.name || '）是早期由系統匯入的政見，附了來源但從沒有人核對過。'
           || '請打開來源：標題與內容是不是這個人的承諾、內容有沒有寫錯、屬於哪一場選舉。'
           || '資料正確 → 用 no_change 回報，outcome 填 confirmed（note 寫你核對了什麼，這筆才算查核過）；'
           || '欄位有錯 → correction 改對；不是政見（口號、行程、表態）→ removal（target_table policies、target_id、reason ≥20 字）。'
           || '**來源拿不到（打不開、逾時、被導去不相干的頁面、付費牆）→ no_change 但 outcome 填 unreachable**，'
           || '那不會把這筆標成已核對，過幾天會換人再試；**來源打得開卻證明不了這筆政見 → 不要回 no_change**，'
           || '那是 correction（欄位錯）或 removal（整筆不該存在）。'
           || '**每一個 source_url 都要打開**：同一批匯入的政見會互相借錯連結（實例：吳怡農的國防政見掛到 2023 敗選報導），'
           || '主題相符不等於這一頁證明了這筆政見。'
           || 'item.current.system_check 是系統對這個來源的逐欄核對結果，可以參考但請自己看過；'
           || '系統判 cannot_tell 是「系統看不出來」，不是「已確認沒問題」，不可以拿它當背書。',
         ARRAY[policy_primary_url(pl.id)], 1, p.region
  FROM cand pl JOIN politicians p ON p.id = pl.politician_id
  WHERE p.merged_into IS NULL
    -- 最貴的函式放最後：候選只剩約 175 筆才呼叫（原本對 5.4 萬筆政見逐筆呼叫，約 1.9 秒）
    AND policy_primary_url(pl.id) IS NOT NULL
$function$;

NOTIFY pgrst, 'reload schema';
