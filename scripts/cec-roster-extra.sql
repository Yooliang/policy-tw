-- 站上有效、中選會選舉專區名單（鏡像 cec_roster_2026）卻沒有的人（唯讀；2026-10-31）
-- 用法（部署 20261031160000 並且鏡像抓過一輪之後）：
--   npx supabase db query --linked -f scripts/cec-roster-extra.sql
-- 一列一位：politician_id、politician_election_id、姓名、選舉別、縣市、鄉鎮（村里長）、號次單位、站上號次與狀態、該單位官方 JSON 網址。
-- 已排除：造字代碼、異體字、同號次僅差一字或子字串（cec_name_fuzzy_eq）、退選的紀錄、沒抓到（超過 3 天）的單位。
-- 打網站請求：request-task 的 kind=audit（帶 politician_id、source_url＝roster_url、note＝「中選會名單查無此人，請查參選狀態」）。
SET default_transaction_read_only = on;
SELECT d.politician_id,
       d.pe_id            AS politician_election_id,
       d.our_name         AS name,
       d.election_type,
       d.county,
       d.town,
       d.unit,
       d.our_cand_no      AS cand_no,
       d.our_status       AS candidacy_status,
       (SELECT u.url FROM cec_roster_units u
         WHERE u.status = 'ok' AND u.election_type = d.election_type AND replace(u.county, '臺', '台') = d.county
           AND (d.election_type <> '村里長' OR replace(u.town, '臺', '台') = d.town) LIMIT 1) AS roster_url
  FROM cec_roster_diff() d
 WHERE d.kind = 'extra'
 ORDER BY d.election_type, d.county, d.town, d.unit, d.our_name;
