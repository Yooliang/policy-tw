-- 照片二選一（維護者 2026-10-11，policy-ops#89）：既有被「只補空欄位」默默丟掉的照片交件，一次開成 avatar_choice 任務
--
-- 起因：politician 交件對到既有人物只補空欄位。人物已經有照片時，後來通過驗證的另一張照片沒套用、狀態照樣 applied
-- （回覆只寫「無空欄位可補」）。2026-10-11 唯讀查：這種交件 88 筆、69 位（蕭燐洪的照片被公報整頁截圖佔住就是其中一位）。
-- 新的交件由落庫程式（_shared/avatar-choice.ts 的 openAvatarChoice）開任務；這支只補既有的，不改任何正式資料，
-- 任務走一般派工（contribution_tasks 的 INSERT 觸發器排進佇列尾），代理挑新的才經 correction 換照片。
--
-- 條件跟 openAvatarChoice 同一套：人物現在有照片、交件的照片跟現有不同、不是佔位圖；同一位同一張新照片只開一件
-- （已經有同一對的 avatar_choice 任務就不開，可重跑）。照片形狀守門擋下的（回覆含「照片沒套用」）不算被丟掉，不開。
-- 已合併的人物跟著 merged_into 走到保留者（只走一層：實際最深 1，見 apply-contribution.ts 的 MAX_MERGE_HOPS 說明）。

INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, status, source, created_by, hint_sources)
SELECT '「' || x.name || '」的照片二選一',
       '「' || x.name || '」已經有照片，又有人交了另一張。兩張都打開看，挑一張比較合適的本人人像照。'
         || '這些都不算合格，盡量避開：背影、側臉、黑白照（選舉公報或 PDF 裡的常是）、從截圖裡裁出來的照片或整頁公報與文件截圖、有多個人物的照片（合照、活動現場照）、海報或旁邊夾著文字的圖、太小或模糊的圖。'
         || '優先：彩色、正面、只有本人、臉清楚的人像照。兩張都有缺點時挑缺點少的。',
       'avatar_choice',
       jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'current_avatar_url', x.current_avatar_url,
                          'new_avatar_url', x.new_avatar_url, 'contribution_id', x.contribution_id),
       x.region, 0, 1, 'open', 'auto_dispute', 'avatar-choice', ARRAY[]::TEXT[]
FROM (
  SELECT DISTINCT ON (p.id, c.payload->>'avatar_url')
         p.id AS politician_id, p.name, p.region, p.avatar_url AS current_avatar_url,
         c.payload->>'avatar_url' AS new_avatar_url, c.id AS contribution_id
  FROM contributions c
  JOIN politicians p0 ON p0.id = c.applied_politician_id
  JOIN politicians p ON p.id = COALESCE(p0.merged_into, p0.id)
  WHERE c.contribution_type = 'politician'
    AND c.status = 'applied'
    AND COALESCE(c.payload->>'avatar_url', '') <> ''
    AND p.avatar_url IS NOT NULL
    AND p.merged_into IS NULL
    AND c.payload->>'avatar_url' <> p.avatar_url
    AND COALESCE(c.review_notes, '') NOT LIKE '%照片沒套用%'
    AND NOT is_placeholder_avatar(c.payload->>'avatar_url')
    AND NOT EXISTS (
      SELECT 1 FROM contribution_tasks t
       WHERE t.task_type = 'avatar_choice'
         AND t.target->>'politician_id' = p.id::TEXT
         AND t.target->>'new_avatar_url' = c.payload->>'avatar_url')
  ORDER BY p.id, c.payload->>'avatar_url', c.created_at DESC
) x;
