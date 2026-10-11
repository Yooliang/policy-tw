-- 當屆類 15 支臂補上起訖（工作單 Yooliang/policy-ops#81，維護者 2026-10-11「好 13 支」，再加第 6 段任期中兩支）——提案，維護者點頭才合
-- ============================================================
--
-- 26 支規則還是 P1 種子的「永遠開」；其中 13 支是當屆類，主控台時間軸整條綠。這支把其中 8 支改成照里程碑開關（rule_id 不變、原地 UPDATE），
-- 另外 4 支維持永遠開並寫明理由；再加第 6 段的政見進度過期、到期政見兩支（就職日起、不設迄日、查不到照開），共 15 支；
-- 當屆缺政見到投票日為止，投票後由補舊屆政見（term_policies，改成投票日 +1 起自動開）接手。正式庫唯讀試算（10-11，用跟 activity_open 一樣的里程碑比對）收回件數寫在每一列的 note 與 PR 說明。
--
--   臂                              起                       迄                  今天收回  投票隔天（11-29）收回
--   raw:policy_missing（當屆缺政見）  —                        投票日              0        1,427（投票後交給補舊屆政見慢慢補，維護者 10-11）
--   term_policies（補舊屆政見）       投票日 +1                 —（不設迄日）       0        0：2026 那屆的手動開關（election_task_config.enabled）改成照里程碑自動開
--   mayor_policies（縣市長政見）      —                        投票日              0        23
--   raw:roster_check（名單清查）      登記截止                  投票日              0        66
--   roster_villages（村里長名單）     登記截止                  投票日              0        360
--   district_seats（選區名額）        —                        投票日              22（2022）44
--   raw:candidacy_source_missing     —                        投票日              0        3
--   withdrawn_filing（撤回登記）      登記截止                  名單公告日          0        0（今天沒有任務）
--   roster_cec_gap（中選會名單對不上）投票日 +1                 —（不設迄日）       0        0
--   raw:progress_stale（政見進度過期） 就職日                    —（不設迄日）       1        0（任期屆滿後照常追，維護者 10-11：進度追蹤是本站重點）
--   deadline_due（到期政見）          就職日                    —（不設迄日）       0        0（今天沒有任務）
--     ↑ 兩支加 params.open_when_unknown：屆別或職位查不到（資料缺）照舊開著，今天收回的只剩 2026 還沒就職的 1 件
--     ↑ 只改一般那條（rule 5、24，排除村里長）；村里長「有流量才開」那兩條（rule 45、46）照舊永遠開
--   elected_missing（當選人缺紀錄）   投票日 +1                 —（不設迄日）       0        0
--   handover_missing、lineage_candidates／links／roles：維持永遠開（理由見下）
--
-- 跟主線預設不同的地方（PR 說明附理由）：
--   * 名單清查、村里長名單的起點用「登記截止」不用「名單公告日」：它們是照中選會「登記彙總表」核對（登記截止後就有），
--     不是照公告的候選人名單；用名單公告日（11-17）今天會先收回 426 件、11-17 再全部重開。
--   * 中選會名單對不上、當選人缺紀錄不設迄日：兩支都只看 cec_candidates（開票後中選會資料庫的名單），在派的全是 2022／2024 已投票屆別
--     還沒補齊的人（215、112 件）；設「開票後 180 天」今天就收回 327 件、那些人永遠補不到。起點投票日 +1 讓 2026 開票前不派。
--   * 交接缺漏、政見傳承三支維持永遠開：傳承三支的任務 target 沒有選舉（259 件 election_id 全空），照選舉里程碑開窗會整批收回；
--     交接缺漏本體已經只在前一任任期屆滿後才派（from_term_end < 今天）。要照段落畫，得先讓任務帶上選舉，另案。
-- 起訖都照每場選舉、每個職位自己的里程碑；沒有該里程碑的舊屆別窗口關著（迄日型的看投票日，每場都有）。

-- 時間窗判斷：規則可以設 params.open_when_unknown＝屆別或職位查不到時照開（只多一段 OR，其餘一字不動；日本站不跟，走樣守門登記成拿掉這一段）
CREATE OR REPLACE FUNCTION activity_open(
  p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT activity_today()
) RETURNS TABLE (
  source TEXT, rule_id BIGINT, override_id BIGINT, election_id INTEGER, election_type TEXT,
  milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE
)
LANGUAGE sql STABLE AS $$
  WITH el AS (SELECT e.id, e.election_reason FROM elections e WHERE e.id = p_election_id),
  ov AS (
    SELECT o.id, o."force", o.open_from, o.open_until
      FROM activity_overrides o
     WHERE o.activity = p_activity
       AND (o.election_id IS NULL OR o.election_id = p_election_id)
       AND (o.election_type IS NULL OR o.election_type = p_election_type)
       AND (o.expires_at IS NULL OR p_today <= o.expires_at)
  ),
  ov_open AS (
    SELECT o.* FROM ov o
     WHERE o."force" = 'open'
        OR (o."force" = 'window' AND (o.open_from IS NULL OR p_today >= o.open_from) AND (o.open_until IS NULL OR p_today <= o.open_until))
  ),
  rule_rows AS (
    SELECT r.id AS rid, f.kind AS mkind, f.on_date AS mdate,
           CASE WHEN f.on_date IS NOT NULL THEN f.on_date + r.from_offset END AS xopen,
           CASE WHEN u.on_date IS NOT NULL THEN u.on_date + r.until_offset END AS xuntil
      FROM activity_rules r
      LEFT JOIN el ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.from_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.until_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) u ON true
     WHERE r.enabled
       AND r.activity = p_activity
       AND (r.reasons IS NULL OR el.election_reason = ANY (r.reasons))
       AND (r.levels IS NULL OR activity_level(p_election_type) = ANY (r.levels))
       AND (r.election_types IS NULL OR p_election_type = ANY (r.election_types))
       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉
       AND (r.jurisdictions IS NULL OR EXISTS (
              SELECT 1 FROM unnest(r.jurisdictions) AS j(x)
               WHERE activity_jurisdiction(p_election_id) = j.x OR activity_jurisdiction(p_election_id) LIKE j.x || ':%'))
       AND (
         r.window_kind = 'always'
         OR (
           (r.from_kind IS NULL OR (f.on_date IS NOT NULL AND p_today >= f.on_date + r.from_offset))
           AND (r.until_kind IS NULL OR (u.on_date IS NOT NULL AND p_today <= u.on_date + r.until_offset))
           AND (r.recur_months IS NULL OR EXTRACT(MONTH FROM p_today)::INTEGER <@ r.recur_months)
           AND activity_status_rank(CASE WHEN r.from_kind IS NOT NULL THEN f.status ELSE u.status END) >= activity_status_rank(r.min_status)
         )
         -- 查不到屆別或職位時照開（規則 params.open_when_unknown，OPS #81；同 #470「職位未知時不排除」）：資料缺不該讓任務被收回，查不到的里程碑當作已到
         OR (COALESCE((r.params->>'open_when_unknown')::BOOLEAN, false)
             AND (p_election_id IS NULL OR p_election_type IS NULL)
             AND (r.from_kind IS NULL OR f.on_date IS NULL OR p_today >= f.on_date + r.from_offset)
             AND (r.until_kind IS NULL OR u.on_date IS NULL OR p_today <= u.on_date + r.until_offset))
       )
  )
  SELECT x.source, x.rule_id, x.override_id, x.election_id, x.election_type, x.milestone_kind, x.milestone_on_date, x.expected_open_on, x.open_until
    FROM (
      SELECT 'override'::TEXT AS source, NULL::BIGINT AS rule_id, o.id AS override_id, p_election_id AS election_id, p_election_type AS election_type,
             NULL::TEXT AS milestone_kind, NULL::DATE AS milestone_on_date, o.open_from AS expected_open_on, o.open_until AS open_until
        FROM ov_open o
       WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov."force" = 'closed')
      UNION ALL
      SELECT 'rule'::TEXT, rr.rid, NULL::BIGINT, p_election_id, p_election_type, rr.mkind, rr.mdate, rr.xopen, rr.xuntil
        FROM rule_rows rr
       WHERE NOT EXISTS (SELECT 1 FROM ov)
    ) x
   ORDER BY x.expected_open_on NULLS LAST, x.rule_id NULLS LAST, x.override_id NULLS LAST
$$;


UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止，投票後交給補舊屆政見（term_policies）慢慢補（維護者 10-11）；10-11 試算今天收回 0、11-29 收回 1,427'
 WHERE id = 3 AND activity = 'raw:policy_missing';

-- 補舊屆政見：投票日 +1 起自動開（維護者 10-11：不靠人 11-29 去 UPDATE）。規則照里程碑；2026 那一屆的設定表開關改成開著，
-- 投票前它本來就沒有可派的（只派當選人與推得出公報的參選人；公報上架後投票前那幾天由規則擋住）。村里長那條（rule 47，有流量才開）不動。
-- 範圍提醒（PR 說明）：這支只對設定表的職位（2026：縣市長、縣市議員、鄉鎮市長）的當選人，加上推得出選舉公報的參選人（含落選人）；
-- 推不出公報的落選人、村里長、代表，投票後不會被補。
UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0,
       note = '當屆類（OPS #81）：投票日 +1 起、不設迄日（當屆缺政見投票日收，投票後由這支接手）；排除村里長（村里長看 rule 47 有流量才開）；2022／2024 投票已過，照舊開著'
 WHERE id = 36 AND activity = 'term_policies';
UPDATE election_task_config
   SET enabled = true, updated_at = now(),
       note = '2026-10-11 起開著（OPS #81）：投票前由規則 term_policies（rule 36，投票日 +1 起）擋住，不再靠人 11-29 手動開'
 WHERE election_id = 2026;

-- 補舊屆政見的去重只在 2026 還沒投票時生效（其餘一字不動）
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
       -- 只在 2026 還沒投票時去重（OPS #81）：當屆缺政見投票日就收，投票隔天起零政見的 2026 參選人改由這支接手，不然兩邊都不派
       AND (NOT EXISTS (SELECT 1 FROM politician_elections c JOIN elections ce ON ce.id = c.election_id WHERE c.politician_id = i0.politician_id AND c.election_id = 2026 AND ce.election_date >= activity_today() AND c.candidacy_status IS DISTINCT FROM 'withdrawn')
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

UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止；10-11 試算今天收回 0、11-29 收回 23'
 WHERE id = 31 AND activity = 'mayor_policies';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表核對，登記截止後才有得查）；10-11 試算今天收回 0、11-29 收回 66'
 WHERE id = 14 AND activity = 'raw:roster_check';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：同名單清查，登記截止起、到投票日為止；10-11 試算今天收回 0、11-29 收回 360'
 WHERE id = 1 AND activity = 'roster_villages';
UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止（名額維護者裁示人工核一次）；10-11 試算今天收回 22（2022）、11-29 收回 44'
 WHERE id = 28 AND activity = 'district_seats';
UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0,
       note = '當屆類（OPS #81）：到投票日為止；10-11 試算今天收回 0（在派的都是 2026）、11-29 收回 3'
 WHERE id = 19 AND activity = 'raw:candidacy_source_missing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'list_published', until_offset = 0,
       note = '當屆類（OPS #81）：登記截止起、到名單公告日為止（沒有「登記開始」里程碑，用登記截止）；10-11 沒有任務'
 WHERE id = 27 AND activity = 'withdrawn_filing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0,
       note = '當屆類（OPS #81）：投票日 +1 起、不設迄日（只看開票後的中選會名單，在派的是 2022／2024 還沒補齊的人）；10-11 試算收回 0'
 WHERE id = 21 AND activity = 'roster_cec_gap';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0,
       note = '當屆類（OPS #81）：投票日 +1 起、不設迄日（只看開票後的中選會當選名單，在派的是 2022／2024 還沒補齊的人）；10-11 試算收回 0'
 WHERE id = 30 AND activity = 'elected_missing';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'term_start', from_offset = 0, until_kind = NULL, until_offset = 0,
       params = params || '{"open_when_unknown": true}'::JSONB,
       note = '第 6 段任期中（OPS #81）：就職日起、不設迄日（任期屆滿後照常追，維護者 10-11）；屆別或職位查不到照開；排除村里長（村里長看 rule 45 有流量才開）；10-11 試算今天收回 1（2026 還沒就職）'
 WHERE id = 5 AND activity = 'raw:progress_stale';
UPDATE activity_rules SET window_kind = 'event', from_kind = 'term_start', from_offset = 0, until_kind = NULL, until_offset = 0,
       params = params || '{"open_when_unknown": true}'::JSONB,
       note = '第 6 段任期中（OPS #81）：就職日起、不設迄日（任期屆滿後照常追，維護者 10-11）；屆別或職位查不到照開；排除村里長（村里長看 rule 46 有流量才開）；10-11 沒有任務'
 WHERE id = 24 AND activity = 'deadline_due';
UPDATE activity_rules SET note = '當屆類但維持永遠開（OPS #81）：本體已經只在前一任任期屆滿後才派；要照段落畫得先讓任務帶上選舉，另案'
 WHERE id = 22 AND activity = 'handover_missing';
UPDATE activity_rules SET note = '當屆類但維持永遠開（OPS #81）：任務 target 沒有選舉，照選舉里程碑開窗會整批收回（10-11 在派 259 件）；要照段落畫得先讓任務帶上選舉，另案'
 WHERE id IN (6, 25, 26) AND activity IN ('lineage_candidates', 'lineage_links', 'lineage_roles');

DO $$
DECLARE v INTEGER;
BEGIN
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (3, 31, 14, 1, 28, 19, 27, 21, 30, 36) AND window_kind = 'event' AND note LIKE '當屆類（OPS #81）%';
  IF v <> 10 THEN RAISE EXCEPTION '當屆類起訖只改到 % 支（應為 10）', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM election_task_config WHERE election_id = 2026 AND enabled) THEN RAISE EXCEPTION '2026 補舊屆政見的設定表開關沒有打開'; END IF;
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (5, 24) AND window_kind = 'event' AND from_kind = 'term_start' AND until_kind IS NULL
     AND (params->>'open_when_unknown')::BOOLEAN;
  IF v <> 2 THEN RAISE EXCEPTION '任期中兩支只改到 % 支（應為 2）', v; END IF;
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (22, 6, 25, 26) AND window_kind = 'always' AND note LIKE '當屆類但維持永遠開（OPS #81）%';
  IF v <> 4 THEN RAISE EXCEPTION '維持永遠開的只標到 % 支（應為 4）', v; END IF;
END $$;
