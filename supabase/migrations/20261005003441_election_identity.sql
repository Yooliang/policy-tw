-- 選舉的新識別與欄位（#344 第一階段：只加不刪）
-- ============================================================
--
-- 為什麼：elections.id 就是投票年份（2022／2024／2026），被參選紀錄、政見、選舉區對照、中選會名單、
-- 各 RPC、前端路由、預渲染、邊緣 Worker、協議（skill.md）大量當「年份」用。年份存不下：
--   - 補選、罷免投票、重行選舉（2022 嘉義市長選舉延到 12-18 重行選舉，中選會名單同步至今抓不到那一場）
--   - 同一年兩場（2008 年立委 1 月、總統 3 月）
-- 日本站（政策の系譜）的 elections.id 是「日期＿種類＿地區」字串。這裡先把新識別加上去、舊的不動，
-- 讀取端第二階段才切（盤點清單見 PR 說明）。
--
-- 做了什麼（全部只加）：
--   1. election_key：一場選舉的新識別，格式「投票日_種類[_地區代碼]」，例：2022-11-26_local。
--      建立後不改（網址會用到）：事後發現日期或種類填錯，只改欄位、不改 election_key（日本站同一條規則）。
--      新增的列沒給就由觸發器依投票日、事由、職位自動產生。
--   2. election_reason：選舉事由（定期改選／補選／罷免投票／重行選舉）。
--   3. election_types：這次選哪些職位，直接存在選舉上（取代 election_types 表；那張表第二階段才刪，
--      過渡期間它一有異動就由觸發器同步到這一欄）。
--   4. notice_date（選舉公告日）、turnout（投票率）：先加欄位，值走流程補（沒有可靠來源前留空）。
--   5. 欄位說明（COMMENT）寫清楚 id、start_date、end_date 的實際語意與誰還在讀。
--
-- 刻意沒做的：
--   - 不改 elections.id、不改任何外鍵：id 留著當內部整數主鍵（舊三筆剛好等於年份），之後新增的選舉
--     照序號拿 id（不再是年份），對外識別與網址用 election_key。這樣十幾張表的 election_id 欄不用搬。
--   - 不把 2022 九合一拆成「一種職位一場」：台灣的定期選舉是同一天、同一份公告、多種職位
--     （中選會正式名稱就是「111年地方公職人員選舉」），網址 /election/2022 也是這一層；而且前端會把
--     elections 每一列都預渲染成一頁、放進網站地圖，第一階段多出列就會改到線上。職位層級的事實
--     （選舉區、應選名額、同額競選）放在下一支的 election_districts。
--   - 不加名實相符的「投票日」新欄：election_date 本來就是投票日、名實相符；名不副實的是 end_date
--     （三筆都存投票日，但 candidate-import 新建選舉時寫的是 12-31）。讀 end_date 的地方第二階段改讀
--     election_date，之後刪 end_date。再加一欄只會多一份要保持一致的投票日。
--   - 不在選舉上加 seats、is_uncontested：台灣的應選名額與同額競選都是「每個選舉區」的事實
--     （九合一一場就有上萬席、幾千個選舉區），放在 election_districts。
--
-- 錯了的代價：election_key 的種類寫錯（例如之後有人用舊的 findOrCreateElection 建了一場總統選舉，
-- 自動產生成 _local），因為建立後不改，只能留著並在 name 寫清楚；所以第二階段新增選舉的寫入端要明給 key。

-- 引用到的既有欄位（10-05 唯讀查詢確認存在）：
--   elections(id, name, short_name, start_date, end_date, election_date)
--   election_types(id, election_id, type)

-- ── 1. 欄位 ──────────────────────────────────────────────────────
ALTER TABLE elections ADD COLUMN IF NOT EXISTS election_key TEXT;
ALTER TABLE elections ADD COLUMN IF NOT EXISTS election_reason TEXT NOT NULL DEFAULT 'regular';
ALTER TABLE elections ADD COLUMN IF NOT EXISTS election_types TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE elections ADD COLUMN IF NOT EXISTS notice_date DATE;
ALTER TABLE elections ADD COLUMN IF NOT EXISTS turnout NUMERIC(5, 2);

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_election_reason_check;
ALTER TABLE elections ADD CONSTRAINT elections_election_reason_check
  CHECK (election_reason IN ('regular', 'by_election', 'recall', 'rerun'));

-- 九種職位（跟 contribution-schema.ts 的 ELECTION_TYPES 同一份；改一邊 CI 會紅）
ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_election_types_check;
ALTER TABLE elections ADD CONSTRAINT elections_election_types_check
  CHECK (election_types <@ ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[]);

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_turnout_check;
ALTER TABLE elections ADD CONSTRAINT elections_turnout_check
  CHECK (turnout IS NULL OR (turnout >= 0 AND turnout <= 100));

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_notice_date_check;
ALTER TABLE elections ADD CONSTRAINT elections_notice_date_check
  CHECK (notice_date IS NULL OR notice_date <= election_date);

-- ── 2. election_key 怎麼產生 ─────────────────────────────────────
-- 種類：定期改選分「local」（地方公職人員：縣市長、議員、鄉鎮市長、代表、村里長）與「national」
-- （中央公職：總統副總統、立法委員）；其他事由各自一個字：by（補選）、recall（罷免投票）、rerun（重行選舉）。
-- 地區代碼只有「不是全國同日」的選舉才加（內政部行政區代碼，admin_divisions.code），由建立的人明給；
-- 自動產生只管前兩段。
CREATE OR REPLACE FUNCTION election_key_for(p_date DATE, p_reason TEXT, p_types TEXT[], p_area TEXT DEFAULT NULL)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(p_date, 'YYYY-MM-DD') || '_' ||
    CASE COALESCE(p_reason, 'regular')
      WHEN 'by_election' THEN 'by'
      WHEN 'recall' THEN 'recall'
      WHEN 'rerun' THEN 'rerun'
      ELSE CASE WHEN cardinality(COALESCE(p_types, '{}')) > 0 AND p_types <@ ARRAY['總統副總統', '立法委員']::TEXT[]
                THEN 'national' ELSE 'local' END
    END ||
    COALESCE('_' || NULLIF(btrim(p_area), ''), '')
$$;
COMMENT ON FUNCTION election_key_for IS '選舉識別 election_key 的產生規則：投票日_種類[_地區代碼]（#344）';

-- 職位排序：跟網站分層、cec-sync 的 OUR_ELECTION_TYPES 同一個順序（總統 → 村里長）
CREATE OR REPLACE FUNCTION election_types_sorted(p_types TEXT[])
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(array_agg(t ORDER BY array_position(
           ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[], t)), '{}')
  FROM (SELECT DISTINCT unnest(p_types) AS t) s
$$;

-- ── 3. 回填既有三筆 ──────────────────────────────────────────────
UPDATE elections e
SET election_types = election_types_sorted(s.types)
FROM (SELECT election_id, array_agg(type::TEXT) AS types FROM election_types GROUP BY election_id) s
WHERE s.election_id = e.id
  AND e.election_types IS DISTINCT FROM election_types_sorted(s.types);

UPDATE elections
SET election_key = election_key_for(election_date, election_reason, election_types)
WHERE election_key IS NULL;

-- 回填結果核一次：三筆要剛好是這三個鍵（投票日或職位跟預期不同就整支退回，不要默默產生別的鍵）
DO $$
DECLARE
  v_got TEXT;
BEGIN
  SELECT string_agg(id || '=' || election_key, ',' ORDER BY id) INTO v_got
  FROM elections WHERE id IN (2022, 2024, 2026);
  IF v_got IS DISTINCT FROM '2022=2022-11-26_local,2024=2024-01-13_national,2026=2026-11-28_local' THEN
    RAISE EXCEPTION '#344 election_key 回填結果不是預期的三筆：%', v_got;
  END IF;
END $$;

ALTER TABLE elections ALTER COLUMN election_key SET NOT NULL;
ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_election_key_key;
ALTER TABLE elections ADD CONSTRAINT elections_election_key_key UNIQUE (election_key);
ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_election_key_format;
ALTER TABLE elections ADD CONSTRAINT elections_election_key_format
  CHECK (election_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}_(local|national|by|recall|rerun)(_[0-9A-Za-z-]+)?$');

-- ── 4. 觸發器：新列自動給鍵、鍵建立後不改 ─────────────────────────
-- 舊的寫入端（candidate-import.ts 的 findOrCreateElection）新建選舉時不會給 election_key，
-- 沒有這個觸發器那支會被 NOT NULL 擋掉。
CREATE OR REPLACE FUNCTION elections_key_guard()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.election_types := election_types_sorted(NEW.election_types);
  IF TG_OP = 'INSERT' THEN
    IF NEW.election_key IS NULL OR btrim(NEW.election_key) = '' THEN
      NEW.election_key := election_key_for(NEW.election_date, NEW.election_reason, NEW.election_types);
    END IF;
  ELSIF NEW.election_key IS DISTINCT FROM OLD.election_key THEN
    RAISE EXCEPTION 'election_key 建立後不改（%，網址會用到）；日期或種類填錯只改欄位', OLD.election_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elections_key_guard ON elections;
CREATE TRIGGER trg_elections_key_guard
  BEFORE INSERT OR UPDATE ON elections
  FOR EACH ROW EXECUTE FUNCTION elections_key_guard();

-- ── 5. 過渡期：election_types 表一有異動就同步到 elections.election_types ──
-- 目前沒有任何寫入端寫這張表（10-05 盤點：只有 migration），這條是保險：第二階段讀取端改讀陣列、
-- 刪表之前，兩份不會走鐘。
CREATE OR REPLACE FUNCTION sync_election_types_array()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_ids INTEGER[] := '{}';
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_ids := v_ids || OLD.election_id; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_ids := v_ids || NEW.election_id; END IF;
  UPDATE elections e
  SET election_types = election_types_sorted(COALESCE(
        (SELECT array_agg(t.type::TEXT) FROM election_types t WHERE t.election_id = e.id), '{}'))
  WHERE e.id = ANY (v_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_election_types_array ON election_types;
CREATE TRIGGER trg_sync_election_types_array
  AFTER INSERT OR UPDATE OR DELETE ON election_types
  FOR EACH ROW EXECUTE FUNCTION sync_election_types_array();

-- ── 6. 欄位說明 ──────────────────────────────────────────────────
COMMENT ON COLUMN elections.id IS
  '內部整數主鍵。舊的三筆（2022、2024、2026）剛好等於投票年份，大量讀取端把它當年份用（#344 盤點）；之後新增的選舉照序號拿 id、不保證是年份。對外識別與網址改用 election_key';
COMMENT ON COLUMN elections.election_key IS
  '一場選舉的識別：投票日_種類[_地區代碼]。種類 local＝地方公職人員定期改選、national＝總統副總統／立委定期改選、by＝補選、recall＝罷免投票、rerun＝重行選舉；地區代碼是內政部行政區代碼，只有不是全國同日的才加。建立後不改（#344）';
COMMENT ON COLUMN elections.election_reason IS
  '選舉事由：regular 定期改選、by_election 補選、recall 罷免投票、rerun 重行選舉（#344）';
COMMENT ON COLUMN elections.election_types IS
  '這次選哪些職位（九種之一的清單，依網站分層排序）。直接存在選舉上，取代 election_types 表；過渡期間由觸發器從那張表同步（#344）';
COMMENT ON COLUMN elections.notice_date IS
  '選舉公告日（選舉委員會發布選舉公告那天，候選人登記期間由這份公告訂定）。空白＝還沒查證（#344）';
COMMENT ON COLUMN elections.turnout IS
  '投票率（百分比，0–100），投票前為空。同日合併舉行多種職位時，填中選會公告的第一順位職位（總統副總統；直轄市長及縣市長）的全國投票率；各選舉區的數字不放這裡（#344）';
COMMENT ON COLUMN elections.election_date IS '投票日（名實相符；取代 end_date）';
COMMENT ON COLUMN elections.start_date IS
  '前端「目前選舉」區間的起點（getActiveElection），不是法定日期';
COMMENT ON COLUMN elections.end_date IS
  '名不副實：既有三筆存的是投票日（跟 election_date 相同），candidate-import 新建選舉時卻寫 12-31。前端 getActiveElection 拿它當「目前選舉」區間的終點，所以投票隔天導覽列就會退回第一筆。第二階段讀取端改讀 election_date 後刪除（#344）';
COMMENT ON TABLE election_types IS
  '舊表：每場選舉有哪些職位。已改存在 elections.election_types（觸發器同步），第二階段讀取端切過去後刪除（#344）';

NOTIFY pgrst, 'reload schema';
