-- ============================================================
-- 修正總統副總統候選人的 position 欄位
-- 總統候選人: 侯友宜、賴清德、柯文哲
-- 副總統候選人: 趙少康、蕭美琴、吳欣盈
-- ============================================================

-- 更新 politicians 表
UPDATE politicians
SET position = '總統候選人'
WHERE name IN ('侯友宜', '賴清德', '柯文哲')
  AND election_type = '總統副總統';

UPDATE politicians
SET position = '副總統候選人'
WHERE name IN ('趙少康', '蕭美琴', '吳欣盈')
  AND election_type = '總統副總統';

-- 更新 politician_elections 表
UPDATE politician_elections
SET position = '總統候選人'
WHERE politician_id IN (
  SELECT id FROM politicians
  WHERE name IN ('侯友宜', '賴清德', '柯文哲')
    AND election_type = '總統副總統'
);

UPDATE politician_elections
SET position = '副總統候選人'
WHERE politician_id IN (
  SELECT id FROM politicians
  WHERE name IN ('趙少康', '蕭美琴', '吳欣盈')
    AND election_type = '總統副總統'
);
