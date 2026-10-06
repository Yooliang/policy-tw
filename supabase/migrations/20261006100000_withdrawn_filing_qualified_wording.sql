-- #345 後續兩項（主線 10-06 裁定）：退選前有沒有登記派工讓代理查；三支 SQL 派工臂的說明改成「名單公告後填 qualified」
-- ============================================================
--
-- 照 10-05 常設裁決「資料一律走流程」：這支只改派工臂與查證來源清單，**不改任何人物或參選紀錄**。
--
-- 1. 退選前有沒有登記（#380 未決 3）：退選的參選紀錄 `withdrawn_after_filing` 空的（看不出退選前登記過沒有，網站只能寫「不參選」），
--    10-06 唯讀有 83 筆，全是 2026 縣市長、早期匯入就是 not_running、沒有查核履歷。新臂 contribution_auto_tasks_withdrawn_filing
--    一筆一件，附中選會的登記名冊當線索（還沒投票的屆別＝這一屆的候選人登記彙總表；已投票的屆別＝中選會選舉資料庫的名單），
--    代理查完用 correction 把那一列的 withdrawn_after_filing 改成 true（登記後退選）或 false（沒登記過）——
--    欄位與說法照 #380：true「登記後退選」、false「表態不參選」、空的「不參選」。correction 開放這一欄在 _shared/contribution-schema.ts
--    （協議 1.55.0），門檻是一般更正（3），**不動計分**。
--    沿用既有任務型別 not_running_recheck（「核對不參選這一列跟登記名冊」本來就是它），task_id 另加 filing 段
--    （auto:not_running_recheck:filing:<參選紀錄 id>），不跟原本那種撞號；同一列原本的不參選重查改由這支一起問，免得同一個人派兩件。
--    10-06 唯讀拿 83 位對中選會 115 年直轄市長、縣市長登記彙總表：0 位在名冊上——多半會補成「表態不參選」。
-- 2. 查證來源清單補兩份名冊：中選會 2026 直轄市長、縣市長候選人登記彙總表（同 20260930000002 補議員那兩份的做法），
--    任務現況（task-context）的 verification_sources 也會附上。
-- 3. 三支 SQL 派工臂的說明還寫「candidate_status 填 confirmed」（#380 未決 1）：#380 起 confirmed 只表示表態參選，
--    名單公告後（含已投票屆別）在名單上的是 qualified。落庫端已經會把公告後的 confirmed 換成 qualified，資料不會錯，
--    這裡把說明改成對的講法：contribution_auto_tasks_elected_missing、_roster_cec_gap、_raw（2026 名單清查公告後那段）；
--    _region_gap 的狀態標籤「確定參選」改「表態參選」。順手拿掉同幾支裡「補得票數與得票率」（1.51.0 起不收）。
--
-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：
--   politician_elections(id, politician_id, election_id, election_type, candidate_status, candidacy_status, withdrawn_after_filing,
--                        verified, region_id, source_note)、politicians(id, name, region, merged_into)、regions(id, region)、
--   elections(id, election_date)、cec_candidates(election_id, election_type, region, sub_region, name_norm, cand_no, elected)、
--   verification_sources(name, kind, regions, election_types, provides, list_url, access, quality_note, how_to, last_checked, status, sort)、
--   contributions(contribution_type, status, task_id, payload, source_urls, applied_at)

-- ── 1. 查證來源：2026 直轄市長、縣市長候選人登記彙總表 ─────────────────────
INSERT INTO verification_sources
  (name, kind, party, regions, election_types, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    '中選會 2026 直轄市長候選人登記彙總表（六都）', 'cec', NULL,
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'],
    ARRAY['縣市長'],
    ARRAY['candidacy', 'roster'],
    'https://web.cec.gov.tw/api/file/bb9a8d7a-9b8a-41ec-8e23-33efd009385a.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，六都全部登記候選人：選舉區、登記日期、姓名、推薦之政黨。登記期間已結束，這份就是登記名單；不在上面的就是沒登記',
    '下載 PDF 找本人那一列，核對縣市與推薦之政黨（「無」＝未經政黨推薦）',
    '2026-10-06', 'ok', 5
  ),
  (
    '中選會 2026 縣市長候選人登記彙總表（其餘 16 縣市）', 'cec', NULL,
    ARRAY['基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['縣市長'],
    ARRAY['candidacy', 'roster'],
    'https://web.cec.gov.tw/api/file/370f3bbf-6408-4fdc-b8d8-9b9214913f74.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，六都以外 16 縣市全部登記候選人：選舉區、登記日期、姓名、推薦之政黨。登記期間已結束，這份就是登記名單；不在上面的就是沒登記',
    '下載 PDF 找本人那一列，核對縣市與推薦之政黨（「無」＝未經政黨推薦）',
    '2026-10-06', 'ok', 5
  )
ON CONFLICT (name) DO NOTHING;

-- ── 2. 三支 SQL 派工臂的說明：名單公告後（含已投票屆別）在名單上的填 qualified（#380 未決 1）──────────
-- 只換說明文字（各支其餘一字不改，withdrawn-filing.test.ts 比對上一版）；raw 那支同時是 2026 名單清查公告後那段與
-- election_result_missing 那段（後者順手拿掉「補得票數與得票率」：1.51.0 起不收）。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH c2026 AS (
    SELECT p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.source_note, pe.candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.candidate_status NOT IN ('not_running')
  ),
  ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidate_status NOT IN ('not_running')
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:policy_missing:' || c.id, 'policy_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '候選人）目前 0 筆政見。請找該候選人有出處的具體政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處；找到幾筆交幾筆，只找到 1 筆就交 1 筆，不要為了湊數交口號、願景或個人表態。先看 current.queued_policies，別人交了還在等票的不要再交。2026 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（2022／2024／2026）並在 note 說明',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 1, c.region
  FROM c2026 c
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL)
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN current_position_missing(c.current_position) THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN current_position_missing(c.current_position) THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c2026 c
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
  WHERE pl.removed_at IS NULL AND (pl.source_url IS NULL OR pl.source_url = '')
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
        AND pe.election_result IN ('not_elected', 'withdrawn')
    )
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 已投票的屆別查得到；2026 尚未公告',
               '該縣市選舉委員會官網（2026 登記名單）', 'cna.com.tw 登記參選名單'], 1, c.region
  FROM c2026 c
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
                '【現在是登記階段】登記已於 2026-09-04 截止，但官方候選人名單要到 ' || s.list_announced_on::TEXT
                  || ' 才公告（直轄市長是 11-12），資格審查 10-16 前完成、10-23 抽號次。'
                  || '所以現在補的是「已登記」而不是「已審定」：candidacy 的 candidate_status 填 registered，不要填 confirmed，也還沒有號次可填。'
                  || '另外，登記已經截止，所以我們資料裡還標著 rumored（傳聞參選）或 likely（可能參選）的人，只要不在登記名單上就是沒登記：請用 correction 把他那筆的 candidate_status 改成 not_running。'
              END
           || '最後用 roster_check 型別回報這次清查（名單上共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。'
           -- 前一位代理查不到時，明講不要再去 db.cec.gov.tw：那是舊版把它排在第一個
           -- 造成的，43 個縣市一次都沒清查成功過，不寫清楚下一位會重蹈同一條死路。
           || CASE WHEN rc.last_attempt_without_count IS NOT NULL
                   THEN '注意：前一位代理回報查不到官方名單（見 target.last_failed_attempt）。'
                        || '請不要再去 db.cec.gov.tw 找——那是選舉結果資料庫，它自己標明「投票後 7 日內更新」，'
                        || '2026 的資料要等 12 月才會進去。改從該縣市選舉委員會官網的登記公告、或媒體的登記名單彙整下手。'
                   ELSE '' END
           || '查不到名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址——那筆不會把縣市標記為已清查，只會讓它隔天再派。',
         CASE WHEN CURRENT_DATE >= s.list_announced_on
              THEN ARRAY['該縣市選舉委員會官網的候選人名單公告', 'bulletin.cec.gov.tw 選舉公報', 'web.cec.gov.tw 中選會公告', 'cna.com.tw 候選人名單彙整']
              ELSE ARRAY['該縣市選舉委員會官網的登記公告', 'web.cec.gov.tw 中選會新聞稿', 'cna.com.tw 登記參選名單彙整', 'ltn.com.tw／udn.com 登記名單'] END,
         2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN LATERAL (
    -- 兩個時鐘：真的清查完的（cec_count 有值）壓 recheck_days；
    -- 只是試過沒找到的壓 roster_attempt_cooldown_days
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
  UNION ALL
  SELECT 'auto:policy_election_missing:' || pl.id, 'policy_election_missing',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'source_url', pl.source_url),
         '政見「' || pl.title || '」（' || p.name || '）沒有標所屬屆別，網站上顯示成「未標註屆別」。'
           || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，那種用 removal 型別回報（需 3 票），不要補屆別。'
           || '是政見就請打開它的來源網址，確認這是哪一場選舉的承諾（或哪一個任期內的施政），'
           || '再用 correction 型別把 policies.election_id 改成該選舉的年份（2022／2024／2026）。'
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
                            'election_type', pe.election_type, 'candidate_status', pe.candidate_status,
                            'region', COALESCE(r.region, p.region), 'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '還標著「' || CASE pe.candidate_status WHEN 'rumored' THEN '傳聞參選' ELSE '可能參選' END || '」，'
           || '但登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，這時候只有兩種可能：'
           || '**在登記名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered（附登記名單網址）；'
           || '**不在名單上** → 改成 not_running（一樣附你查的那份名單，說明找過了沒有他）。'
           || '兩者都要附得出那份名單；查不到該縣市的登記名單就用 no_change 回報，不要用猜的把人留在「傳聞」。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  WHERE pe.candidate_status IN ('rumored', 'likely')
    AND s.registration_closed_on <= CURRENT_DATE
  UNION ALL
  SELECT 'auto:election_result_missing:' || pe.id, 'election_result_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'party', p.party,
                            'region', COALESCE(r.region, p.region), 'election_id', pe.election_id,
                            'election_type', pe.election_type, 'election_date', e.election_date),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '名下有政見，但我們沒有他那場選舉的結果——那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || '請到中選會查這個選區的結果，用 candidacy 型別補 election_result（elected 或 not_elected；得票數、得票率不收，不用查）。'
           || '這筆補上之後他名下的競選承諾才追得動：當選才要查兌現，落選就不再派任務。'
           || '查不到官方結果就不要猜，用 no_change 回報並說明你查了哪些網址。',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否、得票數、得票率',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會原始 API，回歷屆參選',
               'cna.com.tw'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  JOIN elections e ON e.id = pe.election_id
  LEFT JOIN regions r ON r.id = pe.region_id
  WHERE pe.election_result IS NULL
    AND pe.candidate_status NOT IN ('not_running')
    AND e.election_date < CURRENT_DATE
    -- 只問名下有政見的人。已投票屆別、結果空白的參選紀錄有 14,289 筆，全倒進任務池
    -- 會把其他缺口整個擠掉；而這個缺口的用途是解鎖承諾追蹤，沒政見的人解鎖了也沒用。
    -- 這個條件把 14,289 收斂成 54。
    AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = pe.politician_id AND pl.removed_at IS NULL)
$function$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_elected_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH ours AS (
    -- 我們已經有的（屆別, 選舉別, 正規化姓名）；不看狀態——有紀錄但結果空白的是 election_result_missing 另一支臂的事
    SELECT DISTINCT pe.election_id, pe.election_type, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
     WHERE pe.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
  ),
  missing AS (
    SELECT c.*
      FROM cec_candidates c
     WHERE c.elected
       AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長')
       AND NOT EXISTS (SELECT 1 FROM ours o
                        WHERE o.election_id = c.election_id AND o.election_type = c.election_type AND o.nn = c.name_norm)
  ),
  same_name AS (
    SELECT cec_name_key(p.name) AS nn, count(*) AS n
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND cec_name_key(p.name) IN (SELECT m.name_norm FROM missing m)
     GROUP BY 1
  )
  -- 中選會候選人 id 只在同一個場次（theme）內唯一，所以連場次一起放；兩者每次同步都一樣
  SELECT 'auto:election_result_missing:cec:' || COALESCE(m.cec_theme_id, m.election_id::TEXT) || ':' || COALESCE(m.cec_cand_id::TEXT, m.name_norm),
         'election_result_missing',
         jsonb_build_object('name', m.name, 'region', m.region, 'sub_region', m.sub_region,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_cand_id', m.cec_cand_id, 'cec_theme_id', m.cec_theme_id,
                            'same_name_politicians', COALESCE(s.n, 0), 'record_missing', true),
         '中選會 ' || m.election_id || ' ' || m.election_type || ' 的當選名單上有「' || m.name || '」（'
           || m.region || COALESCE(' ' || m.sub_region, '') || '），我們卻沒有他這一屆的參選紀錄——網站上他沒有這個職稱，名下的競選承諾也追不動。'
           || '請到中選會選舉資料庫（db.cec.gov.tw）核對後，用 candidacy 型別補一筆：election_id 填 ' || m.election_id
           || '、election_type 填「' || m.election_type || '」、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 填 elected'
           || CASE WHEN m.region = '全國' THEN '、region 填「全國」、electoral_district 填「' || COALESCE(m.sub_region, '') || '」'
                   WHEN m.election_type IN ('縣市議員', '立法委員') THEN '、region 填「' || m.region || '」、electoral_district 填選區'
                   WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、region 填「' || m.region || '」、sub_region 填「' || COALESCE(m.sub_region, '鄉鎮市區') || '」'
                   ELSE '、region 填「' || m.region || '」' END
           || '（得票數、得票率不收，不用查）；cec_cand_id 填 ' || COALESCE(m.cec_cand_id::TEXT, '（中選會候選人 id）')
           || '、cec_theme_id 填「' || COALESCE(m.cec_theme_id, '') || '」。'
           || CASE WHEN COALESCE(s.n, 0) = 0 THEN '我們的資料庫裡沒有同名的人，只填 name 就好，系統會建立人物。'
                   ELSE '我們的資料庫裡有 ' || s.n || ' 位同名的人，先用第 7 節的唯讀查詢看他們的參選紀錄與出生年，確定是同一人才填他的 politician_id；不是就只填 name，系統會請你指認。' END
           || 'source_urls 附中選會的頁面。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選與當選',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}',
               'https://db.cec.gov.tw/'],
         1, m.region
    FROM missing m
    JOIN elections e ON e.id = m.election_id
    LEFT JOIN same_name s ON s.nn = m.name_norm
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_cec_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT c.election_id, c.election_type, c.name, c.name_norm, c.sub_region, c.village, c.elected, c.cand_no, c.cec_cand_id,
           replace(c.region, '臺', '台') AS county,
           -- 一個鄉鎮動輒幾十人的三種，以鄉鎮市區為單位；代表的 sub_region 是「南投市第01選舉區」「蘭嶼鄉選舉區」，去掉選舉區
           CASE WHEN c.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')
                THEN COALESCE(NULLIF(regexp_replace(COALESCE(c.sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''), '')
                ELSE '' END AS town
      FROM cec_candidates c
     -- 不分區立委是政黨名單，不是個人參選；當選的由 contribution_auto_tasks_elected_missing 派
     WHERE NOT (c.region = '全國' AND c.sub_region = '不分區')
  ),
  ours AS (
    SELECT DISTINCT pe.election_id, pe.election_type, replace(COALESCE(r.region, p.region), '臺', '台') AS county, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_id IN (SELECT DISTINCT x.election_id FROM cec_candidates x)
  ),
  marked AS (
    SELECT c.*,
           EXISTS (SELECT 1 FROM ours o
                    WHERE o.election_id = c.election_id AND o.election_type = c.election_type
                      AND o.county = c.county AND o.nn = c.name_norm) AS matched,
           -- 當選而且是 elected_missing 那五種：那支臂逐位派任務，這裡不重複列
           COALESCE(c.elected, false) AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長') AS covered_elsewhere
      FROM c
  ),
  units AS (
    SELECT m.election_id, m.election_type, m.county, m.town,
           count(*) AS cec_n,
           count(*) FILTER (WHERE m.elected) AS cec_elected,
           count(*) FILTER (WHERE m.matched) AS ours_n,
           count(*) FILTER (WHERE NOT m.matched) AS missing_n,
           count(*) FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS list_n,
           jsonb_agg(jsonb_build_object('name', m.name, 'sub_region', m.sub_region, 'village', m.village,
                                        'elected', m.elected, 'cand_no', m.cand_no, 'cec_cand_id', m.cec_cand_id)
                     ORDER BY m.sub_region, m.village, m.cand_no, m.name)
             FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS missing
      FROM marked m
     GROUP BY m.election_id, m.election_type, m.county, m.town
  ),
  picked AS (
    SELECT u.*, u.county || u.town AS unit,
           -- 這一種選舉，candidacy 的地區欄怎麼填
           CASE
             WHEN u.election_type = '村里長'
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」、village 填每位的村里（target.missing 的 village）'
             WHEN u.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」（鄉鎮市區名，不要寫選舉區）'
             WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN 'region 填「' || u.county || '」、sub_region 填每位的鄉鎮市區（target.missing 的 sub_region）'
             WHEN u.election_type = '縣市議員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選舉區（target.missing 的 sub_region，例：第07選舉區）'
             WHEN u.election_type = '立法委員' AND u.county = '全國'
               THEN 'region 填「全國」、electoral_district 填每位的 sub_region（平地原住民或山地原住民）'
             WHEN u.election_type = '立法委員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選區（target.missing 的 sub_region）'
             ELSE 'region 填「' || u.county || '」'
           END AS fields_how
      FROM units u
     WHERE u.list_n > 0
       -- 我們 0 筆，或明顯偏少（少 3 位以上而且少兩成以上）；零星一兩位多半是姓名寫法不同，交給 cec_reconcile 那條路
       AND (u.ours_n = 0 OR (u.missing_n >= 3 AND u.missing_n * 5 >= u.cec_n)
            -- 已經派出去的單位：補到一半缺口變小（中山區 87 位補了 70 位，剩 17 位不到兩成）也要繼續派，
            -- 直到補完、或有人交 roster_check 收尾——不然門檻會在補到一半時把任務收回，剩下的人永遠沒人補（PGlite 實跑抓到的）
            OR EXISTS (SELECT 1 FROM task_dispatches d
                        WHERE d.task_id = 'auto:roster_check:' || u.election_id || ':' || u.county || u.town || ':' || u.election_type))
  )
  SELECT 'auto:roster_check:' || x.election_id || ':' || x.unit || ':' || x.election_type,
         'roster_check',
         jsonb_build_object('election_id', x.election_id, 'region', x.unit, 'county', x.county, 'township', NULLIF(x.town, ''),
                            'election_type', x.election_type, 'list_source', 'cec',
                            'cec_count', x.cec_n, 'cec_elected', x.cec_elected, 'ours_count', x.ours_n,
                            'missing_count', x.list_n,
                            -- 一件最多列 120 位（大安區 98 位是目前最多的）；多的補完一批，下一輪會列出剩下的
                            'missing', jsonb_path_query_array(x.missing, '$[0 to 119]'),
                            'missing_truncated', x.list_n > 120,
                            'last_checked', rc.last_checked, 'last_failed_attempt', rc.last_attempt_without_count),
         x.unit || ' ' || x.election_id || ' ' || x.election_type || '名單缺人：中選會選舉資料庫上有 ' || x.cec_n || ' 位候選人（當選 '
           || x.cec_elected || ' 位），我們只對得上 ' || x.ours_n || ' 位；要補的 ' || x.list_n || ' 位列在 target.missing'
           || CASE WHEN x.list_n > 120 THEN '（只列前 120 位，補完下一輪會列出剩下的）' ELSE '' END || '。'
           || '這一屆已經投票，名單就在中選會選舉資料庫（db.cec.gov.tw），不用去找登記公告。'
           || '請逐位核對後，每位用 candidacy 型別補一筆：election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、'
           || x.fields_how
           || '、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 照中選會填 elected 或 not_elected（查得到號次 cand_no 就一起附；得票數不收），'
           || 'source_urls 附你核對的中選會頁面；系統會拿中選會的資料自動核對，我們資料庫裡已有這個人（同名只有一位）而且姓名、縣市、當選與否都對得上的，直接上線。'
           || '名字相同不代表同一人：先用第 7 節的唯讀查詢看我們有沒有同名的人、他的參選紀錄與出生年，確定是同一人才填他的 politician_id，不是就只填 name。'
           || '一次最多 20 筆，可分多次交。全部補完才用 roster_check 收尾（election_id、region、election_type 照 target 原樣帶回，region 就是「'
           || x.unit || '」這一串；cec_count 填中選會名單上的人數）；只補了一部分就不要交 roster_check，剩下的人系統下一輪會再派。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：選該屆、該選舉、該縣市（鄉鎮）看完整名單與得票',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 逐位核對歷屆參選與當選',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":' || x.election_id || '}'],
         2, x.county
    FROM picked x
    LEFT JOIN LATERAL (
      -- 兩個時鐘（同 2026 的清查）：真的清查完的（cec_count 有值）壓 30 天；只是試過沒查到的壓 roster_attempt_cooldown_days
      SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
             MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
        FROM roster_checks k
       WHERE k.election_id = x.election_id AND k.region = x.unit AND k.election_type = x.election_type
    ) rc ON TRUE
   WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - INTERVAL '30 days')
     AND (rc.last_attempt_without_count IS NULL
          OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;

-- region_gap：狀態標籤「確定參選」→「表態參選」（confirmed 只表示表態參選）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status, pe.position,
           p.id AS politician_id, p.name, p.party,
           COALESCE(r.region, p.region) AS county,
           NULLIF(concat_ws(' ', r.sub_region, r.village), '') AS attached_below_county,
           pe.region_id IS NULL AS no_region,
           pe.election_type IN ('縣市議員', '立法委員')
             AND pe.candidate_status <> 'not_running'
             AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region) AS no_district,
           -- 掛錯層級：不是縣市層級、也不是這種選舉的選區（立委的「全國」那一列算縣市層級，缺的是選區）
           pe.region_id IS NOT NULL
             AND (r.village IS NOT NULL
                  OR (r.sub_region IS NOT NULL AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region))) AS wrong_level
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')
  ),
  gaps AS (
    SELECT g.*,
           -- 縣市長掛錯層級＝縣市待確認；議員、立委掛錯層級本來就算缺選區
           g.no_region OR (g.wrong_level AND g.election_type = '縣市長') AS need_region,
           CASE g.candidate_status
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '表態參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district OR g.wrong_level
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.need_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'attached_to', CASE WHEN x.wrong_level THEN x.county || ' ' || x.attached_below_county END,
                            'submitted_region', sub.submitted_region,
                            'cec_listed_as', cec.listed_as),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，' || x.status_label || '）的參選紀錄'
           || CASE WHEN x.no_region AND x.no_district THEN '沒有縣市也沒有選區'
                   WHEN x.no_region THEN '沒有縣市'
                   WHEN x.wrong_level
                   THEN '掛在「' || x.county || ' ' || x.attached_below_county || '」——'
                        || CASE WHEN x.election_type = '縣市長' THEN '縣市長的參選紀錄只該記到縣市' ELSE '那不是' || x.election_type || '的選區' END
                        || '（多半是同一個人其他選舉的地區，例如里長那一筆的村里、立委那一筆的選區）'
                   ELSE '只記到縣市、沒有選區' END
           || '，網站的' || CASE WHEN x.no_region THEN '縣市篩選撈不到他'
                                WHEN x.wrong_level AND x.election_type = '縣市長' THEN '參選地區顯示錯了'
                                WHEN x.wrong_level THEN '選區分組把他放錯地方'
                                ELSE '選區篩選撈不到他' END || '。'
           || CASE WHEN sub.submitted_region IS NOT NULL
                   THEN '【先確認是不是同一個人】建立這筆紀錄的交件寫的縣市是「' || sub.submitted_region || '」，現在卻記在「' || COALESCE(x.county, '（空的）')
                        || '」——多半是同名的另一個人被對到這位人物名下。請用登記名冊與出生年、經歷核對：是同一個人就照名冊填 region 與選區重交；'
                        || '不是同一個人就不要交 candidacy（會把別人的參選掛在他名下），改用 no_change 回報，finding 寫「掛錯人：名冊上的是' || sub.submitted_region || '的同名者」。'
                   ELSE '' END
           || CASE WHEN x.candidate_status = 'not_running'
                   THEN '這筆是「表態不參選」的紀錄，要補的是他當初被傳要選、後來表態不選的那個縣市'
                        || COALESCE('（職位欄現在寫「' || x.position || '」，可以當線索，但要附出處）', '') || '。'
                   ELSE '' END
           || '請查證後用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、region 填縣市（用「台」不用「臺」）'
           || CASE WHEN x.no_district THEN '、electoral_district 填' || x.district_how ELSE '' END
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照現有資料原樣帶；'
           || 'source_urls 附看得出' || CASE WHEN x.no_district THEN '選區' ELSE '縣市' END || '的出處。'
           || CASE WHEN cec.listed_as IS NOT NULL
                   THEN '中選會選舉資料庫的名單上記的是「' || cec.listed_as || '」：請打開 db.cec.gov.tw 核對是同一個人後照填，source_urls 附你核對的那一頁。'
                   WHEN x.election_id = 2026 AND x.candidate_status <> 'not_running'
                   THEN '2026 的縣市與選區在中選會候選人登記彙總表（web.cec.gov.tw/central/article/64709，各級選舉的 PDF 逐列寫著選區）；'
                        || '已登記的要附中選會名冊或登記截止後的報導，不然交件會被擋；附名冊網址的，系統會逐位核對、吻合的一票就過。'
                   WHEN x.candidate_status = 'not_running'
                   THEN '不參選的出處通常是當事人表態或政黨提名的新聞報導。'
                   ELSE '' END
           || '查不到可信出處就用 no_change 回報你查了哪些網址，不要猜。',
         CASE WHEN x.candidate_status = 'not_running'
              THEN ARRAY['cna.com.tw', 'udn.com', 'ltn.com.tw', '政黨官網的提名公告']
              WHEN x.election_id = 2026
              THEN ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選區）',
                         COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com']
              ELSE ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，回選舉區',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份}', 'cna.com.tw'] END,
         1, x.county
    FROM gaps x
    -- 中選會名單（已投票的屆別才有）上全國同名同選舉別只有一位時，把他的縣市＋選區當線索附上；同名多位就不給，免得指錯人
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as
        FROM cec_candidates c
       WHERE c.election_id = x.election_id AND c.election_type = x.election_type AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
    -- 建立這筆參選紀錄的交件寫的縣市（只看建立那一次；edit_history 有 (table_name, record_id) 索引，缺口只有幾百筆）。
    -- 跟現在記的縣市一樣、交件沒寫縣市、是全國、或現在根本沒有縣市（那是「補縣市」，不是對錯人）就不提
    LEFT JOIN LATERAL (
      SELECT s.submitted_region
        FROM (SELECT translate(c.payload->>'region', '臺', '台') AS submitted_region
                FROM edit_history eh
                JOIN contributions c ON c.id = eh.contribution_id
               WHERE eh.table_name = 'politician_elections' AND eh.record_id = x.pe_id::TEXT AND eh.field = '*'
               ORDER BY eh.applied_at
               LIMIT 1) s
       WHERE x.county IS NOT NULL
         AND s.submitted_region IS NOT NULL AND s.submitted_region <> '全國'
         AND s.submitted_region <> translate(x.county, '臺', '台')
    ) sub ON true
$$;

-- ── 3. 退選前有沒有登記：派工臂（#380 未決 3）────────────────────────────
-- 一筆退選、看不出退選前有沒有登記的參選紀錄＝一件。線索：
--   還沒投票的屆別：查證來源清單裡這種選舉的中選會登記名冊（縣市對得上的那一份；縣市不明就全附）
--   已投票的屆別：中選會選舉資料庫的名單（cec_candidates）上同屆、同選舉別、同縣市、同名的那一位（在選票上＝登記過）
--   以前不參選重查的代理已經回報「確實不在登記名單上」的，附上那一次（日期與核對的網址），省得重找
CREATE OR REPLACE FUNCTION contribution_auto_tasks_withdrawn_filing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status, pe.source_note,
           p.id AS politician_id, p.name, replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           e.election_date, e.election_date < CURRENT_DATE AS voted
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL
  ),
  -- 已經有人交了這一欄的更正、還在等票的先不派（同一列交一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT c.payload->>'target_id' AS target_id
      FROM contributions c
     WHERE c.contribution_type = 'correction' AND c.status IN ('pending', 'verified')
       AND c.payload->>'target_table' = 'politician_elections'
       AND (c.payload->>'field' = 'withdrawn_after_filing' OR c.payload->'changes' @> '[{"field":"withdrawn_after_filing"}]'::jsonb)
  ),
  x AS (
    SELECT w.*,
           COALESCE(
             (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
               WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
                 AND w.election_type = ANY (v.election_types) AND w.county = ANY (v.regions)),
             (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
               WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
                 AND w.election_type = ANY (v.election_types))
           ) AS rosters,
           (SELECT jsonb_build_object('checked_at', c.applied_at, 'checked_urls', c.payload->'checked_urls')
              FROM contributions c
             WHERE c.task_id = 'auto:not_running_recheck:' || w.pe_id AND c.contribution_type = 'no_change'
               AND c.status = 'applied' AND c.payload->>'outcome' = 'confirmed'
             ORDER BY c.applied_at DESC NULLS LAST LIMIT 1) AS prior_check
      FROM w
     WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.target_id = w.pe_id::TEXT)
  )
  SELECT 'auto:not_running_recheck:filing:' || x.pe_id,
         'not_running_recheck',
         jsonb_build_object('kind', 'withdrawn_filing', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_date', x.election_date,
                            'candidate_status', x.candidate_status, 'source_note', x.source_note,
                            'rosters', to_jsonb(x.rosters),
                            'cec_listed_as', cec.listed_as,
                            'prior_not_on_roster', x.prior_check),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）標成「不參選」，'
           || '但看不出他退選之前有沒有登記過，網站只能寫「不參選」——「登記後退選」跟「從沒登記、只是表態不選」對當事人是兩件很不一樣的事。'
           || '請查證後用 correction 補上：target_table 填 politician_elections、target_id 填 ' || x.pe_id
           || '，changes 改 withdrawn_after_filing，reason 要寫出他的姓名「' || x.name || '」與你核對的名冊。'
           || '**不在登記名冊上（從沒登記過）** → 改成 false，網站會寫「表態不參選」；'
           || '**在登記名冊上、後來宣布退選** → 改成 true，網站會寫「登記後退選」，再附一篇退選的報導；'
           || '**在登記名冊上、而且還在選** → 這一列標錯了，不要改這一欄，改用 correction 把 candidate_status 改成 registered（附名冊）。'
           || CASE WHEN x.voted
                   THEN '這一屆已經投票：' || CASE WHEN cec.listed_as IS NOT NULL
                                                 THEN '中選會選舉資料庫的名單上有同名的「' || cec.listed_as || '」——先確認是同一個人；在選票上就是登記過。'
                                                 ELSE '中選會選舉資料庫的名單上沒有同屆、同選舉別、同縣市、同名的人（打開 db.cec.gov.tw 再確認一次）。' END
                   WHEN x.rosters IS NOT NULL
                   THEN '中選會這一屆的候選人登記彙總表（逐列寫著選舉區、登記日期、姓名、推薦之政黨）：' || array_to_string(x.rosters, '、') || '。'
                   ELSE '登記名冊在中選會 web.cec.gov.tw/central/article/64709（各級選舉的候選人登記彙總表 PDF）。' END
           || CASE WHEN x.prior_check IS NOT NULL
                   THEN '之前不參選重查的代理（' || to_char((x.prior_check->>'checked_at')::timestamptz AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')
                        || '）回報過他「確實不在登記名單上」（target.prior_not_on_roster），可以先打開那份名單核對。'
                   ELSE '' END
           || '找不到名冊就用 no_change（outcome 填 unreachable 或 not_found）回報你查了哪些網址，不要猜。',
         CASE WHEN x.voted
              THEN ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（在選票上＝登記過）',
                         'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}']
              ELSE COALESCE(x.rosters, ARRAY[]::TEXT[])
                   || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表',
                            COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'] END,
         2, x.county
    FROM x
    -- 已投票的屆別：中選會名單上同屆、同選舉別、同縣市、同名只有一位時當線索（同名多位不給，免得指錯人）
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '') || COALESCE(' ' || c.village, '')) END AS listed_as
        FROM cec_candidates c
       WHERE x.voted AND c.election_id = x.election_id AND c.election_type = x.election_type
         AND replace(c.region, '臺', '台') = x.county AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
$$;
COMMENT ON FUNCTION contribution_auto_tasks_withdrawn_filing IS
  '退選、看不出退選前有沒有登記過（withdrawn_after_filing 空的）的參選紀錄，一筆一件，附中選會登記名冊當線索；'
  '代理用 correction 改 withdrawn_after_filing（true 登記後退選／false 沒登記過）。沿用 not_running_recheck 型別（#345 後續，2026-10-06）';

-- 不參選重查：看不出退選前有沒有登記的，改由上面那支一起問（同一份名冊、同一個人不派兩件）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_not_running()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:not_running_recheck:' || pe.id, 'not_running_recheck',
         jsonb_build_object('politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name,
                            'election_id', pe.election_id, 'election_type', pe.election_type,
                            'region', COALESCE(r.region, p.region), 'source_note', pe.source_note,
                            'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '被標成「不參選」，但沒有任何人對過官方登記名單——這一列多半是早期匯入時就這樣寫的。'
           || '**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人，所以它值得被核對一次。'
           || '登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，名單現在查得到。請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對：'
           || '**他在名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered，附那份名單；'
           || '**確實不在名單上** → 用 no_change 回報、outcome 填 confirmed，checked_urls 放你核對的那份名單（這時系統才會把這一列標成已核對，不再重派）；'
           || '**找不到該縣市的名單** → no_change 但 outcome 填 unreachable 或 not_found，那不會把它標成已核對，過幾天換人再試。'
           || 'target.source_note 是這一列的匯入來歷，僅供參考——實測很多寫著「可能再次挑戰」卻被標成不參選，不要拿它當證據。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'],
         2, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  JOIN elections e ON e.id = pe.election_id
  WHERE pe.candidate_status = 'not_running'
    AND s.registration_closed_on <= CURRENT_DATE
    -- 投票日過了就不必再問「他有沒有登記」，那時該問的是結果
    AND (e.election_date IS NULL OR e.election_date >= CURRENT_DATE)
    AND pe.verified IS NOT TRUE
    -- 退選前有沒有登記（#345 後續，2026-10-06）：看不出來的由 contribution_auto_tasks_withdrawn_filing 派（同一份名冊一起問）；
    -- 登記後退選的本來就在名冊上，再問「在不在名冊上」會把退選改回已登記；代理照名冊查過、交更正補上這一欄的，等於核對過名冊
    AND NOT (pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL)
    AND pe.withdrawn_after_filing IS NOT TRUE
    AND NOT EXISTS (SELECT 1 FROM edit_history h
                     WHERE h.table_name = 'politician_elections' AND h.record_id = pe.id::TEXT
                       AND h.field = 'withdrawn_after_filing' AND h.reverted_at IS NULL)
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_not_running IS
  '被標成不參選、但沒人對過官方登記名單的參選紀錄 → not_running_recheck 任務；no_change 且 outcome=confirmed 才把 verified 設 true。'
  '2026-10-06 起退選前有沒有登記看不出來的（withdrawn_after_filing 空的）改由 contribution_auto_tasks_withdrawn_filing 派；'
  '登記後退選的（true）、代理已照名冊交更正補上那一欄的不再問';

-- ── 4. 接進派工（其餘照抄 20261006073460） ─────────────────────────────
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
  UNION ALL SELECT * FROM contribution_auto_tasks_career_sources()
  UNION ALL SELECT * FROM contribution_auto_tasks_withdrawn_filing()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處（contribution_auto_tasks_career_sources，沿用 profile_detail_gap，#346）。'
  '2026-10-06 加退選前有沒有登記（contribution_auto_tasks_withdrawn_filing，沿用 not_running_recheck，#345）。';

-- ── 5. 上線當下的數字（只印，不改資料） ───────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '退選前有沒有登記：派 % 件；不參選重查剩 % 件',
    (SELECT count(*) FROM contribution_auto_tasks_withdrawn_filing()),
    (SELECT count(*) FROM contribution_auto_tasks_not_running());
END $$;

NOTIFY pgrst, 'reload schema';
