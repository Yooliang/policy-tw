-- #347 第二階段 B-1：資料庫讀取端不再讀 policies.source_url／tracking_logs.source_url／policy_sources，改讀出處表。
-- **只加不刪、不改簽名**：欄位、表與四支同步觸發器都還在（刪是 B-2，20261007120000，要等這支上線、寫入端也切過去、新寫入路徑在正式環境跑過一輪）。
--
-- 做了什麼：
--   ① policy_primary_url(uuid)：一條政見的主要出處網址（出處表 source_refs 的 primary）。
--   ② source_set_primary(表, id, 網址, 來源)：換掉一筆政見／進度的主要出處（只有 service_role 能呼叫）。
--      原本是 sources_sync_policy／sources_sync_tracking_log 觸發器在 UPDATE OF source_url 時做的事（刪掉舊的主要出處、換新網址），
--      correction 改 policies.source_url 與履歷還原都會走它——欄位刪掉之後觸發器就沒東西可聽了
--   ③ 四支派工臂（raw／legacy／mismatch／policy_elements）的 SQL 改讀 policy_primary_url()，不再讀 pl.source_url。
--      其餘派工函式的 source_url 是別張表自己的欄位（policy_elements、lineage_*、politician_offices、roster_checks）或只在說明文字裡
--   ④ 交件當下的登記：sources_sync_contribution 兼做「選舉公報／選委會公告的網址在交件當下就登記進 sources，排程才能趕在下架前存檔」
--      （被退件的也存）。B-2 要刪那支觸發器，這裡先把這件事拆成獨立的 sources_register_contribution（只做登記）；
--      過渡期兩支都會跑，登記是冪等的
--   ⑤ 對正式資料核對：政見主要出處網址 vs policies.source_url 逐條一致（只記警告，不擋部署，同第二階段 A）
--
-- 派工臂的行為不變：policy_primary_url(pl.id) 取代 pl.source_url，「沒有出處」改成「沒有主要出處列」
-- （第二階段 A 查過：1,278 條有網址的政見＝1,278 個主要出處，source_refs_drift 空）。

BEGIN;

-- ── ① 政見的主要出處網址 ─────────────────────────────────────
CREATE OR REPLACE FUNCTION policy_primary_url(p_policy_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT s.url
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = 'policies' AND r.target_id = p_policy_id::TEXT AND r.role = 'primary'
   ORDER BY r.created_at, s.id
   LIMIT 1
$$;
COMMENT ON FUNCTION policy_primary_url IS '一條政見的主要出處網址（出處表的 primary；沒有就是 NULL）。#347 第二階段 B-1：派工臂用它取代 policies.source_url';
GRANT EXECUTE ON FUNCTION policy_primary_url(UUID) TO anon, authenticated, service_role;

-- ── ② 換掉主要出處 ───────────────────────────────────────────
-- 跟舊觸發器 sources_sync_policy／sources_sync_tracking_log 的 UPDATE 分支同一個動作：舊的主要出處引用整個刪掉
-- （換掉的原因通常是舊網址沒寫到這筆宣稱，留著當佐證會誤導），新網址升成主要（同一筆資料已經引用過它的，原本是佐證也升成主要）。
-- 網址空白或不是 http(s)：只刪舊的主要出處、不新增。回傳新主要出處的網址（沒有就 NULL）。
CREATE OR REPLACE FUNCTION source_set_primary(
  p_target_table TEXT, p_target_id TEXT, p_url TEXT, p_origin TEXT DEFAULT 'correction'
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sid BIGINT;
  v_url TEXT := btrim(coalesce(p_url, ''));
BEGIN
  IF p_target_table NOT IN ('policies', 'tracking_logs') THEN
    RAISE EXCEPTION 'source_set_primary 只支援 policies／tracking_logs（收到 %）', p_target_table;
  END IF;
  IF coalesce(p_target_id, '') = '' THEN
    RAISE EXCEPTION 'source_set_primary 缺 target_id';
  END IF;
  DELETE FROM source_refs WHERE target_table = p_target_table AND target_id = p_target_id AND role = 'primary';
  v_sid := source_upsert(v_url, coalesce(p_origin, 'correction'), NULL, NULL, NULL, now());
  IF v_sid IS NULL THEN RETURN NULL; END IF;
  INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
  VALUES (v_sid, p_target_table, p_target_id, 'primary', coalesce(p_origin, 'correction'))
  ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
  RETURN v_url;
END;
$$;
REVOKE EXECUTE ON FUNCTION source_set_primary(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION source_set_primary(TEXT, TEXT, TEXT, TEXT) TO service_role;
COMMENT ON FUNCTION source_set_primary IS '換掉一筆政見／進度的主要出處（舊的主要出處引用刪掉、新網址升成主要）。correction 改 source_url 與履歷還原用；只有 service_role。#347 第二階段 B-1';

-- ── ④ 交件當下的登記（從 sources_sync_contribution 拆出來）──────
CREATE OR REPLACE FUNCTION sources_register_contribution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_url TEXT;
BEGIN
  BEGIN
    FOREACH v_url IN ARRAY coalesce(NEW.source_urls, ARRAY[]::TEXT[]) LOOP
      IF source_doc_kind(btrim(v_url)) IS NOT NULL THEN
        PERFORM source_upsert(v_url, 'contribution', NULL, NULL, NULL, coalesce(NEW.created_at, now()));
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sources_register_contribution(%): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sources_register_contribution ON contributions;
CREATE TRIGGER trg_sources_register_contribution AFTER INSERT ON contributions
  FOR EACH ROW EXECUTE FUNCTION sources_register_contribution();
COMMENT ON FUNCTION sources_register_contribution IS '交件當下：選舉公報／選委會公告類的網址先登記進 sources，排程才能在投票前就存檔（公報投票後下架，等驗證通過才存可能來不及；被退件的也存）。只做登記，出處引用由落庫端 source_write() 寫。#347 第二階段 B-1（從 sources_sync_contribution 拆出）';

-- ── ③ 派工臂：不再讀 pl.source_url ───────────────────────────
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
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
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
  WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
    AND e.election_date < CURRENT_DATE
    -- 只問名下有政見的人。已投票屆別、結果空白的參選紀錄有 14,289 筆，全倒進任務池
    -- 會把其他缺口整個擠掉；而這個缺口的用途是解鎖承諾追蹤，沒政見的人解鎖了也沒用。
    -- 這個條件把 14,289 收斂成 54。
    AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = pe.politician_id AND pl.removed_at IS NULL)
$function$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT 'auto:legacy_audit:' || pl.id, 'legacy_audit',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region, 'source_url', policy_primary_url(pl.id)),
         '「' || pl.title || '」（' || p.name || '）是早期由系統匯入的政見，附了來源但從沒有人核對過。'
           || '請打開來源：標題與內容是不是這個人的承諾、內容有沒有寫錯、屬於哪一場選舉。'
           || '資料正確 → 用 no_change 回報，outcome 填 confirmed（note 寫你核對了什麼，這筆才算查核過）；'
           || '欄位有錯 → correction 改對；不是政見（口號、行程、表態）→ removal（target_table policies、target_id、reason ≥20 字）。'
           || '**來源拿不到（打不開、逾時、被導去不相干的頁面、付費牆）→ no_change 但 outcome 填 unreachable**，'
           || '那不會把這筆標成已核對，過幾天會換人再試；**來源打得開卻證明不了這筆政見 → 不要回 no_change**，'
           || '那是 correction（欄位錯）或 removal（整筆不該存在）。'
           || '**每一個 source_url 都要打開**：同一批匯入的政見會互相借錯連結（實例：吳怡農的國防政見掛到 2023 敗選報導），'
           || '主題相符不等於這一頁證明了這筆政見。'
           || 'item.current.system_check 是系統對這個來源的逐欄核對結果，可以參考但請自己看過；'
           || '系統判 cannot_tell 是「系統看不出來」，不是「已確認沒問題」，不可以拿它當背書。',
         ARRAY[policy_primary_url(pl.id)], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL
    AND policy_primary_url(pl.id) IS NOT NULL
    AND p.merged_into IS NULL
    -- 查核過＝有人蓋過 audit 章，或這筆本來就是走貢獻流程建的（edit_history 的整列紀錄 field='*'）。
    -- 原本寫「沒有任何 edit_history 列」，於是只改過一欄的政見也被永久排除：實測 98 筆是這樣消失的，
    -- 多半是 policy_election_missing 只改了 election_id——那次代理打開來源只為了判斷屆別，沒有核對整筆。
    AND NOT EXISTS (
      SELECT 1 FROM edit_history e
      WHERE e.table_name = 'policies' AND e.record_id = pl.id::TEXT AND e.field IN ('audit', '*')
    )
    -- 「是貢獻建出來的」只有新增政見那一種（contribution_type='policy'）。
    -- 原本不看型別，於是任何一筆改到這筆政見的 correction／policy_progress，甚至一筆
    -- 回報「來源打不開」的 no_change，都會把 applied_policy_id 設成它而永久排除——
    -- 線上已有 133 筆落庫的 correction，收窄 edit_history 那條卻不收這條，等於沒改。
    AND NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.applied_policy_id = pl.id AND c.contribution_type = 'policy'
    )
$function$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH jev AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.probability
    FROM jev_decisions j
    WHERE j.subject_type = 'policy' AND j.question = 'election'
    ORDER BY j.subject_id, j.asked_at DESC
  ),
  by_date AS (
    SELECT pl.id
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.proposed_date IS NOT NULL
      AND pl.proposed_date > e.election_date
      -- 2026-09-22 #5：當選者任內提出的施政掛在當選那一屆是對的
      AND NOT EXISTS (
        SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.candidacy_status = 'elected'
      )
  ),
  by_jev AS (
    SELECT pl.id
    FROM policies pl
    JOIN jev ON jev.subject_id = pl.id::TEXT
    WHERE pl.removed_at IS NULL
      AND pl.election_id IS NOT NULL
      AND jev.choice ~ '^\d{4}$'
      AND jev.choice <> pl.election_id::TEXT
      AND jev.probability >= 0.8
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', policy_primary_url(pl.id),
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END) AS target,
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。' AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
$function$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, policy_primary_url(pl.id) AS source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           CASE c.election_year
             WHEN 2022 THEN 'https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面'
             WHEN 2024 THEN 'https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報'
             ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$function$;

-- ── ⑤ 核對與自檢 ─────────────────────────────────────────────
DO $$
DECLARE
  v_diff INTEGER;
  v_n INTEGER;
BEGIN
  -- 主要出處網址跟舊欄位逐條一致（差異是資料不是這支的錯，只記警告）
  SELECT count(*) INTO v_diff FROM policies pl
   WHERE btrim(coalesce(pl.source_url, '')) IS DISTINCT FROM coalesce(policy_primary_url(pl.id), '');
  IF v_diff > 0 THEN
    RAISE WARNING '#347-B1 有 % 條政見的主要出處網址跟 policies.source_url 不一致（看 source_refs_drift）', v_diff;
  ELSE
    RAISE NOTICE '#347-B1 政見主要出處網址與 policies.source_url 逐條一致';
  END IF;
  -- 派工臂改完要還能跑（函式在交易裡才建好，執行時才會發現欄位或型別對不上）
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_raw();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_legacy();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_mismatch();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_policy_elements();
  -- 權限：換主要出處只有 service_role
  IF has_function_privilege('anon', 'public.source_set_primary(text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.source_set_primary(text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '#347-B1 source_set_primary 不能開給 anon／authenticated';
  END IF;
END $$;

COMMIT;
