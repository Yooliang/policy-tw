-- politician_election_policy_counts：每人每屆的承諾數／政見數（#982 延伸）。
--
-- 為什麼：選舉頁候選人卡片的「N 項承諾」以前要把整份政見清單（2026 屆 7,675 筆、預渲染 HTML 7.75 MB，
--   瀏覽器端再分頁抓全站 14,236 筆）載下來才算得出來。現在改讀這支視圖：一人一屆一列，幾 KB 就夠。
-- 怎麼算：只算沒被軟移除（removed_at IS NULL）且標了屆別（election_id 不為空）的政見；
--   pledge_count＝status 為 Campaign Pledge（競選承諾）的筆數，policy_count＝該人該屆全部未移除政見的筆數。
--   沒標屆別的政見不在這支視圖裡（跟選舉頁「只認標了屆別的」同一個規則）。
-- 權限：比照 policies_with_logs——security_invoker＋給 anon／authenticated 讀；底層 policies 的 RLS 照常生效。
CREATE OR REPLACE VIEW politician_election_policy_counts AS
SELECT
  p.politician_id,
  p.election_id,
  count(*) FILTER (WHERE p.status = 'Campaign Pledge')::int AS pledge_count,
  count(*)::int AS policy_count
FROM policies p
WHERE p.removed_at IS NULL
  AND p.election_id IS NOT NULL
GROUP BY p.politician_id, p.election_id;

ALTER VIEW politician_election_policy_counts SET (security_invoker = on);
GRANT SELECT ON politician_election_policy_counts TO anon, authenticated;
COMMENT ON VIEW politician_election_policy_counts IS
  '每人每屆的承諾數（status=Campaign Pledge）與政見數（全部未移除），選舉頁卡片與預渲染用，取代下載整份政見清單來算（#982 延伸）。';
