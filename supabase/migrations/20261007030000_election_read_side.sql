-- #344 第二階段 A：讀取端改看投票日（election_date）、選舉識別鍵；只加不刪
-- （不刪任何欄位或表、不改任何函式簽名；退役 end_date 與 election_types 表是第二階段 B，另一個 PR）
--
-- 做了什麼：
--   ① 任期起訖看選舉本身：新函式 election_term_start／election_term_end（吃 elections.id，不再把 id 當年份）。
--      定期改選與重行選舉＝投票年份的法定任期（地方 12/25、立委 2/1、總統 5/20，四年一屆）；補選＝就任日暫以投票日、
--      卸任日是那一屆原定的最後一天（補足剩餘任期，不是四年）；罷免投票不選人、不算任期。
--      任期同步觸發器（sync_politician_office_from_election）改用它們；舊的 office_term_start／office_term_end 不動（簽名不變、
--      還有派工臂照年份在用，它們吃的年份本來就是 EXTRACT(YEAR FROM election_date)）
--   ② 「最新一屆」看投票日：politician_latest_election（→ 人物表的職位、選舉別、地區指標同步觸發器）、
--      politician_bulletins_for、politicians_with_elections.offices 的排序，原本是 ORDER BY election_id
--   ③ 插隊篩選吃得下新的選舉 id：task_boost_matches 原本用 year_or_null（只收四位數字），新增的選舉 id 不是年份、會被當成沒有
--      → 新函式 election_id_or_null（任何正整數）
--   ④ 嘉義市 2022 縣市長重行選舉拆出來：2022-11-26 那天嘉義市長沒有投（候選人過世、延期），12-18 才重行選舉，
--      不該跟九合一算同一場。新增一場 2022-12-18_rerun_10020（id 照序號拿＝4，不是年份），把嘉義市縣市長的參選紀錄、選舉區、
--      （若 cec-sync 已抓到）中選會名單移過去；每筆移動記 edit_history（agent election-split-344，可倒回）。
--      政見、任期、公報、名冊核對都先唯讀查過：沒有任何一列掛在這幾筆上（移的是 3 筆參選紀錄與 1 筆選舉區，見下方核對）
--   ⑤ 核對（對不上整支退回）：改函式前後，每一位人物的「最新一屆」、每一位現任公職的 offices 陣列、每個職位的任期起訖逐一比對；
--      拆嘉義市之後，最新一屆有變的人只能是移走的那幾位
--
-- 順序：CI 先 db push、再部署函式（CLAUDE.md「部署順序」）。這支只加新函式、換函式內容與重排序，不刪、不改簽名。

-- ── 核對用的「改之前」快照 ───────────────────────────────────────
CREATE TEMP TABLE e344_old_latest AS
SELECT p.id AS politician_id, l.election_id, l.candidate_status, l."position", l.slogan, l.election_type, l.region_id
  FROM politicians p
  CROSS JOIN LATERAL politician_latest_election(p.id) l;

CREATE TEMP TABLE e344_old_offices AS
SELECT v.id AS politician_id, v.offices::TEXT AS offices
  FROM politicians_with_elections v
 WHERE EXISTS (SELECT 1 FROM politician_offices o WHERE o.politician_id = v.id);

-- ── ① 任期起訖看選舉本身 ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION election_term_start(p_election_id INTEGER, p_election_type TEXT)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE e.election_reason
           WHEN 'by_election' THEN e.election_date
           WHEN 'recall' THEN NULL
           ELSE office_term_start(EXTRACT(YEAR FROM e.election_date)::INTEGER, p_election_type)
         END
    FROM elections e WHERE e.id = p_election_id
$$;
COMMENT ON FUNCTION election_term_start IS '這場選舉選出來的人的就任日。定期改選、重行選舉：投票年份的法定就任日（地方 12/25、立委 2/1、總統副總統 5/20，同 office_term_start）；補選：暫以投票日（實際就任日各機關不同，之後要精確再另案）；罷免投票不選人，回 NULL。吃的是 elections.id，不是年份（#344 第二階段 A）';

CREATE OR REPLACE FUNCTION election_term_end(p_election_id INTEGER, p_election_type TEXT)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT CASE e.election_reason
           WHEN 'by_election' THEN (
             -- 補選：補足剩餘任期，卸任日是投票日所在那一屆原定的最後一天（總統與立委 2024 起每四年、地方 2022 起每四年）
             SELECT office_term_end(y, p_election_type)
               FROM generate_series(EXTRACT(YEAR FROM e.election_date)::INTEGER - 4, EXTRACT(YEAR FROM e.election_date)::INTEGER) y
              WHERE (y - CASE WHEN p_election_type IN ('總統副總統', '立法委員') THEN 2024 ELSE 2022 END) % 4 = 0
                AND office_term_start(y, p_election_type) <= e.election_date
              ORDER BY y DESC LIMIT 1)
           WHEN 'recall' THEN NULL
           ELSE office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, p_election_type)
         END
    FROM elections e WHERE e.id = p_election_id
$$;
COMMENT ON FUNCTION election_term_end IS '這場選舉選出來的人的任期最後一天。定期改選、重行選舉：下一屆就任日前一天（同 office_term_end）；補選：投票日所在那一屆原定的最後一天（補足剩餘任期）；罷免投票回 NULL（#344 第二階段 A）';
GRANT EXECUTE ON FUNCTION election_term_start(INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION election_term_end(INTEGER, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION sync_politician_office_from_election()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  o politician_offices%ROWTYPE;
  v_start DATE;
  v_end DATE;
  v_new politician_offices%ROWTYPE;
BEGIN
  SELECT * INTO o FROM politician_offices WHERE politician_election_id = NEW.id;

  IF NEW.candidacy_status = 'elected' THEN
    -- 任期看這場選舉本身（election_term_start／end：定期改選＝法定任期、補選＝補足剩餘任期），不再把 election_id 當年份
    v_start := election_term_start(NEW.election_id, NEW.election_type);
    v_end := election_term_end(NEW.election_id, NEW.election_type);
    IF v_start IS NULL OR v_end IS NULL OR NEW.election_type IS NULL
       OR NEW.election_type NOT IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                                    '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長') THEN
      RETURN NEW;  -- 選舉別不明、或這場選舉不選人（罷免投票）：算不出任期，不建；politician_offices_gap 也看不到它（舊視圖同樣算不出）
    END IF;
    IF o.id IS NULL THEN
      INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date,
                                      election_id, politician_election_id, basis, note)
      VALUES (NEW.politician_id, NEW.election_type, NEW.region_id, v_start, v_end,
              NEW.election_id, NEW.id, 'election_result', '參選紀錄標了當選')
      RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', v_new.id::TEXT, '*', NULL, to_jsonb(v_new), 'office-sync');
    ELSIF o.politician_id IS DISTINCT FROM NEW.politician_id OR o.election_type IS DISTINCT FROM NEW.election_type
       OR o.region_id IS DISTINCT FROM NEW.region_id OR o.election_id IS DISTINCT FROM NEW.election_id
       OR o.basis <> 'election_result' THEN
      UPDATE politician_offices
         SET politician_id = NEW.politician_id, election_type = NEW.election_type, region_id = NEW.region_id,
             election_id = NEW.election_id, basis = 'election_result',
             start_date = v_start, scheduled_end_date = v_end, updated_at = now()
       WHERE id = o.id
      RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), to_jsonb(v_new), 'office-sync');
    END IF;
    PERFORM politician_offices_close_ended(CURRENT_DATE, NEW.politician_id);
    IF TG_OP = 'UPDATE' AND OLD.politician_id IS DISTINCT FROM NEW.politician_id THEN
      PERFORM politician_offices_close_ended(CURRENT_DATE, OLD.politician_id);
    END IF;
  ELSIF o.id IS NOT NULL THEN
    IF NEW.candidacy_status = 'not_elected' OR o.basis = 'election_result' THEN
      -- 標成落選／退選，或原本靠「我們標的當選」、現在當選被拿掉：這個任期從來不存在，刪掉（整列記在 edit_history 可還原）
      DELETE FROM politician_offices WHERE id = o.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), NULL, 'office-sync');
    ELSIF o.politician_id IS DISTINCT FROM NEW.politician_id OR o.region_id IS DISTINCT FROM NEW.region_id THEN
      -- 中選會那條回填的：參選紀錄換人（合併人物）或換地區時跟著改；選舉別、屆別變了就對不上中選會那一列，交給 politician_offices_gap
      UPDATE politician_offices SET politician_id = NEW.politician_id, region_id = NEW.region_id, updated_at = now()
       WHERE id = o.id RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), to_jsonb(v_new), 'office-sync');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION sync_politician_office_from_election IS '#345：參選紀錄標了當選就建任期、當選被拿掉就刪；職位、地區、人物指認跟著改；每筆記 edit_history（office-sync）｜#345 第二階段 A：參選狀態讀 candidacy_status 一欄｜#344 第二階段 A：任期起訖看選舉本身（election_term_start／end），不把 election_id 當年份';

-- ── ② 「最新一屆」看投票日 ───────────────────────────────────────
CREATE OR REPLACE FUNCTION politician_latest_election(p_politician_id uuid)
RETURNS TABLE(election_id integer, candidate_status text, "position" text, slogan text, election_type text, region_id integer)
LANGUAGE sql STABLE AS $$
  SELECT pe.election_id, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)), pe."position", pe.slogan, pe.election_type, pe.region_id
    FROM politician_elections pe
    JOIN elections e ON e.id = pe.election_id
   WHERE pe.politician_id = p_politician_id
   ORDER BY (COALESCE(pe.candidacy_status, '') = 'withdrawn'), e.election_date DESC, pe.election_id DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION politician_bulletins_for(p_politician_id uuid)
RETURNS TABLE(election_id integer, election_type text, cand_no integer, elected boolean, region text, sub_region text, village text, urls text[])
LANGUAGE sql STABLE AS $$
  SELECT b.election_id, b.election_type, b.cand_no, b.elected, b.region, b.sub_region, b.village, b.urls
    FROM politician_bulletins b
    JOIN elections e ON e.id = b.election_id
   WHERE b.politician_id = p_politician_id
   ORDER BY e.election_date DESC, b.election_id DESC, b.election_type
   LIMIT 10
$$;

-- offices 陣列的排序：新到舊看投票日（欄位清單與順序不動）；elections[]、offices[] 每一項多帶 electionDate（投票日，放在最後一個鍵）：
-- 前端「最新一屆」「現任職稱取哪一屆」看投票日、不看 id（新增的選舉 id 不是年份、也不保證越大越新）。前端沒有這個鍵時退回 id，
-- 所以前端比這支先上線也沒事。offices 仍讀任期表 politician_offices
-- （#345 第二階段：職稱改讀任期表，沿用 20261006220000 的寫法；這支只換排序）
CREATE OR REPLACE VIEW politicians_with_elections AS
SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.election_type,
    p."position",
    p.current_position,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    p.avatar_url,
    p.slogan,
    p.bio,
    p.education,
    p.experience,
    p.birth_year,
    p.education_level,
    COALESCE(( SELECT json_agg(pe.election_id) AS json_agg
           FROM politician_elections pe
          WHERE (pe.politician_id = p.id)), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.sub_region
                    ELSE COALESCE(per.sub_region, r.sub_region, p.sub_region)
                END, 'village',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.village
                    ELSE COALESCE(per.village, r.village, p.village)
                END, 'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing, 'electionDate', pee.election_date)) AS json_agg
           FROM ((politician_elections pe
             LEFT JOIN regions per ON ((pe.region_id = per.id)))
             LEFT JOIN elections pee ON ((pee.id = pe.election_id)))
          WHERE (pe.politician_id = p.id)), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', COALESCE(orr.region, p.region), 'subRegion', COALESCE(orr.sub_region, p.sub_region), 'village', COALESCE(orr.village, p.village), 'termEnd', o.scheduled_end_date, 'electionDate', oe.election_date) ORDER BY oe.election_date DESC, o.election_id DESC) AS json_agg
           FROM ((politician_offices o
             LEFT JOIN regions orr ON ((orr.id = o.region_id)))
             LEFT JOIN elections oe ON ((oe.id = o.election_id)))
          WHERE ((o.politician_id = p.id) AND (o.end_date IS NULL) AND (o.start_date <= CURRENT_DATE))), '[]'::json) AS offices
   FROM (politicians p
     LEFT JOIN regions r ON ((p.region_id = r.id)));
ALTER VIEW politicians_with_elections SET (security_invoker = on);

-- ── ③ 插隊篩選吃得下新的選舉 id ──────────────────────────────────
CREATE OR REPLACE FUNCTION election_id_or_null(p_text TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~ '^\d{1,9}$' THEN p_text::INTEGER ELSE NULL END
$$;
COMMENT ON FUNCTION election_id_or_null IS '文字 → 選舉 id（正整數）；其他回 NULL。取代 year_or_null：新增的選舉 id 不是四位數年份（#344 第二階段 A）。year_or_null 留著（簽名不動），第二階段 B 一起刪';
GRANT EXECUTE ON FUNCTION election_id_or_null(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION task_boost_matches(p_filter jsonb)
RETURNS TABLE(task_id text, kind text)
LANGUAGE sql STABLE AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'regions' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'regions')) END AS regions,
      NULLIF(p_filter->>'election_id', '')::INT AS election_id,
      CASE WHEN p_filter ? 'election_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'election_types')) END AS election_types,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      COALESCE((p_filter->>'missing_avatar')::BOOLEAN, false) AS missing_avatar,
      CASE WHEN p_filter ? 'politician_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'politician_ids')::UUID) END AS politician_ids,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的主角、縣市、屆別、型別
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           election_id_or_null(g.target->>'election_id') AS election_id,
           g.target->>'election_type' AS election_type
      FROM contribution_auto_tasks_arms() g
    UNION ALL
    SELECT t.id::TEXT, 'task', t.task_type,
           uuid_or_null(t.target->>'politician_id'),
           COALESCE(t.region, t.target->>'region'),
           election_id_or_null(t.target->>'election_id'),
           t.target->>'election_type'
      FROM contribution_tasks t WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           election_id_or_null(c.payload->>'election_id'),
           c.payload->>'election_type'
      FROM contributions c WHERE c.status = 'pending'
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
    LEFT JOIN politicians p ON p.id = s.politician_id
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.politician_ids IS NULL OR s.politician_id = ANY(f.politician_ids))
     AND (NOT f.missing_avatar OR (p.id IS NOT NULL AND COALESCE(p.avatar_url, '') = ''))
     AND (f.regions IS NULL OR COALESCE(s.region, p.region) = ANY(f.regions))
     AND (f.election_id IS NULL OR s.election_id = f.election_id
          OR (s.election_id IS NULL AND p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = f.election_id)))
     AND (f.election_types IS NULL OR s.election_type = ANY(f.election_types) OR (p.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_type::TEXT = ANY(f.election_types)
               AND (f.election_id IS NULL OR pe.election_id = f.election_id))));
$$;

-- ── 核對一：改了函式與視圖排序，還沒動資料——每一位人物的「最新一屆」、每一位現任公職的 offices 陣列（拿掉新加的 electionDate 鍵之後）都要跟改之前一模一樣 ──
DO $$
DECLARE v_latest INTEGER; v_offices INTEGER; v_terms INTEGER; v_offices_rows INTEGER;
BEGIN
  SELECT count(*) INTO v_latest
    FROM e344_old_latest o
    CROSS JOIN LATERAL politician_latest_election(o.politician_id) n
   WHERE ROW(o.election_id, o.candidate_status, o."position", o.slogan, o.election_type, o.region_id)
         IS DISTINCT FROM ROW(n.election_id, n.candidate_status, n."position", n.slogan, n.election_type, n.region_id);
  IF v_latest > 0 THEN
    RAISE EXCEPTION '#344 politician_latest_election 改看投票日後，有 % 位人物的最新一屆跟改之前不同，不切', v_latest;
  END IF;
  -- 快照的範圍＝「有參選紀錄的人」：politician_latest_election 對沒有任何參選紀錄的人不回列，
  -- 所以不能拿整張人物表的人數去比（線上 16,286 位人物、16,266 位有參選紀錄，差的 20 位是沒參選過的）。
  -- 比的是同一個範圍：有參選紀錄的人物數；資料正常增減（新增人物、新增參選紀錄）都不影響，因為快照與這個數是同一個交易裡算的
  IF (SELECT count(*) FROM e344_old_latest)
     <> (SELECT count(*) FROM politicians p WHERE EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id)) THEN
    RAISE EXCEPTION '#344 最新一屆快照的人數跟「有參選紀錄的人物數」對不上';
  END IF;

  SELECT count(*) INTO v_offices
    FROM e344_old_offices o
    JOIN politicians_with_elections v ON v.id = o.politician_id
   WHERE regexp_replace(v.offices::TEXT, ',\s*"electionDate"\s*:\s*("[^"]*"|null)', '', 'g') IS DISTINCT FROM o.offices;
  IF v_offices > 0 THEN
    RAISE EXCEPTION '#344 politicians_with_elections.offices 改看投票日排序後，有 % 位的陣列跟改之前不同，不切', v_offices;
  END IF;

  -- 任期起訖：每個現存任期，用新函式從選舉算出來的起訖要跟存著的一樣（同一個職位、同一場選舉）
  SELECT count(*), count(*) FILTER (
           WHERE o.start_date IS DISTINCT FROM election_term_start(o.election_id, o.election_type)
              OR o.scheduled_end_date IS DISTINCT FROM election_term_end(o.election_id, o.election_type))
    INTO v_offices_rows, v_terms
    FROM politician_offices o WHERE o.election_id IS NOT NULL;
  IF v_terms > 0 THEN
    RAISE EXCEPTION '#344 election_term_start／end 算出的任期跟現存 % 筆任期裡的 % 筆不同，不切', v_offices_rows, v_terms;
  END IF;
  -- 每場定期選舉的每個職位：新函式跟舊的年份算法逐一相同
  SELECT count(*) INTO v_terms
    FROM elections e
    CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE e.election_reason IN ('regular', 'rerun')
     AND (election_term_start(e.id, t.election_type) IS DISTINCT FROM office_term_start(EXTRACT(YEAR FROM e.election_date)::INTEGER, t.election_type)
       OR election_term_end(e.id, t.election_type) IS DISTINCT FROM office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, t.election_type));
  IF v_terms > 0 THEN
    RAISE EXCEPTION '#344 election_term_start／end 跟舊的年份算法在 % 個（選舉、職位）上不同，不切', v_terms;
  END IF;
END $$;

-- ── ④ 嘉義市 2022 縣市長重行選舉：拆成自己的一場 ─────────────────────────
DO $$
DECLARE
  v_id INTEGER;
  v_moved INTEGER;
  v_districts INTEGER;
  v_cec INTEGER;
  v_policies INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM elections WHERE election_key = '2022-12-18_rerun_10020') THEN
    RAISE NOTICE '#344 嘉義市重行選舉已拆過，略過';
    RETURN;
  END IF;

  -- 重行選舉的事實：2022-11-26 嘉義市長沒有投票（候選人過世、延期），2022-12-18 重行選舉（內政部行政區代碼 10020＝嘉義市）
  INSERT INTO elections (name, short_name, start_date, end_date, election_date, election_key, election_reason, election_types)
  VALUES ('111年嘉義市市長重行選舉', '2022 嘉義市長重行選舉', DATE '2022-12-18', DATE '2022-12-18', DATE '2022-12-18',
          '2022-12-18_rerun_10020', 'rerun', ARRAY['縣市長'])
  RETURNING id INTO v_id;
  -- 舊表過渡期同步（觸發器會把陣列再算一次，結果一樣）
  INSERT INTO election_types (election_id, type) VALUES (v_id, '縣市長');

  -- 嘉義市縣市長的參選紀錄：只能是重行選舉那場（11-26 那天嘉義市長沒有投）
  WITH moved AS (
    UPDATE politician_elections pe SET election_id = v_id
      FROM regions r
     WHERE r.id = pe.region_id AND r.region = '嘉義市' AND pe.election_id = 2022 AND pe.election_type = '縣市長'
    RETURNING pe.id
  ), h AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    SELECT 'politician_elections', m.id::TEXT, 'election_id', to_jsonb(2022), to_jsonb(v_id), 'election-split-344' FROM moved m
    RETURNING 1
  )
  SELECT count(*) INTO v_moved FROM moved;

  WITH moved AS (
    UPDATE election_districts SET election_id = v_id
     WHERE election_id = 2022 AND election_type = '縣市長' AND region = '嘉義市'
    RETURNING id
  ), h AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    SELECT 'election_districts', m.id::TEXT, 'election_id', to_jsonb(2022), to_jsonb(v_id), 'election-split-344' FROM moved m
    RETURNING 1
  )
  SELECT count(*) INTO v_districts FROM moved;

  -- 中選會名單（cec-sync 抓到重行選舉的話，原本記在 2022 底下）
  WITH moved AS (
    UPDATE cec_candidates SET election_id = v_id
     WHERE election_id = 2022 AND election_type = '縣市長' AND region = '嘉義市'
    RETURNING id
  )
  SELECT count(*) INTO v_cec FROM moved;

  -- 掛在這些人身上的 2022 政見：不動（可能是議員等其他選舉的政見），只告知
  SELECT count(*) INTO v_policies
    FROM policies po
   WHERE po.election_id = 2022
     AND po.politician_id IN (SELECT pe.politician_id FROM politician_elections pe WHERE pe.election_id = v_id);

  RAISE NOTICE '#344 嘉義市重行選舉：新增 elections id=%，移走參選紀錄 % 筆、選舉區 % 筆、中選會名單 % 筆；這些人另有 % 筆 2022 政見未動', v_id, v_moved, v_districts, v_cec, v_policies;
END $$;

-- ── 核對二：拆完之後 ─────────────────────────────────────────────
DO $$
DECLARE v_new INTEGER; v_changed INTEGER; v_stray INTEGER; v_offices INTEGER; v_types TEXT[];
BEGIN
  SELECT id, election_types INTO v_new, v_types FROM elections WHERE election_key = '2022-12-18_rerun_10020';
  IF v_new IS NULL THEN RAISE EXCEPTION '#344 嘉義市重行選舉沒有建出來'; END IF;
  IF v_types IS DISTINCT FROM ARRAY['縣市長']::TEXT[] THEN RAISE EXCEPTION '#344 嘉義市重行選舉的職位清單不是 {縣市長}：%', v_types; END IF;
  -- 原本的三場定期選舉還在、重行選舉是新增的那一場（不拿「總共幾筆」比：別人同時新增選舉是正常的資料變動，不該擋住這支）
  IF (SELECT count(*) FROM elections WHERE id IN (2022, 2024, 2026) AND election_reason = 'regular') <> 3 THEN
    RAISE EXCEPTION '#344 原本的三場定期選舉（2022／2024／2026）不見了或事由被改';
  END IF;

  -- 2022 底下不該還有嘉義市縣市長（參選紀錄、選舉區）
  SELECT (SELECT count(*) FROM politician_elections pe JOIN regions r ON r.id = pe.region_id
           WHERE r.region = '嘉義市' AND pe.election_id = 2022 AND pe.election_type = '縣市長')
       + (SELECT count(*) FROM election_districts WHERE election_id = 2022 AND election_type = '縣市長' AND region = '嘉義市')
    INTO v_stray;
  IF v_stray > 0 THEN RAISE EXCEPTION '#344 2022 底下還有 % 筆嘉義市縣市長沒移走', v_stray; END IF;

  -- 最新一屆有變的人，只能是移進重行選舉的那幾位（而且新的最新一屆就是重行選舉）
  SELECT count(*) INTO v_changed
    FROM e344_old_latest o
    CROSS JOIN LATERAL politician_latest_election(o.politician_id) n
   WHERE ROW(o.election_id, o.candidate_status, o."position", o.slogan, o.election_type, o.region_id)
         IS DISTINCT FROM ROW(n.election_id, n.candidate_status, n."position", n.slogan, n.election_type, n.region_id)
     AND NOT (n.election_id = v_new AND o.election_id = 2022
              AND EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.politician_id = o.politician_id AND pe.election_id = v_new));
  IF v_changed > 0 THEN
    RAISE EXCEPTION '#344 拆嘉義市之後，有 % 位不在移動名單上的人最新一屆變了', v_changed;
  END IF;

  -- 現任公職一個都不能動（嘉義市 2022 縣市長沒有任期列）
  SELECT count(*) INTO v_offices
    FROM e344_old_offices o JOIN politicians_with_elections v ON v.id = o.politician_id
   WHERE regexp_replace(v.offices::TEXT, ',\s*"electionDate"\s*:\s*("[^"]*"|null)', '', 'g') IS DISTINCT FROM o.offices;
  IF v_offices > 0 THEN RAISE EXCEPTION '#344 拆嘉義市之後有 % 位的現任公職陣列變了', v_offices; END IF;

  -- 移過去的列不能有舊的任期掛在 2022 嘉義市縣市長上
  IF EXISTS (SELECT 1 FROM politician_offices o JOIN regions r ON r.id = o.region_id
              WHERE o.election_id = 2022 AND o.election_type = '縣市長' AND r.region = '嘉義市') THEN
    RAISE EXCEPTION '#344 有任期掛在 2022 嘉義市縣市長上，要先處理任期再拆';
  END IF;
END $$;

-- ── ⑥ 補選、重行選舉的中選會名單同步：每週六 19:45（UTC）接在 2022／2024 的排程後面 ──
-- cec-sync（#344 第二階段 A）改由 elections 表驅動：2022-11-26 那場不再含嘉義市長（那是 2022-12-18 的重行選舉，自己一場）；
-- 這支排程把「已投票的補選、重行選舉」逐場逐職位各打一次（每場的職位看 elections.election_types，只同步 election_key 指的那個縣市），
-- 之後新增的補選、重行選舉不用再加排程
SELECT cron.unschedule('cec-sync-offcycle-weekly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cec-sync-offcycle-weekly');
SELECT cron.schedule('cec-sync-offcycle-weekly', '45 19 * * 6', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-sync',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := jsonb_build_object('election_id', e.id, 'election_type', t), timeout_milliseconds := 150000)
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t
   WHERE e.election_reason IN ('by_election', 'rerun') AND e.election_date <= CURRENT_DATE;
$$);

NOTIFY pgrst, 'reload schema';

DROP TABLE IF EXISTS e344_old_latest;
DROP TABLE IF EXISTS e344_old_offices;
