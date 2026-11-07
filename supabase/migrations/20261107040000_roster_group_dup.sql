-- 名冊分組任務補「重複」這一種（2026-11-07，40珊宜）
--   20261107030000 的分組只收缺人／缺號次／多／掛錯人／政黨／縣市／鄉鎮，沒有 cec_roster_diff() 的 dup。
--   上線一小時後 dup 從 1 變 5：「有登記、沒號次」的舊紀錄（多）和代理照「缺人」新建、帶號次的紀錄是同一個人，同選區同號次兩筆、掛在兩位人物上。
--   做法：原 roster_group_people() 改名為 roster_group_people_base()（本體不動），新的 roster_group_people() ＝ base ＋ dup；
--   label／task_type／howto 補 'dup'；最後再跑一次 roster_group_tasks_create（以人為準冪等，只會替新冒出的人開單）。
--   只開任務，不寫任何參選或人物資料；合併仍走 merge_politician 交件＋驗證。

ALTER FUNCTION roster_group_people() RENAME TO roster_group_people_base;

CREATE OR REPLACE FUNCTION roster_group_people()
RETURNS TABLE (person_key TEXT, action TEXT, election_type TEXT, county TEXT, town TEXT, name TEXT, pe_id INTEGER, politician_id UUID,
               loc TEXT, line TEXT, source_url TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT * FROM roster_group_people_base()
  UNION ALL
  SELECT d.diff_key, 'dup'::TEXT, d.election_type, d.county, d.town, d.our_name, d.pe_id, d.politician_id,
         replace(d.unit, '|', ''),
         '「' || COALESCE(d.our_name, '') || '」' || replace(d.unit, '|', '') || '｜號次 ' || COALESCE(d.cand_no::TEXT, '（無）')
           || '｜重複的兩位人物：' || replace(substr(d.diff_key, 5), '|', '、')
           || '｜其中一筆 politician_election_id ' || COALESCE(d.pe_id::TEXT, '?'),
         NULL::TEXT
    FROM cec_roster_diff() d
   WHERE d.kind = 'dup'
$fn$;
COMMENT ON FUNCTION roster_group_people IS '2026 名冊差異逐人清單＝roster_group_people_base()（缺人、缺號次、多、掛錯人、政黨、縣市、鄉鎮）＋cec_roster_diff() 的 dup（同一選區同一號次掛在兩位人物上）。只讀。2026-11-07';
REVOKE ALL ON FUNCTION roster_group_people() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION roster_group_label(p_action TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action WHEN 'missing' THEN '補參選紀錄（中選會名單有、本站沒有）' WHEN 'extra' THEN '查參選狀態（中選會名單查無此人）'
                       WHEN 'wrong_owner' THEN '核對掛錯人' WHEN 'party' THEN '補政黨' WHEN 'county' THEN '補縣市' WHEN 'town' THEN '補鄉鎮'
                       WHEN 'cand_no' THEN '補號次' WHEN 'dup' THEN '合併重複人物（同選區同號次兩筆）' END
$$;

CREATE OR REPLACE FUNCTION roster_group_task_type(p_action TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action WHEN 'extra' THEN 'candidate_status_stale' WHEN 'wrong_owner' THEN 'candidacy_owner_mismatch'
                       WHEN 'dup' THEN 'duplicate_politician' ELSE 'candidacy_source_missing' END
$$;

DO $do$
DECLARE v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('roster_group_howto(text)'::regprocedure);
  IF position('WHEN ''dup''' IN v_def) = 0 THEN
    v_def := replace(v_def, E'\n  END\n',
      E'\n    WHEN ''dup'' THEN\n      ''怎麼交：每組各交一筆 merge_politician。兩位人物同名、同選區、同號次，多半是同一人被建了兩次：比對出生年、政黨、其他屆紀錄，確定是同一人就把沒有其他屆紀錄、資料較少的那位併進另一位；''\n      || ''確定是不同人（例如兩位真的同名同選區）就用 merge_politician 判定不同人並寫明依據。source_urls 放中選會名單網址。''\n  END\n');
    IF position('WHEN ''dup''' IN v_def) = 0 THEN RAISE EXCEPTION 'roster_group_howto：找不到要插入 dup 的位置'; END IF;
    EXECUTE v_def;
  END IF;
END
$do$;

SELECT roster_group_tasks_create('roster-group-2026-11-07');
SELECT roster_group_tasks_reboost();
