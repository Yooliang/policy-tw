-- term_policy_missing 改成設定表驅動（2026-10-07，維護者同意開工；#332 選前必補第 2 項）
-- ============================================================
--
-- 現況：contribution_auto_tasks_term_policies() 把屆別與職位寫死在函式裡——(2022：縣市長／縣市議員／鄉鎮市長)、(2024：立委)，
-- 公報入口的說明文字也只分「2022 地方」與「其餘＝2024 立委」兩段。2026 當選者的「那一屆政見」因此沒有對應的自動缺口，
-- 2028 也要再改一次函式。
--
-- 做了什麼（只加不刪，函式簽名不變，所以不用分兩次上）：
--   1. 新表 election_task_config(election_id, positions, bulletin_roc_year, bulletin_hint, scope_note, enabled, note)：
--      一場選舉一列，決定 term_policy_missing 對哪些職位的當選人派工（positions）、這一屆有沒有開（enabled）、
--      公報站的民國年（bulletin_roc_year）。bulletin_hint（任務說明裡「首選中選會公報」那一條的原文）與 scope_note
--      （說明結尾「哪些不是這一屆的競選政見」那一句）可空：空的就用通用文案。
--   2. 種子：2022、2024 兩列 enabled=true，內容與原本寫死的逐字相同（職位、公報入口、結尾那句都從舊函式原文抄出來）；
--      2026 一列 enabled=false——2026-11-29 起由 migration 或主線開啟（見該列的 note）。
--   3. 函式改讀設定表：當選人那一段 JOIN election_task_config（enabled 且職位在 positions 裡）；「推得出公報的參選人」那一段
--      也只收設定表開著的屆別（今天 politician_bulletins 只有 2022、2024，所以不改變輸出；之後哪一屆的公報進來，
--      要先在設定表開那一屆才會派）。其餘（去重、村里長限量、task_id、說明文字）一字不動。
--
-- 守門：部署前後派工清單必須逐件相同——scripts/term-policy-parity.ts 在 PGlite 灌正式庫唯讀快照，同一份資料跑舊函式
-- （20261006220000 原文）與這支 migration 建的新函式，比對輸出的每一件（task_id、target、說明、hint_sources、reward、region）；
-- 並拿 2026 開／關、2022 關掉某職位等情境確認設定真的有效（見 PR 說明與 supabase/functions/_shared/election-task-config.test.ts）。
--
-- 沒動的：politician_bulletins 視圖裡還寫著 pe.election_id = ANY (ARRAY[2022, 2024])（公報對照表 election_bulletins 本來也只有這兩屆）；
-- 去重條件裡的 c.election_id = 2026（零政見的 2026 候選人留給 policy_missing，跟 raw 臂 c2026 同條件）。
-- 這兩處是「公報資料何時有 2026」與「policy_missing 的對象」的事，不在這支。
--
-- 引用到的既有物件（2026-10-07 唯讀查詢確認存在）：elections(id)、politician_elections(politician_id, election_id, election_type,
-- region_id, candidacy_status)、politicians(id, name, party, merged_into, region)、regions(id, region)、policies(politician_id,
-- election_id, removed_at)、視圖 politician_bulletins、task_dispatches(task_id)、term_policy_village_cap()、auth.role()。

CREATE TABLE IF NOT EXISTS election_task_config (
  election_id       INTEGER PRIMARY KEY REFERENCES elections(id),
  positions         TEXT[] NOT NULL DEFAULT '{}',
  bulletin_roc_year INTEGER NOT NULL,
  bulletin_hint     TEXT,
  scope_note        TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT election_task_config_positions_known CHECK (
    positions <@ ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[]
  )
);
COMMENT ON TABLE election_task_config IS
  '一場選舉一列：term_policy_missing 對哪些職位的當選人派工（positions）、這一屆有沒有開（enabled）、公報站的民國年（bulletin_roc_year）；bulletin_hint、scope_note 可空（空的用通用文案）。2026-10-07 起，之後的選舉新增一列即可，不用改函式';
COMMENT ON COLUMN election_task_config.positions IS '當選人要補該屆政見的職位（九種之一）；推得出公報的參選人（含落選、村里長、代表）不看這一欄，只看 enabled';
COMMENT ON COLUMN election_task_config.enabled IS 'false＝這一屆不派 term_policy_missing（兩個來源都不派）';
COMMENT ON COLUMN election_task_config.bulletin_hint IS '任務 hint_sources 第一條（首選中選會公報的入口）的原文；空的用公報站首頁加 bulletin_roc_year 的通用寫法';
COMMENT ON COLUMN election_task_config.scope_note IS '任務說明結尾「任內才宣布的施政、…不是這一屆的競選政見」那一句；空的用「之後新提出的政見」的通用寫法';

ALTER TABLE election_task_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON election_task_config;
CREATE POLICY "Public read" ON election_task_config FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON election_task_config;
CREATE POLICY "Service role write" ON election_task_config FOR ALL USING (auth.role() = 'service_role');

-- 種子：2022、2024 與原本寫死的逐字相同；ON CONFLICT DO NOTHING——重跑不會蓋掉之後被人改過的列（例如 2026 開了之後）
INSERT INTO election_task_config (election_id, positions, bulletin_roc_year, bulletin_hint, scope_note, enabled, note) VALUES
  (2022, ARRAY['縣市長', '縣市議員', '鄉鎮市長'], 111,
   'https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 市長／縣長、議員、鄉鎮市長 → 選舉區 PDF，候選人登記的政見原文在上面',
   '任內才宣布的施政、2026 的新政見不是這一屆的競選政見。', true,
   '2026-10-07 起從設定表讀；內容與原本寫死在 contribution_auto_tasks_term_policies() 的 2022 那一段逐字相同'),
  (2024, ARRAY['立法委員'], 113,
   'https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報：區域／平地原住民／山地原住民各一個資料夾，依選舉區找 PDF（不分區的公報只有政黨政見）',
   '任內才宣布的施政、2026 的新政見不是這一屆的競選政見。', true,
   '2026-10-07 起從設定表讀；內容與原本寫死在 contribution_auto_tasks_term_policies() 的 2024 那一段逐字相同'),
  (2026, ARRAY['縣市長', '縣市議員', '鄉鎮市長'], 115, NULL, NULL, false,
   '2026-11-29 起由 migration 或主線開啟：UPDATE election_task_config SET enabled = true, updated_at = now() WHERE election_id = 2026。開之前先確認結果已補得差不多（當選人 candidacy_status=elected 且職位在 positions 才派；零政見的 2026 候選人留給 policy_missing）；說明結尾與公報入口目前用通用文案，公報站有 115 年的資料後可補 bulletin_hint；task-guidance 與協議的結尾句已改成不點名屆別（協議 1.71.0）')
ON CONFLICT (election_id) DO NOTHING;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pb AS (SELECT * FROM politician_bulletins),
  elected AS (
    -- 原本的對象：當選人，公報推不推得出來都派
    SELECT DISTINCT ON (pe.politician_id, pe.election_id)
           pe.politician_id, pe.election_id, pe.election_type, 'elected'::TEXT AS result,
           COALESCE(r.region, p.region) AS region, 0 AS pri
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND cfg.enabled AND pe.election_type = ANY (cfg.positions)
     WHERE p.merged_into IS NULL
       AND pe.candidacy_status = 'elected'
     ORDER BY pe.politician_id, pe.election_id, pe.election_type
  ),
  from_bulletin AS (
    -- 推得出公報的參選人：結果以我們的紀錄為準，沒有就照中選會名單
    SELECT DISTINCT ON (b.politician_id, b.election_id)
           b.politician_id, b.election_id, b.election_type,
           COALESCE(b.election_result, CASE WHEN b.elected THEN 'elected' WHEN b.elected = false THEN 'not_elected' END) AS result,
           b.region, 1 AS pri
      FROM pb b
      JOIN election_task_config cfg ON cfg.election_id = b.election_id AND cfg.enabled
     ORDER BY b.politician_id, b.election_id, (b.election_type = '村里長'), b.election_type
  ),
  i0 AS (
    SELECT DISTINCT ON (u.politician_id, u.election_id) u.*
      FROM (SELECT * FROM elected UNION ALL SELECT * FROM from_bulletin) u
     ORDER BY u.politician_id, u.election_id, u.pri
  ),
  i AS (
    SELECT 'auto:term_policy_missing:' || i0.politician_id || ':' || i0.election_id AS tid,
           i0.politician_id, i0.election_id, i0.election_type, i0.result, i0.region,
           p.name, p.party, b.urls, b.cand_no, COALESCE(b.elected, i0.result = 'elected') AS is_elected,
           concat_ws(' ', b.region, NULLIF(b.sub_region, ''), NULLIF(b.village, '')) AS unit
      FROM i0
      JOIN politicians p ON p.id = i0.politician_id
      LEFT JOIN pb b ON b.politician_id = i0.politician_id AND b.election_id = i0.election_id AND b.election_type = i0.election_type
     WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.election_id = i0.election_id AND pl.removed_at IS NULL)
       -- 去重：零政見的 2026 候選人留給 policy_missing（跟 raw 臂 c2026 同條件）
       AND (NOT EXISTS (SELECT 1 FROM politician_elections c WHERE c.politician_id = i0.politician_id AND c.election_id = 2026 AND c.candidacy_status IS DISTINCT FROM 'withdrawn')
            OR EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.removed_at IS NULL))
  ),
  village AS (
    -- 村里長限量：已經開出去的照舊，空位依「當選人先、再依地區」遞補
    SELECT v.* FROM (
      SELECT w.*, count(*) FILTER (WHERE w.live) OVER () AS live_n,
             row_number() OVER (PARTITION BY w.live ORDER BY w.is_elected DESC, w.unit, w.cand_no, w.politician_id) AS rn
        FROM (SELECT i.*, EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = i.tid) AS live
                FROM i WHERE i.election_type = '村里長') w
    ) v
     WHERE v.live OR v.rn <= GREATEST(term_policy_village_cap() - v.live_n, 0)
  ),
  picked AS (
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM i WHERE election_type <> '村里長'
    UNION ALL
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM village
  )
  SELECT x.tid, 'term_policy_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.region,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_result', x.result)
           || CASE WHEN x.urls IS NOT NULL
                   THEN jsonb_build_object('bulletin_urls', to_jsonb(x.urls), 'cand_no', x.cand_no, 'bulletin_unit', x.unit)
                   ELSE '{}'::JSONB END,
         x.name || '（' || COALESCE(x.region, '') || ' ' || x.election_id || ' ' || x.election_type
           || CASE x.result WHEN 'elected' THEN '當選' WHEN 'not_elected' THEN '參選，未當選' ELSE '參選' END || '）'
           || '沒有任何 ' || x.election_id || ' 這一屆的政見。'
           || CASE WHEN x.urls IS NOT NULL THEN
                '**這一屆的中選會選舉公報已經找到了**：' || x.urls[1]
                || CASE WHEN cardinality(x.urls) > 1 THEN '（共 ' || cardinality(x.urls) || ' 份，見 target.bulletin_urls；正反面或分份，他在其中一份上）' ELSE '' END
                || '，他在公報上是**號次 ' || COALESCE(x.cand_no::TEXT, '？') || '**（' || x.unit || '）。'
                || '請打開公報，依姓名與號次找到他自己那一欄——公報常是圖片版，要裁切放大核對，不要看成隔壁候選人的——'
                || '把那一欄的政見**逐條**交成 policy：每條一筆、election_id 填 ' || x.election_id || '、status 填 Campaign Pledge、'
                || 'source_urls 放這份公報網址、note 寫「公報第幾頁、號次 ' || COALESCE(x.cand_no::TEXT, '？') || '、第幾點」。'
                || '公報上列幾條就交幾條，一次交完（第一筆上線後這個任務就會關）；只有口號、標語或「為民服務」這種沒有具體內容的不交。'
                || '那一欄真的是空白或只有口號，回 no_change＋outcome=not_found，checked_urls 附這份公報與你另外查過的頁面，finding 寫公報那一欄寫了什麼。'
              ELSE
                '請找他**那一屆的競選政見**：最多 5 筆、每筆一個 policy 型別、各附自己的出處；'
                || 'election_id 填 ' || x.election_id || '，status 填 Campaign Pledge（競選承諾，之後會有任務追「兌現了沒」）。'
                || '**首選中選會選舉公報**——每位候選人登記的政見原文都印在公報上（見 hint_sources 的入口，依縣市、選舉別、選舉區找 PDF）；'
                || '其次本人官網／臉書的競選政見頁、當年的新聞。'
                || '找到幾筆交幾筆，不要為了湊數交標語、口號、願景或個人表態——那些不是政見。'
              END
           || '先看 current.queued_policies 與既有政見，別人交了還在等票的不要再交；' || COALESCE(cfgx.scope_note, '任內才宣布的施政、之後新提出的政見不是這一屆的競選政見。'),
         CASE WHEN x.urls IS NOT NULL THEN
           ARRAY(SELECT u || ' ← 中選會 ' || x.election_id || ' 選舉公報（號次 ' || COALESCE(x.cand_no::TEXT, '？') || '，' || x.unit || '）' FROM unnest(x.urls) AS u)
           || ARRAY['候選人當年的官網／臉書競選政見頁', 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）']
         ELSE
           ARRAY[COALESCE(cfgx.bulletin_hint,
                          'https://eebulletin.cec.gov.tw/ ← 中選會 ' || x.election_id || '（' || cfgx.bulletin_roc_year || ' 年）選舉公報：地方選舉在這個站，點到縣市、選舉別、選舉區 PDF，候選人登記的政見原文在上面；中央選舉的公報在 https://bulletin.cec.gov.tw/'),
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         END,
         1, x.region
    FROM picked x
    JOIN election_task_config cfgx ON cfgx.election_id = x.election_id
$$;
COMMENT ON FUNCTION contribution_auto_tasks_term_policies IS '補該屆政見（term_policy_missing）：設定表 election_task_config 開著（enabled）的屆別——當選人（職位在該屆的 positions 裡；2026-10-07 起讀設定表，種子是原本寫死的 2022 縣市長／縣市議員／鄉鎮市長、2024 立委）沒有那一屆的政見，或推得出選舉公報的參選人（含落選、村里長、代表、原住民區長／區民代表；村里長一次最多 term_policy_village_cap() 件）沒有那一屆的政見；推得出公報就把公報網址與號次放進 target。零政見的 2026 候選人留給 policy_missing。2026-10-02 起、10-06 擴充｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄｜2026-10-07：屆別、職位、公報入口改讀 election_task_config';

NOTIFY pgrst, 'reload schema';
