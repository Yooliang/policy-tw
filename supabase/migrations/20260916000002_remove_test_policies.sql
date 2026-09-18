-- 清掉混在正式資料裡的測試政見（軟移除）。
--
-- 2026-09-16 加「疑似不是政見」偵測時，掃線上 372 筆政見一起掃出來的：
-- 8 筆 title='TEST'、description='test'、source_url='https://example.com'，
-- 全部是 2026-06-09 同一批 ai_extracted 進來的，掛在 8 位真實人物底下（張東正、林強世、
-- 劉坤鱧、何炳樺、廖振源、彭進廷、陳秋淑、林峻宇）。回饋：「可以的話，直接清掉」。
--
-- 用軟移除（removed_at，見 migration 20260912000015）而不是 DELETE：
-- 這個站的移除一律可復原，紀錄留著；讀者端看不到就夠了。
--
-- 條件寫成「三個特徵同時成立」而不是列 id：真的要誤傷，得有人把政見取名 TEST、
-- 內容寫 test、來源填 example.com——那樣的資料本來也該被清掉。

UPDATE policies
   SET removed_at = now(),
       removed_reason = '測試資料：標題與內容都是 test、來源是 example.com，不是真實政見'
 WHERE removed_at IS NULL
   AND btrim(lower(title)) = 'test'
   AND btrim(lower(description)) = 'test'
   AND source_url = 'https://example.com';
