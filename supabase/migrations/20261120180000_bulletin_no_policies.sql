-- 公報未填政見可標記（2026-11-20，小良哥）：報表算完成、派工不重派、人物頁一句說明。
--
-- 為什麼：2026 台南市長 1 號蕭燐洪，選舉公報政見欄是一張「我都八十四歲了，只求正寢，沒有政見」的圖，沒有任何政策條目。
--   站上他 0 條政見，補政見任務（policy_missing／term_policy_missing）永遠派不完，「已抄／應有」永遠少 1。
-- 欄位放 politician_elections 不放 politician_bulletins：politician_bulletins 是視圖（由參選紀錄與公報索引推出來），沒有地方存；
--   而「公報沒填政見」是「這個人這一屆」的事實，正好是參選紀錄的粒度（同一人跨屆、同一屆不同職位互不影響）。
-- 內容：
--   ① politician_elections 加 no_policies_at／no_policies_source_url（兩欄要同時有或同時沒有）。
--   ② contribution_auto_tasks_raw（policy_missing 臂）、contribution_auto_tasks_term_policies（term_policy_missing 臂）：標了就不產卡。
--      兩支都是原定義只在 WHERE 多一段（標「公報未填政見」那段）；term 臂的任務說明多一句教代理怎麼交。
--   ③ 視圖 politicians_with_elections：elections[] 每筆多 noPoliciesAt／noPoliciesSourceUrl 兩個鍵（人物頁讀；欄位清單不變）。
--   ④ 視圖 politician_election_transcribed：每人每屆「已抄」的唯一口徑（有政見 或 標了公報未填政見），報表與腳本都讀這支。
-- 落庫在 TS（apply-contribution.ts 的 applyBulletinNoPolicies）：no_change＋finding_kind=bulletin_no_policies，驗證沿用 no_change 規則。
--
-- 回滾（整段反向執行）：
--   DROP VIEW politician_election_transcribed;
--   把 ③ 的視圖與 ② 的兩支函式還原成 20261111170000／20261115010000／20261011310000 的定義；
--   ALTER TABLE politician_elections DROP CONSTRAINT politician_elections_no_policies_pair, DROP COLUMN no_policies_source_url, DROP COLUMN no_policies_at;

ALTER TABLE politician_elections
  ADD COLUMN IF NOT EXISTS no_policies_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS no_policies_source_url TEXT;
ALTER TABLE politician_elections
  DROP CONSTRAINT IF EXISTS politician_elections_no_policies_pair;
ALTER TABLE politician_elections
  ADD CONSTRAINT politician_elections_no_policies_pair CHECK ((no_policies_at IS NULL) = (no_policies_source_url IS NULL));
COMMENT ON COLUMN politician_elections.no_policies_at IS '選舉公報上這位候選人的政見欄沒有任何政策條目（公報未填政見）被確認的時間；不為空就不再派補政見任務、報表算已抄';
COMMENT ON COLUMN politician_elections.no_policies_source_url IS '公報未填政見的出處（中選會選舉公報網址）；跟 no_policies_at 同時有或同時沒有';

-- ② 派工臂
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
    -- 公報未填政見（2026-11-20）：這個人這一屆的參選紀錄標了 no_policies_at＝公報政見欄沒有任何條目，不再派補政見
    AND NOT EXISTS (SELECT 1 FROM politician_elections pn WHERE pn.politician_id = c.id AND pn.election_id = c.eid
                      AND pn.election_type = c.election_type AND pn.no_policies_at IS NOT NULL)
    AND NOT (c.cs IN ('declared', 'filed') AND c.election_type = ANY ((SELECT mcfg.election_types FROM mcfg)::TEXT[])
             AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL))
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', c.eid,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN current_position_missing(c.current_position) THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN current_position_missing(c.current_position) THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁']
         -- ★ ipdb.tw：只在當屆（2026）村里長、鄉鎮市民代表、直轄市山地原住民區民代表多給一條（只給網域，不給路徑）
         || CASE WHEN c.eid = 2026 AND c.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')
                 THEN ARRAY['ipdb.tw（政精選，2026 候選人照片／號次）'] ELSE ARRAY[]::TEXT[] END, 1, c.region
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
                            'official_list_published', CURRENT_DATE >= s.list_announced_on,
                            'reconcile', rr.u),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。把該縣市這個選舉的參選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'
           || roster_reconcile_text(rr.u)
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
  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）
  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, s.election_type, l.name) AS u) rr ON TRUE
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
    -- 名冊對帳：登記彙總表有的單位，只在有「系統對不上」的人時才派（唯一對上的由系統建）；沒有對帳資料的單位照舊派
    AND (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)
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
       -- 公報未填政見（2026-11-20）：這一屆的參選紀錄標了 no_policies_at 就不再派
       AND NOT EXISTS (SELECT 1 FROM politician_elections pn WHERE pn.politician_id = i0.politician_id AND pn.election_id = i0.election_id
                         AND pn.election_type = i0.election_type AND pn.no_policies_at IS NOT NULL)
       -- 去重：零政見的 2026 候選人留給 policy_missing（跟 raw 臂 c2026 同條件）
       -- 只在 2026 還沒投票時去重（OPS #81）：當屆缺政見投票日就收，投票隔天起零政見的 2026 參選人改由這支接手，不然兩邊都不派
       AND (NOT EXISTS (SELECT 1 FROM politician_elections c JOIN elections ce ON ce.id = c.election_id WHERE c.politician_id = i0.politician_id AND c.election_id = (SELECT campaign_election_id()) AND ce.election_date >= activity_today() AND c.candidacy_status IS DISTINCT FROM 'withdrawn')
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
                || '**公報那一欄確實沒有任何政策條目（空白，或只寫「沒有政見」這類話）**：改回 no_change＋outcome=confirmed＋finding_kind=bulletin_no_policies，checked_urls 第一個放這份公報，finding 寫那一欄的原文大意；同儕驗證通過後這一屆標為「公報未填政見」、不再派。'
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

-- ③ 人物頁讀的視圖
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
                END, 'sourceNote', pe.source_note, 'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing, 'noPoliciesAt', pe.no_policies_at, 'noPoliciesSourceUrl', pe.no_policies_source_url, 'electionDate', pee.election_date)) AS json_agg
           FROM ((politician_elections pe
             LEFT JOIN regions per ON ((pe.region_id = per.id)))
             LEFT JOIN elections pee ON ((pee.id = pe.election_id)))
          WHERE (pe.politician_id = p.id)), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', COALESCE(orr.region, p.region), 'subRegion', COALESCE(orr.sub_region, p.sub_region), 'village', COALESCE(orr.village, p.village), 'termEnd', o.scheduled_end_date, 'electionDate', oe.election_date) ORDER BY oe.election_date DESC, o.election_id DESC) AS json_agg
           FROM ((politician_offices o
             LEFT JOIN regions orr ON ((orr.id = o.region_id)))
             LEFT JOIN elections oe ON ((oe.id = o.election_id)))
          WHERE ((o.politician_id = p.id) AND (o.end_date IS NULL) AND (o.start_date <= CURRENT_DATE))), '[]'::json) AS offices,
    -- 疑似同人標記：輸出時排除已解決（politician_pair_resolutions 已有結論）與已合併（merged_into 不為空）的 id；空了就是 NULL
    NULLIF(ARRAY(SELECT x FROM unnest(p.possible_duplicate_of) AS x
                  WHERE NOT EXISTS (SELECT 1 FROM politicians o WHERE o.id = x AND o.merged_into IS NOT NULL)
                    AND NOT EXISTS (SELECT 1 FROM politician_pair_resolutions pr WHERE pr.pair_key = politician_pair_key(p.id, x))), '{}'::UUID[]) AS possible_duplicate_of
   FROM (politicians p
     LEFT JOIN regions r ON ((p.region_id = r.id)));
ALTER VIEW politicians_with_elections SET (security_invoker = on);

-- ④ 「已抄」口徑：有政見，或標了公報未填政見。一人一屆一職位一列（不含退選）。
CREATE OR REPLACE VIEW politician_election_transcribed AS
SELECT pe.politician_id,
       pe.election_id,
       pe.election_type,
       COALESCE(c.policy_count, 0)::int AS policy_count,
       pe.no_policies_at,
       (COALESCE(c.policy_count, 0) > 0 OR pe.no_policies_at IS NOT NULL) AS transcribed
  FROM politician_elections pe
  LEFT JOIN politician_election_policy_counts c ON c.politician_id = pe.politician_id AND c.election_id = pe.election_id
 WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn';
ALTER VIEW politician_election_transcribed SET (security_invoker = on);
GRANT SELECT ON politician_election_transcribed TO anon, authenticated;
COMMENT ON VIEW politician_election_transcribed IS '每人每屆每職位的「已抄」口徑：transcribed＝有未移除政見，或參選紀錄標了公報未填政見（no_policies_at）。已抄／應有的報表一律讀這支，不要各算各的（2026-11-20）。';

NOTIFY pgrst, 'reload schema';
