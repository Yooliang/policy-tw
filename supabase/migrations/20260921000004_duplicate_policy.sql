-- 政見重複清查（使用者 2026-09-21）：同一個承諾被記成兩筆，上線之後沒有任何路徑找得回來。
--
-- 李四川的兩筆都更政見就是這樣並存的：
--   91dc2b3b「加速都市更新、改善危老建築與居住安全」（7/23，空泛，而且出處掛到醫療那篇）
--   46699563「發表『都更5夠力』：成立府級都更推動委員會、危險建築重建容積最高2倍」（8/19，具體）
--
-- 為什麼系統配不出這一對，所以這支任務的單位是「一個人」而不是「一對政見」：
--   這對真重複的 2-gram Jaccard = 0.021（共同詞只有「建築」）
--   淡海醫院 vs 恩主公醫院（不同承諾）= 0.026（共同詞只有「醫院」）
--   假配對分數比真重複高——門檻定在哪都是先送假的、後漏真的。pg_trgm 的 similarity 更低。
--   同人同類同屆的配對全站有 221 組，大多是醫療那種同主題不同承諾，派出去只是燒額度。
-- 中文的「同一個承諾換句話說」只有代理判得出來，所以系統負責排程、代理負責判斷：
-- 把該人整份政見清單一次交給他看。全站 480 筆政見、119 人有政見、≥2 筆的只有 82 人，
-- 最長一份 25 筆、中位數 3 筆——整份給他看比配對便宜，也比配對準。
--
-- 清單指紋（policy_list_fingerprint）＝這份清單的內容雜湊。查過就記進 policy_dupe_reviews，
-- 清單沒變就永遠不再派（不是 14 天冷卻——同一份清單 14 天後再問一次還是同一個答案）；
-- 新增、編輯或移除任何一筆政見，指紋就變、任務重新出現。

-- ------------------------------------------------------------
-- 1. 清單指紋
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_list_fingerprint(p_politician_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT substr(md5(COALESCE(string_agg(pl.id::TEXT || ':' || md5(pl.title || COALESCE(pl.description, '')), ',' ORDER BY pl.id), '')), 1, 8)
  FROM policies pl
  WHERE pl.politician_id = p_politician_id AND pl.removed_at IS NULL
$$;
COMMENT ON FUNCTION policy_list_fingerprint IS '一個人目前政見清單的內容指紋（id＋標題＋描述）；清單一變就變，用來決定重複清查要不要重派';

-- ------------------------------------------------------------
-- 2. 清查結論
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_dupe_reviews (
  politician_id UUID PRIMARY KEY REFERENCES politicians(id),
  fingerprint TEXT NOT NULL,
  agent_name TEXT,
  contribution_id UUID,
  note TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_dupe_reviews IS '政見重複清查的結論：這個人的這一份清單（fingerprint）已經有代理逐組比對過、回報沒有重複';
ALTER TABLE policy_dupe_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "policy_dupe_reviews public read" ON policy_dupe_reviews;
CREATE POLICY "policy_dupe_reviews public read" ON policy_dupe_reviews FOR SELECT USING (true);

-- ------------------------------------------------------------
-- 3. 任務
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_dup()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH ours AS (
    SELECT p.id, p.name, p.region, COUNT(pl.id) AS n, policy_list_fingerprint(p.id) AS fp
    FROM politicians p
    JOIN policies pl ON pl.politician_id = p.id AND pl.removed_at IS NULL
    WHERE p.merged_into IS NULL
    GROUP BY p.id, p.name, p.region
    HAVING COUNT(pl.id) >= 2
  )
  SELECT 'auto:duplicate_policy:' || o.id || ':' || o.fp, 'duplicate_policy',
         jsonb_build_object('politician_id', o.id, 'name', o.name, 'region', o.region, 'policies_count', o.n, 'fingerprint', o.fp),
         '「' || o.name || '」名下有 ' || o.n || ' 筆政見。請把 item.current.policies 整份看過一遍，找出「同一個承諾被記成兩筆」的組合。'
           || '判準：換句話說講同一件事＝重複；同一個主題但標的不同（不同醫院、不同路線、不同補助對象）＝不是重複，'
           || '一篇報導的「N 大政見」本來就該拆成 N 筆，那不是重複。空泛的一筆（「加速都市更新」）碰上具體的一筆'
           || '（「都更5夠力：府級委員會、危老容積2倍」）而且講的是同一件事，就是重複。'
           || '找到重複 → 保留具體、可查核的那筆，對空泛的那筆提 removal（target_table=policies、target_id＝要移除的那筆，'
           || 'reason 要寫「與 <保留的 policy_id> 是同一個承諾」並說明為什麼保留另一筆）；'
           || '若具體資訊只有要移除的那筆才有，先用 correction 把它補進保留的那筆，再提 removal。'
           || '沒有重複 → 用 no_change 帶這個 task_id 回報，note 要列出你實際比對過哪幾組（只寫「沒有重複」不算查過）。',
         ARRAY['item.current.policies 就是清單本身，不用另外查', '兩筆的 source_url：打開來看是不是同一場發表、同一個承諾', 'policy-tw.web.app/politician/<politician_id> 是這個人的頁面'],
         2, o.region
  FROM ours o
  WHERE NOT EXISTS (
    SELECT 1 FROM policy_dupe_reviews r WHERE r.politician_id = o.id AND r.fingerprint = o.fp
  )
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_policy_dup IS '有 2 筆以上政見、而且目前這份清單還沒人逐組比對過的人 → duplicate_policy 任務（重複提 removal、沒有提 no_change）';

-- ------------------------------------------------------------
-- 4. 併進派工（只多一條 UNION 臂，其餘與 20260920000009 相同）
-- ------------------------------------------------------------
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
    -- 冷卻（有人回報過 no_change 並已落庫）
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
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
  '自動任務派工（含同名配對、早期匯入核對、屆別矛盾、政見重複清查）：合格判斷都在 LIMIT 之前；排序＝（沒派過且系統有判定）一次性插隊 → 最久沒派 → task_id';
