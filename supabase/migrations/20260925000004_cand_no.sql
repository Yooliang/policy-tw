-- 參選號次（2026-09-25 小良哥：已登記先用綠勾，名單公告有號次後改顯示「幾號」；2022 那屆有號次）
--
-- 協議早就收 candidacy 的 cand_no（contribution-schema 有驗），但沒有欄位可放，交了等於丟掉。
-- 這裡補欄位、視圖帶出去；落庫寫入見 _shared/apply-contribution.ts。

ALTER TABLE politician_elections ADD COLUMN IF NOT EXISTS cand_no INTEGER CHECK (cand_no IS NULL OR cand_no > 0);
COMMENT ON COLUMN politician_elections.cand_no IS '選票上的號次（中選會抽籤後才有；2022 由中選會資料庫補，2026 待 11/17 名單公告後由代理整份核對）';

CREATE OR REPLACE VIEW politicians_with_elections AS
 SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.election_type,
    p."position",
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
    COALESCE(( SELECT json_agg(pe.election_id) AS json_agg
           FROM politician_elections pe
          WHERE pe.politician_id = p.id), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion', COALESCE(per.sub_region, r.sub_region, p.sub_region), 'village', COALESCE(per.village, r.village, p.village), 'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no)) AS json_agg
           FROM politician_elections pe
             LEFT JOIN regions per ON pe.region_id = per.id
          WHERE pe.politician_id = p.id), '[]'::json) AS elections,
    p.merged_into
   FROM politicians p
     LEFT JOIN regions r ON p.region_id = r.id;
