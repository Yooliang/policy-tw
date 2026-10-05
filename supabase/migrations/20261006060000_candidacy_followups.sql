-- #345 第一階段的後續三項（協調者 10-06 裁定 #376 的未決 2～4）；只加不刪
--
-- ① confirmed 收窄：只表示「表態參選」（本人宣布、政黨提名）。正式候選人名單公告之後（含已投票的屆別），
--    在名單上的人一律填 qualified（已審定）。這支只改說明：舊值的對應規則（candidacy_status_from_legacy）不動——
--    已投票屆別早期照中選會名冊匯入的 confirmed 仍對到 filed，那是舊資料的讀法；
--    新寫入的 confirmed 由落庫端（apply-contribution.ts）在名單公告後換成 qualified，回覆講一聲。
-- ② 退選分兩種顯示：新欄位 withdrawn_after_filing——true＝曾登記（登記後退選）、false＝沒登記過（表態不參選）、
--    NULL＝判斷不了（不參選）。只在 candidacy_status = 'withdrawn' 時有值。
--    之後由同步觸發器照「退選之前是什麼狀態」寫：之前是 filed → true；考慮參選、表明參選、沒有狀態（傳聞）→ false；其他 → NULL。
--    既有的照查核履歷（edit_history 的 candidate_status 變動）回填：履歷裡登記過（registered／qualified）→ true；
--    有履歷、從沒登記過 → false；沒有履歷（早期匯入就是 not_running）→ NULL。10-06 唯讀：true 3、false 22、NULL 83。
-- ③ 轉任卸任日是推定的：任期表加 end_basis——law＝依法任期屆滿、inferred＝推定（轉任別的公職，記新任期就任前一天）、
--    source＝有出處（更正交件附的）。畫面上 inferred 標「推定」；附出處的 correction 改卸任日後變成 source。
--    回填：既有 16 列 took_other_office → inferred。
-- 另外人物視圖的 elections[] 多帶 candidacyStatus 與 withdrawnAfterFiling 兩個鍵（欄位清單不變），畫面用來分兩種退選。

-- ── ② 退選分兩種 ──────────────────────────────────────────────
ALTER TABLE politician_elections ADD COLUMN IF NOT EXISTS withdrawn_after_filing BOOLEAN;
COMMENT ON COLUMN politician_elections.withdrawn_after_filing IS
  '退選之前有沒有登記過（#345）：true＝登記後退選、false＝沒登記過（表態不參選）、NULL＝判斷不了（顯示「不參選」）。只在 candidacy_status = withdrawn 時有值，由同步觸發器照退選前的狀態寫';

-- 回填（掛觸發器之前；這句只動新欄位，同步觸發器不會被觸發）
UPDATE politician_elections pe
   SET withdrawn_after_filing = h.after_filing
  FROM (
    SELECT x.id,
           CASE WHEN bool_or(eh.old_value #>> '{}' IN ('registered', 'qualified') OR eh.new_value #>> '{}' IN ('registered', 'qualified')) THEN true
                WHEN count(eh.id) > 0 THEN false
           END AS after_filing
      FROM politician_elections x
      LEFT JOIN edit_history eh
        ON eh.table_name = 'politician_elections' AND eh.record_id = x.id::TEXT AND eh.field = 'candidate_status'
     WHERE x.candidacy_status = 'withdrawn'
     GROUP BY x.id
  ) h
 WHERE h.id = pe.id AND pe.withdrawn_after_filing IS NULL AND h.after_filing IS NOT NULL;  -- 只補空的：觸發器已經寫了的不蓋

ALTER TABLE politician_elections DROP CONSTRAINT IF EXISTS politician_elections_withdrawn_after_filing_check;
ALTER TABLE politician_elections ADD CONSTRAINT politician_elections_withdrawn_after_filing_check
  CHECK (withdrawn_after_filing IS NULL OR candidacy_status = 'withdrawn');

-- 同步觸發器：原本的兩邊同步照舊（20261006034500），最後多寫 withdrawn_after_filing
CREATE OR REPLACE FUNCTION sync_candidacy_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_listed BOOLEAN;
  v_legacy_changed BOOLEAN;
  v_new_changed BOOLEAN;
  r RECORD;
BEGIN
  v_listed := candidacy_list_published(NEW.election_id, NEW.election_type, (now() AT TIME ZONE 'Asia/Taipei')::date);
  IF TG_OP = 'INSERT' THEN
    -- 新增時有給新欄位＝第二階段的寫入端（舊欄位那時只剩預設值 rumored）；沒給＝現在的寫入端
    v_new_changed := NEW.candidacy_status IS NOT NULL;
    v_legacy_changed := NOT v_new_changed;
  ELSE
    v_legacy_changed := NEW.candidate_status IS DISTINCT FROM OLD.candidate_status
                     OR NEW.election_result IS DISTINCT FROM OLD.election_result;
    v_new_changed := NEW.candidacy_status IS DISTINCT FROM OLD.candidacy_status;
  END IF;

  IF v_legacy_changed OR (v_new_changed AND NEW.candidacy_status IS NULL) THEN
    NEW.candidacy_status := candidacy_status_from_legacy(NEW.candidate_status, NEW.election_result, v_listed);
  ELSIF v_new_changed THEN
    SELECT * INTO r FROM legacy_status_from_candidacy(NEW.candidacy_status, NEW.candidate_status, NEW.election_result, v_listed);
    NEW.candidate_status := r.candidate_status;
    NEW.election_result := r.election_result;
  END IF;

  -- 退選分兩種（#345 後續）：剛變成退選時看退選前的狀態；已經是退選、或新增的，保留寫入端給的值（沒給＝判斷不了）
  IF NEW.candidacy_status = 'withdrawn' THEN
    IF TG_OP = 'UPDATE' AND OLD.candidacy_status IS DISTINCT FROM 'withdrawn' THEN
      NEW.withdrawn_after_filing := CASE
        WHEN OLD.candidacy_status = 'filed' THEN true
        WHEN OLD.candidacy_status IS NULL OR OLD.candidacy_status IN ('considering', 'declared') THEN false
      END;
    END IF;
  ELSE
    NEW.withdrawn_after_filing := NULL;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION sync_candidacy_status IS '#345 過渡期：candidacy_status 跟 candidate_status＋election_result 兩邊同步（舊欄位有變以舊欄位為準）；退選時記退選前有沒有登記過（withdrawn_after_filing）。第二階段刪舊欄位時改寫';

-- ── ① confirmed 收窄（只改說明） ────────────────────────────────
COMMENT ON COLUMN politician_elections.candidate_status IS
  '舊的參選狀態。confirmed 只表示表態參選（本人宣布、政黨提名）；正式名單公告後（含已投票屆別）在名單上的填 qualified（#345 後續，2026-10-06）；早期匯入的已投票屆別 confirmed 照舊讀成已登記。其餘：rumored／likely／registered／not_running／elected／defeated。#345 過渡中：讀新欄 candidacy_status，這欄第二階段刪';
COMMENT ON FUNCTION candidacy_status_from_legacy IS
  '舊的 candidate_status＋election_result 對到新的 candidacy_status（#345）；rumored（傳聞）對到 NULL＝不收。confirmed 在名單公告後對到 filed 只為了讀早期匯入的舊資料——新寫入的在名單公告後由落庫端換成 qualified。TS 鏡像 _shared/candidacy-status.ts';

-- ── ③ 轉任卸任日標「推定」 ──────────────────────────────────────
ALTER TABLE politician_offices ADD COLUMN IF NOT EXISTS end_basis TEXT;
UPDATE politician_offices
   SET end_basis = CASE end_reason WHEN 'term_expired' THEN 'law' WHEN 'took_other_office' THEN 'inferred' ELSE 'source' END
 WHERE end_date IS NOT NULL AND end_basis IS NULL;
ALTER TABLE politician_offices DROP CONSTRAINT IF EXISTS politician_offices_end_basis;
ALTER TABLE politician_offices ADD CONSTRAINT politician_offices_end_basis
  CHECK ((end_date IS NULL) = (end_basis IS NULL) AND (end_basis IS NULL OR end_basis IN ('law', 'inferred', 'source')));
COMMENT ON COLUMN politician_offices.end_basis IS
  '卸任日的根據：law＝依法任期屆滿／inferred＝推定（轉任別的公職，記新任期就任前一天；畫面標「推定」）／source＝有出處（correction 附的，出處在 source_url）';

-- 每日卸任排程：同 20261006034510，多寫 end_basis
CREATE OR REPLACE FUNCTION politician_offices_close_ended(p_today DATE DEFAULT CURRENT_DATE, p_politician_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n INTEGER;
BEGIN
  WITH nxt AS (
    SELECT o.id,
           (SELECT min(o2.start_date) FROM politician_offices o2
             WHERE o2.politician_id = o.politician_id AND o2.id <> o.id
               AND o2.start_date > o.start_date AND o2.start_date <= p_today) AS next_start
      FROM politician_offices o
     WHERE o.end_date IS NULL
       AND (p_politician_id IS NULL OR o.politician_id = p_politician_id)
  ), closing AS (
    SELECT o.id, o.scheduled_end_date, n.next_start,
           (n.next_start IS NOT NULL AND n.next_start - 1 < o.scheduled_end_date) AS switched
      FROM politician_offices o JOIN nxt n ON n.id = o.id
     WHERE o.scheduled_end_date < p_today
        OR (n.next_start IS NOT NULL AND n.next_start - 1 < o.scheduled_end_date)
  ), upd AS (
    UPDATE politician_offices o
       SET end_date = CASE WHEN c.switched THEN c.next_start - 1 ELSE c.scheduled_end_date END,
           end_reason = CASE WHEN c.switched THEN 'took_other_office' ELSE 'term_expired' END,
           end_basis = CASE WHEN c.switched THEN 'inferred' ELSE 'law' END,
           updated_at = now()
      FROM closing c
     WHERE o.id = c.id
    RETURNING o.id, o.end_date, o.end_reason
  ), hist AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    SELECT 'politician_offices', u.id::TEXT, 'end_date', NULL, to_jsonb(u.end_date::TEXT || ' ' || u.end_reason), 'office-sync'
      FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM hist;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION politician_offices_close_ended IS '把該卸任的任期關掉（#345）：任期屆滿 term_expired／law；同一人後來已就任別的公職 took_other_office／inferred（推定：新任期就任前一天）。只寫已經發生的';

-- ── 人物視圖：elections[] 多帶兩個鍵 ──────────────────────────────
-- 照 20261005004300 原樣，只在 elections 的 json_build_object 加 candidacyStatus、withdrawnAfterFiling（欄位清單不變）。
-- offices 子查詢明寫 politician_offices_derived：#345 第一階段網站職稱仍讀舊視圖（20261006034510 改名），
-- 照抄舊定義的「FROM politician_offices o」會變成讀任期表。
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
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region),
             'subRegion', CASE WHEN COALESCE(pe.election_type::TEXT, p.election_type::TEXT) IN ('總統副總統', '縣市長', '縣市議員', '立法委員')
                               THEN per.sub_region ELSE COALESCE(per.sub_region, r.sub_region, p.sub_region) END,
             'village', CASE WHEN COALESCE(pe.election_type::TEXT, p.election_type::TEXT) IN ('總統副總統', '縣市長', '縣市議員', '立法委員')
                             THEN per.village ELSE COALESCE(per.village, r.village, p.village) END,
             'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no,
             'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing)) AS json_agg
           FROM politician_elections pe
             LEFT JOIN regions per ON pe.region_id = per.id
          WHERE pe.politician_id = p.id), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', o.region, 'subRegion', o.sub_region, 'village', o.village, 'termEnd', o.term_end) ORDER BY o.election_id DESC) AS json_agg
           FROM politician_offices_derived o
          WHERE o.politician_id = p.id), '[]'::json) AS offices
   FROM politicians p
     LEFT JOIN regions r ON p.region_id = r.id;

-- CREATE OR REPLACE VIEW 會把 reloptions 清掉（20261004000005 實測），security_invoker 要補回來
ALTER VIEW politicians_with_elections SET (security_invoker = on);
