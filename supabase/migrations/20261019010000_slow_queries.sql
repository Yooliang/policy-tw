-- 三個慢查詢（policy-ops#136，docs/work/2026-10-19-三個慢查詢.md）：純效能，結果與協議都不變、不升協議版號。
--
-- (a) contribution_verify_pool（/next 與 verify 的驗證池）：
--   · 正式庫唯讀 EXPLAIN：contribution_votes 被整張 Seq Scan 後 Materialize（`OR lower(v.agent_name)=lower(p_agent_name)` 擠在同一個
--     NOT EXISTS，規劃器放棄索引），每筆候選還對這 5 千列做 Join Filter（Rows Removed 514,295）；裁決分支的 `o.id::TEXT = payload->>…`
--     對 contributions 整張掃（cost 54,484 每筆）；網站請求判斷的 `t.id::TEXT = c.task_id` 也一樣
--   · 做法：投票排除拆三個獨立 NOT EXISTS（網段、舊網段、代號）、加表達式索引 (contribution_id, lower(agent_name))；
--     字串對 uuid 的比較改成 uuid_if_canonical(text)（只認小寫標準寫法，與原本 id::TEXT = x 恰好同義；不是 uuid 的字串＝NULL＝不命中）
--   · 基準是正式庫現行定義（與 20261017020100 比對逐字相同，只差格式），仍在「照 queue_at 驅動 + LIMIT」迴圈裡，沒有加任何任務脈絡查詢（裁決 #233／#234）
--
-- 一般 CREATE INDEX（不用 CONCURRENTLY）：migration 在交易裡跑，CONCURRENTLY 不能；contribution_votes 約 4.5 萬列，建索引是毫秒級。
CREATE OR REPLACE FUNCTION uuid_if_canonical(p_text TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid END;
$$;
COMMENT ON FUNCTION uuid_if_canonical IS
  '字串轉 uuid，只認小寫標準寫法（8-4-4-4-12），其他一律 NULL。等同 `id::TEXT = p_text` 的比對語意，但可以走 uuid 主鍵索引。';

CREATE INDEX IF NOT EXISTS idx_contribution_votes_lower_agent ON contribution_votes (contribution_id, lower(agent_name));

CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ
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
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
                   AND contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) END AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    -- 投太多輪（20261017020100）：票數超過 平均 × overvoted_stop_multiplier 的不再派（交件會被 contribution_overvoted_escalate 轉裁決）；
    -- 裁決（adjudication）本身不適用。條件在 LIMIT 之前；(SELECT …) 讓規劃器只算一次
    AND (c.contribution_type = 'adjudication'
         OR c.agree_count + c.disagree_count + c.unsure_count <= (SELECT contribution_overvoted_stop_votes()))
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    -- 過渡期（#484）：切換前自己交的（存單一 IP 的舊雜湊）也不派給自己
    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)
    -- 同代號自己交的也不派給自己（policy-ops#70）：以前只有 TS 在 LIMIT 之後才濾，前段集中同代號時別的網段的同代號機器會拿不到
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    -- 投過票的排除（20261019010000 拆成三個獨立的 NOT EXISTS：OR 擠在同一個子查詢裡規劃器只能把 contribution_votes 整張掃一遍當 Materialize，
    -- 實測 4.5 萬列掃 44 毫秒；拆開後各走 idx_contribution_votes_ip／idx_contribution_votes_lower_agent。三個條件的 OR 語意不變，NULL 參數仍然不命中任何列）
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_legacy_ip_hash
    )
    -- 同代號在別的網段投過的也不派（2026-10-13）：投票有唯一索引 contribution_votes_one_per_agent（貢獻, 代號），
    -- 換了出口網段的同代號拿到也只能 409 already_voted 或 skip，而網站請求的驗證列一直留在前段，會被反覆派回來
    AND (p_agent_name IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND lower(v.agent_name) = lower(p_agent_name)
    ))
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id = uuid_if_canonical(c.payload->>'contribution_id')
          AND (
            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)
            OR (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND (v2.verifier_ip_hash = p_ip_hash OR v2.verifier_ip_hash = p_legacy_ip_hash)
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。'
  '2026-10-02。2026-10-06（#349）兩台機器的型別改看 contribution_needs_two_ips（多了「中止」交接）。'
  '2026-10-09（#484）多 p_legacy_ip_hash：自交與投過票的排除（含裁決的原貢獻）新舊雜湊一起比；NULL＝與先前相同。'
  '2026-10-10（policy-ops#70）多 p_agent_name：同代號（含裁決原貢獻的代號）在 SQL、LIMIT 之前排除；NULL＝與先前相同。'
  '2026-10-13：同代號已投過票的也排除（投票表唯一索引是（貢獻, 代號），換網段的同代號派到也投不進去）。'
  '2026-10-17：票數超過 平均 × overvoted_stop_multiplier（近 30 天已結案交件的平均票數 × 3）的不派（裁決型別除外），在 LIMIT 之前。'
  '2026-10-19（policy-ops#136）純效能：投票排除拆成三個 NOT EXISTS、裁決原貢獻與網站請求任務改用 uuid 比對走主鍵（結果不變）。';

-- ============================================================
-- (c) 派工總表 contribution_auto_tasks_arms()（seed_auto_task_queue 每 10 分鐘呼叫）：5.5 秒／seed 7 秒
-- ============================================================
-- 正式庫唯讀 EXPLAIN ANALYZE（arms_plan_before.txt）最貴的一段是 owner_mismatch 臂（t_28，1.45 秒）：
-- 它的訊號 ① 把 1.6 萬筆參選紀錄 id 全部丟進 election_result_cec_matches()，函式本體 1.05 秒（估 5 列、實際 15,872 列），
-- 整批只留下 2 筆。改在 candidacy_owner_mismatch_signals() 內用同一組比對條件整批連接（見下面函式裡的註解），輸出逐筆不變。
-- 共用的 election_result_cec_matches() 本體一個字沒動（election_results 臂、補選舉結果的系統票、改掛的系統票都用它）；只用 ALTER FUNCTION 補上 ROWS 估計：
-- 沒有估計時規劃器當成 1000 列，而 election_results 臂實際送進去 1.6 萬列，上游連接的列數估計偏小（計畫裡 Function Scan 估 5 列、實際 15,872 列）。
-- ROWS 只影響規劃、不影響結果與函式本體的計畫；單筆呼叫端不受影響。這一項沒有辦法在唯讀環境量出效益（上線後看 seed 耗時），
-- 回退＝`ALTER FUNCTION election_result_cec_matches(INTEGER[]) ROWS 1000;`。
--
-- 沒動的（量過，理由）：
--   * t_10（term_policies，0.63 秒）、t_27（election_results，0.55 秒）：大頭是 politician_bulletins 視圖與 election_result_cec_matches 本體，
--     都是共用物件；20261008180000 已量過「改函式本體」在 force_generic_plan 下會退化（陣列長度估 10 筆 → 巢狀迴圈），這次不重做。
--   * owner_mismatch 的 `payload->>'politician_election_id' = pe.id::TEXT`：計畫裡那個 Hash Anti Join 多的只有約 90 毫秒，
--     耗時在掃 contributions 建雜湊，不在轉型；改成整數比對省不到，所以不動，避免多一處語意風險。
--   * 不建 cec_candidates 索引：現有 (election_id, name_norm)／(election_id, election_type, region) 夠用，慢的是逐列探測的次數，不是缺索引。

CREATE OR REPLACE FUNCTION candidacy_owner_mismatch_signals()
RETURNS TABLE (politician_election_id INTEGER, signal TEXT, detail TEXT)
LANGUAGE sql STABLE AS $$
  WITH pe AS (
    SELECT pe.id, pe.politician_id, pe.election_id, pe.election_type, e.election_date, p.name, p.birth_year,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
  ),
  -- ①中選會名冊唯一對上的那一列，出生年跟人物不同
  -- 20261019010000（policy-ops#136）：原本把 1.6 萬筆參選紀錄 id 全部丟進 election_result_cec_matches(ARRAY(…))，函式本體對每筆逐列 LATERAL 探索引
  -- （正式庫實測 1.05 秒、195,690 個緩衝區），而這裡只要「唯一對上、而且出生年不同」的那 2 筆。改成同一組比對條件的整批連接：
  -- 規則一字不改地照 election_result_cec_matches（同屆、同選舉、同縣市、cec_name_key 同名；有鄉鎮、村里就一起對），
  -- 對上的筆數 = 1 才算（cec_hits = 1），出生年取那一筆的。
  cec AS (
    SELECT x.id, min(cc.birth_year) AS cec_birth_year
      FROM (
        SELECT pe.id, pe.election_id, pe.election_type,
               replace(COALESCE(r.region, p.region), '臺', '台') AS county,
               cec_name_key(p.name) AS nn,
               CASE WHEN pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                    THEN NULLIF(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')
               END AS town,
               CASE WHEN pe.election_type = '村里長'
                    THEN NULLIF(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '')
               END AS village
          FROM politician_elections pe
          JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
          JOIN elections e ON e.id = pe.election_id
          LEFT JOIN regions r ON r.id = pe.region_id
         WHERE p.birth_year IS NOT NULL
      ) x
      JOIN cec_candidates cc
        ON cc.election_id = x.election_id AND cc.election_type = x.election_type
       AND cc.region = x.county AND cc.name_norm = x.nn
       AND (x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)
       AND (x.village IS NULL OR cc.village = x.village)
     GROUP BY x.id
    HAVING count(*) = 1
  )
  SELECT x.id, 'cec_birth_year', '中選會名冊上這一筆的出生年是 ' || c.cec_birth_year || '，這個人記的是 ' || x.birth_year
    FROM pe x JOIN cec c ON c.id = x.id
   WHERE c.cec_birth_year IS NOT NULL AND c.cec_birth_year <> x.birth_year
  UNION ALL
  -- ②建立這筆的交件寫的縣市，跟現在掛的縣市不同（簡嘉佑：交件寫台中市，掛到了桃園市的同名者）
  SELECT DISTINCT x.id, 'submitted_region',
         '建立這筆的交件寫的是「' || replace(c.payload->>'region', '臺', '台') || '」，現在掛的這個人在「' || x.county || '」'
    FROM pe x JOIN contributions c
      ON c.contribution_type = 'candidacy' AND c.status = 'applied' AND c.applied_politician_id = x.politician_id
     AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE x.county IS NOT NULL AND c.payload->>'region' IS NOT NULL AND c.payload->>'region' <> '全國'
     AND left(replace(c.payload->>'region', '臺', '台'), 3) <> left(x.county, 3)
  UNION ALL
  -- ③同一人相隔一屆在不同縣市參選地方選舉（楊寶楨：2022 台北市議員、2026 台中市議員）
  SELECT DISTINCT b.id, 'county_jump',
         '同一個人 ' || a.election_id || ' 在' || a.county || '參選' || a.election_type || '，這一筆在' || b.county
    FROM pe a JOIN pe b ON a.politician_id = b.politician_id AND a.election_date < b.election_date
   WHERE a.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND b.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND a.county IS NOT NULL AND b.county IS NOT NULL AND a.county <> b.county AND a.county <> '全國' AND b.county <> '全國'
     AND b.election_date - a.election_date < 1700
  UNION ALL
  -- ④查證者在這筆的任務上回 no_change、理由寫明「不是同一人」（沒有改掛的型別時只能這樣回）
  SELECT DISTINCT x.id, 'said_different', '有人在這筆的任務上回報「不是同一人」，但當時只能回 no_change'
    FROM contributions c
    JOIN pe x ON x.id = substring(c.task_id FROM ':([0-9]{1,9})$')::INTEGER
   WHERE c.contribution_type = 'no_change' AND c.status NOT IN ('rejected', 'withdrawn')
     AND c.task_id ~ '^auto:[a-z_]+:[0-9]{1,9}$'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') ~ '(不是|並非|非|不為)同一(個)?(人|位)|同名不同人|掛錯'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') !~ '(不是|非|並非)同名不同人'
  UNION ALL
  -- ⑤驗證者理由寫明「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上（楊忠俊：驗證者說分不出、同意建新人物，結果掛到了金寧鄉長）
  SELECT DISTINCT x.id, 'vote_said_different', '驗證這筆的人寫了「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上'
    FROM contribution_votes v
    JOIN contributions c ON c.id = v.contribution_id AND c.contribution_type = 'candidacy' AND c.status = 'applied'
    JOIN pe x ON x.politician_id = c.applied_politician_id AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE v.note ~ '(不是|並非|非)同一(個)?(人|位)|同名不同人'
     AND v.note !~ '(不是|非|並非)同名不同人'
     AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)
$$;
COMMENT ON FUNCTION candidacy_owner_mismatch_signals IS
  '疑似掛錯人的參選紀錄與理由（2026-10-06）：名冊出生年不符、交件縣市不符、相隔一屆換縣市、查證者或驗證者寫明不是同一人。2026-10-19（policy-ops#136）訊號 ① 改整批連接（純效能，輸出不變）。';

ALTER FUNCTION election_result_cec_matches(INTEGER[]) ROWS 16000;
