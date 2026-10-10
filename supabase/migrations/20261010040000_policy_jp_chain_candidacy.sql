-- 日本站「選舉鏈」第 2 步：參選人有誰（roster_check 臂＋candidacy 交件型別＋落庫）
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-election-chain.md 第 2 節的第 2 步（任務型別 roster_check、交件型別 candidacy；
-- 告示前收「表明」、告示後收「届出」）。前一步（20261009250400）做的鏈骨架這支直接用，不改 gate 那一段。
--
-- 這支做的事（新增鏈上的一步＝election_chain_steps() 加名字＋進度視圖加一段＋規則設 after_step 與後備里程碑＋三處登記）：
-- 1. 鏈的步驟清單加 roster（名簿確認）、candidacy（已有參選紀錄）；進度視圖 election_chain_progress 加兩段（其餘一字不改）。
-- 2. 派工臂 roster_check（正見 contribution_auto_tasks_raw 裡 roster_check 那一段的日本版）：每個開著的、已上線的選舉一件，
--    task_id＝auto:roster_check:<選舉 id>。三處一起加：總表加一行 UNION、activity_arm_names() 加名字、activity_rules 種規則
--    （after_step=region＝第 1 步完成；params.chain_fallback＝告示日前 30 天；窗口＝投票日當天止；cap）。
--    另加優先層規則 priority:roster_check（前段／後段，同第 1 步兩支臂的 60／181 天）與 chain_step_rank 的 WHEN 一行（4）。
-- 3. 交件型別 candidacy：DB CHECK（policy_jp_contributions_type_check，漏了所有交件都會被擋而測試全綠）、apply_types()、
--    落庫 apply_candidacy（寫 politicians〔新人才建〕／politician_elections／出處／edit_history）、apply_contribution 多一個 WHEN。
--    共識：SQL contribution_required_agree 走 normal＝目標 3、退件 −3；contribution_needs_two_ips 本來就列 candidacy（20261009130000 抄正見）
--    ＝分數要有 2 個以上不同來源網段才通過（手引き第 7 節：參選的追加・取り消し・狀態變更要 2 個接続元）。這支不改共識。
--    同一件事：candidacy 屬於 claimKey 併票型別（_shared/duplicate-claim.ts），不進 same_claim 登記表（兩邊只能在一邊，same-claims.test.ts 守）。
-- 4. 得票數・得票率不存：payload 不收這類欄位（TS 驗證擋 400；SQL 落庫再擋一次當退件），政治人物的參選紀錄表本來就沒有這些欄位。
--
-- 設計決定（日本站沒有的東西，選最簡單而忠於計畫的做法；都列在 PR 說明）：
-- a. 告示日里程碑：policy_jp.election_milestones 沒有「告示日」的存放處（elections.notice_date 才有），而計畫的後備里程碑全以告示日為準。
--    做法：視圖 election_milestones_all 多一個分支，把 elections.notice_date 當作里程碑 announced 併進來（多一列 origin='elections'；
--    election_milestones 表裡有同一場選舉、整場的 announced 列時以表為準＝可被覆寫）。announced 在正見的意思就是選舉公告日，對得上告示日。
--    notice_date 還沒填的選舉沒有告示日里程碑＝後備不會到（同第 1 步已知限制）；不從法定天數去猜（公職選挙法的告示期間依選舉種類不同，
--    猜錯就是編造日期）。
-- b. 「前一步完成」的定義（計畫第 2 節：缺口全部補上或回報查無並在冷卻中）：
--      roster    ＝這場選舉的 roster_check 任務有人回報 no_change（confirmed＝名簿都登記了／not_found＝名簿還沒公表）並且還在冷卻中。
--                  不用「候選人數」判斷：日本沒有中選會那種可整批比對的名冊，沒有「官方總數」可比。冷卻過了（14 天）會回到未完成＝再查一輪
--                  （新的届出）；已開的後一步不收回（sticky）。
--      candidacy ＝這場選舉至少有一位已表明以上（declared／filed／elected／not_elected）的已上線參選紀錄（第 3 步「該參選人已有參選紀錄」的開啟條件）。
--                  只有 considering（出馬を検討＝本人或政黨公開談過的報導）和退選的不算：傳聞階段的人不該單獨啟動整串建檔・政見；
--                  這種選舉等到有人正式表明，或告示日到了（後備），第 3 步才開。
-- c. 窗口：roster_check 只在投票日當天以前派（until polling +0）；投票日之後的當落由第 6 步（開票結果）管。
-- d. 臂的 cap（預設 200）套在可派（task_unavailable 以外）的前 N 件，順序＝投票日近的先；沒有為 gate 另排（開著的選舉不會超過 cap）。
-- e. 本人物的判定（落庫）：同一人＝kana＋地區（參選或任期的 lg_code）＋birth_year（SCHEMA.md）。payload 給 politician_id 就直接用；
--    只給 name＋kana 時，找「同名同讀音、生年不衝突（任一邊空白不算衝突）、在同一個團體有參選或任期」的人，剛好一位就用他，
--    多位就退件（要代理改帶 politician_id），沒有就新建。這一步不做比對以外的猜測。
-- f. 參選的狀態轉移（落庫）：considering → declared → filed → withdrawn／elected／not_elected 只能往後走，elected／not_elected 是終點；
--    往回走或換終點＝conflict（不覆蓋、退件）。status_date 不得早於庫裡的 status_date。elected／not_elected 的 status_date 要 ≥ 投票日、
--    filed 要 ≥ 告示日（有填的話）且 ≤ 投票日，其餘 ≤ 投票日。
-- g. 沒做的：政黨（party_id／推薦）要先有政黨名冊與 party_info 型別；名簿順位以外的比例代表欄位（is_priority_list）；合区（district_lg_codes）。
--    都不在這一步，payload 帶了也不收（TS 驗證擋）。
--
-- 守門：supabase/functions/_shared/policy-jp-chain-candidacy.test.ts（PGlite 套全部 _policy_jp_ migration）、policy-jp-dispatch-drift.test.ts
-- （新函式登記、被重新定義的函式 mig 清單）、jp/contribution-schema.test.ts、jp-entry-candidacy 相關測試。
-- 不碰 public、ditrust；不動共識／派工／佇列的函式（除了登記的 chain_step_rank、activity_arm_names、總表）。

-- ------------------------------------------------------------
-- 1. 告示日里程碑（election_milestones_all 多一個分支；欄位與前一版相同）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policy_jp.election_milestones_all WITH (security_invoker = true) AS
  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,
         'table'::TEXT AS origin, m.id AS milestone_id
    FROM policy_jp.election_milestones m
  UNION ALL
  SELECT e.id, 'polling'::TEXT, NULL::TEXT, e.election_date, 'official'::TEXT,
         CASE WHEN e.election_date < policy_jp.activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM policy_jp.elections e
   WHERE e.election_date IS NOT NULL
  UNION ALL
  -- 告示日：elections.notice_date 當作整場的 announced 里程碑（表裡有整場的 announced 列就以表為準）
  SELECT e.id, 'announced'::TEXT, NULL::TEXT, e.notice_date, 'official'::TEXT,
         CASE WHEN e.notice_date < policy_jp.activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM policy_jp.elections e
   WHERE e.notice_date IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM policy_jp.election_milestones m WHERE m.election_id = e.id AND m.kind = 'announced' AND m.election_type IS NULL);
COMMENT ON VIEW policy_jp.election_milestones_all IS
  '規則讀的里程碑全貌：election_milestones（origin=table）＋投票日 polling 與告示日 announced（來自 elections，不重複存；表裡有整場的 announced 列時以表為準）。日本版還沒有 term_start／term_end';

-- ------------------------------------------------------------
-- 2. 步驟清單與小工具
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY['discovery', 'local_government', 'regional_stats', 'region', 'roster', 'candidacy']::TEXT[]
$$;
COMMENT ON FUNCTION policy_jp.election_chain_steps IS '選舉鏈的步驟（election_chain_progress.step 的值）；activity_rules.after_step 只能是這裡的值。加步驟＝改這裡＋視圖多一段';

-- 這個任務最近有人回報「查了：沒有缺口／查無」並且還在冷卻中（no_change 的 confirmed 與 not_found；unreachable 不算查完）
CREATE OR REPLACE FUNCTION policy_jp.chain_task_checked(p_task_id TEXT, p_outcomes TEXT[] DEFAULT ARRAY['confirmed', 'not_found']) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT max(tc.checked_at) FROM policy_jp.task_checks tc
   WHERE tc.task_id = p_task_id AND tc.outcome = ANY (p_outcomes)
     AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
$$;
COMMENT ON FUNCTION policy_jp.chain_task_checked IS '選舉鏈進度用：這個任務有人回報查過（outcome 預設 confirmed／not_found）而且還在冷卻中的最近時間；沒有＝NULL';

-- ------------------------------------------------------------
-- 3. 鏈的進度：前一版（20261009250400）的視圖＋roster、candidacy 兩段
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
  SELECT c.election_id, c.lg_code, 'candidacy'::TEXT, c.done, CASE WHEN c.done THEN c.last_at END FROM ca c;
COMMENT ON VIEW policy_jp.election_chain_progress IS
  '選舉鏈的進度：開著的選舉×團體×步驟（election_chain_steps()）一列，done＝這一步的缺口都補上了，或回報查無、還在冷卻中。總表的 chain_gate 讀它（seed 時算一次）。service_role 用';

-- ------------------------------------------------------------
-- 4. 交件型別 candidacy：DB CHECK（漏了這個，代理交件全被擋而測試全綠）與落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy'));

-- 名簿確認の任務（auto:roster_check:…）は一人ずつ candidacy で出す一題多份：最初の 1 筆が落庫しても任務は收回しない（完成の合図は no_change）。
-- 正見は手動任務の roster_check を『一題多份は收回しない』（manual_task_closes_on_applied）にしている。日本站の roster_check は自動任務なので、
-- 複本の task_dispatches_drop_applied には触れず、觸發器の WHEN で candidacy×auto:roster_check を除く（收回は no_change の落庫か seed の缺口判斷）
DROP TRIGGER IF EXISTS contributions_drop_dispatch ON policy_jp.contributions;
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NOT (NEW.contribution_type = 'candidacy' AND NEW.task_id LIKE 'auto:roster_check:%'))
  EXECUTE FUNCTION policy_jp.task_dispatches_drop_applied();

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'no_change']::TEXT[]
$$;

-- 同一人的找法（落庫用）：同名同讀音、生年不衝突、在同一個團體有參選或任期。回 0 位／1 位／多位
CREATE OR REPLACE FUNCTION policy_jp.candidacy_match_politicians(p_name TEXT, p_kana TEXT, p_birth_year INTEGER, p_lg_code TEXT) RETURNS TEXT[]
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT COALESCE(array_agg(p.id ORDER BY p.created_at, p.id), '{}'::TEXT[])
    FROM policy_jp.politicians p
   WHERE p.name = btrim(p_name) AND p.kana = btrim(p_kana)
     AND (p.birth_year IS NULL OR p_birth_year IS NULL OR p.birth_year = p_birth_year)
     AND (EXISTS (SELECT 1 FROM policy_jp.politician_elections pe JOIN policy_jp.elections e ON e.id = pe.election_id
                   WHERE pe.politician_id = p.id AND e.lg_code IS NOT DISTINCT FROM p_lg_code)
          OR EXISTS (SELECT 1 FROM policy_jp.politician_offices o WHERE o.politician_id = p.id AND o.lg_code IS NOT DISTINCT FROM p_lg_code))
$$;
COMMENT ON FUNCTION policy_jp.candidacy_match_politicians IS '同一人的判定（SCHEMA.md：kana＋地區＋birth_year）：同名同讀音、生年不衝突（任一邊空白不算衝突）、在同一個團體有參選或任期的人 id 陣列';

-- 參選狀態的先後（轉移只能往大的走；elected／not_elected 同為終點、withdrawn 也是終點）
CREATE OR REPLACE FUNCTION policy_jp.candidacy_status_rank(p_status TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_status WHEN 'considering' THEN 1 WHEN 'declared' THEN 2 WHEN 'filed' THEN 3 WHEN 'withdrawn' THEN 4 WHEN 'elected' THEN 4 WHEN 'not_elected' THEN 4 END
$$;

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
    IF v_name = '' OR v_kana = '' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_id がないときは name と kana が要る');
    END IF;
    v_ids := policy_jp.candidacy_match_politicians(v_name, v_kana, v_birth, e.lg_code);
    IF cardinality(v_ids) > 1 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('同名同読み・同じ団体の人物が複数いて特定できない（%s）：politician_id を指定して出し直す', array_to_string(v_ids, '、')));
    END IF;
    IF cardinality(v_ids) = 1 THEN v_pid := v_ids[1]; ELSE v_new_person := true; END IF;
  END IF;

  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'candidacy');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  IF v_new_person THEN
    v_pid := gen_random_uuid()::TEXT;
    INSERT INTO policy_jp.politicians (id, name, kana, birth_year, review_status) VALUES (v_pid, v_name, v_kana, v_birth, 'published');
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
      PERFORM policy_jp.source_write('politician_elections', pe.id, c.source_urls, 'candidacy');
      RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politician_elections', 'record_id', pe.id, 'message', format('%s は庫に同じ状態（%s）で既にある', pe.id, v_status));
    END IF;
    IF pe.candidacy_status IN ('elected', 'not_elected', 'withdrawn')
       OR policy_jp.candidacy_status_rank(v_status) < policy_jp.candidacy_status_rank(pe.candidacy_status)
       OR v_date < pe.status_date THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politician_elections', 'record_id', pe.id,
        'message', format('庫の %s は %s（%s）。提出の %s（%s）は後戻り・終点の付け替え・日付の巻き戻しで、上書きしない', pe.id, pe.candidacy_status, pe.status_date, v_status, v_date));
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
  'candidacy 交件の落庫（politician_elections。新しい人なら politicians も）。同じ状態＝unchanged、後戻り・終点の付け替え・日付の巻き戻し・選挙区違い＝conflict（退件）、内容の不備＝invalid（退件）。得票數は受け付けない';

-- 落庫主函式：20261009210000 の版に candidacy の WHEN を 1 行足しただけ（残りは一字も変えない）
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
-- 5. 臂：roster_check（鏈的第 2 步：開著的、已上線的選舉的立候補者名簿）
-- ------------------------------------------------------------
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
           || 'payload は election_id（この選挙の id）・name（漢字）・kana（ひらがな）・candidacy_status・status_date・district_kind（首長選は at_large、議員選は選挙区ごとに district で district_name を付ける、比例は proportional）。'
           || '生年が分かれば birth_year（任意）。既に ours にいる人は politician_id を付けて状態だけ更新します（同じ人を二重に作らない）。'
           || '出典（source_urls）は選管の公表ページか、その人の公式な表明（公式サイト・政党の発表）。報道だけの出典は避けてください。'
           || '得票数・得票率は記録しません（payload に入れない）。'
           || '全員を提出し終えて名簿が揃ったら、contribution_type=no_change、outcome=confirmed、task_id＝このタスクで報告します（checked_urls に見た名簿ページ）。'
           || '名簿がまだ公表されていない・見つからないときは no_change、outcome=not_found で、探した場所を checked_urls に入れて報告してください（候補を推測で作らない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_roster_check IS
  '選挙鎖の第 2 歩：開いている選挙（上線済み）の立候補者名簿 → roster_check 任務（1 選挙 1 件、task_id＝auto:roster_check:<選挙 id>）。告示前は表明まで・告示後は届出。完了の合図は no_change（confirmed／not_found）で冷却。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 6. 臂名清單と総表：20261009250400 の版本に名前 1 つ／UNION 1 行を足しただけ（残りは一字も変えない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open',
    'election_discovery',
    'local_government_missing',
    'regional_stats_missing',
    'roster_check'
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

-- 層內排序的步驟順位：20261009300000 の版に WHEN 1 行（roster_check＝4）
CREATE OR REPLACE FUNCTION policy_jp.chain_step_rank(p_task_id TEXT, p_task_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_task_id IS NULL OR p_task_id NOT LIKE 'auto:%' THEN 0
           ELSE CASE p_task_type
                  WHEN 'election_discovery' THEN 1
                  WHEN 'local_government_missing' THEN 2
                  WHEN 'regional_stats_missing' THEN 3
                  WHEN 'roster_check' THEN 4
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check 4（候補者 4）。之後（建檔 5、政見 6）はここに WHEN を 1 行足す。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 7. 規則（臂的規則＋優先層規則；冪等）
-- ------------------------------------------------------------
-- 窗口：投票日當天止（until polling +0）。前一步完成（after_step=region）或告示日前 30 天（後備）才開
INSERT INTO policy_jp.activity_rules (activity, window_kind, until_kind, until_offset, min_status, after_step, params, note)
SELECT 'roster_check', 'event', 'polling', 0, 'announced', 'region',
       '{"cap":200,"chain_fallback":{"kind":"announced","offset":-30}}'::JSONB,
       '選挙鎖の第 2 歩（立候補者名簿）：開いている選挙の立候補者名簿を選管の公表ページで確かめ、いない人を candidacy で提出させる。告示前は表明（considering／declared）、告示後は届出（filed）。'
       || '地区データ（第 1 歩）が済んでから開く。止まっていても告示日の 30 日前には開く（後備）。投票日当日まで。同時に開くのは最大 200 件（投票日の近い選挙が先）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'roster_check' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:roster_check', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 天内の立候補者名簿任務（最近の選挙を先に派す）'),
    ('priority:roster_check', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の立候補者名簿任務；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- ------------------------------------------------------------
-- 8. 權限（新函式預設對 PUBLIC 可執行、視圖預設 service_role 全權；明寫收回。CREATE OR REPLACE 保留原有權限）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.chain_task_checked(TEXT, TEXT[]), policy_jp.candidacy_match_politicians(TEXT, TEXT, INTEGER, TEXT),
  policy_jp.candidacy_status_rank(TEXT), policy_jp.apply_candidacy(policy_jp.contributions), policy_jp.contribution_auto_tasks_roster_check()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.chain_task_checked(TEXT, TEXT[]), policy_jp.candidacy_match_politicians(TEXT, TEXT, INTEGER, TEXT),
  policy_jp.candidacy_status_rank(TEXT), policy_jp.apply_candidacy(policy_jp.contributions), policy_jp.contribution_auto_tasks_roster_check()
  TO service_role;

-- ------------------------------------------------------------
-- 9. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 鏈上的臂都要有 after_step；after_step 不是 discovery 的都要有後備里程碑（前一步卡住時不能無聲停住）
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'roster_check' AND r.priority IS NULL AND r.enabled
                  AND r.after_step = 'region' AND r.params ? 'chain_fallback' AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：roster_check の規則に after_step／chain_fallback／cap がない（臂が無音で消える／前一歩が止まると一緒に止まる）';
  END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  -- 交件型別的 DB CHECK 要收 candidacy（漏了＝所有交件都被擋）
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%candidacy%') THEN
    RAISE EXCEPTION 'policy_jp：contributions の contribution_type CHECK に candidacy がない';
  END IF;
  IF NOT ('candidacy' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に candidacy がない'; END IF;
  IF NOT (policy_jp.chain_step_rank('auto:roster_check:x', 'roster_check') > policy_jp.chain_step_rank('auto:regional_stats_missing:x', 'regional_stats_missing')) THEN
    RAISE EXCEPTION 'policy_jp：步驟順位は 統計 < 名簿 でなければならない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_candidacy(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_roster_check()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.chain_task_checked(text, text[])', 'EXECUTE')
     OR has_table_privilege('anon', 'policy_jp.election_chain_progress', 'SELECT') THEN
    RAISE EXCEPTION 'policy_jp：選舉鏈（第 2 步）の関数・ビューを anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
