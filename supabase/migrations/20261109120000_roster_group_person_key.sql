-- 名冊分組任務：每筆交件帶 person_key，「掛錯人確認」逐人落地（2026-11-09，小良核准；協議 1.122.0）
--   起因：d9042ce1…、a2035078… 兩張「核對掛錯人」分組任務各派了 9 次不收斂。代理對某位交 no_change confirmed（掛對人），
--   apply-contribution 的多人任務分支只回「已記錄」、沒寫 task_checks；掛錯人臂只在 task_checks 有
--   task_id＝'auto:candidacy_owner_mismatch:<pe_id>' 且 outcome＝'confirmed' 時才排除那一位，
--   所以 roster_group_tasks_sweep() 永遠不會把他移出清單。程式（TS）已改成落庫時寫那一筆；這支 migration 只動說明文字：
--   1. roster_group_description：名單每位前面列 person_key（代理要照抄進 payload.person_key，伺服器不從自由文字猜）；
--   2. roster_group_howto：所有做法都先講 person_key；掛錯人另講「確認掛對人的 no_change 要帶 politician_election_id、通過後從清單移除」；
--   3. 現存 open 的分組任務：header 補同一句、description 重組（含 key）。
--   不改偵測規則、不動任何參選或人物資料。守門：_shared/group-person.test.ts、roster-group-tasks.test.ts。

CREATE OR REPLACE FUNCTION roster_group_description(p_header TEXT, p_people JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_header || E'\n' || COALESCE((SELECT string_agg(x.ord::TEXT || '. person_key：' || (x.p->>'key') || '｜' || (x.p->>'line'), E'\n' ORDER BY x.ord)
                                         FROM jsonb_array_elements(p_people) WITH ORDINALITY AS x(p, ord)), '')
$$;

DO $do$
DECLARE
  v_def TEXT;
  v_lead CONSTANT TEXT := $s$'每一筆交件都要帶 payload.person_key＝名單裡那一位前面列的 person_key（原樣照抄；沒帶或不在名單上會被伺服器擋下）。' || $s$;
  v_old_wo CONSTANT TEXT := '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼）。';
  v_new_wo CONSTANT TEXT := '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼，並帶那一位的 politician_election_id）；通過驗證後那一位會從清單移除，其他人照常。';
BEGIN
  v_def := pg_get_functiondef('roster_group_howto(text)'::regprocedure);
  IF position('payload.person_key' IN v_def) = 0 THEN
    IF position('SELECT CASE p_action' IN v_def) = 0 THEN RAISE EXCEPTION 'roster_group_howto：找不到 SELECT CASE p_action'; END IF;
    v_def := replace(v_def, 'SELECT CASE p_action', 'SELECT ' || v_lead || ' CASE p_action');
    IF position(v_old_wo IN v_def) = 0 THEN RAISE EXCEPTION 'roster_group_howto：找不到 wrong_owner 的句子'; END IF;
    v_def := replace(v_def, v_old_wo, v_new_wo);
    EXECUTE v_def;
  END IF;
END
$do$;

-- 現存 open 的分組任務：header 補 person_key 的說明、掛錯人補確認後移除的說明；description 用新格式（含 key）重組
UPDATE contribution_tasks t
   SET target = t.target || jsonb_build_object('header',
         replace(replace(t.target->>'header',
           '每位各交一筆貢獻（task_id 都填本任務 id，不要把好幾位塞進同一筆）；',
           '每位各交一筆貢獻（task_id 都填本任務 id，payload.person_key 填名單裡那一位前面列的 person_key，不要把好幾位塞進同一筆）；'),
           '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼）。',
           '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼，並帶那一位的 politician_election_id）；通過驗證後那一位會從清單移除，其他人照常。')),
       description = roster_group_description(
         replace(replace(t.target->>'header',
           '每位各交一筆貢獻（task_id 都填本任務 id，不要把好幾位塞進同一筆）；',
           '每位各交一筆貢獻（task_id 都填本任務 id，payload.person_key 填名單裡那一位前面列的 person_key，不要把好幾位塞進同一筆）；'),
           '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼）。',
           '是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼，並帶那一位的 politician_election_id）；通過驗證後那一位會從清單移除，其他人照常。'),
         t.target->'people')
 WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group' AND t.target->>'header' IS NOT NULL
   AND position('payload.person_key' IN t.target->>'header') = 0;
