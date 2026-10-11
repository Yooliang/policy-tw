-- 收掉逐筆補開票結果（raw:election_result_missing），一律走整批版（工作單 Yooliang/policy-ops#72；
-- 決定 policy-ops docs/decisions/2026-10-10-逐筆補開票結果收掉.md，維護者 2026-10-10）。
--
-- 逐筆版（contribution_auto_tasks_raw 的 election_result_missing 分支，只派名下有政見的人）與整批版（contribution_auto_tasks_election_results，
-- 中選會名單對得上的一個單位一件、對不上的逐位派 election_result_missing）兩支並存，同一個人會被兩種任務派。
-- 正式庫唯讀 parity（10-10）：逐筆版算出 374 件，窗口開著的 18 件，這 18 人全在整批版的單位件裡；其餘 356 件
-- 整批版改後都接得住（對不上名單的逐位件，task_id 跟逐筆版同一個）。
--
-- 這支做三件事：
--   1. 整批版「對不上的逐位派」拿掉「名下沒有政見」的限制（那個限制只是為了不跟逐筆版重複）
--   2. contribution_auto_tasks_raw 拿掉 election_result_missing 分支（其餘一字不動）
--   3. activity_arm_names 拿掉 'raw:election_result_missing'；它的規則（rule_id 13）與主控台段落那一列一併刪除
-- 任務型別 election_result_missing 留著：整批版對不上名單的逐位件、elected_missing 都還在用（協議、四處清點不動）。
-- 已在等票的 candidacy 交件照常處理。窗口開著的那 18 件逐筆任務下一輪 seed 收回（原因 filled），人都在整批件裡。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_election_results()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH gap AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
     -- 投票日之後才派：移到規則（activity_rules「election_results」：投票日 +1 起，P2 20261008070000）；這裡不再比日期
     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
  ),
  -- 已經有人交了、還在等票的不再派（同一份名單抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT (it->>'politician_election_id')::INTEGER AS id
      FROM contributions c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END) it
     WHERE c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')
       AND (it->>'politician_election_id') ~ '^[0-9]{1,9}$'
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT g.id FROM gap g WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.id = g.id)))
  ),
  units AS (
    SELECT m.*,
           CASE WHEN m.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town
      FROM m WHERE m.cec_hits = 1
  ),
  numbered AS (
    SELECT u.*,
           (row_number() OVER w - 1) / 120 + 1 AS part,
           (count(*) OVER (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town) - 1) / 120 + 1 AS parts
      FROM units u
    WINDOW w AS (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town
                 ORDER BY u.town NULLS LAST, u.village NULLS LAST, u.name, u.politician_election_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts,
           count(*) AS items_count,
           jsonb_agg(n.politician_election_id ORDER BY n.town NULLS LAST, n.village NULLS LAST, n.name, n.politician_election_id) AS ids
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  )
  -- 批次：一個單位一件（超過 120 位拆成幾件）
  SELECT 'auto:election_results_missing:' || g.election_id || ':' || g.election_type || ':' || g.county
           || COALESCE(':' || g.unit_town, '') || CASE WHEN g.parts > 1 THEN ':p' || g.part ELSE '' END,
         'election_results_missing',
         jsonb_build_object('election_id', g.election_id, 'election_type', g.election_type, 'region', g.county,
                            'sub_region', g.unit_town, 'election_date', e.election_date,
                            'part', g.part, 'parts', g.parts, 'items_count', g.items_count,
                            'politician_election_ids', g.ids),
         g.county || COALESCE(g.unit_town, '') || ' ' || g.election_id || ' ' || g.election_type || '：'
           || '我們有 ' || g.items_count || ' 位參選人的選舉結果還空著'
           || CASE WHEN g.parts > 1 THEN '（這個單位太大，拆成 ' || g.parts || ' 件，這是第 ' || g.part || ' 件）' ELSE '' END
           || '，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。名單在 current.items：每一位附系統比對到的中選會那一列（cec），那是線索不是答案。'
           || '請打開中選會選舉資料庫這個單位的結果逐位核對（同名不同人要看選區、村里、出生年），交一筆 election_results：'
           || 'election_id 填 ' || g.election_id || '、election_type 填「' || g.election_type || '」、region 填「' || g.county || '」'
           || CASE WHEN g.unit_town IS NOT NULL THEN '、sub_region 填「' || g.unit_town || '」' ELSE '' END
           || '，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。核對不了或不是同一個人的不要放進 items，在 note 寫是哪幾位。'
           || 'source_urls 第一個放你核對的中選會那一頁。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：依屆別、選舉、縣市（鄉鎮）點到結果表，當選者有標記',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 個別查一位的歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否'],
         1, g.county
    FROM grouped g
    JOIN elections e ON e.id = g.election_id
  UNION ALL
  -- 對不上的（同縣市同名多位、名單查無）：各自派 election_result_missing，附名單上同縣市同名的人請代理指認。
  -- 名下有政見的也在這裡派（20261010170000 起逐筆版 raw:election_result_missing 收掉，OPS #72）
  SELECT 'auto:election_result_missing:' || m.politician_election_id,
         'election_result_missing',
         jsonb_build_object('politician_id', m.politician_id, 'name', m.name, 'region', m.county,
                            'sub_region', m.town, 'village', m.village,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_hits', m.cec_hits,
                            'cec_same_name', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object('sub_region', cc.sub_region, 'village', cc.village, 'birth_year', cc.birth_year,
                                                                  'elected', cc.elected, 'cec_cand_id', cc.cec_cand_id, 'cec_theme_id', cc.cec_theme_id)
                                               ORDER BY cc.sub_region, cc.village)
                                FROM cec_candidates cc
                               WHERE cc.election_id = m.election_id AND cc.election_type = m.election_type
                                 AND cc.region = m.county AND cc.name_norm = cec_name_key(m.name)), '[]'::jsonb)),
         m.name || '（' || COALESCE(m.county, '') || COALESCE(' ' || m.town, '') || COALESCE(' ' || m.village, '') || ' '
           || m.election_id || ' ' || m.election_type || '）的選舉結果還空著，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || CASE WHEN m.cec_hits = 0 THEN '系統在中選會名單上找不到同縣市同名、地區也對得上的人（多半是地區或姓名寫錯）。'
                   ELSE '中選會名單上同縣市同名、地區也對得上的有 ' || m.cec_hits || ' 位，系統分不出是哪一位（target.cec_same_name）。' END
           || '請到中選會選舉資料庫核對他是哪一位，用 candidacy 補 election_result（elected 或 not_elected），帶 politician_id；'
           || '名單上真的沒有他、或確定不是同一個人，用 no_change 回報你查了哪些網址，不要猜。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}'],
         1, m.county
    FROM m
    JOIN elections e ON e.id = m.election_id
   WHERE m.cec_hits <> 1
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH c2026 AS (
    SELECT p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.source_note,
           -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
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

CREATE OR REPLACE FUNCTION activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'raw:policy_missing',
    'raw:profile_gap',
    'raw:policy_validity',
    'raw:progress_stale',
    'raw:candidacy_source_missing',
    'raw:roster_check',
    'raw:policy_election_missing',
    'raw:candidate_status_stale',
    'dup',
    'legacy',
    'mismatch',
    'policy_dup',
    'not_running',
    'mayor_policies',
    'term_policies',
    'roster_villages',
    'township_gap',
    'region_gap',
    'elected_missing',
    'roster_cec_gap',
    'district_seats',
    'policy_elements',
    'deadline_due',
    'lineage_candidates',
    'handover_missing',
    'lineage_roles',
    'lineage_links',
    'career_sources',
    'withdrawn_filing',
    'party_gap',
    'party_roster',
    'party_info',
    'placeholder_politicians',
    'election_results',
    'owner_mismatch',
    'ballot_numbers',
    'manual_visitor',
    'manual_open',
    'regional_stats_missing'
  ]::TEXT[]
$$;

DELETE FROM activity_rules WHERE id = 13 AND activity = 'raw:election_result_missing';
DELETE FROM console_arm_stage_map WHERE arm = 'raw:election_result_missing';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM activity_rules WHERE activity IN ('raw:election_result_missing', 'priority:raw:election_result_missing')) THEN
    RAISE EXCEPTION '逐筆補開票結果還有規則';
  END IF;
  IF 'raw:election_result_missing' = ANY (activity_arm_names()) THEN
    RAISE EXCEPTION 'activity_arm_names 還有 raw:election_result_missing';
  END IF;
END $$;
