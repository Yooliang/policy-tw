-- ============================================================
-- 新增總統副總統和立法委員到 election_type enum
-- ============================================================

-- 新增 enum 值
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '總統副總統';
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '立法委員';
