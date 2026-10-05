-- 人物的「最新一屆」衍生欄位：修好同步觸發器、改成合理的規則、照新規則重算一次（2026-10-05，#348 後續）
--
-- politicians 的 position／slogan／election_type／region_id 是衍生欄位：由 politician_elections 上的
-- trg_sync_politician_latest 照「最新一屆參選紀錄」寫回來（20260130000005）。視圖 politicians_with_elections
-- 的頂層縣市／鄉鎮／村里就是用 region_id 接 regions 算的，選舉別也是。
--
-- 壞在哪：觸發器用 `IF v_latest IS NOT NULL` 判斷有沒有找到紀錄，而紀錄型別的 IS NOT NULL 要「四個欄位全部非空」
-- 才成立。口號（slogan）幾乎都是空的——10-05 線上 16,214 位有參選紀錄的人，最新一屆口號是空的有 16,213 位——
-- 所以這個觸發器實際上從來沒同步過：人物的四個欄位停在當初匯入時的值，之後新增、補正的參選紀錄都沒寫回來。
-- 10-05 唯讀：人物的 region_id 跟最新一屆不同的 571 位、選舉別不同的 561 位、position 不同的 617 位
-- （多數是 2026 新登記的人：人物表的選舉別與地區指標是空的，參選紀錄早就有了）。
--
-- 新規則（觸發器與下面的重算用同一支 politician_latest_election()）：
--   ① 「最新一屆」＝最近一屆**有在選**的參選紀錄：表態不參選（candidate_status = not_running）排最後，
--      全部都是表態不參選才用最近那一筆。跟前端 mapPolitician 組人物職稱的規則一致（最近一筆非 not_running）。
--      理由：2022 當選的議員 2026 被傳要選縣市長、後來表態不選，那筆 not_running 的選舉別是縣市長、地區只到縣市；
--      拿它當人物的最新一屆，會把現任議員的選舉別改成縣市長、地區指標從議員選區退到縣市
--      （10-05：最近一筆是表態不參選、另有參選紀錄的 84 位，選舉別會被改 59 位、地區指標 82 位）。
--   ② 那一筆有值的欄位寫進人物，空的欄位保留人物現值（跟原本的 COALESCE 相同）。
--   ③ 判斷「有沒有找到」用 FOUND，不用紀錄型別的 IS NOT NULL。
--   ④ 值沒有變就不 UPDATE（不必要地觸發人物表上的統計與身份觸發器）；改參選紀錄的 politician_id 時，舊的那位也重算。
--
-- 重算：照新規則把現有人物重算一次，10-05 唯讀預估 941 位有變動（region_id 545，其中 371 位原本是空的；
-- 選舉別 505、position 538、口號 0；937 位的依據是 2026 參選紀錄）。**只改這四個衍生欄位，不改參選紀錄本身。**
-- 每個改動的欄位寫一筆 edit_history（agent_name = latest-election-sync），舊值在 old_value，可照著還原。
--
-- 連帶：人物表的統計觸發器（trg_region_politician_stats）會因選舉別改變，把統計從舊選舉別搬到新選舉別；
-- 「加統計」找不到地區列時會按人物文字欄新建一列（#348 已知、待裁示），10-05 唯讀查到這次會長出 3 列對不上的組合
-- （人物文字欄寫著「新北市／新北市第12選舉區」「新竹市／臺中市第05選區」「台北市／高雄市第08選區」）。
-- 這支只刪「這次新長出來、落在 region_audit、沒有任何資料指著」的列，跟 #348 的清理同一條規則，刪掉的整列存在 edit_history。

CREATE OR REPLACE FUNCTION politician_latest_election(p_politician_id UUID)
-- "position" 要加引號：它是 SQL 關鍵字，當函式的輸出欄名不加引號會語法錯誤（PGlite 實跑抓到）
RETURNS TABLE (election_id INTEGER, candidate_status TEXT, "position" TEXT, slogan TEXT, election_type TEXT, region_id INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT pe.election_id, pe.candidate_status, pe."position", pe.slogan, pe.election_type, pe.region_id
    FROM politician_elections pe
   WHERE pe.politician_id = p_politician_id
   ORDER BY (COALESCE(pe.candidate_status, '') = 'not_running'), pe.election_id DESC
   LIMIT 1
$$;
COMMENT ON FUNCTION politician_latest_election IS
  '人物的「最新一屆」：最近一屆有在選的參選紀錄（表態不參選排最後，全部都是表態不參選才用最近一筆）。'
  'politicians 的 position／slogan／election_type／region_id 由它衍生（trg_sync_politician_latest），2026-10-05';

CREATE OR REPLACE FUNCTION sync_politician_latest_election()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_ids UUID[];
  v_id UUID;
  v_latest RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.politician_id];
  ELSIF TG_OP = 'UPDATE' AND OLD.politician_id IS DISTINCT FROM NEW.politician_id THEN
    -- 參選紀錄換了人（合併人物、改指認）：新舊兩位都要重算
    v_ids := ARRAY[NEW.politician_id, OLD.politician_id];
  ELSE
    v_ids := ARRAY[NEW.politician_id];
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_latest FROM politician_latest_election(v_id);
    -- 用 FOUND，不用 `v_latest IS NOT NULL`：紀錄型別的 IS NOT NULL 要每個欄位都非空才成立，
    -- 口號幾乎都是空的，舊寫法讓這個觸發器實際上從來沒同步過（2026-10-05）
    IF FOUND THEN
      UPDATE politicians p SET
        position      = COALESCE(v_latest.position, p.position),
        slogan        = COALESCE(v_latest.slogan, p.slogan),
        election_type = COALESCE(v_latest.election_type, p.election_type::TEXT),
        region_id     = COALESCE(v_latest.region_id, p.region_id)
      WHERE p.id = v_id
        AND (p.position IS DISTINCT FROM COALESCE(v_latest.position, p.position)
          OR p.slogan IS DISTINCT FROM COALESCE(v_latest.slogan, p.slogan)
          OR p.election_type::TEXT IS DISTINCT FROM COALESCE(v_latest.election_type, p.election_type::TEXT)
          OR p.region_id IS DISTINCT FROM COALESCE(v_latest.region_id, p.region_id));
    END IF;
    -- 紀錄全刪光的人：沒有可依據的一屆，四個欄位維持原值（跟原本一樣）
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION sync_politician_latest_election() IS
  'politicians 的 position／slogan／election_type／region_id 照 politician_latest_election() 同步（有值才寫、空的保留現值）。'
  '2026-10-05 修：原本用紀錄型別 IS NOT NULL 判斷，口號空的就整筆不同步，實際上從來沒同步過。';

-- ------------------------------------------------------------
-- 照新規則重算一次
-- ------------------------------------------------------------
DO $$
DECLARE
  v_max_region INTEGER;
  n_people INTEGER;
  n_fields INTEGER;
  n_regions INTEGER;
BEGIN
  SELECT COALESCE(max(id), 0) INTO v_max_region FROM regions;

  CREATE TEMP TABLE _latest_sync ON COMMIT DROP AS
  SELECT p.id,
         p.position AS old_position, p.slogan AS old_slogan, p.election_type::TEXT AS old_election_type, p.region_id AS old_region_id,
         COALESCE(l.position, p.position) AS new_position,
         COALESCE(l.slogan, p.slogan) AS new_slogan,
         COALESCE(l.election_type, p.election_type::TEXT) AS new_election_type,
         COALESCE(l.region_id, p.region_id) AS new_region_id
    FROM politicians p
    CROSS JOIN LATERAL politician_latest_election(p.id) l;
  DELETE FROM _latest_sync s
   WHERE s.old_position IS NOT DISTINCT FROM s.new_position
     AND s.old_slogan IS NOT DISTINCT FROM s.new_slogan
     AND s.old_election_type IS NOT DISTINCT FROM s.new_election_type
     AND s.old_region_id IS NOT DISTINCT FROM s.new_region_id;

  UPDATE politicians p
     SET position = s.new_position, slogan = s.new_slogan, election_type = s.new_election_type, region_id = s.new_region_id
    FROM _latest_sync s
   WHERE p.id = s.id;
  GET DIAGNOSTICS n_people = ROW_COUNT;

  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  SELECT 'politicians', s.id::TEXT, f.field, f.old_value, f.new_value, 'latest-election-sync'
    FROM _latest_sync s
    CROSS JOIN LATERAL (VALUES
      ('position',      to_jsonb(s.old_position),      to_jsonb(s.new_position)),
      ('slogan',        to_jsonb(s.old_slogan),        to_jsonb(s.new_slogan)),
      ('election_type', to_jsonb(s.old_election_type), to_jsonb(s.new_election_type)),
      ('region_id',     to_jsonb(s.old_region_id),     to_jsonb(s.new_region_id))
    ) AS f(field, old_value, new_value)
   WHERE f.old_value IS DISTINCT FROM f.new_value;
  GET DIAGNOSTICS n_fields = ROW_COUNT;

  -- 統計觸發器這次新長出來、對不上任何東西的地區列（見檔頭「連帶」）
  WITH gone AS (
    DELETE FROM regions r
     WHERE r.id > v_max_region
       AND r.id IN (SELECT a.id FROM region_audit a)
       AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
    RETURNING r.*
  )
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  SELECT 'regions', gone.id::TEXT, '*', to_jsonb(gone), NULL, 'latest-election-sync' FROM gone;
  GET DIAGNOSTICS n_regions = ROW_COUNT;

  RAISE NOTICE '人物最新一屆重算：% 位、% 個欄位有變動；統計觸發器新長出的對不上地區列刪掉 % 列', n_people, n_fields, n_regions;
END $$;
