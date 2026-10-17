-- 爭點驗證：驗證票票數超過「平均 × 標出倍數」改成針對爭點判斷、不收不確定
-- （維護者 2026-10-18，policy-ops docs/decisions/2026-10-18-超過2倍改爭點驗證.md；協議 1.96.0）
-- ============================================================
--
-- 「超過線」的定義只有一份：票數（agree＋disagree＋unsure 三個計數欄）> contribution_overvoted_flag_votes()
-- （基準 × queue_settings.overvoted_flag_multiplier），裁決（adjudication）型別不適用，狀態是 pending／disputed——
-- 與 console_queue_state().overvoted 完全同一個運算式（20261017020100）。這支 migration 不新增門檻、不新增設定欄：
-- 改倍數（queue_settings）或基準（vote_baseline）時，主控台「投太多輪」區、/next 的爭點資料、/report 的退回三處一起跟著變。
--
--   contribution_dispute_votes(id)    ：超過線回票數，沒超過（或不適用）回 NULL。/report 用它決定要不要擋 unsure
--   contribution_dispute_context(id)  ：超過線回 {votes, baseline, flag, prior:[…]}，沒超過回 NULL。/next 派出驗證票時附上
--
-- 不動驗證池（contribution_verify_pool）與任何計分函式：只多兩支唯讀函式，/next 派出之後對那一筆單筆呼叫一次。

CREATE OR REPLACE FUNCTION contribution_dispute_votes(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT (c.agree_count + c.disagree_count + c.unsure_count)::INTEGER
    FROM contributions c
   WHERE c.id = p_contribution_id
     AND c.status IN ('pending', 'disputed') AND c.contribution_type <> 'adjudication'
     AND c.agree_count + c.disagree_count + c.unsure_count > contribution_overvoted_flag_votes()
$$;
COMMENT ON FUNCTION contribution_dispute_votes IS
  '爭點驗證的判斷（2026-10-18）：等票或等裁決中、票數 > contribution_overvoted_flag_votes()（基準 × overvoted_flag_multiplier）的非裁決交件回票數，否則 NULL。與 console_queue_state().overvoted 同一個運算式；/report 用它擋 unsure。';

-- 前面每一票的結論與理由（照時間；理由截 300 字；最多 30 筆，超過取最近 30 筆）
CREATE OR REPLACE FUNCTION contribution_dispute_context(p_contribution_id UUID) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH d AS (
    SELECT contribution_dispute_votes(p_contribution_id) AS n
  ), p AS (
    SELECT v.verdict, v.agent_name, left(v.note, 300) AS note, v.evidence_url, v.created_at
      FROM contribution_votes v
     WHERE v.contribution_id = p_contribution_id AND (SELECT n FROM d) IS NOT NULL
     ORDER BY v.created_at DESC
     LIMIT 30
  )
  SELECT jsonb_build_object(
           'votes', d.n,
           'baseline', round(contribution_vote_baseline(), 2),
           'flag', round(contribution_overvoted_flag_votes(), 2),
           'shown', (SELECT count(*) FROM p),
           'prior', COALESCE((SELECT jsonb_agg(jsonb_build_object('verdict', p.verdict, 'agent', p.agent_name, 'note', p.note, 'evidence_url', p.evidence_url, 'at', p.created_at) ORDER BY p.created_at) FROM p), '[]'::JSONB))
    FROM d
   WHERE d.n IS NOT NULL
$$;
COMMENT ON FUNCTION contribution_dispute_context IS
  '爭點驗證（2026-10-18）：超過線（contribution_dispute_votes 非 NULL）才回 {votes, baseline, flag, shown, prior:[{verdict, agent, note, evidence_url, at}]}，否則 NULL。prior 照時間，note 截 300 字、最多最近 30 筆。/next 派出驗證票時附在 item.dispute。';

REVOKE ALL ON FUNCTION contribution_dispute_votes(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION contribution_dispute_context(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION contribution_dispute_votes(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION contribution_dispute_context(UUID) TO service_role;
