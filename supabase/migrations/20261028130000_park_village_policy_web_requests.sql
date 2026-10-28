-- 網站請求裡「村里長／鄉鎮市民代表 × 缺政見」在選舉公報還沒上架前停放（2026-10-28，維護者「1+2+3」）
--
-- 起因：開著的網站請求 397 件裡，村里長缺政見 121 件（103 件已有人回報查無）、鄉鎮市民代表缺政見 15 件（15 件都查無）；
-- 這兩類的官方來源只有中選會選舉公報，2026（115 年）的公報還沒上架（elections.bulletin_published_on 為空），候選人自己也多半沒有政見頁，
-- 代理查的全是白工，回的都是 no_change。自動缺口那邊早有規則「公報上架日才開」，但網站請求是手動任務、不受活動規則管，
-- 又每小時整點被拉回最前面，所以一直被重派、塞滿隊頭（跳過 skip 只是回隊尾，下個整點又被拉回來）。
--
-- 做法：把這類請求從派工臂 manual_visitor 的輸出拿掉（停放）——不派給代理、不被每小時整點拉回、不進佇列；
-- 任務本身仍是 open（網站上還看得到，提出的人沒有被關掉），elections.bulletin_published_on 一填，下一輪 seed 自動放出來。
--   · 範圍：source='web_request'、task_type='policy_missing'、目標人物有「選舉日還沒到、公報還沒上架、職位是村里長或鄉鎮市民代表」的參選紀錄
--   · 不碰：縣市長、議員、鄉鎮市長等有官方或候選人自己政見來源的；缺人物資料（profile_gap）；公民提問；已過去的屆別（2022、2024）
--   · 日本站（policy_jp）不動
-- 要恢復：把函式 web_request_parked 改成永遠回 false（或填公報上架日）。

CREATE OR REPLACE FUNCTION web_request_parked(p_task_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contribution_tasks t
      JOIN politician_elections pe ON pe.politician_id = uuid_or_null(t.target->>'politician_id')
      JOIN elections e ON e.id = pe.election_id
     WHERE t.id = p_task_id
       AND t.source = 'web_request' AND t.task_type = 'policy_missing'
       AND pe.election_type IN ('村里長', '鄉鎮市民代表')
       AND e.election_date >= CURRENT_DATE
       AND e.bulletin_published_on IS NULL
  )
$$;
COMMENT ON FUNCTION web_request_parked IS '網站請求是否停放（2026-10-28）：缺政見且目標人物是還沒投票、選舉公報還沒上架的村里長／鄉鎮市民代表候選人。停放的請求不進派工臂 manual_visitor、不被每小時整點拉回；公報上架日（elections.bulletin_published_on）一填就自動放出來。';

-- 臂本體：同 20261008165000，多一條「停放的網站請求不出現」
CREATE OR REPLACE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN, p_id UUID DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT t.id::TEXT, t.task_type,
         jsonb_strip_nulls(jsonb_build_object(
           'title', t.title, 'region', t.region,
           'stance_up', CASE WHEN t.task_type = 'question'
                             THEN COALESCE((SELECT q.stance_up FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0) END)) || t.target,
         COALESCE(NULLIF(t.description, ''), t.title), t.hint_sources, t.reward, t.region
    FROM contribution_tasks t
   WHERE t.status = 'open' AND manual_task_is_visitor(t.source, t.task_type) = p_visitor
     AND (p_id IS NULL OR t.id = p_id)
     -- >>> 停放（20261028130000）：村里長／鄉鎮市民代表缺政見、公報還沒上架
     AND NOT web_request_parked(t.id)
     -- <<< 停放
     AND NOT (t.task_type = 'question' AND t.target->>'question_id' IS NOT NULL
              AND COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0)
                  + (SELECT count(*) FROM contributions c
                      WHERE c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified')
                        AND c.task_id IN (SELECT t2.id::TEXT FROM contribution_tasks t2 WHERE t2.task_type = 'question' AND t2.target->>'question_id' = t.target->>'question_id'))
                  >= question_answer_cap())
$$;
COMMENT ON FUNCTION contribution_auto_tasks_manual IS
  '派工臂 manual_visitor（p_visitor＝true：網站請求與公民提問）／manual_open（false：維護者建、裁決、外部提議…）：contribution_tasks 裡 open 的任務。task_id＝任務 id（uuid 文字）。'
  '2026-10-28 起停放中的網站請求（web_request_parked）不出現；target 在原 target 之外補 title、region 與公民提問的 stance_up；已收滿答案的公民提問不出現。';

-- 已經在佇列裡的停放請求：收回派工列（之後 seed 也會收，這裡一次到位）
DELETE FROM task_dispatches d
 WHERE d.task_id NOT LIKE 'verify:%' AND d.task_id NOT LIKE 'auto:%'
   AND uuid_or_null(d.task_id) IS NOT NULL AND web_request_parked(uuid_or_null(d.task_id));

NOTIFY pgrst, 'reload schema';
