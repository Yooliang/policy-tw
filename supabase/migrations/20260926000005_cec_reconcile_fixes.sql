-- cec 比對兩個修正（2026-09-26，跑 2022 整批同步的子代理抓到）
-- 1. 「查無此人」只判該縣市已同步到的：同步中途停下、漏掉某縣市時，不能把整縣市的人都當成查無此人開任務
-- 2. 排程：村里長一次呼叫跑不完（約 370 個單位），同一晚再補呼叫四次；24 小時內同步過的單位會直接跳過，所以會接著往下跑
--    （cec-sync 的 resume 也修了：next 指的單位本身不再被跳過）

CREATE OR REPLACE FUNCTION cec_reconcile_findings()
RETURNS TABLE (kind TEXT, election_id INTEGER, election_type TEXT, region TEXT, pe_id INTEGER, politician_id UUID, name TEXT, detail TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH synced AS (
    SELECT DISTINCT c.election_id, c.election_type FROM cec_candidates c
  ),
  ours AS (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type,
           COALESCE(r.region, p.region) AS region, r.sub_region, p.name, cec_name_norm(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN synced s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
     WHERE pe.candidate_status IN ('confirmed', 'registered', 'qualified', 'elected', 'defeated') OR pe.election_result IS NOT NULL
  )
  SELECT 'not_in_cec', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會 ' || o.election_id || ' ' || o.election_type || ' 全國名單查無同名者'
    FROM ours o
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c
                      WHERE c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn)
     -- 只判那個縣市已經同步到的：同步中斷漏掉的縣市不能被當成「整個縣市查無此人」（09-26 金門縣村里長）
     AND EXISTS (SELECT 1 FROM cec_candidates c3
                  WHERE c3.election_id = o.election_id AND c3.election_type = o.election_type AND c3.region = o.region)
  UNION ALL
  SELECT 'region_mismatch', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會名單上在 ' || string_agg(DISTINCT c.region || COALESCE(' ' || c.sub_region, ''), '、') || '，我們存的是 ' || COALESCE(o.region, '（空）')
    FROM ours o
    JOIN cec_candidates c ON c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c2
                      WHERE c2.election_id = o.election_id AND c2.election_type = o.election_type AND c2.name_norm = o.nn
                        AND c2.region = o.region)
   GROUP BY o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name
$$;

SELECT cron.unschedule('cec-sync-2022-village-rest') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cec-sync-2022-village-rest');
SELECT cron.schedule('cec-sync-2022-village-rest', '5,10,15,20 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := '{"election_id": 2022, "election_type": "村里長"}'::jsonb, timeout_milliseconds := 150000);
$$);
