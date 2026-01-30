-- ============================================================
-- 新增立委轉戰縣市長到 2026 選舉
-- ============================================================

-- 蘇巧慧 - 新北市長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  'b8d91049-ee19-462a-9fd9-a8ecb7043265'::uuid,
  2026,
  '新北市長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '新北市' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 何欣純 - 台中市長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  '2ec01de6-2588-4fcf-9429-014c4b71bce4'::uuid,
  2026,
  '台中市長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '台中市' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 陳亭妃 - 台南市長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  '41ca213e-995e-4caf-a231-876ff9872a71'::uuid,
  2026,
  '台南市長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '台南市' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 賴瑞隆 - 高雄市長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  'b6d90c2a-723a-496c-9900-0d12a7677c90'::uuid,
  2026,
  '高雄市長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '高雄市' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 陳素月 - 彰化縣長 (彰化縣的陳素月)
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9'::uuid,
  2026,
  '彰化縣長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '彰化縣' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 謝衣鳯 - 彰化縣長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  'a4aa8e7d-5126-4388-9174-d37b7f313a77'::uuid,
  2026,
  '彰化縣長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '彰化縣' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 張嘉郡 - 雲林縣長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  '37fc6d18-12fe-48d2-b083-be12ee680c1e'::uuid,
  2026,
  '雲林縣長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '雲林縣' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 王美惠 - 嘉義市長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  '3bd74ec3-9aab-444e-abea-43bf217839ef'::uuid,
  2026,
  '嘉義市長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '嘉義市' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 蔡易餘 - 嘉義縣長
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  '4c35a2a2-cd38-42a0-b574-3eabd102456f'::uuid,
  2026,
  '嘉義縣長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '嘉義縣' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;

-- 傅崐萁 - 花蓮縣長 (傳聞中，先加入)
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id)
SELECT
  'eeffa35a-7b7b-471d-a3da-cbecf37637a9'::uuid,
  2026,
  '花蓮縣長候選人',
  '縣市長',
  r.id
FROM regions r WHERE r.region = '花蓮縣' AND r.sub_region IS NULL
ON CONFLICT (politician_id, election_id) DO UPDATE SET
  position = EXCLUDED.position,
  election_type = EXCLUDED.election_type,
  region_id = EXCLUDED.region_id;
