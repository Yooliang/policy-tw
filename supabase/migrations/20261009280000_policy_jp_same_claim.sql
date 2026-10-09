-- 同一件事只能有一筆：日本站試點（policy-tw #521；設計 policy-jp docs/PLAN-same-claim.md；裁決 docs/decisions/2026-10-09-同一件事只能有一筆日本站試點.md）
--
-- 登記表第 1 層的 SQL 那一半：policy_jp.same_claim_matches(型別, payload, 來源網段雜湊, 排除的貢獻 id)
--   → { type, existing:[在庫的列], pending:[審議中的提交] }；型別沒登記＝NULL。
--   TS 那一半在 supabase/functions/_shared/same-claims.ts（登記表、parseResolvedClaim、decideSameClaim）；
--   jp-report 交件當下用它擋（resolved_claim／409），jp-next 把它附在任務與驗證項的 item.current.same_claims。
--
-- 各型別「同一件事」的精確鍵（主線 10-09 裁定，#521 07:47 留言第 2 點）：
--   election         團體碼＋職位（head＝首長、assembly＝議會；國政＝election_type 本身）＋election_reason（空值＝regular）＋同一屆
--                    同一屆：regular＝兩個投票日落在同一列 term_expirations 的 [term_end−180, term_end+60]；
--                            任一方落在某一列的窗口內，兩方就要在同一個窗口（對稱）；兩方都不在任何窗口，才看兩個投票日差 ≤ 180 天。
--                            非 regular（出直し・補欠…）＝投票日相同。
--                    elections.id（投票日＋種類＋團體）不拿來判斷：日期抄錯一天就是另一個 id。
--   regional_stat    團體碼＋stat_key＋year
--   local_government 團體碼
-- 探查（任務還沒有 payload 時，jp-next 用任務本身的鍵查）：election 可以只給 lg_code＋office_kind＋term_end（任務 id 裡就有），
--   regional_stat 可以只給 lg_code（列出這個團體所有項目、所有年份），local_government 只給 lg_code。
-- 審議中＝pending／disputed／verified／apply_failed（通過了但還沒落庫的也算，不然會在落庫前再收一筆）。
-- your_network_voted：這個來源網段交過那一筆、或已經對它投過票（兩種都不能再投，交件時回 409 already_voted）。
--
-- 這支只讀，不寫任何表；只給 service_role（jp-next／jp-report 用 service_role 呼叫）。

-- 選舉種類 → 比對用的職位：首長、議會，國政直接用種類（衆院・參院各自一類）
CREATE OR REPLACE FUNCTION policy_jp.same_claim_office(p_election_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
    WHEN p_election_type IN ('governor', 'mayor', 'ward_mayor', 'town_mayor') THEN 'head'
    WHEN p_election_type IN ('pref_assembly', 'muni_assembly') THEN 'assembly'
    ELSE p_election_type
  END
$$;
COMMENT ON FUNCTION policy_jp.same_claim_office IS
  '選舉種類 → 同一件事比對用的職位（head／assembly；國政＝種類本身）。term_expirations.office_kind 同一套值';

-- 兩個投票日是不是同一屆（見檔頭）。p_ref 是「拿來比的那一筆」的投票日，可以是 NULL（探查：改用 p_term_end 當窗口）
CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_term(
  p_lg_code TEXT, p_office TEXT, p_reason TEXT, p_ref DATE, p_term_end DATE, p_other DATE
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_other IS NULL THEN RETURN FALSE; END IF;
  -- 探查：任務帶的任期満了日就是窗口
  IF p_ref IS NULL THEN
    RETURN p_term_end IS NOT NULL AND p_other BETWEEN p_term_end - 180 AND p_term_end + 60;
  END IF;
  IF COALESCE(p_reason, 'regular') <> 'regular' THEN
    RETURN p_other = p_ref;
  END IF;
  -- 任一方落在某一列任期満了的窗口內，兩方就要在同一個窗口（對稱：A 比 B 與 B 比 A 結果相同）
  IF p_lg_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM policy_jp.term_expirations te
     WHERE te.lg_code = p_lg_code AND te.office_kind = p_office
       AND (p_ref BETWEEN te.term_end - 180 AND te.term_end + 60 OR p_other BETWEEN te.term_end - 180 AND te.term_end + 60)
  ) THEN
    RETURN EXISTS (
      SELECT 1 FROM policy_jp.term_expirations te
       WHERE te.lg_code = p_lg_code AND te.office_kind = p_office
         AND p_ref BETWEEN te.term_end - 180 AND te.term_end + 60
         AND p_other BETWEEN te.term_end - 180 AND te.term_end + 60
    );
  END IF;
  RETURN abs(p_other - p_ref) <= 180;
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_same_term IS
  '選舉的「同一屆」：regular＝同一列任期満了的 [−180, +60] 天窗口（查不到就差 ≤ 180 天）、其他事由＝同一天；p_ref 為 NULL 時用 p_term_end 當窗口（任務探查）';

CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches(
  p_type TEXT, p_payload JSONB, p_ip_hash TEXT DEFAULT NULL, p_exclude UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := COALESCE(p_payload, '{}'::JSONB);
  v_lg TEXT := NULLIF(p->>'lg_code', '');
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
  v_office TEXT;
  v_reason TEXT;
  v_date DATE;
  v_term_end DATE;
  v_year INTEGER;
  v_stat TEXT := NULLIF(p->>'stat_key', '');
BEGIN
  IF p_type NOT IN ('election', 'regional_stat', 'local_government') THEN
    RETURN NULL;
  END IF;

  IF p_type = 'election' THEN
    v_office := COALESCE(NULLIF(p->>'office_kind', ''), policy_jp.same_claim_office(NULLIF(p->>'election_type', '')));
    -- 事由空值一律視為任期満了（主線 10-09 裁定 2）；探查也一樣，不然探查列出的出直し選舉，交件端會比不中而回 claim_mismatch
    v_reason := COALESCE(NULLIF(p->>'election_reason', ''), 'regular');
    v_date := policy_jp.date_or_null(p->>'election_date');
    v_term_end := policy_jp.date_or_null(p->>'term_end');
    -- 拿不到鍵（沒有職位、或既沒有投票日也沒有任期満了日）＝不猜
    IF v_office IS NULL OR (v_date IS NULL AND v_term_end IS NULL) THEN
      RETURN jsonb_build_object('type', p_type, 'existing', v_existing, 'pending', v_pending);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', e.id, 'name', e.name, 'election_date', e.election_date, 'notice_date', e.notice_date,
             'election_type', e.election_type, 'election_reason', e.election_reason, 'review_status', e.review_status,
             'summary', e.name || ' ' || e.election_date || CASE WHEN e.notice_date IS NOT NULL THEN '（告示 ' || e.notice_date || '）' ELSE '' END,
             'why', CASE WHEN v_date IS NULL THEN '同団体・同職位・この任期' ELSE '同団体・同職位・同事由・同任期' END)
             ORDER BY e.election_date), '[]'::JSONB)
      INTO v_existing
      FROM policy_jp.elections e
     WHERE e.lg_code IS NOT DISTINCT FROM v_lg
       AND policy_jp.same_claim_office(e.election_type) = v_office
       AND (v_reason IS NULL OR e.election_reason = v_reason)
       AND policy_jp.same_claim_same_term(v_lg, v_office, v_reason, v_date, v_term_end, e.election_date);
    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.created_at), '[]'::JSONB) INTO v_pending
      FROM (
        SELECT c.created_at, jsonb_build_object(
                 'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
                 'election_date', c.payload->>'election_date', 'election_type', c.payload->>'election_type',
                 'election_reason', c.payload->>'election_reason', 'notice_date', c.payload->>'notice_date',
                 'summary', COALESCE(c.payload->>'name', c.payload->>'election_type') || ' ' || COALESCE(c.payload->>'election_date', '?'),
                 'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
                 'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
                   OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
          FROM policy_jp.contributions c
         WHERE c.contribution_type = 'election'
           AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
           AND (p_exclude IS NULL OR c.id <> p_exclude)
           AND NULLIF(c.payload->>'lg_code', '') IS NOT DISTINCT FROM v_lg
           AND policy_jp.same_claim_office(c.payload->>'election_type') = v_office
           AND (v_reason IS NULL OR COALESCE(NULLIF(c.payload->>'election_reason', ''), 'regular') = v_reason)
           AND policy_jp.same_claim_same_term(v_lg, v_office, v_reason, v_date, v_term_end, policy_jp.date_or_null(c.payload->>'election_date'))
         LIMIT 50
      ) x;

  ELSIF p_type = 'regional_stat' THEN
    IF v_lg IS NULL THEN
      RETURN jsonb_build_object('type', p_type, 'existing', v_existing, 'pending', v_pending);
    END IF;
    v_year := CASE WHEN jsonb_typeof(p->'year') = 'number' THEN (p->>'year')::NUMERIC::INTEGER END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', s.id::TEXT, 'stat_key', s.stat_key, 'year', s.year, 'value', s.value, 'unit', s.unit, 'review_status', s.review_status,
             'summary', s.stat_key || ' ' || s.year || '：' || s.value || ' ' || s.unit,
             'why', '同団体・同項目・同年')
             ORDER BY s.stat_key, s.year), '[]'::JSONB)
      INTO v_existing
      FROM policy_jp.regional_stats s
     WHERE s.lg_code = v_lg
       AND (v_stat IS NULL OR s.stat_key = v_stat)
       AND (v_year IS NULL OR s.year = v_year);
    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.created_at), '[]'::JSONB) INTO v_pending
      FROM (
        SELECT c.created_at, jsonb_build_object(
                 'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
                 'stat_key', c.payload->>'stat_key', 'year', c.payload->'year', 'value', c.payload->'value', 'unit', c.payload->>'unit',
                 'summary', COALESCE(c.payload->>'stat_key', '?') || ' ' || COALESCE(c.payload->>'year', '?') || '：' || COALESCE(c.payload->>'value', '?') || ' ' || COALESCE(c.payload->>'unit', ''),
                 'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
                 'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
                   OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
          FROM policy_jp.contributions c
         WHERE c.contribution_type = 'regional_stat'
           AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
           AND (p_exclude IS NULL OR c.id <> p_exclude)
           AND c.payload->>'lg_code' = v_lg
           AND (v_stat IS NULL OR c.payload->>'stat_key' = v_stat)
           AND (v_year IS NULL OR c.payload->>'year' = v_year::TEXT)
         LIMIT 50
      ) x;

  ELSE -- local_government
    IF v_lg IS NULL THEN
      RETURN jsonb_build_object('type', p_type, 'existing', v_existing, 'pending', v_pending);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', g.lg_code, 'name', g.name, 'kana', g.kana, 'kind', g.kind, 'pref_code', g.pref_code,
             'summary', g.name || '（' || g.lg_code || '）', 'why', '同じ団体コード')), '[]'::JSONB)
      INTO v_existing
      FROM policy_jp.local_governments g WHERE g.lg_code = v_lg;
    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.created_at), '[]'::JSONB) INTO v_pending
      FROM (
        SELECT c.created_at, jsonb_build_object(
                 'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
                 'name', c.payload->>'name', 'kind', c.payload->>'kind',
                 'summary', COALESCE(c.payload->>'name', '?') || '（' || v_lg || '）',
                 'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
                 'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
                   OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
          FROM policy_jp.contributions c
         WHERE c.contribution_type = 'local_government'
           AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
           AND (p_exclude IS NULL OR c.id <> p_exclude)
           AND c.payload->>'lg_code' = v_lg
         LIMIT 50
      ) x;
  END IF;

  RETURN jsonb_build_object('type', p_type, 'existing', v_existing, 'pending', v_pending);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches IS
  '同一件事（#521）：型別＋payload → {existing:在庫的列, pending:審議中的提交（附 your_network_voted）}；型別沒登記＝NULL。'
  'jp-report 交件時擋 resolved_claim、jp-next 附在 item.current.same_claims。TS 登記表 _shared/same-claims.ts';

REVOKE ALL ON FUNCTION policy_jp.same_claim_office(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.same_claim_same_term(TEXT, TEXT, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_office(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_same_term(TEXT, TEXT, TEXT, DATE, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID) TO service_role;
