-- verify_dispatches 不再公開可讀（#495，#493 審查附帶發現）。
--
-- 現況：20260921000014 建表時給了 `verify_dispatches_read FOR SELECT USING (true)`（「跟其他表一致」），
-- 加上 Supabase 預設把新表的權限全給 anon／authenticated，所以拿公開的 anon key 就能
-- GET /rest/v1/verify_dispatches 讀到每一列的 ip_hash（來源網段雜湊）與 agent_name。
-- 同一份資料的公開出口 dispatch_recent() 特別標了「不含來源 IP」，這張表本身卻沒有。
--
-- 誰在讀它（2026-10-09 盤點，正式庫唯讀＋全部原始碼）：
--   Edge Function：next、verify-handler（POST /verify、/report）都用 service_role，不受影響。
--   SQL 函式：contribution_verify_pool 及其前身是 INVOKER，但只有 next、verifications 兩支 Edge Function
--            用 service_role 呼叫；前端沒有任何地方呼叫它（Queue.vue 只呼叫 queue_preview 與 dispatch_recent）。
--            dispatch_recent 是 SECURITY DEFINER，以函式擁有者身分讀表，/queue 頁照常。
--            dispatch_records_purge 只授權 service_role。
--   視圖、觸發器：沒有依賴這張表的視圖。
--   前端（.vue／.ts）：沒有直接讀取。policy-jp、policy-console 兩個 repo 逐檔檢查，也沒有。
--
-- 做法：兩層都收——
--   1. 刪掉 USING (true) 的 policy（RLS 仍開著，沒有 policy ＝ 非 BYPASSRLS 的角色看到 0 列）。
--   2. REVOKE anon／authenticated 的所有權限。只刪 policy 的話，不小心用 anon 身分呼叫
--      contribution_verify_pool 會「安靜地讀到 0 列」而不是報錯，驗證池會變成永遠不排除自己派過的；
--      REVOKE 讓這種誤用大聲失敗（permission denied）。
-- service_role 有 BYPASSRLS 與自己的權限，SECURITY DEFINER 函式以擁有者身分執行，兩者都不受影響。
-- 需要公開的「最近誰領走了什麼（不含來源 IP）」維持走 dispatch_recent()。
--
-- 不改 API 形狀、不改協議版號。

DROP POLICY IF EXISTS verify_dispatches_read ON verify_dispatches;
REVOKE ALL ON TABLE verify_dispatches FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE verify_dispatches IS
  '伺服器把哪一筆待驗證派給了哪個來源 IP。投票時要求對得上——派發是唯一的工作來源，代理不能自己挑題目。同時是「這一筆最後何時派出」的依據。含 ip_hash、agent_name，不公開：只有 service_role 與 SECURITY DEFINER 函式能讀；公開出口是 dispatch_recent()（不含來源 IP）。';
