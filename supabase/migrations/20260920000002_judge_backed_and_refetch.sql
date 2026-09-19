-- 外部審查建議 7、9（2026-09-20）。
--
-- 7. 票的來歷：這張票的 evidence_url 是不是拿去給 system-one?action=judge 判過（同一個來源 IP、同一筆貢獻）——
--    是的話記 judge_backed=true。對帳看得出「有多少票其實是 Jev 投的」；之後若要「全 judge 票不能單獨通過」，這一欄是前提。
-- 9. 抓不到正文的棄權票（model 以 policy-tw/fetch-only 開頭）不再是永久的：滿 24 小時可以重問，最多三次；
--    PDF／xls 抽字、附件跟連、JSON-LD 都是 09-19 陸續補上的，之前判過的都帶著死棄權。重問的排在沒判過的後面。

ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS judge_backed BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN contribution_votes.judge_backed IS 'evidence_url 曾由這個來源 IP 拿去 system-one judge 判過：這張票的判斷者是 Jev 不是代理';

CREATE OR REPLACE FUNCTION system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND system_vote_eligible(c.contribution_type)
    AND c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1
    -- 真的判過（Jev 有回答）就不再問；只有「抓不到」的紀錄時，滿 24 小時可重抓，最多三次
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model NOT LIKE 'policy-tw/fetch-only%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model LIKE 'policy-tw/fetch-only%' AND j.asked_at > now() - INTERVAL '24 hours'
    )
    AND (SELECT COUNT(*) FROM jev_decisions j
         WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
           AND j.model LIKE 'policy-tw/fetch-only%') < 3
  ORDER BY
    -- 沒判過的優先，重抓的排後面（跟新貢獻搶同一個 40 秒預算）
    (EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support')) ASC,
    c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION system_one_precheck_candidates IS
  '預判候選：pending、有來源、型別合格；Jev 真的判過的不再問；只有 fetch-only 棄權的滿 24 小時可重抓（最多三次，排在沒判過的後面）';
