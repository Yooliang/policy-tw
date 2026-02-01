-- 暫時開放 ai_prompts 表的公開讀取權限（用於除錯）
-- 之後可以移除此 policy

-- 允許匿名用戶讀取 ai_prompts
CREATE POLICY "Public read access for debugging" ON ai_prompts
    FOR SELECT
    USING (true);

-- 授予 anon 角色 SELECT 權限
GRANT SELECT ON ai_prompts TO anon;
