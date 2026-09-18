-- 人物的選舉資料多帶 electionResult（2026-09-18）。
--
-- 畫面要能說明「這場選舉未當選，所以這項競選承諾不會有執行進度」——看的人現在只看到
-- 一片空白，不知道是還沒人追進度，還是根本不可能有。election_result 就在
-- politician_elections 上，只是這個 view 沒帶出來。
--
-- 只改 elections 這個 JSON 欄位的內容，view 的欄位名稱與型別都不變，所以用 CREATE OR REPLACE
-- 就夠，不必像 20260201100002 那樣先 DROP、再重建相依的函式
-- （get_politicians_by_election／get_politicians_by_filters 不受影響）。

CREATE OR REPLACE VIEW politicians_with_elections AS
SELECT
  p.id,
  p.name,
  p.party,
  p.status,
  p.election_type,
  p.position,
  p.current_position,
  COALESCE(r.region, p.region) AS region,
  COALESCE(r.sub_region, p.sub_region) AS sub_region,
  COALESCE(r.village, p.village) AS village,
  p.avatar_url,
  p.slogan,
  p.bio,
  p.education,
  p.experience,
  p.birth_year,
  p.education_level,
  COALESCE(
    (SELECT json_agg(pe.election_id) FROM politician_elections pe WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS election_ids,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'electionId', pe.election_id,
        'position', COALESCE(pe.position, p.position),
        'slogan', COALESCE(pe.slogan, p.slogan),
        'electionType', COALESCE(pe.election_type, p.election_type::TEXT),
        'regionId', pe.region_id,
        'region', COALESCE(per.region, r.region, p.region),
        'subRegion', COALESCE(per.sub_region, r.sub_region, p.sub_region),
        'village', COALESCE(per.village, r.village, p.village),
        'candidateStatus', pe.candidate_status,
        'electionResult', pe.election_result,
        'sourceNote', pe.source_note
      )
    ) FROM politician_elections pe
    LEFT JOIN regions per ON pe.region_id = per.id
    WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS elections
FROM politicians p
LEFT JOIN regions r ON p.region_id = r.id;
