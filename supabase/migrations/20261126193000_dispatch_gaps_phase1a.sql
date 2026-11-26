-- 派工臂事件驅動化 第 1 期 PR-1：mismatch／issue_too_broad／legacy 三支臂的按鍵重算、觸發器上線，三支切 shadow 開始雙軌（派工輸出不變）
--
-- 設計文件：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 1 期」與附錄 A.1／A.3。接第 0 期（20261126170000、20261126180000）。
--
-- 這一支做的事（派工輸出一個字不變）：
--   ① 三支按鍵重算函式 dispatch_gap_recompute_legacy／_mismatch／_issue_too_broad(p_keys text[])：
--      與現行臂函式的本體逐字相同，只把「鍵過濾」推到最底層（見各函式上方註解）；登記進 dispatch_gap_arm_keys.recompute_fn，drain 遇到沒有 '*' 的批次就走按鍵版。
--   ② 觸發器函式 dispatch_gap_on_change() 重定義（以 20261126180000 版為底）：入列單位對得更細（見該函式上方註解），其餘來源表的分支不變。
--   ③ 觸發器掛到真表（AFTER … FOR EACH ROW，UPDATE 一律限定欄位 OF …，高頻表另加 WHEN 條件，不相關的列連函式都不呼叫）：
--        policies                 INSERT／UPDATE OF title,category,tags,status,proposed_date,election_id,politician_id,removed_at／DELETE
--        politician_elections     INSERT／UPDATE OF candidacy_status,election_id,politician_id,region_id,election_type／DELETE
--        politicians              UPDATE OF name,region,merged_into
--        jev_decisions            INSERT，WHEN subject_type='policy' AND question='election'（每天約 2.3 萬筆新增，只有這一題才進函式）
--        edit_history             INSERT，WHEN table_name='policies' AND field IN ('audit','*')
--        source_refs              INSERT／UPDATE OF role,source_id,target_id／DELETE，WHEN 政見的主要出處（三支觸發器，WHEN 不能同時引用 NEW 與 OLD）
--        contributions            INSERT／UPDATE OF status,applied_policy_id，WHEN contribution_type IN ('policy','policy_subtopics')（高頻表，其他型別不進函式）
--        policy_subtopics         INSERT／UPDATE OF policy_id,issue／DELETE
--        elections                INSERT／UPDATE OF election_date／DELETE
--        activity_rules           INSERT／UPDATE OF params,activity／DELETE（函式裡只認 issue_too_broad 那一條）
--      三支臂沒有讀 tracking_logs，所以不掛；contributions 不掛 DELETE（極少、對帳會補）；politicians 不掛 INSERT／DELETE（新人物沒有政見，政見自己會觸發）。
--   ④ 三支臂切 shadow（dispatch_gap_arms）：總表照舊即時算，同時常駐表由事件維護，每小時 dispatch_gap_shadow_run() 比「即時算 vs dispatch_gaps」寫 reconcile_runs。
--   ⑤ 事件開關 events_enabled 設 true；seed 開頭的 drain 總開關 seed_drain_enabled 設 true（總開關只有一個；目前登記在 dispatch_gap_arm_keys 的只有這三支臂，
--      shadow 下 drain 只維護 dispatch_gaps，總表不讀它，所以打開不影響派工輸出。之後登記新的臂時，要連同它的模式一起決定）。
--   ⑥ 初始灌入：切 shadow 後立刻對三支臂各跑一次整表對帳（dispatch_gap_reconcile_all，約 15 秒：mismatch 9、issue_too_broad 3.5、legacy 2.4），
--      之後靠事件維護。建觸發器放在灌入之後（CREATE TRIGGER 會擋該表寫入到交易結束，不要把 15 秒的灌入夾在中間），
--      灌入與掛觸發器之間那一小段的變更會漏掉，所以最後對三支臂各補一筆整臂事件（'*'），第一輪 seed 開頭的 drain 會再算一次整臂（約 15 秒，一次性）。
--   ⑦ 投票日翻轉：mismatch 的 by_future／by_not_elected 看 election_date 與今天的先後，投票日當天翻面不是任何一筆資料的變更。
--      新增 dispatch_gap_date_flip() 與 pg_cron dispatch-gap-date-flip-daily（UTC 16:04＝台北 00:04）：今天正好是某場選舉投票日才入一筆 mismatch 整臂事件。
--
-- 回滾（互不依賴）：
--   取消排程：SELECT cron.unschedule('dispatch-gap-date-flip-daily');
--   關事件：UPDATE dispatch_gap_settings SET events_enabled = false, seed_drain_enabled = false WHERE id = 1;（觸發器直接 RETURN，seed 不再 drain）
--   退回即時算：SELECT dispatch_gap_set_mode('legacy', 'off'); 同樣 mismatch、issue_too_broad（三支都是 shadow，本來就沒有讀常駐表）。
--   拿掉觸發器：DROP TRIGGER trg_dispatch_gap_policies ON policies;（其餘同名規則 trg_dispatch_gap_<表名>：politician_elections、politicians、jev_decisions、
--     edit_history、contributions、policy_subtopics、elections、activity_rules；source_refs 是 trg_dispatch_gap_source_refs_ins／_upd／_del）。
--   按鍵版改回整表保底：UPDATE dispatch_gap_arm_keys SET recompute_fn = NULL WHERE arm IN ('legacy','mismatch','issue_too_broad');
--   物件：DROP FUNCTION dispatch_gap_recompute_legacy(TEXT[]), dispatch_gap_recompute_mismatch(TEXT[]), dispatch_gap_recompute_issue_too_broad(TEXT[]), dispatch_gap_date_flip();
--   on_change 換回 20261126180000 的定義。
--
-- 風險：部署時多跑約 15 秒（初始灌入）；第一輪 seed 多約 15 秒（補整臂事件）；之後 seed 開頭多一次 drain（事件少時毫秒級，有整臂事件時 3.5～9 秒）。
--   CREATE TRIGGER 取表鎖（SHARE ROW EXCLUSIVE）到交易結束，這支把觸發器都放在最後、鎖持有時間約一秒；SET LOCAL lock_timeout 30 秒，拿不到鎖就整支失敗（重跑即可）。

-- ------------------------------------------------------------
-- 1. 觸發器函式：以 20261126180000 為底，三支臂的入列單位對細
--    · policies：legacy、mismatch 入該政見；issue_too_broad 只在這條政見（新或舊）是 2026 競選承諾時才入整臂（反推不出縣市與議題）
--    · politician_elections：mismatch 只入「這個人（新舊兩個 politician_id）在這一屆（新舊兩個 election_id）的政見」；issue_too_broad 入整臂，
--      但只在該屆是 issue_too_broad_election() 且這個人有未移除的競選承諾時才入（沒承諾的人改參選紀錄不影響議題統計）
--    · politicians：name、region、merged_into 變了才入該人名下每一條政見的 legacy、mismatch
--    · source_refs：只看政見的主要出處（target_table='policies' AND role='primary'），入 legacy 與 mismatch（兩支的 target 都帶 source_url）
--    · contributions：只認 policy（legacy 排除 applied_policy_id）與 policy_subtopics（issue_too_broad 排除在途細項）兩種；後者能從 payload 組出
--      issue:<選舉>:<縣市>:<議題> 就入該單位，組不出才入整臂
--    · policy_subtopics：整臂；elections：mismatch 整臂（投票日變更）；activity_rules：只有 activity='issue_too_broad' 的變動入該臂整臂（門檻與選舉屆別）
--    其餘分支（jev_decisions、edit_history）與 20261126180000 相同；沒登記的臂（raw:profile_gap 等）這期不入列，第 2 期接。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_on_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new     JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old     JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row     JSONB;
  v_kind    TEXT := lower(TG_OP);
  v_cols    TEXT[];
  v_changed BOOLEAN;
  v_arm     TEXT;
  v_tid     TEXT;
  v_eid     TEXT;
  v_pl      JSONB;
  v_np      UUID;
  v_op      UUID;
  v_ne      INTEGER;
  v_oe      INTEGER;
  v_ie      INTEGER;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN NULL;
  END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_TABLE_NAME = 'policies' THEN
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['title', 'description', 'category', 'tags', 'status', 'proposed_date', 'last_updated', 'progress',
                      'election_id', 'politician_id', 'removed_at', 'lineage_id'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'id'), v_kind);
    -- 議題統計只看「issue_too_broad_election() 那一屆的競選承諾」；新舊兩邊都不是就不入列
    IF COALESCE((v_new ->> 'status') = 'Campaign Pledge' OR (v_old ->> 'status') = 'Campaign Pledge', false) THEN
      v_eid := issue_too_broad_election()::TEXT;
      IF COALESCE((v_new ->> 'election_id') = v_eid OR (v_old ->> 'election_id') = v_eid, false) THEN
        PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 反推不出（縣市，議題），整臂重算；同一時段只會留一筆
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'jev_decisions' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'subject_type' = 'policy' AND v_row ->> 'question' = 'election' THEN
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'subject_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'edit_history' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'table_name' = 'policies' AND v_row ->> 'field' IN ('audit', '*') THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'record_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'source_refs' THEN
    -- 只有政見的主要出處會改變 policy_primary_url；更新時新舊兩邊的 target_id 都入（換掉被引用的政見）
    IF COALESCE(v_new ->> 'target_table', v_old ->> 'target_table') = 'policies'
       AND (COALESCE(v_new ->> 'role', '') = 'primary' OR COALESCE(v_old ->> 'role', '') = 'primary') THEN
      FOR v_tid IN SELECT DISTINCT t FROM unnest(ARRAY[v_new ->> 'target_id', v_old ->> 'target_id']) t WHERE t IS NOT NULL LOOP
        PERFORM dispatch_gap_enqueue('legacy', 'policy:' || v_tid, v_kind);
        PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
      END LOOP;
    END IF;

  ELSIF TG_TABLE_NAME = 'politician_elections' THEN
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['candidacy_status', 'election_id', 'politician_id', 'region_id', 'election_type'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    -- mismatch：只有「同一個人、同一屆」的政見會受這一列影響（by_date／by_no_candidacy／by_not_elected 都比 politician_id＋election_id）
    -- （欄位值先轉成 uuid／整數再比，policies 的 politician_id 索引才用得上；NULL 比不到任何列）
    v_np := (v_new ->> 'politician_id')::UUID;
    v_op := (v_old ->> 'politician_id')::UUID;
    v_ne := (v_new ->> 'election_id')::INTEGER;
    v_oe := (v_old ->> 'election_id')::INTEGER;
    FOR v_tid IN
      SELECT p.id::TEXT FROM policies p
       WHERE p.removed_at IS NULL AND p.politician_id = v_np AND p.election_id = v_ne
      UNION
      SELECT p.id::TEXT FROM policies p
       WHERE p.removed_at IS NULL AND p.politician_id = v_op AND p.election_id = v_oe
    LOOP
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
    END LOOP;
    -- issue_too_broad：該屆是議題統計的那一屆、而且這個人有該屆未移除的競選承諾才入整臂
    v_ie := issue_too_broad_election();
    IF (v_ne = v_ie OR v_oe = v_ie)
       AND EXISTS (SELECT 1 FROM policies p
                    WHERE p.politician_id IN (v_np, v_op) AND p.election_id = v_ie
                      AND p.status = 'Campaign Pledge' AND p.removed_at IS NULL) THEN
      PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'politicians' THEN
    -- 人物改名、縣市、被合併會改變這個人名下每條政見的 legacy／mismatch 缺口內容（target 帶 name、region；legacy 排除 merged_into）
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['name', 'region', 'merged_into'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    v_np := (v_row ->> 'id')::UUID;
    FOR v_tid IN SELECT p.id::TEXT FROM policies p WHERE p.politician_id = v_np AND p.removed_at IS NULL LOOP
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || v_tid, v_kind);
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
    END LOOP;

  ELSIF TG_TABLE_NAME = 'contributions' THEN
    -- 只有兩種型別影響這三支臂：policy（legacy 排除「是貢獻建出來的政見」）、policy_subtopics（issue_too_broad 排除在途細項）
    IF TG_OP = 'UPDATE' AND v_old ->> 'status' IS NOT DISTINCT FROM v_new ->> 'status'
       AND v_old ->> 'applied_policy_id' IS NOT DISTINCT FROM v_new ->> 'applied_policy_id' THEN
      RETURN NULL;
    END IF;
    IF v_row ->> 'contribution_type' = 'policy' THEN
      IF v_row ->> 'applied_policy_id' IS NOT NULL THEN
        PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'applied_policy_id'), v_kind);
      END IF;
    ELSIF v_row ->> 'contribution_type' = 'policy_subtopics' THEN
      v_pl := v_row -> 'payload';
      IF COALESCE(v_pl ->> 'election_id', '') <> '' AND COALESCE(v_pl ->> 'region', '') <> '' AND COALESCE(v_pl ->> 'issue', '') <> '' THEN
        -- 與 contribution_auto_tasks_issue_too_broad 的 task_id 同一個組法：縣市臺→台、議題空白→底線
        PERFORM dispatch_gap_enqueue('issue_too_broad',
          'issue:' || (v_pl ->> 'election_id') || ':' || replace(v_pl ->> 'region', '臺', '台') || ':' || regexp_replace(v_pl ->> 'issue', '\s+', '_', 'g'),
          v_kind);
      ELSE
        PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'policy_subtopics' THEN
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 細項落庫／刪除只影響「還沒有細項」的承諾數；對不到縣市，整臂

  ELSIF TG_TABLE_NAME = 'elections' THEN
    PERFORM dispatch_gap_enqueue('mismatch', '*', v_kind);          -- 投票日變更：by_date／by_future／by_not_elected 都看它

  ELSIF TG_TABLE_NAME = 'activity_rules' THEN
    IF COALESCE(v_new ->> 'activity', v_old ->> 'activity') = 'issue_too_broad'
       OR COALESCE(v_old ->> 'activity', '') = 'issue_too_broad' THEN
      PERFORM dispatch_gap_enqueue('issue_too_broad', '*', 'config');   -- 門檻與選舉屆別在 params
    END IF;

  ELSIF TG_TABLE_NAME IN ('election_milestones', 'activity_overrides', 'election_task_config', 'traffic_watch_levels', 'lineage_settings') THEN
    -- 規則與設定變動：登記的每一支臂都整臂重算
    FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys ORDER BY arm LOOP
      PERFORM dispatch_gap_enqueue(v_arm, '*', 'config');
    END LOOP;

  ELSE
    RAISE WARNING 'dispatch_gap_on_change：不認得的來源表 %，略過', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 2. 三支按鍵重算函式（輸出欄位與臂函式相同；p_keys 是 dispatch_gap_scope_key 的 scope_key，'*' 不會送進來——整臂走整表函式）
-- ------------------------------------------------------------

-- legacy：與 20261126010000 的 contribution_auto_tasks_legacy() 逐字相同，只在 cand 加一行鍵過濾（policy:<政見 id>）
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_legacy(p_keys TEXT[])
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH cand AS MATERIALIZED (
    SELECT pl.id, pl.title, pl.politician_id
      FROM policies pl
     WHERE pl.removed_at IS NULL
       -- 鍵過濾（本函式唯一與整表版不同的條件）：只看這批政見
       AND pl.id IN (SELECT substr(k, 8)::UUID FROM unnest(p_keys) k WHERE k ~ '^policy:[0-9a-fA-F-]{36}$')
       AND NOT EXISTS (
         SELECT 1 FROM edit_history e
         WHERE e.table_name = 'policies' AND e.record_id = pl.id::TEXT AND e.field IN ('audit', '*')
       )
       AND NOT EXISTS (
         SELECT 1 FROM contributions c
         WHERE c.applied_policy_id = pl.id AND c.contribution_type = 'policy'
       )
  )
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
  FROM cand pl JOIN politicians p ON p.id = pl.politician_id
  WHERE p.merged_into IS NULL
    AND policy_primary_url(pl.id) IS NOT NULL
$function$;

-- mismatch：與 20261011380000 的 contribution_auto_tasks_mismatch() 逐字相同，只在五個「找出候選政見」的 CTE 與 jev 各加一行鍵過濾（policy:<政見 id>）
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_mismatch(p_keys TEXT[])
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH kk AS MATERIALIZED (
    -- 鍵過濾用：這批政見的 id
    SELECT substr(k, 8)::UUID AS id FROM unnest(p_keys) k WHERE k ~ '^policy:[0-9a-fA-F-]{36}$'
  ),
  jev AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.probability
    FROM jev_decisions j
    WHERE j.subject_type = 'policy' AND j.question = 'election'
      AND j.subject_id IN (SELECT kk.id::TEXT FROM kk)
    ORDER BY j.subject_id, j.asked_at DESC
  ),
  by_date AS (
    SELECT pl.id
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.id IN (SELECT kk.id FROM kk)
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
      AND pl.id IN (SELECT kk.id FROM kk)
      AND pl.election_id IS NOT NULL
      AND jev.choice ~ '^\d{4}$'
      AND jev.choice <> pl.election_id::TEXT
      AND jev.probability >= 0.8
  ),
  by_future AS (
    SELECT pl.id
    FROM policies pl
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.id IN (SELECT kk.id FROM kk)
      AND pl.status <> 'Campaign Pledge'
      AND e.election_date > activity_today()
  ),
  by_no_candidacy AS (
    SELECT pl.id
    FROM policies pl
    WHERE pl.removed_at IS NULL
      AND pl.id IN (SELECT kk.id FROM kk)
      AND pl.status = 'Campaign Pledge'
      AND pl.election_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id)
  ),
  by_not_elected AS (
    SELECT pl.id
    FROM policies pl
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.id IN (SELECT kk.id FROM kk)
      AND pl.status <> 'Campaign Pledge'
      AND e.election_date <= activity_today()
      AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id AND pe.candidacy_status = 'elected')
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev UNION SELECT id FROM by_future UNION SELECT id FROM by_no_candidacy UNION SELECT id FROM by_not_elected)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', policy_primary_url(pl.id),
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END)
           -- 只有新來源的列多 kind，原有的 target 一個字不變（seed 不會因此重寫既有派工列）
           || CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN jsonb_build_object('kind', 'in_office_future')
                   WHEN nc.id IS NOT NULL THEN jsonb_build_object('kind', 'pledge_no_candidacy')
                   WHEN ne.id IS NOT NULL THEN jsonb_build_object('kind', 'in_office_not_elected')
                   ELSE '{}'::jsonb END AS target,
         CASE WHEN pl.status <> 'Campaign Pledge' AND e.election_date > activity_today() THEN
           '政見「' || pl.title || '」（' || p.name || '）狀態是 ' || pl.status::TEXT || '（任內施政或已在推動），卻掛在 ' || e.election_date::TEXT
           || ' 才投票、還沒舉行的那場選舉，人物頁會把它當成過往政績、標成那場選舉。請打開來源確認：'
           || '它是任內宣布的施政 → 用 correction 把 policies.election_id 改成他這一任當選的那屆（已經投過票的那場；參選紀錄看 /next 的 current.elections）；'
           || '它其實是這次選舉的競選承諾 → 用 correction 把 policies.status 改成 Campaign Pledge；'
           || '分不出來就用 no_change 回報你查了什麼。提出日期晚於當選那屆的投票日是任內施政的正常情形，不是屆別錯了。'
         WHEN nc.id IS NOT NULL THEN
           '政見「' || pl.title || '」（' || p.name || '）是競選承諾、掛在 ' || pl.election_id || ' 那一屆，但我們沒有他參選那一屆的紀錄（參選紀錄看 /next 的 current.elections）。請打開來源確認：'
           || '他其實是在別屆提的 → 用 correction 把 policies.election_id 改成他參選的那一屆；'
           || '他確實參選了那一屆、只是我們缺參選紀錄 → 交 candidacy 補上那一屆的參選紀錄（附中選會或報導），這筆政見不用改；'
           || '它不是競選承諾而是任內施政 → 用 correction 把 status 改成 Proposed、election_id 改成他當選的那屆；分不出來用 no_change。'
         WHEN ne.id IS NOT NULL THEN
           '政見「' || pl.title || '」（' || p.name || '）狀態是 ' || pl.status::TEXT || '（任內施政或已在推動），掛在 ' || pl.election_id
           || ' 那一屆，但我們的參選紀錄沒有他在那一屆當選。任內施政要掛在他當選的那屆。請打開來源確認：'
           || '他當選的是別屆 → 用 correction 把 policies.election_id 改成那一屆；他確實在那一屆當選、只是紀錄缺或錯 → 交 candidacy 補正那一屆的參選紀錄；'
           || '它其實是那一屆的競選承諾 → 用 correction 把 status 改成 Campaign Pledge；'
           || '他沒有公職、這件事是他當議員候選人時的主張或倡議 → 改成那一次參選的競選承諾（status Campaign Pledge、election_id 填那次）；分不出來用 no_change。'
         ELSE
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。'
           || '任內施政不要改掛到還沒投票的選舉（伺服器會擋）。' END AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
  LEFT JOIN by_no_candidacy nc ON nc.id = pl.id
  LEFT JOIN by_not_elected ne ON ne.id = pl.id
$function$;

-- issue_too_broad：與 20261102010000 的 contribution_auto_tasks_issue_too_broad() 逐字相同，只加兩處鍵過濾（issue:<選舉>:<縣市>:<議題>）：
--   ① big 只看鍵裡出現的縣市（鍵的第三段）；② sc 只留 scope_key 在這批鍵裡的（縣市×議題）。其餘（threshold、queued、輸出欄位）不動
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_issue_too_broad(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH p AS (SELECT issue_too_broad_threshold() AS threshold, issue_too_broad_election() AS eid),
  kc AS MATERIALIZED (
    -- 鍵過濾用：這批鍵涉及的縣市
    SELECT DISTINCT split_part(k, ':', 3) AS county FROM unnest(p_keys) k WHERE k LIKE 'issue:%'
  ),
  big AS (
    SELECT replace(r.region, '臺', '台') AS county
      FROM p
      JOIN policies po ON po.election_id = p.eid AND po.status = 'Campaign Pledge' AND po.removed_at IS NULL
      JOIN politician_elections pe ON pe.politician_id = po.politician_id AND pe.election_id = p.eid
      JOIN regions r ON r.id = pe.region_id
     WHERE issue_level_of(pe.election_type) IS NOT NULL
       AND replace(r.region, '臺', '台') IN (SELECT kc.county FROM kc)
     GROUP BY replace(r.region, '臺', '台'), p.threshold
    HAVING count(DISTINCT po.id) > p.threshold
  ),
  sc AS MATERIALIZED (
    SELECT b.county, s.*
      FROM p CROSS JOIN big b
      CROSS JOIN LATERAL issues_scoped(p.eid, b.county) s
     WHERE NOT EXISTS (SELECT 1 FROM policy_subtopics t WHERE t.policy_id = s.policy_id AND t.issue = s.issue)
       AND 'issue:' || p.eid || ':' || b.county || ':' || regexp_replace(s.issue, '\s+', '_', 'g') = ANY (p_keys)
  ),
  grp AS (
    SELECT sc.county, sc.issue, count(DISTINCT sc.policy_id) AS n
      FROM sc CROSS JOIN p
     GROUP BY sc.county, sc.issue, p.threshold
    HAVING count(DISTINCT sc.policy_id) > p.threshold
  ),
  queued AS (
    SELECT DISTINCT c.payload ->> 'region' AS region, c.payload ->> 'issue' AS issue
      FROM contributions c WHERE c.contribution_type = 'policy_subtopics' AND c.status IN ('pending', 'verified')
  )
  SELECT 'auto:issue_too_broad:' || p.eid || ':' || g.county || ':' || regexp_replace(g.issue, '\s+', '_', 'g'),
         'issue_too_broad',
         jsonb_build_object(
           'election_id', p.eid, 'region', g.county, 'issue', g.issue, 'total', g.n, 'threshold', p.threshold, 'list_cap', 200,
           'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('policy_id', x.policy_id, 'title', x.title, 'level', x.level)
                                                  ORDER BY x.level_rank, x.proposed_date DESC NULLS LAST, x.policy_id), '[]'::JSONB)
                          FROM (SELECT d.* FROM (SELECT DISTINCT ON (s.policy_id) s.policy_id, s.title, s.level, s.level_rank, s.proposed_date
                                                   FROM sc s WHERE s.county = g.county AND s.issue = g.issue
                                                  ORDER BY s.policy_id) d
                                 ORDER BY d.level_rank, d.proposed_date DESC NULLS LAST, d.policy_id LIMIT 200) x),
           'existing_subtopics', (SELECT COALESCE(jsonb_agg(q.subtopic ORDER BY q.cnt DESC, q.subtopic), '[]'::JSONB)
                                    FROM (SELECT t.subtopic, count(*) AS cnt FROM policy_subtopics t WHERE t.issue = g.issue GROUP BY t.subtopic) q),
           'source_url', 'https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'),
         g.county || '的「' || g.issue || '」議題在 ' || p.eid || ' 年有 ' || g.n || ' 筆承諾還沒有細項，超過 ' || p.threshold
           || ' 筆，一個大類太寬、各級承諾很難比到同一件事。請讀 target.policies 的承諾，提出 2～6 個細項標籤（每個 2～12 字，例如「托育」「敬老津貼」），'
           || '並逐筆歸類：**優先沿用 target.existing_subtopics 已存在的細項名**，真的沒有合適的才新取名；一筆承諾歸進最貼切的一個細項，'
           || '實在歸不進去的就不要放進 assignments（不要硬塞）。用 policy_subtopics 交一份：election_id、region、issue 照 target 原樣帶回，'
           || 'subtopics 是你用到的細項名（每個都要有承諾歸進去），assignments 是 [{policy_id, subtopic}]（subtopic 必須在 subtopics 裡）；'
           || '大類議題不會被改掉，細項只是在大類底下再分一層。source_urls 放 target.source_url。',
         ARRAY['https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'],
         1, g.county
    FROM grp g CROSS JOIN p
   WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.region = g.county AND q.issue = g.issue)
$$;

-- ------------------------------------------------------------
-- 3. 投票日翻轉：今天正好是某場選舉的投票日，mismatch 整臂入一筆事件（by_future／by_not_elected 的邊界）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_date_flip() RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM elections e WHERE e.election_date = activity_today())
     AND dispatch_gap_enqueue_reg('mismatch', '*', 'date_flip') THEN
    RETURN 1;
  END IF;
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION dispatch_gap_recompute_legacy(TEXT[]) IS '20261126193000：legacy 臂的按鍵版（鍵＝policy:<政見 id>），本體同現行臂函式、只多一行鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_mismatch(TEXT[]) IS '20261126193000：mismatch 臂的按鍵版（鍵＝policy:<政見 id>），本體同現行臂函式、只在候選政見與 jev 加鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_issue_too_broad(TEXT[]) IS '20261126193000：issue_too_broad 臂的按鍵版（鍵＝issue:<選舉>:<縣市>:<議題>），本體同現行臂函式、只多縣市與（縣市×議題）鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_date_flip() IS '20261126193000：今天正好是某場選舉的投票日時，mismatch 整臂入一筆 date_flip 事件（投票日翻轉不是任何資料變更）。pg_cron dispatch-gap-date-flip-daily 台北 00:04 呼叫。';

REVOKE ALL ON FUNCTION dispatch_gap_on_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_legacy(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_mismatch(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_issue_too_broad(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_date_flip() FROM PUBLIC, anon, authenticated;

-- 登記按鍵版（drain 沒有 '*' 的批次就走它；整臂與對帳仍走 full_fn）
UPDATE dispatch_gap_arm_keys SET recompute_fn = 'dispatch_gap_recompute_legacy(text[])' WHERE arm = 'legacy';
UPDATE dispatch_gap_arm_keys SET recompute_fn = 'dispatch_gap_recompute_mismatch(text[])' WHERE arm = 'mismatch';
UPDATE dispatch_gap_arm_keys SET recompute_fn = 'dispatch_gap_recompute_issue_too_broad(text[])' WHERE arm = 'issue_too_broad';

-- ------------------------------------------------------------
-- 4. 切 shadow ＋ 初始灌入（觸發器之前做：灌入約 15 秒，不要讓 CREATE TRIGGER 的表鎖等著它）
-- ------------------------------------------------------------
SELECT dispatch_gap_set_mode('legacy', 'shadow', '第 1 期 PR-1：雙軌開始');
SELECT dispatch_gap_set_mode('mismatch', 'shadow', '第 1 期 PR-1：雙軌開始');
SELECT dispatch_gap_set_mode('issue_too_broad', 'shadow', '第 1 期 PR-1：雙軌開始');

DO $$
BEGIN
  -- 與 seed 的 drain 共用 advisory lock：恰好撞上就拿不到鎖、這裡什麼都沒灌；下面補的整臂事件會讓第一輪 seed 補上
  PERFORM count(*) FROM dispatch_gap_reconcile_all(ARRAY['legacy', 'mismatch', 'issue_too_broad']);
END $$;

-- ------------------------------------------------------------
-- 5. 觸發器（最後才掛；表鎖到交易結束，所以只留短短一段）
-- ------------------------------------------------------------
SET LOCAL lock_timeout = '30s';

DROP TRIGGER IF EXISTS trg_dispatch_gap_policies ON policies;
CREATE TRIGGER trg_dispatch_gap_policies
  AFTER INSERT OR UPDATE OF title, category, tags, status, proposed_date, election_id, politician_id, removed_at OR DELETE
  ON policies FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_politician_elections ON politician_elections;
CREATE TRIGGER trg_dispatch_gap_politician_elections
  AFTER INSERT OR UPDATE OF candidacy_status, election_id, politician_id, region_id, election_type OR DELETE
  ON politician_elections FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_politicians ON politicians;
CREATE TRIGGER trg_dispatch_gap_politicians
  AFTER UPDATE OF name, region, merged_into
  ON politicians FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_jev_decisions ON jev_decisions;
CREATE TRIGGER trg_dispatch_gap_jev_decisions
  AFTER INSERT
  ON jev_decisions FOR EACH ROW WHEN (NEW.subject_type = 'policy' AND NEW.question = 'election')
  EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_edit_history ON edit_history;
CREATE TRIGGER trg_dispatch_gap_edit_history
  AFTER INSERT
  ON edit_history FOR EACH ROW WHEN (NEW.table_name = 'policies' AND NEW.field IN ('audit', '*'))
  EXECUTE FUNCTION dispatch_gap_on_change();

-- source_refs：WHEN 不能在同一支觸發器同時引用 NEW 與 OLD，所以拆成新增、更新、刪除三支
DROP TRIGGER IF EXISTS trg_dispatch_gap_source_refs_ins ON source_refs;
CREATE TRIGGER trg_dispatch_gap_source_refs_ins
  AFTER INSERT
  ON source_refs FOR EACH ROW WHEN (NEW.target_table = 'policies' AND NEW.role = 'primary')
  EXECUTE FUNCTION dispatch_gap_on_change();
DROP TRIGGER IF EXISTS trg_dispatch_gap_source_refs_upd ON source_refs;
CREATE TRIGGER trg_dispatch_gap_source_refs_upd
  AFTER UPDATE OF role, source_id, target_id
  ON source_refs FOR EACH ROW WHEN (NEW.target_table = 'policies' AND (NEW.role = 'primary' OR OLD.role = 'primary'))
  EXECUTE FUNCTION dispatch_gap_on_change();
DROP TRIGGER IF EXISTS trg_dispatch_gap_source_refs_del ON source_refs;
CREATE TRIGGER trg_dispatch_gap_source_refs_del
  AFTER DELETE
  ON source_refs FOR EACH ROW WHEN (OLD.target_table = 'policies' AND OLD.role = 'primary')
  EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_contributions ON contributions;
CREATE TRIGGER trg_dispatch_gap_contributions
  AFTER INSERT OR UPDATE OF status, applied_policy_id
  ON contributions FOR EACH ROW WHEN (NEW.contribution_type IN ('policy', 'policy_subtopics'))
  EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_policy_subtopics ON policy_subtopics;
CREATE TRIGGER trg_dispatch_gap_policy_subtopics
  AFTER INSERT OR UPDATE OF policy_id, issue OR DELETE
  ON policy_subtopics FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_elections ON elections;
CREATE TRIGGER trg_dispatch_gap_elections
  AFTER INSERT OR UPDATE OF election_date OR DELETE
  ON elections FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_activity_rules ON activity_rules;
CREATE TRIGGER trg_dispatch_gap_activity_rules
  AFTER INSERT OR UPDATE OF params, activity OR DELETE
  ON activity_rules FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

-- ------------------------------------------------------------
-- 6. 開關：事件、seed 開頭 drain；補整臂事件（灌入到掛上觸發器之間漏掉的變更，第一輪 seed 的 drain 一次補齊）
-- ------------------------------------------------------------
UPDATE dispatch_gap_settings SET events_enabled = true, seed_drain_enabled = true WHERE id = 1;

SELECT dispatch_gap_enqueue('legacy', '*', 'migration');
SELECT dispatch_gap_enqueue('mismatch', '*', 'migration');
SELECT dispatch_gap_enqueue('issue_too_broad', '*', 'migration');

-- ------------------------------------------------------------
-- 7. 排程：投票日翻轉（UTC 16:04＝台北 00:04；分鐘避開整十、:29、:35 與奇數分鐘）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-date-flip-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-date-flip-daily')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-date-flip-daily', '4 16 * * *', 'SELECT dispatch_gap_date_flip();')$q$;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 8. 自我檢查：三支臂是 shadow、按鍵版都在且已登記、觸發器都掛上、兩個開關開著、其他臂維持 off
-- ------------------------------------------------------------
DO $$
DECLARE
  v_n INTEGER;
BEGIN
  IF (SELECT count(*) FROM dispatch_gap_arms WHERE mode = 'shadow') <> 3
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'shadow' AND arm NOT IN ('legacy', 'mismatch', 'issue_too_broad'))
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'live') THEN
    RAISE EXCEPTION '第 1 期 PR-1：只有 legacy、mismatch、issue_too_broad 三支臂可以是 shadow，不能有 live';
  END IF;
  IF EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm IN ('legacy', 'mismatch', 'issue_too_broad')
              AND (k.recompute_fn IS NULL OR to_regprocedure(k.recompute_fn) IS NULL)) THEN
    RAISE EXCEPTION '第 1 期 PR-1：三支臂的按鍵版沒有登記或函式不存在';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger WHERE tgname LIKE 'trg\_dispatch\_gap\_%' AND NOT tgisinternal;
  IF v_n <> 12 THEN
    RAISE EXCEPTION '第 1 期 PR-1：預期掛 12 支觸發器，實際 %', v_n;
  END IF;
  IF NOT dispatch_gap_events_enabled() OR NOT dispatch_gap_seed_drain_enabled() THEN
    RAISE EXCEPTION '第 1 期 PR-1：事件與 seed drain 兩個開關都要是開';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
