-- 守門退回紀錄（2026-09-24，leatherback 經工頭轉：靠拒絕生效的機制要記拒絕了幾次，否則跟從未生效分不出來）
--
-- 投票的五道守門（note_repeated／note_copied／note_too_thin／cec_count_required／cec_count_mismatch）退回時寫一列：
-- 時間、哪一道、哪個端點、哪一筆貢獻、來源 IP 雜湊。不存備註或 payload 內容。
-- 答得出三件事：守門有沒有在擋（次數）、會不會擋到誠實的代理（被擋後同一 IP 有沒有補好再投成功）、行為有沒有改善（擋下率走勢）。
-- 系統核證據的 same_source／no_subject 本來就記在 contribution_votes.evidence_verdict，不重複記。

CREATE TABLE IF NOT EXISTS gate_rejections (
  id               BIGSERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  gate             TEXT NOT NULL,
  endpoint         TEXT,
  contribution_id  UUID,
  ip_hash          TEXT
);
CREATE INDEX IF NOT EXISTS gate_rejections_at_idx ON gate_rejections (at DESC);
COMMENT ON TABLE gate_rejections IS '投票守門的退回紀錄（不含內容）：看守門有沒有在擋、被擋的有沒有補好再送';
ALTER TABLE gate_rejections ENABLE ROW LEVEL SECURITY;

-- 公開的彙總（不含 IP）：每天每道守門擋了幾次、其中幾次後來同一來源在 1 小時內補好投成
CREATE OR REPLACE FUNCTION gate_rejection_summary(p_days INTEGER DEFAULT 7)
RETURNS TABLE (day DATE, gate TEXT, rejected BIGINT, recovered_1h BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (g.at AT TIME ZONE 'Asia/Taipei')::DATE, g.gate, COUNT(*),
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM contribution_votes v
            WHERE v.contribution_id = g.contribution_id AND v.verifier_ip_hash = g.ip_hash
              AND v.created_at BETWEEN g.at AND g.at + INTERVAL '1 hour'))
    FROM gate_rejections g
   WHERE g.at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 90))
   GROUP BY 1, 2
   ORDER BY 1 DESC, 2
$$;
GRANT EXECUTE ON FUNCTION gate_rejection_summary(INTEGER) TO anon, authenticated;

-- 保留 180 天
SELECT cron.unschedule('gate-rejections-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gate-rejections-purge');
SELECT cron.schedule('gate-rejections-purge', '40 19 * * *', $$DELETE FROM gate_rejections WHERE at < now() - INTERVAL '180 days';$$);
