-- ============================================================
-- 驗證派工的原子認領（2026-10-14）：同一個來源網段的並行 /next 不再領到同一筆待驗證。
--
-- 起因：同一台機器（同一網段雜湊）開兩個視窗跑協議，兩邊幾乎同時 GET /next，
-- 驗證池（contribution_verify_pool）的「15 分鐘內派給這個網段的不再派」要等 /next 寫完 verify_dispatches 才生效，
-- 而 /next 一輪要 2～9 秒，兩個請求都在對方寫入之前讀了池子，拿到同一筆；先投的那邊成功，另一邊查證做完才吃 409 already_voted。
-- 正式庫 log 10-13 03:10～10-14 03:10：同網段 60 秒內被派兩次以上的驗證 45 筆，四個網段（含驗證 VM 的匿名代號池）。
--
-- 做法：/next 不再無條件 upsert，改呼叫這支函式「認領」。
--   沒有列 → 插入、認領成功；有列但派出已超過 15 分鐘 → 蓋新時間、成功；15 分鐘內派過 → 不動、回 false，/next 換下一筆候選。
--   並行時第二個 INSERT 會等第一個交易提交，再對提交後的那一列判斷 WHERE（READ COMMITTED 的 ON CONFLICT DO UPDATE），所以只有一個成功。
-- 15 分鐘與驗證池的排除窗口同一個數字（20261011160000 的 contribution_verify_pool），改一邊要改兩邊。
-- 派工綁定（verify-handler 查 (貢獻, 網段) 7 天內有沒有列）不受影響：認領成功一樣寫同一列。
-- ============================================================
CREATE OR REPLACE FUNCTION verify_dispatch_claim(p_contribution_id UUID, p_ip_hash TEXT, p_agent_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    INSERT INTO verify_dispatches AS vd (contribution_id, ip_hash, agent_name, dispatched_at)
    VALUES (p_contribution_id, p_ip_hash, p_agent_name, now())
    ON CONFLICT (contribution_id, ip_hash) DO UPDATE
      SET agent_name = EXCLUDED.agent_name, dispatched_at = EXCLUDED.dispatched_at
      WHERE vd.dispatched_at <= now() - interval '15 minutes'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
COMMENT ON FUNCTION verify_dispatch_claim(UUID, TEXT, TEXT) IS
  '驗證派工的原子認領：15 分鐘內已派給同一網段的回 false（/next 換下一筆），否則寫 verify_dispatches 回 true。2026-10-14，同網段並行撞單。';
REVOKE ALL ON FUNCTION verify_dispatch_claim(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION verify_dispatch_claim(UUID, TEXT, TEXT) TO service_role;
