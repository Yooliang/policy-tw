-- 政策脈絡「一件事的全貌」第一期：立場、事件兩個資料櫃與讀取骨架（policy-tw#675；計畫 docs/PLAN-lineage-whole-picture.md 第 2 節與第 7 節第一期）
-- ============================================================
--
-- 維護者 2026-11-20 裁示：現在就蓋資料櫃、選後（2026-11-28 之後）才開任務。所以本檔**只建表、視圖、函式、權限**，
-- 不新增任何貢獻型別、不新增任何派工臂、不加排程、不讓代理交件（交件與臂是第二期，預設關著）。
-- 現況（lineage_statuses）與參數表（lineage_settings）已在 20261105200000 建好，這裡只替參數表補欄。
--
-- 本檔做的事：
--   1. lineage_settings 補欄（事件重查天數、往外擴與分格的上限、總開關、起跑日 dispatch_start_on）——全是第二期以後才會讀的參數，現在沒有任何函式讀它們。
--   2. lineages.search_terms（往外擴用的專有名詞，空陣列＝不參與）＋檢查函式 lineage_terms_in_title。
--   3. lineage_links.link_type 加 contains（大計畫包含項目；先加不刪舊值）＋新觸發器 lineage_links_check_contains（層級與地方、不成環）。
--   4. 新表 lineage_stances（立場）、lineage_events（事件）：RLS 公開讀（只讀沒軟刪除的）、anon／authenticated 只有 SELECT、寫入只走 service_role；
--      立場可掛政見（policy_id）；兩表都有軟刪除（removed_at）與爭議旗標（disputed_at、dispute_note）；
--      同一人同一天可以多次表態（唯一鍵含原文摘句的 md5）；表態日／決定日必須落在任期內（觸發器），選前日期插不進去。
--   5. source_refs 目標表清單加 lineages、lineage_stances、lineage_events；子表出處同步與清理觸發器。
--   6. 其餘子表（參與者、交接、關聯、立場、事件）掛 lineage_touch_parents_on_content：只有內容真的變了才蓋父脈絡的 updated_at（網站地圖 lastmod 讀它）。
--   7. 函式 lineage_norm、lineage_policy_place、lineage_coverage、lineage_term_df；視圖 lineages_full 尾端加欄、lineages_list、lineage_terms。
--   8. merge_politician() 與空殼人物那一段：同名人物合併與空殼清理要把立場與事件推動者也算進去（計畫 2.9）。
--
-- 回滾（本檔沒有改動既有資料列；全是加法，倒回就是反著 DROP）：
--   DROP VIEW lineage_terms, lineages_list;  CREATE OR REPLACE lineages_full 用 20261105200000 的那一版（DROP 新尾欄需重建視圖）；
--   DROP TABLE lineage_events, lineage_stances;  ALTER TABLE lineages DROP COLUMN search_terms;（先 DROP CONSTRAINT lineages_search_terms_ok）
--   DROP FUNCTION lineage_event_within_elected_term(UUID, UUID, DATE, DATE), lineage_stance_within_elected_term(UUID, DATE, DATE), lineage_events_check_term(), lineage_stances_check_term()；（表先 DROP 才能 DROP 函式；觸發器隨表消失）
--   DROP TRIGGER trg_lineage_participants_touch_parent ON lineage_participants（handovers、lineage_links 同名規則 trg_*_touch_parent）；DROP FUNCTION lineage_touch_parents_on_content()；
--   ALTER TABLE lineage_settings DROP COLUMN 各新欄；link_type CHECK 與 source_refs CHECK 改回前一版；
--   DROP TRIGGER trg_lineage_links_contains ON lineage_links 並把 trg_lineage_links_levels 建回來（函式 lineage_links_check_levels 沒刪）；
--   merge_politician／placeholder_politicians 用 20261007020000 的定義蓋回去。
--   （只要還沒有任何立場或事件資料，這些都是無損的。）

-- ------------------------------------------------------------
-- 1. 參數表補欄：事件重查天數、往外擴與分格上限、總開關（第二期以後才讀；初值依計畫 2.7）
-- ------------------------------------------------------------
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS event_recheck_days   INTEGER NOT NULL DEFAULT 180 CHECK (event_recheck_days >= 1);
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS expand_term_df_cap   INTEGER NOT NULL DEFAULT 12 CHECK (expand_term_df_cap >= 1);
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS expand_candidates_max INTEGER NOT NULL DEFAULT 30 CHECK (expand_candidates_max >= 1);
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS expand_stop_terms    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS expand_recheck_days  INTEGER NOT NULL DEFAULT 30 CHECK (expand_recheck_days >= 1);
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS cell_max_policies    INTEGER NOT NULL DEFAULT 60 CHECK (cell_max_policies >= 1);
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS open_cap_per_arm     INTEGER CHECK (open_cap_per_arm IS NULL OR open_cap_per_arm >= 1);
-- 整組新臂的總開關：預設 true 只是「參數」；新臂本身的 activity_rules 上線時一律 enabled=false，兩道都要開才會派
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS enabled              BOOLEAN NOT NULL DEFAULT true;
-- 起跑日（台北日）：二期的臂要等這天之後才派（選後 2026-11-29）；一期只加欄、不接線
ALTER TABLE lineage_settings ADD COLUMN IF NOT EXISTS dispatch_start_on    DATE NOT NULL DEFAULT '2026-11-29';
COMMENT ON COLUMN lineage_settings.dispatch_start_on IS '立場、事件、往外擴任務的起跑日（台北日，預設 2026-11-29＝選後）；第一期只加欄、沒有任何函式讀它，二期的臂才讀';
COMMENT ON COLUMN lineage_settings.event_recheck_days IS '有事件的脈絡，最近一筆事件（或最近現況）超過幾天再派事件缺口（第二期才讀）';
COMMENT ON COLUMN lineage_settings.expand_term_df_cap IS '專有名詞在合格政見裡出現超過幾條就算太泛（往外擴，第五期才讀）';
COMMENT ON COLUMN lineage_settings.expand_candidates_max IS '一件往外擴任務最多列幾條候選政見（第五期才讀）';
COMMENT ON COLUMN lineage_settings.expand_stop_terms IS '緊急時加的停用詞（不是常態維護的詞表；第五期才讀）';
COMMENT ON COLUMN lineage_settings.expand_recheck_days IS '一條脈絡往外擴看過後，多久才會因「又有新候選」再派（第五期才讀）';
COMMENT ON COLUMN lineage_settings.cell_max_policies IS '分格任務一格超過幾條就依屆別拆（第五期才讀；今天最大一格 44 條）';
COMMENT ON COLUMN lineage_settings.open_cap_per_arm IS '各臂同時開著的上限；空＝不設（與今天一致）。要限流改這一格（第二期以後才讀）';
COMMENT ON COLUMN lineage_settings.enabled IS '整組新臂（立場、事件、往外擴）的總開關。注意：新臂各自的 activity_rules 上線時另有一道 enabled=false，兩道都開才會派工';

-- ------------------------------------------------------------
-- 2. lineages.search_terms：往外擴用的專有名詞（空陣列＝沒有專有名詞，不參與）
-- ------------------------------------------------------------
-- 規則（資料庫的 CHECK 允許空陣列，這樣 DEFAULT '{}' 與既有列不被擋）：最多 5 個、每個 2～12 字、都必須是標題的子字串（維護者：「用脈絡標題的專有名詞」）。
-- 改標題時 CHECK 會要求同步改詞。「至少一個詞」是交件與派工那一端的要求，不是資料庫約束。
CREATE OR REPLACE FUNCTION lineage_terms_in_title(p_title TEXT, p_terms TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_terms IS NULL THEN false
    WHEN cardinality(p_terms) = 0 THEN true
    WHEN cardinality(p_terms) > 5 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(p_terms) AS t(term)
       WHERE t.term IS NULL
          OR char_length(t.term) NOT BETWEEN 2 AND 12
          OR position(t.term IN COALESCE(p_title, '')) = 0)
  END
$$;
COMMENT ON FUNCTION lineage_terms_in_title IS '專有名詞陣列合不合格：空陣列合格；最多 5 個、每個 2～12 字、必須是標題的子字串（區分大小寫，不做正規化）。lineages_search_terms_ok 用它';

ALTER TABLE lineages ADD COLUMN IF NOT EXISTS search_terms TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE lineages DROP CONSTRAINT IF EXISTS lineages_search_terms_ok;
ALTER TABLE lineages ADD CONSTRAINT lineages_search_terms_ok CHECK (lineage_terms_in_title(title, search_terms));
COMMENT ON COLUMN lineages.search_terms IS '往外擴找同一件事用的專有名詞（0～5 個，每個 2～12 字且是標題的子字串）；空陣列＝沒有專有名詞，不參與往外擴。補值走派工流程（第五期），不寫 migration';

-- 層級、地方欄位改義為「主辦」（欄位名不動、不動資料）：只改註解
COMMENT ON COLUMN lineages.level IS 'national 中央／county 縣市／township 鄉鎮市區：**主辦**＝這件事實際在哪一級政府決定與執行（#675 起一條脈絡可以涵蓋多個地方，涵蓋地方由政見推導，見 lineage_coverage；沒有單一主辦的填牽頭或核定的那一級，實在找不到填中央）';
COMMENT ON COLUMN lineages.region IS '主辦的縣市（網站寫法「台」，中央為 NULL）；一條脈絡實際涵蓋哪些縣市看 lineage_coverage()';
COMMENT ON COLUMN lineages.sub_region IS '主辦的鄉鎮市區（只有 township 層級有）';
COMMENT ON INDEX lineages_same_title_same_place IS '同一個主辦、同標題不會有兩條（#675 起「主辦」的意思；它擋不到「不同主辦、同一件事」的重複，那個靠派工與驗證）';

-- ------------------------------------------------------------
-- 3. lineage_links：加 contains（大計畫包含項目）；新觸發器取代舊的層級檢查
-- ------------------------------------------------------------
-- 意思：upper_lineage_id＝大計畫、lower_lineage_id＝項目；一個項目可屬於多個大計畫（有向、不成環）。欄位名不改。
-- link_type 先加不刪舊值（top_down／bottom_up 目前 0 筆，但舊程式與在途交件仍可能帶舊值）；新交件只收 contains 要等第五期。
ALTER TABLE lineage_links DROP CONSTRAINT IF EXISTS lineage_links_link_type_check;
ALTER TABLE lineage_links ADD CONSTRAINT lineage_links_link_type_check CHECK (link_type IN ('top_down', 'bottom_up', 'contains'));
COMMENT ON COLUMN lineage_links.link_type IS 'contains＝大計畫（upper）包含項目（lower）；top_down／bottom_up 是舊值（0 筆），保留到確認沒有在途交件後由後續 migration 刪掉';

-- contains 的規則：①層級與地方（中央 → 中央、任何縣市、任何鄉鎮；縣市 → 同縣市的縣市項目或同縣市的鄉鎮項目；鄉鎮 → 同鄉鎮的鄉鎮項目；
-- 項目層級高於大計畫、或縣市不同，一律擋）②不成環（大計畫不能是項目的後代）；舊值照舊走 lineage_links_check_levels 的檢查（本檔沒改那支函式）。
CREATE OR REPLACE FUNCTION lineage_links_check_contains() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE u lineages%ROWTYPE; d lineages%ROWTYPE;
BEGIN
  IF NEW.link_type <> 'contains' THEN
    PERFORM lineage_links_check_levels_row(NEW);
    RETURN NEW;
  END IF;
  SELECT * INTO u FROM lineages WHERE id = NEW.upper_lineage_id;
  SELECT * INTO d FROM lineages WHERE id = NEW.lower_lineage_id;
  IF NOT (
       (u.level = 'national')
    OR (u.level = 'county'   AND d.level IN ('county', 'township') AND d.region IS NOT DISTINCT FROM u.region)
    OR (u.level = 'township' AND d.level = 'township' AND d.region IS NOT DISTINCT FROM u.region AND d.sub_region IS NOT DISTINCT FROM u.sub_region)
  ) THEN
    RAISE EXCEPTION 'lineage_links：大計畫（%／%）不能包含項目（%／%）：項目的層級比大計畫高、或不在大計畫的地方裡',
      u.level, COALESCE(u.region, '全國') || COALESCE(u.sub_region, ''), d.level, COALESCE(d.region, '全國') || COALESCE(d.sub_region, '');
  END IF;
  -- 不成環：從項目往下（它自己包含的項目、再往下……）走，走得到大計畫就是成環
  IF EXISTS (
    WITH RECURSIVE down(id) AS (
      SELECT NEW.lower_lineage_id
      UNION
      SELECT k.lower_lineage_id FROM lineage_links k JOIN down ON k.upper_lineage_id = down.id
       WHERE k.link_type = 'contains' AND k.id IS DISTINCT FROM NEW.id
    )
    SELECT 1 FROM down WHERE id = NEW.upper_lineage_id
  ) THEN
    RAISE EXCEPTION 'lineage_links：成環——大計畫「%」已經是項目「%」的後代', u.title, d.title;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION lineage_links_check_contains IS 'lineage_links 的層級與地方、不成環檢查（#675）：contains 走新規則；舊值（top_down／bottom_up）仍走舊的上一層檢查（lineage_links_check_levels_row）';

-- 舊檢查的「列版本」：邏輯與 lineage_links_check_levels 一字不差（舊函式不動，回滾用）
CREATE OR REPLACE FUNCTION lineage_links_check_levels_row(p_row lineage_links) RETURNS lineage_links
LANGUAGE plpgsql AS $$
DECLARE u lineages%ROWTYPE; d lineages%ROWTYPE;
BEGIN
  SELECT * INTO u FROM lineages WHERE id = p_row.upper_lineage_id;
  SELECT * INTO d FROM lineages WHERE id = p_row.lower_lineage_id;
  IF NOT ((u.level = 'national' AND d.level IN ('county', 'township'))
       OR (u.level = 'county' AND d.level = 'township' AND u.region = d.region)) THEN
    RAISE EXCEPTION 'lineage_links：上級（%／%）不在下級（%／%）的上一層', u.level, COALESCE(u.region, '全國'), d.level, COALESCE(d.region, '全國');
  END IF;
  RETURN p_row;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineage_links_levels ON lineage_links;
DROP TRIGGER IF EXISTS trg_lineage_links_contains ON lineage_links;
CREATE TRIGGER trg_lineage_links_contains BEFORE INSERT OR UPDATE OF upper_lineage_id, lower_lineage_id, link_type ON lineage_links
  FOR EACH ROW EXECUTE FUNCTION lineage_links_check_contains();

-- ------------------------------------------------------------
-- 4. 新表：立場 lineage_stances
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_stances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id      UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  -- 只收站上已有的人物（與參與者同規則）；人物合併後讀取端用 merged_into 對到保留者，merge_politician() 也會把這欄搬過去
  politician_id   UUID NOT NULL REFERENCES politicians(id),
  -- 這句話屬於哪條政見（可追溯；選填）
  policy_id       UUID REFERENCES policies(id) ON DELETE SET NULL,
  stance          TEXT NOT NULL CHECK (stance IN ('support', 'oppose', 'conditional')),
  -- 有條件時必填、其他必空
  condition_text  TEXT CHECK (condition_text IS NULL OR char_length(btrim(condition_text)) BETWEEN 6 AND 200),
  -- 表態當天；只知道年或月就填該期間第一天並標精度。晚於今天由交件守門擋（CHECK 不能用 now()）
  stated_on       DATE NOT NULL,
  date_precision  TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day', 'month', 'year')),
  -- 原文摘句：驗證者要在出處找得到一字不差
  quote           TEXT NOT NULL CHECK (char_length(btrim(quote)) BETWEEN 8 AND 300),
  -- 唯一鍵用：同一人同一天的多句不同表態各自一筆、不互相覆蓋
  quote_hash      TEXT GENERATED ALWAYS AS (md5(btrim(quote))) STORED,
  source_url      TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator  TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  -- 子表的備註（對應交件裡每一項的 note；跟交件外層 contributions.note 是兩個欄位）
  note            TEXT CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 200),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  -- 軟刪除：有值＝這筆已撤下（公開讀取一律濾掉，RLS 與視圖兩道）；爭議旗標：有人質疑但還沒結論，公開仍可見、畫面可標示
  removed_at      TIMESTAMPTZ,
  disputed_at     TIMESTAMPTZ,
  dispute_note    TEXT CHECK (dispute_note IS NULL OR char_length(btrim(dispute_note)) BETWEEN 1 AND 300),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lineage_stances_condition CHECK ((stance = 'conditional') = (condition_text IS NOT NULL)),
  CONSTRAINT lineage_stances_dispute CHECK ((disputed_at IS NULL) = (dispute_note IS NULL))
);
-- 同一人同一天可以有好幾次表態（同日多次表態不互相覆蓋）；只有「原文摘句一字不差」才算同一筆（重交＝覆蓋，查核履歷記每欄舊值）。
-- 軟刪除的不佔位，撤下之後同一句可以重新收進來。「現行立場」＝同一人最新一筆，立場變過看全部列
CREATE UNIQUE INDEX IF NOT EXISTS lineage_stances_one_per_quote ON lineage_stances (lineage_id, politician_id, stated_on, quote_hash) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lineage_stances_policy ON lineage_stances (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lineage_stances_politician ON lineage_stances (politician_id);
CREATE INDEX IF NOT EXISTS idx_lineage_stances_timeline ON lineage_stances (lineage_id, stated_on DESC);
COMMENT ON TABLE lineage_stances IS
  '政策脈絡的立場（#675 第一期）：誰在哪天對這件事表態支持、反對或有條件，附原文摘句與出處。現行立場＝同一人最新一筆，立場變過看全部列。第一期只有資料櫃，沒有任何交件型別或派工臂（第二期才接，預設關）；寫入只走 service_role 或落庫函式。回滾：DROP TABLE lineage_stances';
COMMENT ON COLUMN lineage_stances.politician_id IS '表態的人（站上已有的人物）；人物合併時由 merge_politician() 搬給保留者。表態日必須落在他的某一任期內（觸發器 lineage_stances_check_term）';
COMMENT ON COLUMN lineage_stances.policy_id IS '這句話屬於哪條政見（選填，可追溯；政見被刪則清空）';
COMMENT ON COLUMN lineage_stances.removed_at IS '軟刪除時間；有值就不公開（RLS 與視圖都濾掉）';
COMMENT ON COLUMN lineage_stances.disputed_at IS '爭議旗標：有人質疑這筆但還沒結論（與 dispute_note 同有同無）；公開仍可見';
COMMENT ON COLUMN lineage_stances.stance IS 'support 支持／oppose 反對／conditional 有條件（有條件時 condition_text 必填、其他必空）';
COMMENT ON COLUMN lineage_stances.condition_text IS '有條件支持的條件（6～200 字）；stance 不是 conditional 時必為空';
COMMENT ON COLUMN lineage_stances.stated_on IS '表態當天；只知道年或月就填該期間第一天並標 date_precision（老的質詢紀錄常只確定年份）';
COMMENT ON COLUMN lineage_stances.date_precision IS 'day／month／year：stated_on 的精度';
COMMENT ON COLUMN lineage_stances.quote IS '原文摘句（8～300 字）；驗證者要在出處找得到一字不差';
COMMENT ON COLUMN lineage_stances.source_locator IS '在出處的哪裡（議事紀錄日期與案由、報導段落…）';
COMMENT ON COLUMN lineage_stances.note IS '備註（1～200 字，選填）；不是交件外層的「交件說明」';

-- ------------------------------------------------------------
-- 4b. 新表：事件 lineage_events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id      UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('decided', 'approved', 'budget_added', 'budget_cut', 'started', 'completed', 'paused', 'cancelled', 'resumed', 'other')),
  -- 決定當天（不是報導日）；晚於今天由交件守門擋
  occurred_on     DATE NOT NULL,
  date_precision  TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day', 'month', 'year')),
  -- 哪一級在哪個地方做的決定（與 lineages_place 同一組規則）；篩選與關係圖的地方標籤用它
  level           TEXT NOT NULL CHECK (level IN ('national', 'county', 'township')),
  region          TEXT,
  sub_region      TEXT,
  admin_code      TEXT REFERENCES admin_divisions(code),
  -- 機關名稱（縣議會、行政院、交通部、縣政府…），自由文字，不另建機關表
  decided_by      TEXT NOT NULL CHECK (char_length(btrim(decided_by)) BETWEEN 2 AND 40),
  -- 只寫發生了什麼，不寫評價
  description     TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 10 AND 300),
  -- 誰提案或爭取（關係圖畫「爭取 → 核定」的虛線箭頭用；不填就不畫）
  initiator_politician_id UUID REFERENCES politicians(id),
  initiator_note  TEXT CHECK (initiator_note IS NULL OR char_length(btrim(initiator_note)) BETWEEN 2 AND 30),
  source_url      TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator  TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  removed_at      TIMESTAMPTZ,
  disputed_at     TIMESTAMPTZ,
  dispute_note    TEXT CHECK (dispute_note IS NULL OR char_length(btrim(dispute_note)) BETWEEN 1 AND 300),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lineage_events_dispute CHECK ((disputed_at IS NULL) = (dispute_note IS NULL)),
  CONSTRAINT lineage_events_place CHECK (
       (level = 'national' AND region IS NULL AND sub_region IS NULL AND admin_code IS NULL)
    OR (level = 'county'   AND region IS NOT NULL AND sub_region IS NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{5}$')
    OR (level = 'township' AND region IS NOT NULL AND sub_region IS NOT NULL AND admin_code IS NOT NULL AND admin_code ~ '^[0-9]{8}$')
  ),
  CONSTRAINT lineage_events_initiator_note CHECK (initiator_note IS NULL OR initiator_politician_id IS NOT NULL)
);
-- 已知取捨：同一天、同一機關、同一型態的兩項決定會撞鍵，後交的覆蓋先交的（查核履歷會記舊值）；協議要求同日同機關同型態合併成一筆、description 分點寫。軟刪除的不佔位
CREATE UNIQUE INDEX IF NOT EXISTS lineage_events_one_per_decision ON lineage_events (lineage_id, event_type, occurred_on, decided_by) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lineage_events_initiator ON lineage_events (initiator_politician_id) WHERE initiator_politician_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lineage_events_timeline ON lineage_events (lineage_id, occurred_on DESC);
COMMENT ON TABLE lineage_events IS
  '政策脈絡的事件（#675 第一期）：政府或議會對這件事做的決定（拍板、核定、編預算、刪預算、動工、完工、暫緩、喊卡、重啟…），附決定機關、日期、出處。第一期只有資料櫃，沒有任何交件型別或派工臂（第二期才接，預設關）；寫入只走 service_role 或落庫函式。回滾：DROP TABLE lineage_events';
COMMENT ON COLUMN lineage_events.event_type IS 'decided 拍板／approved 核定／budget_added 編列預算／budget_cut 預算刪減／started 動工或開辦／completed 完工或上路／paused 暫緩／cancelled 喊卡或終止／resumed 重啟／other 其他（other 的描述要寫清楚是什麼決定）';
COMMENT ON COLUMN lineage_events.occurred_on IS '決定當天（不是報導日）';
COMMENT ON COLUMN lineage_events.level IS '哪一級在哪個地方做的決定（level／region／sub_region／admin_code 與 lineages_place 同一組規則）';
COMMENT ON COLUMN lineage_events.decided_by IS '決定機關名稱（2～40 字，自由文字）：縣議會、行政院、交通部、縣政府…';
COMMENT ON COLUMN lineage_events.description IS '發生了什麼（10～300 字），只寫事實不寫評價';
COMMENT ON COLUMN lineage_events.initiator_politician_id IS '誰提案或爭取（選填）；人物合併時由 merge_politician() 搬給保留者';
COMMENT ON COLUMN lineage_events.removed_at IS '軟刪除時間；有值就不公開（RLS 與視圖都濾掉）';
COMMENT ON COLUMN lineage_events.disputed_at IS '爭議旗標：有人質疑這筆但還沒結論（與 dispute_note 同有同無）；公開仍可見';
COMMENT ON COLUMN lineage_events.occurred_on IS '決定當天（不是報導日）；有推動者時必須落在推動者的某一任期內，沒有推動者時不得早於涉及這條脈絡的人最早的任期起日（觸發器 lineage_events_check_term）';
COMMENT ON COLUMN lineage_events.initiator_note IS '推動方式的短註（例：縣府提案、立委爭取）；沒有推動者就不能填';

-- ------------------------------------------------------------
-- 4c. 兩張新表共同：RLS 公開讀、只有 service_role 寫；anon／authenticated 只給 SELECT（沒有 INSERT／UPDATE／DELETE／TRUNCATE／TRIGGER／REFERENCES）
-- ------------------------------------------------------------
ALTER TABLE lineage_stances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_stances;
CREATE POLICY "Public read" ON lineage_stances FOR SELECT USING (removed_at IS NULL);
DROP POLICY IF EXISTS "Service role write" ON lineage_stances;
CREATE POLICY "Service role write" ON lineage_stances FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON lineage_stances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON lineage_stances TO anon, authenticated;
GRANT ALL ON lineage_stances TO service_role;

ALTER TABLE lineage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_events;
CREATE POLICY "Public read" ON lineage_events FOR SELECT USING (removed_at IS NULL);
DROP POLICY IF EXISTS "Service role write" ON lineage_events;
CREATE POLICY "Service role write" ON lineage_events FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON lineage_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON lineage_events TO anon, authenticated;
GRANT ALL ON lineage_events TO service_role;

-- updated_at：蓋自己這一列
DROP TRIGGER IF EXISTS trg_lineage_stances_touch ON lineage_stances;
CREATE TRIGGER trg_lineage_stances_touch BEFORE UPDATE ON lineage_stances FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();
DROP TRIGGER IF EXISTS trg_lineage_events_touch ON lineage_events;
CREATE TRIGGER trg_lineage_events_touch BEFORE UPDATE ON lineage_events FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- ------------------------------------------------------------
-- 5. 出處：source_refs 目標表清單加 lineages、lineage_stances、lineage_events
--    （現行定義＝20261105200000 的十一個值，一個不少，再加三個；做法同 lineage_statuses）
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements', 'lineage_participants', 'handovers', 'lineage_links', 'politician_careers', 'parties', 'politician_elections', 'regional_stats', 'lineage_statuses', 'lineages', 'lineage_stances', 'lineage_events'));

DROP TRIGGER IF EXISTS trg_lineage_stances_sync_source ON lineage_stances;
CREATE TRIGGER trg_lineage_stances_sync_source AFTER INSERT OR UPDATE OF source_url ON lineage_stances
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_lineage_stances_drop_refs ON lineage_stances;
CREATE TRIGGER trg_lineage_stances_drop_refs AFTER DELETE ON lineage_stances
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();
DROP TRIGGER IF EXISTS trg_lineage_events_sync_source ON lineage_events;
CREATE TRIGGER trg_lineage_events_sync_source AFTER INSERT OR UPDATE OF source_url ON lineage_events
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_lineage_events_drop_refs ON lineage_events;
CREATE TRIGGER trg_lineage_events_drop_refs AFTER DELETE ON lineage_events
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();

-- ------------------------------------------------------------
-- 5b. 內容層承諾防線：表態日／決定日要落在任期內（選前的只是承諾，不是這件事的立場或決定）
-- ------------------------------------------------------------
-- 任期＝這個人有一筆參選紀錄 candidacy_status = 'elected'、那一屆已投票（投票日早於 p_today，投票日當天算還沒投票；與 policy_is_elected_term 同一個條件），
-- 而且日期落在 election_term_start(…) ≤ 日期 ≤ election_term_end(…)（罷免回 NULL 的不會有人當選；迄日為空就當沒有迄日）。合併過的人看保留者名下的參選紀錄。
-- 兩支函式的 TS 鏡像：_shared/elected-term.ts 的 isElectedTerm（「已投票且當選」那一段）；SQL 與 TS 由 lineage-stances-events.test.ts 逐案比對。
CREATE OR REPLACE FUNCTION lineage_stance_within_elected_term(p_politician_id UUID, p_date DATE, p_today DATE DEFAULT activity_today()) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politician_elections q
      JOIN elections e ON e.id = q.election_id
      JOIN politicians qp ON qp.id = q.politician_id
     WHERE COALESCE(qp.merged_into, qp.id) = COALESCE((SELECT x.merged_into FROM politicians x WHERE x.id = p_politician_id), p_politician_id)
       AND q.candidacy_status = 'elected'
       AND e.election_date < p_today
       AND p_date >= election_term_start(q.election_id, q.election_type)
       AND p_date <= COALESCE(election_term_end(q.election_id, q.election_type), 'infinity'::date)
  )
$$;
COMMENT ON FUNCTION lineage_stance_within_elected_term IS '這個人在這一天是不是在某一個當選任期內（當選紀錄、那一屆已投票且投票日當天算未投票、任期起訖看選舉本身；合併過的人看保留者）。立場的表態日與有推動者的事件決定日用它擋選前日期（#675）';

-- 事件：有推動者看推動者的任期；沒有推動者就看「涉及這條脈絡的人」——政見持有人與交接雙方（參與者、立場表態者不計），
-- 日期落在其中任一人的某個當選任期內就收（前任核定、後任動工都收得進來）；一個涉及的人都沒有（空脈絡）就擋。
CREATE OR REPLACE FUNCTION lineage_event_within_elected_term(p_lineage_id UUID, p_initiator_politician_id UUID, p_date DATE, p_today DATE DEFAULT activity_today()) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_initiator_politician_id IS NOT NULL THEN lineage_stance_within_elected_term(p_initiator_politician_id, p_date, p_today)
    ELSE EXISTS (
      SELECT 1 FROM (
        SELECT pl.politician_id AS pid FROM policies pl WHERE pl.lineage_id = p_lineage_id AND pl.removed_at IS NULL
        UNION SELECT from_politician_id FROM handovers WHERE lineage_id = p_lineage_id
        UNION SELECT to_politician_id FROM handovers WHERE lineage_id = p_lineage_id
      ) who
      WHERE who.pid IS NOT NULL AND lineage_stance_within_elected_term(who.pid, p_date, p_today)
    )
  END
$$;
COMMENT ON FUNCTION lineage_event_within_elected_term IS '事件的決定日是不是落在當選任期內：有推動者看推動者；沒有就看政見持有人與交接雙方（參與者不計）任一人的任期；空脈絡回 false（#675）';

CREATE OR REPLACE FUNCTION lineage_stances_check_term() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 只搬人（合併人物）或蓋時間戳、日期沒變的更新不重判
  IF TG_OP = 'UPDATE' AND NEW.stated_on = OLD.stated_on THEN RETURN NEW; END IF;
  IF NOT lineage_stance_within_elected_term(NEW.politician_id, NEW.stated_on) THEN
    RAISE EXCEPTION 'lineage_stances：表態日 % 不在這個人的任何一個當選任期內（選前的只是承諾，不是立場）', NEW.stated_on;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineage_stances_check_term ON lineage_stances;
CREATE TRIGGER trg_lineage_stances_check_term BEFORE INSERT OR UPDATE OF stated_on, politician_id ON lineage_stances
  FOR EACH ROW EXECUTE FUNCTION lineage_stances_check_term();

CREATE OR REPLACE FUNCTION lineage_events_check_term() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.occurred_on = OLD.occurred_on AND NEW.lineage_id = OLD.lineage_id THEN RETURN NEW; END IF;
  IF NEW.initiator_politician_id IS NOT NULL THEN
    IF NOT lineage_stance_within_elected_term(NEW.initiator_politician_id, NEW.occurred_on) THEN
      RAISE EXCEPTION 'lineage_events：決定日 % 不在推動者的任何一個任期內', NEW.occurred_on;
    END IF;
  ELSIF NOT lineage_event_within_elected_term(NEW.lineage_id, NULL, NEW.occurred_on) THEN
    RAISE EXCEPTION 'lineage_events：決定日 % 不在涉及這條脈絡的人（政見持有人、交接雙方）的任何一個當選任期內', NEW.occurred_on;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_lineage_events_check_term ON lineage_events;
CREATE TRIGGER trg_lineage_events_check_term BEFORE INSERT OR UPDATE OF occurred_on, lineage_id ON lineage_events
  FOR EACH ROW EXECUTE FUNCTION lineage_events_check_term();

-- ------------------------------------------------------------
-- 6. 子表「內容」一變，父脈絡的 updated_at 跟著動（網站地圖 lastmod 讀它）
--    發現（計畫 2.6）：lib/sitemap.ts 說脈絡頁 lastmod 取 lineages.updated_at、連參與者交接關聯的變動都蓋，但先前的觸發器只蓋各自那張表。
--    lineage_touch_parent（20261105200000，現況表用）不動；其餘子表用下面這支：UPDATE 時只有「內容」真的變了才蓋
--    （把 updated_at、contribution_id 拿掉後整列比較；一個沒變的 UPDATE 或只是蓋時間戳不會讓 lastmod 亂跳）；INSERT／DELETE 一律蓋。
--    關聯有兩個父脈絡（大計畫與項目）一次蓋兩邊。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION lineage_touch_parents_on_content() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END; v_old JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
        v_ids UUID[];
BEGIN
  IF TG_OP = 'UPDATE' AND (v_new - 'updated_at' - 'contribution_id') = (v_old - 'updated_at' - 'contribution_id') THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT x::UUID) INTO v_ids
    FROM (SELECT unnest(ARRAY[
            COALESCE(v_new->>'lineage_id', v_old->>'lineage_id'),
            COALESCE(v_new->>'upper_lineage_id', v_old->>'upper_lineage_id'),
            COALESCE(v_new->>'lower_lineage_id', v_old->>'lower_lineage_id'),
            v_old->>'lineage_id', v_old->>'upper_lineage_id', v_old->>'lower_lineage_id'])) AS t(x)
   WHERE x IS NOT NULL;
  UPDATE lineages SET updated_at = now() WHERE id = ANY (v_ids);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION lineage_touch_parents_on_content() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION lineage_touch_parents_on_content IS '子表（參與者、交接、關聯、立場、事件）的內容異動才蓋父脈絡 updated_at；關聯蓋大計畫與項目兩邊（#675）';

DROP TRIGGER IF EXISTS trg_lineage_participants_touch_parent ON lineage_participants;
CREATE TRIGGER trg_lineage_participants_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_participants
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();
DROP TRIGGER IF EXISTS trg_handovers_touch_parent ON handovers;
CREATE TRIGGER trg_handovers_touch_parent AFTER INSERT OR UPDATE OR DELETE ON handovers
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();
DROP TRIGGER IF EXISTS trg_lineage_links_touch_parent ON lineage_links;
CREATE TRIGGER trg_lineage_links_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_links
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();
DROP TRIGGER IF EXISTS trg_lineage_stances_touch_parent ON lineage_stances;
CREATE TRIGGER trg_lineage_stances_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_stances
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();
DROP TRIGGER IF EXISTS trg_lineage_events_touch_parent ON lineage_events;
CREATE TRIGGER trg_lineage_events_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_events
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parents_on_content();

-- ------------------------------------------------------------
-- 7. 讀取：函式
-- ------------------------------------------------------------
-- 文字正規化（專有名詞比對用）：轉小寫、全形英數轉半形、「臺」換「台」、去掉所有空白
CREATE OR REPLACE FUNCTION lineage_norm(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(replace(translate(lower(COALESCE(p_text, '')), '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'), '臺', '台'), '\s+', '', 'g')
$$;
COMMENT ON FUNCTION lineage_norm IS '文字正規化：轉小寫、全形英數轉半形、「臺」換「台」、去掉空白（專有名詞出現數 lineage_term_df 用）';

-- 一條政見放在哪（單一真相，格與涵蓋共用）：職位＋層級＋縣市＋鄉鎮。一條政見只回一列（立委只放自己縣市那一格，不再同時出現在中央與縣市）；放不進任何格的回 0 列。
-- 規則同 lineage_candidate_scope：縣市與鄉鎮只來自那一屆參選紀錄自己、「臺」換「台」、「全國」不算縣市。
-- 這裡**不判斷政見合不合格**——合格一律呼叫 policy_is_elected_term／lineage_policy_eligible（20261019020000），不另寫第二份。
CREATE OR REPLACE FUNCTION lineage_policy_place(p_policy_id UUID)
RETURNS TABLE (election_type TEXT, level TEXT, region TEXT, sub_region TEXT)
LANGUAGE sql STABLE AS $$
  WITH x AS (
    SELECT q.election_type AS et, replace(r.region, '臺', '台') AS county, r.sub_region AS r_sub
      FROM policies pl
      JOIN LATERAL (
        SELECT qq.election_type, qq.region_id
          FROM politician_elections qq
         WHERE qq.politician_id = pl.politician_id AND qq.election_id = pl.election_id
         ORDER BY (qq.candidacy_status = 'elected') DESC NULLS LAST,
                  (qq.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, qq.id
         LIMIT 1
      ) q ON true
      LEFT JOIN regions r ON r.id = q.region_id
     WHERE pl.id = p_policy_id
  )
  SELECT x.et, 'national', NULL::TEXT, NULL::TEXT FROM x
   WHERE x.et = '總統副總統' OR (x.et = '立法委員' AND (x.county IS NULL OR x.county = '全國'))
  UNION ALL
  SELECT x.et, 'county', x.county, NULL::TEXT FROM x
   WHERE x.county IS NOT NULL AND x.county <> '全國' AND x.et IN ('縣市長', '縣市議員', '立法委員')
  UNION ALL
  SELECT x.et, 'township', x.county, x.r_sub FROM x
   WHERE x.et IN ('鄉鎮市長', '直轄市山地原住民區長') AND x.county IS NOT NULL AND x.r_sub IS NOT NULL
$$;
COMMENT ON FUNCTION lineage_policy_place IS '一條政見放在哪（職位、層級、縣市、鄉鎮），只回一列、放不進去回 0 列；不判斷合不合格（合格看 lineage_policy_eligible）。涵蓋地方 lineage_coverage 與第五期的分格共用這一支（#675）';

-- 一條脈絡實際涵蓋哪些地方：由合格政見的 lineage_policy_place 分組，[{level, region, sub_region, policy_count}]；只看政見，主辦另外顯示
CREATE OR REPLACE FUNCTION lineage_coverage(p_lineage_id UUID) RETURNS JSON
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(json_agg(json_build_object('level', g.level, 'region', g.region, 'sub_region', g.sub_region, 'policy_count', g.n)
                           ORDER BY array_position(ARRAY['national', 'county', 'township'], g.level), g.region NULLS FIRST, g.sub_region NULLS FIRST), '[]'::json)
    FROM (
      SELECT pp.level, pp.region, pp.sub_region, count(*)::INTEGER AS n
        FROM policies pl
        CROSS JOIN LATERAL lineage_policy_place(pl.id) pp
       WHERE pl.lineage_id = p_lineage_id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
       GROUP BY pp.level, pp.region, pp.sub_region
    ) g
$$;
COMMENT ON FUNCTION lineage_coverage IS '一條脈絡涵蓋的地方（合格政見依 lineage_policy_place 分組的筆數）；沒有合格政見回 []';

-- 專有名詞在合格政見的標題或說明裡出現幾條（往外擴判斷「太泛」用）：不含該脈絡自己已有的政見；建立時也要扣掉這筆要歸入的
CREATE OR REPLACE FUNCTION lineage_term_df(p_term TEXT, p_exclude_lineage UUID DEFAULT NULL, p_exclude_policies UUID[] DEFAULT '{}')
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT count(*)::INTEGER
    FROM policies pl
   WHERE pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
     AND (p_exclude_lineage IS NULL OR pl.lineage_id IS DISTINCT FROM p_exclude_lineage)
     AND NOT (pl.id = ANY (COALESCE(p_exclude_policies, '{}')))
     AND lineage_norm(p_term) <> ''
     AND position(lineage_norm(p_term) IN lineage_norm(COALESCE(pl.title, '') || ' ' || COALESCE(pl.description, ''))) > 0
$$;
COMMENT ON FUNCTION lineage_term_df IS '專有名詞（正規化後）在合格政見標題或說明裡出現的條數；不含 p_exclude_lineage 自己的政見與 p_exclude_policies。第五期往外擴用；第一期沒有任何函式呼叫它';

-- 一條脈絡涉及的人（政見持有人、立場持有人、參與者、交接雙方、事件推動者），合併過的算到保留那位；關係圖任期原料與一覽的人數共用
CREATE OR REPLACE VIEW lineage_people AS
SELECT DISTINCT x.lineage_id, COALESCE(p.merged_into, p.id) AS politician_id
  FROM (
    SELECT pl.lineage_id, pl.politician_id FROM policies pl
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
    UNION ALL SELECT lineage_id, politician_id FROM lineage_stances WHERE removed_at IS NULL
    UNION ALL SELECT lineage_id, politician_id FROM lineage_participants
    UNION ALL SELECT lineage_id, from_politician_id FROM handovers
    UNION ALL SELECT lineage_id, to_politician_id FROM handovers
    UNION ALL SELECT lineage_id, initiator_politician_id FROM lineage_events WHERE initiator_politician_id IS NOT NULL AND removed_at IS NULL
  ) x
  JOIN politicians p ON p.id = x.politician_id;
ALTER VIEW lineage_people SET (security_invoker = on);
GRANT SELECT ON lineage_people TO anon, authenticated;
COMMENT ON VIEW lineage_people IS '一條脈絡涉及的人（政見持有人、立場持有人、參與者、交接雙方、事件推動者；合併後算保留者）。lineage_terms 與 lineages_list 共用';

-- 關係圖的任期原料：涉及的人各取任期表 politician_offices 的列，再補上單席首長職位（縣市長、鄉鎮市長、區長）的**所有**歷任，讓泳道連得起來；
-- 多席職位（議員、立委）只列涉及的人。involved＝這一任的人本身涉及這條脈絡。把歷任裁到脈絡期間是第四期畫圖函式的事（純函式、可測），這裡不裁。
CREATE OR REPLACE VIEW lineage_terms AS
WITH inv AS (
  SELECT i.lineage_id, o.id AS office_id, o.election_type, rg.region, rg.sub_region
    FROM lineage_people i
    JOIN politicians p ON COALESCE(p.merged_into, p.id) = i.politician_id
    JOIN politician_offices o ON o.politician_id = p.id
    LEFT JOIN regions rg ON rg.id = o.region_id
),
seat AS (
  SELECT DISTINCT lineage_id, election_type, replace(region, '臺', '台') AS region, sub_region
    FROM inv
   WHERE election_type IN ('縣市長', '鄉鎮市長', '直轄市山地原住民區長') AND region IS NOT NULL
),
nb AS (
  SELECT s.lineage_id, o.id AS office_id
    FROM seat s
    JOIN regions rg ON replace(rg.region, '臺', '台') = s.region AND rg.sub_region IS NOT DISTINCT FROM s.sub_region
    JOIN politician_offices o ON o.region_id = rg.id AND o.election_type = s.election_type
),
ids AS (
  SELECT lineage_id, office_id, true AS involved FROM inv
  UNION ALL
  SELECT lineage_id, office_id, false FROM nb
),
u AS (
  SELECT lineage_id, office_id, bool_or(involved) AS involved FROM ids GROUP BY lineage_id, office_id
)
SELECT u.lineage_id, COALESCE(pp.merged_into, pp.id) AS politician_id, COALESCE(mp.name, pp.name) AS name,
       o.election_type, rg.region, rg.sub_region, o.start_date, o.scheduled_end_date, o.end_date, u.involved
  FROM u
  JOIN politician_offices o ON o.id = u.office_id
  JOIN politicians pp ON pp.id = o.politician_id
  LEFT JOIN politicians mp ON mp.id = pp.merged_into
  LEFT JOIN regions rg ON rg.id = o.region_id;
ALTER VIEW lineage_terms SET (security_invoker = on);
GRANT SELECT ON lineage_terms TO anon, authenticated;
COMMENT ON VIEW lineage_terms IS '關係圖的任期原料（#675）：脈絡涉及的人的任期＋單席首長職位的歷任；involved 標出誰本身涉及這條脈絡';

CREATE OR REPLACE VIEW lineages_full AS
SELECT
  l.id, l.title, l.summary, l.category, l.level, l.region, l.sub_region, l.admin_code, l.created_at, l.updated_at,
  COALESCE(
    (SELECT json_agg(pl.id ORDER BY e.election_date NULLS LAST, pl.proposed_date NULLS LAST, pl.id)
       FROM policies pl LEFT JOIN elections e ON e.id = pl.election_id
      -- >>> 只算合格的政見（那一屆已投票且當選；台北日期）：不合格的資料不動、讀取端不算（2026-10-19）
      WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)),
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
  ) AS links,
  -- >>> 現況（policy-ops#201 第 2 期）：現行＝最大 as_of 那一列；沒有就是 NULL（畫面不顯示）
  (SELECT json_build_object(
            'id', st.id, 'phase', st.phase, 'text', st.text, 'as_of', st.as_of,
            'source_url', st.source_url, 'source_locator', st.source_locator, 'source', source_brief('lineage_statuses', st.id::text))
     FROM lineage_statuses st
    WHERE st.lineage_id = l.id
    ORDER BY st.as_of DESC
    LIMIT 1) AS status,
  -- <<< 現況
  -- >>> #675 第一期：尾端加欄（前面的欄一個字不動）
  -- 涵蓋地方：合格政見依 lineage_policy_place 分組（主辦另看 level／region）
  lineage_coverage(l.id) AS coverage,
  l.search_terms,
  -- 脈絡本身（摘要的依據）的出處，主要的排前面；目前沒有任何列（還沒有交件寫它），先備好欄
  COALESCE(
    (SELECT json_agg(json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher, 'kind', s.source_kind, 'archive_url', s.archive_url, 'role', r.role)
            ORDER BY (r.role = 'primary') DESC, r.created_at, s.id)
       FROM source_refs r JOIN sources s ON s.id = r.source_id
      WHERE r.target_table = 'lineages' AND r.target_id = l.id::TEXT),
    '[]'::json
  ) AS sources,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', st.id, 'politician_id', COALESCE(pp.merged_into, st.politician_id), 'name', COALESCE(mp.name, pp.name), 'policy_id', st.policy_id,
              'disputed_at', st.disputed_at, 'dispute_note', st.dispute_note,
              'stance', st.stance, 'condition', st.condition_text, 'stated_on', st.stated_on, 'date_precision', st.date_precision,
              'quote', st.quote, 'note', st.note, 'source_url', st.source_url, 'source_locator', st.source_locator,
              'source', source_brief('lineage_stances', st.id::TEXT))
            ORDER BY st.stated_on, st.created_at, st.id)
       FROM lineage_stances st
       JOIN politicians pp ON pp.id = st.politician_id
       LEFT JOIN politicians mp ON mp.id = pp.merged_into
      WHERE st.lineage_id = l.id AND st.removed_at IS NULL),
    '[]'::json
  ) AS stances,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', ev.id, 'disputed_at', ev.disputed_at, 'dispute_note', ev.dispute_note, 'event_type', ev.event_type, 'occurred_on', ev.occurred_on, 'date_precision', ev.date_precision,
              'level', ev.level, 'region', ev.region, 'sub_region', ev.sub_region, 'decided_by', ev.decided_by, 'description', ev.description,
              'initiator', CASE WHEN ev.initiator_politician_id IS NULL THEN NULL
                                ELSE json_build_object('politician_id', COALESCE(ip.merged_into, ev.initiator_politician_id), 'name', COALESCE(im.name, ip.name), 'note', ev.initiator_note) END,
              'source_url', ev.source_url, 'source_locator', ev.source_locator, 'source', source_brief('lineage_events', ev.id::TEXT))
            ORDER BY ev.occurred_on, ev.created_at, ev.id)
       FROM lineage_events ev
       LEFT JOIN politicians ip ON ip.id = ev.initiator_politician_id
       LEFT JOIN politicians im ON im.id = ip.merged_into
      WHERE ev.lineage_id = l.id AND ev.removed_at IS NULL),
    '[]'::json
  ) AS events,
  -- 現況歷史共幾列（現行那一列在 status）
  (SELECT count(*)::INTEGER FROM lineage_statuses sc WHERE sc.lineage_id = l.id) AS status_count
  -- <<< #675 第一期
FROM lineages l;
ALTER VIEW lineages_full SET (security_invoker = on);
GRANT SELECT ON lineages_full TO anon, authenticated;
COMMENT ON VIEW lineages_full IS '政策脈絡一條一列（#349）：脈絡頁讀這個；政見只給 id（內容讀 policies_with_logs），參與者、交接、關聯各帶出處；status 是現行現況（policy-ops#201）；尾端 coverage（涵蓋地方）、search_terms、sources（脈絡本身的出處）、stances（立場）、events（事件）、status_count 是 #675 第一期加的。一覽頁改讀輕量的 lineages_list';

-- 一覽頁與全站快照用的輕量視圖：不帶子表 JSON（一條成熟的脈絡預估 20 KB，300 條就 6 MB，會塞進 /analysis 的 __INITIAL_STATE__）
CREATE OR REPLACE VIEW lineages_list AS
SELECT
  l.id, l.title, l.summary, l.category, l.level, l.region, l.sub_region, l.admin_code, l.created_at, l.updated_at,
  (SELECT count(*)::INTEGER FROM policies pl WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)) AS policy_count,
  (SELECT count(*)::INTEGER FROM lineage_people lp WHERE lp.lineage_id = l.id) AS people_count,
  (SELECT count(*)::INTEGER FROM handovers h WHERE h.lineage_id = l.id) AS handover_count,
  (SELECT count(*)::INTEGER FROM lineage_events ev WHERE ev.lineage_id = l.id AND ev.removed_at IS NULL) AS event_count,
  (SELECT count(*)::INTEGER FROM lineage_stances st WHERE st.lineage_id = l.id AND st.removed_at IS NULL) AS stance_count,
  lineage_coverage(l.id) AS coverage,
  cur.phase AS status_phase,
  cur.as_of AS status_as_of
FROM lineages l
LEFT JOIN LATERAL (
  SELECT x.phase, x.as_of FROM lineage_statuses x WHERE x.lineage_id = l.id ORDER BY x.as_of DESC LIMIT 1
) cur ON true;
ALTER VIEW lineages_list SET (security_invoker = on);
GRANT SELECT ON lineages_list TO anon, authenticated;
COMMENT ON VIEW lineages_list IS '政策脈絡一覽（#675 第一期）：標題、摘要、類別、主辦、updated_at、各種筆數（合格政見／涉及的人／交接／事件／立場）、涵蓋地方、現況的階段與截至日；不帶子表 JSON。前端遇到它不存在時退回 lineages_full';

-- ------------------------------------------------------------
-- 8. 人物合併與空殼清理連動（計畫 2.9）：新表有人物外鍵，合併路徑要同時到位
--    本體以 20261007020000 的現行定義為底，只多標記為 #675 的段落與一個回傳鍵；其餘一字不改（守門 lineage-stances-events.test.ts 逐段比對）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_politician(p_keep uuid, p_remove uuid, p_contribution uuid, p_agent text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_keep politicians%ROWTYPE; v_remove politicians%ROWTYPE;
  v_policies INTEGER := 0; v_elections INTEGER := 0; v_filled TEXT[] := ARRAY[]::TEXT[];
  v_participants INTEGER := 0; v_handovers INTEGER := 0; v_stances INTEGER := 0; v_events INTEGER := 0; v_new_from UUID; v_new_to UUID;
  r RECORD; k RECORD; v_pair TEXT; v_res_id UUID; v_field TEXT;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'keep 與 remove 是同一筆'; END IF;
  SELECT * INTO v_keep FROM politicians WHERE id = p_keep;
  SELECT * INTO v_remove FROM politicians WHERE id = p_remove;
  IF v_keep.id IS NULL OR v_remove.id IS NULL THEN RAISE EXCEPTION '找不到人物'; END IF;
  IF v_keep.merged_into IS NOT NULL THEN RAISE EXCEPTION '保留的那筆本身已被合併'; END IF;
  IF v_remove.merged_into IS NOT NULL THEN RAISE EXCEPTION '要併入的那筆已經合併過'; END IF;
  v_pair := politician_pair_key(p_keep, p_remove);

  -- 政見：每筆一列
  FOR r IN SELECT id FROM policies WHERE politician_id = p_remove LOOP
    UPDATE policies SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    v_policies := v_policies + 1;
  END LOOP;

  -- 參選紀錄：同一場已有 → keep 那列補空欄（每欄一列）、remove 那列整列記下再刪；沒有 → 整列搬過去
  FOR r IN SELECT * FROM politician_elections WHERE politician_id = p_remove LOOP
    SELECT * INTO k FROM politician_elections WHERE politician_id = p_keep AND election_id = r.election_id;
    IF k.id IS NOT NULL THEN
      FOREACH v_field IN ARRAY ARRAY['position', 'slogan', 'election_type', 'region_id', 'source_note'] LOOP
        IF to_jsonb(k)->v_field IS NULL OR to_jsonb(k)->v_field = 'null'::jsonb THEN
          IF to_jsonb(r)->v_field IS NOT NULL AND to_jsonb(r)->v_field <> 'null'::jsonb THEN
            -- 補空欄用 FROM 來源列、不用 $1.欄位：r 是匿名 RECORD，經 USING 傳進動態 SQL 之後讀不到欄位（could not identify column in record data type）
            EXECUTE format('UPDATE politician_elections AS tgt SET %I = src.%I FROM politician_elections AS src WHERE tgt.id = $1 AND src.id = $2', v_field, v_field) USING k.id, r.id;
            INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
            VALUES ('politician_elections', k.id::TEXT, v_field, NULL, to_jsonb(r)->v_field, p_contribution, p_agent);
          END IF;
        END IF;
      END LOOP;
      -- 結果（當選、落選）：keep 那列還沒有結果、remove 那列有，就補過去（以前的 election_result 就是這樣補空欄）；
      -- 登記階段與退選以 keep 為準，不互相覆蓋。得票數、得票率不再搬（#345：待刪、不再寫入）
      IF r.candidacy_status IN ('elected', 'not_elected')
         AND COALESCE(k.candidacy_status, '') NOT IN ('elected', 'not_elected') THEN
        UPDATE politician_elections SET candidacy_status = r.candidacy_status WHERE id = k.id;
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('politician_elections', k.id::TEXT, 'candidacy_status', to_jsonb(k.candidacy_status), to_jsonb(r.candidacy_status), p_contribution, p_agent);
      END IF;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_elections WHERE id = r.id;
    ELSE
      UPDATE politician_elections SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_elections := v_elections + 1;
  END LOOP;

  -- 身份鍵：keep 已有的整列記下再刪；其餘搬過去
  FOR r IN SELECT * FROM politician_keys kk WHERE kk.politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM politician_keys k2 WHERE k2.politician_id = p_keep AND k2.key_type = r.key_type AND k2.key_value = r.key_value) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_keys WHERE id = r.id;
    ELSE
      UPDATE politician_keys SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
  END LOOP;

  -- 政策脈絡的角色（#349）：同一條脈絡、同一種依據保留那位已經有的 → 整列記下再刪；其餘搬過去
  FOR r IN SELECT * FROM lineage_participants lp WHERE lp.politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM lineage_participants k3 WHERE k3.politician_id = p_keep AND k3.lineage_id = r.lineage_id AND k3.basis = r.basis) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM lineage_participants WHERE id = r.id;
    ELSE
      UPDATE lineage_participants SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_participants := v_participants + 1;
  END LOOP;

  -- 交接（#349）：前後任任何一端是併進來的人就改到保留那位；改完前後變成同一人同一屆、或跟已有的同一對任期撞鍵 → 整列記下再刪
  -- （任期表的對應 from_office_id／to_office_id 由觸發器 trg_handovers_fill_office 照新的人重算）
  FOR r IN SELECT * FROM handovers h WHERE h.from_politician_id = p_remove OR h.to_politician_id = p_remove LOOP
    v_new_from := CASE WHEN r.from_politician_id = p_remove THEN p_keep ELSE r.from_politician_id END;
    v_new_to := CASE WHEN r.to_politician_id = p_remove THEN p_keep ELSE r.to_politician_id END;
    IF (v_new_from = v_new_to AND r.from_election_id IS NOT DISTINCT FROM r.to_election_id)
       OR EXISTS (SELECT 1 FROM handovers h2
                   WHERE h2.id <> r.id AND h2.lineage_id = r.lineage_id
                     AND h2.from_politician_id = v_new_from AND h2.from_election_id IS NOT DISTINCT FROM r.from_election_id
                     AND h2.to_politician_id = v_new_to AND h2.to_election_id IS NOT DISTINCT FROM r.to_election_id) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('handovers', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM handovers WHERE id = r.id;
    ELSE
      UPDATE handovers SET from_politician_id = v_new_from, to_politician_id = v_new_to WHERE id = r.id;
      IF r.from_politician_id = p_remove THEN
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('handovers', r.id::TEXT, 'from_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
      END IF;
      IF r.to_politician_id = p_remove THEN
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('handovers', r.id::TEXT, 'to_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
      END IF;
    END IF;
    v_handovers := v_handovers + 1;
  END LOOP;

  -- >>> #675：政策脈絡的立場——同一條脈絡、同一天、同一句原文保留那位已經有一列 → 併進來的那列整列記進 edit_history 再刪；其餘改 politician_id（舊→新記一列履歷）
  FOR r IN SELECT * FROM lineage_stances s WHERE s.politician_id = p_remove LOOP
    IF r.removed_at IS NULL AND EXISTS (SELECT 1 FROM lineage_stances k4 WHERE k4.politician_id = p_keep AND k4.lineage_id = r.lineage_id AND k4.stated_on = r.stated_on
                                          AND k4.quote_hash = r.quote_hash AND k4.removed_at IS NULL) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_stances', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM lineage_stances WHERE id = r.id;
    ELSE
      UPDATE lineage_stances SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_stances', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_stances := v_stances + 1;
  END LOOP;

  -- 政策脈絡事件的推動者：沒有唯一鍵衝突，直接改，每列一筆履歷
  FOR r IN SELECT id FROM lineage_events WHERE initiator_politician_id = p_remove LOOP
    UPDATE lineage_events SET initiator_politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('lineage_events', r.id::TEXT, 'initiator_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    v_events := v_events + 1;
  END LOOP;
  -- <<< #675

  -- 提問、票的指認、審查的指認：每列一筆
  FOR r IN SELECT id FROM citizen_questions WHERE politician_id = p_remove LOOP
    UPDATE citizen_questions SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('citizen_questions', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM contribution_votes WHERE resolved_politician_id = p_remove::TEXT LOOP
    UPDATE contribution_votes SET resolved_politician_id = p_keep::TEXT WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('contribution_votes', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM politician_identity_reviews WHERE resolved_politician_id = p_remove LOOP
    UPDATE politician_identity_reviews SET resolved_politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_identity_reviews', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;

  -- 保留那筆的空欄用併入那筆補：每欄一列
  FOREACH v_field IN ARRAY ARRAY['birth_year', 'avatar_url', 'education_level', 'bio', 'current_position', 'sub_region', 'region'] LOOP
    IF (to_jsonb(v_keep)->v_field IS NULL OR to_jsonb(v_keep)->v_field = 'null'::jsonb)
       AND to_jsonb(v_remove)->v_field IS NOT NULL AND to_jsonb(v_remove)->v_field <> 'null'::jsonb THEN
      EXECUTE format('UPDATE politicians SET %I = $1.%I WHERE id = $2', v_field, v_field) USING v_remove, p_keep;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', p_keep::TEXT, v_field, NULL, to_jsonb(v_remove)->v_field, p_contribution, p_agent);
      v_filled := v_filled || v_field;
    END IF;
  END LOOP;

  -- 舊列留著、標記併入誰
  UPDATE politicians SET merged_into = p_keep WHERE id = p_remove;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', p_remove::TEXT, 'merged_into', NULL, to_jsonb(p_keep::TEXT), p_contribution, p_agent);

  -- 配對結論：整列記下（revert 會把它刪掉，這一對就會重新派任務）
  DELETE FROM politician_pair_resolutions WHERE pair_key = v_pair;
  INSERT INTO politician_pair_resolutions (pair_key, a, b, resolution, contribution_id)
  VALUES (v_pair, LEAST(p_keep, p_remove), GREATEST(p_keep, p_remove), 'same', p_contribution)
  RETURNING id INTO v_res_id;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  SELECT 'politician_pair_resolutions', v_res_id::TEXT, '*', NULL, to_jsonb(x), p_contribution, p_agent FROM politician_pair_resolutions x WHERE x.id = v_res_id;

  RETURN jsonb_build_object('moved_policies', v_policies, 'moved_elections', v_elections, 'filled', to_jsonb(v_filled),
                            'moved_participants', v_participants, 'moved_handovers', v_handovers,
                            'moved_stances', v_stances, 'moved_events', v_events);
END;
$$;
COMMENT ON FUNCTION merge_politician IS '軟合併：每個寫入各記一列 edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回；只由 apply 呼叫｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result｜2026-10-06：政策脈絡的角色（lineage_participants）與交接（handovers）一起搬（#349）｜2026-11-20：政策脈絡的立場（lineage_stances）與事件推動者（lineage_events）一起搬（#675）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_placeholder_politicians()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:placeholder_politician:' || p.id,
         'placeholder_politician',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'region', p.region, 'party', p.party,
                            'elections', (SELECT jsonb_agg(jsonb_build_object('id', pe.id, 'election_id', pe.election_id, 'election_type', pe.election_type,
                                                                              'candidacy_status', pe.candidacy_status, 'source_note', pe.source_note)
                                                           ORDER BY pe.election_id)
                                            FROM politician_elections pe WHERE pe.politician_id = p.id)),
         '人物「' || p.name || '」（' || COALESCE(p.region, '縣市未知') || '）的姓名看起來是測試資料，不像真的參選人。'
           || '請到中選會選舉資料庫、選委會公告與媒體查有沒有這個人：**查無此人** → 用 removal 型別回報，target_table 填 politicians、target_id 填「' || p.id
           || '」、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人連參選紀錄一起移除（留查核履歷、可還原）。'
           || '**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, p.region
    FROM politicians p
   WHERE p.merged_into IS NULL AND politician_name_is_placeholder(p.name)
     -- 已經有人交了移除這個人、還在等票的先不派
     AND NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT)
  UNION ALL
  -- 空殼：有一筆參選紀錄被 reassign_candidacy 改掛走（沒被還原），而且現在名下什麼都沒有。
  -- 姓名像測試資料的由上面那一種派，這裡不重複（task_id 同一種格式，會撞號）
  SELECT 'auto:placeholder_politician:' || p.id,
         'placeholder_politician',
         jsonb_build_object('kind', 'orphan', 'politician_id', p.id, 'name', p.name, 'region', p.region, 'party', p.party, 'elections', '[]'::JSONB,
                            'reassigned', (SELECT jsonb_agg(DISTINCT jsonb_build_object('politician_election_id', h.record_id,
                                                                                         'contribution_id', h.contribution_id))
                                             FROM edit_history h
                                            WHERE h.table_name = 'politician_elections' AND h.field = 'politician_id'
                                              AND h.old_value = to_jsonb(p.id::TEXT) AND h.reverted_at IS NULL)),
         '人物「' || p.name || '」（' || COALESCE(p.region, '縣市未知') || '）名下已經沒有任何參選紀錄、政見、任期、學經歷、公民提問或政策脈絡——'
           || '他的參選紀錄被確認掛錯人、改掛到別的同名的人身上之後，這一位就成了空殼。'
           || '請到中選會選舉資料庫、選委會公告與媒體查有沒有這個人（別屆、別地方有沒有參選或任職）：**查無此人** → 用 removal 型別回報，target_table 填 politicians、target_id 填「' || p.id
           || '」、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人移除（留查核履歷、可還原）。'
           || '**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面，並用對應的型別補上他的參選紀錄或政見。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, p.region
    FROM politicians p
   WHERE p.merged_into IS NULL AND NOT politician_name_is_placeholder(p.name)
     AND EXISTS (SELECT 1 FROM edit_history h JOIN contributions rc ON rc.id = h.contribution_id AND rc.contribution_type = 'reassign_candidacy'
                  WHERE h.table_name = 'politician_elections' AND h.field = 'politician_id'
                    AND h.old_value = to_jsonb(p.id::TEXT) AND h.reverted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM policies x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM politician_offices x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM politician_careers x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM citizen_questions x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM lineage_participants x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM handovers x WHERE x.from_politician_id = p.id OR x.to_politician_id = p.id)
     -- >>> #675：名下只剩一筆立場、或只是某個事件的推動者，不算空殼
     AND NOT EXISTS (SELECT 1 FROM lineage_stances x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM lineage_events x WHERE x.initiator_politician_id = p.id)
     -- <<< #675
     AND NOT EXISTS (SELECT 1 FROM politicians x WHERE x.merged_into = p.id)
     AND NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_placeholder_politicians IS
  '姓名看起來是測試資料的人物（politician_name_is_placeholder），新任務型別 placeholder_politician，查無此人就交 removal（2026-10-06）｜'
  '同日加「空殼」那一種（target.kind＝orphan）：參選紀錄被 reassign_candidacy 改掛走、現在名下什麼都沒有的人，走同一條移除流程，不直接刪｜2026-11-20：空殼的判斷把立場與事件推動者也算進「名下還有東西」（#675）';

NOTIFY pgrst, 'reload schema';
