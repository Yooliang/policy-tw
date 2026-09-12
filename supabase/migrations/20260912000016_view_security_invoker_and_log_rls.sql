-- 開源前的安全收斂。兩個問題都是「RLS 看起來全開好了，其實有繞道」。
--
-- 一、檢視繞過 RLS
--   實測：匿名身分 POST /rest/v1/discussions_full 回的是
--   「null value in column "policy_title" of relation "discussions"」——
--   注意 relation 是底層表 discussions，代表寫入已經穿過 RLS，只被 NOT NULL 攔下。
--   其他每一張表同樣的探測都回 42501（RLS 擋住）。
--   原因是 PostgreSQL 的檢視預設以「建立者」的身分執行，底層表的 RLS 不會套到呼叫者。
--   security_invoker = on 讓檢視以呼叫者身分執行，底層表的 RLS 才會生效。
--   這個專案的前端只讀這些檢視，改了不影響讀取。
--
-- 二、ai_usage_logs 可匿名寫入
--   政策是 FOR INSERT WITH CHECK (true)，任何人拿公開的 anon key 就能塞資料進來。
--   實際只有 edge function 用服務金鑰在寫（ai-action／ai-classify／ai-contribute／ai-search），
--   收斂成 service_role 不會壞掉任何東西。目前表內 0 筆。

-- 逐一列名會漏、也會被「其實是物化檢視」這種例外炸掉（ai_usage_stats 就是），
-- 所以掃 pg_views 動態處理，以後新增的檢視也自動涵蓋。
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = on)', v.viewname);
    RAISE NOTICE '檢視 % 已改為以呼叫者身分執行', v.viewname;
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Public can insert" ON ai_usage_logs;
DROP POLICY IF EXISTS "Service role write" ON ai_usage_logs;
CREATE POLICY "Service role write" ON ai_usage_logs FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
