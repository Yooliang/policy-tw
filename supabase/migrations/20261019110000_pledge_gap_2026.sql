-- 承諾缺口改成「沒有 2026 承諾」、缺口仍在不收回、村里長與鄉鎮市民代表等公報（2026-10-19，維護者「好 盡力 修缺口」，#679 PR 1）
-- ============================================================
--
-- 用詞：2026 候選人選前提出的叫「承諾」（policies：election_id＝當屆、未移除、status＝Campaign Pledge 或 origin＝pledge；is_campaign_pledge）；
-- 政見＝任何屆別的政見。
--
--   1. 缺口定義。policy_missing（raw 臂）原本是「名下完全沒有任何政見」才算缺口：舊屆（2022／2024）政見一進來缺口就消失，
--      近 30 天以政見關掉的缺口 164 件裡 73%（119 件）收進來的是舊屆政見；另有 383 位「只有舊屆政見、沒有 2026 承諾」的人沒有任何臂管。
--      改成：當屆候選人沒有當屆承諾就是缺口。任務說明改成只收這一屆的承諾（交舊屆的不會結束這件任務）。
--      與 mayor_policies 的分工：縣市長（規則 params.election_types）已有政見的人由 mayor_policies 臂派（同一個 task_id），raw 不重複；
--      兩臂的「當屆承諾數」用同一個 is_campaign_pledge（mayor_policies 原本只看 election_id，跟 raw 一致後兩邊同一個定義）。
--   2. 缺口仍在不收回。共用觸發器 contributions_drop_dispatch 在任一份交件 applied 時刪派工列，缺口還在就在隊尾重建
--      （縣市長 14 天 27 次關閉 22 次重開）。只動 auto:policy_missing:* 且交件型別是 policy 的：交件上線後缺口仍成立
--      （policy_missing_gap_open，同 raw／mayor_policies 的條件）就不刪、保留原排隊位置；缺口已補上（交的是當屆承諾且夠了）照舊刪。
--      其他任務、其他交件型別（no_change 等）一個字不變——同一支觸發器已有 roster_check 的排除（20261010070000），這支只多一個條件。
--   3. 公報前派工集中。村里長、鄉鎮市民代表（維護者 10-19「村里長、市代盡力」）的 policy_missing 公報上架（bulletin_published 里程碑狀態＝done，
--      bulletin-watch 偵測到改成實際）才開：規則 3（raw:policy_missing，到投票日為止）加排除這兩個職位，另加一條規則只對這兩個職位、
--      公報上架日起到投票日。議員、鄉鎮市長、區長／區民代表、縣市長照舊。不寫死日期：2026 公報預估 11-18（status＝expected）不算，要等里程碑變 done。
--      牴觸／更正的既有裁決見 docs/decisions/2026-10-19-承諾缺口只算當屆村里長市代等公報.md。
--
-- 只新增兩個函式（is_campaign_pledge、policy_missing_gap_open）、換兩支臂本體（raw、mayor_policies，前一版 20261011300000 加機械式替換）、
-- 重建一個觸發器、一條規則 UPDATE 加一條 INSERT；不碰 seed、task_dispatches_queue_key、task_boost。

-- ------------------------------------------------------------
-- 1. 承諾的定義（單一真相）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_campaign_pledge(p_status TEXT, p_origin TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_status, '') = 'Campaign Pledge' OR COALESCE(p_origin, '') = 'pledge'
$$;
COMMENT ON FUNCTION is_campaign_pledge(TEXT, TEXT) IS
  '這筆政見是不是「承諾」（候選人選前提出的）：status＝Campaign Pledge 或 origin＝pledge。呼叫端再加 election_id＝當屆（campaign_election_id）與未移除。raw、mayor_policies 與 policy_missing_gap_open 共用。2026-10-19';

-- ------------------------------------------------------------
-- 2. raw（前一版 20261011300000；缺口條件、說明文字、縣市長分工）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH cur AS MATERIALIZED (
    -- 當屆＝下一場還沒投票的定期選舉（都投完了就是最近投完的那一場）；由 elections 決定（campaign_election_id），不再寫死年份
    SELECT ce.id, election_year_text(ce.id) AS year FROM (SELECT campaign_election_id() AS id) ce
  ),
  -- 規則 mayor_policies 的職位（縣市長）已有政見的人由 mayor_policies 臂派（同一個 task_id），這裡不重複（原本靠「名下 0 筆政見」自然分開）
  mcfg AS MATERIALIZED (
    SELECT ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM activity_rules r
     WHERE r.activity = 'mayor_policies' AND r.priority IS NULL
     ORDER BY r.enabled DESC, r.id LIMIT 1
  ),
  c_cur AS (
    SELECT cur.id AS eid, cur.year AS eyear, p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.candidacy_status AS cs, pe.source_note,
           -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    JOIN cur ON cur.id = pe.election_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n,
           -- 名單缺口用：名冊內人數＝排除 considering（可能參選）與 withdrawn（退選），其餘都算——已登記、已表態，選後的當選／落選也算（只算 filed、declared 的話，選後人數歸零、缺口永遠成立）
           COUNT(*) FILTER (WHERE COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')) AS n_listed
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    GROUP BY 1, 2, 3
  ),
  -- 登記後才退選的人（withdrawn_after_filing 為真）：他們在中選會登記名冊上，但 ours 不收退選的，名冊人數比我們的名冊內人數多出這幾位
  filed_out AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n_filed_out
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS TRUE
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:policy_missing:' || c.id, 'policy_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid, 'election_type', c.election_type),
         c.name || '（' || COALESCE(c.region, '') || ' ' || c.eyear || ' ' || COALESCE(c.election_type, '') || '候選人）目前沒有 ' || c.eyear || ' 這一屆的承諾（候選人在 ' || c.eyear || ' 選舉前提出的政見）' ||
           CASE WHEN EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL)
                THEN '；名下另有 ' || (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL) || ' 筆過去任期或上屆的政見，不算這一屆'
                ELSE '，名下目前 0 筆政見' END ||
           '。請找該候選人有出處的 ' || c.eyear || ' 競選承諾，最多 5 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 ' || c.eid || '；找到幾筆交幾筆，只找到 1 筆就交 1 筆，不要為了湊數交口號、願景或個人表態。先看 current.queued_policies，別人交了還在等票的不要再交。' ||
           '**這件任務只收 ' || c.eyear || ' 這一屆的承諾**：現任任期的施政、上屆或過去選舉的政見不是這一屆的承諾，不要拿來交（交了這件任務也不會結束）；找不到這一屆的承諾就用 no_change 回報你查了什麼',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 1, c.region
  FROM c_cur c
  -- 缺口＝這個人沒有當屆（c.eid）的承諾（is_campaign_pledge）；原本是「名下完全沒有任何政見」，舊屆政見一進來缺口就消失（2026-10-19，#679）
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL
                      AND pl.election_id = c.eid AND is_campaign_pledge(pl.status::TEXT, pl.origin))
    AND NOT (c.cs IN ('declared', 'filed') AND c.election_type = ANY ((SELECT mcfg.election_types FROM mcfg)::TEXT[])
             AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL))
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN current_position_missing(c.current_position) THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN current_position_missing(c.current_position) THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c_cur c
  WHERE c.birth_year IS NULL OR current_position_missing(c.current_position) OR c.avatar_url IS NULL
  UNION ALL
  SELECT 'auto:policy_validity:' || pl.id, 'policy_validity',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region),
         '「' || pl.title || '」（' || p.name || '）掛在政見底下，但我們沒有任何出處。'
           || '**先判斷它是不是政見**：政見是「當選後要做的具體事情」，看得出做什麼、給誰、做到什麼程度。'
           || '競選標語、團隊組成、行程、個人表態、選戰口號都不是政見（例如「母雞帶小雞」「溫暖創新的某某市」）。'
           || '不是政見就用 removal 型別回報（payload 帶 target_table: "policies"、target_id: 這筆政見的 id、reason ≥20 字寫清楚它是哪一類；需 3 票）；'
           || '是政見就找到原始出處，用 correction 型別補 policies.source_url。'
           || '兩邊都查不出來（找不到出處，也無法判定不是政見）就用 no_change 回報你查了什麼。',
         ARRAY['候選人官網政見頁', 'cna.com.tw', 'ltn.com.tw', 'udn.com'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM source_refs sr WHERE sr.target_table = 'policies' AND sr.target_id = pl.id::TEXT AND sr.role = 'primary')
  UNION ALL
  SELECT 'auto:progress_stale:' || pl.id, 'progress_stale',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress,
                            'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'election_id', pl.election_id, 'election_date', e.election_date),
         CASE WHEN pl.status::TEXT = 'Campaign Pledge' THEN
           '競選承諾「' || pl.title || '」（' || p.name || '）所屬的選舉已經在 ' || e.election_date::TEXT
             || ' 投票完畢，這筆卻還停在「競選承諾」。'
             || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，追不出進度也不該追——'
             || '那種用 removal 型別回報（需 3 票），不要為它補欄位。是政見才往下做：請先確認這個人有沒有當選：'
             || '當選就查這項承諾後來有沒有開始執行，用 policy_progress 型別把 status 改成 In Progress／Achieved／Stalled／Failed 並附上進度紀錄；'
             || '落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 型別補那場選舉的 election_result（附中選會網址）——補上之後這筆不會再派。'
             || '真的查不到後續，用 no_change 回報並說明你查了哪些來源。'
         ELSE
           '政見「' || pl.title || '」（' || p.name || '，' || pl.status::TEXT || '）超過 90 天沒有進度紀錄。'
             || '**第一步先判斷它是不是政見**：標語、行程、個人表態不是，那種用 removal 型別回報（需 3 票），不要補欄位。'
             || '是政見就請查施政報告、議會／立法院紀錄或新聞後用 policy_progress 型別回報。查證後確定近期真的沒有新進度，就用 no_change 回報——那也是成果，會讓這筆暫時不再派給別人'
         END,
         CASE WHEN pl.status::TEXT = 'Campaign Pledge'
              THEN ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 查這個人那一屆選上了沒有',
                         '政見本身的 source_url', 'cna.com.tw', '該機關官網施政報告']
              ELSE ARRAY['縣市政府施政報告（*.gov.tw）', 'ly.gov.tw 議事錄', '議會官網', 'cna.com.tw'] END,
         1, p.region
  FROM policies pl
  JOIN politicians p ON p.id = pl.politician_id
  LEFT JOIN elections e ON e.id = pl.election_id
  WHERE pl.removed_at IS NULL
    AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
    AND pl.last_updated < CURRENT_DATE - INTERVAL '90 days'
    AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= CURRENT_DATE - INTERVAL '90 days')
    -- 競選承諾要等那場選舉投票完，才問得出「兌現了嗎」。2026 投票日是 11-28，
    -- 現在問它「90 天沒有進度」，代理只能回 no_change。屆別空著的也一樣問不出來，
    -- 那些先由 policy_election_missing 把屆別補上，補完就會自己流回這裡。
    AND (pl.status::TEXT <> 'Campaign Pledge'
         OR (e.election_date IS NOT NULL AND e.election_date < CURRENT_DATE))
    -- 落選／退選的人的承諾永遠不會有進度，不要每 14 天再派一次
    AND NOT EXISTS (
      SELECT 1 FROM politician_elections pe
      WHERE pe.politician_id = pl.politician_id
        AND pe.election_id = pl.election_id
        AND pe.candidacy_status IN ('not_elected', 'withdrawn')
    )
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
         c.name || '（' || COALESCE(c.region, '') || ' ' || c.eyear || ' ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 已投票的屆別查得到；' || c.eyear || ' 尚未公告',
               '該縣市選舉委員會官網（' || c.eyear || ' 登記名單）', 'cna.com.tw 登記參選名單'], 1, c.region
  FROM c_cur c
  WHERE c.source_note IS NULL OR c.source_note !~ 'https?://'
  UNION ALL
  SELECT 'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type,
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', l.name, 'election_type', s.election_type,
                            'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count,
                            'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。把該縣市這個選舉的參選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'
           -- 名單分兩個階段，講清楚現在該補哪一種，否則兩個階段的資料會混在一起
           || CASE WHEN CURRENT_DATE >= s.list_announced_on THEN
                '【現在是審定名單階段】官方候選人名單已於 ' || s.list_announced_on::TEXT
                  || ' 公告，請以公告名單為準：candidacy 的 candidate_status 填 qualified（名單上的人；confirmed 只表示表態參選），查得到號次就一起附上。'
              ELSE
                '【現在是登記階段】'
                  -- 時程句（登記截止、名單公告、資格審查、抽號次）：日期都讀 roster_check_scope，過了日期的不再出現
                  || roster_schedule_text(s.registration_closed_on, s.list_announced_on, s.municipal_mayor_list_on,
                                          s.qualification_review_by, s.ballot_draw_on)
                  || '所以現在補的是「已登記」而不是「已審定」：candidacy 的 candidate_status 填 registered，不要填 confirmed'
                  -- 號次要等抽籤日之後才有；抽完了就不再說「還沒有號次可填」
                  || CASE WHEN s.ballot_draw_on IS NULL OR s.ballot_draw_on >= CURRENT_DATE THEN '，也還沒有號次可填' ELSE '' END
                  || '。'
                  || '另外，登記已經截止，所以我們資料裡還標著 rumored（傳聞參選）或 likely（可能參選）的人，只要不在登記名單上就是沒登記：請用 correction 把他那筆的 candidate_status 改成 not_running。'
              END
           || '最後用 roster_check 型別回報這次清查（名單上共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。'
           -- 前一位代理查不到時，明講不要再去 db.cec.gov.tw：那是舊版把它排在第一個
           -- 造成的，43 個縣市一次都沒清查成功過，不寫清楚下一位會重蹈同一條死路。
           || CASE WHEN rc.last_attempt_without_count IS NOT NULL
                   THEN '注意：前一位代理回報查不到官方名單（見 target.last_failed_attempt）。'
                        || '請不要再去 db.cec.gov.tw 找——那是選舉結果資料庫，它自己標明「投票後 7 日內更新」，'
                        || election_year_text(s.election_id) || ' 的資料要等 ' || to_char((SELECT e.election_date + 7 FROM elections e WHERE e.id = s.election_id), 'FMMM') || ' 月才會進去。改從該縣市選舉委員會官網的登記公告、或媒體的登記名單彙整下手。'
                   ELSE '' END
           || '查不到名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址——那筆不會把縣市標記為已清查，只會讓它隔天再派。',
         CASE WHEN CURRENT_DATE >= s.list_announced_on
              THEN ARRAY['該縣市選舉委員會官網的候選人名單公告', 'bulletin.cec.gov.tw 選舉公報', 'web.cec.gov.tw 中選會公告', 'cna.com.tw 候選人名單彙整']
              ELSE ARRAY['該縣市選舉委員會官網的登記公告', 'web.cec.gov.tw 中選會新聞稿', 'cna.com.tw 登記參選名單彙整', 'ltn.com.tw／udn.com 登記名單'] END,
         2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name
  LEFT JOIN LATERAL (
    -- 兩個時鐘：真的清查完的（cec_count 有值）壓 recheck_days；
    -- 只是試過沒找到的壓 roster_attempt_cooldown_days
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count,
           -- 最近一次真的清查（cec_count 有值）回報的中選會人數
           (array_agg(cec_count ORDER BY checked_at DESC, id DESC) FILTER (WHERE cec_count IS NOT NULL))[1] AS last_cec_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    -- 最近一次回報的 cec_count 比我們現在的名冊內人數多＝缺口還在：不套 recheck_days，繼續派；落差為 0（或我們比較多）才套
    AND (rc.last_checked IS NULL
         -- 登記後才退選的人在名冊上、不在我們的名冊內人數裡：回報的名冊人數先扣掉他們再比（不扣，名冊 88 位、我們 86 位加 2 位登記後退選，會永遠派下去）
         OR COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)
         OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
  UNION ALL
  SELECT 'auto:policy_election_missing:' || pl.id, 'policy_election_missing',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'source_url', policy_primary_url(pl.id)),
         '政見「' || pl.title || '」（' || p.name || '）沒有標所屬屆別，網站上顯示成「未標註屆別」。'
           || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，那種用 removal 型別回報（需 3 票），不要補屆別。'
           || '是政見就請打開它的來源網址，確認這是哪一場選舉的承諾（或哪一個任期內的施政），'
           || '再用 correction 型別把 policies.election_id 改成該選舉的年份（' || regular_election_years_text() || '）。'
           || '判斷依據是來源本身：競選承諾看那場選舉的年份，施政進度看講話當下的任期。'
           || '來源沒寫清楚、或那個人同時參選過多屆分不出來，就不要猜——用 no_change 回報並說明你查了什麼。',
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁', 'cna.com.tw'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND pl.election_id IS NULL
  UNION ALL
  -- 登記截止之後還標著「傳聞參選」「可能參選」的，一定有結論：不是在登記名單上，就是沒登記。
  -- 這條規則原本只寫在 roster_check 的敘述裡，而名單清查一直清不動（全國性結構化名單要等 11-17
  -- 公告才有），所以 63 筆就這樣掛著。2026-09-17：「傳聞的參選人在名單出來之後，
  -- 他就應該要被確認下來」——拆成一筆一個任務，各自派出去。
  SELECT 'auto:candidate_status_stale:' || pe.id, 'candidate_status_stale',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'election_id', pe.election_id,
                            'election_type', pe.election_type, 'candidate_status', CASE WHEN pe.candidacy_status = 'considering' THEN 'likely' ELSE 'rumored' END,
                             'region', COALESCE(r.region, p.region), 'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '還標著「' || CASE WHEN pe.candidacy_status = 'considering' THEN '可能參選' ELSE '傳聞參選' END || '」，'
           || '但登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，這時候只有兩種可能：'
           || '**在登記名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered（附登記名單網址）；'
           || '**不在名單上** → 改成 not_running（一樣附你查的那份名單，說明找過了沒有他）。'
           || '兩者都要附得出那份名單；查不到該縣市的登記名單就用 no_change 回報，不要用猜的把人留在「傳聞」。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  WHERE (pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')
    -- 登記截止之後才派：移到規則（activity_rules「raw:candidate_status_stale」：登記截止 +0 起，P2 20261008162000）；這裡不再比日期
$function$;


-- ------------------------------------------------------------
-- 3. mayor_policies（前一版 20261011300000；當屆承諾數改用 is_campaign_pledge）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_mayor_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  -- 等票中的當屆政見提交數：整張 contributions 掃一次、依人物分組；原本每位候選人各掃一次（payload 沒有索引，每次約 3 毫秒）
  WITH cur AS MATERIALIZED (
    -- 當屆＝下一場還沒投票的定期選舉（都投完了就是最近投完的那一場）；由 elections 決定（campaign_election_id），不再寫死年份
    SELECT ce.id, election_year_text(ce.id) AS year FROM (SELECT campaign_election_id() AS id) ce
  ),
  -- 職位與「幾筆算夠」讀規則 mayor_policies 的 params（election_types、max_policies；跟日本站同名），主控台可改
  cfg AS MATERIALIZED (
    SELECT (r.params->>'max_policies')::INTEGER AS max_policies,
           ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM activity_rules r
     WHERE r.activity = 'mayor_policies' AND r.priority IS NULL
     ORDER BY r.enabled DESC, r.id LIMIT 1  -- 停用了也照算（窗口由總表關，缺口收回記 window）
  ),
  queued_by AS MATERIALIZED (
    SELECT c.payload->>'politician_id' AS pid, COUNT(*) AS n FROM contributions c
     WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')
       AND c.payload->>'politician_id' IS NOT NULL
       AND COALESCE(NULLIF(c.payload->>'election_id', ''), (SELECT cur.id::TEXT FROM cur)) = (SELECT cur.id::TEXT FROM cur)
     GROUP BY 1
  ),
  m AS MATERIALIZED (
    SELECT p.id, p.name, p.party, p.region,
           (SELECT pe.election_type FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_id = (SELECT cur.id FROM cur)
               AND pe.election_type = ANY ((SELECT cfg.election_types FROM cfg)::TEXT[]) AND pe.candidacy_status IN ('declared', 'filed')
             ORDER BY pe.id LIMIT 1) AS etype,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL) AS n_all,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = (SELECT cur.id FROM cur) AND is_campaign_pledge(pl.status::TEXT, pl.origin)) AS n_cur,
           COALESCE((SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT), 0) AS queued,
           (SELECT string_agg(DISTINCT pl.category, '、') FROM policies pl
             WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = (SELECT cur.id FROM cur) AND pl.category IS NOT NULL) AS cats
    FROM politicians p
    WHERE p.merged_into IS NULL
      -- is_2026_mayor_candidate(p.id) 的本體原樣寫在這裡：當純量函式逐人呼叫要掃全部人物（約 1.6 萬次），寫成 EXISTS 才會變成半連接
      AND EXISTS (SELECT 1 FROM politician_elections pe
                   WHERE pe.politician_id = p.id
                     AND pe.election_id = (SELECT cur.id FROM cur) AND pe.election_type = ANY ((SELECT cfg.election_types FROM cfg)::TEXT[])
                     AND pe.candidacy_status IN ('declared', 'filed'))
  )
  SELECT 'auto:policy_missing:' || m.id, 'policy_missing',
         jsonb_build_object('politician_id', m.id, 'name', m.name, 'party', m.party, 'region', m.region,
                            'election_id', cur.id, 'election_type', m.etype,
                            'policies_now', m.n_cur, 'policies_other_terms', m.n_all - m.n_cur, 'queued', m.queued,
                            'categories_now', m.cats),
         m.name || '（' || COALESCE(m.region, '') || ' ' || cur.year || ' ' || m.etype || '候選人）**' || cur.year || ' 這一屆**的政見只有 ' || m.n_cur || ' 筆' ||
           CASE WHEN m.queued > 0 THEN '（另有 ' || m.queued || ' 筆還在等票）' ELSE '' END ||
           CASE WHEN m.n_all - m.n_cur > 0 THEN '；另外 ' || (m.n_all - m.n_cur) || ' 筆是過去任期或上屆的，不算這屆' ELSE '' END ||
           CASE WHEN m.cats IS NOT NULL THEN '。這屆已有的類別：' || m.cats ELSE '' END ||
           '。' || array_to_string(cfg.election_types, '、') || '是網站的主要內容，請補這一屆的政見：找有出處的具體 ' || cur.year || ' 競選政見，最多 ' || cfg.max_policies || ' 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 ' || cur.id || '，優先補還沒有的類別。' ||
           '先看 current.queued_policies 與既有政見，已經有的不要重複交；現任者任內的施政、上屆的承諾不是這屆的政見，不要當 ' || cur.year || ' 交。' ||
           '找到幾筆交幾筆，不要為了湊數交口號、願景或個人表態。',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 2, m.region
  FROM m CROSS JOIN cur CROSS JOIN cfg
  WHERE m.n_all > 0                 -- 總數 0 筆的由 raw 臂派，不重複
    AND m.n_cur + m.queued < cfg.max_policies
$$;


-- ------------------------------------------------------------
-- 4. 缺口還在嗎（觸發器用）：同 raw ∪ mayor_policies 的條件，單一人物版
-- ------------------------------------------------------------
-- raw 缺口：當屆參選（非退選）、沒有當屆承諾、且不是「縣市長類已有政見」（那種由 mayor_policies 管）
-- mayor_policies 缺口：當屆縣市長類（declared／filed）、名下有政見、當屆承諾＋等票 < params.max_policies
-- 兩條的條件抄自上面兩支臂（parity 測試 policy-missing-current-term.test.ts 在 PGlite 上逐人比對函式與臂）
CREATE OR REPLACE FUNCTION policy_missing_gap_open(p_politician_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  WITH cur AS (SELECT campaign_election_id() AS id),
  cfg AS (
    SELECT (r.params->>'max_policies')::INTEGER AS max_policies,
           ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM activity_rules r
     WHERE r.activity = 'mayor_policies' AND r.priority IS NULL
     ORDER BY r.enabled DESC, r.id LIMIT 1
  ),
  f AS (
    SELECT
      EXISTS (SELECT 1 FROM politician_elections pe, cur
               WHERE pe.politician_id = p_politician_id AND pe.election_id = cur.id AND pe.candidacy_status IS DISTINCT FROM 'withdrawn') AS is_cand,
      EXISTS (SELECT 1 FROM politician_elections pe, cur, cfg
               WHERE pe.politician_id = p_politician_id AND pe.election_id = cur.id
                 AND pe.election_type = ANY (cfg.election_types::TEXT[]) AND pe.candidacy_status IN ('declared', 'filed')) AS is_mayor,
      EXISTS (SELECT 1 FROM politicians x WHERE x.id = p_politician_id AND x.merged_into IS NULL) AS live,
      (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p_politician_id AND pl.removed_at IS NULL) AS n_all,
      (SELECT COUNT(*) FROM policies pl, cur
        WHERE pl.politician_id = p_politician_id AND pl.removed_at IS NULL AND pl.election_id = cur.id
          AND is_campaign_pledge(pl.status::TEXT, pl.origin)) AS n_pledge,
      (SELECT COUNT(*) FROM contributions c, cur
        WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')
          AND c.payload->>'politician_id' = p_politician_id::TEXT
          AND COALESCE(NULLIF(c.payload->>'election_id', ''), cur.id::TEXT) = cur.id::TEXT) AS queued
  )
  SELECT COALESCE(
           (f.is_cand AND f.n_pledge = 0 AND NOT (f.is_mayor AND f.n_all > 0))
           OR (f.live AND f.is_mayor AND f.n_all > 0 AND f.n_pledge + f.queued < (SELECT cfg.max_policies FROM cfg)),
         false)
    FROM f
$$;
COMMENT ON FUNCTION policy_missing_gap_open(UUID) IS
  '這個人現在還是 policy_missing 缺口嗎（raw 臂：當屆沒有承諾；mayor_policies 臂：縣市長類當屆承諾＋等票不夠）。觸發器 contributions_drop_dispatch 用它判斷 policy 交件上線後要不要收回派工列。2026-10-19';

-- ------------------------------------------------------------
-- 5. 缺口仍在不收回：觸發器 WHEN 多一個條件（task_dispatches_drop_applied 本體不動，日本站複本有 drift 測試）
-- ------------------------------------------------------------
-- 前一版 20261010070000 的 WHEN ＋ 一個條件：auto:policy_missing:<人物> 的 policy 交件上線後缺口還在 → 不收回（保留排隊位置）
DROP TRIGGER IF EXISTS contributions_drop_dispatch ON contributions;
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NOT (NEW.task_id LIKE 'auto:roster_check:%' AND NEW.contribution_type NOT IN ('roster_check', 'no_change'))
                     AND NOT (NEW.task_id LIKE 'auto:policy_missing:%' AND NEW.contribution_type = 'policy'
                              AND policy_missing_gap_open(uuid_or_null(substr(NEW.task_id, 21)))))
  EXECUTE FUNCTION task_dispatches_drop_applied();

-- ------------------------------------------------------------
-- 6. 公報前村里長、鄉鎮市民代表不派 policy_missing，公報上架（里程碑 done）後自動開
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM activity_rules WHERE id = 3 AND activity = 'raw:policy_missing' AND election_types IS NULL AND until_kind = 'polling') THEN
    RAISE EXCEPTION 'rule 3 (raw:policy_missing) is not in the expected shape';
  END IF;
END $$;

UPDATE activity_rules
   SET except_election_types = ARRAY['村里長', '鄉鎮市民代表'],
       note = CASE WHEN COALESCE(note, '') LIKE '%2026-10-19（#679）%' THEN note
                   ELSE '2026-10-19（#679）：村里長與鄉鎮市民代表排除，改看下一條規則（公報上架日起）。' || COALESCE(note, '') END,
       updated_at = now()
 WHERE id = 3 AND activity = 'raw:policy_missing';

INSERT INTO activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, election_types, note)
SELECT 'raw:policy_missing', 'event', 'bulletin_published', 0, 'polling', 0, 'done', ARRAY['村里長', '鄉鎮市民代表'],
       '村里長與鄉鎮市民代表的當屆承諾缺口（維護者 2026-10-19「村里長、市代盡力」）：公報上架（bulletin_published 里程碑 done，bulletin-watch 偵測到才改；預估日不算）起到投票日。公報前這兩種人沒有線上來源，派出去只會回查無、吃掉 14 天冷卻'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules WHERE activity = 'raw:policy_missing' AND from_kind = 'bulletin_published');

-- ------------------------------------------------------------
-- 7. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT is_campaign_pledge('Campaign Pledge', NULL) OR NOT is_campaign_pledge('In Progress', 'pledge') OR is_campaign_pledge('In Progress', NULL) THEN
    RAISE EXCEPTION 'is_campaign_pledge is wrong';
  END IF;
  IF (SELECT count(*) FROM activity_rules WHERE activity = 'raw:policy_missing' AND enabled) <> 2 THEN
    RAISE EXCEPTION 'raw:policy_missing should have exactly 2 enabled rules';
  END IF;
END $$;
