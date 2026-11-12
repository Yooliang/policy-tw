-- 一人一包 PR3（docs/PLAN-bundle-policies.md 第 2 節）：交件端旗標與在途計數。旗標預設關，線上行為不變。
-- 1. queue_settings 加 bundle_enabled（預設 false）、bundle_max_items（30）、bundle_min_items（2）
-- 2. contribution_queue_tasks 的「在途未額滿」改數 COUNT(DISTINCT coalesce(bundle_id, id))：一包算一筆
--    （整支以 20261111100000_work_key.sql 第 5 節為底，只換「合格：在途未額滿」那一段，其餘一字不差）

ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS bundle_enabled   BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bundle_max_items SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS bundle_min_items SMALLINT NOT NULL DEFAULT 2;
COMMENT ON COLUMN queue_settings.bundle_enabled IS '一人一包交件開關：false 時 /report contribute 的 bundle:true 被忽略（照舊逐條收，回應帶 bundle_ignored:true）';
COMMENT ON COLUMN queue_settings.bundle_max_items IS '一人一包：一包最多幾條（預設 30）';
COMMENT ON COLUMN queue_settings.bundle_min_items IS '一人一包：一包最少幾條（預設 2；併掉重複後少於此數回 400 bundle_too_small）';

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
    -- 工作卡鍵的租約：p_ip_hash 為 NULL（不知道是誰）時視為全部是別人的，也排除；驗證票的租約沒有 work_key（不會擋到這裡）
    AND NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND d.work_key IS NOT NULL AND l.work_key = d.work_key
    )
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
    -- 這個任務底下在等票（pending／verified／disputed）的貢獻到 5 筆（TASK_INFLIGHT_CAP）就先不再派（filterSaturatedTasks）；
    -- 一人一包（20261112030000）：同一包只算一筆（DISTINCT coalesce(bundle_id, id)），一包 30 條不會讓任務瞬間額滿
    AND (SELECT count(DISTINCT coalesce(f.bundle_id, f.id)) FROM contributions f
      WHERE f.task_id = d.task_id AND f.status IN ('pending', 'verified', 'disputed')) < 5
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
