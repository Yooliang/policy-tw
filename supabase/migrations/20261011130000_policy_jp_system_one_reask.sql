-- 日本站系統票：宣稱裡帶投票日的舊判定，candidacy 重問一次
-- ============================================================
--
-- 起因（日本站近三天任務提交檢視，2026-10-12 正式庫唯讀實測）：jp-system-one 上線後（20261011110000），candidacy 的宣稱
-- election 欄是「〇〇町長選挙（投票日 2026-12-20）」。出馬表明的報道多半只寫「任期満了に伴う〇〇町長選」、沒有投票日，
-- Jev 對 election 欄的確信度張在 0.47〜0.61，supported 的總確率取核心欄最小值，所以 45 件 candidacy 判定裡只有 2 件達到門檻 0.95；
-- 32 件 candidacy 是 supported、已有兩個網段同意（score 2），卻因系統票不算數而目標停在 3，從 10-10 晚上起沒有一件 candidacy 落庫。
--
-- 修法分兩半：
--   1. _shared/jp/system-one.ts 的 jpClaimOf 不再把投票日放進 election 欄（投票日本來就不是代理主張的，是庫從 election_id 引的），
--      問句補一句「投票日がなくても同じ団体・同じ職の今度の選挙なら confirmed、過去の選挙なら contradicted」。
--   2. 這支 migration：候選清單把「宣稱的 election 欄含『（投票日 』」的舊判定當作沒判過，讓 jp-system-one 用新的宣稱重問一次。
--      新判定的 state_hash 不同、照常寫一列；contribution_system_vote 取最新一筆，所以新判定一寫進來就取代舊的。
--      新宣稱不含投票日，不會再被這個條件放出來，所以每件最多重問一次。其他型別、fetch-only 的重抓規則一個字不動。
--
-- 計分規則不動（系統票只把目標 3 降成 2，candidacy 仍要兩個不同網段）。
-- 守門：policy-jp-system-one.test.ts（舊宣稱的判定重問一次、新宣稱的判定不再問）、jp/system-one.test.ts（宣稱不含投票日）、
-- policy-jp-dispatch-drift.test.ts（system_one_precheck_candidates 的 JP_ONLY 多登記這一支）。
-- 不碰 public、ditrust。冪等。

CREATE OR REPLACE FUNCTION policy_jp.system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM policy_jp.contributions c
  WHERE c.status = 'pending'
    AND policy_jp.system_vote_eligible(c.contribution_type)
    AND c.contribution_type = ANY (policy_jp.system_one_precheck_types())
    AND c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1
    -- 真的判過（Jev 有回答）就不再問；只有「抓不到」的紀錄時，滿 24 小時可重抓，最多三次
    -- 例外（20261011130000）：宣稱的 election 欄還帶投票日的舊判定不算判過（新宣稱不帶，所以最多重問一次）
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model NOT LIKE 'policy-jp/fetch-only%'
        AND COALESCE(j.state->'claim'->>'election', '') NOT LIKE '%（投票日 %'
    )
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model LIKE 'policy-jp/fetch-only%' AND j.asked_at > now() - INTERVAL '24 hours'
    )
    AND (SELECT COUNT(*) FROM policy_jp.jev_decisions j
         WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
           AND j.model LIKE 'policy-jp/fetch-only%') < 3
  ORDER BY
    -- 沒判過的優先，重抓、重問的排後面
    (EXISTS (SELECT 1 FROM policy_jp.jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support')) ASC,
    c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION policy_jp.system_one_precheck_candidates IS
  '系統票の候選（正見 system_one_precheck_candidates の日本版）：pending、出典あり、型別が system_one_precheck_types()；Jev が実際に判定したものは二度と聞かない'
  '（例外：宣稱の election に投票日が入っていた旧判定は一度だけ聞き直す、20261011130000）；'
  '「抓不到」（policy-jp/fetch-only）だけのものは 24 時間後に再取得（最多三次、未判定のものの後ろ）。jp-system-one?action=precheck が読む';

REVOKE EXECUTE ON FUNCTION policy_jp.system_one_precheck_candidates(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.system_one_precheck_candidates(INTEGER) TO service_role;
