-- 補學經歷條列（profile_detail_gap，協議 1.42.0；維護者 2026-10-02 裁示）
--
-- 人物頁側欄的「學歷」「經歷」兩塊讀的是 politicians.education[] / experience[]
-- （PoliticianProfile.vue:586、601），空的時候顯示「暫無資料」。
-- 線上量（2026-10-02）：16,195 位人物裡 education 空的 16,137、experience 空的 16,143
-- —— 全站只有 58 個人有結構化學歷。而**沒有任何任務型別會去補這兩個欄位**：
-- profile_gap 只看 birth_year／current_position／avatar_url。
--
-- 林亮君（f9fdb6b6）是實例：birth_year 1989、current_position 臺北市議員、
-- education_level 碩士、bio 寫著完整學經歷散文，education／experience 都是 NULL，側欄兩塊空白。
-- 代理交了一筆 politician 貢獻並通過驗證，apply 回「已對到既有人物（無空欄位可補）」
-- —— 它交的四個欄位本來就有值，該補的那兩個陣列它沒交。那一輪額度換到零，側欄還是空的。
--
-- 為什麼不折進 profile_gap：967 位 2026 候選人的學經歷都是空的，折進去等於
-- 「全員都有 profile_gap 缺口」，profile_gap 本來「缺基本識別資料」的意思會被稀釋，
-- 而且會把補照片（805 筆）跟補學經歷（967 筆）擠在同一個型別裡搶隊列。
--
-- 試水溫範圍（維護者裁示先跑小的）：**bio 已經有值**而學經歷有缺的，線上 98 筆。
-- 挑這個條件是因為 bio 裡通常已經寫著學經歷散文，代理知道要找什麼、驗證者也好核；
-- 不限 2026（只限 2026 是 69 筆，多出來的 29 筆一樣便宜，不加這條沒必要的限制）。
-- 要放寬到「所有學經歷空的人」就把 WHERE 的 bio 條件拿掉 —— 那是 16,134 筆，會淹掉隊列，
-- 等這 98 筆的成效（上線率、退件率）看過再決定。
--
-- 🔴 bio 本身沒有附來源，所以這個任務**不是「把 bio 抄成陣列」就好**：
-- 代理要找到支持那些學經歷的來源網址（官方個人頁、議會介紹頁、維基），bio 只是線索。
--
-- 只「加」：新增一支臂，contribution_auto_tasks_arms() 以同簽名 CREATE OR REPLACE
-- （原八支臂照抄自 20261002000001）。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_profile_details()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:profile_detail_gap:' || p.id, 'profile_detail_gap',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'party', p.party,
                            'region', COALESCE(p.region, ''), 'current_position', p.current_position,
                            'missing', ARRAY_REMOVE(ARRAY[
                              CASE WHEN COALESCE(cardinality(p.education), 0) = 0 THEN 'education' END,
                              CASE WHEN COALESCE(cardinality(p.experience), 0) = 0 THEN 'experience' END], NULL)),
         p.name || '（' || COALESCE(p.region, '') || '）的人物頁側欄「'
           || array_to_string(ARRAY_REMOVE(ARRAY[
                CASE WHEN COALESCE(cardinality(p.education), 0) = 0 THEN '學歷' END,
                CASE WHEN COALESCE(cardinality(p.experience), 0) = 0 THEN '經歷' END], NULL), '」「')
           || '」顯示「暫無資料」—— 那兩塊讀的是 education[]／experience[] 兩個陣列，不是 bio。'
           || '請用一筆 politician 型別補上 **education[]／experience[] 陣列，一條一項**'
           || '（例 education: ["國立臺灣師範大學企業管理系", "國立清華大學科技法律研究所碩士"]）。'
           || '**寫進 bio 散文裡不算** —— 那兩塊照樣顯示「暫無資料」。'
           || 'current.politician.bio 通常已經寫著學經歷，可以當線索知道要找什麼，'
           || '但 **bio 本身沒有附來源，不能只憑它就交**：source_urls 要放你實際打開、看得到這些學經歷的網址'
           || '（所屬機關／議會的個人介紹頁、維基百科、本人官網）。'
           || 'bio 跟來源不一致時以來源為準，並在 note 說明哪裡不一致。'
           || '只補查得到的那一個欄位也可以；兩個都查不到就回 not_found。'
           || '**已經有值的欄位不要重交**（看 current.politician）—— 伺服器只補空欄位，重交那一輪是白做。',
         ARRAY['所屬機關／議會官網的個人介紹頁（學歷、經歷最常在這裡）',
               'zh.wikipedia.org 該人物條目',
               'ly.gov.tw 立委個人頁',
               '本人官網／競選網站的「關於我」'], 1, COALESCE(p.region, '')
  FROM politicians p
  WHERE p.merged_into IS NULL
    AND COALESCE(btrim(p.bio), '') <> ''
    AND (COALESCE(cardinality(p.education), 0) = 0 OR COALESCE(cardinality(p.experience), 0) = 0)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_profile_details IS
  'bio 已有值、但 education[]／experience[] 其中一個是空的 → profile_detail_gap（補學經歷條列）。'
  '2026-10-02 維護者裁示先跑這個小範圍（98 筆）；要放寬到所有學經歷空的人就拿掉 bio 條件（16,134 筆，會淹掉隊列）。';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT * FROM contribution_auto_tasks_raw()
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_profile_details()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫';
