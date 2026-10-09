-- 同一件事只能有一筆，第二步：既有的重複收編＋上線後自動收編（policy-tw #521；工作單 Yooliang/policy-ops#24）
--
-- 1. 上線後收編（照正見裁決 2026-09-21「同一宣稱已上線，其他等票的提交收編成 superseded」，正見在 apply-contribution.ts 的 supersedeDuplicates）：
--    election／regional_stat／local_government 的提交一轉成 applied，同一件事（policy_jp.same_claim_matches，20261009280000）
--    其他還在等票的（pending／verified，同正見）而且內容相同的，改成 superseded；每一筆記一列 edit_history（可追、可撤：撤回＝把狀態改回 pending）。
--    內容相同＝選舉：投票日・種類・事由相同；統計：值相同；團體：名稱・讀音・種類相同。
--    宣告 differs:<id> 的（代理說內容不同）不收編：照主線裁定 1，兩筆並存進投票，由票決定。
-- 2. 既有的重複（#531 上線前收進來的；10-09 11:15 唯讀查正式庫是 15 對）：
--    a. 一筆已落庫、後交的還在等票（5 對）：用第 1 點同一支函式補跑一次（對所有已落庫的提交，冪等）。
--    b. 兩筆都在等票（4 對）：後交的併進先交的——後交那筆的票搬到先交那筆（那個網段已經投過先交那筆、或就是先交那筆的交件者，不搬），
--       後交那筆的交件者記成對先交那筆的同意票（同「重複提交＝同意票」；網段投過或就是交件者則不記），後交那筆改 superseded。
--       票一進來，contribution_votes 的觸發器照常重算先交那筆的共識；達到門檻由落庫排程照常落庫。
--    c. 兩筆都已落庫（6 對）：不動。elections 每對只有一列（第二筆落庫時是 unchanged），正式資料沒有錯，已落庫提交的狀態與履歷不改。
--
-- 只動 policy_jp.contributions／contribution_votes／edit_history；不碰 public、ditrust，不寫正式資料表。整支冪等（重跑不會再搬、再記）。

CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_content(p_type TEXT, a JSONB, b JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'election' THEN (a->>'election_date', a->>'election_type', COALESCE(NULLIF(a->>'election_reason', ''), 'regular'))
                     IS NOT DISTINCT FROM (b->>'election_date', b->>'election_type', COALESCE(NULLIF(b->>'election_reason', ''), 'regular'))
    -- 數值比對跟 apply_regional_stat 同一判準（NUMERIC：28.5 與 28.50 相同）；不是數字的不算相同
    WHEN 'regional_stat' THEN jsonb_typeof(a->'value') = 'number' AND jsonb_typeof(b->'value') = 'number'
                              AND (a->>'value')::NUMERIC = (b->>'value')::NUMERIC AND a->>'unit' IS NOT DISTINCT FROM b->>'unit'
    WHEN 'local_government' THEN (a->>'name', a->>'kana', a->>'kind') IS NOT DISTINCT FROM (b->>'name', b->>'kana', b->>'kind')
    ELSE FALSE
  END
$$;
COMMENT ON FUNCTION policy_jp.same_claim_same_content IS
  '同一件事的兩筆提交內容是否相同（收編用）：選舉＝投票日・種類・事由、統計＝值・單位、團體＝名稱・讀音・種類';

-- 一筆提交（已落庫的那一筆）→ 把同一件事、內容相同、還在等票的其他提交收編成 superseded；回收編了幾筆
CREATE OR REPLACE FUNCTION policy_jp.same_claim_supersede(p_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  c policy_jp.contributions%ROWTYPE;
  m JSONB;
  v_ids UUID[];
BEGIN
  SELECT * INTO c FROM policy_jp.contributions WHERE id = p_id;
  IF NOT FOUND OR c.status <> 'applied' THEN RETURN 0; END IF;
  m := policy_jp.same_claim_matches(c.contribution_type, c.payload, NULL, c.id);
  IF m IS NULL THEN RETURN 0; END IF;
  SELECT array_agg(o.id) INTO v_ids
    FROM jsonb_array_elements(m->'pending') p
    JOIN policy_jp.contributions o ON o.id = (p->>'contribution_id')::UUID
   WHERE o.status IN ('pending', 'verified')
     AND COALESCE(o.payload->>'resolved_claim', '') NOT LIKE 'differs:%'
     AND policy_jp.same_claim_same_content(c.contribution_type, c.payload, o.payload);
  IF v_ids IS NULL THEN RETURN 0; END IF;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  SELECT 'contributions', o.id::TEXT, 'status', to_jsonb(o.status), to_jsonb('superseded'::TEXT), c.id, 'same-claim'
    FROM policy_jp.contributions o WHERE o.id = ANY (v_ids);
  UPDATE policy_jp.contributions
     SET status = 'superseded', reviewed_by = 'same-claim', reviewed_at = now(),
         review_notes = '同一件事已由 ' || COALESCE(c.agent_name, '?') || ' 的提交（' || c.id || '）上線，這筆收編（#521；撤回＝改回 pending）'
   WHERE id = ANY (v_ids);
  RETURN cardinality(v_ids);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_supersede IS
  '上線後收編（照正見 2026-09-21）：已落庫的那一筆 → 同一件事、內容相同、還在等票的其他提交改 superseded，記 edit_history（agent_name same-claim）；differs 的不收編';

CREATE OR REPLACE FUNCTION policy_jp.same_claim_supersede_trg() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM policy_jp.same_claim_supersede(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contributions_same_claim_supersede ON policy_jp.contributions;
CREATE TRIGGER contributions_same_claim_supersede AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NEW.contribution_type IN ('election', 'regional_stat', 'local_government'))
  EXECUTE FUNCTION policy_jp.same_claim_supersede_trg();

-- 兩筆都在等票：後交的併進先交的（見檔頭 2b）；回併了幾筆
CREATE OR REPLACE FUNCTION policy_jp.same_claim_merge_pending() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  r RECORD;
  m JSONB;
  first_c policy_jp.contributions%ROWTYPE;
  v_n INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.* FROM policy_jp.contributions c
     WHERE c.contribution_type IN ('election', 'regional_stat', 'local_government')
       AND c.status IN ('pending', 'verified')
       AND COALESCE(c.payload->>'resolved_claim', '') NOT LIKE 'differs:%'
     ORDER BY c.created_at DESC, c.id
  LOOP
    -- 迴圈開始後這一筆可能已被改掉（重讀狀態）
    CONTINUE WHEN (SELECT status FROM policy_jp.contributions WHERE id = r.id) NOT IN ('pending', 'verified');
    m := policy_jp.same_claim_matches(r.contribution_type, r.payload, NULL, r.id);
    -- 先交的：同一件事、內容相同、比這筆早、還在等票的最早一筆
    SELECT o.* INTO first_c
      FROM jsonb_array_elements(COALESCE(m->'pending', '[]'::JSONB)) p
      JOIN policy_jp.contributions o ON o.id = (p->>'contribution_id')::UUID
     WHERE o.status IN ('pending', 'verified', 'disputed')
       AND (o.created_at, o.id) < (r.created_at, r.id)
       AND COALESCE(o.payload->>'resolved_claim', '') NOT LIKE 'differs:%'
       AND policy_jp.same_claim_same_content(r.contribution_type, r.payload, o.payload)
     ORDER BY o.created_at, o.id
     LIMIT 1;
    CONTINUE WHEN NOT FOUND;

    -- 後交那筆的票搬過去（那個網段投過先交那筆、或就是先交那筆的交件者，不搬）
    UPDATE policy_jp.contribution_votes v
       SET contribution_id = first_c.id,
           note = left('（#521 收編：原本投在重複提交 ' || r.id || '）' || COALESCE(v.note, ''), 2000)
     WHERE v.contribution_id = r.id
       -- 自己不能驗自己：先交那筆的交件者（網段或代號相同）的票不搬
       AND v.verifier_ip_hash IS DISTINCT FROM first_c.contributor_ip_hash
       AND lower(v.agent_name) IS DISTINCT FROM lower(first_c.agent_name)
       -- 一個網段、一個代號在一筆上只有一票（唯一約束 contribution_votes_one_per_agent 是 (contribution_id, agent_name)）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contribution_votes x WHERE x.contribution_id = first_c.id
                        AND (x.verifier_ip_hash = v.verifier_ip_hash OR x.agent_name = v.agent_name))
       -- 同一網段在後交那筆上有兩票（代號不同）：只搬最早那一票
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contribution_votes y WHERE y.contribution_id = r.id
                        AND y.verifier_ip_hash = v.verifier_ip_hash AND (y.created_at, y.id) < (v.created_at, v.id));
    -- 後交那筆的交件者＝對先交那筆的同意票（重複提交＝同意票）
    INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, agent_tool, verifier_ip_hash, actor_id, via, note, evidence_url)
    SELECT first_c.id, 'agree', r.agent_name, r.agent_tool, r.contributor_ip_hash, r.actor_id, 'merge',
           left('這票來自重複提交：' || r.agent_name || ' 獨立查證後提交了同一件事（' || r.id || '），#521 收編時改記為對這一筆的同意票。'
                || COALESCE('對方的來源：' || array_to_string(r.source_urls, '、'), ''), 2000),
           r.source_urls[1]
     WHERE r.contributor_ip_hash IS DISTINCT FROM first_c.contributor_ip_hash
       -- 同一個代理（代號相同、網段不同）重交：不能變成自己對自己的同意票
       AND lower(r.agent_name) IS DISTINCT FROM lower(first_c.agent_name)
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contribution_votes x WHERE x.contribution_id = first_c.id
                        AND (x.verifier_ip_hash = r.contributor_ip_hash OR x.agent_name = r.agent_name))
    ON CONFLICT DO NOTHING;

    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('contributions', r.id::TEXT, 'status', to_jsonb(r.status), to_jsonb('superseded'::TEXT), first_c.id, 'same-claim');
    UPDATE policy_jp.contributions
       SET status = 'superseded', reviewed_by = 'same-claim', reviewed_at = now(),
           review_notes = '同一件事已有先交的 ' || COALESCE(first_c.agent_name, '?') || ' 的提交（' || first_c.id || '），這筆的票與交件者那一票併過去、這筆收編（#521；撤回＝改回 pending）'
     WHERE id = r.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_merge_pending IS
  '一次性收編（#521）：同一件事、內容相同、兩筆都在等票 → 後交的票與交件者那一票併進先交的，後交的改 superseded（記 edit_history）。冪等';

REVOKE ALL ON FUNCTION policy_jp.same_claim_same_content(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.same_claim_supersede(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.same_claim_supersede_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION policy_jp.same_claim_merge_pending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_same_content(TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_supersede(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION policy_jp.same_claim_merge_pending() TO service_role;

-- ---- 一次性：既有的重複（見檔頭 2）。先併兩筆都在等票的，再對已落庫的補跑收編 ----
DO $$
DECLARE
  v_merged INTEGER;
  v_superseded INTEGER := 0;
  r RECORD;
BEGIN
  v_merged := policy_jp.same_claim_merge_pending();
  FOR r IN SELECT id FROM policy_jp.contributions
            WHERE status = 'applied' AND contribution_type IN ('election', 'regional_stat', 'local_government')
            ORDER BY applied_at NULLS LAST, id
  LOOP
    v_superseded := v_superseded + policy_jp.same_claim_supersede(r.id);
  END LOOP;
  RAISE NOTICE '#521 收編：兩筆都等票併掉 % 筆，已落庫補收編 % 筆', v_merged, v_superseded;
END;
$$;
