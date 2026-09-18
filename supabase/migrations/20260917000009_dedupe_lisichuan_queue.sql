-- 手動整併李四川底下堆積的待驗證政見（2026-09-17：「你需要手動整併一下李四川的資料了」）。
--
-- 怎麼堆起來的：`policy_missing`／李四川 是網站訪客請求的任務，優先級高、又卡在
-- pickManualTask 的前三名視窗；任務要等「有貢獻上線」才關，而那些貢獻卡在票數不夠，
-- 於是每個代理都抽到它、各自認真查、各自再交一筆。派工端的病灶已在 000008 修掉
-- （派過往後排、在途滿 3 筆不再派、任務現況會列出等票中的提交），這一支只清現場。
--
-- 判準：只退「與已上線內容重複」或「同一件事重複提交」，一件事至少留一筆。
-- 留下的一律是票數較多、或先提交的那一筆；退件理由寫清楚指向誰，代理看得懂為什麼。

-- A. 醫療那包：這四件事早就各自上線了（興建蘆洲醫院／加速板橋醫療園區／興建淡海
--    新市鎮醫院／協助恩主公醫院擴建），這 5 筆都是同一批事實再交一次。
UPDATE contributions SET
  status = 'rejected',
  review_notes = '與已上線政見重複：蘆洲醫院、板橋醫療園區、淡海新市鎮醫院、恩主公醫院擴建都已在站上（人物頁可查）。同一件事不需要再交一次。',
  reviewed_by = 'maintainer',
  reviewed_at = NOW()
WHERE id IN (
  'd05cd6dd-0af3-499b-8634-de1b02cb01cf',  -- Meshyai 合併版
  'd2c82690-349c-4c4c-a1bf-92ead5b1c3f8',  -- a-zhen 合併版
  '8683266b-8c1a-4baf-9cd5-60b3bc3a23f3',  -- a-zhen 蘆洲
  '103f3663-0e1b-47aa-9126-0d8dbe208e49',  -- a-zhen 淡海
  '9ab7c470-269a-4747-92b4-8865b6833e0c'   -- a-zhen 板橋
) AND status = 'pending';

-- B. 「居住新五箭」交了三次。留最早、已有一票的 b2574a56（a-zhen 09-14），
--    另外兩筆退件並指名該去投哪一筆。
UPDATE contributions SET
  status = 'rejected',
  review_notes = '重複提交：「居住新五箭」已有人提交（b2574a56，a-zhen 09-14，已有 1 票）。同一件事請改去投那一筆的票，不要再交一份。',
  reviewed_by = 'maintainer',
  reviewed_at = NOW()
WHERE id IN (
  '696205d9-2ba3-4921-9de3-51d5868a7376',  -- antigravity 09-16
  '3f13d367-aee4-468d-b7c9-40560450eb57'   -- pi/deepseek 09-17
) AND status = 'pending';

-- C. 運動幣與巨蛋：站上的體例是一件事一筆（既有的「興建蘆洲醫院」「加速板橋醫療園區」
--    都是拆開的），所以留兩筆細項（6ab5f28e 運動幣、3191853c 巨蛋），退掉把兩件事
--    包在一起的那筆。
UPDATE contributions SET
  status = 'rejected',
  review_notes = '與同批重複：運動幣（6ab5f28e）與巨蛋（3191853c）已各自有一筆在等票。站上體例是一件事一筆，這筆把兩件事包在一起，請改投那兩筆。',
  reviewed_by = 'maintainer',
  reviewed_at = NOW()
WHERE id = '9b412bc7-c3cd-48d3-bfe0-ac7ea2a39842' AND status = 'pending';

-- 收尾自檢：李四川底下應該只剩 13 筆待驗證（原 21 − 8）
DO $$
DECLARE v_left INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_left FROM contributions
  WHERE contribution_type = 'policy' AND status = 'pending'
    AND payload->>'politician_id' = '98b8b1ff-d085-4597-8384-a02461f773f6';
  RAISE NOTICE '李四川底下還在等票的政見：% 筆', v_left;
END $$;
