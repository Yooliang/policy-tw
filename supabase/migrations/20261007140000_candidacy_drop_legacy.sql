-- #345 第二階段 B：刪舊的參選狀態欄位（politician_elections 的 candidate_status、election_result、votes_received、vote_percentage）
-- 與兩欄之間的同步觸發器。第二階段 A（20261006220000，10-06 合併、三段部署都綠）已經把讀寫端全部換成 candidacy_status，
-- 這支只刪不用的東西。刪欄位不可復原——合併前請先看 PR 描述的「資料比對」與「需要維護者決定的事」。
--
-- 做了什麼：
--   ① 票數備份：votes_received／vote_percentage 沒有搬到任何新地方（站上不顯示、協議不收），1,604 筆只存在這兩欄。
--      刪欄位之前原樣存進 politician_election_votes_archive（不想留就在合併前拿掉第 ① 段、或事後 DROP 那張表）
--   ② 視圖：politicians_with_elections 的 elections[] 拿掉 candidateStatus／electionResult 兩個鍵（欄位清單不變，CREATE OR REPLACE）；
--      elected_politicians 拿掉票數兩欄（DROP 重建、補回 security_invoker 與授權）；
--      politician_offices_derived 改看 candidacy_status（行為不變，刪欄位前要先放掉對 election_result 的依賴）
--   ③ 觸發器與函式：
--      - 任期觸發器 trg_sync_politician_office 的欄位清單拿掉 election_result
--      - 刪 trg_sync_candidacy_status／sync_candidacy_status／candidacy_status_from_legacy／legacy_status_from_candidacy（舊兩欄的雙向同步）
--      - **但 sync_candidacy_status 還兼管 withdrawn_after_filing**（退選前有沒有登記過：剛變成退選時看退選前的狀態、不是退選就清成空，
--        CHECK politician_elections_withdrawn_after_filing_check 要它）。第二階段 A 的清單漏了這一件，這裡拆成獨立的
--        politician_elections_withdrawn_flag() 與觸發器 trg_politician_elections_withdrawn_flag，邏輯一字不改
--      - politician_latest_election() 的輸出欄 candidate_status 改成 candidacy_status（簽名變了，DROP 重建；呼叫它的觸發器只用 position／slogan／election_type／region_id）
--   ④ 刪欄位：candidate_status（連同 CHECK 與預設值 rumored）、election_result（連同 CHECK 與索引 idx_politician_elections_result）、votes_received、vote_percentage
--   ⑤ 結尾自檢：四欄都不在了、備份筆數對得上、三個視圖的內容跟刪之前一致、退選旗標觸發器在、授權還在，對不上整支退回
--
-- 不刪的：politician_offices_derived 與 politician_offices_gap。第二階段 A 清單列了要刪，但它們是「2026-11-28 投票後、12-25 就任前，
-- 中選會名單上當選而任期表還沒有」的監測工具（見第二階段 A 的風險段）；2026 還沒投票，補結果的流程沒法驗證，所以先留著，
-- 投票結果補齊、gap 的 missing 只剩預期內的幾種之後再刪（另開 PR）。
--
-- 先決條件（這支假設已成立，PR 描述有逐項查證）：第二階段 A 已上線；沒有函式、視圖、前端、Edge Function 還讀舊欄位。
-- 部署順序：這支只動資料庫；舊欄位已經沒有程式在讀寫，所以 db push 先後都不會讓舊函式炸。

BEGIN;

-- ── ① 票數備份 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS politician_election_votes_archive (
  politician_election_id INTEGER PRIMARY KEY,
  politician_id UUID NOT NULL,
  election_id INTEGER NOT NULL,
  votes_received INTEGER,
  vote_percentage NUMERIC,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE politician_election_votes_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read access" ON politician_election_votes_archive;
CREATE POLICY "Public read access" ON politician_election_votes_archive FOR SELECT USING (true);
COMMENT ON TABLE politician_election_votes_archive IS '#345 第二階段 B（2026-10-07）：刪 politician_elections.votes_received／vote_percentage 之前的原樣備份（站上不顯示票數、協議不收）。沒有程式讀寫它；確定不需要就整張 DROP';

INSERT INTO politician_election_votes_archive (politician_election_id, politician_id, election_id, votes_received, vote_percentage)
SELECT pe.id, pe.politician_id, pe.election_id, pe.votes_received, pe.vote_percentage
  FROM politician_elections pe
 WHERE pe.votes_received IS NOT NULL OR pe.vote_percentage IS NOT NULL
ON CONFLICT (politician_election_id) DO NOTHING;

-- 刪之前的樣子（結尾比對用；temp 表隨連線結束消失）
CREATE TEMP TABLE _b345 AS
SELECT
  (SELECT count(*) FROM politician_elections WHERE votes_received IS NOT NULL OR vote_percentage IS NOT NULL) AS n_votes,
  (SELECT count(*) FROM elected_politicians) AS n_elected,
  (SELECT count(*) FROM politicians_with_elections) AS n_pwe,
  (SELECT md5(COALESCE(string_agg(w.id::text || '|' || w.election_ids::text || '|' || w.offices::text || '|'
                                  || COALESCE((SELECT jsonb_agg(e - 'candidateStatus' - 'electionResult' ORDER BY e::text)::text
                                                 FROM jsonb_array_elements(w.elections::jsonb) e), '[]'), ',' ORDER BY w.id), ''))
     FROM politicians_with_elections w) AS pwe_hash,
  (SELECT count(*) FROM politician_offices_derived) AS n_derived,
  (SELECT md5(COALESCE(string_agg(d::text, '|' ORDER BY d::text), '')) FROM politician_offices_derived d) AS derived_hash;

DO $$
DECLARE v_arch INTEGER; v_src INTEGER;
BEGIN
  SELECT count(*) INTO v_arch FROM politician_election_votes_archive;
  SELECT n_votes INTO v_src FROM _b345;
  IF v_arch < v_src THEN
    RAISE EXCEPTION '#345-B 票數備份少了：備份 % 筆、原表有票數的 % 筆，不刪', v_arch, v_src;
  END IF;
  RAISE NOTICE '#345-B 票數備份 % 筆（原表有票數的 % 筆）', v_arch, v_src;
END $$;

-- ── ② 視圖 ──────────────────────────────────────────────────
-- 人物視圖：elections[] 拿掉 candidateStatus／electionResult 兩個鍵。欄位清單與順序不變；其餘照 #344 第二階段 A（20261007030000）的最新版
-- （elections[]／offices[] 帶 electionDate、offices 依投票日排序）——以正式庫現行的定義為底，不是第二階段 A 的舊版。
-- offices 讀任期表（#345 第二階段：職稱改讀任期表）。CREATE OR REPLACE 會清掉 reloptions，security_invoker 要補回。
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
          WHERE (pe.politician_id = p.id)), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.sub_region
                    ELSE COALESCE(per.sub_region, r.sub_region, p.sub_region)
                END, 'village',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.village
                    ELSE COALESCE(per.village, r.village, p.village)
                END, 'sourceNote', pe.source_note, 'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing, 'electionDate', pee.election_date)) AS json_agg
           FROM ((politician_elections pe
             LEFT JOIN regions per ON ((pe.region_id = per.id)))
             LEFT JOIN elections pee ON ((pee.id = pe.election_id)))
          WHERE (pe.politician_id = p.id)), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', COALESCE(orr.region, p.region), 'subRegion', COALESCE(orr.sub_region, p.sub_region), 'village', COALESCE(orr.village, p.village), 'termEnd', o.scheduled_end_date, 'electionDate', oe.election_date) ORDER BY oe.election_date DESC, o.election_id DESC) AS json_agg
           FROM ((politician_offices o
             LEFT JOIN regions orr ON ((orr.id = o.region_id)))
             LEFT JOIN elections oe ON ((oe.id = o.election_id)))
          WHERE ((o.politician_id = p.id) AND (o.end_date IS NULL) AND (o.start_date <= CURRENT_DATE))), '[]'::json) AS offices
   FROM (politicians p
     LEFT JOIN regions r ON ((p.region_id = r.id)));
ALTER VIEW politicians_with_elections SET (security_invoker = on);

-- 當選者視圖：拿掉票數兩欄（欄位變少，要 DROP 重建；沒有別的視圖依賴它，2026-10-07 查 pg_depend）
DROP VIEW IF EXISTS elected_politicians;
CREATE VIEW elected_politicians AS
SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.avatar_url,
    p.region,
    p.sub_region,
    pe.election_id,
    pe."position",
    pe.election_type,
    e.name AS election_name,
    e.election_date
   FROM ((politicians p
     JOIN politician_elections pe ON ((p.id = pe.politician_id)))
     JOIN elections e ON ((pe.election_id = e.id)))
  WHERE (pe.candidacy_status = 'elected'::text);
ALTER VIEW elected_politicians SET (security_invoker = on);
GRANT SELECT ON elected_politicians TO anon, authenticated, service_role;

-- 舊的現任公職視圖：結果欄位改看 candidacy_status（election_result IS NULL ＝還沒有結果＝不是當選也不是落選）。
-- 對線上資料逐列比對（10-07 唯讀）：8,560 列、兩邊差集 0；結尾再核一次。
CREATE OR REPLACE VIEW politician_offices_derived AS
SELECT pe.politician_id,
    pe.id AS politician_election_id,
    pe.election_id,
    pe.election_type,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    office_term_start(pe.election_id, pe.election_type) AS term_start,
    office_term_end(pe.election_id, pe.election_type) AS term_end,
        CASE
            WHEN (pe.candidacy_status = 'elected'::text) THEN 'election_result'::text
            ELSE 'cec_candidates'::text
        END AS verified_by
   FROM ((politician_elections pe
     JOIN politicians p ON (((p.id = pe.politician_id) AND (p.merged_into IS NULL))))
     LEFT JOIN regions r ON ((r.id = pe.region_id)))
  WHERE ((office_term_start(pe.election_id, pe.election_type) <= CURRENT_DATE) AND (office_term_end(pe.election_id, pe.election_type) >= CURRENT_DATE) AND ((pe.candidacy_status = 'elected'::text) OR (((pe.candidacy_status IS NULL) OR (pe.candidacy_status <> ALL (ARRAY['elected'::text, 'not_elected'::text]))) AND ( SELECT ((count(*) = 1) AND bool_and(c.elected))
           FROM cec_candidates c
          WHERE ((c.election_id = pe.election_id) AND (c.election_type = pe.election_type) AND (c.name_norm = cec_name_norm(p.name)) AND (c.region = COALESCE(r.region, p.region)))))));
ALTER VIEW politician_offices_derived SET (security_invoker = on);
COMMENT ON VIEW politician_offices_derived IS '（#345 過渡）舊的現任公職視圖，原名 politician_offices：當場從我們標的當選＋中選會名單唯一對上算。網站職稱已改讀任期表 politician_offices（第二階段 A）；這個視圖只剩核對用，跟任期表的差異看 politician_offices_gap。2026 投票、結果補齊之後刪（另開 PR；第二階段 B 暫留，見 20261007140000 檔頭）';

-- ── ③ 觸發器與函式 ──────────────────────────────────────────
-- 任期觸發器：欄位清單拿掉 election_result（欄位要刪了；DROP COLUMN 會被這個依賴擋住）
DROP TRIGGER IF EXISTS trg_sync_politician_office ON politician_elections;
CREATE TRIGGER trg_sync_politician_office
  AFTER INSERT OR UPDATE OF candidacy_status, election_type, region_id, politician_id, election_id ON politician_elections
  FOR EACH ROW EXECUTE FUNCTION sync_politician_office_from_election();

-- 退選旗標：從 sync_candidacy_status 原樣搬出來（退選分兩種，#345 後續）。
-- 剛變成退選時看退選前的狀態（登記過 → true；考慮／表明／沒狀態 → false）；已經是退選、或新增的，保留寫入端給的值；不是退選就清成空。
CREATE OR REPLACE FUNCTION politician_elections_withdrawn_flag()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
COMMENT ON FUNCTION politician_elections_withdrawn_flag IS '退選旗標 withdrawn_after_filing 的維護：剛變成退選時看退選前的狀態、不是退選就清成空（CHECK politician_elections_withdrawn_after_filing_check 要求只有退選才能有值）。#345 第二階段 B（2026-10-07）從 sync_candidacy_status 原樣搬出';

-- 觸發順序：舊的 sync_candidacy_status 是 BEFORE INSERT OR UPDATE OF candidate_status, election_result, candidacy_status；
-- 新的只聽 candidacy_status（候選欄位沒了）。先建新的、再刪舊的，同一個交易裡沒有空窗。
CREATE TRIGGER trg_politician_elections_withdrawn_flag
  BEFORE INSERT OR UPDATE OF candidacy_status ON politician_elections
  FOR EACH ROW EXECUTE FUNCTION politician_elections_withdrawn_flag();

DROP TRIGGER IF EXISTS trg_sync_candidacy_status ON politician_elections;
DROP FUNCTION IF EXISTS sync_candidacy_status();
DROP FUNCTION IF EXISTS legacy_status_from_candidacy(TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS candidacy_status_from_legacy(TEXT, TEXT, BOOLEAN);

-- 人物最新一屆：輸出欄 candidate_status（交件協議的詞）改成 candidacy_status（資料庫的值）。簽名變了，DROP 重建。
-- 排序照 #344 第二階段 A（20261007030000）的最新版：看投票日（election_date），不看 election_id。
-- 呼叫它的 sync_politician_latest_election() 與回填只用 position／slogan／election_type／region_id。
DROP FUNCTION IF EXISTS politician_latest_election(UUID);
CREATE FUNCTION politician_latest_election(p_politician_id UUID)
RETURNS TABLE(election_id INTEGER, candidacy_status TEXT, "position" TEXT, slogan TEXT, election_type TEXT, region_id INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT pe.election_id, pe.candidacy_status, pe."position", pe.slogan, pe.election_type, pe.region_id
    FROM politician_elections pe
    JOIN elections e ON e.id = pe.election_id
   WHERE pe.politician_id = p_politician_id
   ORDER BY (COALESCE(pe.candidacy_status, '') = 'withdrawn'), e.election_date DESC, pe.election_id DESC
   LIMIT 1
$$;
COMMENT ON FUNCTION politician_latest_election IS '人物的「最新一屆」：最近一屆有在選的參選紀錄（表態不參選排最後，全部都是表態不參選才用最近一筆）。politicians 的 position／slogan／election_type／region_id 由它衍生（trg_sync_politician_latest），2026-10-05｜#345 第二階段 B（2026-10-07）：輸出欄 candidate_status 改成 candidacy_status（資料庫的值，不再換成協議的詞）';
GRANT EXECUTE ON FUNCTION politician_latest_election(UUID) TO anon, authenticated, service_role;

-- ── ④ 刪欄位 ────────────────────────────────────────────────
-- CHECK（politician_elections_candidate_status_check、politician_elections_election_result_check）、預設值 rumored、
-- 索引 idx_politician_elections_result 跟著欄位一起消失
ALTER TABLE politician_elections
  DROP COLUMN candidate_status,
  DROP COLUMN election_result,
  DROP COLUMN votes_received,
  DROP COLUMN vote_percentage;

-- ── ⑤ 結尾自檢（對不上整支退回）─────────────────────────────
DO $$
DECLARE
  b _b345%ROWTYPE;
  v_n INTEGER;
  v_hash TEXT;
  v_bad TEXT;
BEGIN
  SELECT * INTO b FROM _b345;

  -- 四欄都不在了
  SELECT string_agg(column_name, '、') INTO v_bad FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'politician_elections'
     AND column_name IN ('candidate_status', 'election_result', 'votes_received', 'vote_percentage');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '#345-B 這些欄位還在：%', v_bad; END IF;
  -- 同步觸發器與函式都不在了
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.politician_elections'::regclass AND tgname = 'trg_sync_candidacy_status') THEN
    RAISE EXCEPTION '#345-B trg_sync_candidacy_status 還在';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('sync_candidacy_status', 'candidacy_status_from_legacy', 'legacy_status_from_candidacy')) THEN
    RAISE EXCEPTION '#345-B 舊的同步函式還在';
  END IF;
  -- 退選旗標觸發器在
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.politician_elections'::regclass AND tgname = 'trg_politician_elections_withdrawn_flag') THEN
    RAISE EXCEPTION '#345-B 退選旗標觸發器不在';
  END IF;
  -- 任期觸發器在、欄位清單沒有已刪的欄位、有 candidacy_status
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.politician_elections'::regclass AND tgname = 'trg_sync_politician_office'
                    AND pg_get_triggerdef(oid) LIKE '%UPDATE OF candidacy_status,%') THEN
    RAISE EXCEPTION '#345-B 任期觸發器的欄位清單不對';
  END IF;

  -- 視圖內容跟刪之前一致
  SELECT count(*) INTO v_n FROM elected_politicians;
  IF v_n <> b.n_elected THEN RAISE EXCEPTION '#345-B elected_politicians 筆數變了：% → %', b.n_elected, v_n; END IF;
  SELECT count(*) INTO v_n FROM politicians_with_elections;
  IF v_n <> b.n_pwe THEN RAISE EXCEPTION '#345-B politicians_with_elections 筆數變了：% → %', b.n_pwe, v_n; END IF;
  SELECT md5(COALESCE(string_agg(w.id::text || '|' || w.election_ids::text || '|' || w.offices::text || '|'
                                 || COALESCE((SELECT jsonb_agg(e ORDER BY e::text)::text FROM jsonb_array_elements(w.elections::jsonb) e), '[]'), ',' ORDER BY w.id), ''))
    INTO v_hash FROM politicians_with_elections w;
  IF v_hash <> b.pwe_hash THEN RAISE EXCEPTION '#345-B politicians_with_elections 內容變了（拿掉兩個鍵以外的東西也變了）'; END IF;
  SELECT count(*), md5(COALESCE(string_agg(d::text, '|' ORDER BY d::text), '')) INTO v_n, v_hash FROM politician_offices_derived d;
  IF v_n <> b.n_derived OR v_hash <> b.derived_hash THEN
    RAISE EXCEPTION '#345-B politician_offices_derived 內容變了：% 列 → % 列', b.n_derived, v_n;
  END IF;

  -- 授權
  IF NOT has_table_privilege('anon', 'public.elected_politicians', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.elected_politicians', 'SELECT')
     OR NOT has_function_privilege('anon', 'public.politician_latest_election(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '#345-B 授權沒補回來';
  END IF;
  IF (SELECT c.reloptions::text FROM pg_class c WHERE c.oid = 'public.elected_politicians'::regclass) IS DISTINCT FROM '{security_invoker=on}'
     OR (SELECT c.reloptions::text FROM pg_class c WHERE c.oid = 'public.politicians_with_elections'::regclass) IS DISTINCT FROM '{security_invoker=on}'
     OR (SELECT c.reloptions::text FROM pg_class c WHERE c.oid = 'public.politician_offices_derived'::regclass) IS DISTINCT FROM '{security_invoker=on}' THEN
    RAISE EXCEPTION '#345-B 視圖的 security_invoker 沒補回來';
  END IF;

  RAISE NOTICE '#345-B 完成：四欄已刪、備份 % 筆票數、當選者 % 位、人物視圖 % 位、舊現任視圖 % 列，內容與刪之前一致', b.n_votes, b.n_elected, b.n_pwe, b.n_derived;
END $$;

DROP TABLE _b345;

COMMIT;
