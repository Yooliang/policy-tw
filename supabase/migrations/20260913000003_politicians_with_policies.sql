-- 「有政見的人物」用一個 view 拿，不要把 77 個 uuid 塞進網址。
--
-- 2026-09-13 我加了 loadPoliticiansWithPolicies（政見卡片與縣市篩選都要這批人，
-- 不然卡片會被 v-if 整張吃掉）。實作是先撈出 politician_id 再用
-- `id=in.(uuid1,uuid2,…)` 回頭查，產生的網址長度是 **2,941 字元**。
--
-- 從桌機直連 Supabase 這樣是 200，但超過 2048／2083 的網址在行動網路的代理伺服器
-- 與不少 WAF 上會直接被回 403——在手機上看到的就是這個。而且人物數量會長，
-- 網址只會越來越長，這是個會隨資料成長而惡化的實作。
--
-- 改成 view：前端一個短網址、一次查詢，也不必在前端維護分批邏輯。
-- 條件跟前端原本算的完全一樣：有至少一筆未軟移除的政見。

CREATE OR REPLACE VIEW politicians_with_policies AS
SELECT p.*
FROM politicians_with_elections p
WHERE EXISTS (
  SELECT 1 FROM policies pl
  WHERE pl.politician_id = p.id AND pl.removed_at IS NULL
);

COMMENT ON VIEW politicians_with_policies IS '名下至少有一筆未移除政見的人物；政見卡片與縣市篩選靠它，避免前端用 id=in.(…) 產生超長網址';

-- 跟其他 view 一樣以呼叫者身分執行，底層表的 RLS 才會生效（見 20260912000016）
ALTER VIEW politicians_with_policies SET (security_invoker = on);
