-- 日本站「告示前の読み（kana）は選填」と roster_check の冷卻を告示日で打ち切る（工作單 Yooliang/policy-ops#60）
-- ============================================================
--
-- 決定：policy-ops docs/decisions/2026-10-10-日本站告示前讀音選填.md。
-- 背景：告示前（表明段階）は本人・政党・報道に読みが出ないことが多く、kana 必須のせいで「名簿に名前はあるのに交件できない」人が出ていた。
--
-- 這支做的事（前一版＝緊接在前最新的定義；機械替換的對照在 policy-jp-kana-optional.test.ts）：
-- 1. politicians.kana の NOT NULL を外す（欄位は消さない。CHECK btrim(kana) <> '' は NULL を通すので残す＝空文字は入らない）。
-- 2. candidacy の kana：告示日（election_milestones_all の announced、apply_candidacy と同じ読み方）より前は任意、告示日以降は必須。
--    告示日の記録がない選挙は告示前扱い。判定は SQL 関数 candidacy_kana_required に一本化（SQL 落庫と TS 入口〔contribute-handler〕が同じ関数）。
--    politician_id を付けた candidacy（既にいる人）は kana 不要。いる人に読みがなくて今回付いたときは空欄を埋める（既にある読みは上書きしない）。
-- 3. 同一人の判定 candidacy_match_politicians：読みがないときは「同じ漢字の名前＋同じ団体に参選か任期＋生年が衝突しない」だけで絞り、
--    唯一命中のときだけ同一人、0 人・複数は新しい人（推測しない）。読みがあるときは従来どおり（読み一致を優先、読みなしの人は生年と同じく衝突扱いにしない）。
-- 4. 読みがない人：profile_gap 臂の缺口に kana を足す（target.missing に "kana"）、politician 交件に kana（空欄を埋めるだけ。
--    違う値＝生年と同じく conflict で差し戻し）、same_claim は kana を生年と同じ扱い、鏈の profile 完了判定（chain_profile_missing／done）にも kana を入れる。
--    kana が NULL の人を扱う他の臂（profile_detail_gap、policy_missing）の説明文は NULL になって seed が落ちないよう、読みの部分だけ NULL 安全にする。
-- 5. roster_check の not_found の冷卻：min(14 日, 告示日の前日まで)。告示日当日にもう一度派す。confirmed・unreachable・他の任務は変えない。
--    冷卻の計算は三か所ある（refresh_dispatch_blocked＝task_dispatches.cooling、task_unavailable＝臂の排除、chain_task_checked＝鏈 roster 步驟の done）。
--    三か所とも同じ小さな関数 roster_not_found_released（「この not_found はもう冷卻に数えない」）を足すだけにして、定義を一つにする。
--    refresh_dispatch_blocked は正見の複本なので、policy-jp-dispatch-drift.test.ts の DEVIATED（日本專屬の偏離）に登記して一か所の差分だけを許す。
--    告示日より後に報告された not_found は従来どおり 14 日（上限をかけない）。
-- 6. roster_check の説明文：出典は「告示前は報道・本人や政党の発信で可、告示後は選管の公表を優先」。kana の規則と not_found の再確認も書く。
--
-- 冪等：全部 CREATE OR REPLACE／DROP NOT NULL（何度流しても同じ）。協議版號は _shared/jp/protocol.ts 0.11.0。
-- 不碰 public、ditrust。

-- ------------------------------------------------------------
-- 1. 欄位：kana の NOT NULL を外す（CHECK は残す：NULL は通る、空文字・空白だけは入らない）
-- ------------------------------------------------------------
ALTER TABLE policy_jp.politicians ALTER COLUMN kana DROP NOT NULL;
COMMENT ON TABLE policy_jp.politicians IS '人物。不存職稱、地區、簡介。同一人＝kana＋地區（任期或參選的 lg_code）＋birth_year 三者相同；不能只用漢字姓名。告示前に読みなしで建つ人がいる（kana は NULL になりうる。告示日以降の candidacy は kana 必須）';

-- ------------------------------------------------------------
-- 2. 告示日と kana 必須の判定（SQL 落庫と TS 入口が同じ関数を見る）
-- ------------------------------------------------------------
-- 選挙の告示日：里程碑 announced（整場）。表の列が優先、無ければ elections.notice_date が併進した列。無ければ NULL
CREATE OR REPLACE FUNCTION policy_jp.election_notice_date(p_election_id TEXT) RETURNS DATE
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT m.on_date FROM policy_jp.election_milestones_all m
   WHERE m.election_id = p_election_id AND m.kind = 'announced' AND m.election_type IS NULL
   ORDER BY (m.origin = 'table') DESC, m.on_date LIMIT 1
$$;
COMMENT ON FUNCTION policy_jp.election_notice_date IS '選挙の告示日（election_milestones_all の announced・整場。里程碑表の列が優先、無ければ elections.notice_date）；記録がなければ NULL';

-- 告示日以降か（その選挙の candidacy に kana が要るか）。告示日の記録がない選挙は告示前扱い（false）
CREATE OR REPLACE FUNCTION policy_jp.candidacy_kana_required(p_election_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT COALESCE(policy_jp.activity_today() >= policy_jp.election_notice_date(p_election_id), false)
$$;
COMMENT ON FUNCTION policy_jp.candidacy_kana_required IS 'candidacy に kana が要るか：告示日（election_notice_date）以降なら true。告示日の記録がなければ false（告示前扱い）。apply_candidacy と jp-report の入口が共有';

-- ------------------------------------------------------------
-- 3. roster_check の not_found の冷卻を告示日で打ち切る（三か所の冷卻計算が共有する一つの判定）
-- ------------------------------------------------------------
-- 「この roster_check の not_found は、もう冷卻に数えない」：
--   outcome が not_found の roster_check で、報告した日（東京）が告示日より前、かつ今日が告示日以降。
--   ＝ 冷卻は min(14 日, 告示日の前日まで)。14 日のほうは各所の既存の式がそのまま見る。
--   告示日以降に報告された not_found は上限をかけない（従来どおり 14 日）。告示日の記録がない選挙も従来どおり。
CREATE OR REPLACE FUNCTION policy_jp.roster_not_found_released(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN p_outcome = 'not_found' AND p_task_id LIKE 'auto:roster_check:%'
              THEN COALESCE((SELECT policy_jp.activity_today() >= x.nd AND (p_checked_at AT TIME ZONE 'Asia/Tokyo')::DATE < x.nd
                               FROM (SELECT policy_jp.election_notice_date(substring(p_task_id FROM 19)) AS nd) x), false)
              ELSE false END
$$;
COMMENT ON FUNCTION policy_jp.roster_not_found_released IS
  'roster_check（auto:roster_check:<選挙 id>）の not_found を、告示日が来たので冷卻に数えないか。冷卻＝min(14 日, 告示日の前日まで)の「告示日」の側。refresh_dispatch_blocked・task_unavailable・chain_task_checked が共有。confirmed／unreachable／他の任務は常に false';


CREATE OR REPLACE FUNCTION policy_jp.chain_task_checked(p_task_id TEXT, p_outcomes TEXT[] DEFAULT ARRAY['confirmed', 'not_found']) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT max(tc.checked_at) FROM policy_jp.task_checks tc
   WHERE tc.task_id = p_task_id AND tc.outcome = ANY (p_outcomes)
     AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
     AND NOT policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)  -- roster_check の not_found だけ、告示日で冷卻を打ち切る（工作單 policy-ops#60）
$$;

COMMENT ON FUNCTION policy_jp.chain_task_checked IS '選舉鏈進度用：這個任務有人回報查過（outcome 預設 confirmed／not_found）而且還在冷卻中的最近時間；沒有＝NULL。roster_check の not_found は告示日（roster_not_found_released）で冷卻が打ち切られ、そこから先は「查過」に数えない';

CREATE OR REPLACE FUNCTION policy_jp.task_unavailable(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  -- 1. 飽和：在途（pending／verified／disputed）的交件 ≥ 5 筆（同 refresh_dispatch_blocked 的 saturated）
  SELECT (SELECT COUNT(*) FROM policy_jp.contributions c WHERE c.task_id = p_task_id AND c.status IN ('pending', 'verified', 'disputed')) >= 5
      -- 2. 「查了，沒有異動／查無」還在等票或已通過、還沒落庫（同 refresh_dispatch_blocked 的 nochange）
      OR EXISTS (SELECT 1 FROM policy_jp.contributions c
                  WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = p_task_id)
      -- 3. 冷卻中：最近查過（同 refresh_dispatch_blocked 的 cool：unreachable 2 天、其餘 14 天）
      OR EXISTS (SELECT 1 FROM policy_jp.task_checks tc
                  WHERE tc.task_id = p_task_id
                    AND tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL
                    AND NOT policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at))  -- roster_check の not_found だけ告示日で打ち切る（工作單 policy-ops#60）
      -- 4. 資料型交件已通過驗證、等著落庫（團體還沒進來時會等）：答案已經有了，不要再派人重查
      OR EXISTS (SELECT 1 FROM policy_jp.contributions c
                  WHERE c.task_id = p_task_id AND c.status = 'verified' AND c.contribution_type IN ('election', 'local_government', 'regional_stat'))
$$;

COMMENT ON FUNCTION policy_jp.task_unavailable IS '任務現在不能派（飽和／no_change 等票或已通過／冷卻中／資料型交件通過等落庫）。派工臂在 LIMIT cap 之前用它排除，cap 才是「可派的前 N 筆」（#503）。前三項與 refresh_dispatch_blocked 同一個定義（roster_check の not_found の告示日打ち切りも同じ）';

CREATE OR REPLACE FUNCTION policy_jp.refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  WITH saturated AS (
    SELECT c.task_id FROM policy_jp.contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM policy_jp.contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
  )
  , cool AS (
    SELECT DISTINCT tc.task_id FROM policy_jp.task_checks tc
    WHERE tc.checked_at > now() - (
      CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days'
    )::INTERVAL
      AND NOT policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る
  )
  UPDATE policy_jp.task_dispatches d
     SET blocked = EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id),
         cooling = EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id)
   WHERE d.task_id LIKE 'auto:%'
     AND (d.blocked IS DISTINCT FROM EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)
       OR d.cooling IS DISTINCT FROM EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 4. 同一人の判定：読みがないときは名前＋団体＋生年だけで絞る
-- ------------------------------------------------------------
-- 読みあり：読みが一致する人を優先、いなければ庫に読みがない人（生年と同じ「任一邊空白不算衝突」）。読みの違う人は別人。
-- 読みなし：同じ漢字の名前・同じ団体に参選か任期・生年が衝突しない人を全員返す（読みの違いでは絞れない）。呼び出し側が唯一命中だけを同一人とする
CREATE OR REPLACE FUNCTION policy_jp.candidacy_match_politicians(p_name TEXT, p_kana TEXT, p_birth_year INTEGER, p_lg_code TEXT) RETURNS TEXT[]
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH k AS (SELECT NULLIF(btrim(COALESCE(p_kana, '')), '') AS kana),
  base AS (
    SELECT p.id, p.kana, p.created_at FROM policy_jp.politicians p
     WHERE p.name = btrim(p_name)
       AND (p.birth_year IS NULL OR p_birth_year IS NULL OR p.birth_year = p_birth_year)
       AND (EXISTS (SELECT 1 FROM policy_jp.politician_elections pe JOIN policy_jp.elections e ON e.id = pe.election_id
                     WHERE pe.politician_id = p.id AND e.lg_code IS NOT DISTINCT FROM p_lg_code)
            OR EXISTS (SELECT 1 FROM policy_jp.politician_offices o WHERE o.politician_id = p.id AND o.lg_code IS NOT DISTINCT FROM p_lg_code))
  ),
  exact AS (SELECT b.id, b.created_at FROM base b, k WHERE k.kana IS NOT NULL AND b.kana = k.kana),
  pick AS (
    SELECT id, created_at FROM exact
    UNION ALL
    SELECT b.id, b.created_at FROM base b, k
     WHERE NOT EXISTS (SELECT 1 FROM exact) AND (k.kana IS NULL OR b.kana IS NULL)
  )
  SELECT COALESCE(array_agg(id ORDER BY created_at, id), '{}'::TEXT[]) FROM pick
$$;
COMMENT ON FUNCTION policy_jp.candidacy_match_politicians IS '同一人の判定（SCHEMA.md：kana＋地區＋birth_year）：同名・生年が衝突しない（任一邊空白不算衝突）・同じ団体に参選か任期がある人の id 陣列。読みがあるときは読み一致を優先（いなければ庫に読みのない人）、読みがないときは読みで絞らない（唯一命中だけを同一人にするのは呼び出し側）';


CREATE OR REPLACE FUNCTION policy_jp.apply_candidacy(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_eid TEXT := NULLIF(btrim(COALESCE(p->>'election_id', '')), '');
  v_status TEXT := p->>'candidacy_status';
  v_date DATE;
  v_kind TEXT := p->>'district_kind';
  v_dname TEXT := NULLIF(btrim(COALESCE(p->>'district_name', '')), '');
  v_dlg TEXT := NULLIF(p->>'district_lg_code', '');
  v_rank INTEGER;
  v_wd BOOLEAN;
  v_pid TEXT := NULLIF(btrim(COALESCE(p->>'politician_id', '')), '');
  v_name TEXT := btrim(COALESCE(p->>'name', ''));
  v_kana TEXT := btrim(COALESCE(p->>'kana', ''));
  v_birth INTEGER;
  v_notice DATE;
  v_prim BIGINT;
  v_ids TEXT[];
  v_new_person BOOLEAN := false;
  v_n INTEGER;
  v_peid TEXT;
  e policy_jp.elections%ROWTYPE;
  pe policy_jp.politician_elections%ROWTYPE;
  pe_new policy_jp.politician_elections%ROWTYPE;
  v_src BIGINT;
BEGIN
  -- 得票數・得票率は受け付けない（CLAUDE.md：存わない）。TS の検証が先に 400 で止めるが、直接入った行もここで退件する
  IF p ?| ARRAY['votes', 'vote_count', 'votes_received', 'vote_percentage', 'vote_rate', 'vote_share', 'turnout'] THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '得票數・得票率は記録しない（payload から取り除いて出し直す）');
  END IF;
  IF v_eid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_id がない');
  END IF;
  SELECT * INTO e FROM policy_jp.elections WHERE id = v_eid;
  IF NOT FOUND OR e.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('選挙 %s は登録されていないか、まだ公開されていない（先に election の提出が必要）', v_eid));
  END IF;
  IF policy_jp.candidacy_status_rank(v_status) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'candidacy_status は considering／declared／filed／withdrawn／elected／not_elected のどれか');
  END IF;
  -- 日付：形狀、真的有這一天、1947～2100（PostgreSQL は 0000 年を受け付けない）
  IF p->>'status_date' IS NULL OR p->>'status_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'status_date は YYYY-MM-DD');
  END IF;
  BEGIN
    v_date := (p->>'status_date')::DATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'status_date が実在しない日付');
  END;
  IF v_date NOT BETWEEN DATE '1947-01-01' AND DATE '2100-12-31' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'status_date は 1947～2100 年の間');
  END IF;
  IF v_status IN ('elected', 'not_elected') AND v_date < e.election_date THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s の status_date（%s）が投票日（%s）より前', v_status, v_date, e.election_date));
  END IF;
  -- 告示日は里程碑の announced を読む（elections.notice_date は視圖が併進し、里程碑表に整場の announced 列があればそちらが勝つ＝維持者の上書きが効く）
  SELECT m.on_date INTO v_notice FROM policy_jp.election_milestones_all m
   WHERE m.election_id = e.id AND m.kind = 'announced' AND m.election_type IS NULL ORDER BY (m.origin = 'table') DESC, m.on_date LIMIT 1;
  IF v_status = 'filed' AND (v_date > e.election_date OR (v_notice IS NOT NULL AND v_date < v_notice)) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('filed（届出）の status_date（%s）は告示日（%s）以降・投票日（%s）以前', v_date, COALESCE(v_notice::TEXT, '未記'), e.election_date));
  END IF;
  IF v_status IN ('considering', 'declared') AND v_date > e.election_date THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s の status_date（%s）が投票日（%s）より後', v_status, v_date, e.election_date));
  END IF;
  -- 選挙区
  IF COALESCE(v_kind, '') NOT IN ('district', 'proportional', 'at_large') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'district_kind は district／proportional／at_large のどれか');
  END IF;
  IF (v_kind = 'at_large') <> (v_dname IS NULL) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'district_kind=at_large のときは district_name を付けず、それ以外は district_name が要る');
  END IF;
  IF v_dlg IS NOT NULL AND (v_kind <> 'district' OR NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = v_dlg)) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'district_lg_code は district_kind=district のときだけ、local_governments にある団体コードで');
  END IF;
  IF p ? 'list_rank' THEN
    IF jsonb_typeof(p->'list_rank') <> 'number' OR (p->>'list_rank')::NUMERIC <> trunc((p->>'list_rank')::NUMERIC) OR (p->>'list_rank')::NUMERIC < 1 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'list_rank は 1 以上の整数');
    END IF;
    v_rank := (p->>'list_rank')::INTEGER;
    IF v_kind <> 'proportional' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'list_rank（名簿順位）は district_kind=proportional のときだけ');
    END IF;
  END IF;
  IF p ? 'withdrawn_after_filing' THEN
    IF jsonb_typeof(p->'withdrawn_after_filing') <> 'boolean' OR v_status <> 'withdrawn' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'withdrawn_after_filing は true／false で、candidacy_status=withdrawn のときだけ');
    END IF;
    v_wd := (p->>'withdrawn_after_filing')::BOOLEAN;
  END IF;
  IF p ? 'birth_year' AND jsonb_typeof(p->'birth_year') <> 'null' THEN
    IF jsonb_typeof(p->'birth_year') <> 'number' OR (p->>'birth_year')::NUMERIC <> trunc((p->>'birth_year')::NUMERIC) OR (p->>'birth_year')::NUMERIC NOT BETWEEN 1900 AND 2100 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'birth_year は 1900～2100 の整数（西暦）');
    END IF;
    v_birth := (p->>'birth_year')::INTEGER;
  END IF;

  -- 人物：politician_id が最優先、なければ name＋kana で同一人を探す
  IF v_pid IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM policy_jp.politicians x WHERE x.id = v_pid) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('politician_id %s は politicians にない', v_pid));
    END IF;
  ELSE
    IF v_name = '' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_id がないときは name が要る');
    END IF;
    -- kana（工作單 policy-ops#60）：告示前は任意、告示日以降は必須（告示日の記録がない選挙は告示前扱い。TS の入口でも同じ関数で 400 にする）
    IF v_kana = '' AND policy_jp.candidacy_kana_required(e.id) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('告示日（%s）以降の candidacy は kana（ひらがな）が要る（省略できるのは告示前だけ）', v_notice));
    END IF;
    v_ids := policy_jp.candidacy_match_politicians(v_name, v_kana, v_birth, e.lg_code);
    IF cardinality(v_ids) > 1 AND v_kana <> '' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('同名同読み・同じ団体の人物が複数いて特定できない（%s）：politician_id を指定して出し直す', array_to_string(v_ids, '、')));
    END IF;
    -- 読みがないときは「同じ漢字の名前・同じ団体・生年が衝突しない」人が一人だけのときに限って同一人。複数いる・いないは新しい人（推測しない）
    IF cardinality(v_ids) = 1 THEN v_pid := v_ids[1]; ELSE v_new_person := true; END IF;
  END IF;

  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'candidacy');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  IF v_new_person THEN
    v_pid := gen_random_uuid()::TEXT;
    INSERT INTO policy_jp.politicians (id, name, kana, birth_year, review_status) VALUES (v_pid, v_name, NULLIF(v_kana, ''), v_birth, 'published');
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politicians', v_pid, '*', NULL, (SELECT to_jsonb(x) FROM policy_jp.politicians x WHERE x.id = v_pid), c.id, 'auto-apply');
    PERFORM policy_jp.source_write('politicians', v_pid, c.source_urls, 'candidacy');
  END IF;

  v_peid := v_pid || ':' || v_eid || ':' || v_kind;
  SELECT * INTO pe FROM policy_jp.politician_elections WHERE politician_id = v_pid AND election_id = v_eid AND district_kind = v_kind;
  IF FOUND THEN
    IF pe.district_name IS DISTINCT FROM v_dname THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politician_elections', 'record_id', pe.id,
        'message', format('庫裡的 %s は選挙区が「%s」で、提出の「%s」と違う。選挙区は上書きしない', pe.id, COALESCE(pe.district_name, '（なし）'), COALESCE(v_dname, '（なし）')));
    END IF;
    IF pe.candidacy_status = v_status THEN
      -- 読みの空欄埋めは衝突チェックを通ってから（conflict で差し戻すときに読みだけ書き込まれる半端を防ぐ。#564 審查）
      IF NOT v_new_person AND v_kana <> '' THEN
        UPDATE policy_jp.politicians SET kana = v_kana WHERE id = v_pid AND kana IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
          INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
          VALUES ('politicians', v_pid, 'kana', NULL, to_jsonb(v_kana), c.id, 'auto-apply');
          PERFORM policy_jp.source_write('politicians', v_pid, c.source_urls, 'candidacy');
        END IF;
      END IF;

      PERFORM policy_jp.source_write('politician_elections', pe.id, c.source_urls, 'candidacy');
      RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politician_elections', 'record_id', pe.id, 'message', format('%s は庫に同じ状態（%s）で既にある', pe.id, v_status));
    END IF;
    IF pe.candidacy_status IN ('elected', 'not_elected', 'withdrawn')
       OR policy_jp.candidacy_status_rank(v_status) < policy_jp.candidacy_status_rank(pe.candidacy_status)
       OR v_date < pe.status_date THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politician_elections', 'record_id', pe.id,
        'message', format('庫の %s は %s（%s）。提出の %s（%s）は後戻り・終点の付け替え・日付の巻き戻しで、上書きしない', pe.id, pe.candidacy_status, pe.status_date, v_status, v_date));
    END IF;
    -- 読みの空欄埋めは衝突チェックを通ってから（conflict で差し戻すときに読みだけ書き込まれる半端を防ぐ。#564 審查）
    IF NOT v_new_person AND v_kana <> '' THEN
      UPDATE policy_jp.politicians SET kana = v_kana WHERE id = v_pid AND kana IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('politicians', v_pid, 'kana', NULL, to_jsonb(v_kana), c.id, 'auto-apply');
        PERFORM policy_jp.source_write('politicians', v_pid, c.source_urls, 'candidacy');
      END IF;
    END IF;

    UPDATE policy_jp.politician_elections
       SET candidacy_status = v_status, status_date = v_date,
           withdrawn_after_filing = CASE WHEN v_status = 'withdrawn' THEN v_wd ELSE NULL END,
           list_rank = COALESCE(v_rank, list_rank)
     WHERE id = pe.id
    RETURNING * INTO pe_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_elections', pe.id, 'candidacy_status', to_jsonb(pe.candidacy_status), to_jsonb(pe_new.candidacy_status), c.id, 'auto-apply'),
           ('politician_elections', pe.id, 'status_date', to_jsonb(pe.status_date), to_jsonb(pe_new.status_date), c.id, 'auto-apply');
    PERFORM policy_jp.source_write('politician_elections', pe.id, c.source_urls, 'candidacy');
    -- 状態が変わったので『目前狀態の出處』は新しい出處が主要になる（古い主要は佐證に降ろす。正見 source_set_primary の考え方）
    v_prim := policy_jp.source_write('politician_election_status', pe.id, c.source_urls, 'candidacy');
    IF v_prim IS NOT NULL THEN
      UPDATE policy_jp.source_refs SET role = 'supporting' WHERE target_table = 'politician_election_status' AND target_id = pe.id AND role = 'primary' AND source_id <> v_prim;
      UPDATE policy_jp.source_refs SET role = 'primary' WHERE target_table = 'politician_election_status' AND target_id = pe.id AND source_id = v_prim;
    END IF;
    UPDATE policy_jp.contributions SET applied_politician_id = v_pid WHERE id = c.id;
    RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politician_elections', 'record_id', pe.id,
      'message', format('%s の状態を %s → %s に更新', pe.id, pe.candidacy_status, v_status));
  END IF;

  -- 読みの空欄埋めは衝突チェックを通ってから（conflict で差し戻すときに読みだけ書き込まれる半端を防ぐ。#564 審查）
  IF NOT v_new_person AND v_kana <> '' THEN
    UPDATE policy_jp.politicians SET kana = v_kana WHERE id = v_pid AND kana IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', v_pid, 'kana', NULL, to_jsonb(v_kana), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('politicians', v_pid, c.source_urls, 'candidacy');
    END IF;
  END IF;

  INSERT INTO policy_jp.politician_elections (id, politician_id, election_id, candidacy_status, withdrawn_after_filing, status_date, district_kind,
                                              district_name, district_lg_code, list_rank, review_status)
  VALUES (v_peid, v_pid, v_eid, v_status, v_wd, v_date, v_kind, v_dname, v_dlg, v_rank, 'published')
  RETURNING * INTO pe_new;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politician_elections', v_peid, '*', NULL, to_jsonb(pe_new), c.id, 'auto-apply');
  PERFORM policy_jp.source_write('politician_elections', v_peid, c.source_urls, 'candidacy');
  PERFORM policy_jp.source_write('politician_election_status', v_peid, c.source_urls, 'candidacy');
  UPDATE policy_jp.contributions SET applied_politician_id = v_pid WHERE id = c.id;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politician_elections', 'record_id', v_peid,
    'message', format('%s（%s）の参選を追加：%s %s', COALESCE(NULLIF(v_name, ''), v_pid), v_eid, v_status, v_date));
END;
$$;

COMMENT ON FUNCTION policy_jp.apply_candidacy IS
  'candidacy 交件の落庫（politician_elections。新しい人なら politicians も）。同じ状態＝unchanged、後戻り・終点の付け替え・日付の巻き戻し・選挙区違い＝conflict（退件）、内容の不備＝invalid（退件）。得票數は受け付けない。kana は告示前は任意・告示日以降は必須（policy-ops#60）、読みがないときの同一人は「同名・同団体・生年が衝突しない人が一人だけ」';

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
  v_kana TEXT;
  v_kana_set BOOLEAN := false;
  v_has_src BOOLEAN;
  v_src BIGINT;
  v_year INTEGER := EXTRACT(YEAR FROM policy_jp.activity_today())::INTEGER;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_id がない（politician は既存の人にだけ足す。新しい人は candidacy で作る）');
  END IF;
  IF p ? 'name' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '名前は politician では直さない（correction で出し直す）');
  END IF;
  SELECT * INTO v_row FROM policy_jp.politicians WHERE id = v_pid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('politician_id %s は politicians にない', v_pid));
  END IF;
  IF NOT (p ? 'birth_year' OR p ? 'kana' OR p ? 'education' OR p ? 'career') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'birth_year・kana・education・career のどれか一つは要る');
  END IF;
  -- 読み（kana、工作單 policy-ops#60）：空欄を埋めるだけ。庫に読みがあって違う値＝生年と同じく conflict（上書きしない）
  IF p ? 'kana' THEN
    IF jsonb_typeof(p->'kana') <> 'string' OR btrim(p->>'kana') = '' OR char_length(btrim(p->>'kana')) > 80 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'kana は 1～80 字の文字列（ひらがな）');
    END IF;
    v_kana := btrim(p->>'kana');
    IF v_row.kana IS NOT NULL AND v_row.kana <> v_kana THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politicians', 'record_id', v_pid,
        'message', format('庫の %s は読み「%s」で、提出の「%s」と違う。上書きしない（直すなら correction）', v_pid, v_row.kana, v_kana));
    END IF;
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

  -- 読み：空欄だけ埋める（違う値は上で conflict にしてある）。同じ値なら出処だけ足す
  IF v_kana IS NOT NULL THEN
    IF v_row.kana IS NULL THEN
      UPDATE policy_jp.politicians SET kana = v_kana WHERE id = v_pid;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', v_pid, 'kana', NULL, to_jsonb(v_kana), c.id, 'auto-apply');
      v_kana_set := true;
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
  IF NOT v_birth_set AND NOT v_kana_set AND v_new_careers = 0 AND v_attached = 0 THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politicians', 'record_id', v_pid, 'message', format('%s は庫に同じ内容で既にある', v_pid));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politicians', 'record_id', v_pid,
    'message', format('%s：生年%s、読み%s、学経歴 %s 件を追加、既存 %s 件に出処を付けた', v_pid, CASE WHEN v_birth_set THEN 'を登録' ELSE 'は変更なし' END,
                      CASE WHEN v_kana_set THEN 'を登録' ELSE 'は変更なし' END, v_new_careers, v_attached));
END;
$$;

COMMENT ON FUNCTION policy_jp.apply_politician IS
  'politician 交件の落庫（既存の人に生年・読み・学経歴を足す）。生年と読みは空欄だけ埋める（違う値＝conflict）、学経歴は一条一項で insert（同じ文字の既存項目には出処だけ足す）、同じ内容＝unchanged、不備＝invalid';

CREATE OR REPLACE FUNCTION policy_jp.chain_profile_missing(p_politician_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT NULLIF(jsonb_strip_nulls(jsonb_build_object(
           'birth_year', CASE WHEN p.birth_year IS NULL THEN true END,
           'kana', CASE WHEN p.kana IS NULL THEN true END,  -- 告示前に読みなしで建った人（工作單 policy-ops#60）
           'careers', CASE WHEN NOT EXISTS (SELECT 1 FROM policy_jp.politician_careers c WHERE c.politician_id = p.id AND c.review_status = 'published') THEN true END,
           'career_sources', (SELECT jsonb_agg(c.text ORDER BY c.kind, c.sort_order, c.id)
                                FROM policy_jp.politician_careers c
                               WHERE c.politician_id = p.id AND c.review_status = 'published'
                                 AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = 'politician_careers' AND r.target_id = c.id::TEXT)))),
         '{}'::JSONB)
    FROM policy_jp.politicians p WHERE p.id = p_politician_id
$$;

COMMENT ON FUNCTION policy_jp.chain_profile_missing IS '人物の建檔の缺口（birth_year／kana／careers／career_sources）；齊了＝NULL。profile_gap・profile_detail_gap 臂と election_chain_progress の profile が共有';

CREATE OR REPLACE FUNCTION policy_jp.chain_profile_done(p_politician_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.politicians WHERE id = p_politician_id) AND COALESCE(
    (m IS NULL)
    OR (  (NOT (m ? 'birth_year' OR m ? 'kana') OR policy_jp.chain_task_checked('auto:profile_gap:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)
      AND (NOT (m ? 'careers')         OR policy_jp.chain_task_checked('auto:profile_detail_gap:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)
      AND (NOT (m ? 'career_sources')  OR policy_jp.chain_task_checked('auto:profile_detail_gap:sources:' || p_politician_id, ARRAY['not_found']) IS NOT NULL)),
    false)
    FROM (SELECT policy_jp.chain_profile_missing(p_politician_id) AS m) x
$$;

COMMENT ON FUNCTION policy_jp.chain_profile_done IS '人物の建檔が済んでいるか：缺口なし、または缺口ごとに no_change(not_found) が冷卻中（生年と読みは同じ auto:profile_gap の一件）。人物が存在しなければ false';

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
     WHERE p.cap IS NOT NULL AND (s.birth_year IS NULL OR s.kana IS NULL)
       AND NOT policy_jp.task_unavailable('auto:profile_gap:' || s.politician_id)
       -- 足りないもの（生年・読み）を全部足した提出が審議中なら、もう一度派さない（落ちれば戻ってくる）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'politician' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.payload->>'politician_id' = s.politician_id
                          AND (s.birth_year IS NOT NULL OR c.payload ? 'birth_year') AND (s.kana IS NOT NULL OR c.payload ? 'kana'))
     ORDER BY s.election_date, s.kana, s.politician_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:profile_gap:' || g.politician_id, 'profile_gap',
         jsonb_build_object('politician_id', g.politician_id, 'name', g.name, 'kana', g.kana, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'candidacy_status', g.candidacy_status,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN g.birth_year IS NULL THEN 'birth_year' END, CASE WHEN g.kana IS NULL THEN 'kana' END], NULL)),
                            'chain_lg_code', g.lg_code, 'chain_step', 'profile'),
         g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || ' ' || g.election_id || ' の立候補者）の'
           || CASE WHEN g.birth_year IS NULL AND g.kana IS NULL THEN '生年と読み（kana）が' WHEN g.birth_year IS NULL THEN '生年が' ELSE '読み（kana）が' END || '未登録です。'
           || CASE WHEN g.birth_year IS NULL THEN
                '同じ人かどうかは「読み＋地域＋生年」で判断するため、生年が分かると同姓同名の取り違えを防げます。'
                || '本人の公式サイト・議会や自治体の公式な紹介ページ・選管の公表資料で生年（西暦）を確かめ、'
              ELSE '' END
           || CASE WHEN g.kana IS NULL THEN
                '読み（kana）は告示前の表明段階では分からないまま登録された人です（告示日以降の届出では必須）。本人の公式サイト・選管の公表資料・政党の発表などで正式な読みをひらがなで確かめ、'
              ELSE '' END
           || 'contribution_type=politician で提出してください。'
           || 'payload は politician_id（' || g.politician_id || '）・'
           || CASE WHEN g.birth_year IS NULL THEN 'birth_year（西暦の 4 桁整数）・' ELSE '' END
           || CASE WHEN g.kana IS NULL THEN 'kana（ひらがな）・' ELSE '' END
           || 'resolved_claim（item.current.same_claims を見て決める。'
           || '誰も提出していなければ "new"）。分からないものがあるときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測しない）。'
           || '年齢から逆算した値・報道の「推定」は使いません。',
         ARRAY[g.lg_name || ' 公式サイトの立候補者紹介', '候補者本人の公式サイト', g.pref_name || ' 選挙管理委員会', '議会の議員紹介ページ']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;

COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_profile_gap IS
  '選挙鎖の第 3 歩：開いている選挙の立候補者で生年か読み（kana）が未登録の人 → profile_gap 任務（task_id＝auto:profile_gap:<人物 id>、target.missing に birth_year／kana）。審議中の提出が足りないものを全部足している人は派さない。params.cap は可派の前 N 件';

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
             g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || ' ' || g.election_id || ' の立候補者）の学歴・経歴がまだ登録されていません。'
               || '議会・自治体・選管の公式な紹介ページ、候補者本人の公式サイト（プロフィール欄）で確かめ、contribution_type=politician で提出してください。'
               || 'payload は politician_id（' || g.politician_id || '）・education（学歴の配列）・career（職歴・経歴の配列、一条一項）と resolved_claim。'
               || '配列の各項目は原文どおり 1 項目 1 文字列（例 education: ["○○大学法学部卒業"]）。説明文のなかに混ぜた書き方は取りません。'
               || '見つからないときは no_change、outcome=not_found で、探した場所を checked_urls に入れて報告してください（推測しない）。'
               || 'フェイスブック・Instagram・Threads は内容を読み取れないため出典になりません。'
           ELSE
             g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || ' ' || g.election_id || ' の立候補者）の学歴・経歴のうち ' || jsonb_array_length(g.missing->'career_sources')
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

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_policy_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'policy_missing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*,
           -- 審議中の公約の題名（重複して出さないため。正見の queued_policies）
           COALESCE((SELECT jsonb_agg(DISTINCT c.payload->>'title') FROM policy_jp.contributions c
                      WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                        AND c.payload->>'politician_election_id' = s.politician_election_id), '[]'::JSONB) AS queued
      FROM policy_jp.chain_policy_subjects() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.chain_policy_exists(s.politician_election_id)
       AND NOT policy_jp.task_unavailable('auto:policy_missing:' || s.politician_election_id)
     ORDER BY s.election_date, s.kana, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:policy_missing:' || g.politician_election_id, 'policy_missing',
         jsonb_build_object('politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'queued_policies', g.queued,
                            'chain_lg_code', g.lg_code, 'chain_step', 'policy'),
         g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）の公約がまだ 1 件も登録されていません。'
           || '選挙公報（選挙管理委員会のページ）・候補者本人の公式サイト・公式な政策パンフレットから、この候補者が掲げた具体的な公約を探してください。'
           || '1 件ずつ contribution_type=policy で提出します（最大 5 件、見つかった数だけ。1 件でも構いません。スローガン・理念・人柄の話は公約ではないので出さない）。'
           || 'payload は politician_election_id（' || g.politician_election_id || '）・title（4～100 字）・description（要約：120 字以内、事実だけ。原文の修辞は写さない）・'
           || 'category（分野、例：子育て・防災・交通）・source_locator（原文のどこか：公報の頁や見出し。必須）・resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）、'
           || '分かれば proposed_date（公約が公表された日）。source_urls はその公約が書かれたページ（選挙公報・候補者の公式サイト）。'
           || '審議中の同じ公約（target.queued_policies：' || COALESCE((SELECT string_agg(q, '、') FROM jsonb_array_elements_text(g.queued) q), 'なし') || '）は重複して出さないでください。'
           || '日付の進め方：告示日は ' || COALESCE(g.notice_date::TEXT, '未記録') || '、選挙公報は告示日以降に出ます。公約が見つからない・まだ公表されていないときは、'
           || 'contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測や他人の公約の流用をしない）。'
           || '得票数・当落の予想は書きません。',
         ARRAY[g.lg_name || ' 選挙管理委員会の選挙公報', '候補者本人の公式サイト・公式パンフレット', g.pref_name || ' 選挙管理委員会', '政党の公認・推薦候補の発表ページ']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_roster_check()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'roster_check' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT e.id AS election_id, e.name AS election_name, e.election_type, e.election_date, nd.d AS notice_date, e.lg_code,
           COALESCE(g.name, '（名称未確認）') AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）') AS pref_name,
           (nd.d IS NOT NULL AND policy_jp.activity_today() >= nd.d) AS after_notice,
           (SELECT count(*) FROM policy_jp.politician_elections pe WHERE pe.election_id = e.id AND pe.review_status = 'published' AND pe.candidacy_status <> 'withdrawn') AS ours_count,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('politician_id', pe.politician_id, 'name', pp.name, 'kana', pp.kana,
                                                          'candidacy_status', pe.candidacy_status, 'district_kind', pe.district_kind, 'district_name', pe.district_name)
                                      ORDER BY pp.kana, pp.id)
                       FROM (SELECT * FROM policy_jp.politician_elections x WHERE x.election_id = e.id AND x.review_status = 'published' ORDER BY x.created_at, x.id LIMIT 100) pe
                       JOIN policy_jp.politicians pp ON pp.id = pe.politician_id), '[]'::JSONB) AS ours
      FROM policy_jp.chain_open_elections o
      JOIN policy_jp.elections e ON e.id = o.election_id AND o.basis = 'published' AND e.review_status = 'published'
      JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
      -- 告示日は里程碑の announced（elections.notice_date は視圖が併進し、里程碑表の整場 announced が勝つ）。apply_candidacy と同じ読み方
      LEFT JOIN LATERAL (SELECT m.on_date AS d FROM policy_jp.election_milestones_all m
                          WHERE m.election_id = e.id AND m.kind = 'announced' AND m.election_type IS NULL ORDER BY (m.origin = 'table') DESC, m.on_date LIMIT 1) nd ON true
      CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:roster_check:' || e.id)
     ORDER BY e.election_date, e.id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:roster_check:' || g.election_id, 'roster_check',
         jsonb_build_object('election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'pref_name', g.pref_name,
                            'phase', CASE WHEN g.after_notice THEN 'post_notice' ELSE 'pre_notice' END,
                            'ours_count', g.ours_count, 'ours', g.ours,
                            'chain_lg_code', g.lg_code, 'chain_step', 'roster'),
         g.election_name || '（' || g.election_id || '、投票日 ' || g.election_date || COALESCE('、告示日 ' || g.notice_date, '、告示日は未記録') || '）の立候補者名簿を確かめます。'
           || '現在 ' || g.ours_count || ' 人が登録されています（target.ours に一覧）。'
           || CASE WHEN g.after_notice THEN
                '【告示後の段階】告示日を過ぎています。選挙管理委員会が公表した立候補者の一覧（候補者届出の公示・立候補者名簿）を開き、届出済みの人は candidacy_status=filed、status_date＝届出（受理）日（告示日以降）で提出してください。'
              ELSE
                '【告示前の段階】まだ届出は始まっていません。この段階で収めるのは「表明」までです：本人か政党が公に表明した人は candidacy_status=declared（立候補を表明）、出馬を検討していると本人か政党が公に話した報道があるときだけ considering（検討）。'
                || 'filed（届出済み）は告示日以降にしか使えません。うわさ・憶測は収めません。'
              END
           || '名簿にいて ours にいない人を、1 人ずつ contribution_type=candidacy で提出してください：'
           || 'payload は election_id（この選挙の id）・name（漢字）・kana（ひらがな。告示前は任意＝読みが分からなければ省略してよい、告示日以降は必須）・candidacy_status・status_date・district_kind（首長選は at_large、議員選は選挙区ごとに district で district_name を付ける、比例は proportional）。'
           || '生年が分かれば birth_year（任意）。既に ours にいる人は politician_id を付けて状態だけ更新します（同じ人を二重に作らない）。'
           || CASE WHEN g.after_notice THEN
                '出典（source_urls）は選管の公表（立候補者一覧・候補者届出の公示）を優先してください。選管がまだ載せていない人は、本人・政党の公式な発信で補って構いません。'
              ELSE
                '出典（source_urls）は報道、または本人・政党の発信（公式サイト・政党の発表・記者会見の報道）で構いません。告示後は選管の公表を優先します。'
              END
           || '得票数・得票率は記録しません（payload に入れない）。'
           || '全員を提出し終えて名簿が揃ったら、contribution_type=no_change、outcome=confirmed、task_id＝このタスクで報告します（checked_urls に見た名簿ページ）。'
           || '名簿がまだ公表されていない・見つからないときは no_change、outcome=not_found で、探した場所を checked_urls に入れて報告してください（候補を推測で作らない）。'
           || 'not_found の報告は最長 14 日（告示日が近いときは告示日の前日まで）お休みになり、告示日にもう一度この確認が回ってきます。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;

CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches_politician(p JSONB, p_ip_hash TEXT, p_exclude UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_pid TEXT := NULLIF(p->>'politician_id', '');
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
  v_has_facts BOOLEAN := (p ? 'birth_year') OR (p ? 'kana') OR (p ? 'education') OR (p ? 'career');
  v_birth NUMERIC := CASE WHEN jsonb_typeof(p->'birth_year') = 'number' THEN (p->>'birth_year')::NUMERIC END;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('type', 'politician', 'existing', v_existing, 'pending', v_pending);
  END IF;
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.ord), '[]'::JSONB) INTO v_existing FROM (
    -- 読み（kana）：生年と同じ扱い（値が違っても『庫に読みがある』＝同じこと。違う値は differs で出し直す）
    SELECT -1 AS ord, jsonb_build_object('id', pp.id || ':kana', 'fact', 'kana', 'kana', pp.kana, 'summary', pp.name || ' 読み ' || pp.kana, 'why', '同じ人・庫に読みがある') AS j
      FROM policy_jp.politicians pp
     WHERE pp.id = v_pid AND pp.kana IS NOT NULL AND (NOT v_has_facts OR p ? 'kana')
    UNION ALL
    SELECT 0 AS ord, jsonb_build_object('id', pp.id, 'fact', 'birth_year', 'birth_year', pp.birth_year, 'summary', pp.name || ' 生年 ' || pp.birth_year, 'why', '同じ人・庫に生年がある') AS j
      FROM policy_jp.politicians pp
     WHERE pp.id = v_pid AND pp.birth_year IS NOT NULL AND (NOT v_has_facts OR p ? 'birth_year')
    UNION ALL
    SELECT 1 + pc.id, jsonb_build_object('id', pc.id::TEXT, 'fact', pc.kind, 'text', pc.text, 'summary', pc.kind || '：' || pc.text, 'why', '同じ人・同じ種類・同じ文字の学経歴が庫にある')
      FROM policy_jp.politician_careers pc
     WHERE pc.politician_id = v_pid AND pc.review_status = 'published'
       -- 出處のない項目は『同じこと』ではない：補出處（career_sources 任務）の提出は、庫にある同じ文字の項目に出處を掛けるのが目的なので、
       -- 出處つきの項目だけが既存の事実。ここに含めると new が 409 duplicate_claim、在庫 id 指定が no_change に化けて、出處が永遠に掛からない
       AND EXISTS (SELECT 1 FROM policy_jp.source_refs r WHERE r.target_table = 'politician_careers' AND r.target_id = pc.id::TEXT)
       AND (NOT v_has_facts
            OR (pc.kind = 'education' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'education') = 'array' THEN p->'education' ELSE '[]'::JSONB END) t WHERE btrim(t) = pc.text))
            OR (pc.kind = 'career' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'career') = 'array' THEN p->'career' ELSE '[]'::JSONB END) t WHERE btrim(t) = pc.text)))
  ) x;
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.created_at), '[]'::JSONB) INTO v_pending FROM (
    SELECT c.created_at, jsonb_build_object(
             'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
             'birth_year', c.payload->'birth_year', 'kana', c.payload->'kana', 'education', c.payload->'education', 'career', c.payload->'career',
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
            OR (p ? 'kana' AND c.payload ? 'kana')
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
  '同一件事（politician）：人物 id ＋ 事実（生年・読み・学歴・経歴の各項目）。事実がない探査では、この人の庫にある事実と審議中の提出を全部返す。same_claim_matches 分派器から呼ばれる';

CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_content(p_type TEXT, a JSONB, b JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'election' THEN (a->>'election_date', a->>'election_type', COALESCE(NULLIF(a->>'election_reason', ''), 'regular'))
                     IS NOT DISTINCT FROM (b->>'election_date', b->>'election_type', COALESCE(NULLIF(b->>'election_reason', ''), 'regular'))
    -- 数値比対は apply_regional_stat と同じ判準（NUMERIC：28.5 と 28.50 は同じ）；数字でないものは同じとみなさない
    WHEN 'regional_stat' THEN jsonb_typeof(a->'value') = 'number' AND jsonb_typeof(b->'value') = 'number'
                              AND (a->>'value')::NUMERIC = (b->>'value')::NUMERIC AND a->>'unit' IS NOT DISTINCT FROM b->>'unit'
    WHEN 'local_government' THEN (a->>'name', a->>'kana', a->>'kind') IS NOT DISTINCT FROM (b->>'name', b->>'kana', b->>'kind')
    -- 政治人物：生年・読み・学歴・経歴が（順序を問わず）同じ
    WHEN 'politician' THEN
      (a->>'birth_year') IS NOT DISTINCT FROM (b->>'birth_year')
      AND (a->>'kana') IS NOT DISTINCT FROM (b->>'kana')
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'education') = 'array' THEN a->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'education') = 'array' THEN b->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'career') = 'array' THEN a->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'career') = 'array' THEN b->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
    -- 政見：要約が（空白・全半角・大小文字を無視して）同じ（題名は鍵で既に同じ）
    WHEN 'policy' THEN policy_jp.policy_title_key(a->>'description') = policy_jp.policy_title_key(b->>'description') AND NULLIF(btrim(COALESCE(a->>'description', '')), '') IS NOT NULL
    ELSE FALSE
  END
$$;

-- ------------------------------------------------------------
-- 7. 權限（新函式は PUBLIC に実行権が付くので明示的に収回。CREATE OR REPLACE した既存の関数は権限を保つ）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.election_notice_date(TEXT), policy_jp.candidacy_kana_required(TEXT),
  policy_jp.roster_not_found_released(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.election_notice_date(TEXT), policy_jp.candidacy_kana_required(TEXT),
  policy_jp.roster_not_found_released(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ------------------------------------------------------------
-- 8. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'policy_jp' AND table_name = 'politicians' AND column_name = 'kana' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'policy_jp：politicians.kana の NOT NULL が外れていない';
  END IF;
  -- 空文字・空白だけの読みは今も入らない（CHECK を残してある）
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'policy_jp.politicians'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%kana%') THEN
    RAISE EXCEPTION 'policy_jp：politicians.kana の CHECK（空文字を入れない）が無くなっている';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.candidacy_kana_required(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.election_notice_date(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.roster_not_found_released(text, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：告示日・kana・冷卻の新しい関数を anon に渡してはいけない';
  END IF;
  -- 三か所の冷卻計算が同じ判定を見ている（どれか一つ漏れると「臂は出すのに cooling で /next が配らない」などが起きる）
  IF pg_get_functiondef('policy_jp.refresh_dispatch_blocked()'::regprocedure) NOT LIKE '%roster_not_found_released%'
     OR pg_get_functiondef('policy_jp.task_unavailable(text)'::regprocedure) NOT LIKE '%roster_not_found_released%'
     OR pg_get_functiondef('policy_jp.chain_task_checked(text, text[])'::regprocedure) NOT LIKE '%roster_not_found_released%' THEN
    RAISE EXCEPTION 'policy_jp：冷卻の三か所（refresh_dispatch_blocked／task_unavailable／chain_task_checked）が roster_not_found_released を見ていない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
