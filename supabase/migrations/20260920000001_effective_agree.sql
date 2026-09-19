-- 有效門檻只有一份（外部審查 2026-09-19 建議 1）。
--
-- 20260919000015 把系統票 not_supported 改成「門檻 +1」，但派工池（contribution_verify_pool）與 TS 的
-- filterVerifyCandidates 還在用原門檻：同意票一達原門檻就不再派，卻永遠差一票——那筆會永久卡在 pending
--（實查 1 筆：卡伊．馬賴）。這裡把「有效門檻」抽成一支函式，計票、派工池、/next 與 /report 的回應都用它。

CREATE OR REPLACE FUNCTION contribution_effective_agree(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE v_need INTEGER; v_sys TEXT;
BEGIN
  SELECT contribution_required_agree(contribution_type, payload, source_urls) INTO v_need
  FROM contributions WHERE id = p_contribution_id;
  IF v_need IS NULL THEN RETURN NULL; END IF;
  v_sys := contribution_system_vote(p_contribution_id);
  RETURN CASE WHEN v_sys = 'supported' THEN GREATEST(1, v_need - 1)
              WHEN v_sys = 'not_supported' THEN v_need + 1
              ELSE v_need END;
END;
$$;
COMMENT ON FUNCTION contribution_effective_agree IS
  '這筆貢獻現在要幾張代理同意票：原門檻依系統票 supported −1（最少 1）／not_supported +1。計票、派工池、回應欄位共用這一支。';

-- 計票改呼叫同一支
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_status TEXT; v_new TEXT; v_need_eff INTEGER;
BEGIN
  SELECT
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'agree'),
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'disagree'),
    COUNT(*) FILTER (WHERE verdict = 'unsure')
  INTO v_agree, v_disagree, v_unsure
  FROM contribution_votes WHERE contribution_id = p_contribution_id;

  SELECT status INTO v_status FROM contributions WHERE id = p_contribution_id;
  -- 系統票已折進有效門檻：supported → GREATEST(1, v_need - 1)；not_supported → v_need + 1（見 contribution_effective_agree）
  v_need_eff := contribution_effective_agree(p_contribution_id);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 兩張代理反對＝爭議；達標且反對 ≤1 通過；其餘 pending。沒有懸空。
    IF v_disagree >= 2 THEN v_new := 'disputed';
    ELSIF v_agree >= v_need_eff AND v_disagree <= 1 THEN v_new := 'verified';
    ELSE v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;
COMMENT ON FUNCTION contribution_apply_consensus IS
  '代理票依來源 IP 去重；門檻取 contribution_effective_agree（系統票已折進去）；兩張反對才是爭議，達標且反對 ≤1 通過。';

-- 派工池：用有效門檻，並把它回給呼叫端
DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         contribution_effective_agree(c.id) AS effective_required
  FROM contributions c
  WHERE c.status = 'pending'
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    -- 已經湊夠「有效」門檻的不用再驗（系統票折進去了；之前用原門檻會把 not_supported 的那筆永久卡住）
    AND c.agree_count < contribution_effective_agree(c.id)
  ORDER BY c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '/next 的驗證候選池：同 IP 提交／投過的、已達有效門檻的都在 LIMIT 之前排掉，回最早的 N 筆；effective_required 是這筆現在要幾張同意票。';

-- policy_validity 任務敘述寫明 removal 的三個欄位（審查建議 3：代理讀任務敘述的機率比翻 skill.md 高）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
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
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN c.current_position IS NULL THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN c.current_position IS NULL THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c2026 c
  WHERE c.birth_year IS NULL OR c.current_position IS NULL OR c.avatar_url IS NULL
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
                  || ' 公告，請以公告名單為準：candidacy 的 candidate_status 填 confirmed，查得到號次就一起附上。'
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
           || '請到中選會查這個選區的結果，用 candidacy 型別補 election_result（elected 或 not_elected），查得到就一起補得票數與得票率。'
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
$fn$;

-- PostgREST 計算欄位：select=*,effective_agree 就拿得到有效門檻（contribution-status／contributions-feed／tasks 用）
CREATE OR REPLACE FUNCTION effective_agree(c contributions) RETURNS INTEGER
LANGUAGE sql STABLE AS $$ SELECT contribution_effective_agree(c.id) $$;

-- ============ 合併可還原＋門檻（外部審查建議 6）============
-- 之前 merge_politician() 只記兩列 edit_history（merged_into／merged_from），revert 只會把 merged_into 設回 NULL，
-- 搬走的政見與參選、補上的欄位、刪掉的鍵、改指向的提問／指認、pair 結論全都留在原地——「可還原」只是名義上的。
-- 這裡每一個寫入都記一列；planRevert 對「field='*'、old=整列、new=NULL」的列會把那一列 INSERT 回來。
ALTER TABLE politician_pair_resolutions ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS politician_pair_resolutions_id_idx ON politician_pair_resolutions (id);

CREATE OR REPLACE FUNCTION merge_politician(p_keep UUID, p_remove UUID, p_contribution UUID, p_agent TEXT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_keep politicians%ROWTYPE; v_remove politicians%ROWTYPE;
  v_policies INTEGER := 0; v_elections INTEGER := 0; v_filled TEXT[] := ARRAY[]::TEXT[];
  r RECORD; k RECORD; v_pair TEXT; v_res_id UUID; v_field TEXT;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'keep 與 remove 是同一筆'; END IF;
  SELECT * INTO v_keep FROM politicians WHERE id = p_keep;
  SELECT * INTO v_remove FROM politicians WHERE id = p_remove;
  IF v_keep.id IS NULL OR v_remove.id IS NULL THEN RAISE EXCEPTION '找不到人物'; END IF;
  IF v_keep.merged_into IS NOT NULL THEN RAISE EXCEPTION '保留的那筆本身已被合併'; END IF;
  IF v_remove.merged_into IS NOT NULL THEN RAISE EXCEPTION '要併入的那筆已經合併過'; END IF;
  v_pair := politician_pair_key(p_keep, p_remove);

  -- 政見：每筆一列
  FOR r IN SELECT id FROM policies WHERE politician_id = p_remove LOOP
    UPDATE policies SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    v_policies := v_policies + 1;
  END LOOP;

  -- 參選紀錄：同一場已有 → keep 那列補空欄（每欄一列）、remove 那列整列記下再刪；沒有 → 整列搬過去
  FOR r IN SELECT * FROM politician_elections WHERE politician_id = p_remove LOOP
    SELECT * INTO k FROM politician_elections WHERE politician_id = p_keep AND election_id = r.election_id;
    IF k.id IS NOT NULL THEN
      FOREACH v_field IN ARRAY ARRAY['position', 'slogan', 'election_type', 'region_id', 'election_result', 'votes_received', 'vote_percentage', 'source_note'] LOOP
        IF to_jsonb(k)->v_field IS NULL OR to_jsonb(k)->v_field = 'null'::jsonb THEN
          IF to_jsonb(r)->v_field IS NOT NULL AND to_jsonb(r)->v_field <> 'null'::jsonb THEN
            EXECUTE format('UPDATE politician_elections SET %I = $1.%I WHERE id = $2', v_field, v_field) USING r, k.id;
            INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
            VALUES ('politician_elections', k.id::TEXT, v_field, NULL, to_jsonb(r)->v_field, p_contribution, p_agent);
          END IF;
        END IF;
      END LOOP;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_elections WHERE id = r.id;
    ELSE
      UPDATE politician_elections SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_elections := v_elections + 1;
  END LOOP;

  -- 身份鍵：keep 已有的整列記下再刪；其餘搬過去
  FOR r IN SELECT * FROM politician_keys kk WHERE kk.politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM politician_keys k2 WHERE k2.politician_id = p_keep AND k2.key_type = r.key_type AND k2.key_value = r.key_value) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_keys WHERE id = r.id;
    ELSE
      UPDATE politician_keys SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
  END LOOP;

  -- 提問、票的指認、審查的指認：每列一筆
  FOR r IN SELECT id FROM citizen_questions WHERE politician_id = p_remove LOOP
    UPDATE citizen_questions SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('citizen_questions', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM contribution_votes WHERE resolved_politician_id = p_remove LOOP
    UPDATE contribution_votes SET resolved_politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('contribution_votes', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM politician_identity_reviews WHERE resolved_politician_id = p_remove LOOP
    UPDATE politician_identity_reviews SET resolved_politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_identity_reviews', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;

  -- 保留那筆的空欄用併入那筆補：每欄一列
  FOREACH v_field IN ARRAY ARRAY['birth_year', 'avatar_url', 'education_level', 'bio', 'current_position', 'sub_region', 'region'] LOOP
    IF (to_jsonb(v_keep)->v_field IS NULL OR to_jsonb(v_keep)->v_field = 'null'::jsonb)
       AND to_jsonb(v_remove)->v_field IS NOT NULL AND to_jsonb(v_remove)->v_field <> 'null'::jsonb THEN
      EXECUTE format('UPDATE politicians SET %I = $1.%I WHERE id = $2', v_field, v_field) USING v_remove, p_keep;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', p_keep::TEXT, v_field, NULL, to_jsonb(v_remove)->v_field, p_contribution, p_agent);
      v_filled := v_filled || v_field;
    END IF;
  END LOOP;

  -- 舊列留著、標記併入誰
  UPDATE politicians SET merged_into = p_keep WHERE id = p_remove;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', p_remove::TEXT, 'merged_into', NULL, to_jsonb(p_keep::TEXT), p_contribution, p_agent);

  -- 配對結論：整列記下（revert 會把它刪掉，這一對就會重新派任務）
  DELETE FROM politician_pair_resolutions WHERE pair_key = v_pair;
  INSERT INTO politician_pair_resolutions (pair_key, a, b, resolution, contribution_id)
  VALUES (v_pair, LEAST(p_keep, p_remove), GREATEST(p_keep, p_remove), 'same', p_contribution)
  RETURNING id INTO v_res_id;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  SELECT 'politician_pair_resolutions', v_res_id::TEXT, '*', NULL, to_jsonb(x), p_contribution, p_agent FROM politician_pair_resolutions x WHERE x.id = v_res_id;

  RETURN jsonb_build_object('moved_policies', v_policies, 'moved_elections', v_elections, 'filled', to_jsonb(v_filled));
END;
$$;
COMMENT ON FUNCTION merge_politician IS '軟合併：每個寫入各記一列 edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回；只由 apply 呼叫';

-- 門檻：merge_politician 從 removal 級改成 high（官方 4／媒體 6／社群 8／其他 8）——誤併的代價比誤刪高；
-- 系統票不再折進去：Jev 的 same_person 看的是我們自己的欄位，不是獨立證據
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;

CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress')
$$;

-- 還在投票中的 merge_politician 依新門檻重算
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE contribution_type = 'merge_politician' AND status IN ('pending', 'verified') LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
