-- 日本站派工臂對齊正見 B 期：開票結果（當落）與新任期（工作單 Yooliang/policy-ops#95）
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-arms-parity.md 的 B 期（選舉鏈第 5 步「開票結果」、第 6 步「新任期」）。10/25 豊見城が最初の選挙で、投票日の翌日には任務が要る。
--
--   正見臂             日本臂（activity）   任務型別（task_type）       task_id                                              交件
--   election_results   election_results     election_result_missing     auto:election_result_missing:<參選 id>               candidacy（elected／not_elected、届出していなければ withdrawn）
--   elected_missing    elected_missing      election_result_missing     auto:election_result_missing:elected:<選舉 id>       candidacy（elected、記録にない当選者を足す）／no_change（confirmed＝全員記録済み）
--   （任期觸發器）      —                    —                           —                                                    politician_offices（当選の参選から自動で建てる）
--
--   ※ 任務型別は正見と同じ election_result_missing（正見の elected_missing も同じ型別で、task_id の形で見分ける）。<參選 id> ＝ politician_elections.id。
--   ※ 臂名は正見と同じ（election_results・elected_missing）。日本站の臂名は raw: を付けない（既存の臂と同じ）。
--
-- 時間窗與鏈（日期條件寫在規則、不寫在臂）：
--   election_results  window_kind='event'、from polling +1（投票日の翌日起）、終わりなし（鏈が投票日後 chain_close_after_days＝90 日で閉じる）。
--                     after_step='candidacy'（第 2 步之後）、後備＝polling +1（窓の起点と同じ：鏈が止まっていても翌日には開く）。cap 300。
--   elected_missing   同じ窓。after_step='results'（新しい鏈の一歩：この選挙の参選が全員当落まで決まった）、後備＝polling +7
--                     （一人ずつの当落が終わってから「記録にない当選者」を探す。終わらなくても 1 週間後には開く）。cap 100。
--   優先層：投票日の翌日から前段（priority 1）。告示前の臂（polling -60 起）と違い、開票は投票日以降なので主控台の段も第 4 段（開票）になる。
--   三處一起加：總表加兩行 UNION、activity_arm_names() 加兩個名字、activity_rules 種兩條規則（＋優先層）；chain_step_rank 補順位（7）；
--   console_arm_stage_map 登記第 4 段；鏈の步驟清單に results を足し、進度視圖に一段足す。
--
-- 新任期（正見 20261006034510 の politician_offices 觸發器＋每日排程の日本版）：
--   当選（elected）の参選から任期を一列建てる：職位＝選舉種類、団体＝選挙の団体、就任日と任期満了日は法定（地方自治法 93・140 条、公職選挙法 258・259 条）：
--     定期（任期満了による選挙）：総務省「任期満了に関する調」（term_expirations）の前任の満了日が投票日以降なら満了日の翌日、投票日より前なら投票日から 4 年
--     辞職・死亡・解職・解散の後の選挙：投票日から 4 年
--     補欠・増員（議員）：投票日から、議会の任期満了日（term_expirations）まで
--     それ以外（再選挙・国政・満了日が分からない）は建てない（視圖 politician_offices_pending の reason=term_unknown に出る。人が確かめる）
--   **日本站の「現職」は end_date が空かどうかだけで決まる（policy-jp CLAUDE.md・assemble.ts）**。だから正見と違い、就任日が来るまで任期の列を建てない
--   （正見は先に建てて表示側が就任日を見る）。就任日がまだの当選は politician_offices_pending の reason=not_started に出て、毎日の排程（JST 00:05）が就任日に建てる。
--   卸任：任期満了日を過ぎた＝term_expired（law）、同じ人が後で別の公職に就任＝took_other_office（inferred）、首長で別の人が就任＝other（inferred）。
--     まだ来ていない卸任日は先に書かない（正見と同じ：「卸任日が空＝現職」を崩さない）。
--   当選が取り消された（elected でなくなった、非公開になった）参選の任期は消す（その任期は最初からなかった。edit_history に全列を残す、正見と同じ）。
--   term_no（第何期）は記録上の回数（同じ人・同じ職位・同じ団体で、この任期より前に始まった任期の数＋1）。過去の任期がまだ記録にない現職は少なく出る
--     ——往回補（C 期）で過去の任期が入れば次の排程で数え直す。
--
-- 與正見不同的地方（policy-jp-dispatch-drift.test.ts の JP_ONLY、why 欄に FOLLOWED／DEVIATED）：
--   1. 当落の交件：正見は整批の election_results 型（中選會名單＋系統票で一單位一件）。日本站には選管の機械可読な名簿も系統票もないので、
--      一人一件の candidacy（elected／not_elected）。整批・系統票は A 期の「参選人系統票」と一緒に後で（計畫）。
--   2. 記録にない当選者：正見は中選會の當選名單と照らして一人一件。日本站は名簿がないので一選挙一件、定数（elections.seats、首長は 1）に
--      当選者の数が足りない、または定数が分からない選挙に出し、no_change confirmed（全員記録済みと確かめた）で閉じる。一題多份（roster_check と同じ）なので
--      candidacy が一件落庫しても任務は收回しない（contributions_drop_dispatch の WHEN）。
--   3. 任期：正見は投票の後すぐに任期列を建て、表示側が就任日を見る。日本站は表示側が end_date しか見ないので就任日に建てる。
--      正見の中選會回填・politician_offices_gap は台灣専用で搬ばない。
--
-- 交件と落庫：新しい提出の型・result 値は増やさない。apply_candidacy はそのまま（filed → elected／not_elected、日付は投票日以降の検査は既存）。
-- TS（_shared/jp/contribution-schema.ts）の task_id 比對に election_result_missing を足す。協議版號 0.14.0。
--
-- 守門：supabase/functions/_shared/policy-jp-results-terms.test.ts（PGlite 假時鐘：投票日まで開かない・翌日開く・当落が入ると filled；
-- 記録にない当選者の鏈 gate と後備；任期が就任日に建ち・満了で閉じ・当選取消で消える；還原驗證）、policy-jp-dispatch-drift.test.ts、
-- jp/contribution-schema-chain.test.ts。不碰 public、ditrust。冪等（規則は NOT EXISTS、登記は ON CONFLICT）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 鏈の步驟清單に results（開票結果）を足す：20261010060000 の版の末尾に 1 つ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY['discovery', 'local_government', 'regional_stats', 'region', 'roster', 'candidacy', 'profile', 'policy', 'results']::TEXT[]
$$;
COMMENT ON FUNCTION policy_jp.election_chain_steps IS '選舉鏈的步驟（election_chain_progress.step 的值）；activity_rules.after_step 只能是這裡的值。加步驟＝改這裡＋視圖多一段';

-- ------------------------------------------------------------
-- 2. 臂 election_results：投票日が過ぎても当落の決まっていない参選 → 選管の開票結果で elected／not_elected に
--    （正見 election_results の日本版。一人一件、task_id＝auto:election_result_missing:<参選 id>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_election_results()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'election_results' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.chain_candidacy_records() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND s.candidacy_status IN ('considering', 'declared', 'filed')
       AND NOT policy_jp.task_unavailable('auto:election_result_missing:' || s.politician_election_id)
     -- 投票日の古い選挙から（結果の公表は投票日の翌日から。並び順だけで、窓を開けるかどうかは規則が決める）
     ORDER BY s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:election_result_missing:' || g.politician_election_id, 'election_result_missing',
         jsonb_build_object('kind', 'result', 'politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'chain_lg_code', g.lg_code, 'chain_step', 'results'),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）は、当方の記録では「'
           || CASE g.candidacy_status WHEN 'considering' THEN '出馬を検討' WHEN 'declared' THEN '立候補を表明' ELSE '届出済み' END || '」（' || g.status_date || '）のままです。'
           || '投票日を過ぎたので、選挙管理委員会が公表した開票結果（当選人の告示・選挙結果のページ）で当落を確かめてください。'
           || '【当選】（無投票当選を含む） → contribution_type=candidacy で candidacy_status=elected、status_date＝投票日（' || g.election_date || '。開票が翌日でも、無投票でも投票日）。'
           || '【落選】 → candidacy_status=not_elected、status_date＝投票日。'
           || CASE WHEN g.candidacy_status = 'filed'
                   THEN '【開票結果に名前がない】 → 届出の後に辞退したと考えられます。辞退が確かめられたら candidacy_status=withdrawn、withdrawn_after_filing=true、status_date＝辞退の日。'
                   ELSE '【開票結果にも立候補者の一覧にも名前がない】 → 届出をしなかった人です。candidacy_status=withdrawn、withdrawn_after_filing=false、status_date＝立候補者の一覧が公表された日（告示日）。' END
           || 'payload は politician_id（' || g.politician_id || '）・election_id（' || g.election_id || '）・candidacy_status・status_date・district_kind（' || g.district_kind || '）'
           || CASE WHEN g.district_name IS NOT NULL THEN '・district_name（' || g.district_name || '）' ELSE '' END
           || '。選挙区は現在の記録のまま変えません。source_urls は選挙管理委員会の開票結果のページにしてください（報道だけの出典は避けます）。'
           || '得票数・得票率は記録しません（payload に入れない。入れると差し戻し）。'
           || '開票結果がまだ公表されていない・見つからないときは、推測で当落を書かず、contribution_type=no_change、outcome=not_found（ページが開けなかったときは unreachable）、'
           || 'checked_urls に探した場所を入れて報告してください。',
         ARRAY[g.lg_name || ' 選挙管理委員会の開票結果・当選人の告示', g.pref_name || ' 選挙管理委員会', g.lg_name || ' 公式サイト（選挙のお知らせ）', '総務省 選挙関連情報']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_election_results IS
  '当落（正見 election_results の日本版）：開いている選挙で、投票日を過ぎても considering／declared／filed のままの参選 → election_result_missing 任務（kind=result、一人一件、task_id＝auto:election_result_missing:<参選 id>）。'
  '日付（投票日の翌日起）は規則 activity_rules「election_results」が決める。完了は candidacy（elected／not_elected／withdrawn）の落庫。得票数は記録しない。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 3. 臂 elected_missing：定数に当選者の数が足りない（または定数が分からない）選挙 → 開票結果の当選者全員と照らして、記録にない当選者を足す
--    （正見 elected_missing の日本版。一選挙一件、task_id＝auto:election_result_missing:elected:<選挙 id>）
-- ------------------------------------------------------------
-- 定数：首長は 1、議会は elections.seats（分からなければ NULL）
CREATE OR REPLACE FUNCTION policy_jp.election_seats_needed(p_election_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN e.election_type IN ('governor', 'mayor', 'ward_mayor', 'town_mayor') THEN 1 ELSE e.seats END
    FROM policy_jp.elections e WHERE e.id = p_election_id
$$;
COMMENT ON FUNCTION policy_jp.election_seats_needed IS '選挙の定数：首長（governor・mayor・ward_mayor・town_mayor）は 1、議会は elections.seats（未記録は NULL）。elected_missing 臂が使う';

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_elected_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'elected_missing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  el AS (
    SELECT e.id AS election_id, e.name AS election_name, e.election_type, e.election_date, e.lg_code, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）') AS pref_name,
           policy_jp.election_seats_needed(e.id) AS seats,
           (SELECT count(*) FROM policy_jp.politician_elections pe
             WHERE pe.election_id = e.id AND pe.review_status = 'published' AND pe.candidacy_status = 'elected')::INTEGER AS n_elected,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'kana', x.kana, 'district_name', x.district_name)
                                      ORDER BY x.kana NULLS LAST, x.name)
                       FROM (SELECT pe.politician_id, pp.name, pp.kana, pe.district_name
                               FROM policy_jp.politician_elections pe JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
                              WHERE pe.election_id = e.id AND pe.review_status = 'published' AND pe.candidacy_status = 'elected'
                              LIMIT 200) x), '[]'::JSONB) AS elected
      FROM policy_jp.chain_open_elections o
      JOIN policy_jp.elections e ON e.id = o.election_id AND o.basis = 'published' AND e.review_status = 'published'
      JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
  ),
  gaps AS (
    SELECT el.*
      FROM el CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND (el.seats IS NULL OR el.n_elected < el.seats)
       -- 照合済み：この任務に no_change confirmed（開票結果の当選者は全員記録にある）の報告がある
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = 'auto:election_result_missing:elected:' || el.election_id AND tc.outcome = 'confirmed')
       AND NOT policy_jp.task_unavailable('auto:election_result_missing:elected:' || el.election_id)
     ORDER BY el.election_date, el.election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:election_result_missing:elected:' || g.election_id, 'election_result_missing',
         jsonb_build_object('kind', 'elected_missing', 'record_missing', true, 'election_id', g.election_id, 'election_name', g.election_name,
                            'election_type', g.election_type, 'election_date', g.election_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'seats', g.seats, 'elected_count', g.n_elected, 'elected', g.elected,
                            'chain_lg_code', g.lg_code, 'chain_step', 'results'),
         g.lg_name || ' ' || g.election_name || '（投票日 ' || g.election_date || '）の当選者のうち、当方の記録にあるのは ' || g.n_elected || ' 人です'
           || CASE WHEN g.seats IS NULL THEN '（定数は未記録）。' ELSE '（定数 ' || g.seats || '）。' END
           || '記録にある当選者は target.elected のとおりです。選挙管理委員会が公表した開票結果（当選人の告示）の当選者全員と照らし合わせ、'
           || '記録にない当選者がいれば、一人につき一件、contribution_type=candidacy で出してください：election_id（' || g.election_id || '）・name・kana（ひらがな）・'
           || 'candidacy_status=elected・status_date＝投票日（' || g.election_date || '）・district_kind（首長と選挙区のない議会は at_large、選挙区のある議会は district と district_name）。'
           || '同じ人がすでに当方にいる（ほかの選挙の記録がある）ときは politician_id を付けます。source_urls は選挙管理委員会の開票結果のページです。'
           || '当方に「届出済み」などで記録がある人は、別の任務（一人ずつの当落）で確かめているので、ここでは足さなくて構いません。'
           || '【当選者が全員記録にある】 → contribution_type=no_change、outcome=confirmed、checked_urls に照合した開票結果のページ、finding に照合した人数を書いて報告してください（照合済みになり、この任務は二度と出ません）。'
           || '開票結果がまだ公表されていない・見つからないときは no_change、outcome=not_found（開けなかったときは unreachable）で探した場所を checked_urls に入れて報告してください。'
           || '得票数・得票率は記録しません。',
         ARRAY[g.lg_name || ' 選挙管理委員会の開票結果・当選人の告示', g.pref_name || ' 選挙管理委員会', g.lg_name || ' 公式サイト（選挙のお知らせ）', '総務省 選挙関連情報']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_elected_missing IS
  '記録にない当選者（正見 elected_missing の日本版）：開いている選挙で、定数（election_seats_needed）に当選者が足りない、または定数が分からない選挙 → election_result_missing 任務'
  '（kind=elected_missing、一選挙一件、task_id＝auto:election_result_missing:elected:<選挙 id>）。no_change confirmed で照合済み（二度と出ない）。一題多份：candidacy の落庫では收回しない。'
  '日付（投票日の翌日起）と鏈（after_step=results、後備 polling +7）は規則 activity_rules「elected_missing」が決める。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 4. 一題多份：記録にない当選者の任務は、candidacy が 1 件落庫しても收回しない（20261010040000 の觸發器に条件を 1 つ足しただけ）
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS contributions_drop_dispatch ON policy_jp.contributions;
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NOT (NEW.contribution_type = 'candidacy' AND NEW.task_id LIKE 'auto:roster_check:%')
                     AND NOT (NEW.contribution_type = 'candidacy' AND NEW.task_id LIKE 'auto:election\_result\_missing:elected:%'))
  EXECUTE FUNCTION policy_jp.task_dispatches_drop_applied();

-- ------------------------------------------------------------
-- 5. 新任期：当選の参選 → politician_offices（正見 20261006034510 sync_politician_office_from_election／politician_offices_close_ended の日本版）
-- ------------------------------------------------------------
-- 選挙の種類 → 任期の職位（国政は任期の決まりが違う〈衆院は解散、参院は 6 年〉ので、まだ建てない＝NULL）
CREATE OR REPLACE FUNCTION policy_jp.office_position_for(p_election_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_election_type
           WHEN 'governor' THEN 'governor'
           WHEN 'mayor' THEN 'mayor'
           WHEN 'ward_mayor' THEN 'ward_mayor'
           WHEN 'town_mayor' THEN 'town_mayor'
           WHEN 'pref_assembly' THEN 'pref_assembly_member'
           WHEN 'muni_assembly' THEN 'muni_assembly_member'
         END
$$;
COMMENT ON FUNCTION policy_jp.office_position_for IS '選挙の種類 → politician_offices.position。地方の 6 種類だけ（国政は NULL：任期の決まりが違うので任期を自動で建てない）';

-- 選挙で生まれる任期の就任日と任期満了日（法定）。算出できないときは行を返さない
--   定期（regular）：term_expirations（総務省「任期満了に関する調」）の前任の満了日（投票日の前後 120 日以内でいちばん近いもの）が
--                    投票日以降 → 満了日の翌日から 4 年（公選法 258・259 条の 2）、投票日より前 → 投票日から 4 年（地方自治法 93・140 条）
--   辞職・死亡・解職・解散（resignation／death／recall／dissolution）：投票日から 4 年
--   補欠・増員（by_election／increase、議員）：投票日から、議会の任期満了日（投票日以降でいちばん近い term_expirations）まで（公選法 260 条）
--   再選挙（rerun）・国政・満了日の記録がない定期・補欠：算出しない
--   既知の限界：長の辞職による選挙で前職が当選したときは残任期（公選法 259 条の 2）だが、ここでは 4 年にする（politician_offices_pending で人が確かめる）
CREATE OR REPLACE FUNCTION policy_jp.office_term_for(p_election_id TEXT)
RETURNS TABLE (start_date DATE, scheduled_end_date DATE, term_rule TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH e AS (
    SELECT x.id, x.election_date, x.election_reason, x.lg_code,
           CASE WHEN x.election_type IN ('governor', 'mayor', 'ward_mayor', 'town_mayor') THEN 'head' ELSE 'assembly' END AS office_kind
      FROM policy_jp.elections x
     WHERE x.id = p_election_id AND policy_jp.office_position_for(x.election_type) IS NOT NULL AND x.lg_code IS NOT NULL
  ),
  prev AS (  -- 定期：前任の満了日（投票日の前後 120 日以内でいちばん近い。同じ満了日なら新しい調査）
    SELECT t.term_end FROM policy_jp.term_expirations t JOIN e ON t.lg_code = e.lg_code AND t.office_kind = e.office_kind
     WHERE t.term_end BETWEEN e.election_date - 120 AND e.election_date + 120
     ORDER BY abs(t.term_end - e.election_date), t.as_of DESC LIMIT 1
  ),
  cur AS (  -- 補欠・増員：議会のいまの任期の満了日（投票日以降でいちばん近い）
    SELECT t.term_end FROM policy_jp.term_expirations t JOIN e ON t.lg_code = e.lg_code AND t.office_kind = 'assembly'
     WHERE t.term_end >= e.election_date
     ORDER BY t.term_end, t.as_of DESC LIMIT 1
  ),
  s AS (
    SELECT CASE
             WHEN e.election_reason = 'regular' AND (SELECT term_end FROM prev) >= e.election_date THEN (SELECT term_end FROM prev) + 1
             WHEN e.election_reason = 'regular' AND (SELECT term_end FROM prev) IS NOT NULL THEN e.election_date
             WHEN e.election_reason IN ('resignation', 'death', 'recall', 'dissolution') THEN e.election_date
             WHEN e.election_reason IN ('by_election', 'increase') AND e.office_kind = 'assembly' AND (SELECT term_end FROM cur) IS NOT NULL THEN e.election_date
           END AS start_date,
           CASE
             WHEN e.election_reason = 'regular' AND (SELECT term_end FROM prev) >= e.election_date THEN 'regular_after_predecessor'
             WHEN e.election_reason = 'regular' AND (SELECT term_end FROM prev) IS NOT NULL THEN 'regular_from_polling'
             WHEN e.election_reason IN ('resignation', 'death', 'recall', 'dissolution') THEN 'from_polling'
             WHEN e.election_reason IN ('by_election', 'increase') THEN 'remaining_term'
           END AS term_rule,
           (SELECT term_end FROM cur) AS cur_end
      FROM e
  )
  SELECT s.start_date,
         CASE WHEN s.term_rule = 'remaining_term' THEN s.cur_end ELSE (s.start_date + INTERVAL '4 years' - INTERVAL '1 day')::DATE END,
         s.term_rule
    FROM s
   WHERE s.start_date IS NOT NULL
$$;
COMMENT ON FUNCTION policy_jp.office_term_for IS
  '選挙で生まれる任期の就任日・任期満了日（法定）と根拠（term_rule：regular_after_predecessor／regular_from_polling／from_polling／remaining_term）。'
  '定期は term_expirations の前任の満了日、補欠・増員は議会の満了日を使う。再選挙・国政・満了日の記録がないものは行なし（politician_offices_pending の term_unknown）';

-- 自動で建てた任期の id：'office:' ＋ 参選紀錄 id（参選が消えても〈外鍵は SET NULL〉どの参選から出たか分かる）
CREATE OR REPLACE FUNCTION policy_jp.office_id_for(p_politician_election_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT 'office:' || p_politician_election_id
$$;
COMMENT ON FUNCTION policy_jp.office_id_for IS '当選の参選から自動で建てた任期の id（office:<参選紀錄 id>）。この形の id だけが politician_offices_sync の管理下（手で足した任期は触らない）';

-- 任期の同期（每日排程・觸發器が呼ぶ）。p_today 以前に起きたことだけ書く（就任前の任期は建てない、まだ来ていない卸任は書かない）。
-- p_politician_election_id を渡すと、建てる・消すはその参選だけ（觸發器用）。卸任と期数の数え直しは毎回全体（日本站の任期は少ない）
CREATE OR REPLACE FUNCTION policy_jp.politician_offices_sync(p_today DATE DEFAULT policy_jp.activity_today(), p_politician_election_id TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_n INTEGER := 0;
  o policy_jp.politician_offices%ROWTYPE;
  v_new policy_jp.politician_offices%ROWTYPE;
  r RECORD;
BEGIN
  -- a. 消す：自動で建てた任期のうち、元の参選が当選でなくなった・非公開になった・消えたもの（その任期は最初からなかった。全列を履歴に残す）
  FOR o IN
    SELECT x.* FROM policy_jp.politician_offices x
      LEFT JOIN policy_jp.politician_elections pe ON policy_jp.office_id_for(pe.id) = x.id
      LEFT JOIN policy_jp.elections e ON e.id = pe.election_id
     WHERE x.id LIKE 'office:%'
       AND (p_politician_election_id IS NULL OR x.id = policy_jp.office_id_for(p_politician_election_id))
       AND (pe.id IS NULL OR pe.candidacy_status <> 'elected' OR pe.review_status <> 'published' OR e.review_status IS DISTINCT FROM 'published')
  LOOP
    BEGIN
      DELETE FROM policy_jp.source_refs WHERE target_table = 'politician_offices' AND target_id = o.id;
      DELETE FROM policy_jp.politician_offices WHERE id = o.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id, '*', to_jsonb(o), NULL, 'office-sync');
      v_n := v_n + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- 交接（handovers）などがこの任期を指している：消さずに残す（1 件のために同期全体を止めない）。politician_offices_pending の orphaned に出る
      RAISE WARNING 'policy_jp.politician_offices_sync：% はほかの記録から参照されているので消さない', o.id;
    END;
  END LOOP;

  -- b. 建てる・直す：当選・公開済みの参選で、任期が算出できて就任日が来たもの
  FOR r IN
    SELECT pe.id AS peid, pe.politician_id, e.id AS eid, e.lg_code, policy_jp.office_position_for(e.election_type) AS position,
           t.start_date, t.scheduled_end_date, x.id AS office_id
      FROM policy_jp.politician_elections pe
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      CROSS JOIN LATERAL policy_jp.office_term_for(e.id) t
      LEFT JOIN policy_jp.politician_offices x ON x.id = policy_jp.office_id_for(pe.id)
     WHERE pe.candidacy_status = 'elected' AND pe.review_status = 'published'
       AND (p_politician_election_id IS NULL OR pe.id = p_politician_election_id)
       AND t.start_date <= p_today
     ORDER BY t.start_date, pe.id
  LOOP
    IF r.office_id IS NULL THEN
      INSERT INTO policy_jp.politician_offices (id, politician_id, position, lg_code, term_no, start_date, scheduled_end_date,
                                                election_id, politician_election_id, review_status)
      VALUES (policy_jp.office_id_for(r.peid), r.politician_id, r.position, r.lg_code, 1, r.start_date, r.scheduled_end_date,
              r.eid, r.peid, 'published')
      RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', v_new.id, '*', NULL, to_jsonb(v_new), 'office-sync');
      v_n := v_n + 1;
    ELSE
      -- 人物・選挙・就任日・満了日が変わった（人の付け替え、満了日の記録の訂正）：まだ卸任していない任期だけ直す
      SELECT * INTO o FROM policy_jp.politician_offices WHERE id = r.office_id;
      IF o.end_date IS NULL AND (o.politician_id, o.position, o.lg_code, o.election_id, o.start_date, o.scheduled_end_date)
           IS DISTINCT FROM (r.politician_id, r.position, r.lg_code, r.eid, r.start_date, r.scheduled_end_date) THEN
        UPDATE policy_jp.politician_offices
           SET politician_id = r.politician_id, position = r.position, lg_code = r.lg_code, election_id = r.eid,
               start_date = r.start_date, scheduled_end_date = r.scheduled_end_date
         WHERE id = o.id
        RETURNING * INTO v_new;
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
        VALUES ('politician_offices', o.id, '*', to_jsonb(o), to_jsonb(v_new), 'office-sync');
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;

  -- c. 期数：同じ人・同じ職位・同じ団体で、この任期より前に始まった任期の数＋1（記録上の回数。自動で建てた任期だけ数え直す）
  FOR r IN
    SELECT x.id, x.term_no AS old_no,
           (SELECT count(*) FROM policy_jp.politician_offices y
             WHERE y.politician_id = x.politician_id AND y.position = x.position AND y.lg_code IS NOT DISTINCT FROM x.lg_code
               AND y.start_date < x.start_date AND y.review_status = 'published')::INTEGER + 1 AS new_no
      FROM policy_jp.politician_offices x
     WHERE x.id LIKE 'office:%'
  LOOP
    IF r.new_no <> r.old_no THEN
      UPDATE policy_jp.politician_offices SET term_no = r.new_no WHERE id = r.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', r.id, 'term_no', to_jsonb(r.old_no), to_jsonb(r.new_no), 'office-sync');
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- d. 卸任（起きたことだけ）：
  --    任期満了日を過ぎた → term_expired（law）。
  --    満了前に、同じ人が後で別の公職に就任した → その前日に took_other_office（inferred）。
  --    満了前に、同じ首長の職に別の人が就任した → その前日に other（inferred。辞職・失職などの理由は分からない）。
  FOR r IN
    WITH nx AS (
      SELECT x.id, x.start_date, x.scheduled_end_date,
             (SELECT min(y.start_date) FROM policy_jp.politician_offices y
               WHERE y.politician_id = x.politician_id AND y.id <> x.id AND y.start_date > x.start_date AND y.start_date <= p_today
                 AND y.review_status = 'published') AS self_next,
             CASE WHEN x.position IN ('governor', 'mayor', 'ward_mayor', 'town_mayor') THEN
               (SELECT min(y.start_date) FROM policy_jp.politician_offices y
                 WHERE y.position = x.position AND y.lg_code IS NOT DISTINCT FROM x.lg_code AND y.politician_id <> x.politician_id
                   AND y.start_date > x.start_date AND y.start_date <= p_today AND y.review_status = 'published') END AS succ_next
        FROM policy_jp.politician_offices x
       WHERE x.end_date IS NULL
    )
    SELECT nx.id,
           CASE WHEN least(nx.self_next, nx.succ_next) - 1 < nx.scheduled_end_date THEN least(nx.self_next, nx.succ_next) - 1 ELSE nx.scheduled_end_date END AS end_date,
           CASE WHEN least(nx.self_next, nx.succ_next) - 1 < nx.scheduled_end_date
                THEN CASE WHEN nx.self_next IS NOT NULL AND nx.self_next <= COALESCE(nx.succ_next, nx.self_next) THEN 'took_other_office' ELSE 'other' END
                ELSE 'term_expired' END AS end_reason,
           CASE WHEN least(nx.self_next, nx.succ_next) - 1 < nx.scheduled_end_date THEN 'inferred' ELSE 'law' END AS end_basis
      FROM nx
     WHERE nx.scheduled_end_date < p_today
        OR least(nx.self_next, nx.succ_next) - 1 < nx.scheduled_end_date
  LOOP
    SELECT * INTO o FROM policy_jp.politician_offices WHERE id = r.id;
    UPDATE policy_jp.politician_offices SET end_date = r.end_date, end_reason = r.end_reason, end_basis = r.end_basis WHERE id = r.id
    RETURNING * INTO v_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES ('politician_offices', r.id, 'end_date', NULL, to_jsonb(r.end_date::TEXT || ' ' || r.end_reason), 'office-sync');
    v_n := v_n + 1;
  END LOOP;

  -- e. 出典：自動で建てた任期の出典＝その参選の目前狀態の出典（当選の出典があとから付いた・主要が替わったときに追う）
  INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, role, origin)
  SELECT sr.source_id, 'politician_offices', x.id, sr.role, 'office-sync'
    FROM policy_jp.politician_offices x
    JOIN policy_jp.source_refs sr ON sr.target_table = 'politician_election_status' AND policy_jp.office_id_for(sr.target_id) = x.id
   WHERE x.id LIKE 'office:%'
  ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = EXCLUDED.role
   WHERE policy_jp.source_refs.role IS DISTINCT FROM EXCLUDED.role AND policy_jp.source_refs.origin = 'office-sync';
  DELETE FROM policy_jp.source_refs d
   WHERE d.target_table = 'politician_offices' AND d.origin = 'office-sync' AND d.target_id LIKE 'office:%'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs sr
                      WHERE sr.target_table = 'politician_election_status' AND policy_jp.office_id_for(sr.target_id) = d.target_id AND sr.source_id = d.source_id);
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION policy_jp.politician_offices_sync IS
  '新任期（正見 sync_politician_office_from_election＋politician_offices_close_ended の日本版）：当選・公開済みの参選から、就任日が来た任期を建てる（id＝office:<参選 id>、出典は当選の出典）、'
  '当選でなくなった参選の任期を消す、記録上の期数を数え直す、起きた卸任（満了＝term_expired/law、転任＝took_other_office/inferred、首長の後任就任＝other/inferred）を書く。'
  'まだ就任していない任期・まだ来ていない卸任は書かない（日本站の「現職」は end_date が空かどうかだけ）。毎日 JST 00:05 と、参選の状態が変わったときに呼ばれる。履歴は edit_history（office-sync）';

CREATE OR REPLACE FUNCTION policy_jp.politician_elections_office_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM policy_jp.politician_offices_sync(policy_jp.activity_today(), NEW.id);
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION policy_jp.politician_elections_office_sync IS '参選の状態・人物・選挙・公開状態が変わったら、その参選の任期を同期する（politician_offices_sync）';

-- 遅延（交易の最後に走る）：apply_candidacy は参選の行を書いたあとで目前狀態の出典を書くので、出典が揃ってから任期を同期する
DROP TRIGGER IF EXISTS politician_elections_office_sync ON policy_jp.politician_elections;
CREATE CONSTRAINT TRIGGER politician_elections_office_sync
  AFTER INSERT OR UPDATE OF candidacy_status, politician_id, election_id, review_status ON policy_jp.politician_elections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION policy_jp.politician_elections_office_sync();

-- 当選したのに任期がまだない参選（正常は「就任日待ち」だけ）：not_started＝就任日がまだ、term_unknown＝任期が算出できない（人が確かめる）
CREATE OR REPLACE VIEW policy_jp.politician_offices_pending WITH (security_invoker = true) AS
  SELECT pe.id AS politician_election_id, pe.politician_id, e.id AS election_id, e.election_type, e.election_reason, e.election_date, e.lg_code,
         t.start_date, t.scheduled_end_date, t.term_rule,
         CASE WHEN policy_jp.office_position_for(e.election_type) IS NULL THEN 'national'
              WHEN t.start_date IS NULL THEN 'term_unknown'
              ELSE 'not_started' END AS reason
    FROM policy_jp.politician_elections pe
    JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
    JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
    LEFT JOIN LATERAL policy_jp.office_term_for(e.id) t ON true
   WHERE pe.candidacy_status = 'elected' AND pe.review_status = 'published'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.politician_offices x WHERE x.id = policy_jp.office_id_for(pe.id))
  UNION ALL
  -- 当選でなくなったのに、交接などから参照されていて消せなかった自動の任期（人が直す）
  SELECT x.politician_election_id, x.politician_id, x.election_id, NULL, NULL, NULL, x.lg_code, x.start_date, x.scheduled_end_date, NULL, 'orphaned'
    FROM policy_jp.politician_offices x
    LEFT JOIN policy_jp.politician_elections pe ON policy_jp.office_id_for(pe.id) = x.id
   WHERE x.id LIKE 'office:%' AND (pe.id IS NULL OR pe.candidacy_status <> 'elected' OR pe.review_status <> 'published');
COMMENT ON VIEW policy_jp.politician_offices_pending IS
  '当選したのに任期（politician_offices）がまだない参選：not_started＝就任日がまだ（毎日の排程が就任日に建てる）、term_unknown＝就任日・満了日が算出できない'
  '（再選挙・満了日の記録がない定期・補欠など。人が確かめる）、national＝国政（任期を自動で建てない）、orphaned＝当選でなくなったのに交接などから参照されていて消せなかった自動の任期。service_role 用';

-- ------------------------------------------------------------
-- 6. 鏈の進度視圖：20261010060000 の版に第 5 步 results の一段（rs）と UNION 1 行を足しただけ（残りは一字も変えない）
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
  ),
  -- 第 4 步 policy：這場選舉至少有一位公約の対象，而且每一位都有上線の政見（または policy_missing が『查無』で冷卻中）
  pl AS (
    SELECT o.election_id, o.lg_code, (x.n > 0 AND x.n = x.n_done) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n,
               count(*) FILTER (WHERE policy_jp.chain_policy_exists(s.id) OR policy_jp.chain_task_checked('auto:policy_missing:' || s.id, ARRAY['not_found']) IS NOT NULL) AS n_done,
               max(s.updated_at) AS last_at
          FROM policy_jp.politician_elections s
         WHERE s.election_id = o.election_id AND s.review_status = 'published' AND s.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
      ) x
  ),
  -- 第 5 步 results：この選挙に取りやめ以外の参選が 1 人以上いて、全員の当落が決まった（elected／not_elected）。記録にない当選者を探す臂はこのあと
  rs AS (
    SELECT o.election_id, o.lg_code, (x.n > 0 AND x.n_open = 0) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, count(*) FILTER (WHERE s.candidacy_status NOT IN ('elected', 'not_elected')) AS n_open, max(s.updated_at) AS last_at
          FROM policy_jp.politician_elections s
         WHERE s.election_id = o.election_id AND s.review_status = 'published' AND s.candidacy_status <> 'withdrawn'
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
  SELECT f.election_id, f.lg_code, 'profile'::TEXT, f.done, CASE WHEN f.done THEN f.last_at END FROM pf f
  UNION ALL
  SELECT p.election_id, p.lg_code, 'policy'::TEXT, p.done, CASE WHEN p.done THEN p.last_at END FROM pl p
  UNION ALL
  SELECT r.election_id, r.lg_code, 'results'::TEXT, r.done, CASE WHEN r.done THEN r.last_at END FROM rs r;
COMMENT ON VIEW policy_jp.election_chain_progress IS
  '選舉鏈的進度：開著的選舉×團體×步驟（election_chain_steps()）一列，done＝這一步的缺口都補上了，或回報查無、還在冷卻中。總表の chain_gate 讀它（seed 時算一次）。service_role 用';

-- ------------------------------------------------------------
-- 7. 臂名清單と総表：20261011070000 の版本に名前 2 つ／UNION 2 行を足しただけ（残りは一字も変えない）
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
    'profile_detail_gap',
    'policy_missing',
    'candidate_status_stale',
    'not_running',
    'withdrawn_filing',
    'candidacy_source_missing',
    'election_results',
    'elected_missing'
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
  UNION ALL SELECT 'policy_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_missing() t
  UNION ALL SELECT 'candidate_status_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_candidate_status_stale() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM policy_jp.contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'candidacy_source_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_candidacy_source_missing() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_results() t
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_elected_missing() t
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


-- 層内排序の步驟順位：20261011070000 の版に WHEN 1 行（開票結果の任務型別＝7：policy_missing の次）
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
                  WHEN 'policy_missing' THEN 6
                  WHEN 'candidate_status_stale' THEN 4
                  WHEN 'not_running_recheck' THEN 4
                  WHEN 'candidacy_source_missing' THEN 4
                  WHEN 'election_result_missing' THEN 7
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 8. 規則（臂的規則＋優先層規則；冪等）
-- ------------------------------------------------------------
-- 窗口：投票日の翌日起、終わりなし（鏈が投票日後 90 日で閉じる）。日付條件は規則に書き、臂では比べない
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, after_step, params, note)
SELECT a.activity, 'event', 'polling', 1, NULL, 0, 'announced', a.after_step, a.params::JSONB, a.note
  FROM (VALUES
    ('election_results', 'candidacy', '{"cap":300,"chain_fallback":{"kind":"polling","offset":1}}',
     '選挙鎖・当落（正見 election_results）：投票日を過ぎても当落の決まっていない参選を、選管の開票結果で elected／not_elected に。投票日の翌日起（鏈が閉じるまで）。同時に開くのは最大 300 件（投票日の古い選挙が先）。得票数は記録しない'),
    ('elected_missing', 'results', '{"cap":100,"chain_fallback":{"kind":"polling","offset":7}}',
     '選挙鎖・記録にない当選者（正見 elected_missing）：定数に当選者が足りない・定数が分からない選挙で、開票結果の当選者全員と照らして記録にない当選者を足す。投票日の翌日起、全員の当落が決まってから（決まらなくても投票日の 7 日後）。同時に開くのは最大 100 件')
  ) AS a(activity, after_step, params, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority IS NULL);

-- 優先層：投票日の翌日から前段（開票の結果は最近の選挙ほど要る。鏈が 90 日で閉じるので後段はない）
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT 'priority:' || x.arm, 'event', 'polling', 1, NULL, 0, 1::SMALLINT, x.arm || '：前段：投票日の翌日から（開票結果は鏈が閉じるまで前段）'
  FROM (VALUES ('election_results'), ('elected_missing')) AS x(arm)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:' || x.arm AND r.priority = 1);

-- 主控台時間軸の段（投票日の翌日起算＝第 4 段。規則からも同じ段が出るが、規則を止めたときの後備として登記）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('election_results', 4, '当落（投票日の翌日から）'),
  ('elected_missing', 4, '記録にない当選者（全員の当落が決まってから）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- 每日排程：JST 00:05（UTC 15:05。activity_today() が日本時間で日付を替えた直後）に就任日の来た任期を建て、満了した任期を閉じる
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-offices-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-offices-daily')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-offices-daily', '5 15 * * *', 'SELECT policy_jp.politician_offices_sync();')$q$;
  END IF;
END
$$;

-- いま当選の参選がもうあれば（上線前に当落が入っていた分）一度同期しておく
SELECT policy_jp.politician_offices_sync();

-- ------------------------------------------------------------
-- 9. 權限（新函式預設對 PUBLIC 可執行；明寫收回。CREATE OR REPLACE 保留原有權限）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_election_results(), policy_jp.contribution_auto_tasks_elected_missing(),
  policy_jp.election_seats_needed(TEXT), policy_jp.office_position_for(TEXT), policy_jp.office_term_for(TEXT), policy_jp.office_id_for(TEXT),
  policy_jp.politician_offices_sync(DATE, TEXT), policy_jp.politician_elections_office_sync()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_election_results(), policy_jp.contribution_auto_tasks_elected_missing(),
  policy_jp.election_seats_needed(TEXT), policy_jp.office_position_for(TEXT), policy_jp.office_term_for(TEXT), policy_jp.office_id_for(TEXT),
  policy_jp.politician_offices_sync(DATE, TEXT)
  TO service_role;
REVOKE ALL ON policy_jp.politician_offices_pending FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_jp.politician_offices_pending TO service_role;

-- ------------------------------------------------------------
-- 10. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 兩支臂：規則是「投票日 +1 起、沒有止」、election_results 掛 candidacy 之後、elected_missing 掛 results 之後，都有後備與 cap
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'election_results' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'event'
                    AND r.from_kind = 'polling' AND r.from_offset = 1 AND r.until_kind IS NULL
                    AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap')
     OR NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'elected_missing' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'event'
                    AND r.from_kind = 'polling' AND r.from_offset = 1 AND r.until_kind IS NULL
                    AND r.after_step = 'results' AND r.params ? 'chain_fallback' AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：election_results／elected_missing 的規則不是「投票日 +1 起、沒有止、after_step=candidacy／results、有 chain_fallback 與 cap」';
  END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  -- 三處一起加
  IF NOT (policy_jp.activity_arm_names() @> ARRAY['election_results', 'elected_missing']) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() 沒有兩支新臂';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_election_results()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_elected_missing()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 總表沒有兩支新臂的分支';
  END IF;
  IF NOT ('results' = ANY (policy_jp.election_chain_steps())) THEN
    RAISE EXCEPTION 'policy_jp：election_chain_steps() 沒有 results';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_views v WHERE v.schemaname = 'policy_jp' AND v.viewname = 'election_chain_progress' AND v.definition LIKE '%''results''::text%') THEN
    RAISE EXCEPTION 'policy_jp：election_chain_progress 沒有 results 一段';
  END IF;
  IF policy_jp.chain_step_rank('auto:election_result_missing:x', 'election_result_missing') <> 7 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank 沒有登記 election_result_missing';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m WHERE m.arm IN ('election_results', 'elected_missing') AND m.stage = 4) <> 2 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map 沒有登記兩支新臂（第 4 段）';
  END IF;
  -- 記録にない当選者は一題多份：candidacy の落庫で收回しない（觸發器の WHEN）
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'policy_jp' AND c.relname = 'contributions' AND t.tgname = 'contributions_drop_dispatch'
                    AND pg_get_triggerdef(t.oid) LIKE '%auto:roster_check:%' AND pg_get_triggerdef(t.oid) LIKE '%:elected:%') THEN
    RAISE EXCEPTION 'policy_jp：contributions_drop_dispatch 的 WHEN 沒有排除 roster_check 與記録にない当選者';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'policy_jp' AND c.relname = 'politician_elections' AND t.tgname = 'politician_elections_office_sync') THEN
    RAISE EXCEPTION 'policy_jp：politician_elections 沒有任期同期の觸發器';
  END IF;
  -- 任期の法定計算：定期（前任の満了日が投票日以降）＝満了日の翌日から 4 年
  IF (SELECT ('2026-11-07'::DATE + 1, ('2026-11-08'::DATE + INTERVAL '4 years' - INTERVAL '1 day')::DATE) <> (DATE '2026-11-08', DATE '2030-11-07')) THEN
    RAISE EXCEPTION 'policy_jp：任期の日付計算がおかしい';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_election_results()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_elected_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.politician_offices_sync(date,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.office_term_for(text)', 'EXECUTE')
     OR has_table_privilege('anon', 'policy_jp.politician_offices_pending', 'SELECT') THEN
    RAISE EXCEPTION 'policy_jp：開票結果・新任期（B 期）の関数・視圖を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
