-- 同名先比生年、真模糊先建新人物掛疑似標記；身分退件改待指認不丟隊尾（協議 1.130.0，2026-11-11，維護者裁示「排吧」）
-- 裁決：docs/decisions/2026-11-11-同名身分系統先比生年真模糊先建新人物掛疑似標記.md
-- 只加不刪：
--   1. politicians.possible_duplicate_of UUID[]（疑似同人，待補生年：缺生年的同名者 id）；contributions.needs_identity_pick（身分原因改回待指認，只退回一次）。
--   2. 觸發器 politicians_clear_possible_duplicate：任一方補上生年、且兩邊生年不同 → 從標記裡拿掉對方（空了設 NULL）；相同則保留，由 duplicate_politician 臂開合併任務。
--   3. contribution_auto_tasks_dup：配對條件多一項「同名＋possible_duplicate_of 指到對方」（以 20261031090000 為底，只多兩處）。
--   4. contribution_verify_pool：needs_identity_pick 的件不被「分數已達標」濾掉（以 20261109170000 為底，只改一個條件）。
--   5. roster_reconcile_rows：名冊有生年（鏡像）、全庫同名者都有生年且都不同 → 照「沒有同名者」處理（以 20261031160000 為底，多 birth_year 與 pn_x 兩處；SET enable_nestloop = off 保留）。merge 的同屆參選紀錄限制不動。
--   6. 視圖 politicians_with_elections 尾端多 possible_duplicate_of（前台人物頁顯示「疑似同人，待補生年」），輸出時排除已解決與已合併的 id。
--   7. 標記出口：不同人結論（politician_pair_resolutions）與合併（merged_into）的觸發器。
-- 缺生年同名者的 profile_gap：既有臂（campaign_election_arms）已會對「當屆有參選紀錄、缺生年」的人開，這裡不另開；duplicate_politician 任務本身就會在標記一建立時開出。

ALTER TABLE politicians ADD COLUMN IF NOT EXISTS possible_duplicate_of UUID[];
COMMENT ON COLUMN politicians.possible_duplicate_of IS '疑似同人，待補生年：建這個人物時，站上有同名者缺生年、無法確定是不是同一人，先建新人物並記下那幾位的 id；任一方補上生年且不同就清掉（觸發器 politicians_clear_possible_duplicate），相同就由 duplicate_politician 任務合併。NULL＝沒有疑慮';
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS needs_identity_pick BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN contributions.needs_identity_pick IS '落庫判不出同名身分、驗證者沒指認：不退件，改回 pending 並標這欄、重發驗證票（只退回一次）；既有票數與分數保留';
CREATE INDEX IF NOT EXISTS politicians_possible_duplicate_idx ON politicians USING GIN (possible_duplicate_of) WHERE possible_duplicate_of IS NOT NULL;

CREATE OR REPLACE FUNCTION politicians_clear_possible_duplicate() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.birth_year IS NULL THEN RETURN NEW; END IF;
  -- 我自己的標記：拿掉「對方有生年而且跟我不同」的
  IF NEW.possible_duplicate_of IS NOT NULL THEN
    UPDATE politicians p SET possible_duplicate_of = NULLIF(ARRAY(
        SELECT x FROM unnest(p.possible_duplicate_of) AS x
         WHERE NOT EXISTS (SELECT 1 FROM politicians o WHERE o.id = x AND o.birth_year IS NOT NULL AND o.birth_year <> NEW.birth_year)), '{}'::UUID[])
     WHERE p.id = NEW.id;
  END IF;
  -- 別人指到我的標記：我有生年了，跟他不同就拿掉我
  UPDATE politicians p SET possible_duplicate_of = NULLIF(array_remove(p.possible_duplicate_of, NEW.id), '{}'::UUID[])
   WHERE p.possible_duplicate_of @> ARRAY[NEW.id] AND p.birth_year IS NOT NULL AND p.birth_year <> NEW.birth_year;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS politicians_clear_possible_duplicate ON politicians;
CREATE TRIGGER politicians_clear_possible_duplicate AFTER INSERT OR UPDATE OF birth_year ON politicians
  FOR EACH ROW EXECUTE FUNCTION politicians_clear_possible_duplicate();

-- 標記的其他出口（2026-11-11 審查）：
--   ① 同名配對被記成「不同人」（politician_pair_resolutions.resolution = 'different'，applyMergePolitician 的 same_person=false 寫的就是它）→ 雙方標記裡指向對方的 id 拿掉。
--   ② 某人被合併（politicians.merged_into 設值）→ 他自己的標記清掉；別人標記裡指向他的 id 改指向合併後那位（保留的那位就是標記主人自己時直接拿掉），去重。
-- 觸發器放在 DB 這一層：merge_politician（SQL 軟合併）與 TS 的不同人分支都走得到，不必兩邊各改一次。
CREATE OR REPLACE FUNCTION politician_pair_clear_possible_duplicate() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.resolution IS DISTINCT FROM 'different' THEN RETURN NEW; END IF;
  UPDATE politicians p SET possible_duplicate_of = NULLIF(array_remove(p.possible_duplicate_of, NEW.b), '{}'::UUID[])
   WHERE p.id = NEW.a AND p.possible_duplicate_of @> ARRAY[NEW.b];
  UPDATE politicians p SET possible_duplicate_of = NULLIF(array_remove(p.possible_duplicate_of, NEW.a), '{}'::UUID[])
   WHERE p.id = NEW.b AND p.possible_duplicate_of @> ARRAY[NEW.a];
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS politician_pair_clear_possible_duplicate ON politician_pair_resolutions;
CREATE TRIGGER politician_pair_clear_possible_duplicate AFTER INSERT OR UPDATE OF resolution ON politician_pair_resolutions
  FOR EACH ROW EXECUTE FUNCTION politician_pair_clear_possible_duplicate();

CREATE OR REPLACE FUNCTION politicians_merged_fix_possible_duplicate() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.merged_into IS NULL THEN RETURN NEW; END IF;
  UPDATE politicians SET possible_duplicate_of = NULL WHERE id = NEW.id AND possible_duplicate_of IS NOT NULL;
  UPDATE politicians p SET possible_duplicate_of = NULLIF(ARRAY(
      SELECT DISTINCT y FROM (SELECT CASE WHEN x = NEW.id THEN NEW.merged_into ELSE x END AS y FROM unnest(p.possible_duplicate_of) AS x) z WHERE y <> p.id), '{}'::UUID[])
   WHERE p.id <> NEW.id AND p.possible_duplicate_of @> ARRAY[NEW.id];
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS politicians_merged_fix_possible_duplicate ON politicians;
CREATE TRIGGER politicians_merged_fix_possible_duplicate AFTER UPDATE OF merged_into ON politicians
  FOR EACH ROW EXECUTE FUNCTION politicians_merged_fix_possible_duplicate();

CREATE OR REPLACE FUNCTION contribution_auto_tasks_dup()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH n AS (
    SELECT p.id, p.name, p.party, p.region, p.birth_year, p.current_position, p.possible_duplicate_of,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
    FROM politicians p WHERE p.merged_into IS NULL
  ),
  -- 擋住號次缺口的配對（20261031090000）：同一個選舉、同一個號次單位（ballot_number_unit）裡同名（正規化）的兩個人物，一個已有號次、一個沒有。
  -- 同單位同名同時登記，多半是同一位候選人被建成兩筆；縣市不同、出生年不明，原本的「同縣市或同出生年」條件配不到。
  ue AS (
    SELECT pe.election_id, pe.election_type, p.id AS pid, pe.cand_no,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
      FROM politician_elections pe
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL
  ),
  up AS (
    SELECT LEAST(x.pid, y.pid) AS a_id, GREATEST(x.pid, y.pid) AS b_id, min(x.unit) AS unit
      FROM ue x JOIN ue y ON y.election_id = x.election_id AND y.election_type = x.election_type AND y.unit = x.unit AND y.nkey = x.nkey AND y.pid <> x.pid
     WHERE x.unit IS NOT NULL AND x.cand_no IS NULL AND y.cand_no IS NOT NULL
     GROUP BY 1, 2
  )
  SELECT 'auto:duplicate_politician:' || a.id || '|' || b.id, 'duplicate_politician',
         jsonb_build_object(
           'pair_key', a.id || '|' || b.id,
           'a', jsonb_build_object('id', a.id, 'name', a.name, 'party', a.party, 'region', a.region, 'birth_year', a.birth_year, 'current_position', a.current_position),
           'b', jsonb_build_object('id', b.id, 'name', b.name, 'party', b.party, 'region', b.region, 'birth_year', b.birth_year, 'current_position', b.current_position))
           || CASE WHEN up.a_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cand_no_gap', true, 'cand_no_unit', replace(up.unit, '|', ' ')) END,
         '「' || a.name || '」有兩筆人物資料（' || COALESCE(a.region, '') || ' ' || COALESCE(a.party, '') || '／' || COALESCE(b.region, '') || ' ' || COALESCE(b.party, '') || '），很可能是同一個人。'
           || '請查中選會候選人資料庫（歷屆參選、出生年、政黨）或官方名單，確認是不是同一人。'
           || '用 merge_politician 回報：same_person=true 帶 keep_id（保留資料較完整、參選紀錄較多的那筆）與 remove_id；確認是不同人就 same_person=false。'
           || '兩種都要 reason（≥20 字）與 source_urls。item.current.a／b 是兩筆的全欄＋參選紀錄＋政見標題，current.system_vote 是系統的判定。'
           || '**system_vote 只看我們自己資料庫裡的欄位，不是獨立證據**——它說不同人，你還是要自己查一次官方來源。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，同一人會列在同一筆', 'POST /functions/v1/fetch-cec-data {"queryName":"姓名"}', '該縣市議會／政府官網的人物簡介'],
         2, COALESCE(a.region, b.region)
  FROM n a JOIN n b ON a.nkey = b.nkey AND a.id < b.id
  LEFT JOIN up ON up.a_id = a.id AND up.b_id = b.id
  WHERE (COALESCE(a.region, '') = COALESCE(b.region, '') OR (a.birth_year IS NOT NULL AND a.birth_year = b.birth_year) OR up.a_id IS NOT NULL
         -- 系統建新人物時標的「疑似同人，待補生年」（20261111170000）：同名＋標記指到對方，就開合併任務，不等縣市或生年對上
         OR a.id = ANY(COALESCE(b.possible_duplicate_of, '{}'::UUID[])) OR b.id = ANY(COALESCE(a.possible_duplicate_of, '{}'::UUID[])))
    AND NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = a.id || '|' || b.id)
    -- Jev 判「不同人」：只認**最新一筆**判定（原本是「有沒有任何一筆 diff」，後來改判 same 也壓不掉舊的），
    -- 而且只壓 jev_pair_exclusion_days() 天（原本永久）。
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT j.choice, j.probability, j.asked_at
        FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.subject_id = a.id || '|' || b.id
        ORDER BY j.asked_at DESC
        LIMIT 1
      ) latest
      WHERE latest.choice = 'diff'
        AND latest.probability >= system_one_min_probability()
        AND latest.asked_at > now() - (jev_pair_exclusion_days() || ' days')::INTERVAL
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_type = 'merge_politician' AND c.status IN ('pending', 'verified', 'disputed')
        AND c.payload->>'keep_id' ~* '^[0-9a-f-]{36}$' AND c.payload->>'remove_id' ~* '^[0-9a-f-]{36}$'
        AND politician_pair_key((c.payload->>'keep_id')::UUID, (c.payload->>'remove_id')::UUID) = a.id || '|' || b.id)
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_dup IS
  '同名人物配對 → duplicate_politician 任務；已有人類結論的不派，Jev 最新一筆高信心「不同人」的壓 90 天；另收「同選舉同號次單位同名、一個有號次一個沒有」的配對（20261031090000），以及「同名＋possible_duplicate_of 指到對方」（疑似同人待補生年，20261111170000）';

CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL,
  p_actor_id TEXT DEFAULT NULL,
  p_skip_held BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ,
  held_count INTEGER
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id = uuid_if_canonical(c.task_id) AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at,
         h.n AS held_count
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  -- 這張票現在被幾個「別的代理」握著（2026-11-09）：30 分鐘內（同 LEASE_MINUTES）派到、還沒對它投票的不同代號，不含正在要的這一位
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT lower(vd.agent_name))::INTEGER AS n
      FROM verify_dispatches vd
     WHERE vd.contribution_id = c.id
       AND vd.dispatched_at > now() - interval '30 minutes'
       AND vd.agent_name IS NOT NULL
       AND (p_agent_name IS NULL OR lower(vd.agent_name) <> lower(p_agent_name))
       AND NOT EXISTS (SELECT 1 FROM contribution_votes cv
                        WHERE cv.contribution_id = vd.contribution_id AND lower(cv.agent_name) = lower(vd.agent_name))
  ) h
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    -- 投太多輪（20261017020100）：票數超過 平均 × overvoted_stop_multiplier 的不再派（交件會被 contribution_overvoted_escalate 轉裁決）；
    -- 裁決（adjudication）本身不適用。條件在 LIMIT 之前；(SELECT …) 讓規劃器只算一次
    AND (c.contribution_type = 'adjudication'
         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT contribution_overvoted_stop_votes()))
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    -- 自己交的不派給自己：同代號、或同一個 DiTrust 帳號（維護者 2026-11-04：投票不看 IP，不再比來源網段；p_ip_hash／p_legacy_ip_hash 留著相容、不使用）
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND (p_actor_id IS NULL OR c.actor_id IS DISTINCT FROM p_actor_id)
    -- 投過票的排除（維護者 2026-11-04 起以投票人為準：同代號、或同一個 DiTrust 帳號；同網段別的代理投過不算）
    AND (p_actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.actor_id = p_actor_id
    ))
    AND (p_agent_name IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND lower(v.agent_name) = lower(p_agent_name)
    ))
    -- 剛派給這個代號的不要再派（2026-09-21，見 000021；2026-11-04 起只看同網段「同代號」的派發，同網段別的代理不受影響）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND (p_agent_name IS NULL OR lower(vd.agent_name) = lower(p_agent_name))
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    -- 待指認（needs_identity_pick）的件分數已經夠了、狀態被改回 pending 等人補指認：不能被「分數已達標」濾掉（20261111170000）
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) OR c.needs_identity_pick)
    -- 握著的人數已經 >= 還缺的票數（目標分數 − 目前分數，每票以 1 分算）就先不派（p_skip_held；沒有別的可派時 /next 會用 FALSE 再要一次，不餓死）
    AND (NOT p_skip_held
         OR h.n < GREATEST(1, COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) - c.score))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id = uuid_if_canonical(c.payload->>'contribution_id')
          AND (
            (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR (p_actor_id IS NOT NULL AND o.actor_id = p_actor_id)
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id
                AND ((p_agent_name IS NOT NULL AND lower(v2.agent_name) = lower(p_agent_name))
                     OR (p_actor_id IS NOT NULL AND v2.actor_id = p_actor_id))
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

CREATE OR REPLACE FUNCTION roster_reconcile_rows()
RETURNS TABLE (
  reg_id BIGINT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, sub_region TEXT, village TEXT, district TEXT,
  name TEXT, party TEXT, source_url TEXT, row_no INTEGER, pe_id INTEGER, politician_id UUID, our_status TEXT,
  category TEXT, reason TEXT, person_action TEXT, system_applied BOOLEAN, announce_id BIGINT, announce_state TEXT
)
LANGUAGE sql STABLE
SET enable_nestloop = off  -- 見檔頭：不關的話 CTE 列數被估成 1，選巢狀迴圈，10.6 秒；關掉 0.5 秒
AS $$
  WITH reg AS (
    SELECT r.id AS reg_id, r.election_id, r.election_type, replace(r.region, '臺', '台') AS county,
           r.sub_region, replace(r.sub_region, '臺', '台') AS town, r.village, r.district,
           r.name, roster_name_key(r.name) AS name_key, r.party, r.source_url, r.row_no,
           NULLIF(btrim(replace(COALESCE(r.village, ''), '臺', '台')), '') AS village_n,
           NULL::INTEGER AS birth_year   -- 登記彙總表沒有出生年
      FROM cec_registrations r
      JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
     -- >>> 官方名冊鏡像（20261031160000）：該單位有 3 天內成功抓取的中選會 JSON 就不用登記彙總表（村里長 JSON 沒有村里名，系統建不起來，仍用登記彙總表）
     WHERE NOT EXISTS (SELECT 1 FROM cec_roster_mirror_units(true) mu
                        WHERE mu.election_type = r.election_type AND mu.county = replace(r.region, '臺', '台')
                          AND (mu.town = '' OR mu.town = COALESCE(replace(r.sub_region, '臺', '台'), '')))
    UNION ALL
    -- reg_id：鏡像列每天重抓、id 會變，改用內容（單位、選區、號次、姓名）算出的穩定負數，跟登記彙總表的正數 id 不會撞；log 的「每位只處理一次」靠它
    SELECT -abs(hashtextextended(x.election_type || '|' || x.county || '|' || x.town || '|' || x.area_code || '|' || COALESCE(x.cand_no::TEXT, '') || '|' || x.name, 0)),
           2026, x.election_type, replace(x.county, '臺', '台'),
           CASE WHEN x.election_type = '縣市議員' THEN NULL ELSE NULLIF(x.town, '') END,
           NULLIF(replace(x.town, '臺', '台'), ''), NULL::TEXT,
           CASE WHEN x.area_code <> '' THEN '第' || lpad(regexp_replace(x.area_code, '^0+', ''), 2, '0') || '選舉區' END,
           x.name, roster_name_key(x.name), COALESCE(x.party, '無'), x.unit_url, COALESCE(x.cand_no, 0), NULL::TEXT,
           CASE WHEN x.birth ~ '^[0-9]{6}$' THEN 1911 + substr(x.birth, 1, 2)::INTEGER END   -- 鏡像的民國出生年月日（6 碼）→ 西元年
      FROM cec_roster_2026 x
     WHERE EXISTS (SELECT 1 FROM cec_roster_mirror_units(true) mu
                    WHERE mu.election_type = x.election_type AND mu.county = replace(x.county, '臺', '台')
                      AND (mu.town = '' OR mu.town = replace(x.town, '臺', '台')))
    -- <<< 官方名冊鏡像
  ),
  regn AS (
    SELECT g.*, CASE WHEN g.name_key IS NULL THEN NULL
                     ELSE count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.name_key) END AS dup_n
      FROM reg g
  ),
  ours AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type::TEXT AS election_type,
           pe.candidacy_status AS status, COALESCE(pe.withdrawn_after_filing, FALSE) AS filed_out,
           p.name AS pname,
           roster_name_key(p.name) AS nn,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           substring(COALESCE(rg.sub_region, '') FROM '第[0-9]+選舉區') AS district
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE (pe.election_id, pe.election_type::TEXT) IN (SELECT DISTINCT x.election_id, x.election_type FROM reg x)
  ),
  hit AS (
    SELECT g.reg_id, o.pe_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type
                 AND o.county = g.county AND o.nn = g.name_key
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
  ),
  reg_deg AS (SELECT h.reg_id, count(*) AS n, min(h.pe_id) AS pe_id FROM hit h GROUP BY h.reg_id),
  pe_deg AS (SELECT h.pe_id, count(*) AS n FROM hit h GROUP BY h.pe_id),
  -- 同單位先比對（優先於全庫同名規則）：名冊這位沒有名字相同的紀錄，但同屆、同職位、同縣市（鄉鎮層級的選舉要同鄉鎮）已有一筆
  -- 參選紀錄（含已經對上名冊別一列的：正式庫的名冊真的有「佀廣洋」與長名兩列），名字是名冊名的子字串或反過來（較短的那個至少 2 字）——改過名、暱稱與全名、名冊寫法較長：
  -- 多半是同一個人，系統不建（建了就是重複人物），派代理確認（reason＝similar_name_in_unit）
  sim AS (
    SELECT g.reg_id, min(o.pe_id) AS pe_id, min(o.politician_id::TEXT)::UUID AS politician_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type AND o.county = g.county
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
                 AND (g.election_type <> '縣市議員' OR o.district IS NULL OR g.district IS NULL OR o.district = g.district)
     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key
       AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
       AND ((length(o.nn) >= 2 AND strpos(g.name_key, o.nn) > 0) OR (length(g.name_key) >= 2 AND strpos(o.nn, g.name_key) > 0))
     GROUP BY g.reg_id
  ),
  -- 安全網：同單位只要還有「我們標已表態／已登記／選後（或登記後退選）、卻沒對上名冊」的參選紀錄，名冊這邊沒對上的人就不給 new（改派代理，
  -- reason＝unmatched_candidacy_in_unit）：那一筆多半就是名冊這位換了寫法（異體字、打錯字、純羅馬拼音、暱稱）還沒被比對器認出來，
  -- 這時候建新人物就是重複人物。單位＝同屆、同職位、同縣市（鄉鎮層級要同鄉鎮、縣市議員雙方都有選舉區時要同選舉區）。只擋 new：attach 掛的是既有人物，不會多出人。
  unm AS (
    SELECT o.election_id, o.election_type, o.county, o.town, o.district FROM ours o
     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  ),
  unm_hit AS (
    SELECT DISTINCT g.reg_id
      FROM regn g
      JOIN unm u ON u.election_id = g.election_id AND u.election_type = g.election_type AND u.county = g.county
                AND (u.town IS NULL OR g.town IS NULL OR u.town = g.town)
                AND (g.election_type <> '縣市議員' OR u.district IS NULL OR g.district IS NULL OR u.district = g.district)
     WHERE g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
  ),
  -- 人物：全庫同名（姓名鍵相同、未合併）的人有幾位；剛好一位時，他要「看得出是同一個地方的人」（鄉鎮層級的選舉要同縣市同鄉鎮，其餘同縣市）
  -- 而且這一屆還沒有別筆參選紀錄（一人一屆一筆），才能掛上去
  pn AS MATERIALIZED (
    SELECT p.id, roster_name_key(p.name) AS nn, replace(p.region, '臺', '台') AS pregion, p.party, p.birth_year
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND roster_name_key(p.name) IN (SELECT x.name_key FROM regn x WHERE x.name_key IS NOT NULL)
  ),
  -- 同名者有生年、名冊也有生年而且不同＝不是同一人，不算同名衝突（2026-11-11）：全庫的同名者都被這樣排除時，名冊這位照「全庫沒有同名者」處理（new）
  pn_x AS (
    SELECT g.reg_id, count(*) AS k FROM regn g JOIN pn q ON q.nn = g.name_key
     WHERE g.birth_year IS NOT NULL AND q.birth_year IS NOT NULL AND q.birth_year <> g.birth_year GROUP BY g.reg_id
  ),
  pn_n AS (SELECT q.nn, count(*) AS n, min(q.id::TEXT)::UUID AS one_id, min(q.pregion) AS pregion, min(q.party) AS party FROM pn q GROUP BY q.nn),
  pplace AS (
    SELECT DISTINCT pe.politician_id, replace(rg.region, '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           NULLIF(btrim(replace(COALESCE(rg.village, ''), '臺', '台')), '') AS village
      FROM politician_elections pe JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  pplace_c AS (SELECT DISTINCT q.politician_id, q.county FROM pplace q),
  pplace_t AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL),
  -- 村里長：既有的參選紀錄在這個鄉鎮「有明確村里」（pv_any）而名冊的村里跟其中任何一個都不同（沒有 pv_eq）→ 不掛（同鄉鎮不同里的同名者是兩個人）
  pv_any AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  pv_eq AS (SELECT DISTINCT q.politician_id, q.county, q.town, q.village FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  p_has AS (
    SELECT DISTINCT pe.politician_id, pe.election_id
      FROM politician_elections pe WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  -- 全部用相等連接（不用相關子查詢：關掉 nested loop 之後，相關子查詢逐列掃整張暫存表，20 秒）
  person AS (
    SELECT g.reg_id,
           CASE WHEN COALESCE(n.n, 0) = 0 OR n.n = COALESCE(px.k, 0) THEN 'new'
                WHEN n.n = 1
                 AND h.politician_id IS NULL
                 AND (CASE WHEN g.town IS NULL THEN (n.pregion = g.county OR pc.politician_id IS NOT NULL)
                           ELSE pt.politician_id IS NOT NULL END)
                 AND NOT (g.election_type = '村里長' AND g.village_n IS NOT NULL AND va.politician_id IS NOT NULL AND ve.politician_id IS NULL)
                 -- 政黨互斥（兩邊都不是無黨籍、而且不同黨）不自動掛
                 AND NOT (COALESCE(btrim(g.party), '') NOT IN ('', '無', '無黨籍') AND COALESCE(btrim(n.party), '') NOT IN ('', '無', '無黨籍')
                          AND strpos(n.party, g.party) = 0 AND strpos(g.party, n.party) = 0)
                THEN 'attach' END AS person_action,
           CASE WHEN n.n = 1 THEN n.one_id END AS one_id
      FROM regn g
      LEFT JOIN pn_n n ON n.nn = g.name_key
      LEFT JOIN pn_x px ON px.reg_id = g.reg_id
      LEFT JOIN p_has h ON h.politician_id = n.one_id AND h.election_id = g.election_id
      LEFT JOIN pplace_c pc ON pc.politician_id = n.one_id AND pc.county = g.county
      LEFT JOIN pplace_t pt ON pt.politician_id = n.one_id AND pt.county = g.county AND pt.town = g.town
      LEFT JOIN pv_any va ON va.politician_id = n.one_id AND va.county = g.county AND va.town = g.town
      LEFT JOIN pv_eq ve ON ve.politician_id = n.one_id AND ve.county = g.county AND ve.town = g.town AND ve.village = g.village_n
     WHERE g.name_key IS NOT NULL AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
  ),
  rows_reg AS (
    SELECT g.reg_id, g.election_id, g.election_type, g.county, COALESCE(g.town, '') AS town, g.sub_region, g.village, g.district,
           g.name, g.party, g.source_url, g.row_no, COALESCE(o.pe_id, sm.pe_id) AS pe_id, COALESCE(o.politician_id, sm.politician_id, pr.one_id) AS politician_id, o.status AS our_status,
           CASE
             WHEN g.name_key IS NULL THEN 'missing_ambiguous'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' OR (o.status = 'withdrawn' AND NOT o.filed_out) THEN 'status_mismatch' ELSE 'both' END
             WHEN rd.n >= 1 THEN 'match_ambiguous'
             WHEN sm.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN ap.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN g.dup_n > 1 THEN 'missing_ambiguous'
             WHEN pr.person_action IS NULL THEN 'missing_ambiguous'
             WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'missing_ambiguous'
             ELSE 'missing_creatable' END AS category,
           CASE
             WHEN g.name_key IS NULL THEN 'unreadable_name'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' THEN 'ours_considering'
                    WHEN o.status = 'withdrawn' AND NOT o.filed_out THEN 'ours_withdrawn_not_after_filing' END
             WHEN rd.n >= 1 THEN 'match_not_one_to_one'
             WHEN sm.reg_id IS NOT NULL THEN 'similar_name_in_unit'
             WHEN ap.reg_id IS NOT NULL THEN
               CASE WHEN ap.reverted_at IS NOT NULL THEN 'system_reverted'
                    WHEN ap.outcome = 'applied' THEN 'system_applied_gone'
                    ELSE 'system_unresolved' END
             WHEN g.dup_n > 1 THEN 'same_name_multi'
             WHEN pr.person_action IS NULL THEN 'person_unclear'
             WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'unmatched_candidacy_in_unit'
             END AS reason,
           CASE WHEN rd.n IS NULL AND ap.reg_id IS NULL AND sm.reg_id IS NULL AND g.name_key IS NOT NULL AND g.dup_n = 1
                     AND NOT (pr.person_action = 'new' AND uh.reg_id IS NOT NULL) THEN pr.person_action END AS person_action,
           (ap.reg_id IS NOT NULL AND ap.outcome = 'applied' AND ap.reverted_at IS NULL) AS system_applied
      FROM regn g
      LEFT JOIN reg_deg rd ON rd.reg_id = g.reg_id
      LEFT JOIN pe_deg pd ON pd.pe_id = rd.pe_id
      LEFT JOIN ours o ON o.pe_id = rd.pe_id
      LEFT JOIN person pr ON pr.reg_id = g.reg_id
      LEFT JOIN sim sm ON sm.reg_id = g.reg_id
      LEFT JOIN unm_hit uh ON uh.reg_id = g.reg_id
      LEFT JOIN roster_reconcile_log ap ON ap.reg_id = g.reg_id
  ),
  rows_ours AS (
    SELECT NULL::BIGINT AS reg_id, o.election_id, o.election_type, o.county, COALESCE(o.town, '') AS town, o.town AS sub_region, NULL::TEXT AS village, NULL::TEXT AS district,
           o.pname AS name, NULL::TEXT AS party, NULL::TEXT AS source_url, NULL::INTEGER AS row_no,
           o.pe_id, o.politician_id, o.status AS our_status,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'ours_extra' ELSE 'status_mismatch' END AS category,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'not_in_registration' ELSE 'filed_flag_no_registration' END AS reason,
           NULL::TEXT AS person_action, FALSE AS system_applied
      FROM ours o
     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  )
  SELECT x.reg_id, x.election_id, x.election_type, x.county, x.town, x.sub_region, x.village, x.district,
         x.name, x.party, x.source_url, x.row_no, x.pe_id, x.politician_id, x.our_status,
         x.category, x.reason, x.person_action, x.system_applied,
         NULL::BIGINT AS announce_id, NULL::TEXT AS announce_state
    FROM (SELECT * FROM rows_reg UNION ALL SELECT * FROM rows_ours) x
$$;

-- 以 20261007140000 的定義為底只在尾端多一欄（#345 第二階段：職稱改讀任期表，offices 讀 politician_offices，沒有退回舊視圖）
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
                END, 'sourceNote', pe.source_note, 'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing, 'electionDate', pee.election_date)) AS json_agg
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

NOTIFY pgrst, 'reload schema';
