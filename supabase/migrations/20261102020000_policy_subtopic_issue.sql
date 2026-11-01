-- 議題細項 P1b（policy-ops#173）：新承諾交件可帶選填 subtopic，落庫時寫進 policy_subtopics
-- ============================================================
--
-- policy 交件的 payload 多一個選填欄位 subtopic（細項名）。細項掛在「大類議題」底下，所以落庫要先知道這筆承諾的大類：
-- 這支函式回它的大類議題（issue_tags_of 的結果；有多個時優先取 category，其次依字母序第一個），
-- 沒有議題（標籤全是雜訊且類別是其他）就回 NULL，落庫端略過細項、不擋承諾本身。
-- 細項仍然獨立存放在 policy_subtopics，不寫進 policies.tags（理由見 20261102010000）。只新增唯讀函式。

CREATE OR REPLACE FUNCTION policy_subtopic_issue(p_policy_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN btrim(COALESCE(p.category, '')) = ANY (k.issues) THEN btrim(p.category)
           ELSE (SELECT min(i) FROM unnest(k.issues) AS i)
         END
    FROM policies p
    JOIN politicians po ON po.id = p.politician_id
    CROSS JOIN LATERAL (SELECT issue_tags_of(p.tags, p.category, ARRAY[po.name]) AS issues) k
   WHERE p.id = p_policy_id AND cardinality(k.issues) > 0
$$;
REVOKE ALL ON FUNCTION policy_subtopic_issue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_subtopic_issue(uuid) TO service_role;
COMMENT ON FUNCTION policy_subtopic_issue IS '一筆承諾的大類議題（issue_tags_of；多個時優先 category，其次字母序第一個），沒有就 NULL。policy 交件帶 subtopic 時落庫用（policy-ops#173 P1b）。';

NOTIFY pgrst, 'reload schema';
