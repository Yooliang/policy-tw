-- 清 regions 的髒列（#348 第一階段，接在 20261005000480 補官方代碼之後）
-- ============================================================
--
-- 小良哥 2026-10-05 裁示 regions 表的髒列要清。前一支補完官方代碼之後，對不上官方行政區、也不是選舉區、
-- 也不是中選會名單上的歷屆村里的列（視圖 region_audit）在 10-05 線上有 17 列，另加 1 列選區名冊沒有的議員選區，
-- 共 18 列，分六類：
--
--   類別                                   列數  有掛資料  處理
--   全國重複（「全國／全國」）                  1      1  引用搬到「全國」那一列（2024 總統副總統 6 筆參選紀錄）
--   議員選區的俗名（台北市 中山大同區 等）       6      6  引用搬到同一個選區的正式列（第04選舉區…），
--                                                      依據是選舉區對照表（electoral_district_areas）2022 與 2026 兩屆的鄉鎮組成
--   鄉鎮不在這個縣市（屏東縣 東勢區 等）         5      3  有掛資料的退到同縣市的縣市層級列；沒掛的刪
--   村里不存在（宜蘭市 新豐里 等）              2      1  有掛資料的退到同一鄉鎮的鄉鎮層級列；沒掛的刪
--   其他寫法錯誤（測試市、第2選舉區、
--     台北市底下的「高雄市第03選區」）          3      0  刪
--   選區名冊沒有的議員選區（金門縣 第04選舉區）  1      0  刪
--
-- 「搬引用」只動 politician_elections.region_id 與 politicians.region_id 兩個指標，而且**縣市一律不變**：
--   - 俗名 → 正式選區：同一個地方的兩種寫法（中山大同區＝第04選舉區），縣市、選區都不變。
--   - 鄉鎮不在這個縣市 → 縣市層級：只拿掉證明是錯的那一段（屏東縣沒有東勢區），留下縣市；
--     這幾筆都是同名的人資料混在一起（例：2026 屏東縣長參選人蘇清泉，掛到的是台中市東勢區隆興里
--     另一位蘇清泉里長的地區），人本身該在哪一區不是這支 migration 決定的。
--   - 村里不存在 → 鄉鎮層級：同理（宜蘭市長陳美玲掛到的「宜蘭市 新豐里」是南投草屯另一位陳美玲的里）。
-- 人物本身的縣市或選區錯了，照 10-05 常設裁決走任務流程：縣市議員退到縣市層級後，
-- contribution_auto_tasks_region_gap（20261005000400）本來就會派「補選區」任務，中選會名單上全國同名唯一時
-- 會附「中選會記的是哪裡」當線索。這支不改任何人物的文字欄（region／sub_region／village）。
--
-- 每一筆改動逐列寫進 edit_history（agent_name＝regions-cleanup-348），刪掉的 regions 列整列存在 old_value，
-- 要退回可以照著還原。
--
-- 防再發：update_region_stats 在「扣統計」時找不到列會新建一列——人物的文字欄一改，舊的錯誤組合
-- （例：屏東縣 東勢區）就會被扣統計這一步重新建出來。改成扣的時候找不到就跳過。
--
-- 沒處理、留給後續的：
--   - 縣市議員的原住民選區（台北市第07、第08選舉區等 17 列）：選舉區對照表不收、cec_candidates 的 2022 議員名單
--     裡也一個原住民選區都沒有，但 2026 登記名冊上有，也在 COUNCIL_ABORIGINAL_DISTRICTS 裡，是真的選區，不動。
--   - 人物文字欄裡的錯誤組合（蘇清泉的 sub_region 還是「東勢區」）：#328 淘汰人物表地區欄時一起處理。

-- ------------------------------------------------------------
-- 防再發：扣統計時找不到列就跳過，不要新建
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_region_stats(
  p_region TEXT,
  p_sub_region TEXT,
  p_village TEXT,
  p_stat_column TEXT,
  p_delta INTEGER
)
RETURNS VOID AS $$
DECLARE
  v_sql TEXT;
  v_region_id INTEGER;
BEGIN
  IF p_stat_column IS NULL OR p_region IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_region_id
  FROM regions
  WHERE region = p_region
    AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
    AND COALESCE(village, '') = COALESCE(p_village, '');

  IF v_region_id IS NULL THEN
    -- 扣統計（人物刪除或地區改掉）時找不到列：本來就沒有可扣的，跳過。
    -- 以前這裡會新建一列再扣成 0，被清掉的錯誤組合就這樣長回來（#348）。
    IF p_delta < 0 THEN
      RETURN;
    END IF;

    INSERT INTO regions (region, sub_region, village, total_politicians)
    VALUES (p_region, p_sub_region, p_village, 0)
    ON CONFLICT (region, sub_region, village) DO NOTHING
    RETURNING id INTO v_region_id;

    IF v_region_id IS NULL THEN
      SELECT id INTO v_region_id
      FROM regions
      WHERE region = p_region
        AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
        AND COALESCE(village, '') = COALESCE(p_village, '');
    END IF;
  END IF;

  v_sql := format(
    'UPDATE regions SET
       total_politicians = GREATEST(0, total_politicians + $1),
       %I = GREATEST(0, %I + $1),
       updated_at = NOW()
     WHERE id = $2',
    p_stat_column, p_stat_column
  );

  EXECUTE v_sql USING p_delta, v_region_id;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 有掛資料的髒列：引用搬到哪一列
-- ------------------------------------------------------------
-- kind：alias＝同一個地方的另一種寫法；county＝鄉鎮不在這個縣市，退到縣市層級；town＝村里不存在，退到鄉鎮層級
CREATE TEMP TABLE _region_move (
  kind TEXT, from_region TEXT, from_sub TEXT, from_village TEXT, to_region TEXT, to_sub TEXT, to_village TEXT, why TEXT
) ON COMMIT DROP;
INSERT INTO _region_move VALUES
  ('alias',  '全國',   '全國',         NULL,     '全國',   NULL,         NULL, '全國重複：全國層級的列是 sub_region 空的那一列'),
  ('alias',  '台北市', '中山大同區',   NULL,     '台北市', '第04選舉區', NULL, '議員選區俗名'),
  ('alias',  '台北市', '中正萬華區',   NULL,     '台北市', '第05選舉區', NULL, '議員選區俗名'),
  ('alias',  '台北市', '松山信義區',   NULL,     '台北市', '第03選舉區', NULL, '議員選區俗名'),
  ('alias',  '台北市', '大安文山區',   NULL,     '台北市', '第06選舉區', NULL, '議員選區俗名'),
  ('alias',  '苗栗縣', '後龍造橋竹南', NULL,     '苗栗縣', '第04選舉區', NULL, '議員選區俗名'),
  ('alias',  '苗栗縣', '頭份三灣南庄', NULL,     '苗栗縣', '第05選舉區', NULL, '議員選區俗名'),
  ('county', '屏東縣', '東勢區',       '隆興里', '屏東縣', NULL,         NULL, '東勢區在台中市，不在屏東縣'),
  ('county', '台北市', '八德區',       '大強里', '台北市', NULL,         NULL, '八德區在桃園市，不在台北市'),
  ('county', '桃園市', '大林鎮',       NULL,     '桃園市', NULL,         NULL, '大林鎮在嘉義縣，不在桃園市'),
  ('town',   '宜蘭縣', '宜蘭市',       '新豐里', '宜蘭縣', '宜蘭市',     NULL, '宜蘭市沒有新豐里（內政部現行與中選會歷屆名單都沒有）');

CREATE TEMP TABLE _region_repoint (from_id INTEGER PRIMARY KEY, to_id INTEGER NOT NULL, why TEXT) ON COMMIT DROP;

DO $$
DECLARE
  m RECORD;
  v_from INTEGER;
  v_to INTEGER;
  v_ok BOOLEAN;
  v_stem TEXT;
BEGIN
  FOR m IN SELECT * FROM _region_move LOOP
    SELECT id INTO v_from FROM regions
     WHERE region = m.from_region AND sub_region IS NOT DISTINCT FROM m.from_sub AND village IS NOT DISTINCT FROM m.from_village;
    IF v_from IS NULL THEN
      RAISE NOTICE '已經不在了，跳過：% % %', m.from_region, m.from_sub, COALESCE(m.from_village, '');
      CONTINUE;
    END IF;
    SELECT id INTO v_to FROM regions
     WHERE region = m.to_region AND sub_region IS NOT DISTINCT FROM m.to_sub AND village IS NOT DISTINCT FROM m.to_village;

    -- 每一類各自再核一次「它真的是錯的、搬過去的那列真的是對的」。核不過就不搬（記警告），
    -- 不整支退回：db push 失敗會連帶擋住函式部署（10-05 才因為一支 migration 擋過整條部署）。
    IF m.kind = 'alias' AND m.from_region = '全國' THEN
      v_ok := v_to IS NOT NULL;
    ELSIF m.kind = 'alias' THEN
      -- 俗名的每個鄉鎮（去掉區／鄉／鎮／市）都要出現在名字裡、字數剛好用完，而且 2022、2026 兩屆的
      -- 選舉區對照表都是這樣分（兩屆都有、組成一樣），才算同一個選區
      v_stem := regexp_replace(m.from_sub, '區$', '');
      SELECT count(*) = 2 AND bool_and(y.ok)
        INTO v_ok
        FROM (SELECT e.election_id,
                     bool_and(position(regexp_replace(e.township, '[區鄉鎮市]$', '') IN v_stem) > 0)
                       AND sum(char_length(regexp_replace(e.township, '[區鄉鎮市]$', ''))) = char_length(v_stem) AS ok
                FROM electoral_district_areas e
               WHERE e.region = m.to_region AND e.electoral_district = m.to_sub AND e.election_id IN (2022, 2026)
               GROUP BY e.election_id) y;
      v_ok := COALESCE(v_ok, false) AND v_to IS NOT NULL;
    ELSIF m.kind = 'county' THEN
      -- 那個鄉鎮市區真的不在這個縣市（官方清單裡沒有這個組合）
      v_ok := v_to IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM admin_divisions a WHERE a.level = 'town' AND a.match_key = admin_match_key(m.from_region, m.from_sub, NULL));
    ELSE
      -- 鄉鎮對、村里不存在：官方清單沒有，中選會歷屆村里長名單也沒有
      v_ok := v_to IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM admin_divisions a WHERE a.match_key = admin_match_key(m.from_region, m.from_sub, m.from_village))
        AND NOT EXISTS (SELECT 1 FROM cec_candidates c
                         WHERE c.election_type = '村里長'
                           AND admin_match_key(c.region, c.sub_region, c.village) = admin_match_key(m.from_region, m.from_sub, m.from_village));
    END IF;

    IF NOT v_ok THEN
      RAISE WARNING '核對沒過，這列不搬：% % % → % %', m.from_region, m.from_sub, COALESCE(m.from_village, ''), m.to_region, COALESCE(m.to_sub, '');
      CONTINUE;
    END IF;
    INSERT INTO _region_repoint VALUES (v_from, v_to, m.why);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 搬引用
-- ------------------------------------------------------------
-- politician_elections 上的 trg_sync_politician_latest 會把「最新一屆」的 region_id 寫回 politicians.region_id，
-- 而有些人的人物指標本來就跟最新一屆不同（例：侯友宜的 2024 總統參選紀錄指「全國／全國」，人物指標是空的）。
-- 這支只搬指向髒列的指標，所以先存下人物指標，搬完照存的值還原（指向髒列的才換成新列）。
CREATE TEMP TABLE _pol_region_before ON COMMIT DROP AS
SELECT p.id, p.region_id
  FROM politicians p
 WHERE p.region_id IN (SELECT from_id FROM _region_repoint)
    OR p.id IN (SELECT pe.politician_id FROM politician_elections pe WHERE pe.region_id IN (SELECT from_id FROM _region_repoint));

WITH moved AS (
  UPDATE politician_elections pe
     SET region_id = m.to_id
    FROM _region_repoint m
   WHERE pe.region_id = m.from_id
  RETURNING pe.id, m.from_id, m.to_id
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
SELECT 'politician_elections', moved.id::TEXT, 'region_id', to_jsonb(moved.from_id), to_jsonb(moved.to_id), 'regions-cleanup-348'
  FROM moved;

WITH target AS (
  SELECT b.id, b.region_id AS before_id, COALESCE(m.to_id, b.region_id) AS after_id
    FROM _pol_region_before b
    LEFT JOIN _region_repoint m ON m.from_id = b.region_id
),
restored AS (
  UPDATE politicians p
     SET region_id = t.after_id
    FROM target t
   WHERE p.id = t.id AND p.region_id IS DISTINCT FROM t.after_id
  RETURNING p.id, t.before_id, t.after_id
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
SELECT 'politicians', restored.id::TEXT, 'region_id', to_jsonb(restored.before_id), to_jsonb(restored.after_id), 'regions-cleanup-348'
  FROM restored
 WHERE restored.before_id IS DISTINCT FROM restored.after_id;  -- 只是被同步觸發器改到、又還原回去的不記

-- ------------------------------------------------------------
-- 刪掉沒有任何資料掛著的髒列
-- ------------------------------------------------------------
-- 範圍＝region_audit 列出來、而且沒有參選紀錄也沒有人物指著的列（上面搬完的也在內）。
-- region_audit 認「中選會歷屆村里」要靠 cec_candidates；cec-sync 是先刪再寫，剛好撞上同步、名單還沒寫回來時，
-- 歷屆村里會被誤判成髒列——名單不齊就整段不刪。
DO $$
DECLARE n_cec INT; n_del INT;
BEGIN
  SELECT count(*) INTO n_cec FROM cec_candidates WHERE election_type = '村里長' AND election_id = 2022;
  IF n_cec < 10000 THEN
    RAISE WARNING '中選會 2022 村里長名單只有 % 筆（應約 14,000），這次不刪髒列', n_cec;
    RETURN;
  END IF;

  WITH gone AS (
    DELETE FROM regions r
     WHERE r.id IN (SELECT a.id FROM region_audit a)
       AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
    RETURNING r.*
  )
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  SELECT 'regions', gone.id::TEXT, '*', to_jsonb(gone), NULL, 'regions-cleanup-348' FROM gone;
  GET DIAGNOSTICS n_del = ROW_COUNT;
  RAISE NOTICE '刪掉髒列 % 列', n_del;
END $$;

-- 形狀像選區、但系統自己的選區名冊沒有的議員選區列：金門縣 第04選舉區。
-- 名冊＝electoral_district_areas（2022、2026 一般選區）＋ _shared/electoral-district.ts 的
-- COUNCIL_ABORIGINAL_DISTRICTS（原住民選區；金門縣沒有）。交件時 district-registry.ts 本來就會把這個選區擋掉，
-- 這一列沒有任何資料掛著。region_audit 只看形狀抓不到它（原住民選區不在對照表裡，不能拿對照表判），所以單獨點名。
WITH gone AS (
  DELETE FROM regions r
   WHERE r.region = '金門縣' AND r.sub_region = '第04選舉區' AND r.village IS NULL
     AND NOT EXISTS (SELECT 1 FROM electoral_district_areas e WHERE e.region = r.region AND e.electoral_district = r.sub_region)
     AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)
     AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
  RETURNING r.*
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
SELECT 'regions', gone.id::TEXT, '*', to_jsonb(gone), NULL, 'regions-cleanup-348' FROM gone;

DO $$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM region_audit LOOP
    n := n + 1;
    RAISE WARNING '還留著的髒列：#% % % %（%；參選紀錄 %、人物 %）',
      r.id, r.region, COALESCE(r.sub_region, ''), COALESCE(r.village, ''), r.problem, r.election_refs, r.politician_refs;
  END LOOP;
  RAISE NOTICE 'region_audit 剩 % 列', n;
END $$;
