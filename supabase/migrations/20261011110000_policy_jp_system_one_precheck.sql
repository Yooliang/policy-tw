-- 日本站的系統票（Jev 核對提交者附的出典）：投票端 jp-system-one?action=precheck 的候選清單與排程
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-arms-parity.md「另外要補的：系統票」；維護者 10-11 在討論串選「系統票先做」（排在第 2 步三支臂前面）。
--
-- 日本站的「收票端」早就在（20261009130000）：policy_jp.jev_decisions、contribution_system_vote()（source_support ≥ 0.95 的最新一筆）、
-- contribution_effective_agree()（supported 目標 −1、not_supported +1）、jp-next 把它附在 item.current.system_vote。缺的只是投票的那一端，
-- 所以這支 migration 只加兩樣：
--   1. policy_jp.system_one_precheck_candidates(p_limit)：照正見 system_one_precheck_candidates（20261006141500）——pending、有出典、
--      型別合格、Jev 真的判過就不再問、只有「抓不到」的紀錄滿 24 小時可重抓（最多三次，排在沒判過的後面）。
--      與正見不同（登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY）：
--        ・型別只收 jp-system-one 組得出宣稱（claim）的三種：candidacy、politician、policy（policy_jp.system_one_precheck_types()）。
--          system_vote_eligible（複本，不動）還收 correction 等；correction 的宣稱形狀日本站還沒定，先不投（沒有系統票＝目標照表）。
--        ・正見的 system_vote_cec_only（只由中選會名單核對投票的型別）日本站沒有，不搬。
--        ・「抓不到」的模型名是 policy-jp/fetch-only-00000000（正見 policy-tw/fetch-only-00000000），兩站的紀錄分得開。
--   2. pg_cron policy-jp-system-one-precheck-10min：每 10 分鐘打 jp-system-one?action=precheck&limit=60（同正見 system-one-precheck-10min 的頻率與上限，
--      錯開分鐘：正見 3,13,…、日本 7,17,…）。端點不帶金鑰、靠成本上限守（10 分鐘內 policy_jp.jev_decisions 已判滿 limit 就不判），同正見。
--
-- 計分規則一個字不動：系統票照舊只把目標 3 降成 2，candidacy 仍要兩個不同網段（contribution_needs_two_ips）。
-- 日本站每個網段只算最新一票、每票 1 分，所以參選交件：沒有系統票＝3 個網段、有 supported 系統票＝2 個網段。
-- 正見「中選會名冊逐位吻合」的例外（目標降到 1、免第二網段）日本站不搬：維護者 2026-10-11 在討論串選「要兩台」。
--
-- 守門：supabase/functions/_shared/policy-jp-system-one.test.ts（PGlite：候選清單的篩選與排序、fetch-only 重抓的 24 小時與三次上限、
-- 系統票寫進來後 contribution_apply_consensus 的目標變 2、仍要兩個網段）、jp/system-one.test.ts（宣稱與逐欄收斂）、policy-jp-dispatch-drift.test.ts（JP_ONLY 登記）。
-- 不碰 public、ditrust。冪等。

-- ------------------------------------------------------------
-- 1. 候選清單
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.system_one_precheck_types() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['candidacy', 'politician', 'policy']::TEXT[] $$;
COMMENT ON FUNCTION policy_jp.system_one_precheck_types IS
  'jp-system-one が出典を確かめて系統票を入れる交件型別（TS の JP_PRECHECK_TYPES と同じ。対齊は policy-jp-system-one.test.ts）。system_vote_eligible より狭い：宣稱の形が決まっている型だけ';

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
    AND NOT EXISTS (
      SELECT 1 FROM policy_jp.jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model NOT LIKE 'policy-jp/fetch-only%'
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
    -- 沒判過的優先，重抓的排後面
    (EXISTS (SELECT 1 FROM policy_jp.jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support')) ASC,
    c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION policy_jp.system_one_precheck_candidates IS
  '系統票の候選（正見 system_one_precheck_candidates の日本版）：pending、出典あり、型別が system_one_precheck_types()；Jev が実際に判定したものは二度と聞かない；'
  '「抓不到」（policy-jp/fetch-only）だけのものは 24 時間後に再取得（最多三次、未判定のものの後ろ）。jp-system-one?action=precheck が読む';

REVOKE EXECUTE ON FUNCTION policy_jp.system_one_precheck_candidates(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.system_one_precheck_candidates(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.system_one_precheck_types() TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2. 排程（沒有 pg_cron／pg_net 的環境略過）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL AND to_regnamespace('net') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-system-one-precheck-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-system-one-precheck-10min')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-system-one-precheck-10min', '7,17,27,37,47,57 * * * *',
      $c$SELECT net.http_post(
          url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/jp-system-one?action=precheck&limit=60',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := '{}'::jsonb,
          timeout_milliseconds := 55000
        );$c$)$q$;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 3. 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY policy_jp.system_one_precheck_types() LOOP
    IF NOT policy_jp.system_vote_eligible(t) THEN
      RAISE EXCEPTION 'system_one_precheck_types の % は system_vote_eligible にない（投じても数えられない）', t;
    END IF;
  END LOOP;
END
$$;
