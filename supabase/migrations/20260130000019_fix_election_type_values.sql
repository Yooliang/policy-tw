-- ============================================================
-- 修正 politician_elections 中的 election_type 值
-- '總統' -> '總統副總統'
-- '立委' -> '立法委員'
-- ============================================================

-- 修正總統
UPDATE politician_elections
SET election_type = '總統副總統'
WHERE election_type = '總統';

-- 修正立委
UPDATE politician_elections
SET election_type = '立法委員'
WHERE election_type = '立委';

-- 同時修正 politicians 表
UPDATE politicians
SET election_type = '總統副總統'::election_type
WHERE election_type::text = '總統';

UPDATE politicians
SET election_type = '立法委員'::election_type
WHERE election_type::text = '立委';
