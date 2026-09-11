-- ============================================================
-- 2026 重複政治人物清理（由 scripts/dedupe-2026-dryrun.mjs 於 2026-09-11T08:13:34.888Z 產生）
-- 計畫說明見 .dedupe-check/dryrun.md。
--
-- 執行前提：
--   1. migration 20260911000001~3 已套（politician_keys 存在；PE 唯一索引已建）
--   2. 先確認沒有人正在讀這些 id（前端 IndexedDB 快取會晚一點才換）
--   3. 整段在一個 transaction 內；任何 assert 失敗會 RAISE 直接中止
--   4. 最後一行是 ROLLBACK：先跑一次看 NOTICE 全部通過，再把 ROLLBACK 改成 COMMIT 跑第二次
--   5. 跑完用另一條連線重查：SELECT name, COUNT(*) FROM politicians WHERE name IN (...) GROUP BY 1;
-- 期望：刪 25 位、搬 2 筆參選紀錄、刪 25 筆同場重複參選紀錄、搬 6 筆政見
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok [%] = %', label, actual;
  RETURN 'ok';
END;
$$;

-- 事前總量
SELECT pg_temp.assert_count('politicians total', (SELECT COUNT(*) FROM politicians), 15856);
SELECT pg_temp.assert_count('politician_elections total', (SELECT COUNT(*) FROM politician_elections), 16078);
SELECT pg_temp.assert_count('policies total', (SELECT COUNT(*) FROM policies), 293);

-- ---------- 吳秀華|台東縣|縣市長：保留 9f81d161-51ad-43ad-bd4b-d1c5747257ea，刪 1 筆 ----------
SELECT pg_temp.assert_count('politicians 吳秀華|台東縣|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('9f81d161-51ad-43ad-bd4b-d1c5747257ea', '91f81822-02c9-4a70-a9b0-811b6536034c')), 2);
UPDATE politician_elections SET politician_id = '9f81d161-51ad-43ad-bd4b-d1c5747257ea' WHERE id IN (35072);
SELECT pg_temp.assert_count('moved PE 吳秀華|台東縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id = '9f81d161-51ad-43ad-bd4b-d1c5747257ea' AND id IN (35072)), 1);
DELETE FROM politician_elections WHERE id IN (35025);
UPDATE ai_prompts SET politician_id = '9f81d161-51ad-43ad-bd4b-d1c5747257ea' WHERE politician_id IN ('91f81822-02c9-4a70-a9b0-811b6536034c');
SELECT pg_temp.assert_count('no PE left 吳秀華|台東縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('91f81822-02c9-4a70-a9b0-811b6536034c')), 0);
SELECT pg_temp.assert_count('no policies left 吳秀華|台東縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('91f81822-02c9-4a70-a9b0-811b6536034c')), 0);
DELETE FROM politicians WHERE id IN ('91f81822-02c9-4a70-a9b0-811b6536034c');

-- ---------- 吳宗憲|宜蘭縣|縣市長：保留 5534465f-6c68-4d03-ad0b-223b2b97a31e，刪 3 筆 ----------
SELECT pg_temp.assert_count('politicians 吳宗憲|宜蘭縣|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('5534465f-6c68-4d03-ad0b-223b2b97a31e', '3579e97f-2898-45d1-8c38-7f8fccb0b696', '97db7946-062e-4110-a982-824b3355624e', 'e9dc5e78-ea12-4b07-a407-1f13bc4d8f33')), 4);
DELETE FROM politician_elections WHERE id IN (35383, 35388, 35392);
UPDATE ai_prompts SET politician_id = '5534465f-6c68-4d03-ad0b-223b2b97a31e' WHERE politician_id IN ('3579e97f-2898-45d1-8c38-7f8fccb0b696', '97db7946-062e-4110-a982-824b3355624e', 'e9dc5e78-ea12-4b07-a407-1f13bc4d8f33');
SELECT pg_temp.assert_count('no PE left 吳宗憲|宜蘭縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('3579e97f-2898-45d1-8c38-7f8fccb0b696', '97db7946-062e-4110-a982-824b3355624e', 'e9dc5e78-ea12-4b07-a407-1f13bc4d8f33')), 0);
SELECT pg_temp.assert_count('no policies left 吳宗憲|宜蘭縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('3579e97f-2898-45d1-8c38-7f8fccb0b696', '97db7946-062e-4110-a982-824b3355624e', 'e9dc5e78-ea12-4b07-a407-1f13bc4d8f33')), 0);
DELETE FROM politicians WHERE id IN ('3579e97f-2898-45d1-8c38-7f8fccb0b696', '97db7946-062e-4110-a982-824b3355624e', 'e9dc5e78-ea12-4b07-a407-1f13bc4d8f33');

-- ---------- 張志豪|台北市|縣市議員：保留 e03da54d-d2ab-4b40-9a97-d0ee50422651，刪 1 筆 ----------
SELECT pg_temp.assert_count('politicians 張志豪|台北市|縣市議員', (SELECT COUNT(*) FROM politicians WHERE id IN ('e03da54d-d2ab-4b40-9a97-d0ee50422651', '0e18376a-2998-40f2-af95-676ca2a646f3')), 2);
UPDATE politician_elections SET candidate_status = 'confirmed' WHERE id = 31 AND candidate_status = 'rumored';
DELETE FROM politician_elections WHERE id IN (35387);
UPDATE ai_prompts SET politician_id = 'e03da54d-d2ab-4b40-9a97-d0ee50422651' WHERE politician_id IN ('0e18376a-2998-40f2-af95-676ca2a646f3');
SELECT pg_temp.assert_count('no PE left 張志豪|台北市|縣市議員', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('0e18376a-2998-40f2-af95-676ca2a646f3')), 0);
SELECT pg_temp.assert_count('no policies left 張志豪|台北市|縣市議員', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('0e18376a-2998-40f2-af95-676ca2a646f3')), 0);
DELETE FROM politicians WHERE id IN ('0e18376a-2998-40f2-af95-676ca2a646f3');

-- ---------- 許淑華|南投縣|縣市長：保留 46b9a63f-e5ec-4a7b-b9dc-3624235780e0，刪 4 筆 ----------
SELECT pg_temp.assert_count('politicians 許淑華|南投縣|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('46b9a63f-e5ec-4a7b-b9dc-3624235780e0', '4a1e22b0-3a21-4647-8c45-8e206d082ca7', '95f51dfd-a072-4857-8105-12d93b1bf9d0', '4ad2346a-0528-43e6-bae0-8cc8212b3647', '6bcb67b9-7c9c-4d82-912e-9f721f6dcd1b')), 5);
UPDATE politician_elections SET candidate_status = 'confirmed' WHERE id = 34999 AND candidate_status = 'likely';
DELETE FROM politician_elections WHERE id IN (35368, 35373, 35384, 35391);
UPDATE ai_prompts SET politician_id = '46b9a63f-e5ec-4a7b-b9dc-3624235780e0' WHERE politician_id IN ('4a1e22b0-3a21-4647-8c45-8e206d082ca7', '95f51dfd-a072-4857-8105-12d93b1bf9d0', '4ad2346a-0528-43e6-bae0-8cc8212b3647', '6bcb67b9-7c9c-4d82-912e-9f721f6dcd1b');
SELECT pg_temp.assert_count('no PE left 許淑華|南投縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('4a1e22b0-3a21-4647-8c45-8e206d082ca7', '95f51dfd-a072-4857-8105-12d93b1bf9d0', '4ad2346a-0528-43e6-bae0-8cc8212b3647', '6bcb67b9-7c9c-4d82-912e-9f721f6dcd1b')), 0);
SELECT pg_temp.assert_count('no policies left 許淑華|南投縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('4a1e22b0-3a21-4647-8c45-8e206d082ca7', '95f51dfd-a072-4857-8105-12d93b1bf9d0', '4ad2346a-0528-43e6-bae0-8cc8212b3647', '6bcb67b9-7c9c-4d82-912e-9f721f6dcd1b')), 0);
DELETE FROM politicians WHERE id IN ('4a1e22b0-3a21-4647-8c45-8e206d082ca7', '95f51dfd-a072-4857-8105-12d93b1bf9d0', '4ad2346a-0528-43e6-bae0-8cc8212b3647', '6bcb67b9-7c9c-4d82-912e-9f721f6dcd1b');

-- ---------- 陳素月|彰化縣|縣市長：保留 bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9，刪 8 筆 ----------
SELECT pg_temp.assert_count('politicians 陳素月|彰化縣|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9', '2d6e5aca-235f-478d-969d-644e69456540', 'c1146719-009d-41ed-a288-ddd86530e158', 'ca6f721f-054a-4eb9-8eff-a04bfad31618', '14c94485-63a7-4a9b-97e8-333e99113996', '9d690d37-fb4f-4540-a266-d2f5d805c39c', 'd96c4288-14eb-4292-8356-ed1d52c83a40', '40e9dff1-5298-407e-93b1-101f33ca245b', '10c7de3a-c11a-45ec-a924-104614c73031')), 9);
UPDATE politician_elections SET candidate_status = 'confirmed' WHERE id = 34727 AND candidate_status = 'rumored';
DELETE FROM politician_elections WHERE id IN (35363, 35366, 35370, 35377, 35382, 35390, 35393, 35394);
UPDATE policies SET politician_id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9' WHERE id IN ('4a0cc117-ac3d-4037-bb1c-606033e296ea', '9b990687-7323-4c75-8d02-c89a300c83cf', 'c745b28e-ba7f-4029-8b32-7969900966f3');
SELECT pg_temp.assert_count('moved policies 陳素月|彰化縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9' AND id IN ('4a0cc117-ac3d-4037-bb1c-606033e296ea', '9b990687-7323-4c75-8d02-c89a300c83cf', 'c745b28e-ba7f-4029-8b32-7969900966f3')), 3);
UPDATE ai_prompts SET politician_id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9' WHERE politician_id IN ('2d6e5aca-235f-478d-969d-644e69456540', 'c1146719-009d-41ed-a288-ddd86530e158', 'ca6f721f-054a-4eb9-8eff-a04bfad31618', '14c94485-63a7-4a9b-97e8-333e99113996', '9d690d37-fb4f-4540-a266-d2f5d805c39c', 'd96c4288-14eb-4292-8356-ed1d52c83a40', '40e9dff1-5298-407e-93b1-101f33ca245b', '10c7de3a-c11a-45ec-a924-104614c73031');
SELECT pg_temp.assert_count('no PE left 陳素月|彰化縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('2d6e5aca-235f-478d-969d-644e69456540', 'c1146719-009d-41ed-a288-ddd86530e158', 'ca6f721f-054a-4eb9-8eff-a04bfad31618', '14c94485-63a7-4a9b-97e8-333e99113996', '9d690d37-fb4f-4540-a266-d2f5d805c39c', 'd96c4288-14eb-4292-8356-ed1d52c83a40', '40e9dff1-5298-407e-93b1-101f33ca245b', '10c7de3a-c11a-45ec-a924-104614c73031')), 0);
SELECT pg_temp.assert_count('no policies left 陳素月|彰化縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('2d6e5aca-235f-478d-969d-644e69456540', 'c1146719-009d-41ed-a288-ddd86530e158', 'ca6f721f-054a-4eb9-8eff-a04bfad31618', '14c94485-63a7-4a9b-97e8-333e99113996', '9d690d37-fb4f-4540-a266-d2f5d805c39c', 'd96c4288-14eb-4292-8356-ed1d52c83a40', '40e9dff1-5298-407e-93b1-101f33ca245b', '10c7de3a-c11a-45ec-a924-104614c73031')), 0);
DELETE FROM politicians WHERE id IN ('2d6e5aca-235f-478d-969d-644e69456540', 'c1146719-009d-41ed-a288-ddd86530e158', 'ca6f721f-054a-4eb9-8eff-a04bfad31618', '14c94485-63a7-4a9b-97e8-333e99113996', '9d690d37-fb4f-4540-a266-d2f5d805c39c', 'd96c4288-14eb-4292-8356-ed1d52c83a40', '40e9dff1-5298-407e-93b1-101f33ca245b', '10c7de3a-c11a-45ec-a924-104614c73031');

-- ---------- 童子瑋|基隆市|縣市長：保留 fab097b2-2c5d-46e3-80f0-d469b84c6d33，刪 4 筆 ----------
SELECT pg_temp.assert_count('politicians 童子瑋|基隆市|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('fab097b2-2c5d-46e3-80f0-d469b84c6d33', '4853b6aa-a970-4871-848b-730e18cab0f2', 'bc635f7c-5d1a-434f-9024-b6154ebea641', '6abe6170-4b6c-4e37-8ed9-684e32dfdedc', 'd9658580-08a9-4bc4-a546-05bf4171eba0')), 5);
UPDATE politician_elections SET candidate_status = 'confirmed' WHERE id = 12 AND candidate_status = 'rumored';
DELETE FROM politician_elections WHERE id IN (35372, 35380, 35389, 35395);
UPDATE policies SET politician_id = 'fab097b2-2c5d-46e3-80f0-d469b84c6d33' WHERE id IN ('3f6307da-9ba0-4948-a5d5-401eb27182f3', '6be0ea15-55be-4f06-9ded-42c77795b04b', 'fdd19b91-273d-46c7-9b5d-11efea8bcc50');
SELECT pg_temp.assert_count('moved policies 童子瑋|基隆市|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id = 'fab097b2-2c5d-46e3-80f0-d469b84c6d33' AND id IN ('3f6307da-9ba0-4948-a5d5-401eb27182f3', '6be0ea15-55be-4f06-9ded-42c77795b04b', 'fdd19b91-273d-46c7-9b5d-11efea8bcc50')), 3);
UPDATE ai_prompts SET politician_id = 'fab097b2-2c5d-46e3-80f0-d469b84c6d33' WHERE politician_id IN ('4853b6aa-a970-4871-848b-730e18cab0f2', 'bc635f7c-5d1a-434f-9024-b6154ebea641', '6abe6170-4b6c-4e37-8ed9-684e32dfdedc', 'd9658580-08a9-4bc4-a546-05bf4171eba0');
SELECT pg_temp.assert_count('no PE left 童子瑋|基隆市|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('4853b6aa-a970-4871-848b-730e18cab0f2', 'bc635f7c-5d1a-434f-9024-b6154ebea641', '6abe6170-4b6c-4e37-8ed9-684e32dfdedc', 'd9658580-08a9-4bc4-a546-05bf4171eba0')), 0);
SELECT pg_temp.assert_count('no policies left 童子瑋|基隆市|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('4853b6aa-a970-4871-848b-730e18cab0f2', 'bc635f7c-5d1a-434f-9024-b6154ebea641', '6abe6170-4b6c-4e37-8ed9-684e32dfdedc', 'd9658580-08a9-4bc4-a546-05bf4171eba0')), 0);
DELETE FROM politicians WHERE id IN ('4853b6aa-a970-4871-848b-730e18cab0f2', 'bc635f7c-5d1a-434f-9024-b6154ebea641', '6abe6170-4b6c-4e37-8ed9-684e32dfdedc', 'd9658580-08a9-4bc4-a546-05bf4171eba0');

-- ---------- 蘇清泉|屏東縣|縣市長：保留 b6e1fec9-c02a-49c8-8290-b9d9ecda7a68，刪 4 筆 ----------
SELECT pg_temp.assert_count('politicians 蘇清泉|屏東縣|縣市長', (SELECT COUNT(*) FROM politicians WHERE id IN ('b6e1fec9-c02a-49c8-8290-b9d9ecda7a68', '2ae912ca-7b9e-44c4-8cf8-6196fb3860be', '3b62b019-0b69-4705-92ab-b3fb8d938a8c', '0f533a80-b5ad-4673-acd4-c5ec8d3e46f9', '5775220d-b36d-4c39-b146-c65011ced4c1')), 5);
UPDATE politician_elections SET politician_id = 'b6e1fec9-c02a-49c8-8290-b9d9ecda7a68' WHERE id IN (35218);
SELECT pg_temp.assert_count('moved PE 蘇清泉|屏東縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id = 'b6e1fec9-c02a-49c8-8290-b9d9ecda7a68' AND id IN (35218)), 1);
UPDATE politician_elections SET candidate_status = 'confirmed' WHERE id = 24 AND candidate_status = 'rumored';
DELETE FROM politician_elections WHERE id IN (35009, 35369, 35374, 35385);
UPDATE ai_prompts SET politician_id = 'b6e1fec9-c02a-49c8-8290-b9d9ecda7a68' WHERE politician_id IN ('2ae912ca-7b9e-44c4-8cf8-6196fb3860be', '3b62b019-0b69-4705-92ab-b3fb8d938a8c', '0f533a80-b5ad-4673-acd4-c5ec8d3e46f9', '5775220d-b36d-4c39-b146-c65011ced4c1');
SELECT pg_temp.assert_count('no PE left 蘇清泉|屏東縣|縣市長', (SELECT COUNT(*) FROM politician_elections WHERE politician_id IN ('2ae912ca-7b9e-44c4-8cf8-6196fb3860be', '3b62b019-0b69-4705-92ab-b3fb8d938a8c', '0f533a80-b5ad-4673-acd4-c5ec8d3e46f9', '5775220d-b36d-4c39-b146-c65011ced4c1')), 0);
SELECT pg_temp.assert_count('no policies left 蘇清泉|屏東縣|縣市長', (SELECT COUNT(*) FROM policies WHERE politician_id IN ('2ae912ca-7b9e-44c4-8cf8-6196fb3860be', '3b62b019-0b69-4705-92ab-b3fb8d938a8c', '0f533a80-b5ad-4673-acd4-c5ec8d3e46f9', '5775220d-b36d-4c39-b146-c65011ced4c1')), 0);
DELETE FROM politicians WHERE id IN ('2ae912ca-7b9e-44c4-8cf8-6196fb3860be', '3b62b019-0b69-4705-92ab-b3fb8d938a8c', '0f533a80-b5ad-4673-acd4-c5ec8d3e46f9', '5775220d-b36d-4c39-b146-c65011ced4c1');

-- 事後總量
SELECT pg_temp.assert_count('politicians after', (SELECT COUNT(*) FROM politicians), 15831);
SELECT pg_temp.assert_count('politician_elections after', (SELECT COUNT(*) FROM politician_elections), 16053);
SELECT pg_temp.assert_count('policies after', (SELECT COUNT(*) FROM policies), 293);

-- politician_keys 由 ON DELETE CASCADE 自動清掉被刪者的 key；保留者的 key 由觸發器在搬移 PE 時補上。

ROLLBACK; -- 主線審過後改成 COMMIT
