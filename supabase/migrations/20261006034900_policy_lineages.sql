-- 政策脈絡（issue #349 第一階段；維護者 2026-10-05 點頭：名稱「政策脈絡」，網站簡稱「脈絡」）
-- ============================================================
--
-- 一條脈絡＝一件事在某一層級、某一地方的來龍去脈。比照日本站（keifu SCHEMA 的 lineages／handovers），多兩個方向：
--   前後任（時間）：脈絡內的交接紀錄 handovers——接手 keep／轉向 pivot／縮小 shrink／中止 stop／重新開始 resume（與日本站同值）
--   同級多人：脈絡內的參與者 lineage_participants——人＋角色（提案／共同提案／連署／主張推動）＋出處
--   上下級：不同的脈絡互相關聯 lineage_links——上級立法或補助 → 下級執行（top_down）；下級爭取 → 上級採納（bottom_up）
-- 政見掛到脈絡：policies.lineage_id（可 null）；政見從哪裡來：policies.origin（照日本站 policy_origin：
--   pledge 競選承諾／policy_address 施政報告／assembly 議會提案／budget 預算）。
--
-- 裁決（issue #349、docs/DECISIONS.md 2026-10-05／10-06）：
--   - 角色以官方紀錄為準（立法院議事系統、議會網站等打得開的頁面）：basis='official_record' 的出處要是官方網址（交件端擋）；
--     本人自述只標 basis='self_claim'（「本人宣稱」），不當作主導的證據；臉書讀不到不收（交件端擋）。
--   - 「中止」交接要較高票數：比照 merge_politician 的兩台機器規則（contribution_needs_two_ips，見下）；其他交接型別一般門檻。
--     **不動計分**：分數、目標、退件門檻都沒改，只把既有的「兩台機器」規則套到 handover_type=stop 這一種。
--   - 取代 related_policies 互指（線上 0 列、沒有任何寫入者）。第一階段只加不刪：related_policies 與前端讀它的地方都留著，
--     第二階段讀取端全部改讀脈絡之後才刪。
--   - 資料一律走流程（10-05 常設裁決）：這支 migration 不寫任何一條脈絡、參與者、交接或關聯，只加表與派工臂。
--     唯一寫入的是 policies.origin 的回填：status='Campaign Pledge' 的照字面填 'pledge'（同一欄位的機械對應，不是新的判斷）。
--
-- 派工（候選怎麼找，見 PR 說明的取捨）：
--   1. lineage_candidate：同一層級、同一地方、同一類別的政見放成一組（「格」），整份交給代理判斷哪些是同一件事——
--      純字元相似度太不靈敏（#331 S0：明顯同議題常低於 0.2；政見重複清查 20260921000004 量過真重複 0.021、假配對 0.026），
--      跟政見重複清查同一個做法：系統負責分組與排程，代理負責判斷。格的指紋＝政見 id＋內容雜湊；
--      回報「沒有同一件事」（no_change confirmed）或交上一條脈絡並落庫後，這一格同一份清單不再派，清單變了才再派。
--      範圍照三要素：還沒投票的屆別看在選者、已投票的屆別看當選者。10-06 唯讀實查：縣市 140 格、中央 11 格，共約 151 件。
--   2. handover_missing：脈絡裡有某位首長那一任的政見，而那個職位之後換了人、前任任期已結束，脈絡裡卻沒有這兩人之間的交接 →
--      記交接。上線當下 0 件（2022 那屆的首長 2026-12-24 才卸任；2018 以前的任期不在資料庫裡）。
--   3. lineage_roles_missing：脈絡裡有現任或前任民意代表（立委、議員、代表）的政見，卻沒有他的參與角色 → 照官方紀錄標角色。
--   4. lineage_link_candidate：同類別、上一層級（縣市的上一層是中央；鄉鎮的上一層是同縣市）的脈絡還沒有關聯 → 判斷有沒有上下級關係。
--   2～4 上線當下 0 件（還沒有任何脈絡），脈絡上線後才會出現。

-- 引用到的既有欄位與函式（10-06 唯讀查詢確認存在）：
--   policies(id, title, description, category, status, politician_id, election_id, removed_at)、
--   politicians(id, name, region, merged_into)、politician_elections(politician_id, election_id, election_type,
--   candidate_status, election_result, region_id)、elections(id, election_date)、regions(id, region, sub_region, admin_code)、
--   admin_divisions(code)、categories(name)、contributions(id, contribution_type, status, payload, task_id, score, target_score, voter_ips,
--   batch_verified_by, ...)、source_refs(source_id, target_table, target_id, role, origin)、sources(id, url, title, publisher,
--   source_kind, archive_url)、source_upsert(text, text, text, text, date, timestamptz)、office_term_end(integer, text)、
--   contribution_effective_agree(uuid)、contribution_reject_floor(text)、contribution_roster_matched(uuid)、
--   contribution_vote_weight(text, boolean)、contribution_auto_tasks(...)、contribution_subject_politician(jsonb)、uuid_or_null(text)
--   politician_offices(id, politician_id, election_id)：任期表由 20261006034510（#345）建；10-06 查遠端時那支還沒部署
--   （遠端的 politician_offices 還是舊視圖），欄位照該 migration 的 CREATE TABLE。這支的時間戳排在它後面。

-- ------------------------------------------------------------
-- 1. 脈絡 lineages
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  summary         TEXT,
  -- 跟 policies.category 同一個外鍵（分類改名時一起改）
  category        TEXT REFERENCES categories(name) ON UPDATE CASCADE,
  level           TEXT NOT NULL CHECK (level IN ('national', 'county', 'township')),
  region          TEXT,
  sub_region      TEXT,
  admin_code      TEXT REFERENCES admin_divisions(code),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 字數跟 _shared/lineage.ts 的 LINEAGE_TITLE_MIN／MAX、LINEAGE_SUMMARY_MAX 同一組數字（lineage.test.ts 盯著）
  CONSTRAINT lineages_title_len CHECK (char_length(btrim(title)) BETWEEN 4 AND 60),
  CONSTRAINT lineages_summary_len CHECK (summary IS NULL OR char_length(btrim(summary)) BETWEEN 1 AND 200),
  -- 層級與地方要對得上：中央沒有地方；縣市要有縣市與 5 碼代碼；鄉鎮要有縣市、鄉鎮與 8 碼代碼（內政部官方代碼，#348）。
  -- admin_code 要明寫 IS NOT NULL：NULL ~ '…' 是 NULL，整個 CHECK 會被當成通過（PGlite 實跑抓到）
  CONSTRAINT lineages_place CHECK (
       (level = 'national' AND region IS NULL AND sub_region IS NULL AND admin_code IS NULL)
    OR (level = 'county'   AND region IS NOT NULL AND sub_region IS NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{5}$')
    OR (level = 'township' AND region IS NOT NULL AND sub_region IS NOT NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{8}$')
  )
);
-- 同一層級、同一地方不會有兩條同名的脈絡（同一件事被建兩次時第二筆落庫會失敗，回覆會叫代理歸入既有那條）
CREATE UNIQUE INDEX IF NOT EXISTS lineages_same_title_same_place ON lineages (level, COALESCE(admin_code, ''), lower(btrim(title)));
CREATE INDEX IF NOT EXISTS idx_lineages_place ON lineages (level, region, sub_region);

COMMENT ON TABLE lineages IS
  '政策脈絡（#349，比照日本站 keifu lineages）：一件事在某一層級、某一地方的來龍去脈。政見以 policies.lineage_id 掛上來；'
  '前後任看 handovers、同級多人看 lineage_participants、上下級看 lineage_links。資料一律走派工與同儕驗證';
COMMENT ON COLUMN lineages.title IS '這件事的名稱（4～60 字，中性、照事實，例：「國定假日法制化（增加 4＋1 天）」「台中捷運藍線」）';
COMMENT ON COLUMN lineages.summary IS '一兩句話講這件事是什麼（200 字內，只寫事實、不評價）';
COMMENT ON COLUMN lineages.category IS '政見分類（categories.name 的 19 個正式名稱之一）';
COMMENT ON COLUMN lineages.level IS 'national 中央／county 縣市／township 鄉鎮市區：這件事在哪一級政府決定、執行';
COMMENT ON COLUMN lineages.region IS '縣市（網站寫法「台」，中央為 NULL）';
COMMENT ON COLUMN lineages.sub_region IS '鄉鎮市區（只有 township 層級有）';
COMMENT ON COLUMN lineages.admin_code IS '內政部官方行政區代碼（縣市 5 碼、鄉鎮 8 碼；#348 admin_divisions），對應日本站的 lg_code';

ALTER TABLE lineages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineages;
CREATE POLICY "Public read" ON lineages FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineages;
CREATE POLICY "Service role write" ON lineages FOR ALL USING (auth.role() = 'service_role');

-- updated_at：四張表共用一支
CREATE OR REPLACE FUNCTION lineage_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineages_touch ON lineages;
CREATE TRIGGER trg_lineages_touch BEFORE UPDATE ON lineages FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- ------------------------------------------------------------
-- 2. 政見掛到脈絡、政見從哪裡來（只加欄位；policies 的 updated_at 觸發器只看內容欄位，這兩欄不會讓「最近更新」跳動）
-- ------------------------------------------------------------
ALTER TABLE policies ADD COLUMN IF NOT EXISTS lineage_id UUID REFERENCES lineages(id) ON DELETE SET NULL;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_origin_check;
ALTER TABLE policies ADD CONSTRAINT policies_origin_check
  CHECK (origin IS NULL OR origin IN ('pledge', 'policy_address', 'assembly', 'budget'));
CREATE INDEX IF NOT EXISTS idx_policies_lineage ON policies (lineage_id) WHERE lineage_id IS NOT NULL;
COMMENT ON COLUMN policies.lineage_id IS '屬於哪條政策脈絡（#349；可 null＝還沒歸入）。只由 lineage 貢獻寫入';
COMMENT ON COLUMN policies.origin IS
  '政見從哪裡來（#349，照日本站 policy_origin）：pledge 競選承諾／policy_address 施政報告／assembly 議會提案／budget 預算。'
  'NULL＝還沒標。status 的 Campaign Pledge 是「來源」不是「進度」，第二階段 status 只留進度';

-- 回填：status 字面就是「競選承諾」的，來源就是 pledge（同一個欄位的機械對應）。其他狀態（推動中、已實現…）
-- 看不出原本是競選承諾還是任內施政，留 NULL，走 policy／correction 交件補。
UPDATE policies SET origin = 'pledge' WHERE origin IS NULL AND status::TEXT = 'Campaign Pledge';

-- 之後新增的競選承諾自動標 pledge（同一條對應；交件有給 origin 的照交件）
CREATE OR REPLACE FUNCTION policies_default_origin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin IS NULL AND NEW.status::TEXT = 'Campaign Pledge' THEN NEW.origin := 'pledge'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_policies_default_origin ON policies;
CREATE TRIGGER trg_policies_default_origin BEFORE INSERT ON policies FOR EACH ROW EXECUTE FUNCTION policies_default_origin();

-- ------------------------------------------------------------
-- 3. 脈絡內的參與者 lineage_participants（同級多人：人＋角色＋出處）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id      UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  politician_id   UUID NOT NULL REFERENCES politicians(id),
  role            TEXT NOT NULL CHECK (role IN ('proposer', 'co_proposer', 'cosigner', 'advocate')),
  basis           TEXT NOT NULL CHECK (basis IN ('official_record', 'self_claim')),
  source_url      TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator  TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  note            TEXT CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 200),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 一個人在一條脈絡裡：官方紀錄一個角色、本人宣稱一個角色（兩者不同時並列，畫面才看得出「本人說是提案，紀錄是共同提案」）
  CONSTRAINT lineage_participants_one_per_basis UNIQUE (lineage_id, politician_id, basis)
);
CREATE INDEX IF NOT EXISTS idx_lineage_participants_politician ON lineage_participants (politician_id);
COMMENT ON TABLE lineage_participants IS
  '脈絡內的參與者（#349）：誰在這件事裡、什麼角色、依據什麼。角色以官方紀錄為準（basis=official_record，出處要是官方網址）；'
  '本人自述只標「本人宣稱」（basis=self_claim），不當作主導的證據；臉書讀不到不收。人物合併後讀取端用 merged_into 對到保留的那位';
COMMENT ON COLUMN lineage_participants.role IS 'proposer 提案／co_proposer 共同提案／cosigner 連署／advocate 主張推動';
COMMENT ON COLUMN lineage_participants.basis IS 'official_record 官方紀錄（立法院議事系統、議會網站…）／self_claim 本人宣稱';
COMMENT ON COLUMN lineage_participants.source_locator IS '在出處的哪裡（議案編號、關係文書第幾頁、會議紀錄日期與案由）';
ALTER TABLE lineage_participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_participants;
CREATE POLICY "Public read" ON lineage_participants FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineage_participants;
CREATE POLICY "Service role write" ON lineage_participants FOR ALL USING (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_lineage_participants_touch ON lineage_participants;
CREATE TRIGGER trg_lineage_participants_touch BEFORE UPDATE ON lineage_participants FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- ------------------------------------------------------------
-- 4. 交接 handovers（前後任：脈絡內、從哪一任交到哪一任）
-- 一任用「人物＋那一屆」表示（交件與派工都用這兩個，那一屆不在資料庫裡〔2018 以前〕時屆別留空）。
-- 日本站用任期（from_office_id／to_office_id）；正見的任期表 politician_offices（#345，20261006034510）已上線，
-- 但第一階段網站職稱還沒切過去、新當選者要走流程才有列，所以任期編號不由交件給，由觸發器照「人物＋那一屆」對上：
-- 剛好一列才填，對不到（那一屆不在資料庫、還沒有任期列）或對到不只一列就留空。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handovers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id         UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  from_politician_id UUID NOT NULL REFERENCES politicians(id),
  from_election_id   INTEGER REFERENCES elections(id),
  to_politician_id   UUID NOT NULL REFERENCES politicians(id),
  to_election_id     INTEGER REFERENCES elections(id),
  -- 那一任在任期表的哪一列（觸發器 handovers_fill_office 填，見上）
  from_office_id     BIGINT REFERENCES politician_offices(id) ON DELETE SET NULL,
  to_office_id       BIGINT REFERENCES politician_offices(id) ON DELETE SET NULL,
  handover_type      TEXT NOT NULL CHECK (handover_type IN ('keep', 'pivot', 'shrink', 'stop', 'resume')),
  decided_on         DATE,
  note               TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 20 AND 500),
  source_url         TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator     TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  contribution_id    UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 前後兩任要不一樣：不同人，或同一人的不同屆
  CONSTRAINT handovers_distinct_terms CHECK (from_politician_id <> to_politician_id OR from_election_id IS DISTINCT FROM to_election_id),
  -- 同一條脈絡裡同一對任期只有一筆交接（重交＝覆蓋）
  CONSTRAINT handovers_one_per_pair UNIQUE NULLS NOT DISTINCT (lineage_id, from_politician_id, from_election_id, to_politician_id, to_election_id)
);
CREATE INDEX IF NOT EXISTS idx_handovers_lineage ON handovers (lineage_id);
COMMENT ON TABLE handovers IS
  '交接（#349，比照日本站 keifu handovers，交接型態同值）：脈絡裡從前一任到下一任，這件事怎麼被處理。'
  '跟政見進度分工：policies.status 是這條政見本身的進度，handover_type 是換任時這件事怎麼被處理';
COMMENT ON COLUMN handovers.handover_type IS
  'keep 接手（原樣延續）／pivot 轉向（目的不變、做法變了）／shrink 縮小（規模或預算縮水但沒停）／stop 中止（下一任停掉；要兩台機器）／resume 重新開始（曾經中止又重啟）';
COMMENT ON COLUMN handovers.decided_on IS '判定依據的日期（例：預算刪除、議會決議、宣布停工的日子）；不知道就空';
COMMENT ON COLUMN handovers.from_election_id IS '前一任是哪一屆選出的；那一屆不在資料庫（2018 以前）時為空';
COMMENT ON COLUMN handovers.from_office_id IS '前一任在任期表 politician_offices 的哪一列；觸發器照人物＋那一屆對上，剛好一列才填';
COMMENT ON COLUMN handovers.to_office_id IS '後一任在任期表 politician_offices 的哪一列；觸發器照人物＋那一屆對上，剛好一列才填';

-- 人物＋那一屆 → 任期表的那一列（剛好一列才回，其他回空）
CREATE OR REPLACE FUNCTION handover_office_of(p_politician_id UUID, p_election_id INTEGER)
RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(o.id) END
    FROM politician_offices o
   WHERE p_election_id IS NOT NULL
     AND o.politician_id = p_politician_id AND o.election_id = p_election_id
$$;
CREATE OR REPLACE FUNCTION handovers_fill_office()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.from_office_id := handover_office_of(NEW.from_politician_id, NEW.from_election_id);
  NEW.to_office_id := handover_office_of(NEW.to_politician_id, NEW.to_election_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_handovers_fill_office ON handovers;
CREATE TRIGGER trg_handovers_fill_office
  BEFORE INSERT OR UPDATE OF from_politician_id, from_election_id, to_politician_id, to_election_id ON handovers
  FOR EACH ROW EXECUTE FUNCTION handovers_fill_office();

ALTER TABLE handovers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON handovers;
CREATE POLICY "Public read" ON handovers FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON handovers;
CREATE POLICY "Service role write" ON handovers FOR ALL USING (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_handovers_touch ON handovers;
CREATE TRIGGER trg_handovers_touch BEFORE UPDATE ON handovers FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- ------------------------------------------------------------
-- 5. 脈絡之間的關聯 lineage_links（上下級：不同脈絡互相關聯）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upper_lineage_id UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  lower_lineage_id UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  link_type        TEXT NOT NULL CHECK (link_type IN ('top_down', 'bottom_up')),
  note             TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 20 AND 500),
  source_url       TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator   TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  contribution_id  UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lineage_links_not_self CHECK (upper_lineage_id <> lower_lineage_id),
  CONSTRAINT lineage_links_one_per_pair UNIQUE (upper_lineage_id, lower_lineage_id)
);
CREATE INDEX IF NOT EXISTS idx_lineage_links_lower ON lineage_links (lower_lineage_id);
COMMENT ON TABLE lineage_links IS
  '脈絡之間的上下級關聯（#349）：upper 是上一級（中央之於縣市、縣市之於同縣市的鄉鎮），lower 是下一級。'
  'top_down＝上級立法或補助 → 下級執行；bottom_up＝下級爭取 → 上級採納。層級高低由落庫檢查（_shared/lineage.ts 的 linkLevelProblem）';

-- 上級要真的在上一級：中央 → 縣市；縣市 → 同縣市的鄉鎮（中央 → 鄉鎮跳一級也收，鄉鎮公所直接執行中央補助的情況）
CREATE OR REPLACE FUNCTION lineage_links_check_levels() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE u lineages%ROWTYPE; d lineages%ROWTYPE;
BEGIN
  SELECT * INTO u FROM lineages WHERE id = NEW.upper_lineage_id;
  SELECT * INTO d FROM lineages WHERE id = NEW.lower_lineage_id;
  IF NOT ((u.level = 'national' AND d.level IN ('county', 'township'))
       OR (u.level = 'county' AND d.level = 'township' AND u.region = d.region)) THEN
    RAISE EXCEPTION 'lineage_links：上級（%／%）不在下級（%／%）的上一層', u.level, COALESCE(u.region, '全國'), d.level, COALESCE(d.region, '全國');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineage_links_levels ON lineage_links;
CREATE TRIGGER trg_lineage_links_levels BEFORE INSERT OR UPDATE OF upper_lineage_id, lower_lineage_id ON lineage_links
  FOR EACH ROW EXECUTE FUNCTION lineage_links_check_levels();

ALTER TABLE lineage_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_links;
CREATE POLICY "Public read" ON lineage_links FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineage_links;
CREATE POLICY "Service role write" ON lineage_links FOR ALL USING (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_lineage_links_touch ON lineage_links;
CREATE TRIGGER trg_lineage_links_touch BEFORE UPDATE ON lineage_links FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- ------------------------------------------------------------
-- 6. 候選清查的結論 lineage_candidate_reviews（同 policy_dupe_reviews：同一份清單查過就不再派）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_candidate_reviews (
  -- id 是查核履歷的紀錄鍵：整筆還原時 executeRevert 用 .eq("id", record_id) 刪這一列
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_key      TEXT NOT NULL UNIQUE,
  fingerprint     TEXT NOT NULL,
  agent_name      TEXT,
  contribution_id UUID,
  note            TEXT,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE lineage_candidate_reviews IS
  '脈絡候選的清查結論（#349）：review_key＝block:<格>（同一層級同一地方同一類別的政見）或 link:<脈絡 id>（上下級候選）；'
  'fingerprint 是當時那份清單的指紋。查過（no_change confirmed，或交了脈絡／關聯並落庫）就記一列，清單沒變就不再派';
ALTER TABLE lineage_candidate_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_candidate_reviews;
CREATE POLICY "Public read" ON lineage_candidate_reviews FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineage_candidate_reviews;
CREATE POLICY "Service role write" ON lineage_candidate_reviews FOR ALL USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 7. 出處：參與者、交接、關聯的 source_url 同步成 source_refs（只加不刪；做法同 policy_elements：寫不進出處表就讓落庫失敗）
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements', 'lineage_participants', 'handovers', 'lineage_links'));

CREATE OR REPLACE FUNCTION lineage_rows_sync_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sid BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_url IS NOT DISTINCT FROM OLD.source_url THEN RETURN NEW; END IF;
  v_sid := source_upsert(NEW.source_url, TG_TABLE_NAME || '.source_url', NULL, NULL, NULL, now());
  IF v_sid IS NULL THEN
    RAISE EXCEPTION 'lineage_rows_sync_source(%.%): 出處網址寫不進 sources：%', TG_TABLE_NAME, NEW.id, NEW.source_url;
  END IF;
  DELETE FROM source_refs
   WHERE target_table = TG_TABLE_NAME AND target_id = NEW.id::text AND role = 'primary' AND source_id <> v_sid;
  INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
  VALUES (v_sid, TG_TABLE_NAME, NEW.id::text, 'primary', TG_TABLE_NAME || '.source_url')
  ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION lineage_rows_drop_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM source_refs WHERE target_table = TG_TABLE_NAME AND target_id = OLD.id::text;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineage_participants_sync_source ON lineage_participants;
CREATE TRIGGER trg_lineage_participants_sync_source AFTER INSERT OR UPDATE OF source_url ON lineage_participants
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_lineage_participants_drop_refs ON lineage_participants;
CREATE TRIGGER trg_lineage_participants_drop_refs AFTER DELETE ON lineage_participants
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();
DROP TRIGGER IF EXISTS trg_handovers_sync_source ON handovers;
CREATE TRIGGER trg_handovers_sync_source AFTER INSERT OR UPDATE OF source_url ON handovers
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_handovers_drop_refs ON handovers;
CREATE TRIGGER trg_handovers_drop_refs AFTER DELETE ON handovers
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();
DROP TRIGGER IF EXISTS trg_lineage_links_sync_source ON lineage_links;
CREATE TRIGGER trg_lineage_links_sync_source AFTER INSERT OR UPDATE OF source_url ON lineage_links
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_lineage_links_drop_refs ON lineage_links;
CREATE TRIGGER trg_lineage_links_drop_refs AFTER DELETE ON lineage_links
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();

-- 一筆出處的簡要（網址、標題、發布者、等級、存檔），讀取視圖共用
CREATE OR REPLACE FUNCTION source_brief(p_table TEXT, p_id TEXT) RETURNS JSON
LANGUAGE sql STABLE AS $$
  SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher, 'kind', s.source_kind, 'archive_url', s.archive_url)
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = p_table AND r.target_id = p_id AND r.role = 'primary'
   LIMIT 1
$$;

-- ------------------------------------------------------------
-- 8. 貢獻型別：lineage（建立／歸入脈絡）、lineage_participants（標參與角色）、lineage_handover（記交接）、lineage_link（記脈絡關聯）
--    DB CHECK、TS CONTRIBUTION_TYPES、skill.md、標籤四處一起加（thresholds.test 盯 CHECK 與 TS 一致）
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link'));

-- 票數預算影子模式（只記錄、不套用門檻）的候選加這四種：vote-budget.test 規定每一種貢獻型別都要有風險維度，
-- vote-budget-cron.test 規定候選清單＝有維度的型別。本體照抄 20261005005640（#364），只在清單尾端加四種。影子模式不影響計分。
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

-- ------------------------------------------------------------
-- 9. 「中止」交接要兩台機器：既有的兩台機器規則（merge_politician／candidacy／removal）抽成一支，加上 handover_type=stop
--    TS 鏡像：_shared/consensus.ts 的 needsTwoIps（SCORE_TWO_IP_TYPES＋同一個條件），lineage.test.ts 盯兩邊。
--    分數、目標、退件門檻一律不動——這裡只決定「分數到了之後，要不要至少兩台不同機器投過」。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('merge_politician', 'candidacy', 'removal')
      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')
$$;
COMMENT ON FUNCTION contribution_needs_two_ips IS
  '分數不得由單一來源 IP 湊足的貢獻：同名合併、加減參選人、移除，以及「中止」交接（#349，維護者 10-05：中止要較高票數，比照 merge_politician）';

-- 計票：同 20261001000001，只把「高風險型別要兩台機器」的型別清單換成 contribution_needs_two_ips（多看 payload）
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個來源 IP 只算最新那一票（沿用「代理票依來源 IP 去重」的精神）
  WITH latest AS (
    SELECT DISTINCT ON (verifier_ip_hash) verifier_ip_hash, verdict, COALESCE(weight, contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM contribution_votes WHERE contribution_id = p_contribution_id
    ORDER BY verifier_ip_hash, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM contributions WHERE id = p_contribution_id;
  v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);
  v_reject := contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_score >= v_target
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多。
      -- 名冊逐位吻合的例外（2026-10-01）：系統已逐位核過中選會名冊，就是另一雙眼睛
      AND (NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)) THEN
      v_new := 'verified';
    ELSIF (SELECT batch_verified_by FROM contributions WHERE id = p_contribution_id) IS NOT NULL THEN
      -- 隨名冊整批驗證通過（2026-09-24）：系統逐位核對過、名冊那筆也過了，不再逐筆湊票
      v_new := 'verified';
    ELSE
      v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    score = v_score,
    target_score = v_target,
    voter_ips = v_ips,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 驗證池：同 20261002000007，只把兩處型別清單換成 contribution_needs_two_ips
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
                   AND contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) END AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            o.contributor_ip_hash = p_ip_hash
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND v2.verifier_ip_hash = p_ip_hash
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。'
  '2026-10-02。2026-10-06（#349）兩台機器的型別改看 contribution_needs_two_ips（多了「中止」交接）。';

-- 派工佇列預覽（/queue）：同 20260924000004，只把型別清單換成 contribution_needs_two_ips
CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           g.target->>'region' AS region, g.queue_at, 2 AS tie
      FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL) g
    UNION ALL
    SELECT 'task', t.id::TEXT, t.task_type, t.title, t.region,
           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END), 1
      FROM contribution_tasks t
     WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify', 'verify:' || v.id, v.contribution_type,
           COALESCE(NULLIF(v.payload->>'name', ''),
                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(v.payload)),
                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(v.payload->>'policy_id')),
                    NULLIF(v.payload->>'title', ''), ''),
           COALESCE(v.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(v.payload))),
           COALESCE(d.queue_at, v.created_at), 0
      FROM contributions v
      LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || v.id
     WHERE v.status = 'pending'
       -- 跟驗證池同一條可派條件（分數未達標，或高風險型別還不到兩台機器）；不用驗證池本身，因為它一次最多回 200 筆
       AND (v.score < COALESCE(v.target_score, contribution_effective_agree(v.id))
            OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2))
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.tie, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.tie, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，進表時已按驗證：任務 2:1 排好）';

-- ------------------------------------------------------------
-- 10. 讀取：policies_with_logs 多 lineage（政見頁「所屬脈絡」）；lineages_full（脈絡頁、脈絡一覽）
-- policies 多了兩欄，p.* 會把它們插在 logs 前面，CREATE OR REPLACE 不行，照 20260921000028 的做法重建
-- （沒有別的視圖依賴它，10-06 pg_depend 查過）。前面 p.*、logs、related_policy_ids、elements 與 20261005005640 一字不差。
-- 之後要改這個視圖：policies 沒加欄位就 CREATE OR REPLACE，新欄位一律接在 lineage 後面。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS policies_with_logs;
CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description)
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'element', e.element, 'stated', e.stated, 'text', e.text, 'deadline_date', e.deadline_date,
        'source_locator', e.source_locator, 'source_url', e.source_url, 'updated_at', e.updated_at,
        'source', (SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher,
                                            'kind', s.source_kind, 'archive_url', s.archive_url)
                     FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policy_elements' AND r.target_id = e.id::text AND r.role = 'primary'
                    LIMIT 1)
      )
      ORDER BY array_position(ARRAY['target', 'deadline', 'funding'], e.element)
    )
    FROM policy_elements e
    WHERE e.policy_id = p.id),
    '[]'::json
  ) AS elements,
  (SELECT json_build_object('id', l.id, 'title', l.title, 'level', l.level, 'region', l.region, 'sub_region', l.sub_region,
                            'category', l.category, 'summary', l.summary)
     FROM lineages l WHERE l.id = p.lineage_id) AS lineage
FROM policies p;

-- 以呼叫者身分執行，底層表的 RLS 才會生效（見 20260912000016）；重建後權限照給
ALTER VIEW policies_with_logs SET (security_invoker = on);
GRANT SELECT ON policies_with_logs TO anon, authenticated;

-- 一條脈絡一列：政見 id（照投票日排）、參與者、交接、上下級關聯，每一筆帶自己的出處。人物合併後指到保留的那位
CREATE OR REPLACE VIEW lineages_full AS
SELECT
  l.id, l.title, l.summary, l.category, l.level, l.region, l.sub_region, l.admin_code, l.created_at, l.updated_at,
  COALESCE(
    (SELECT json_agg(pl.id ORDER BY e.election_date NULLS LAST, pl.proposed_date NULLS LAST, pl.id)
       FROM policies pl LEFT JOIN elections e ON e.id = pl.election_id
      WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL),
    '[]'::json
  ) AS policy_ids,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', lp.id, 'politician_id', COALESCE(pp.merged_into, lp.politician_id), 'name', COALESCE(mp.name, pp.name),
              'role', lp.role, 'basis', lp.basis, 'source_url', lp.source_url, 'source_locator', lp.source_locator, 'note', lp.note,
              'source', source_brief('lineage_participants', lp.id::text))
            ORDER BY array_position(ARRAY['proposer', 'co_proposer', 'cosigner', 'advocate'], lp.role),
                     array_position(ARRAY['official_record', 'self_claim'], lp.basis), lp.created_at, lp.id)
       FROM lineage_participants lp
       JOIN politicians pp ON pp.id = lp.politician_id
       LEFT JOIN politicians mp ON mp.id = pp.merged_into
      WHERE lp.lineage_id = l.id),
    '[]'::json
  ) AS participants,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', h.id,
              'from_politician_id', COALESCE(fp.merged_into, h.from_politician_id), 'from_name', COALESCE(fm.name, fp.name), 'from_election_id', h.from_election_id,
              'to_politician_id', COALESCE(tp.merged_into, h.to_politician_id), 'to_name', COALESCE(tm.name, tp.name), 'to_election_id', h.to_election_id,
              'from_office_id', h.from_office_id, 'to_office_id', h.to_office_id,
              'handover_type', h.handover_type, 'decided_on', h.decided_on, 'note', h.note,
              'source_url', h.source_url, 'source_locator', h.source_locator, 'source', source_brief('handovers', h.id::text))
            ORDER BY te.election_date NULLS LAST, h.decided_on NULLS LAST, h.created_at, h.id)
       FROM handovers h
       JOIN politicians fp ON fp.id = h.from_politician_id
       LEFT JOIN politicians fm ON fm.id = fp.merged_into
       JOIN politicians tp ON tp.id = h.to_politician_id
       LEFT JOIN politicians tm ON tm.id = tp.merged_into
       LEFT JOIN elections te ON te.id = h.to_election_id
      WHERE h.lineage_id = l.id),
    '[]'::json
  ) AS handovers,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', k.id, 'direction', CASE WHEN k.upper_lineage_id = l.id THEN 'lower' ELSE 'upper' END,
              'lineage_id', o.id, 'title', o.title, 'level', o.level, 'region', o.region, 'sub_region', o.sub_region,
              'link_type', k.link_type, 'note', k.note, 'source_url', k.source_url, 'source_locator', k.source_locator,
              'source', source_brief('lineage_links', k.id::text))
            ORDER BY array_position(ARRAY['national', 'county', 'township'], o.level), o.region NULLS FIRST, o.title, o.id)
       FROM lineage_links k
       JOIN lineages o ON o.id = CASE WHEN k.upper_lineage_id = l.id THEN k.lower_lineage_id ELSE k.upper_lineage_id END
      WHERE k.upper_lineage_id = l.id OR k.lower_lineage_id = l.id),
    '[]'::json
  ) AS links
FROM lineages l;
ALTER VIEW lineages_full SET (security_invoker = on);
GRANT SELECT ON lineages_full TO anon, authenticated;
COMMENT ON VIEW lineages_full IS '政策脈絡一條一列（#349）：脈絡頁與脈絡一覽讀這個；政見只給 id（內容讀 policies_with_logs），參與者、交接、關聯各帶出處';

-- ------------------------------------------------------------
-- 11. 派工臂一：lineage_candidate（同一層級、同一地方、同一類別的政見放成一格，整份交給代理判斷哪些是同一件事）
-- ------------------------------------------------------------
-- 一條政見放在哪一格：中央＝總統、立委（含不分區、原住民）；縣市＝縣市長、議員、區域立委（區域立委的政見多半是地方建設，
-- 兩格都放，代理把它歸到這件事實際在哪一級決定的那條脈絡）；鄉鎮＝鄉鎮市長、原住民區長。
-- 範圍照三要素（#364）：還沒投票的屆別看在選者（不含不參選、退選），已投票的屆別看當選者。
CREATE OR REPLACE FUNCTION lineage_candidate_scope()
RETURNS TABLE (policy_id UUID, title TEXT, content_md5 TEXT, category TEXT, status TEXT, lineage_id UUID,
               politician_id UUID, name TEXT, election_id INTEGER, election_date DATE, election_type TEXT,
               level TEXT, region TEXT, sub_region TEXT)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT pl.id AS policy_id, pl.title, md5(pl.title || COALESCE(pl.description, '')) AS content_md5, pl.category,
           pl.status::TEXT AS status, pl.lineage_id, p.id AS politician_id, p.name, pl.election_id, e.election_date,
           x.election_type,
           -- 縣市與鄉鎮只來自那一屆參選紀錄自己（10-05 裁決：不借人物表的地區；缺地區的由「補縣市／補選區」任務補上後才進格）
           replace(r.region, '臺', '台') AS county, r.sub_region AS r_sub
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      JOIN LATERAL (
        SELECT q.election_type, q.candidate_status, q.election_result, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.election_result = 'elected') DESC NULLS LAST,
                  (q.candidate_status NOT IN ('not_running', 'withdrawn')) DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL AND pl.category IS NOT NULL
       AND (
         (e.election_date >= CURRENT_DATE AND x.candidate_status NOT IN ('not_running', 'withdrawn'))
         OR (e.election_date < CURRENT_DATE AND x.election_result = 'elected')
       )
  )
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'national', NULL::TEXT, NULL::TEXT
    FROM scoped s WHERE s.election_type IN ('總統副總統', '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'county', s.county, NULL::TEXT
    FROM scoped s
   WHERE s.county IS NOT NULL AND s.county <> '全國'
     AND (s.election_type IN ('縣市長', '縣市議員') OR s.election_type = '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'township', s.county, s.r_sub
    FROM scoped s
   WHERE s.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND s.county IS NOT NULL AND s.r_sub IS NOT NULL
$$;
COMMENT ON FUNCTION lineage_candidate_scope IS
  '脈絡候選的範圍（#349）：哪些政見、放在哪一格（層級＋縣市＋鄉鎮＋類別）。還沒投票的屆別看在選者、已投票的看當選者（同三要素）';

-- 格的鍵：層級｜縣市｜鄉鎮｜類別 的雜湊前 12 碼（task_id 不能有空白；文字另外放在 target）
CREATE OR REPLACE FUNCTION lineage_block_key(p_level TEXT, p_region TEXT, p_sub_region TEXT, p_category TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT substr(md5(p_level || '|' || COALESCE(p_region, '') || '|' || COALESCE(p_sub_region, '') || '|' || COALESCE(p_category, '')), 1, 12)
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_candidates()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM lineage_candidate_scope()),
  blocks AS (
    SELECT s.level, s.region, s.sub_region, s.category,
           lineage_block_key(s.level, s.region, s.sub_region, s.category) AS block_key,
           -- 指紋只看政見本身（id＋標題＋說明），不看歸入了哪條脈絡：交上脈絡之後這一格不必因為「有人歸入了」而再派一次
           substr(md5(string_agg(s.policy_id::TEXT || ':' || s.content_md5, ',' ORDER BY s.policy_id)), 1, 8) AS fp,
           count(*) AS n,
           count(DISTINCT (s.politician_id, s.election_id)) AS terms,
           count(*) FILTER (WHERE s.lineage_id IS NULL) AS loose,
           jsonb_agg(jsonb_build_object(
             'policy_id', s.policy_id, 'title', s.title, 'politician_id', s.politician_id, 'name', s.name,
             'election_id', s.election_id, 'election_year', EXTRACT(YEAR FROM s.election_date)::INTEGER,
             'election_type', s.election_type, 'status', s.status, 'lineage_id', s.lineage_id)
             ORDER BY s.election_date, s.name, s.policy_id) AS policies
      FROM s
     GROUP BY s.level, s.region, s.sub_region, s.category
  )
  SELECT 'auto:lineage_candidate:' || b.block_key || ':' || b.fp, 'lineage_candidate',
         jsonb_build_object(
           'block_key', b.block_key, 'fingerprint', b.fp, 'level', b.level, 'region', b.region, 'sub_region', b.sub_region,
           'category', b.category, 'policies', b.policies, 'policies_total', b.n,
           -- 同一層級同一地方已經有的脈絡（任何類別都列，最多 30 條）：是同一件事就歸入它，不要另建一條
           'existing_lineages', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('lineage_id', l.id, 'title', l.title, 'category', l.category) ORDER BY l.title, l.id)
               FROM (SELECT * FROM lineages l0
                      WHERE l0.level = b.level AND l0.region IS NOT DISTINCT FROM b.region AND l0.sub_region IS NOT DISTINCT FROM b.sub_region
                      ORDER BY COALESCE(l0.category = b.category, false) DESC, l0.title LIMIT 30) l
           ), '[]'::jsonb)),
         '這一格是' || CASE b.level WHEN 'national' THEN '中央' WHEN 'county' THEN b.region ELSE b.region || b.sub_region END
           || '「' || b.category || '」類的 ' || b.n || ' 條政見（target.policies，跨 ' || b.terms || ' 個人或屆別）。'
           || '請整份看過，找出**講的是同一件事**的政見——同一個建設、同一部法律、同一筆補助或同一個制度（例：前任的「捷運藍線」與後任的「藍線延伸到大坑」；'
           || '幾位立委都承諾的「國定假日法制化」）。同一個主題但標的不同（不同的醫院、不同的路線、不同的補助對象）不是同一件事。'
           || '找到就交 lineage：同一件事已經有脈絡（target.existing_lineages）就帶 lineage_id 把政見歸進去，沒有就用 new_lineage 建一條'
           || '（title 4～60 字、中性、照事實；level 填這件事在哪一級政府決定與執行——立委承諾的地方建設多半是縣市級）；一件事交一筆，同一格可以交好幾筆。'
           || '只有一條政見、也沒有別人或別屆談同一件事的，不要建脈絡。整份看完沒有任何同一件事 → no_change，outcome=confirmed，finding 列出你比對過哪幾組。'
           || '每一筆 note 寫清楚憑什麼判定是同一件事（政見原文或報導裡的同一個名稱、地點、金額）。',
         ARRAY['target.policies 就是清單本身；每條政見的出處在 policy-tw.web.app/policy/<policy_id>',
               '縣市政府與議會官網（*.gov.tw）的施政報告、計畫名稱',
               '立法院法律提案系統 lis.ly.gov.tw（法案名稱）'],
         1, COALESCE(b.region, '全國')
    FROM blocks b
   WHERE b.terms >= 2 AND b.loose >= 1
     AND NOT EXISTS (
       SELECT 1 FROM lineage_candidate_reviews rv WHERE rv.review_key = 'block:' || b.block_key AND rv.fingerprint = b.fp
     )
     -- 有人交了還在等票：先不派（同一格的幾筆會一起交，被退件就會回來）
     AND NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.task_id = 'auto:lineage_candidate:' || b.block_key || ':' || b.fp
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_candidates IS
  '同一層級、同一地方、同一類別、跨人或跨屆的政見放成一格，還有沒歸入脈絡的就派 lineage_candidate；同一份清單查過就不再派（#349，2026-10-06）';

-- ------------------------------------------------------------
-- 12. 派工臂二：handover_missing（脈絡裡某位首長那一任的政見，那個職位之後換了人、前任已卸任，卻沒有交接紀錄）
-- 只看首長（縣市長、鄉鎮市長、原住民區長）：交接是行政的延續；議員、立委不是前後任的關係（多席、不執行）。
-- 總統副總統一屆兩人，第一階段不派（下一次換任是 2028）。前任那一任的卸任日用 office_term_end（跟職稱、三要素同一支）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_handover_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH exec AS (
    SELECT DISTINCT pl.lineage_id, pe.politician_id AS from_id, pe.election_id AS from_eid, pe.election_type,
           replace(r.region, '臺', '台') AS county, r.sub_region AS town, e.election_date AS from_date,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, pe.election_type) AS from_term_end
      FROM policies pl
      JOIN politician_elections pe ON pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id
       AND pe.election_result = 'elected' AND pe.election_type IN ('縣市長', '鄉鎮市長', '直轄市山地原住民區長')
      JOIN elections e ON e.id = pe.election_id
      JOIN regions r ON r.id = pe.region_id
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL
  ),
  succ AS (
    -- 同一個職位、下一個當選的人（投票日在前一任之後的第一個）
    SELECT DISTINCT ON (x.lineage_id, x.from_id, x.from_eid)
           x.*, pe2.politician_id AS to_id, pe2.election_id AS to_eid
      FROM exec x
      JOIN politician_elections pe2 ON pe2.election_type = x.election_type AND pe2.election_result = 'elected'
      JOIN elections e2 ON e2.id = pe2.election_id AND e2.election_date > x.from_date
      JOIN regions r2 ON r2.id = pe2.region_id
     WHERE replace(r2.region, '臺', '台') = x.county
       AND (x.election_type = '縣市長' OR r2.sub_region IS NOT DISTINCT FROM x.town)
       AND x.from_term_end < CURRENT_DATE
     ORDER BY x.lineage_id, x.from_id, x.from_eid, e2.election_date, pe2.politician_id
  )
  SELECT 'auto:handover_missing:' || s.lineage_id || ':' || substr(md5(s.from_id::TEXT || ':' || s.from_eid || ':' || s.to_id::TEXT || ':' || s.to_eid), 1, 8),
         'handover_missing',
         jsonb_build_object('lineage_id', s.lineage_id, 'lineage_title', l.title, 'level', l.level, 'region', l.region,
                            'sub_region', l.sub_region, 'office', s.election_type,
                            'from_politician_id', s.from_id, 'from_name', fp.name, 'from_election_id', s.from_eid,
                            'from_term_end', s.from_term_end,
                            'to_politician_id', s.to_id, 'to_name', tp.name, 'to_election_id', s.to_eid),
         '脈絡「' || l.title || '」裡有 ' || fp.name || '（' || s.election_type || '，' || EXTRACT(YEAR FROM s.from_date)::INTEGER || ' 年當選，'
           || s.from_term_end::TEXT || ' 卸任）任內的政見；接任的是 ' || tp.name || '，但脈絡裡還沒有這兩任之間的交接紀錄。'
           || '請查 ' || tp.name || ' 上任後這件事怎麼了：照舊做（keep 接手）、目的不變但改了做法（pivot 轉向）、規模或預算縮水但沒停（shrink 縮小）、'
           || '停掉了（stop 中止）、或曾經停掉後又重啟（resume 重新開始）。用 lineage_handover 交一筆，note 寫清楚依據（哪份預算、議會紀錄、施政報告或報導，講了什麼）。'
           || '**中止要有來源明確寫出停止、喊卡、解約或終止**——「後任政見清單裡沒有」不等於中止；中止這一型要兩台不同機器的驗證票才會上線。'
           || '還查不到後任怎麼處理（剛上任、沒有任何公開資料）→ no_change，outcome=not_found。',
         ARRAY['縣市政府施政報告、預算書（*.gov.tw）', '縣市議會議事錄與質詢紀錄', 'cna.com.tw'],
         1, COALESCE(l.region, '全國')
    FROM succ s
    JOIN lineages l ON l.id = s.lineage_id
    JOIN politicians fp ON fp.id = s.from_id
    JOIN politicians tp ON tp.id = s.to_id
   WHERE s.to_id <> s.from_id
     AND NOT EXISTS (
       SELECT 1 FROM handovers h
        WHERE h.lineage_id = s.lineage_id AND h.from_politician_id = s.from_id AND h.to_politician_id = s.to_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage_handover' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.payload->>'lineage_id' = s.lineage_id::TEXT
          AND c.payload->>'from_politician_id' = s.from_id::TEXT AND c.payload->>'to_politician_id' = s.to_id::TEXT
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_handover_missing IS
  '脈絡裡有首長那一任的政見、那個職位之後換了人而前任已卸任、卻沒有交接 → handover_missing（交 lineage_handover）（#349，2026-10-06）';

-- ------------------------------------------------------------
-- 13. 派工臂三：lineage_roles_missing（脈絡裡有民意代表的政見，卻沒有他的參與角色 → 照官方紀錄標角色）
-- 民意代表＝當過（投票日已過、當選）立委、縣市議員、鄉鎮市民代表、原住民區民代表的人——他們的提案、連署有官方紀錄可查。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_roles()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH people AS (
    SELECT DISTINCT pl.lineage_id, p.id AS politician_id, p.name
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL
       AND EXISTS (
         SELECT 1 FROM politician_elections pe JOIN elections e ON e.id = pe.election_id
          WHERE pe.politician_id = p.id AND pe.election_result = 'elected' AND e.election_date < CURRENT_DATE
            AND pe.election_type IN ('立法委員', '縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')
       )
       AND NOT EXISTS (SELECT 1 FROM lineage_participants lp WHERE lp.lineage_id = pl.lineage_id AND lp.politician_id = p.id)
  ),
  grp AS (
    SELECT lineage_id, jsonb_agg(jsonb_build_object('politician_id', politician_id, 'name', name) ORDER BY name, politician_id) AS people,
           string_agg(name, '、' ORDER BY name, politician_id) AS names
      FROM people GROUP BY lineage_id
  )
  SELECT 'auto:lineage_roles_missing:' || l.id, 'lineage_roles_missing',
         jsonb_build_object('lineage_id', l.id, 'lineage_title', l.title, 'level', l.level, 'region', l.region,
                            'sub_region', l.sub_region, 'category', l.category, 'people', g.people),
         '脈絡「' || l.title || '」裡有民意代表的政見（' || g.names || '），但還沒有他們在這件事裡的角色。'
           || '請到**官方紀錄**查：立法院議事系統（提案、關係文書、連署名單）、縣市議會網站（提案、議事錄）。'
           || '查到誰是提案人（proposer）、共同提案人（co_proposer）、連署人（cosigner）、或在官方紀錄裡主張推動（advocate，例：質詢、臨時提案）'
           || '——不限 target.people，同一案的其他提案、連署人也一起標——用 lineage_participants 交一筆，basis 填 official_record、出處放那一頁、source_locator 寫議案編號或頁碼。'
           || '本人在官網、新聞或答辯書裡說「我提的」而官方紀錄不是：照官方紀錄標角色，另外加一項 basis=self_claim（本人宣稱）。臉書讀不到，不收。'
           || '官方紀錄裡查不到這個人跟這件事有關 → 不要替他標角色；全部都查不到 → no_change，outcome=not_found，checked_urls 列你查過的議事系統頁面。',
         ARRAY['https://lis.ly.gov.tw/lylgmeetc/lgmeetkm ← 立法院議事系統（議案、關係文書）', 'https://ppg.ly.gov.tw ← 立法院議事暨公報資訊網', '各縣市議會官網（*.gov.tw）的提案與議事錄'],
         1, COALESCE(l.region, '全國')
    FROM grp g
    JOIN lineages l ON l.id = g.lineage_id
   WHERE NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage_participants' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.payload->>'lineage_id' = l.id::TEXT
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_roles IS
  '脈絡裡有民意代表（當過立委、議員、代表）的政見、卻沒有他的參與角色 → lineage_roles_missing（交 lineage_participants，照官方紀錄）（#349，2026-10-06）';

-- ------------------------------------------------------------
-- 14. 派工臂四：lineage_link_candidate（同類別、上一層級的脈絡還沒有關聯 → 判斷有沒有上下級關係）
-- 一條下級脈絡一件，列出所有候選的上級；同一份候選清單查過就不再派（lineage_candidate_reviews 的 link:<id>）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_links()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH cand AS (
    SELECT lo.id AS lower_id, up.id AS upper_id, up.title AS upper_title, up.level AS upper_level, up.region AS upper_region
      FROM lineages lo
      JOIN lineages up ON up.category = lo.category AND up.id <> lo.id
       AND ((lo.level = 'county' AND up.level = 'national')
         OR (lo.level = 'township' AND (up.level = 'national' OR (up.level = 'county' AND up.region = lo.region))))
     WHERE lo.category IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lineage_links k WHERE k.upper_lineage_id = up.id AND k.lower_lineage_id = lo.id)
  ),
  grp AS (
    SELECT lower_id,
           jsonb_agg(jsonb_build_object('lineage_id', upper_id, 'title', upper_title, 'level', upper_level, 'region', upper_region)
                     ORDER BY upper_level, upper_title, upper_id) AS uppers,
           substr(md5(string_agg(upper_id::TEXT, ',' ORDER BY upper_id)), 1, 8) AS fp,
           count(*) AS n
      FROM cand GROUP BY lower_id
  )
  SELECT 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp, 'lineage_link_candidate',
         jsonb_build_object('lineage_id', lo.id, 'lineage_title', lo.title, 'level', lo.level, 'region', lo.region,
                            'sub_region', lo.sub_region, 'category', lo.category, 'fingerprint', g.fp, 'upper_candidates', g.uppers),
         '脈絡「' || lo.title || '」（' || CASE lo.level WHEN 'county' THEN lo.region ELSE lo.region || lo.sub_region END || '）跟上一級的 '
           || g.n || ' 條同類別脈絡（target.upper_candidates）還沒有關聯。請判斷有沒有上下級關係：'
           || '上級立法或補助、這裡配套執行（top_down，例：中央條例或前瞻補助 → 縣市的執行計畫）；或這裡先爭取、上級後來採納（bottom_up，例：縣市試辦 → 中央入法）。'
           || '有就用 lineage_link 交（upper_lineage_id 是上級那條、lower_lineage_id 是這一條），一對交一筆，note 寫依據（補助核定公文、條例條文、執行計畫寫到上級的哪一案）。'
           || '同類別但沒有實際的法規、預算或政策連結（只是主題相近）不算。全部都沒有 → no_change，outcome=confirmed，finding 寫你逐條看過的結論。',
         ARRAY['中央各部會與縣市政府的計畫、補助核定（*.gov.tw）', '全國法規資料庫 law.moj.gov.tw', '縣市議會議事錄'],
         1, COALESCE(lo.region, '全國')
    FROM grp g
    JOIN lineages lo ON lo.id = g.lower_id
   WHERE NOT EXISTS (
       SELECT 1 FROM lineage_candidate_reviews rv WHERE rv.review_key = 'link:' || g.lower_id AND rv.fingerprint = g.fp
     )
     AND NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage_link' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.task_id = 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_links IS
  '同類別、上一層級的脈絡還沒有關聯 → lineage_link_candidate（交 lineage_link 或 no_change）；同一份候選清單查過就不再派（#349，2026-10-06）';

-- ------------------------------------------------------------
-- 15. 所有自動缺口：原樣保留 20261005005640（#364）那一版的每一支臂，加這四支
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due())
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_region_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_elected_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_cec_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_district_seats()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_elements()
  UNION ALL SELECT * FROM due
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_candidates()
  UNION ALL SELECT * FROM contribution_auto_tasks_handover_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_roles()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_links()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。'
  '2026-10-05 加 region_gap（縣市長／議員／立委缺縣市或缺選區）與 elected_missing（中選會當選、我們沒有參選紀錄）。'
  '2026-10-05 加 roster_cec_gap（已投票屆別：中選會名單有、我們沒有的人，依鄉鎮或縣市聚成名單清查）。'
  '2026-10-06 加 district_seats（議員、代表各選舉區的應選名額，#344）。'
  '2026-10-05 加 policy_elements（政見三要素）與 deadline_due（期限到了查進度，同一條政見不再另派 progress_stale）（#364）。'
  '2026-10-06 加政策脈絡四支：lineage_candidates、handover_missing、lineage_roles、lineage_links（#349）。';
