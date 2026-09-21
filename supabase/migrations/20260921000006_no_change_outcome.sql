-- no_change 的涵蓋面過載（使用者 2026-09-21，證據由 ballyhoo-4d 的子代理現場提供）：
-- 194 筆 no_change、橫跨 7 種任務型別，同一個型別承載四種不同主張：
--   1. 查了，資料本來就對／沒新進度         → 名副其實
--   2. 查了，公開資料就是沒有               → 設計本意（防死路無限重派）
--   3. 查了，來源拿不到、判不出來           → 什麼都沒確認，卻被記成「查過」
--   4. 查了，來源拿得到但證明不了這筆       → 該走 correction／removal
-- 3 和 4 是「我沒能確認」被記成「我確認了」。
--
-- legacy_audit 把它放大成會寫進資料、而且不可逆的錯：apply 的 no_change 分支不看 finding 內容，
-- 一律在 edit_history 蓋「已核對來源 <網域>」，而 legacy_audit 的派工條件是「沒有查核履歷」——
-- 蓋完章那筆政見就再也不會被派。現場實例：黃秀芳綠能稅那筆，代理打開中央社來源、發現報導
-- 根本沒涵蓋該政見，finding 自己寫「來源無效需後續補充」，卻走了會蓋章的那條路。
-- 還沒釀成災：edit_history 裡 field='audit' 目前 0 筆（這條線 2026-09-20 才上）。現在改來得及。
--
-- 這支 migration 做三件事：
--   1. task_checks 記下 outcome（三選一），apply 只有 confirmed 才蓋章（TS 那側）
--   2. unreachable 走短冷卻：「我拿不到來源」是該換一台機器再試，不是結案
--      （skill.md 自己寫過：同一個網址在一個代理回 403、在另一台回 200。roster 的
--       「查不到名單」早就是這樣處理的，見 roster_attempt_cooldown_days）
--   3. legacy_audit 的排除條件收窄：原本「任何 edit_history 列」把只改過一欄的政見也永久排除，
--      實測 98 筆是這樣消失的（多半是 policy_election_missing 只改了 election_id——
--      那次代理打開來源只為了判斷屆別，沒有核對整筆）。改成只認「audit 章」與「貢獻建立的（field='*'）」。

-- ------------------------------------------------------------
-- 1. task_checks 記 outcome
-- ------------------------------------------------------------
ALTER TABLE task_checks ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE task_checks DROP CONSTRAINT IF EXISTS task_checks_outcome_check;
ALTER TABLE task_checks ADD CONSTRAINT task_checks_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('confirmed', 'unreachable', 'not_found'));
COMMENT ON COLUMN task_checks.outcome IS
  'confirmed＝來源支持、資料無誤；unreachable＝拿不到來源內容，未能確認；not_found＝公開資料就是沒有。NULL 是 2026-09-21 之前的舊資料，一律不當成「已核對」';

-- ------------------------------------------------------------
-- 2. 拿不到來源的冷卻
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_unreachable_cooldown_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
COMMENT ON FUNCTION task_unreachable_cooldown_days IS
  '「我拿不到這個來源」之後多久可以再派給別人：要短到換得了人（代理多半固定時段跑，1 天常常撞回同一批），又長到不會同一輪重撞；跟「查過、確實沒有」的 14 天是兩回事';

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT * FROM contribution_auto_tasks_raw()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_dup()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_legacy()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_mismatch()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_policy_dup()
  ),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM t
  LEFT JOIN inflight f ON f.task_id = t.task_id
  LEFT JOIN task_dispatches d ON d.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻（有人回報過 no_change 並已落庫）：拿不到來源的那種只壓短時間，換一台機器可能就開得了
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (
          CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'
        )::INTERVAL
    )
    -- 底下在途 ≥5 筆：它缺的是票不是更多提交
    AND COALESCE(f.n, 0) < 5
    -- 有人回報「查了沒東西」還在等票：期間不派
    AND NOT EXISTS (
      SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = t.task_id
    )
    -- 以下三種是「對這個代理」的排除，沒帶身份就不做
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = t.task_id OR l.target_key = task_target_key(t.task_id, t.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = t.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY
    -- 一次性插隊：Jev 有高信心答案、而且還沒派過的，排最前（派過一次就跟大家一樣按最久沒派排）
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability()
          AND t.task_id IN ('auto:policy_election_missing:' || j.subject_id, 'auto:policy_election_mismatch:' || j.subject_id))
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      -- 早期匯入的政見：系統核過來源（支持或矛盾都算，矛盾更該先看）的排前面
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 最久沒派的優先；沒派過的算最久。這就是全序，不需要隨機（同時派給多人由 SQL 裡的認領排除擋）
    d.last_dispatched_at ASC NULLS FIRST,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工（含同名配對、早期匯入核對、屆別矛盾、政見重複清查）：合格判斷都在 LIMIT 之前；冷卻依 task_checks.outcome 分長短；排序＝（沒派過且系統有判定）一次性插隊 → 最久沒派 → task_id';

-- ------------------------------------------------------------
-- 3. legacy_audit：只有「蓋過 audit 章」或「本來就是貢獻建的」才算查核過
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:legacy_audit:' || pl.id, 'legacy_audit',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region, 'source_url', pl.source_url),
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
         ARRAY[pl.source_url], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL
    AND COALESCE(pl.source_url, '') <> ''
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
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_legacy IS
  '早期匯入、有來源、沒查核履歷的政見 → legacy_audit 任務；只有 no_change 且 outcome=confirmed 會蓋 audit 章讓它消失';
