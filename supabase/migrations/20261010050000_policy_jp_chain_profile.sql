-- 日本站「選舉鏈」第 3 步：參選人建檔（profile_gap／profile_detail_gap 臂＋politician 交件型別＋落庫＋同一件事）
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-election-chain.md 第 2 節的第 3 步（任務型別 profile_gap、profile_detail_gap；交件型別 politician；
-- 「該參選人已有參選紀錄」逐人開、後備＝告示日）。前提：20261010040000（第 2 步：candidacy、roster_check、告示日里程碑 announced）。
--
-- 這支做的事（新增鏈上的一步＝election_chain_steps() 加名字＋進度視圖加一段＋規則設 after_step 與後備里程碑＋三處登記）：
-- 1. 步驟清單加 profile（建檔）；進度視圖 election_chain_progress 加一段（其餘一字不改）。
-- 2. 派工臂（正見 contribution_auto_tasks_raw 的 profile_gap、contribution_auto_tasks_profile_details／career_sources 的日本版）：
--      profile_gap         task_id＝auto:profile_gap:<人物 id>            生年（birth_year）未登錄
--      profile_detail_gap  task_id＝auto:profile_detail_gap:<人物 id>      學歷・經歷（politician_careers）一筆也沒有（target.kind＝careers_missing）
--                          task_id＝auto:profile_detail_gap:sources:<人物 id>  有學歷・經歷但缺出處（target.kind＝career_sources，附缺出處的原文）
--    對象＝開著的、已上線的選舉（chain_open_elections，basis=published）裡有參選紀錄（上線・不是退選）的人；一個人在好幾場開著的選舉時掛在投票日最早的那一場。
--    三處一起加：總表加兩行 UNION、activity_arm_names() 加兩個名字、activity_rules 種兩條規則（after_step=candidacy＝該場選舉已有參選紀錄；
--    後備＝告示日當天；窗口永遠開；cap）。另加優先層規則 priority:profile_gap／priority:profile_detail_gap 與 chain_step_rank 的 WHEN（5）。
--    日本站的人物表只有 name／kana／birth_year（職稱・政黨・照片在別的表或不存），所以 profile_gap 只問生年；
--    正見的 current_position／avatar_url 在日本站沒有對應欄位，不問。
-- 3. 交件型別 politician：DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_politician（生年只補空欄位、學經歷一條一項
--    insert politician_careers、出處掛到文字相同的項目上；已有不同的生年＝conflict 不覆蓋）、apply_contribution 多一個 WHEN。
--    人物本身只由 candidacy 建立（同一人的判定集中在 apply_candidacy 一處）；politician 型別只補既有的人，payload 要帶 politician_id。
--    共識：SQL contribution_required_agree 走 normal＝目標 3、退件 −3（不要兩個網段）。這支不改共識。
-- 4. 同一件事（#521 的登記表）：politician 不是 claimKey 併票型別（自由文字，正見也不併），所以登記在 same-claims.ts 的登記表（jp）。
--      精確鍵＝人物 id ＋ 事實：payload 帶的生年（庫裡已有生年→重複）、學歷・經歷的每一條（庫裡已有同 kind 同文字的列→重複）。
--      「這個人」本身一定在庫裡，所以不能把人當鍵（會永遠 duplicate_claim）；鍵是這次要補的事實。
--    SQL：same_claim_matches 改成分派器（20261009280000 的本體改名為 same_claim_matches_base，型別 politician 走新的 same_claim_matches_politician，
--    其餘照舊交給 base），同一個入口 jp-next／jp-report 照呼叫；same_claim_same_content 多 politician 一個 WHEN；收編觸發器的型別清單多 politician。
--    （same_claim_merge_pending 是一次性函式，清單不跟：politician 沒有『上線前的既有重複』要併。）
-- 5. 得票數不相關；payload 的 name／kana 不收（改名・讀音更正走 correction）。
--
-- 設計決定：
-- a. 「前一步完成」＝candidacy（該場選舉已有人正式表明：declared 以上的上線參選紀錄，第 2 步定義；considering 與退選不算）。臂對所有非退選的人派
--    （含 considering），所以傳聞階段的人不會單獨啟動建檔，要等有人正式表明，或告示日到了（後備＝announced +0）。
-- b. profile 步驟 done（給第 4 步用）：這場選舉至少有一位參選人，而且每一位都「建檔齊了」——生年有了、學經歷有了、學經歷都有出處；
--    其中任何一項被回報查無（no_change not_found）並在冷卻中也算（只有那一項，不連帶其他項）。三項各有各的 task id，冷卻各算各的。
-- c. 學歷・經歷的來源：日本站沒有 education／experience 陣列（正見有），一律是 politician_careers 一條一列；payload 欄位叫 education／career
--    （career 對應 politician_careers.kind='career'，正見叫 experience）。臉書・IG・Threads 讀不到，不算出處（寫在任務說明）。
--
-- 守門：supabase/functions/_shared/policy-jp-chain-profile.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、
-- jp/contribution-schema-chain.test.ts、jp-entry-chain.test.ts。不碰 public、ditrust。

-- ------------------------------------------------------------
-- 1. 步驟清單
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY['discovery', 'local_government', 'regional_stats', 'region', 'roster', 'candidacy', 'profile']::TEXT[]
$$;
COMMENT ON FUNCTION policy_jp.election_chain_steps IS '選舉鏈的步驟（election_chain_progress.step 的值）；activity_rules.after_step 只能是這裡的值。加步驟＝改這裡＋視圖多一段';

-- ------------------------------------------------------------
-- 2. 建檔的缺口判準（臂與進度視圖共用同一個）
-- ------------------------------------------------------------
-- 一個人缺什麼：{birth_year: true, careers: true, career_sources: ["原文", …]}；齊了＝NULL。不看冷卻（冷卻由呼叫端處理）
CREATE OR REPLACE FUNCTION policy_jp.chain_profile_missing(p_politician_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT NULLIF(jsonb_strip_nulls(jsonb_build_object(
           'birth_year', CASE WHEN p.birth_year IS NULL THEN true END,
           'careers', CASE WHEN NOT EXISTS (SELECT 1 FROM policy_jp.politician_careers c WHERE c.politician_id = p.id AND c.review_status = 'published') THEN true END,
           'career_sources', (SELECT jsonb_agg(c.text ORDER BY c.kind, c.sort_order, c.id)
                                FROM policy_jp.politician_careers c
                               WHERE c.politician_id = p.id AND c.review_status = 'published'
                                 AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = 'politician_careers' AND r.target_id = c.id::TEXT)))),
         '{}'::JSONB)
    FROM policy_jp.politicians p WHERE p.id = p_politician_id
$$;
COMMENT ON FUNCTION policy_jp.chain_profile_missing IS '人物の建檔の缺口（birth_year／careers／career_sources）；齊了＝NULL。profile_gap・profile_detail_gap 臂と election_chain_progress の profile が共有';

-- 建檔が済んでいる：缺口がない、または缺口ごとに『查無』が冷卻中（三つの task id は別々）
CREATE OR REPLACE FUNCTION policy_jp.chain_profile_done(p_politician_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.politicians WHERE id = p_politician_id) AND COALESCE(
    (m IS NULL)
    OR (  (NOT (m ? 'birth_year')      OR policy_jp.chain_task_checked('auto:profile_gap:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)
      AND (NOT (m ? 'careers')         OR policy_jp.chain_task_checked('auto:profile_detail_gap:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)
      AND (NOT (m ? 'career_sources')  OR policy_jp.chain_task_checked('auto:profile_detail_gap:sources:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)),
    false)
    FROM (SELECT policy_jp.chain_profile_missing(p_politician_id) AS m) x
$$;
COMMENT ON FUNCTION policy_jp.chain_profile_done IS '人物の建檔が済んでいるか：缺口なし、または缺口ごとに no_change(not_found) が冷卻中。人物が存在しなければ false';

-- ------------------------------------------------------------
-- 3. 鏈の進度：前一版（20261010040000）の視圖＋profile の一段
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policy_jp.election_chain_progress WITH (security_invoker = true) AS
  WITH oe AS (SELECT o.election_id, o.lg_code, o.since FROM policy_jp.chain_open_elections o),
  lg AS (
    -- 團體與所屬都道府県（都道府県的選舉兩個碼相同）：每個碼都在 local_governments，或那一件回報查無、還在冷卻中
    SELECT o.election_id, o.lg_code,
           bool_and(g.lg_code IS NOT NULL OR ck.checked_at IS NOT NULL) AS done,
           max(COALESCE(g.created_at, ck.checked_at)) AS last_at
      FROM oe o
      CROSS JOIN LATERAL (VALUES (policy_jp.lg_pref_code(o.lg_code)), (o.lg_code)) AS c(code)
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = c.code
      LEFT JOIN LATERAL (
        SELECT max(tc.checked_at) AS checked_at FROM policy_jp.task_checks tc
         WHERE tc.task_id = 'auto:local_government_missing:' || c.code AND tc.outcome = 'not_found'
           AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
      ) ck ON true
     GROUP BY o.election_id, o.lg_code
  ),
  st AS (
    -- 統計齊了（或不收統計的種類），或那一件回報查無、還在冷卻中
    SELECT o.election_id, o.lg_code,
           (policy_jp.chain_regional_stats_missing(o.lg_code) IS NULL OR ck.checked_at IS NOT NULL) AS done,
           GREATEST((SELECT max(s.created_at) FROM policy_jp.regional_stats s WHERE s.lg_code = o.lg_code AND s.review_status = 'published'), ck.checked_at, o.since) AS last_at
      FROM oe o
      LEFT JOIN LATERAL (
        SELECT max(tc.checked_at) AS checked_at FROM policy_jp.task_checks tc
         WHERE tc.task_id = 'auto:regional_stats_missing:' || o.lg_code AND tc.outcome = 'not_found'
           AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
      ) ck ON true
  ),
  -- 第 2 步 roster：名簿確認過了（roster_check 任務有人回報 confirmed／not_found，還在冷卻中）
  ro AS (
    SELECT o.election_id, o.lg_code, (ck.checked_at IS NOT NULL) AS done, ck.checked_at AS last_at
      FROM oe o
      CROSS JOIN LATERAL (SELECT policy_jp.chain_task_checked('auto:roster_check:' || o.election_id) AS checked_at) ck
  ),
  -- 第 2 步之後的 candidacy：這場選舉至少有一位已表明以上的已上線參選紀錄（considering 與退選不算；逐人的第 3 步靠它開）
  ca AS (
    SELECT o.election_id, o.lg_code, (x.n > 0) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, max(pe.created_at) AS last_at FROM policy_jp.politician_elections pe
         WHERE pe.election_id = o.election_id AND pe.review_status = 'published' AND pe.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
      ) x
  ),
  -- 第 3 步 profile：這場選舉至少有一位參選人，而且每一位都建檔齊了（缺口なし、または缺口ごとに『查無』が冷卻中）
  pf AS (
    SELECT o.election_id, o.lg_code, (x.n > 0 AND x.n = x.n_done) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, count(*) FILTER (WHERE policy_jp.chain_profile_done(pe.pid)) AS n_done, max(pe.u) AS last_at
          FROM (SELECT pe0.politician_id AS pid, max(pe0.updated_at) AS u FROM policy_jp.politician_elections pe0
                 WHERE pe0.election_id = o.election_id AND pe0.review_status = 'published' AND pe0.candidacy_status <> 'withdrawn'
                 GROUP BY pe0.politician_id) pe
      ) x
  )
  SELECT o.election_id, o.lg_code, 'discovery'::TEXT AS step, true AS done, o.since AS done_at FROM oe o
  UNION ALL
  SELECT l.election_id, l.lg_code, 'local_government'::TEXT, l.done, CASE WHEN l.done THEN l.last_at END FROM lg l
  UNION ALL
  SELECT s.election_id, s.lg_code, 'regional_stats'::TEXT, s.done, CASE WHEN s.done THEN s.last_at END FROM st s
  UNION ALL
  SELECT l.election_id, l.lg_code, 'region'::TEXT, l.done AND s.done, CASE WHEN l.done AND s.done THEN GREATEST(l.last_at, s.last_at) END
    FROM lg l JOIN st s ON s.election_id = l.election_id AND s.lg_code = l.lg_code
  UNION ALL
  SELECT r.election_id, r.lg_code, 'roster'::TEXT, r.done, CASE WHEN r.done THEN r.last_at END FROM ro r
  UNION ALL
  SELECT c.election_id, c.lg_code, 'candidacy'::TEXT, c.done, CASE WHEN c.done THEN c.last_at END FROM ca c
  UNION ALL
  SELECT f.election_id, f.lg_code, 'profile'::TEXT, f.done, CASE WHEN f.done THEN f.last_at END FROM pf f;
COMMENT ON VIEW policy_jp.election_chain_progress IS
  '選舉鏈的進度：開著的選舉×團體×步驟（election_chain_steps()）一列，done＝這一步的缺口都補上了，或回報查無、還在冷卻中。總表の chain_gate 讀它（seed 時算一次）。service_role 用';

-- ------------------------------------------------------------
-- 4. 交件型別 politician：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'no_change']::TEXT[]
$$;

-- politician 交件の落庫：既存の人に生年と学経歴を足す（空欄だけ埋める。既にある値は上書きしない）
CREATE OR REPLACE FUNCTION policy_jp.apply_politician(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_pid TEXT := NULLIF(btrim(COALESCE(p->>'politician_id', '')), '');
  v_row policy_jp.politicians%ROWTYPE;
  v_birth INTEGER;
  v_kind TEXT;
  v_text TEXT;
  v_cid BIGINT;
  v_order INTEGER;
  v_new_careers INTEGER := 0;
  v_attached INTEGER := 0;
  v_birth_set BOOLEAN := false;
  v_has_src BOOLEAN;
  v_src BIGINT;
  v_year INTEGER := EXTRACT(YEAR FROM policy_jp.activity_today())::INTEGER;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_id がない（politician は既存の人にだけ足す。新しい人は candidacy で作る）');
  END IF;
  IF p ?| ARRAY['name', 'kana'] THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '名前・読みは politician では直さない（correction で出し直す）');
  END IF;
  SELECT * INTO v_row FROM policy_jp.politicians WHERE id = v_pid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('politician_id %s は politicians にない', v_pid));
  END IF;
  IF NOT (p ? 'birth_year' OR p ? 'education' OR p ? 'career') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'birth_year・education・career のどれか一つは要る');
  END IF;
  IF p ? 'birth_year' THEN
    IF jsonb_typeof(p->'birth_year') <> 'number' OR (p->>'birth_year')::NUMERIC <> trunc((p->>'birth_year')::NUMERIC)
       OR (p->>'birth_year')::NUMERIC NOT BETWEEN 1900 AND v_year THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('birth_year は 1900～%s の整数（西暦）', v_year));
    END IF;
    v_birth := (p->>'birth_year')::INTEGER;
  END IF;
  FOREACH v_kind IN ARRAY ARRAY['education', 'career'] LOOP
    IF p ? v_kind THEN
      IF jsonb_typeof(p->v_kind) <> 'array' OR jsonb_array_length(p->v_kind) = 0 OR jsonb_array_length(p->v_kind) > 30 THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s は 1～30 件の文字列の配列', v_kind));
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->v_kind) e WHERE jsonb_typeof(e) <> 'string' OR btrim(e #>> '{}') = '' OR char_length(btrim(e #>> '{}')) > 200) THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s の各項目は 1～200 字の文字列', v_kind));
      END IF;
    END IF;
  END LOOP;

  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'politician');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  -- 生年：空欄だけ埋める。同じ値なら何もしない（出処だけ足す）、違う値は conflict（上書きしない）
  IF v_birth IS NOT NULL THEN
    IF v_row.birth_year IS NULL THEN
      UPDATE policy_jp.politicians SET birth_year = v_birth WHERE id = v_pid;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', v_pid, 'birth_year', NULL, to_jsonb(v_birth), c.id, 'auto-apply');
      v_birth_set := true;
    ELSIF v_row.birth_year <> v_birth THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politicians', 'record_id', v_pid,
        'message', format('庫の %s は生年 %s で、提出の %s と違う。上書きしない（直すなら correction）', v_pid, v_row.birth_year, v_birth));
    END IF;
    PERFORM policy_jp.source_write('politicians', v_pid, c.source_urls, 'politician');
  END IF;

  -- 学歴・経歴：一条一項。文字が同じ既存の項目には出処だけ足す（まだ出処のない項目）
  FOREACH v_kind IN ARRAY ARRAY['education', 'career'] LOOP
    CONTINUE WHEN NOT (p ? v_kind);
    FOR v_text IN SELECT DISTINCT btrim(e #>> '{}') FROM jsonb_array_elements(p->v_kind) e LOOP
      SELECT pc.id INTO v_cid FROM policy_jp.politician_careers pc WHERE pc.politician_id = v_pid AND pc.kind = v_kind AND pc.text = v_text;
      IF v_cid IS NULL THEN
        SELECT COALESCE(max(sort_order), 0) + 1 INTO v_order FROM policy_jp.politician_careers WHERE politician_id = v_pid;
        INSERT INTO policy_jp.politician_careers (politician_id, kind, text, sort_order, review_status) VALUES (v_pid, v_kind, v_text, v_order, 'published')
        RETURNING id INTO v_cid;
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('politician_careers', v_cid::TEXT, '*', NULL, (SELECT to_jsonb(x) FROM policy_jp.politician_careers x WHERE x.id = v_cid), c.id, 'auto-apply');
        PERFORM policy_jp.source_write('politician_careers', v_cid::TEXT, c.source_urls, 'politician');
        v_new_careers := v_new_careers + 1;
      ELSE
        SELECT EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = 'politician_careers' AND r.target_id = v_cid::TEXT) INTO v_has_src;
        IF NOT v_has_src THEN
          PERFORM policy_jp.source_write('politician_careers', v_cid::TEXT, c.source_urls, 'politician');
          v_attached := v_attached + 1;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE policy_jp.contributions SET applied_politician_id = v_pid WHERE id = c.id;
  IF NOT v_birth_set AND v_new_careers = 0 AND v_attached = 0 THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politicians', 'record_id', v_pid, 'message', format('%s は庫に同じ内容で既にある', v_pid));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politicians', 'record_id', v_pid,
    'message', format('%s：生年%s、学経歴 %s 件を追加、既存 %s 件に出処を付けた', v_pid, CASE WHEN v_birth_set THEN 'を登録' ELSE 'は変更なし' END, v_new_careers, v_attached));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_politician IS
  'politician 交件の落庫（既存の人に生年と学経歴を足す）。生年は空欄だけ埋める（違う値＝conflict）、学経歴は一条一項で insert（同じ文字の既存項目には出処だけ足す）、同じ内容＝unchanged、不備＝invalid';

-- 落庫主函式：20261010040000 の版に politician の WHEN を 1 行足しただけ（残りは一字も変えない）
CREATE OR REPLACE FUNCTION policy_jp.apply_contribution(p_id UUID, p_retry BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  c policy_jp.contributions%ROWTYPE;
  v_blocker TEXT;
  v_out JSONB;
  v_err TEXT;
  v_count INTEGER;
  v_msg TEXT;
BEGIN
  SELECT * INTO c FROM policy_jp.contributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF NOT (c.status = 'verified'
          OR (p_retry AND c.status = 'apply_failed' AND c.retry_count < policy_jp.apply_max_retries() AND c.next_retry_at IS NOT NULL AND c.next_retry_at <= now())) THEN
    RETURN jsonb_build_object('status', 'skipped', 'contribution_status', c.status);
  END IF;
  IF NOT (c.contribution_type = ANY (policy_jp.apply_types())) THEN
    RETURN jsonb_build_object('status', 'unsupported', 'contribution_type', c.contribution_type);
  END IF;
  v_blocker := policy_jp.apply_blocker(c.contribution_type, c.payload);
  IF v_blocker IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'waiting', 'reason', v_blocker, 'message', '外鍵指到的團體還沒落庫，等它進來再落（貢獻維持 ' || c.status || '）：' || v_blocker);
  END IF;

  BEGIN
    v_out := CASE c.contribution_type
               WHEN 'local_government' THEN policy_jp.apply_local_government(c)
               WHEN 'regional_stat' THEN policy_jp.apply_regional_stat(c)
               WHEN 'election' THEN policy_jp.apply_election(c)
               WHEN 'candidacy' THEN policy_jp.apply_candidacy(c)
               WHEN 'politician' THEN policy_jp.apply_politician(c)
               ELSE policy_jp.apply_no_change(c)
             END;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_count := c.retry_count + 1;
    IF v_count >= policy_jp.apply_max_retries() THEN
      -- 連續失敗：不硬建，退件；缺口還在，派工佇列之後會重新派出去（正見 auto-apply.ts 的 GAP_RETURNS）
      UPDATE policy_jp.contributions SET status = 'rejected', retry_count = v_count, last_error = v_err, next_retry_at = NULL,
             review_notes = '[auto] 落庫連續 ' || v_count || ' 次失敗，退件：' || v_err || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
             reviewed_by = 'auto-apply', reviewed_at = now()
       WHERE id = c.id;
      RETURN jsonb_build_object('status', 'rejected', 'message', v_err, 'retry_count', v_count);
    END IF;
    UPDATE policy_jp.contributions SET status = 'apply_failed', retry_count = v_count, last_error = v_err,
           next_retry_at = now() + make_interval(mins => policy_jp.apply_retry_delay_minutes()),
           review_notes = '[auto] 落庫失敗（第 ' || v_count || ' 次，' || policy_jp.apply_retry_delay_minutes() || ' 分鐘後重試）：' || v_err,
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'apply_failed', 'message', v_err, 'retry_count', v_count);
  END;

  v_msg := v_out->>'message';
  IF v_out->>'outcome' IN ('conflict', 'invalid') THEN
    UPDATE policy_jp.contributions SET status = 'rejected', last_error = NULL, next_retry_at = NULL,
           review_notes = '[auto] ' || v_msg || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'rejected', 'outcome', v_out->>'outcome', 'message', v_msg);
  END IF;
  -- applied／unchanged：狀態轉 applied 會觸發 contributions_drop_dispatch，自動缺口的派工列立刻收回
  UPDATE policy_jp.contributions SET status = 'applied', applied_at = now(), last_error = NULL, next_retry_at = NULL,
         review_notes = '[auto] ' || v_msg, reviewed_by = 'auto-apply', reviewed_at = now()
   WHERE id = c.id;
  RETURN jsonb_build_object('status', 'applied', 'outcome', v_out->>'outcome', 'message', v_msg, 'table_name', v_out->>'table_name', 'record_id', v_out->>'record_id');
END;
$$;

-- ------------------------------------------------------------
-- 5. 臂：profile_gap（生年）と profile_detail_gap（学歴・経歴、出処）
-- ------------------------------------------------------------
-- 対象の人：開いている・上線済みの選挙で、上線済み・退選でない参選紀錄がある人。複数の選挙にいる人は投票日の一番早い選挙に掛ける
CREATE OR REPLACE FUNCTION policy_jp.chain_profile_subjects() RETURNS TABLE (
  politician_id TEXT, name TEXT, kana TEXT, birth_year INTEGER, election_id TEXT, election_name TEXT, election_type TEXT, election_date DATE,
  lg_code TEXT, lg_name TEXT, pref_name TEXT, candidacy_status TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT DISTINCT ON (pp.id) pp.id, pp.name, pp.kana, pp.birth_year, e.id, e.name, e.election_type, e.election_date, e.lg_code,
         COALESCE(g.name, '（名称未確認）'),
         COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）'),
         pe.candidacy_status
    FROM policy_jp.chain_open_elections o
    JOIN policy_jp.elections e ON e.id = o.election_id AND o.basis = 'published' AND e.review_status = 'published'
    JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
    JOIN policy_jp.politician_elections pe ON pe.election_id = e.id AND pe.review_status = 'published' AND pe.candidacy_status <> 'withdrawn'
    JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
   ORDER BY pp.id, e.election_date, e.id
$$;
COMMENT ON FUNCTION policy_jp.chain_profile_subjects IS '建檔の対象の人：開いている・上線済みの選挙に上線済み・退選でない参選紀錄がある人（複数なら投票日の一番早い選挙に掛ける）';

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_profile_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'profile_gap' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.* FROM policy_jp.chain_profile_subjects() s CROSS JOIN p
     WHERE p.cap IS NOT NULL AND s.birth_year IS NULL
       AND NOT policy_jp.task_unavailable('auto:profile_gap:' || s.politician_id)
       -- すでに生年を足した提出が審議中なら、もう一度派さない（落ちれば戻ってくる）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'politician' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.payload->>'politician_id' = s.politician_id AND c.payload ? 'birth_year')
     ORDER BY s.election_date, s.kana, s.politician_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:profile_gap:' || g.politician_id, 'profile_gap',
         jsonb_build_object('politician_id', g.politician_id, 'name', g.name, 'kana', g.kana, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'candidacy_status', g.candidacy_status, 'missing', jsonb_build_array('birth_year'),
                            'chain_lg_code', g.lg_code, 'chain_step', 'profile'),
         g.name || '（' || g.kana || '、' || g.lg_name || ' ' || g.election_id || ' の立候補者）の生年が未登録です。'
           || '同じ人かどうかは「読み＋地域＋生年」で判断するため、生年が分かると同姓同名の取り違えを防げます。'
           || '本人の公式サイト・議会や自治体の公式な紹介ページ・選管の公表資料で生年（西暦）を確かめ、contribution_type=politician で提出してください。'
           || 'payload は politician_id（' || g.politician_id || '）・birth_year（西暦の 4 桁整数）と resolved_claim（item.current.same_claims を見て決める。'
           || '誰も提出していなければ "new"）。生年が分からないときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測しない）。'
           || '年齢から逆算した値・報道の「推定」は使いません。',
         ARRAY[g.lg_name || ' 公式サイトの立候補者紹介', '候補者本人の公式サイト', g.pref_name || ' 選挙管理委員会', '議会の議員紹介ページ']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_profile_gap IS
  '選挙鎖の第 3 歩：開いている選挙の立候補者で生年が未登録の人 → profile_gap 任務（task_id＝auto:profile_gap:<人物 id>）。審議中の提出がある人は派さない。params.cap は可派の前 N 件';

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_profile_detail_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'profile_detail_gap' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  inflight AS (
    -- すでに学経歴を足した提出が審議中の人（落ちれば戻ってくる）
    SELECT DISTINCT c.payload->>'politician_id' AS pid FROM policy_jp.contributions c
     WHERE c.contribution_type = 'politician' AND c.status IN ('pending', 'verified', 'apply_failed') AND (c.payload ? 'education' OR c.payload ? 'career')
  ),
  careers AS (
    SELECT s.*, policy_jp.chain_profile_missing(s.politician_id) AS missing FROM policy_jp.chain_profile_subjects() s CROSS JOIN p WHERE p.cap IS NOT NULL
  ),
  gaps AS (
    SELECT x.* FROM (
      SELECT c.*, 'careers_missing'::TEXT AS kind, 'auto:profile_detail_gap:' || c.politician_id AS tid FROM careers c WHERE c.missing ? 'careers'
      UNION ALL
      SELECT c.*, 'career_sources'::TEXT, 'auto:profile_detail_gap:sources:' || c.politician_id FROM careers c WHERE c.missing ? 'career_sources'
    ) x
     WHERE NOT policy_jp.task_unavailable(x.tid)
       AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.pid = x.politician_id)
     ORDER BY x.election_date, x.kana, x.tid
     LIMIT (SELECT cap FROM p)
  )
  SELECT g.tid, 'profile_detail_gap',
         jsonb_build_object('kind', g.kind, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'candidacy_status', g.candidacy_status,
                            'missing', CASE g.kind WHEN 'careers_missing' THEN jsonb_build_array('education', 'career') ELSE jsonb_build_array('career_sources') END,
                            'unsourced', CASE g.kind WHEN 'career_sources' THEN g.missing->'career_sources' END,
                            'chain_lg_code', g.lg_code, 'chain_step', 'profile'),
         CASE g.kind
           WHEN 'careers_missing' THEN
             g.name || '（' || g.kana || '、' || g.lg_name || ' ' || g.election_id || ' の立候補者）の学歴・経歴がまだ登録されていません。'
               || '議会・自治体・選管の公式な紹介ページ、候補者本人の公式サイト（プロフィール欄）で確かめ、contribution_type=politician で提出してください。'
               || 'payload は politician_id（' || g.politician_id || '）・education（学歴の配列）・career（職歴・経歴の配列、一条一項）と resolved_claim。'
               || '配列の各項目は原文どおり 1 項目 1 文字列（例 education: ["○○大学法学部卒業"]）。説明文のなかに混ぜた書き方は取りません。'
               || '見つからないときは no_change、outcome=not_found で、探した場所を checked_urls に入れて報告してください（推測しない）。'
               || 'フェイスブック・Instagram・Threads は内容を読み取れないため出典になりません。'
           ELSE
             g.name || '（' || g.kana || '、' || g.lg_name || ' ' || g.election_id || ' の立候補者）の学歴・経歴のうち ' || jsonb_array_length(g.missing->'career_sources')
               || ' 項目にまだ出典がありません：「' || (SELECT string_agg(t, '」「') FROM jsonb_array_elements_text(g.missing->'career_sources') t) || '」。'
               || 'この項目が書かれている公式な紹介ページ（議会・自治体・選管・本人の公式サイト）を開き、contribution_type=politician で提出してください：'
               || 'payload は politician_id（' || g.politician_id || '）・education／career に上の原文をそのまま（文字を直さない）と resolved_claim、'
               || 'source_urls にその項目が書かれたページ。サーバーは文字が同じ既存の項目に出典を付けるだけです。'
               || '書き方が違う・ここにない項目を見つけたときも、ここの原文は変えず note に違いを書いてください。'
               || '見つからないときは no_change、outcome=not_found で報告してください。'
         END,
         ARRAY[g.lg_name || ' 公式サイトの立候補者紹介', '議会の議員紹介ページ', '候補者本人の公式サイト', g.pref_name || ' 選挙管理委員会']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_profile_detail_gap IS
  '選挙鎖の第 3 歩：開いている選挙の立候補者の学歴・経歴 → profile_detail_gap 任務。kind=careers_missing（一件もない）は auto:profile_detail_gap:<人物 id>、kind=career_sources（出典のない項目がある）は auto:profile_detail_gap:sources:<人物 id>。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 6. 同一件事（政治人物）：same_claim_matches を分派器に、same_claim_same_content と収編触発器を拡張
-- ------------------------------------------------------------
ALTER FUNCTION policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID) RENAME TO same_claim_matches_base;

-- politician：鍵＝人物 id ＋ 事実。payload に生年があれば庫に生年があるか、education／career があれば同 kind 同文字の列があるか。
-- 事実が一つもない（探査：profile_gap／profile_detail_gap の任務を領いたとき）なら、この人の庫にある事実を全部並べる。
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches_politician(p JSONB, p_ip_hash TEXT, p_exclude UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_pid TEXT := NULLIF(p->>'politician_id', '');
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
  v_has_facts BOOLEAN := (p ? 'birth_year') OR (p ? 'education') OR (p ? 'career');
  v_birth NUMERIC := CASE WHEN jsonb_typeof(p->'birth_year') = 'number' THEN (p->>'birth_year')::NUMERIC END;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('type', 'politician', 'existing', v_existing, 'pending', v_pending);
  END IF;
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.ord), '[]'::JSONB) INTO v_existing FROM (
    SELECT 0 AS ord, jsonb_build_object('id', pp.id, 'fact', 'birth_year', 'birth_year', pp.birth_year, 'summary', pp.name || ' 生年 ' || pp.birth_year, 'why', '同じ人・庫に生年がある') AS j
      FROM policy_jp.politicians pp
     WHERE pp.id = v_pid AND pp.birth_year IS NOT NULL AND (NOT v_has_facts OR p ? 'birth_year')
    UNION ALL
    SELECT 1 + pc.id, jsonb_build_object('id', pc.id::TEXT, 'fact', pc.kind, 'text', pc.text, 'summary', pc.kind || '：' || pc.text, 'why', '同じ人・同じ種類・同じ文字の学経歴が庫にある')
      FROM policy_jp.politician_careers pc
     WHERE pc.politician_id = v_pid AND pc.review_status = 'published'
       AND (NOT v_has_facts
            OR (pc.kind = 'education' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'education') = 'array' THEN p->'education' ELSE '[]'::JSONB END) t WHERE btrim(t) = pc.text))
            OR (pc.kind = 'career' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'career') = 'array' THEN p->'career' ELSE '[]'::JSONB END) t WHERE btrim(t) = pc.text)))
  ) x;
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.created_at), '[]'::JSONB) INTO v_pending FROM (
    SELECT c.created_at, jsonb_build_object(
             'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
             'birth_year', c.payload->'birth_year', 'education', c.payload->'education', 'career', c.payload->'career',
             'summary', '生年 ' || COALESCE(c.payload->>'birth_year', '—') || '／学歴 ' || COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(c.payload->'education') = 'array' THEN c.payload->'education' END), 0)
                        || ' 件／経歴 ' || COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(c.payload->'career') = 'array' THEN c.payload->'career' END), 0) || ' 件',
             'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
             'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
               OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'politician'
       AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
       AND (p_exclude IS NULL OR c.id <> p_exclude)
       AND c.payload->>'politician_id' = v_pid
       AND (NOT v_has_facts
            OR (p ? 'birth_year' AND c.payload ? 'birth_year')
            OR (jsonb_typeof(p->'education') = 'array' AND jsonb_typeof(c.payload->'education') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p->'education') a JOIN jsonb_array_elements_text(c.payload->'education') b ON btrim(a) = btrim(b)))
            OR (jsonb_typeof(p->'career') = 'array' AND jsonb_typeof(c.payload->'career') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p->'career') a JOIN jsonb_array_elements_text(c.payload->'career') b ON btrim(a) = btrim(b))))
     LIMIT 50
  ) y;
  RETURN jsonb_build_object('type', 'politician', 'existing', v_existing, 'pending', v_pending);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches_politician IS
  '同一件事（politician）：人物 id ＋ 事実（生年・学歴・経歴の各項目）。事実がない探査では、この人の庫にある事実と審議中の提出を全部返す。same_claim_matches の分派先';

CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches(
  p_type TEXT, p_payload JSONB, p_ip_hash TEXT DEFAULT NULL, p_exclude UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician') THEN
    RETURN NULL;
  END IF;
  IF p_type = 'politician' THEN
    RETURN policy_jp.same_claim_matches_politician(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  RETURN policy_jp.same_claim_matches_base(p_type, p_payload, p_ip_hash, p_exclude);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches IS
  '同一件事（#521）の入口：型別＋payload → {existing:在庫の列, pending:審議中の提出（your_network_voted つき）}；登録のない型別＝NULL。'
  'election／regional_stat／local_government は same_claim_matches_base（20261009280000 の本体）、politician は same_claim_matches_politician。TS 登録表 _shared/same-claims.ts';

-- 収編用の「内容が同じか」：20261009280100 の版に politician の WHEN を足しただけ
CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_content(p_type TEXT, a JSONB, b JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'election' THEN (a->>'election_date', a->>'election_type', COALESCE(NULLIF(a->>'election_reason', ''), 'regular'))
                     IS NOT DISTINCT FROM (b->>'election_date', b->>'election_type', COALESCE(NULLIF(b->>'election_reason', ''), 'regular'))
    -- 数値比対は apply_regional_stat と同じ判準（NUMERIC：28.5 と 28.50 は同じ）；数字でないものは同じとみなさない
    WHEN 'regional_stat' THEN jsonb_typeof(a->'value') = 'number' AND jsonb_typeof(b->'value') = 'number'
                              AND (a->>'value')::NUMERIC = (b->>'value')::NUMERIC AND a->>'unit' IS NOT DISTINCT FROM b->>'unit'
    WHEN 'local_government' THEN (a->>'name', a->>'kana', a->>'kind') IS NOT DISTINCT FROM (b->>'name', b->>'kana', b->>'kind')
    -- 政治人物：生年・学歴・経歴が（順序を問わず）同じ
    WHEN 'politician' THEN
      (a->>'birth_year') IS NOT DISTINCT FROM (b->>'birth_year')
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'education') = 'array' THEN a->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'education') = 'array' THEN b->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'career') = 'array' THEN a->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'career') = 'array' THEN b->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
    ELSE FALSE
  END
$$;

DROP TRIGGER IF EXISTS contributions_same_claim_supersede ON policy_jp.contributions;
CREATE TRIGGER contributions_same_claim_supersede AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NEW.contribution_type IN ('election', 'regional_stat', 'local_government', 'politician'))
  EXECUTE FUNCTION policy_jp.same_claim_supersede_trg();

-- ------------------------------------------------------------
-- 7. 臂名清單と総表：20261010040000 の版本に名前 2 つ／UNION 2 行を足しただけ（残りは一字も変えない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open',
    'election_discovery',
    'local_government_missing',
    'regional_stats_missing',
    'roster_check',
    'profile_gap',
    'profile_detail_gap'
  ]::TEXT[]
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
  SELECT 'manual_visitor' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'election_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_discovery() t
  UNION ALL SELECT 'local_government_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_local_government_missing() t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t
  UNION ALL SELECT 'roster_check' AS arm, t.* FROM policy_jp.contribution_auto_tasks_roster_check() t
  UNION ALL SELECT 'profile_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_gap() t
  UNION ALL SELECT 'profile_detail_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_detail_gap() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, policy_jp.election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       -- >>> 選舉鏈：規則有 after_step 的列，要這一步在 election_chain_progress 是 done 才開；視圖在這裡只算一次，只取規則用得到的步驟
       chain AS MATERIALIZED (
  SELECT p.election_id, p.lg_code, p.step FROM policy_jp.election_chain_progress p
   WHERE p.done AND p.step IN (SELECT r.after_step FROM policy_jp.activity_rules r WHERE r.enabled AND r.after_step IS NOT NULL)
       ),
       -- <<< 選舉鏈
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until,
         (SELECT r.after_step FROM policy_jp.activity_rules r WHERE r.id = o.rule_id) AS after_step,  -- 選舉鏈：開這一組的規則掛在哪一步之後（NULL＝不在鏈上；覆寫開的也是 NULL）
         (SELECT r.params->'chain_fallback' FROM policy_jp.activity_rules r WHERE r.id = o.rule_id) AS chain_fallback  -- 選舉鏈：後備里程碑
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE policy_jp.activity_require_rule(x.arm) OFFSET 0) k
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM policy_jp.activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN w.via IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'chain_gate', CASE WHEN o.after_step IS NOT NULL THEN jsonb_build_object('after_step', o.after_step, 'via', w.via) END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, '') = COALESCE(g.eid, '') AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 選舉鏈：窗口有開（o.source）之後，規則有 after_step 的列要過 gate：前一步 done → 後備里程碑到了（fallback）→ 開過（sticky）；都不是＝擋下（NULL）
    CROSS JOIN LATERAL (SELECT CASE
           WHEN o.source IS NULL THEN NULL
           WHEN o.after_step IS NULL THEN 'none'
           WHEN EXISTS (SELECT 1 FROM chain c WHERE c.election_id = g.eid AND c.lg_code = policy_jp.activity_chain_scope(g.target) AND c.step = o.after_step) THEN 'done'
           ELSE policy_jp.activity_chain_escape(o.chain_fallback, g.eid, g.etype, g.task_id) END AS via) w
    -- <<< 選舉鏈
   WHERE (w.via IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
$$;

-- 層内排序の步驟順位：20261010040000 の版に WHEN 1 行（profile_gap／profile_detail_gap＝5）
CREATE OR REPLACE FUNCTION policy_jp.chain_step_rank(p_task_id TEXT, p_task_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_task_id IS NULL OR p_task_id NOT LIKE 'auto:%' THEN 0
           ELSE CASE p_task_type
                  WHEN 'election_discovery' THEN 1
                  WHEN 'local_government_missing' THEN 2
                  WHEN 'regional_stats_missing' THEN 3
                  WHEN 'roster_check' THEN 4
                  WHEN 'profile_gap' THEN 5
                  WHEN 'profile_detail_gap' THEN 5
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check 4、profile_gap／profile_detail_gap 5。政見（6）はここに WHEN を 1 行足す。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 8. 規則（冪等）
-- ------------------------------------------------------------
-- 窗口は永遠（always）。該場選舉に参選紀錄が出た（after_step=candidacy）か、告示日当日（後備）から開く
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, after_step, params, note)
SELECT a.activity, 'always', 'announced', 'candidacy', '{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB, a.note
  FROM (VALUES
    ('profile_gap', '選挙鎖の第 3 歩（建檔）：開いている選挙の立候補者で生年が未登録の人を、公式な紹介ページで確かめて politician を提出させる。その選挙に参選紀錄が出てから開く（人ごと）；止まっていても告示日には開く（後備）。同時に開くのは最大 200 件'),
    ('profile_detail_gap', '選挙鎖の第 3 歩（建檔）：開いている選挙の立候補者の学歴・経歴（一件もない／出典のない項目）を、公式な紹介ページで確かめて politician を提出させる。その選挙に参選紀錄が出てから開く；告示日には開く（後備）。同時に開くのは最大 200 件')
  ) AS a(activity, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:profile_gap',        'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の建檔（生年）任務（最近の選挙を先に派す）'),
    ('priority:profile_gap',        NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の建檔（生年）任務；61～180 日は既定の層（中段）'),
    ('priority:profile_detail_gap', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の建檔（学歴・経歴）任務'),
    ('priority:profile_detail_gap', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の建檔（学歴・経歴）任務；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- ------------------------------------------------------------
-- 9. 権限（新函式は既定で PUBLIC に実行権がつく。明示的に取り上げる）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.chain_profile_missing(TEXT), policy_jp.chain_profile_done(TEXT), policy_jp.chain_profile_subjects(),
  policy_jp.apply_politician(policy_jp.contributions), policy_jp.contribution_auto_tasks_profile_gap(), policy_jp.contribution_auto_tasks_profile_detail_gap(),
  policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_base(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_politician(JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.chain_profile_missing(TEXT), policy_jp.chain_profile_done(TEXT), policy_jp.chain_profile_subjects(),
  policy_jp.apply_politician(policy_jp.contributions), policy_jp.contribution_auto_tasks_profile_gap(), policy_jp.contribution_auto_tasks_profile_detail_gap(),
  policy_jp.same_claim_matches(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_base(TEXT, JSONB, TEXT, UUID), policy_jp.same_claim_matches_politician(JSONB, TEXT, UUID)
  TO service_role;

-- ------------------------------------------------------------
-- 10. 自己検査：間違えたらこの migration ごと失敗させる
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  SELECT string_agg(x.activity, ', ') INTO bad
    FROM (VALUES ('profile_gap'), ('profile_detail_gap')) AS x(activity)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = x.activity AND r.priority IS NULL AND r.enabled
                      AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些建檔臂的規則缺 after_step／chain_fallback／cap：%', bad; END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%politician%') THEN
    RAISE EXCEPTION 'policy_jp：contributions の contribution_type CHECK に politician がない';
  END IF;
  IF NOT ('politician' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に politician がない'; END IF;
  IF NOT (policy_jp.chain_step_rank('auto:profile_gap:x', 'profile_gap') > policy_jp.chain_step_rank('auto:roster_check:x', 'roster_check')) THEN
    RAISE EXCEPTION 'policy_jp：步驟順位は 名簿 < 建檔 でなければならない';
  END IF;
  IF policy_jp.same_claim_matches('politician', '{}'::JSONB) IS NULL OR policy_jp.same_claim_matches('election', '{}'::JSONB) IS NULL
     OR policy_jp.same_claim_matches('candidacy', '{}'::JSONB) IS NOT NULL THEN
    RAISE EXCEPTION 'policy_jp：same_claim_matches の分派が壊れている（politician／election は結果を返し、candidacy は NULL）';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_politician(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.chain_profile_missing(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_profile_gap()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_profile_detail_gap()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.same_claim_matches_base(text, jsonb, text, uuid)', 'EXECUTE')
     OR has_table_privilege('anon', 'policy_jp.election_chain_progress', 'SELECT') THEN
    RAISE EXCEPTION 'policy_jp：選舉鏈（第 3 步）の関数・ビューを anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
