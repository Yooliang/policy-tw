-- web_request_gap_sync 每輪 5~13 秒：其中約 5 秒是 web_request_close_satisfied 對每個候選請求呼叫 web_request_has_pledges，
-- 函式裡寫 pl.politician_id::TEXT = p_politician，uuid 欄位被轉成文字比，policies_visible_idx（politician_id）用不上，
-- planner 改走 idx_policies_election_id 掃整屆政見（每次呼叫約 1,200 個 buffer，實測 800 多次呼叫共 100 萬 buffer）。
-- 改成把輸入轉 uuid 再比（不是 uuid 格式的輸入就當查無，同原本文字比對的結果），走 policies_visible_idx。語意不變。
CREATE OR REPLACE FUNCTION web_request_has_pledges(p_politician TEXT, p_election TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  WITH e AS (SELECT COALESCE(election_id_or_null(NULLIF(p_election, '')), campaign_election_id()) AS id)
  SELECT EXISTS (
    SELECT 1 FROM policies pl, e
     WHERE pl.politician_id = CASE WHEN p_politician ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_politician::UUID END
       AND pl.removed_at IS NULL AND pl.election_id = e.id
       AND (e.id IS DISTINCT FROM campaign_election_id() OR is_campaign_pledge(pl.status::TEXT, pl.origin)))
$$;
COMMENT ON FUNCTION web_request_has_pledges IS '人物在那一屆（空＝當屆）現在有沒有承諾：未移除的政見，當屆要 is_campaign_pledge。網站請求併入缺口後自動結案的條件之一。2026-11-19 起人物 id 以 uuid 比對（走 policies_visible_idx），不再轉文字。';
