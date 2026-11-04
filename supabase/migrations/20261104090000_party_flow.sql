-- 政黨分流圖（/parties/flow，工作單：Yooliang/policy-ops#193）：中選會名冊依（政黨、縣市、鄉鎮、選舉別）分組的人數。
--
-- 只讀 cec_roster_2026（官方名冊鏡像，公開可讀），只回聚合：不回姓名、生日、住址。
-- 名冊近 2 萬列、分組後約 1,600 列，超過 PostgREST 單次 1,000 列上限，所以整包用一個 jsonb 陣列回傳（單一純量不受列數上限影響）。
-- 正規化：縣市、鄉鎮、政黨名稱的「臺」換成「台」；政黨為空或「無」＝無黨籍，統一寫成「無黨籍」。
-- 沒有鄉鎮的選舉（縣市長、縣市議員）town 為空字串。
-- 引用到的既有欄位（2026-11-04 唯讀查詢確認存在）：cec_roster_2026(party, county, town, election_type)

CREATE OR REPLACE FUNCTION party_flow_counts()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('p', party, 'c', county, 't', town, 'e', election_type, 'n', n)
                            ORDER BY party, county, town, election_type), '[]'::jsonb)
    FROM (
      SELECT CASE WHEN COALESCE(btrim(party), '') IN ('', '無') THEN '無黨籍' ELSE replace(btrim(party), '臺', '台') END AS party,
             replace(county, '臺', '台') AS county,
             replace(COALESCE(town, ''), '臺', '台') AS town,
             election_type,
             count(*)::integer AS n
        FROM cec_roster_2026
       GROUP BY 1, 2, 3, 4
    ) g;
$$;
COMMENT ON FUNCTION party_flow_counts() IS '政黨分流圖用：名冊依（政黨、縣市、鄉鎮、選舉別）分組的人數，只有聚合、沒有姓名。回一個 jsonb 陣列（鍵 p 政黨、c 縣市、t 鄉鎮、e 選舉別、n 人數）。2026-11-04';
GRANT EXECUTE ON FUNCTION party_flow_counts() TO anon, authenticated;
