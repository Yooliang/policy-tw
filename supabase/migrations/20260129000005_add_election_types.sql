-- 新增缺少的 election_type enum 值
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '總統';
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '立委';
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '直轄市長';
ALTER TYPE election_type ADD VALUE IF NOT EXISTS '直轄市議員';
