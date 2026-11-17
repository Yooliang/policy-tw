-- politician_bulletins 視圖：2026 的對照改走我們自己的參選紀錄。
--
-- 為什麼：視圖原本只認 2022、2024，靠 cec_candidates（中選會名單）用姓名比對。2026 的 cec_candidates 是 0 列，
--   所以 2026 的人再怎麼有公報也推不出來，補政見任務（policy_missing 的 current.bulletins、term_policy_missing 的
--   target.bulletin_urls）都是空的。
-- 怎麼改：2022／2024 的對法一個字不動（拿出來當 cec 那一段）；其餘屆別（今天只有 2026 有索引）另一段 own：
--   參選紀錄（filed／elected／not_elected）已經用 region_id 落在某個選舉單位，直接拿 regions 的縣市／鄉鎮市區／村里
--   對 election_bulletins 的同一組鍵，不需要姓名比對，所以也沒有「同名多人」的問題；號次用我們自己記的 politician_elections.cand_no。
--   withdrawn（退選）不列。election_bulletins 沒有那個單位的列就不給（寧可不附，不要給錯）。
-- 欄位名稱與型別跟舊視圖一模一樣；下游（politician_bulletins_for、term_policy_missing）不用動。
CREATE OR REPLACE VIEW politician_bulletins AS
WITH x AS (
  SELECT DISTINCT ON (pe.politician_id, pe.election_id, pe.election_type)
         pe.politician_id, pe.election_id, pe.election_type,
         CASE WHEN pe.candidacy_status = ANY (ARRAY['elected', 'not_elected']) THEN pe.candidacy_status ELSE NULL END AS election_result,
         replace(COALESCE(r.region, p.region), '臺', '台') AS county,
         replace(COALESCE(NULLIF(r.sub_region, ''), NULLIF(p.sub_region, '')), '臺', '台') AS town,
         replace(COALESCE(NULLIF(r.village, ''), NULLIF(p.village, '')), '臺', '台') AS village,
         cec_name_key(p.name) AS nn
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE pe.election_id = ANY (ARRAY[2022, 2024])
   ORDER BY pe.politician_id, pe.election_id, pe.election_type, pe.id
),
m AS (
  SELECT x.politician_id, x.election_id, x.election_type, x.election_result,
         c.region, COALESCE(c.sub_region, '') AS sub_region, COALESCE(c.village, '') AS village, c.cand_no, c.elected,
         count(*) OVER (PARTITION BY x.politician_id, x.election_id, x.election_type) AS n_match
    FROM x
    JOIN cec_candidates c
      ON c.election_id = x.election_id AND c.election_type = x.election_type
     AND replace(c.region, '臺', '台') = x.county AND c.name_norm = x.nn
     AND (x.town IS NULL OR x.election_type IN ('縣市長', '縣市議員', '立法委員')
          OR replace(COALESCE(c.sub_region, ''), '臺', '台') LIKE x.town || '%')
     AND (x.village IS NULL OR x.election_type <> '村里長' OR replace(COALESCE(c.village, ''), '臺', '台') = x.village)
),
cec AS (
  SELECT m.politician_id, m.election_id, m.election_type, m.election_result,
         m.region, m.sub_region, m.village, m.cand_no, m.elected,
         ARRAY(SELECT CASE WHEN u.p LIKE '01選舉公報/%' THEN 'https://bulletin.cec.gov.tw/' ELSE 'https://eebulletin.cec.gov.tw/' END || u.p
                 FROM unnest(b.paths) WITH ORDINALITY AS u(p, o) ORDER BY u.o) AS urls,
         b.match_basis
    FROM m
    JOIN election_bulletins b
      ON b.election_id = m.election_id AND b.election_type = m.election_type
     AND b.region = m.region AND b.sub_region = m.sub_region AND b.village = m.village
   WHERE m.n_match = 1
),
own AS (
  -- 2026 起：參選紀錄的選舉單位（regions）直接對 election_bulletins；不看姓名
  SELECT DISTINCT ON (pe.politician_id, pe.election_id, pe.election_type)
         pe.politician_id, pe.election_id, pe.election_type,
         CASE WHEN pe.candidacy_status = ANY (ARRAY['elected', 'not_elected']) THEN pe.candidacy_status ELSE NULL END AS election_result,
         b.region, b.sub_region, b.village, pe.cand_no,
         CASE pe.candidacy_status WHEN 'elected' THEN true WHEN 'not_elected' THEN false ELSE NULL END AS elected,
         ARRAY(SELECT CASE WHEN u.p LIKE '01選舉公報/%' THEN 'https://bulletin.cec.gov.tw/' ELSE 'https://eebulletin.cec.gov.tw/' END || u.p
                 FROM unnest(b.paths) WITH ORDINALITY AS u(p, o) ORDER BY u.o) AS urls,
         b.match_basis
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    JOIN regions r ON r.id = pe.region_id
    JOIN election_bulletins b
      ON b.election_id = pe.election_id AND b.election_type = pe.election_type
     AND replace(b.region, '臺', '台') = replace(r.region, '臺', '台')
     AND b.sub_region = replace(COALESCE(r.sub_region, ''), '臺', '台')
     AND b.village = replace(COALESCE(r.village, ''), '臺', '台')
   WHERE pe.election_id <> ALL (ARRAY[2022, 2024])
     AND pe.candidacy_status = ANY (ARRAY['filed', 'elected', 'not_elected'])
   ORDER BY pe.politician_id, pe.election_id, pe.election_type, pe.id
)
SELECT * FROM cec
UNION ALL
SELECT * FROM own;
COMMENT ON VIEW politician_bulletins IS
  '參選紀錄 → 選舉公報網址（urls）與號次（cand_no）。2022／2024：中選會名單唯一對得上的那一位（同名多人或公報推不出來的不列）；2026 起：參選紀錄所在的選舉單位直接對 election_bulletins（2026-11-17）';
