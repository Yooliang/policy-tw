-- 政見頁／人物頁的按鈕請求，從公民提問搬回任務清單。
--
-- 2026-09-15 貼了 /community 上一排「待回答」：「鍾小平的基本資料不齊…」
-- 「「台南 400 首位女市長」這筆看起來不像政見…」等等，說：
--   「這些因該出現在 /ai-assistant?tab=tasks，我之前提出的講錯了」
--   「不用人填文字」「公民提問 > 任務清單 > 自動缺口」「轉任務 去重復」
--
-- 程式那一半（同一個 PR）：按鈕改回打 request-task、按一下就建任務；ask 端點只收民眾自己打字的提問。
-- 這支 migration 是資料那一半，一次性，不是會重複套用的規則：
--   1. 按鈕建出來、掛在公民提問上的任務：拿掉 target.question_id，標題與說明換成任務清單的寫法
--   2. 按鈕任務（web_request、非 question）priority 一律 2；公民提問維持 3
--   3. 同型別＋同目標的 open 按鈕任務只留最早那筆，其餘關閉（「台南 400 首位女市長」被建了兩次）
--   4. 那些提問從 citizen_questions 刪掉——任務說明已經帶著要做的事，
--      留著只會讓 /community 一直掛著一題永遠不會有人回答的「待回答」
--      （鍾小平那題的任務 09-14 就做完關掉了，提問卻還是待回答）
--
-- 認得出「按鈕建的」：citizen_questions.task_id 指到的任務 task_type 不是 question
-- （一般提問一律建 question 型別，見 ask/index.ts 改之前的 askTaskType）。

-- supabase db push 會把整支 migration 包在一個 transaction 裡，這裡不另寫 BEGIN／COMMIT。

-- 0. 要處理的提問：任務型別不是 question 的那幾題。有代理答過的不動（目前一筆都沒有，但不要默默刪掉答案）
CREATE TEMP TABLE button_questions AS
SELECT q.id AS question_id, q.task_id, t.task_type, t.status AS task_status
  FROM citizen_questions q
  JOIN contribution_tasks t ON t.id = q.task_id
 WHERE t.task_type <> 'question'
   AND q.answer_count = 0;

DO $$
DECLARE v_skipped int;
BEGIN
  SELECT COUNT(*) INTO v_skipped
    FROM citizen_questions q JOIN contribution_tasks t ON t.id = q.task_id
   WHERE t.task_type <> 'question' AND q.answer_count > 0;
  IF v_skipped > 0 THEN
    RAISE NOTICE '有 % 題按鈕提問已經有答案，保留在公民提問、不刪', v_skipped;
  END IF;
END $$;

-- 1. 任務改成任務清單的標題與說明（跟 _shared/request-task.ts 的 buildRequestTaskText 同一套句子）
UPDATE contribution_tasks t
   SET target = t.target - 'question_id',
       title = CASE t.task_type
         WHEN 'policy_validity' THEN '查證「' || COALESCE(p.title, '（見 target）') || '」是不是政見（網站訪客請求）'
         WHEN 'progress_stale'  THEN '追蹤政見「' || COALESCE(p.title, '（見 target）') || '」的進度（網站訪客請求）'
         WHEN 'profile_gap'     THEN '補「' || COALESCE(who.name, '這位政治人物') || '」的基本資料（網站訪客請求）'
         WHEN 'policy_missing'  THEN '補「' || COALESCE(who.name, '這位政治人物') || '」的政見（網站訪客請求）'
         ELSE t.title
       END,
       description = CASE t.task_type
         WHEN 'policy_validity' THEN '有人在網站上按了「這不是政見？」，覺得「' || COALESCE(who.name, '') || '」的「' || COALESCE(p.title, '') || '」不像政見（比較像個人表態、行程或活動紀錄）。請查證原始出處後三選一：整筆不該存在用 removal／分類或狀態標錯用 correction／其實是有效的承諾用 no_change 並在 note 說明查到什麼。'
         WHEN 'progress_stale'  THEN '有人在網站上按了「請 AI 追進度」。請查「' || COALESCE(who.name, '') || '」政見「' || COALESCE(p.title, '') || '」的最新執行狀況（施政報告、議會／立法院紀錄、新聞），用 policy_progress 型別回報，附日期與出處。'
         WHEN 'profile_gap'     THEN '有人在網站上按了「請 AI 幫忙查資料」。請補「' || COALESCE(who.name, '') || '」的出生年、現職、學歷、官方照片網址（只補查得到的），用 politician 型別提交。'
         WHEN 'policy_missing'  THEN '有人在網站上按了「請 AI 幫忙查政見」。請找「' || COALESCE(who.name, '') || '」任何有出處的具體政見：2026 選舉政見優先，找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬選舉並在 note 說明。'
         ELSE t.description
       END
  FROM button_questions b
  LEFT JOIN contribution_tasks t0 ON t0.id = b.task_id
  LEFT JOIN policies p ON p.id = (t0.target->>'policy_id')::uuid
  LEFT JOIN politicians who ON who.id = COALESCE((t0.target->>'politician_id')::uuid, p.politician_id)
 WHERE t.id = b.task_id;

-- 2. 派工順序：公民提問（3）> 任務清單（按鈕任務 2）> 自動缺口
UPDATE contribution_tasks
   SET priority = 2
 WHERE status = 'open'
   AND source = 'web_request'
   AND task_type <> 'question'
   AND priority <> 2;

-- 3. 去重：同型別＋同目標的 open 按鈕任務只留最早那筆
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY task_type, COALESCE(target->>'policy_id', target->>'politician_id')
           ORDER BY created_at ASC
         ) AS rn
    FROM contribution_tasks
   WHERE status = 'open'
     AND source = 'web_request'
     AND task_type IN ('policy_validity', 'progress_stale', 'profile_gap', 'policy_missing')
     AND COALESCE(target->>'policy_id', target->>'politician_id') IS NOT NULL
)
UPDATE contribution_tasks t
   SET status = 'closed', closed_at = now()
  FROM ranked r
 WHERE t.id = r.id AND r.rn > 1;

-- 4. 從公民提問拿掉（question_answers／question_stances 會跟著 CASCADE，前面已確認沒有答案）
DELETE FROM citizen_questions q
 USING button_questions b
 WHERE q.id = b.question_id;

DROP TABLE button_questions;
