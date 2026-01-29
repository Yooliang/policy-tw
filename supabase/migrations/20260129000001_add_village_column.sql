-- 新增村里欄位到 politicians 表
ALTER TABLE politicians ADD COLUMN IF NOT EXISTS village TEXT;

-- 為村里欄位加上註解
COMMENT ON COLUMN politicians.village IS '村里名稱（用於村里長選舉）';
