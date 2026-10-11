-- 日本站派工臂對齊正見 A 期第一支：參選狀態推進・退選查核・參選出處補選管（工作單 Yooliang/policy-ops#95）
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-arms-parity.md 的 A 期第一列。照搬正見現行的四支臂（時期屬「3 登記後到投票」，日本＝告示日後到投票日）：
--
--   正見臂                         日本臂（activity）          任務型別（task_type）       task_id                                   交件
--   raw:candidate_status_stale     candidate_status_stale      candidate_status_stale      auto:candidate_status_stale:<參選 id>     candidacy（filed／withdrawn）
--   not_running                    not_running                 not_running_recheck         auto:not_running_recheck:<參選 id>        no_change（confirmed）／task_suggestion
--   withdrawn_filing               withdrawn_filing            not_running_recheck         auto:not_running_recheck:filing:<參選 id> candidacy（withdrawn＋withdrawn_after_filing）
--   raw:candidacy_source_missing   candidacy_source_missing    candidacy_source_missing    auto:candidacy_source_missing:<參選 id>   candidacy（同じ状態で選管の出典を足す）
--
--   ※ 「紀錄有誤、其實有届出」的訂正（正見用 correction 改 registered）日本站改用 task_suggestion 報告（同樣的理由：correction 放不下參選 id、也不自動落庫），由人確認後反映。
--   ※ 日本站的臂名不帶 raw:（既有的 roster_check／policy_missing 也一樣）；任務型別・task_id 的形狀照正見現行（20261010170000／20261006220000／20261006100000）。
--     <參選 id> ＝ politician_elections.id ＝ <人物 id>:<選舉 id>:<district_kind>。
--
-- 時間窗與鏈（正見的做法：日期條件寫在規則、不寫在臂）：
--   四條規則都是 window_kind='event'、from announced +0（告示日起）、until polling +0（投票日當天止）、min_status='announced'。
--   掛選舉鏈：after_step='candidacy'（這場選舉已有人表明以上＝第 2 步之後），params.chain_fallback＝announced +0（窗口起點就是告示日，
--   鏈卡住也不延後；自我檢查擋沒有後備的鏈上規則）；cap 200（同其他鏈上臂；正見沒有 cap，由佇列比例節流）。臂本身不比日期。
--   三處一起加：總表加四行 UNION、activity_arm_names() 加四個名字、activity_rules 種四條規則（另加各臂的優先層規則，同 roster_check 的 60／181 天）；
--   chain_step_rank 補順位（都是第 2 步之後的候選人類＝4）；console_arm_stage_map 登記第 3 段（告示日起算第 3 段，規則本身也算得出同一段）。
--
-- 與正見不同的地方（登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY，why 欄寫 FOLLOWED／DEVIATED）：
--   1. 狀態詞彙：正見讀 rumored／likely（傳聞・可能參選）→ 登記・不參選；日本站沒有傳聞（CLAUDE.md：不收傳聞），對應的是 considering／declared
--      → 告示日後必須是 filed（届出）或 withdrawn（取りやめ）。所以 candidate_status_stale 的對象是 considering＋declared（正見只有 considering 一格）。
--   2. 名冊：正見附中選會登記彙總表（cec_registrations、roster_check_scope）當線索，日本站沒有可整批比對的名冊，改指「選管公表の立候補者一覧」，
--      不收窄到單一縣市。正見的 cec_listed_as／rosters／prior_not_on_roster 不搬。
--   3. 不參選的核對旗標：正見用 politician_elections.verified；日本站沒有這欄，改看「這件任務有人回報 no_change confirmed」或「withdrawn_after_filing
--      這個欄位已有變更紀錄」（正見也用後一條）＝照過名冊。
--   4. 退選補 withdrawn_after_filing 的交件：正見用 correction；日本站 correction 還不自動落庫（停在 verified），而且 target_id 上限 64 字、放不下參選 id
--      （<人物 id>:<選舉 id>:<district_kind> 約 100 字），任務會永遠關不掉，所以沿用 candidacy
--      （計畫：交件沿用 candidacy），apply_candidacy 在「同じ状態の withdrawn で withdrawn_after_filing が空」のとき空欄を埋める（庫に値があって違う＝conflict、
--      同じ＝unchanged；状態・日付は触らない）。ほかの分岐は 20261010120000 の版から一字も変えない。
--   5. candidacy_source_missing：正見這個任務型別有七種子類（缺縣市・缺選區・缺號次…）都屬台灣專屬；搬的是「參選紀錄沒有可查證的出處」那一種，
--      日本站的判準是「這筆參選（filed）沒有 official 等級的出處（source_refs 的 politician_elections／politician_election_status 掛的 sources.source_kind）」。
--      declared 以下不派（告示後本來就由 candidate_status_stale 先推進成 filed，同一人不要兩個任務）。
--   6. 不搬：locations／regions 的縣市欄位、roster_check_scope 的日期欄（日本站日期讀 election_milestones_all：announced＝告示日、polling＝投票日）。
--
-- 交件與落庫：不發明新的 result 值。TS 驗證（_shared/jp/contribution-schema.ts）把三個任務型別加進 task_id 比對：candidacy 的 politician_id／election_id／
-- district_kind 要組得出任務的參選 id；照合（not_running，非 filing）用 no_change／task_suggestion，不收 candidacy。協議版號 0.13.0。
--
-- 守門：supabase/functions/_shared/policy-jp-arms-candidacy-status.test.ts（PGlite 假時鐘：告示前不開、告示日開、投票日後收回 window、補完收回 filled；
-- 還原驗證）、policy-jp-dispatch-drift.test.ts（新函式登記、被重新定義的函式 mig 清單）、jp/contribution-schema-chain.test.ts、jp-entry-chain.test.ts（端到端）。
-- 不碰 public、ditrust。冪等（規則用 NOT EXISTS、登記用 ON CONFLICT），尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 共用小函式
-- ------------------------------------------------------------
-- 開著的、已上線的選舉裡，上線的參選紀錄（不分狀態）；四支臂共用的對象清單（chain_policy_subjects 的「不分狀態」版）
CREATE OR REPLACE FUNCTION policy_jp.chain_candidacy_records() RETURNS TABLE (
  politician_election_id TEXT, politician_id TEXT, name TEXT, kana TEXT, candidacy_status TEXT, withdrawn_after_filing BOOLEAN, status_date DATE,
  district_kind TEXT, district_name TEXT, election_id TEXT, election_name TEXT, election_type TEXT, election_date DATE, notice_date DATE,
  lg_code TEXT, lg_name TEXT, pref_name TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT pe.id, pe.politician_id, pp.name, pp.kana, pe.candidacy_status, pe.withdrawn_after_filing, pe.status_date, pe.district_kind, pe.district_name,
         e.id, e.name, e.election_type, e.election_date, policy_jp.election_notice_date(e.id), e.lg_code,
         COALESCE(g.name, '（名称未確認）'),
         COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）')
    FROM policy_jp.chain_open_elections o
    JOIN policy_jp.elections e ON e.id = o.election_id AND o.basis = 'published' AND e.review_status = 'published'
    JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
    JOIN policy_jp.politician_elections pe ON pe.election_id = e.id AND pe.review_status = 'published'
    JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
$$;
COMMENT ON FUNCTION policy_jp.chain_candidacy_records IS
  '開いている・上線済みの選挙の、上線済みの参選紀錄（状態を問わない）＋選挙・団体の表示用の列。候補者の状態を確かめる四つの臂（candidate_status_stale・not_running・withdrawn_filing・candidacy_source_missing）が共有する対象';

-- この参選の「目前狀態」か参選そのものに、選管などの official 等級の出典が付いているか
CREATE OR REPLACE FUNCTION policy_jp.candidacy_has_official_source(p_politician_election_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.source_refs r JOIN policy_jp.sources s ON s.id = r.source_id
                  WHERE r.target_table IN ('politician_elections', 'politician_election_status') AND r.target_id = p_politician_election_id
                    AND s.source_kind = 'official')
$$;
COMMENT ON FUNCTION policy_jp.candidacy_has_official_source IS
  '参選紀錄（politician_elections）または目前狀態（politician_election_status）に official 等級の出典（sources.source_kind＝official：*.go.jp・*.lg.jp・自治体の公式サイト）が付いているか。candidacy_source_missing 臂が共有';

-- ------------------------------------------------------------
-- 2. 臂 candidate_status_stale：告示日を過ぎても considering／declared のままの参選 → filed か withdrawn かを選管の一覧で確かめる
--    （正見 raw:candidate_status_stale の日本版。一人一件、task_id＝auto:candidate_status_stale:<参選 id>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_candidate_status_stale()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'candidate_status_stale' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.chain_candidacy_records() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND s.candidacy_status IN ('considering', 'declared')
       AND NOT policy_jp.task_unavailable('auto:candidate_status_stale:' || s.politician_election_id)
     -- 投票日が過ぎた選挙は後ろへ（並び順だけ。窓を開けるかどうかは規則が決める）
     ORDER BY (s.election_date < policy_jp.activity_today()), s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:candidate_status_stale:' || g.politician_election_id, 'candidate_status_stale',
         jsonb_build_object('politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'chain_lg_code', g.lg_code, 'chain_step', 'candidacy'),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）は、当方の記録では「'
           || CASE g.candidacy_status WHEN 'considering' THEN '出馬を検討' ELSE '立候補を表明' END || '」（' || g.status_date || '）のままです。'
           || '告示日（' || COALESCE(g.notice_date::TEXT, '未記録') || '）を過ぎ、立候補の届出は締め切られているので、結論は次のどちらかしかありません。'
           || '【届出した】選挙管理委員会が公表した立候補者（届出）の一覧にこの人が載っている → contribution_type=candidacy で candidacy_status=filed、'
           || 'status_date＝届出（受理）の日（告示日以降・投票日以前）を提出してください。'
           || '【届出していない】一覧に載っていない → candidacy_status=withdrawn、withdrawn_after_filing=false（届出前に取りやめ）、'
           || 'status_date＝一覧が公表された日（本人が出馬しないと表明した日が分かればその日。ただし現在の status_date 以降）で提出してください。'
           || 'payload は politician_id（' || g.politician_id || '）・election_id（' || g.election_id || '）・candidacy_status・status_date・district_kind（' || g.district_kind || '）'
           || CASE WHEN g.district_name IS NOT NULL THEN '・district_name（' || g.district_name || '）' ELSE '' END
           || '、withdrawn のときだけ withdrawn_after_filing。選挙区は現在の記録のまま変えません。'
           || 'source_urls は必ず選挙管理委員会が公表した一覧のページにしてください（報道だけの出典は避けます）。'
           || '一覧がまだ公表されていない・見つからないときは、状態を推測で変えず、contribution_type=no_change、outcome=not_found（ページが開けなかったときは unreachable）、'
           || 'checked_urls に探した場所を入れて報告してください。得票数・得票率は記録しません（payload に入れない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_candidate_status_stale IS
  '参選状態の推進（正見 raw:candidate_status_stale の日本版）：開いている選挙で considering／declared のままの参選 → candidate_status_stale 任務（一人一件、task_id＝auto:candidate_status_stale:<参選 id>）。'
  '日付（告示日起・投票日止）は規則 activity_rules「candidate_status_stale」が決める。完了は candidacy（filed／withdrawn）の落庫。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 3. 臂 not_running：「届出前に取りやめ」（withdrawn・withdrawn_after_filing=false）と記録されたまま、選管の一覧と照らしていない参選 → 一覧で確かめる
--    （正見 not_running の日本版。task_id＝auto:not_running_recheck:<参選 id>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_not_running()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'not_running' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.chain_candidacy_records() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND s.candidacy_status = 'withdrawn' AND s.withdrawn_after_filing IS NOT DISTINCT FROM false
       -- 照合済み（正見の pe.verified IS NOT TRUE に当たる）：この任務に no_change confirmed の報告がある、または withdrawn_after_filing の欄に変更履歴がある（一覧を見て埋めた）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = 'auto:not_running_recheck:' || s.politician_election_id AND tc.outcome = 'confirmed')
       AND NOT EXISTS (SELECT 1 FROM policy_jp.edit_history h WHERE h.table_name = 'politician_elections' AND h.record_id = s.politician_election_id
                          AND h.field = 'withdrawn_after_filing' AND h.reverted_at IS NULL)
       AND NOT policy_jp.task_unavailable('auto:not_running_recheck:' || s.politician_election_id)
     ORDER BY (s.election_date < policy_jp.activity_today()), s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:not_running_recheck:' || g.politician_election_id, 'not_running_recheck',
         jsonb_build_object('kind', 'not_running', 'politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'chain_lg_code', g.lg_code, 'chain_step', 'candidacy'),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）は「届出前に取りやめ（出馬しない）」と記録されていますが、'
           || '選挙管理委員会が公表した立候補者（届出）の一覧と照らし合わせた人がまだいません。'
           || 'この記録の代償は大きく、取りやめになった人には公約・基本情報・出典の各任務が派されなくなるので、一度は一覧で確かめます。'
           || '選挙管理委員会の一覧（候補者名簿）を開いて、この人を探してください。'
           || '【載っていない（確かに届出していない）】 → contribution_type=no_change、outcome=confirmed、checked_urls に照合した一覧のページ、finding に確かめた内容を書いて報告してください。'
           || 'confirmed で報告すると照合済みになり、同じ任務は二度と派されません。'
           || '【載っている（実は届出している）】 → 記録のほうが誤りです。取りやめは終点なので candidacy では戻せません。'
           || 'task_suggestion で報告してください：title に「届出済みの取りやめ記録の訂正提案」、description に載っていた一覧のページと一覧での表記、'
           || 'target_politician_id に ' || g.politician_id || '（参選紀錄の id は target.politician_election_id。人が確かめて直します）。'
           || '【一覧が見つからない・開けない】 → no_change、outcome=not_found または unreachable で、探した場所を checked_urls に入れて報告してください（これは照合済みにはならず、数日後に別の人が再挑戦します）。'
           || '推測で状態を変えないでください。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_not_running IS
  '不出馬の照合（正見 not_running の日本版）：withdrawn で withdrawn_after_filing=false の参選のうち、選管の一覧と照合した人がいないもの → not_running_recheck 任務（task_id＝auto:not_running_recheck:<参選 id>）。'
  '照合済み＝no_change confirmed の報告、または withdrawn_after_filing 欄の変更履歴。日付は規則 activity_rules「not_running」が決める。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 4. 臂 withdrawn_filing：withdrawn なのに届出の前か後か分からない（withdrawn_after_filing が空）参選 → 一覧で確かめて補う
--    （正見 withdrawn_filing の日本版。task_id＝auto:not_running_recheck:filing:<参選 id>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_withdrawn_filing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'withdrawn_filing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.chain_candidacy_records() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND s.candidacy_status = 'withdrawn' AND s.withdrawn_after_filing IS NULL
       -- 同じ参選の答えがもう審議中なら重ねて派さない（正見の queued）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND c.payload->>'candidacy_status' = 'withdrawn' AND c.payload ? 'withdrawn_after_filing'
                          AND c.payload->>'politician_id' = s.politician_id AND c.payload->>'election_id' = s.election_id AND c.payload->>'district_kind' = s.district_kind)
       AND NOT policy_jp.task_unavailable('auto:not_running_recheck:filing:' || s.politician_election_id)
     ORDER BY (s.election_date < policy_jp.activity_today()), s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:not_running_recheck:filing:' || g.politician_election_id, 'not_running_recheck',
         jsonb_build_object('kind', 'withdrawn_filing', 'politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'chain_lg_code', g.lg_code, 'chain_step', 'candidacy'),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）は「取りやめ」と記録されていますが、'
           || '届出をする前に取りやめたのか、届出をした後に辞退したのかが分かりません（withdrawn_after_filing が空）。'
           || '「届出後に辞退」と「届出もしていない」は当事者にとってまったく違うことなので、選挙管理委員会が公表した立候補者（届出）の一覧で確かめて補ってください。'
           || '【一覧に載っていない（届出前に取りやめ）】 → withdrawn_after_filing=false。'
           || '【一覧に載っていた（届出後に辞退）】 → withdrawn_after_filing=true（辞退の報道があれば source_urls に足します）。'
           || 'contribution_type=candidacy で提出します：payload は politician_id（' || g.politician_id || '）・election_id（' || g.election_id || '）・candidacy_status=withdrawn・'
           || 'status_date（現在の記録と同じ ' || g.status_date || '）・district_kind（' || g.district_kind || '）'
           || CASE WHEN g.district_name IS NOT NULL THEN '・district_name（' || g.district_name || '）' ELSE '' END
           || '・withdrawn_after_filing（true／false）。状態と日付は変わらず、withdrawn_after_filing の空欄が埋まります。source_urls は確かめた一覧のページです。'
           || '【一覧に載っていて、しかも辞退していない（記録が誤り）】 → candidacy では戻せません。task_suggestion（title に「届出済みの取りやめ記録の訂正提案」、'
           || 'description に載っていた一覧のページ、target_politician_id に ' || g.politician_id || '）で報告してください（参選紀錄の id は target.politician_election_id）。'
           || '一覧が見つからない・開けないときは、no_change、outcome=not_found または unreachable で探した場所を checked_urls に入れて報告してください（推測で埋めない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_withdrawn_filing IS
  '退選の届出前後の補完（正見 withdrawn_filing の日本版）：withdrawn で withdrawn_after_filing が空の参選 → not_running_recheck 任務（kind=withdrawn_filing、task_id＝auto:not_running_recheck:filing:<参選 id>）。'
  '交件は candidacy（同じ withdrawn で withdrawn_after_filing を足す。apply_candidacy が空欄を埋める）。日付は規則 activity_rules「withdrawn_filing」が決める。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 5. 臂 candidacy_source_missing：届出済み（filed）なのに official 等級の出典が付いていない参選 → 選管の公表ページを足す
--    （正見 raw:candidacy_source_missing の「出典がない」の日本版。一人一件、task_id＝auto:candidacy_source_missing:<参選 id>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_candidacy_source_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'candidacy_source_missing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*,
           -- いま付いている出典（どんな出典が付いているかを見せる）
           COALESCE((SELECT jsonb_agg(jsonb_build_object('url', x.url, 'source_kind', x.source_kind) ORDER BY x.url)
                       FROM (SELECT DISTINCT so.url, so.source_kind
                               FROM policy_jp.source_refs r JOIN policy_jp.sources so ON so.id = r.source_id
                              WHERE r.target_table IN ('politician_elections', 'politician_election_status') AND r.target_id = s.politician_election_id
                              LIMIT 10) x), '[]'::JSONB) AS have
      FROM policy_jp.chain_candidacy_records() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND s.candidacy_status = 'filed'
       AND NOT policy_jp.candidacy_has_official_source(s.politician_election_id)
       AND NOT policy_jp.task_unavailable('auto:candidacy_source_missing:' || s.politician_election_id)
     ORDER BY (s.election_date < policy_jp.activity_today()), s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:candidacy_source_missing:' || g.politician_election_id, 'candidacy_source_missing',
         jsonb_build_object('politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'current_sources', g.have,
                            'chain_lg_code', g.lg_code, 'chain_step', 'candidacy'),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）は届出済み（filed、' || g.status_date || '）と記録されていますが、'
           || '出典が報道などにとどまり（target.current_sources）、選挙管理委員会の公表ページに当たっていません。届出は選管の公表が一次の出典です。'
           || '選挙管理委員会が公表した立候補者（届出）の一覧のページ（告示のお知らせ、候補者名簿、選挙公報の掲載ページなど）を探し、この人が載っていることを確かめてください。'
           || '載っていたら、contribution_type=candidacy を現在の記録と同じ内容で出します：politician_id（' || g.politician_id || '）・election_id（' || g.election_id || '）・candidacy_status=filed・'
           || 'status_date（' || g.status_date || '。選管の公表で届出日が分かるならその日）・district_kind（' || g.district_kind || '）'
           || CASE WHEN g.district_name IS NOT NULL THEN '・district_name（' || g.district_name || '）' ELSE '' END
           || '、source_urls にその選管のページを付けます。状態は変わらず、出典だけが足されます。'
           || '一覧に載っていなかった・ページが見つからないときは candidacy を出さず、no_change、outcome=not_found（開けなかったときは unreachable）で、'
           || '探した場所と見たものを checked_urls と finding に書いて報告してください（推測で出典を作らない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・告示のお知らせ', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', g.lg_name || ' 公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_candidacy_source_missing IS
  '参選の出典を選管に（正見 raw:candidacy_source_missing の「出典がない」の日本版）：filed で official 等級の出典がない参選 → candidacy_source_missing 任務（一人一件、task_id＝auto:candidacy_source_missing:<参選 id>）。'
  '完了は candidacy（同じ filed）の落庫で選管の出典が足されること。日付は規則 activity_rules「candidacy_source_missing」が決める。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 6. 落庫：apply_candidacy は 20261010120000 の版に、「同じ withdrawn で withdrawn_after_filing の空欄を埋める」分岐を足しただけ（残りは一字も変えない）
-- ------------------------------------------------------------
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
      -- >>> A 期（policy-ops#95）：withdrawn の withdrawn_after_filing は空欄だけ埋める。庫に値があって違う＝conflict（上書きしない）。読みの空欄埋めより先に判定する
      IF v_status = 'withdrawn' AND v_wd IS NOT NULL AND pe.withdrawn_after_filing IS NOT NULL AND pe.withdrawn_after_filing <> v_wd THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politician_elections', 'record_id', pe.id,
          'message', format('庫の %s は withdrawn_after_filing=%s で、提出の %s と違う。届出前後は上書きしない', pe.id, pe.withdrawn_after_filing, v_wd));
      END IF;
      -- <<< A 期
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
      -- >>> A 期（policy-ops#95）：同じ withdrawn の再提出で withdrawn_after_filing の空欄を埋める（状態・日付は触らない）
      IF v_status = 'withdrawn' AND v_wd IS NOT NULL AND pe.withdrawn_after_filing IS NULL THEN
        UPDATE policy_jp.politician_elections SET withdrawn_after_filing = v_wd WHERE id = pe.id;
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('politician_elections', pe.id, 'withdrawn_after_filing', NULL, to_jsonb(v_wd), c.id, 'auto-apply');
        PERFORM policy_jp.source_write('politician_election_status', pe.id, c.source_urls, 'candidacy');
        UPDATE policy_jp.contributions SET applied_politician_id = v_pid WHERE id = c.id;
        RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politician_elections', 'record_id', pe.id,
          'message', format('%s の withdrawn_after_filing を %s に補完（取りやめ・%s は変えない）', pe.id, v_wd, pe.status_date));
      END IF;
      -- <<< A 期
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
  'candidacy 交件の落庫（politician_elections。新しい人なら politicians も）。同じ状態＝unchanged、後戻り・終点の付け替え・日付の巻き戻し・選挙区違い＝conflict（退件）、内容の不備＝invalid（退件）。得票數は受け付けない。kana は告示前は任意・告示日以降は必須（policy-ops#60）、読みがないときの同一人は「同名・同団体・生年が衝突しない人が一人だけ」｜A 期（policy-ops#95）：同じ withdrawn の再提出は withdrawn_after_filing の空欄を埋める（値があって違う＝conflict）';


-- ------------------------------------------------------------
-- 7. 臂名清單と総表：20261010060000 の版本に名前 4 つ／UNION 4 行を足しただけ（残りは一字も変えない）
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
    'candidacy_source_missing'
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


-- 層内排序の步驟順位：20261010060000 の版に WHEN 3 行（候補者の状態を確かめる三つの任務型別＝4：roster_check と同じ「参選人有誰」の段）
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6。登録のない auto 型別は 9';


-- ------------------------------------------------------------
-- 8. 規則（臂的規則＋優先層規則；冪等）
-- ------------------------------------------------------------
-- 窗口：告示日 +0 起、投票日 +0 止（日期條件寫在規則、不寫在臂）。前一步（candidacy＝已有人表明以上）完成才開；止まっていても告示日には開く（後備）
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, after_step, params, note)
SELECT a.activity, 'event', 'announced', 0, 'polling', 0, 'announced', 'candidacy', '{"cap":200,"chain_fallback":{"kind":"announced","offset":0}}'::JSONB, a.note
  FROM (VALUES
    ('candidate_status_stale',
     '選挙鎖・参選状態の推進（正見 raw:candidate_status_stale）：告示日を過ぎても considering／declared のままの参選を、選管の立候補者一覧で確かめて filed か withdrawn に進めさせる。告示日起・投票日当日止。同時に開くのは最大 200 件（投票日の近い選挙が先）'),
    ('not_running',
     '選挙鎖・不出馬の照合（正見 not_running）：「届出前に取りやめ」と記録されたまま選管の一覧と照らしていない参選を、一覧で確かめさせる。告示日起・投票日当日止。同時に開くのは最大 200 件'),
    ('withdrawn_filing',
     '選挙鎖・退選の届出前後（正見 withdrawn_filing）：withdrawn で withdrawn_after_filing が空の参選に、選管の一覧で確かめた届出前後を補わせる。告示日起・投票日当日止。同時に開くのは最大 200 件'),
    ('candidacy_source_missing',
     '選挙鎖・参選の出典を選管に（正見 raw:candidacy_source_missing）：filed なのに official 等級の出典がない参選に、選管の公表ページを足させる。告示日起・投票日当日止。同時に開くのは最大 200 件')
  ) AS a(activity, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT 'priority:' || x.arm, 'event', t.from_kind, t.from_offset, t.until_kind, t.until_offset, t.tier, x.arm || '：' || t.note
  FROM (VALUES ('candidate_status_stale'), ('not_running'), ('withdrawn_filing'), ('candidacy_source_missing')) AS x(arm)
  CROSS JOIN (VALUES
    ('polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の任務（最近の選挙を先に派す）'),
    (NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の任務；61～180 日は既定の層（中段）')
  ) AS t(from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:' || x.arm AND r.priority = t.tier);

-- 主控台時間軸の段（告示日起算＝第 3 段。規則からも同じ段が出るが、規則を止めたときの後備として登記）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('candidate_status_stale', 3, '参選状態の推進（告示後）'),
  ('not_running', 3, '不出馬の照合（告示後）'),
  ('withdrawn_filing', 3, '退選の届出前後（告示後）'),
  ('candidacy_source_missing', 3, '参選の出典を選管に（告示後）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 9. 權限（新函式預設對 PUBLIC 可執行；明寫收回。CREATE OR REPLACE 保留原有權限）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.chain_candidacy_records(), policy_jp.candidacy_has_official_source(TEXT),
  policy_jp.contribution_auto_tasks_candidate_status_stale(), policy_jp.contribution_auto_tasks_not_running(),
  policy_jp.contribution_auto_tasks_withdrawn_filing(), policy_jp.contribution_auto_tasks_candidacy_source_missing()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.chain_candidacy_records(), policy_jp.candidacy_has_official_source(TEXT),
  policy_jp.contribution_auto_tasks_candidate_status_stale(), policy_jp.contribution_auto_tasks_not_running(),
  policy_jp.contribution_auto_tasks_withdrawn_filing(), policy_jp.contribution_auto_tasks_candidacy_source_missing()
  TO service_role;

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
  -- 四支臂：規則是「告示日 +0 起、投票日 +0 止」、掛 candidacy 之後、有後備與 cap
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(ARRAY['candidate_status_stale', 'not_running', 'withdrawn_filing', 'candidacy_source_missing']) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                      WHERE r.activity = a.arm AND r.priority IS NULL AND r.enabled AND r.window_kind = 'event'
                        AND r.from_kind = 'announced' AND r.from_offset = 0 AND r.until_kind = 'polling' AND r.until_offset = 0
                        AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些臂的規則不是「告示日 +0 起、投票日 +0 止、after_step=candidacy、有 chain_fallback 與 cap」：%', bad; END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  -- 三處一起加：總表要真的產出四個臂名（總表分支漏掉＝臂永遠不派，而且沒有聲音）
  IF NOT (policy_jp.activity_arm_names() @> ARRAY['candidate_status_stale', 'not_running', 'withdrawn_filing', 'candidacy_source_missing']) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() 沒有四支新臂';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_candidate_status_stale()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_not_running()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_withdrawn_filing()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_candidacy_source_missing()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 總表沒有四支新臂的分支';
  END IF;
  IF NOT (policy_jp.chain_step_rank('auto:candidate_status_stale:x', 'candidate_status_stale') = policy_jp.chain_step_rank('auto:roster_check:x', 'roster_check')
          AND policy_jp.chain_step_rank('auto:not_running_recheck:x', 'not_running_recheck') = 4
          AND policy_jp.chain_step_rank('auto:candidacy_source_missing:x', 'candidacy_source_missing') = 4) THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank 沒有登記三個新任務型別';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m
       WHERE m.arm IN ('candidate_status_stale', 'not_running', 'withdrawn_filing', 'candidacy_source_missing') AND m.stage = 3) <> 4 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map 沒有登記四支新臂（第 3 段）';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_candidate_status_stale()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_not_running()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_withdrawn_filing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_candidacy_source_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.chain_candidacy_records()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.candidacy_has_official_source(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：候補者の状態を確かめる臂（A 期）の関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
