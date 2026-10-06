-- 政黨解散日、改名界線日的派工（party_info_missing）只派「網站上有人用到的政黨」（維護者 10-06）。
--
-- 原本三種缺口（rename 改名界線日、off_registry 名冊外的政黨、dissolved 名冊上是解散廢止而停用日空著）
-- 對 parties 全表 403 個政黨一視同仁，其中 69 個真的有人掛（人物的政黨或某次參選的政黨），
-- 其餘是內政部名冊上歷年備案過的小黨，網站上沒有任何人用到，查它的解散日對讀者沒有任何差別，卻佔掉代理的額度。
-- 「用到」＝ politicians.party_id（沒被併走的人）或 politician_elections.party_id（那個人沒被併走）指到它。
-- rename 是新舊兩筆一起交，任何一端有人用到就派（舊名稱有人掛、界線日就是他那一次參選該不該算舊名的依據）。
-- 之後有人被對到那個政黨（新匯入、更正），臂下一輪自然就把它派出來——不用另外補。
-- 只改派工臂的篩選；任務編號、說明、提示來源、已有人交了在等票先不派，一字不動。不碰任何政黨、人物或參選紀錄資料。
--
-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：politicians(party_id, merged_into)、politician_elections(party_id, politician_id)、
--   parties(id, name, moi_no, moi_status, valid_from, valid_to, predecessor_id)、contributions(contribution_type, status, payload)

CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_info()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH used AS (
    -- 網站上有人用到的政黨：人物現在掛的、或某一次參選時掛的（被併走的人不算）
    SELECT p.party_id FROM politicians p WHERE p.party_id IS NOT NULL AND p.merged_into IS NULL
    UNION
    SELECT pe.party_id FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id
     WHERE pe.party_id IS NOT NULL AND p.merged_into IS NULL
  ),
  queued AS (
    -- 已經有人交了這個政黨的 party_info、還在等票的先不派
    SELECT DISTINCT (e ->> 'party_id') AS party_id
      FROM contributions c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload -> 'parties') = 'array' THEN c.payload -> 'parties' ELSE '[]'::JSONB END) e
     WHERE c.contribution_type = 'party_info' AND c.status IN ('pending', 'verified')
  ),
  gaps AS (
    -- rename：改名的界線日（新名稱開始用、舊名稱停用）還空著；新舊任何一端有人用到就派
    SELECT 'rename'::TEXT AS kind, n.id AS party_id, jsonb_build_array(n.id, o.id) AS party_ids,
           n.name, o.name AS other_name, n.moi_status,
           array_remove(ARRAY[CASE WHEN n.valid_from IS NULL THEN 'valid_from' END, CASE WHEN o.valid_to IS NULL THEN 'valid_to' END], NULL) AS missing
      FROM parties n JOIN parties o ON o.id = n.predecessor_id
     WHERE (n.valid_from IS NULL OR o.valid_to IS NULL)
       AND (n.id IN (SELECT party_id FROM used) OR o.id IN (SELECT party_id FROM used))
    UNION ALL
    -- off_registry：內政部名冊查無此名稱、也還沒對到是誰改名前的名字
    SELECT 'off_registry', p.id, jsonb_build_array(p.id), p.name, NULL, NULL, ARRAY['predecessor_id', 'valid_to']
      FROM parties p
     WHERE p.moi_no IS NULL AND NOT EXISTS (SELECT 1 FROM parties c WHERE c.predecessor_id = p.id)
       AND p.id IN (SELECT party_id FROM used)
    UNION ALL
    -- dissolved：名冊上是解散、廢止、撤銷，停用日空著（名冊只有狀態、沒有日期）
    SELECT 'dissolved', p.id, jsonb_build_array(p.id), p.name, NULL, p.moi_status, ARRAY['valid_to']
      FROM parties p
     WHERE p.moi_status IN ('自行解散', '廢止備案', '撤銷備案') AND p.valid_to IS NULL
       AND NOT EXISTS (SELECT 1 FROM parties c WHERE c.predecessor_id = p.id)
       AND p.id IN (SELECT party_id FROM used)
  )
  SELECT 'auto:party_info_missing:' || g.kind || ':' || g.party_id,
         'party_info_missing',
         jsonb_build_object('kind', g.kind, 'party_id', g.party_id, 'party_ids', g.party_ids, 'name', g.name,
                            'predecessor_name', g.other_name, 'moi_status', g.moi_status, 'missing', to_jsonb(g.missing)),
         CASE g.kind
           WHEN 'rename' THEN '「' || g.other_name || '」改名為「' || g.name || '」，但改名是哪一天還不知道（政黨表的 '
             || array_to_string(g.missing, '、') || ' 空著）。請查內政部政黨資訊網、內政部公告或政黨自己的公告，'
             || '用 party_info 交：新名稱「' || g.name || '」那一項給 valid_from（開始用新名稱的日子）、舊名稱「' || g.other_name || '」那一項給 valid_to（停用的日子），兩筆一起交。'
           WHEN 'off_registry' THEN '「' || g.name || '」出現在我們的資料裡，但內政部政黨名冊查無此名稱。請查它是不是名冊上某個政黨改名前的名字：'
             || '是的話用 party_info 交兩項——名冊上那個政黨給 predecessor_id 填 ' || g.party_id || '（＋改名日 valid_from），「' || g.name || '」給 valid_to（停用的日子）；'
             || '要有來源講明是同一個政黨改名，名字像不算。只查到它停止活動的日子就只交它自己的 valid_to。'
           ELSE '「' || g.name || '」在內政部政黨名冊上的狀態是「' || g.moi_status || '」，但哪一天解散、廢止還不知道（政黨表的 valid_to 空著）。'
             || '請查內政部政黨資訊網那個政黨的頁面、內政部公告，用 party_info 交：這個政黨給 valid_to（解散或廢止生效的日子）。'
         END
           || '查不到確切的日子就不要交那一欄（不要填月初、年初湊），用 no_change 說明你查了哪些網址；臉書、IG、Threads 不算出處。',
         ARRAY['https://party.moi.gov.tw/PartyMain.aspx?n=16100&sms=13073 ← 內政部政黨資訊網：查政黨（點政黨名稱看備案、解散、廢止的紀錄）',
               '內政部全球資訊網的公告', '政黨官網的公告'],
         1, NULL::TEXT
    FROM gaps g
   WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.party_id = g.party_id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_info IS
  '政黨資訊缺口（2026-10-06）：改名的界線日、名冊外政黨的對應、解散廢止的停用日，新任務型別 party_info_missing，代理交 party_info；只派網站上有人用到的政黨（人物或參選紀錄掛著它）';
