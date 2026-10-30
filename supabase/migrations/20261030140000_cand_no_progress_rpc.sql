-- 號次進度彙總（公開唯讀）：給工作機的小畫面每分鐘讀。只回彙總數字，不回人名、IP、代號。
-- 單筆帶號次 candidacy 與整批 cand_numbers 兩種交件都算進交件／待驗證／已驗證／退件；batch_* 另外單獨列整批那組。
-- 「今天」用台北日期。
CREATE OR REPLACE FUNCTION public.cand_no_progress() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '8s' AS $$
  WITH t AS (SELECT (date_trunc('day', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei') AS d0),
  c AS (
    SELECT c.status, c.created_at, (c.contribution_type = 'cand_numbers') AS is_batch
      FROM contributions c
     WHERE (c.contribution_type = 'candidacy' AND c.payload ? 'cand_no') OR c.contribution_type = 'cand_numbers'
  )
  SELECT jsonb_build_object(
    'as_of', now(),
    'gap_tasks_in_queue', (SELECT count(*) FROM task_dispatches WHERE target->>'kind' = 'cand_no'),
    'gap_boosted', (SELECT count(*) FROM task_dispatches WHERE target->>'kind' = 'cand_no' AND boost_seconds > 0),
    'submitted_today', (SELECT count(*) FROM c, t WHERE c.created_at >= t.d0),
    'submitted_1h', (SELECT count(*) FROM c WHERE c.created_at >= now() - interval '1 hour'),
    'pending_now', (SELECT count(*) FROM c WHERE c.status = 'pending'),
    'verified_now', (SELECT count(*) FROM c WHERE c.status = 'verified'),
    'applied_total', (SELECT count(*) FROM c WHERE c.status = 'applied'),
    'rejected_today', (SELECT count(*) FROM c, t WHERE c.status = 'rejected' AND c.created_at >= t.d0),
    'candidacies_with_no', (SELECT count(*) FROM politician_elections WHERE election_id = 2026 AND cand_no IS NOT NULL),
    'filed_total', (SELECT count(*) FROM politician_elections WHERE election_id = 2026 AND candidacy_status IN ('filed', 'qualified', 'elected', 'not_elected')),
    'votes_1h', (SELECT count(*) FROM contribution_votes v JOIN contributions k ON k.id = v.contribution_id
                  WHERE ((k.contribution_type = 'candidacy' AND k.payload ? 'cand_no') OR k.contribution_type = 'cand_numbers')
                    AND v.created_at >= now() - interval '1 hour'),
    'batch_pending_now', (SELECT count(*) FROM c WHERE c.is_batch AND c.status = 'pending'),
    'batch_submitted_1h', (SELECT count(*) FROM c WHERE c.is_batch AND c.created_at >= now() - interval '1 hour')
  );
$$;
REVOKE ALL ON FUNCTION public.cand_no_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cand_no_progress() TO anon, authenticated;
COMMENT ON FUNCTION public.cand_no_progress IS '號次進度彙總（公開唯讀，只回數字）：單筆帶號次 candidacy＋整批 cand_numbers；給工作機小畫面每分鐘讀';
