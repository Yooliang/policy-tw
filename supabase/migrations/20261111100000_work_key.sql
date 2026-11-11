-- 工作卡鍵 work_key：階梯、租約、換號都認它（2026-11-11，docs/PLAN-dispatch-work-unit.md 第 0 期 0.1，不升協議版）
--
-- 起因：44 支臂各自編 task_id，粒度不一；冷卻與查核階梯的鍵是完整 task_id，所以同一人同一件事換號（指紋變）、
-- 換臂（11/29 policy_missing → term_policy_missing）、手動任務與自動缺口並存時，查核史歸零、租約擋不住兩個代理同時做同一件事。
-- 做法：不改任何臂的輸出，加一個可推導的 work_key＝「這張工作卡是什麼」，由 task_work_key(task_id, target) 算：
--
--   政見缺口（人 × 當屆政見）   auto:policy_missing:<pid>                      → politician:<pid>:policies:<campaign_election_id()>
--                               auto:term_policy_missing:<pid>:<eid>           → politician:<pid>:policies:<eid>（屆別是 scope，不是 need；同人同屆同一張卡）
--   基本資料（人）              auto:profile_gap:<pid>、auto:profile_detail_gap:<pid>、auto:profile_detail_gap:sources:<pid>
--                                                                              → politician:<pid>:profile
--   一條政見的臂                auto:<臂>:<policy_id>（policy_validity 舊形 <pe>:<policy_id> 取最後一段）
--                               臂＝policy_elements_missing、progress_stale、deadline_due、policy_validity、policy_election_missing、
--                                    policy_election_mismatch、policy_source_missing、legacy_audit
--                                                                              → policy:<policy_id>:<臂>
--   帶內容指紋的臂              auto:<臂>:<鍵>:<8～32 碼十六進位指紋>（臂＝task_rekey_arms()＋handover_missing）
--                                                                              → 去掉末段指紋（沿用 task_rekey_stable_key 的做法）
--   單位型                      auto:candidacy_source_missing:cand_no[_recheck]:<屆>:<型>:<縣市>[:<鄉鎮>][:pN]
--                                                                              → unit:<屆>:<型>:<縣市[:鄉鎮]>:cand_no[_recheck][:pN]
--                               auto:election_results_missing:<屆>:<型>:<縣市>[:<鄉鎮>][:pN]
--                                                                              → unit:<屆>:<型>:<縣市[:鄉鎮]>:election_results[:pN]
--                               auto:roster_check:<屆>:<單位>:<型>             → unit:<屆>:<型>:<單位>:roster_check
--                               auto:district_seats_missing:<屆>:<縣市>:<型>   → unit:<屆>:<型>:<縣市>:district_seats
--                               （pN＝一單位拆成每 50 人一件的分段，是不同的人，不合併）
--   其他 auto:                  原樣（auto:<臂>:<第三段起>）；例外：auto:lineage_status_stale:<脈絡>:<截至日> 去掉末段截至日
--   uuid 手動任務               查 contribution_tasks：task_type＝policy_missing／term_policy_missing → politician:<pid>:policies:<target.election_id，沒有就當屆>
--                               （網站請求缺政見因此跟自動缺口同一張卡）；profile_gap／profile_detail_gap → politician:<pid>:profile；
--                               上面「一條政見的臂」那幾個型別且 target.policy_id → policy:<id>:<型別>；其餘（或取不到）→ task:<uuid>
--   verify:<貢獻 id>            → 該交件母任務的 work_key（contributions.task_id，沒有就 payload->>'task_id'）；找不到母任務回 NULL
--
-- activity_arm_names() 全部 43 個臂 → task_id 長相 → work_key（正式庫 2026-11-11 task_dispatches／task_checks／gap_events 全部 task_id 逐一核對）：
--   raw:policy_missing         auto:policy_missing:<pid>                       politician:<pid>:policies:<當屆>
--   mayor_policies             auto:policy_missing:<pid>（縣市長）             同上（跟 raw 同一張卡）
--   term_policies              auto:term_policy_missing:<pid>:<eid>            politician:<pid>:policies:<eid>
--   traffic:term_policies      同 term_policies（只換臂名）
--   raw:profile_gap            auto:profile_gap:<pid>                          politician:<pid>:profile
--   career_sources             auto:profile_detail_gap:sources:<pid>           politician:<pid>:profile
--   raw:policy_validity        auto:policy_validity:<policy_id>                policy:<id>:policy_validity
--   raw:progress_stale         auto:progress_stale:<policy_id>                 policy:<id>:progress_stale
--   traffic:progress_stale     同 progress_stale
--   deadline_due               auto:deadline_due:<policy_id>                   policy:<id>:deadline_due
--   traffic:deadline_due       同 deadline_due
--   policy_elements            auto:policy_elements_missing:<policy_id>        policy:<id>:policy_elements_missing
--   raw:policy_election_missing auto:policy_election_missing:<policy_id>       policy:<id>:policy_election_missing
--   mismatch                   auto:policy_election_mismatch:<policy_id>       policy:<id>:policy_election_mismatch
--   legacy                     auto:legacy_audit:<policy_id>                   policy:<id>:legacy_audit
--   policy_dup                 auto:duplicate_policy:<pe_or_pid>:<fp>          auto:duplicate_policy:<…>（去指紋）
--   lineage_candidates         auto:lineage_candidate:<區塊>:<fp>              auto:lineage_candidate:<區塊>（去指紋）
--   lineage_links              auto:lineage_link_candidate:<下級脈絡>:<fp>     auto:lineage_link_candidate:<下級脈絡>（去指紋）
--   handover_missing           auto:handover_missing:<脈絡>:<fp 8 碼>          auto:handover_missing:<脈絡>（去指紋）
--   lineage_roles              auto:lineage_roles_missing:<脈絡>               原樣
--   lineage_status             auto:lineage_status_stale:<脈絡>:<截至日>       auto:lineage_status_stale:<脈絡>
--   dup                        auto:duplicate_politician:<a>|<b>               原樣
--   placeholder_politicians    auto:placeholder_politician:<pid>               原樣
--   raw:candidacy_source_missing、township_gap、region_gap  auto:candidacy_source_missing:<pe_id>  原樣（人×參選紀錄）
--   party_gap、party_roster    auto:candidacy_source_missing:party:<pe_id>     原樣
--   raw:candidate_status_stale auto:candidate_status_stale:<pe_id>             原樣
--   not_running                auto:not_running_recheck:<pe_id>                原樣
--   withdrawn_filing           auto:not_running_recheck:filing:<pe_id>         原樣
--   elected_missing、election_results（人）  auto:election_result_missing:<pe_id>、auto:election_result_missing:cec:<…>:<…>  原樣
--   owner_mismatch             auto:candidacy_owner_mismatch:<pe_id>           原樣
--   ballot_numbers             auto:candidacy_source_missing:cand_no[_recheck]:<屆>:<型>:<縣市>…  unit:<屆>:<型>:<縣市…>:cand_no[_recheck][:pN]
--   election_results（單位）   auto:election_results_missing:<屆>:<型>:<縣市>…  unit:<屆>:<型>:<縣市…>:election_results[:pN]
--   raw:roster_check、roster_villages、roster_cec_gap、（名單清查收斂的單位列） auto:roster_check:<屆>:<單位>:<型>  unit:<屆>:<型>:<單位>:roster_check
--   district_seats             auto:district_seats_missing:<屆>:<縣市>:<型>    unit:<屆>:<型>:<縣市>:district_seats
--   party_info                 auto:party_info_missing:<kind>:<id>             原樣
--   regional_stats_missing     auto:regional_stat_missing:<行政區代碼>         原樣
--   issue_too_broad            auto:issue_too_broad:<屆>:<縣市>:<議題>         原樣
--   manual_visitor、manual_open <uuid>（contribution_tasks.id）                見上面「uuid 手動任務」；其他型別 task:<uuid>
--   （名冊分組的逐人鍵 auto:roster_group_person:…、auto:candidacy_owner_mismatch:<pe> 也走「原樣」）
--
-- 這支 migration「只加欄位與改函式本體，不刪欄位、不改簽名」（CLAUDE.md：改簽名的分兩次上）：
--   · task_dispatches／task_checks／contribution_task_leases 各加 work_key 欄；觸發器在寫入時算（需要 target，不能用 GENERATED），回填既有列
--   · 階梯（視圖 task_ladder_closed、函式 task_check_cooldown_days_for）、refresh_dispatch_blocked 的 cool_until、
--     contribution_queue_tasks 的認領中，改認 work_key（整支 CREATE OR REPLACE 重寫，簽名不變）
--   · 換號沿用（20261019040000）不用搬資料：新列的 work_key 跟舊列相同，task_checks（鍵是 work_key）自然延續
--   · 租約：原本的 target_key（整個人／整條政見）比對照舊保留、另加 work_key 相等也算被認領（只多擋、不少擋；
--     兩張不同的卡〔同一人的缺政見與補基本資料〕仍然不會同時派給兩個代理）
-- 不改的（登記）：manual_front_pull／cand_no_front_pull 等「插隊拉回」仍按自己的 task_id 讀 task_checks（20261109180000），之後要接 work_key 另開。

-- ------------------------------------------------------------
-- 1. 欄位與索引
-- ------------------------------------------------------------
ALTER TABLE task_dispatches          ADD COLUMN IF NOT EXISTS work_key TEXT;
ALTER TABLE task_checks              ADD COLUMN IF NOT EXISTS work_key TEXT;
ALTER TABLE contribution_task_leases ADD COLUMN IF NOT EXISTS work_key TEXT;
COMMENT ON COLUMN task_dispatches.work_key          IS '工作卡鍵（task_work_key(task_id, target)，BEFORE INSERT／UPDATE OF task_id, target 觸發器填）：同一人×同一件事同一個鍵，跨臂、跨指紋、跨手動任務。2026-11-11';
COMMENT ON COLUMN task_checks.work_key              IS '工作卡鍵（寫入時由 task_id 算，算不出來用 task:<task_id>）：查核階梯與冷卻按它累計，換號、換臂不歸零。2026-11-11';
COMMENT ON COLUMN contribution_task_leases.work_key IS '工作卡鍵（寫入時由 task_id 算）：兩個任務代號同一張卡時，租約互相擋。2026-11-11';
CREATE INDEX IF NOT EXISTS task_dispatches_work_key_idx          ON task_dispatches (work_key);
CREATE INDEX IF NOT EXISTS task_checks_work_key_idx              ON task_checks (work_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS contribution_task_leases_work_key_idx ON contribution_task_leases (work_key, leased_until);

-- ------------------------------------------------------------
-- 2. task_work_key
-- ------------------------------------------------------------
-- 帶內容指紋的臂：task_rekey_arms()（換號沿用排隊位置的那份清單）＋handover_missing（task_id 末段 substr(md5(…), 1, 8)）。
-- 不改 task_rekey_arms() 本身（它決定 seed 的沿用排隊位置，加臂會改派工行為）。
CREATE OR REPLACE FUNCTION task_work_key_fp_arms() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$ SELECT task_rekey_arms() || ARRAY['handover_missing']::TEXT[] $$;
COMMENT ON FUNCTION task_work_key_fp_arms IS '工作卡鍵要去掉末段指紋的臂：task_rekey_arms()＋handover_missing。2026-11-11';

CREATE OR REPLACE FUNCTION task_work_key(p_task_id TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_seg    TEXT[];
  v_n      INTEGER;
  v_arm    TEXT;
  v_u      UUID;
  v_parent TEXT;
  v_t      JSONB;
  v_type   TEXT;
  v_pid    TEXT;
  v_poid   TEXT;
  v_i      INTEGER;
  v_chunk  TEXT;
BEGIN
  IF p_task_id IS NULL OR p_task_id = '' THEN RETURN NULL; END IF;

  -- 驗證票：母任務的工作卡
  IF p_task_id LIKE 'verify:%' THEN
    v_u := uuid_or_null(substr(p_task_id, 8));
    IF v_u IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(c.task_id, c.payload->>'task_id') INTO v_parent FROM contributions c WHERE c.id = v_u;
    IF v_parent IS NULL OR v_parent = '' OR v_parent LIKE 'verify:%' THEN RETURN NULL; END IF;
    RETURN task_work_key(v_parent, NULL);
  END IF;

  -- uuid 手動任務：從 contribution_tasks 取 target 與 task_type，組成跟自動缺口同樣形狀的鍵
  v_u := uuid_or_null(p_task_id);
  IF v_u IS NOT NULL THEN
    SELECT t.task_type, t.target INTO v_type, v_t FROM contribution_tasks t WHERE t.id = v_u;
    IF NOT FOUND THEN v_type := NULL; v_t := COALESCE(p_target, '{}'::JSONB); END IF;
    v_pid  := CASE WHEN uuid_or_null(v_t->>'politician_id') IS NOT NULL THEN lower(v_t->>'politician_id') END;
    v_poid := CASE WHEN uuid_or_null(v_t->>'policy_id') IS NOT NULL THEN lower(v_t->>'policy_id') END;
    IF v_type IN ('policy_missing', 'term_policy_missing') AND v_pid IS NOT NULL THEN
      RETURN 'politician:' || v_pid || ':policies:' || COALESCE(election_id_or_null(v_t->>'election_id')::TEXT, campaign_election_id()::TEXT);
    ELSIF v_type IN ('profile_gap', 'profile_detail_gap') AND v_pid IS NOT NULL THEN
      RETURN 'politician:' || v_pid || ':profile';
    ELSIF v_type IN ('policy_elements_missing', 'progress_stale', 'deadline_due', 'policy_validity', 'policy_election_missing',
                     'policy_election_mismatch', 'policy_source_missing', 'legacy_audit') AND v_poid IS NOT NULL THEN
      RETURN 'policy:' || v_poid || ':' || v_type;
    END IF;
    RETURN 'task:' || p_task_id;
  END IF;

  IF p_task_id NOT LIKE 'auto:%' THEN RETURN p_task_id; END IF;

  v_seg := string_to_array(p_task_id, ':');
  v_n   := array_length(v_seg, 1);
  v_arm := v_seg[2];

  -- 政見缺口：人 × 屆
  IF v_arm = 'policy_missing' AND v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
    RETURN 'politician:' || lower(v_seg[3]) || ':policies:' || campaign_election_id();
  ELSIF v_arm = 'term_policy_missing' AND v_n = 4 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
    RETURN 'politician:' || lower(v_seg[3]) || ':policies:' || v_seg[4];
  END IF;

  -- 基本資料
  IF v_arm IN ('profile_gap', 'profile_detail_gap') THEN
    IF v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
      RETURN 'politician:' || lower(v_seg[3]) || ':profile';
    ELSIF v_n = 4 AND v_seg[3] = 'sources' AND uuid_or_null(v_seg[4]) IS NOT NULL THEN
      RETURN 'politician:' || lower(v_seg[4]) || ':profile';
    END IF;
  END IF;

  -- 一條政見的臂
  IF v_arm IN ('policy_elements_missing', 'progress_stale', 'deadline_due', 'policy_validity', 'policy_election_missing',
               'policy_election_mismatch', 'policy_source_missing', 'legacy_audit') THEN
    IF v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
      RETURN 'policy:' || lower(v_seg[3]) || ':' || v_arm;
    ELSIF v_n = 4 AND v_arm = 'policy_validity' AND uuid_or_null(v_seg[4]) IS NOT NULL THEN
      RETURN 'policy:' || lower(v_seg[4]) || ':' || v_arm;   -- 舊形 <pe_id>:<policy_id>
    END IF;
  END IF;

  -- 帶內容指紋的臂：去掉末段指紋
  IF v_arm = ANY (task_work_key_fp_arms()) AND p_task_id ~ '^auto:[a-z_]+:[^:]+:[0-9a-f]{8,32}$' THEN
    RETURN regexp_replace(p_task_id, ':[0-9a-f]{8,32}$', '');
  END IF;

  -- 脈絡現況：末段是截至日，不是內容
  IF v_arm = 'lineage_status_stale' AND v_n = 4 THEN
    RETURN 'auto:lineage_status_stale:' || v_seg[3];
  END IF;

  -- 單位型
  IF v_arm = 'candidacy_source_missing' AND v_seg[3] IN ('cand_no', 'cand_no_recheck') AND v_n >= 6 THEN
    v_i := v_n; v_chunk := '';
    IF v_seg[v_n] ~ '^p[0-9]+$' THEN v_chunk := ':' || v_seg[v_n]; v_i := v_n - 1; END IF;
    IF v_i >= 6 THEN
      RETURN 'unit:' || v_seg[4] || ':' || v_seg[5] || ':' || array_to_string(v_seg[6:v_i], ':') || ':' || v_seg[3] || v_chunk;
    END IF;
  ELSIF v_arm = 'election_results_missing' AND v_n >= 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    v_i := v_n; v_chunk := '';
    IF v_seg[v_n] ~ '^p[0-9]+$' THEN v_chunk := ':' || v_seg[v_n]; v_i := v_n - 1; END IF;
    IF v_i >= 5 THEN
      RETURN 'unit:' || v_seg[3] || ':' || v_seg[4] || ':' || array_to_string(v_seg[5:v_i], ':') || ':election_results' || v_chunk;
    END IF;
  ELSIF v_arm = 'roster_check' AND v_n = 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    RETURN 'unit:' || v_seg[3] || ':' || v_seg[5] || ':' || v_seg[4] || ':roster_check';
  ELSIF v_arm = 'district_seats_missing' AND v_n = 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    RETURN 'unit:' || v_seg[3] || ':' || v_seg[5] || ':' || v_seg[4] || ':district_seats';
  END IF;

  RETURN p_task_id;   -- 其他 auto:：原樣
END;
$$;
COMMENT ON FUNCTION task_work_key IS
  '工作卡鍵（2026-11-11，docs/PLAN-dispatch-work-unit.md 0.1）：同一人×同一件事同一個鍵。完整對應表見 migration 20261111100000 檔頭；'
  'policy_missing 與 term_policy_missing 同人同屆同鍵、帶指紋的臂去掉末段指紋、uuid 手動任務查 contribution_tasks 組成同樣形狀、verify:<id> 取母任務的鍵（找不到 NULL）。STABLE（讀 campaign_election_id、contribution_tasks、contributions）';

-- ------------------------------------------------------------
-- 3. 寫入時填 work_key 的觸發器（task_dispatches 需要 target，所以不用 GENERATED）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_key_fill() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'task_dispatches' THEN
    NEW.work_key := task_work_key(NEW.task_id, NEW.target);
  ELSE
    -- task_checks、contribution_task_leases：呼叫端自己帶了就用；沒帶就由 task_id 算，算不出來退回 task:<task_id>（階梯永不歸 NULL）
    NEW.work_key := COALESCE(NEW.work_key, task_work_key(NEW.task_id, NULL), 'task:' || NEW.task_id);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION work_key_fill IS 'task_dispatches／task_checks／contribution_task_leases 寫入時填 work_key（task_work_key）；TS 不算，SQL 同一份定義。2026-11-11';

DROP TRIGGER IF EXISTS trg_task_dispatches_work_key ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_work_key BEFORE INSERT OR UPDATE OF task_id, target ON task_dispatches
  FOR EACH ROW EXECUTE FUNCTION work_key_fill();
DROP TRIGGER IF EXISTS trg_task_checks_work_key ON task_checks;
CREATE TRIGGER trg_task_checks_work_key BEFORE INSERT ON task_checks
  FOR EACH ROW EXECUTE FUNCTION work_key_fill();
DROP TRIGGER IF EXISTS trg_task_leases_work_key ON contribution_task_leases;
CREATE TRIGGER trg_task_leases_work_key BEFORE INSERT OR UPDATE OF task_id ON contribution_task_leases
  FOR EACH ROW EXECUTE FUNCTION work_key_fill();

-- ------------------------------------------------------------
-- 4. 查核階梯改 PARTITION BY work_key（20261109150000 的視圖與冷卻函式；簽名、欄位不變）
-- ------------------------------------------------------------
-- 結案清單：同一張工作卡的 not_found＋confirmed 累計編號超過階梯格數＝結案；輸出「這張卡現在的每一個任務代號」
-- （查核紀錄上出現過的，加派工列上目前掛著這個 work_key 的），所以換號、換臂後的新任務代號一出生就是結案的（找不到 work_key 退回 task_id）
CREATE OR REPLACE VIEW task_ladder_closed AS
WITH numbered AS (
  SELECT tc.task_id, COALESCE(tc.work_key, tc.task_id) AS wk, tc.outcome, tc.checked_at, tc.id,
         row_number() OVER (PARTITION BY COALESCE(tc.work_key, tc.task_id) ORDER BY tc.checked_at, tc.id) AS n,
         count(*) OVER (PARTITION BY COALESCE(tc.work_key, tc.task_id)) AS checks
    FROM task_checks tc
   WHERE tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)
), closed AS (
  SELECT wk, max(checks) AS checks, min(checked_at) AS closed_at, max(checked_at) AS last_checked_at
    FROM numbered
   WHERE task_check_ladder_days(outcome, n) IS NULL
   GROUP BY wk
), members AS (
  SELECT COALESCE(tc.work_key, tc.task_id) AS wk, tc.task_id FROM task_checks tc
  UNION
  SELECT d.work_key, d.task_id FROM task_dispatches d WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%'
)
SELECT m.task_id, c.checks, c.closed_at, c.last_checked_at,
       CASE WHEN m.task_id LIKE 'auto:%' THEN split_part(m.task_id, ':', 2) ELSE 'manual' END AS task_kind
  FROM closed c
  JOIN members m ON m.wk = c.wk;
COMMENT ON VIEW task_ladder_closed IS '被查核階梯結案的任務（同一張工作卡 work_key 的 not_found＋confirmed 累計超過階梯格數，2026-11-11 起；之前按 task_id）：每個掛在這張卡上的任務代號一列。auto: 任務由 refresh_dispatch_blocked 永久 blocked、手動任務被關閉。維護者覆核用；要放回去＝刪掉那幾筆 task_checks（或改設定表 days）';

-- 一筆 task_checks 的冷卻天數：階梯與「進度類第二次起」的次序都按同一張工作卡累計（p_id 那一列的 work_key；找不到就由 task_id 算）
CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(p_task_id) THEN
             COALESCE(task_check_ladder_days(p_outcome,
                        (SELECT count(*) FROM task_checks x
                          WHERE x.work_key = one.wk AND x.outcome IN ('not_found', 'confirmed') AND (x.checked_at, x.id) <= (p_checked_at, p_id))),
                      (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome))
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
                AND (SELECT count(*) FROM task_checks x
                      WHERE x.work_key = one.wk AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2
             THEN s.not_found_repeat_days
           WHEN p_outcome = 'not_found' THEN task_not_found_cooldown_days()
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT COALESCE((SELECT y.work_key FROM task_checks y WHERE y.id = p_id), task_work_key(p_task_id, NULL), 'task:' || p_task_id) AS wk) AS one
    LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數（2026-11-11 起次序按工作卡 work_key 累計，換號、換臂不歸零）：unreachable＝task_unreachable_cooldown_days()；非例外任務的 not_found／confirmed＝階梯（task_check_ladder_days，同一張卡兩種合計的第 n 次）；例外任務（task_check_ladder_exempt）not_found＝2 天（進度類第二次起 not_found_repeat_days）、confirmed 與其餘＝task_check_cooldown_days()';

-- ------------------------------------------------------------
-- 5. contribution_queue_tasks：認領中多比 work_key（整支重寫；簽名與回傳欄位不變，其餘與正式庫現行定義一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 強模型待辦（20261109230000）：requires_tier='strong' 的難題不進一般派工，只由持鑰匙者 GET /next?lane=strong 認領
    AND d.target->>'requires_tier' IS DISTINCT FROM 'strong'
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面所有「合格」條件都在 LIMIT 之前：不合格的列不佔窗口（程式裡的過濾器發生在 LIMIT 之後，會讓窗口被不合格的列塞滿、全部剔掉就沒有任務可派）
    -- >>> 合格：認領中
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target)
             -- 工作卡鍵（20261111100000）：同一張卡（跨臂、跨指紋、手動任務與自動缺口）被別人認領中也不派
             OR (d.work_key IS NOT NULL AND l.work_key = d.work_key))
    ))
    -- <<< 合格：認領中
    -- >>> 合格：同機器交過
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
    -- <<< 合格：同機器交過
    -- >>> 合格：任務停放
    -- 底下有任何一份交件還在途（pending／verified／disputed；任務編號看 contributions.task_id，欄是空的看 payload.task_id）的任務就停放：
    -- 派工列還在、排序鍵不動，只是不可派（20261017010000）。任一份通過 → 任務結束（手動任務 shouldCloseOnApplied、auto: 缺口列由觸發器
    -- contributions_drop_dispatch 收回）；全部被退 → 這個條件不成立，任務在原本的位置再派。不分誰來領，所以 p_ip_hash 為 NULL 也排。
    -- 不停放的三型（各有自己的既有規則，下面的標記照舊）：question（一題最多收 3 份答案）、adjudicate（已有裁決在等）、roster_check（一單位會交很多筆、在途額滿 5）
    -- 寫成兩個各自獨立的 NOT EXISTS（欄一個、payload 一個），不用 OR 包起來：OR 會讓規劃器改走逐列的子查詢（正式庫唯讀實測全量版本 5.5 秒），
    -- 分開寫才會變成 anti join、各走各的索引（contributions_task_id_status_idx、contributions_payload_task_inflight_idx）；三型例外放在子查詢裡當外層條件
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check') AND NOT task_target_multi_person(d.target)
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id = d.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions f
      WHERE d.task_type NOT IN ('question', 'adjudicate', 'roster_check') AND NOT task_target_multi_person(d.target)
        AND f.status IN ('pending', 'verified', 'disputed') AND f.task_id IS NULL AND f.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：任務停放
    -- >>> 合格：查無回報在等票
    -- 有人回報查無（no_change）還在等票或已通過、還沒落庫的任務，/next 不派給任何人（filterReportedDeadEnds）；不分誰來領，所以 p_ip_hash 為 NULL 也排
    AND NOT EXISTS (
      SELECT 1 FROM contributions n
      WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
        AND n.payload->>'task_id' = d.task_id
    )
    -- <<< 合格：查無回報在等票
    -- >>> 合格：在途未額滿
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；LIMIT 5 讓計數最多數到 5 筆
    AND (SELECT count(*) FROM (
      SELECT 1 FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed') LIMIT 5
    ) inflight) < 5
    -- <<< 合格：在途未額滿
    -- >>> 合格：提問未滿額
    -- 手動任務裡的公民提問（task_type＝question、不是 auto:）：已上線答案（citizen_questions.answer_count）＋還在等票的 question_answer ≥ question_answer_cap() 就不派（fullQuestionIdsOf）
    AND (d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR uuid_or_null(d.target->>'question_id') IS NULL OR
         COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id = uuid_or_null(d.target->>'question_id')), 0)
         + (SELECT count(*) FROM contributions a
             WHERE a.task_id = d.task_id AND a.contribution_type = 'question_answer' AND a.status IN ('pending', 'verified'))
         < question_answer_cap())
    -- <<< 合格：提問未滿額
    -- >>> 合格：提問這台答過
    -- 這個代號答過這一題（question_answers，含已上線）、或這個代號／IP 交過這個任務的 question_answer（含 applied）就不再派給他（my_answers + filterAnsweredQuestionTasks）
    AND (p_ip_hash IS NULL OR d.task_type <> 'question' OR d.task_id LIKE 'auto:%' OR (
      NOT EXISTS (SELECT 1 FROM question_answers qa
                   WHERE qa.question_id = uuid_or_null(d.target->>'question_id') AND lower(qa.agent_name) = lower(COALESCE(p_agent, '')))
      AND NOT EXISTS (SELECT 1 FROM contributions m
                       WHERE m.task_id = d.task_id AND m.contribution_type = 'question_answer' AND m.status = 'applied'
                         AND (m.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND m.agent_name = p_agent)))
    ))
    -- <<< 合格：提問這台答過
    -- >>> 合格：裁決任務
    -- 裁決任務（task_type＝adjudicate，target.contribution_id＝原貢獻）：這筆爭議已有 pending／verified 的裁決在等票就不再派（不分誰來領）；
    -- 原貢獻是他自己交的、或這台機器（p_ip_hash）對原貢獻投過票的不派給他（filterAdjudicateTasks；過渡期的舊雜湊那一半仍在程式裡）
    AND (d.task_type <> 'adjudicate' OR (
      NOT EXISTS (SELECT 1 FROM contributions j
                   WHERE j.contribution_type = 'adjudication' AND j.status IN ('pending', 'verified')
                     AND j.payload->>'contribution_id' = d.target->>'contribution_id')
      AND (p_ip_hash IS NULL OR (
        (p_agent IS NULL OR lower(d.target->>'contributor') IS DISTINCT FROM lower(p_agent))
        AND NOT EXISTS (SELECT 1 FROM contribution_votes v
                         WHERE v.contribution_id = uuid_or_null(d.target->>'contribution_id') AND v.verifier_ip_hash = p_ip_hash)
      ))
    ))
    -- <<< 合格：裁決任務
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

-- ------------------------------------------------------------
-- 6. refresh_dispatch_blocked：cool_until 取同一張工作卡的最晚查核（整支重寫；簽名不變，其餘與正式庫現行定義一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  -- >>> 查核階梯：手動任務（uuid）結案＝關閉（open 的才動）
  UPDATE contribution_tasks t SET status = 'closed', closed_at = now()
    FROM task_ladder_closed lc
   WHERE lc.task_id = t.id::text AND t.status = 'open';
  -- <<< 查核階梯
  WITH saturated AS (
    SELECT c.task_id FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
    -- >>> 查核階梯：結案的 auto: 任務永久不派
    UNION SELECT lc.task_id FROM task_ladder_closed lc WHERE lc.task_id LIKE 'auto:%'
    -- <<< 查核階梯
  )
  , cool AS (
    -- 工作卡鍵（20261111100000）：同一張卡的查核一起算，冷卻取最晚的一筆（換號、換臂、手動任務與自動缺口都延續）
    SELECT tc.work_key, max(tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL) AS until
      FROM task_checks tc
    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL
      AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))
    GROUP BY tc.work_key
  )
  -- >>> 多人分組任務：逐人冷卻
  , st AS MATERIALIZED (SELECT * FROM roster_group_person_status())
  , gp AS (
    SELECT t.id::TEXT AS task_id, COALESCE(s.closed, FALSE) AS closed, s.cool_until AS until
      FROM contribution_tasks t
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.target->'people', '[]'::JSONB)) e
      LEFT JOIN st s ON s.cid = roster_group_check_task_id(e->>'key', e->>'action', e->>'politician_election_id')
     WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group'
  ), g AS (
    SELECT gp.task_id,
           CASE WHEN count(*) FILTER (WHERE NOT gp.closed) > 0
                 AND count(*) FILTER (WHERE NOT gp.closed AND NOT COALESCE(gp.until > now(), FALSE)) = 0
                THEN min(gp.until) FILTER (WHERE NOT gp.closed) END AS until
      FROM gp GROUP BY gp.task_id
  )
  -- <<< 多人分組任務
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id) ELSE d.blocked END AS blocked,
           CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END AS until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.work_key = COALESCE(d.work_key, 'task:' || d.task_id) LEFT JOIN g ON g.task_id = d.task_id
     WHERE d.task_id NOT LIKE 'verify:%'
  )
  UPDATE task_dispatches d
     SET blocked = x.blocked, cool_until = x.until, cooling = COALESCE(x.cooling, false)
    FROM x
   WHERE x.task_id = d.task_id
     AND (d.blocked, d.cool_until, d.cooling) IS DISTINCT FROM (x.blocked, x.until, COALESCE(x.cooling, false));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 7. 回填既有列（task_dispatches 暫停 queue_at 觸發器，做完自我檢查：任何一列的 queue_at 變了整支失敗）
-- ------------------------------------------------------------
DO $$
DECLARE v_moved INTEGER;
BEGIN
  LOCK TABLE task_dispatches IN SHARE ROW EXCLUSIVE MODE;
  CREATE TEMP TABLE _wk_before ON COMMIT DROP AS SELECT task_id, queue_at FROM task_dispatches;
  ALTER TABLE task_dispatches DISABLE TRIGGER trg_task_dispatches_queue_key;
  UPDATE task_dispatches SET work_key = task_work_key(task_id, target) WHERE work_key IS NULL;
  ALTER TABLE task_dispatches ENABLE TRIGGER trg_task_dispatches_queue_key;
  SELECT count(*) INTO v_moved FROM task_dispatches d JOIN _wk_before b ON b.task_id = d.task_id WHERE d.queue_at IS DISTINCT FROM b.queue_at;
  IF v_moved <> 0 THEN RAISE EXCEPTION 'work_key 回填動到了 % 列的 queue_at', v_moved; END IF;
END $$;

UPDATE task_checks SET work_key = COALESCE(task_work_key(task_id, NULL), 'task:' || task_id) WHERE work_key IS NULL;
UPDATE contribution_task_leases SET work_key = COALESCE(task_work_key(task_id, NULL), 'task:' || task_id) WHERE work_key IS NULL;

-- 階梯與冷卻改按卡累計後，讓 blocked／cool_until 立刻同步（結案的卡一次收；之後仍由 seed 每 10 分鐘呼叫）
SELECT refresh_dispatch_blocked();
