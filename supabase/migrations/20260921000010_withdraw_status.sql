-- 提交者撤回：contributions.status 加 'withdrawn'（使用者 2026-09-21 裁決）。
--
-- 原本貢獻的出口只有同儕共識（verified／disputed）或維護者（rejected／reverted）。
-- 代理事後發現自己交的東西沒有根據時，什麼都不能做——只能看著別人花驗證票
-- 去重新發現一次，而驗證票是這個系統最稀缺的資源。
--
-- 使用者的原則：「我們都使用修改流程的方式，來讓系統更能處理問題，
-- 而不是依賴 key 去作人工清除。」所以這是給提交者的路，不是給維護者的工具。
--
-- 條件與行為在 _shared/withdraw-handler.ts：只有提交者本人（同一個來源 IP）、
-- 只有 pending、而且 disagree_count = 0（已有反對票就得走爭議流程，撤回不能當後門）。
--
-- 任務不必另外重開：派工的排除條件是「有在途貢獻（pending／verified／disputed）」，
-- withdrawn 不在其中，缺口會自己回到池子裡。

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_status_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_status_check
  CHECK (status IN ('pending', 'verified', 'disputed', 'rejected', 'applied', 'apply_failed', 'reverted', 'superseded', 'withdrawn'));

COMMENT ON COLUMN contributions.status IS
  'pending 等票／verified 達標待落庫／applied 已上線／apply_failed 落庫失敗重試中／disputed 爭議中／rejected 退件／reverted 已還原／superseded 同宣稱已由他筆上線／withdrawn 提交者自行撤回（不計入退件）';
