-- 清掉重複派工留下的重複貢獻（一次性資料修正）。
--
-- 2026-09-15：「處理掉那一些資料」，範圍拍板「連政見重疊一起清」。
-- 背景：#27 之前 /next 只依代號排除交過的任務，同一題被派給很多代理。逐筆看過內容後：
--   - 補政見類任務底下大部分是「一次交多條不同政見」，屬正常，不動
--   - 真的重複的只有下面 12 筆：
--       萬大捷運站街景那題公民提問已有 1 份答案上線，其餘 5 份回答退件
--       陳玉珍 2 筆與已上線政見逐字相同；李四川 5 筆是同批另一份政見的子項或重述
-- 退件理由寫進 review_notes，看得出是誰、為什麼退的。

CREATE TEMP TABLE dup_rejects (id uuid PRIMARY KEY, reason text NOT NULL);
INSERT INTO dup_rejects (id, reason) VALUES
  ('3f0a3f25-efb1-47e7-b2d5-27aead2be2d6'::uuid, '萬大：此題已有上線答案'),
  ('4e10e213-f8ce-46ca-b9e5-f61a1a05c9a2'::uuid, '萬大：此題已有上線答案'),
  ('04e83331-cdd9-4065-b451-e031558e43a5'::uuid, '萬大：此題已有上線答案'),
  ('ed0bd285-711e-4874-a846-eebefee9b12f'::uuid, '萬大：此題已有上線答案'),
  ('1fc624b8-dc4a-43c4-951d-93da63584aa0'::uuid, '萬大：此題已有上線答案'),
  ('68cf5ae3-93c1-4737-a43a-42697bc70e42'::uuid, '陳玉珍：與已上線政見重複'),
  ('d0918c6c-b4a0-4cbe-bd81-0423c0332009'::uuid, '陳玉珍：與已上線政見重複'),
  ('9108f0ed-5228-4967-b00e-40ffbdf07c03'::uuid, '李四川：與同批「推動醫療建設」重複'),
  ('8ccf45fa-4bbb-48af-85df-63b3410dd520'::uuid, '李四川：與同批「推動醫療建設」重複'),
  ('ec94e025-aaa1-4c1b-bcc0-9401177246c5'::uuid, '李四川：與同批「居住新五箭」重複'),
  ('9eadb857-d8fd-4884-acd4-9848a957499e'::uuid, '李四川：與同批「居住新五箭」重複'),
  ('5d07af53-597f-45e5-8e9e-d36a8ee9a11c'::uuid, '李四川：與同批「居住新五箭」重複');

-- 1. 退件（只動還沒定案的；萬一其間已經上線或被退，就不動它）
UPDATE contributions c
   SET status = 'rejected',
       review_notes = '重複貢獻（重複派工清理）：' || d.reason,
       reviewed_by = 'maintainer-cleanup-2026-09-15',
       reviewed_at = now()
  FROM dup_rejects d
 WHERE c.id = d.id
   AND c.status IN ('pending', 'verified', 'disputed');

-- 2. 審這些貢獻的裁決：還沒定案的一起退，對應的裁決任務關閉（原貢獻已退件，不需要再裁決）
UPDATE contributions
   SET status = 'rejected',
       review_notes = '被裁決的貢獻已因重複退件，裁決不再需要',
       reviewed_by = 'maintainer-cleanup-2026-09-15',
       reviewed_at = now()
 WHERE contribution_type = 'adjudication'
   AND status IN ('pending', 'verified', 'disputed')
   AND payload->>'contribution_id' IN (SELECT id::text FROM dup_rejects);

UPDATE contribution_tasks
   SET status = 'closed', closed_at = now()
 WHERE status = 'open'
   AND task_type = 'adjudicate'
   AND target->>'contribution_id' IN (SELECT id::text FROM dup_rejects);

DROP TABLE dup_rejects;
