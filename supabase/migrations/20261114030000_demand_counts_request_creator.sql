-- 需求加權：網站請求的「第一個請求者」也算一個需求單位（2026-11-14，維護者裁示：不同人請求同一件都要算一次需求）
-- ============================================================
--
-- 現況（查 request-task／create-or-attach-task／work_card_attach）：同一個來源（IPv4 /24、IPv6 /64 的雜湊 ipHash）對同一張工作卡的 request 訊號
-- 由 work_card_signals 唯一鍵 (work_key, kind, actor) 擋，同人重複按只算一次；不同人請求同一件（卡上已有開著的任務）時回 already_queued
-- 並寫一筆新的 request 訊號（需求 +1 單位＝+2 天、上限 14 天）。唯一的缺口：**建立任務的第一個請求者沒有寫訊號**（只有第二個人起才算），
-- 所以 A 建立、B 再請求，需求只有 1 單位。
--
-- 這支：不改 TS、不動額度計算（若在建立時多寫一筆訊號，每日 20 次的額度會把建立者重複計算），改在需求公式補算——
--   work_card_demand_seconds 的單位數多加「這張卡上開著的網站請求任務的請求者，且他還沒有自己的 request 訊號」的人數。
--   A 建立 → 1 單位；B → 2；A 再按（寫自己的訊號）→ 不再補算、仍是 2；B 再按 → 仍是 2。
-- 重貼 work_card_demand_seconds、work_card_demand_refresh（以 20261112070000 為底，只差標記區塊；refresh 多一段把「只有建立者」的卡納入重算）。
-- 不升協議版號。

CREATE OR REPLACE FUNCTION work_card_demand_seconds(p_work_key TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM queue_settings WHERE id = 1),
  sig AS (
    SELECT count(*) FILTER (WHERE x.kind <> 'view') AS direct,
           count(*) FILTER (WHERE x.kind = 'view')  AS views
      FROM work_card_signals x, s
     WHERE x.work_key = p_work_key AND x.created_at > now() - make_interval(days => s.demand_signal_days)
  ),
  -- >>> 第一個請求者也算一個單位（20261114030000）：網站請求建立的手動任務（開著、source=web_request）當初沒寫 request 訊號，
  --     它的請求者（requester_ip_hash）還沒有自己的 request 訊號時補算一個單位；之後他再按（或別人按）走 work_card_signal_add，同一人不重複計
  creators AS (
    SELECT count(DISTINCT t.requester_ip_hash) AS n
      FROM task_dispatches d
      JOIN contribution_tasks t ON t.id::TEXT = d.task_id
      CROSS JOIN s
     WHERE d.work_key = p_work_key AND d.task_id NOT LIKE 'verify:%'
       AND t.source = 'web_request' AND t.status = 'open' AND COALESCE(t.requester_ip_hash, '') <> ''
       AND t.created_at > now() - make_interval(days => s.demand_signal_days)
       AND NOT EXISTS (SELECT 1 FROM work_card_signals x WHERE x.work_key = p_work_key AND x.kind = 'request' AND x.actor = t.requester_ip_hash
                          AND x.created_at > now() - make_interval(days => s.demand_signal_days))
  ),
  -- <<< 第一個請求者也算一個單位
  st AS (SELECT * FROM work_key_ladder_state(p_work_key)),
  card AS (SELECT COALESCE((SELECT c.no_output_dispatches FROM work_cards c WHERE c.work_key = p_work_key), 0) AS n)
  SELECT CASE
           WHEN p_work_key IS NULL THEN 0
           WHEN (SELECT st.closed OR COALESCE(st.check_cool_until > now(), FALSE) FROM st) THEN 0   -- 防線①：冷卻中、階梯已結案不疊
           WHEN card.n >= s.demand_halving_max THEN 0                                                -- 防線②：減半到上限視同 0
           ELSE floor(LEAST(s.demand_cap_seconds::NUMERIC,
                            (sig.direct + creators.n + GREATEST(0, sig.views / s.demand_view_unit - 1)) * s.demand_unit_seconds::NUMERIC)
                      * power(0.5::NUMERIC, card.n))::BIGINT
         END
    FROM s, sig, card, creators
$$;

CREATE OR REPLACE FUNCTION work_card_demand_refresh() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH keys AS (
    SELECT x.work_key FROM work_card_signals x
     WHERE x.created_at > now() - make_interval(days => (SELECT demand_signal_days FROM queue_settings WHERE id = 1))
    UNION
    SELECT c.work_key FROM work_cards c WHERE c.demand_seconds <> 0
    -- >>> 第一個請求者也算一個單位（20261114030000）：開著的網站請求任務所在的卡（只有建立者、還沒有任何訊號）也要算
    UNION
    SELECT d.work_key FROM task_dispatches d JOIN contribution_tasks t ON t.id::TEXT = d.task_id
     WHERE d.work_key IS NOT NULL AND t.source = 'web_request' AND t.status = 'open'
       AND t.created_at > now() - make_interval(days => (SELECT demand_signal_days FROM queue_settings WHERE id = 1))
    -- <<< 第一個請求者也算一個單位
  ), calc AS (
    SELECT k.work_key, work_card_demand_seconds(k.work_key) AS sec FROM keys k
  )
  INSERT INTO work_cards (work_key, demand_seconds)
  SELECT work_key, sec FROM calc
  ON CONFLICT (work_key) DO UPDATE SET demand_seconds = EXCLUDED.demand_seconds, updated_at = now()
   WHERE work_cards.demand_seconds IS DISTINCT FROM EXCLUDED.demand_seconds;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

NOTIFY pgrst, 'reload schema';
