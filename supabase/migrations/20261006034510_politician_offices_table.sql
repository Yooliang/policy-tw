-- 任期存成正式資料：politician_offices 表（#345 第一階段之二；只加不刪）
--
-- 現況：職稱（現任公職）是視圖 politician_offices 當場從「我們標的當選」與「中選會名單唯一對上且當選」算出來的
-- （20261004000005）。算出來的東西補不了缺口、也記不了中途卸任（辭職、罷免、轉任），換屆當天就整批消失、不留歷史。
-- 日本站（政策の系譜 SCHEMA）一開始就是表：一個任期一列，現任＝卸任日為空。
--
-- 這支做的事（第一階段只加，讀取端不切）：
--   ① 舊視圖改名 politician_offices_derived 保留（內容一字不改）。人物視圖 politicians_with_elections 的 offices 子查詢
--      是照物件編號連過去的，改名後照舊讀它——**網站上的職稱這一步完全不變**。
--   ② 新表 politician_offices：人、職位（九種選舉別）、地區（regions）、就任日、任期屆滿日、實際卸任日與原因、
--      由哪一場選舉／哪一筆參選紀錄產生、認定依據與出處（中選會那一列的場次＋候選人代號）。
--      **現任＝已就任（start_date ≤ 今天）而且 end_date 為空。** 比日本站多看就任日：台灣 11 月底投票、12 月 25 日才就任，
--      這段期間新當選者還不是現任（10-04 裁決）。
--   ③ 回填：照舊視圖的邏輯整批搬進來（10-06 唯讀：8,560 列／8,544 位，見下方）。跨屆都當選的 16 位（全是 2022 議員轉 2024 立委）
--      舊視圖給兩列、顯示層取最近一屆；這裡照 10-04 裁決「後面那個就任時前一個已經辭掉」把議員那一筆記成
--      2024-01-31 卸任（took_other_office）——現任集合跟網站上看到的職稱一致。
--   ④ 之後怎麼長：參選紀錄的 election_result 變成 elected（代理交件、同儕驗證上線的結果）就由觸發器建一列；
--      改回不是當選就刪掉那一列（那個任期從來不存在）；職位、地區、人物指認變了跟著改。每一筆都記 edit_history（office-sync）。
--      **中選會名單那條來源不會自動長新列**：那是系統比對、不是走流程核過的資料，第一階段只在回填時搬一次；
--      之後中選會有、表裡沒有的，看視圖 politician_offices_gap，走任務補（派工臂設計見 #345 第一階段 PR 說明）。
--   ⑤ 每天一次（cron，台灣時間 08:05）把該卸任的關掉：任期屆滿 → term_expired；同一人後來就任別的公職 → 前一個在新任期就任前一天卸任
--      （took_other_office）。只寫已經發生的事：還沒到的卸任日不先寫（不然「卸任日為空＝現任」就不成立了）。
--
-- 為什麼這階段不讓讀取端改讀新表：舊視圖會自動跟著中選會名單長（2026 投票後 cec-sync 一跑，12-25 起新當選者自動有職稱），
-- 新表不會（見 ④）。現在切過去，2026 新當選者的職稱要等任務補完才出得來；先並行跑、用 politician_offices_gap 盯兩邊差多少，
-- 差異只剩預期的那幾種、流程補得上之後（第二階段）再切，切完才刪舊視圖。職稱的規則（lib/politician-office.ts）這階段一行都不動。
--
-- 回填預估（10-06 唯讀，實際以上線當下為準）：
--   2022 村里長 7,377（中選會 7,376／我們標的 1）、縣市議員 852（815／37）、鄉鎮市長 190（7／183）、
--   直轄市山地原住民區民代表 45（中選會）、縣市長 21（20／1）；2024 立法委員 73、總統副總統 2（都是我們標的）。
--   其中 16 列（2022 縣市議員）回填當下就記成 2024-01-31 卸任，現任 8,544 列＝8,544 位，跟舊視圖算出來的職稱逐人一致（PGlite 實跑）。

-- ① 舊視圖改名保留。
--    為什麼可以一次改名、不必分兩次上：沒有任何 Edge Function、前端、協議用名字讀這個視圖（10-06 全庫搜尋，只有註解提到）；
--    唯一的讀取端是人物視圖 politicians_with_elections 的子查詢，那是照物件編號連的，改名後照舊讀到同一個視圖。
--    ⚠️ 之後若照抄 20261005004300 的人物視圖定義重建（寫著 FROM politician_offices o），會變成讀新表——
--    第二階段要切才這樣寫；politician-offices-table.test.ts 盯著。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'politician_offices' AND c.relkind = 'v') THEN
    ALTER VIEW politician_offices RENAME TO politician_offices_derived;
  END IF;
END $$;
COMMENT ON VIEW politician_offices_derived IS
  '（#345 過渡）舊的現任公職視圖，原名 politician_offices：當場從我們標的當選＋中選會名單唯一對上算。人物視圖的職稱第一階段仍讀它；正式資料在表 politician_offices，兩邊差異看 politician_offices_gap。第二階段讀取端切到表之後刪';

-- 參選紀錄的 id 本來就不重複（序號），補一條唯一索引讓新表能用外鍵指過來
CREATE UNIQUE INDEX IF NOT EXISTS politician_elections_id_key ON politician_elections (id);

-- ② 新表
CREATE TABLE IF NOT EXISTS politician_offices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  politician_id UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  election_type TEXT NOT NULL CHECK (election_type IN (
    '總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
    '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')),
  region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  start_date DATE NOT NULL,
  scheduled_end_date DATE NOT NULL,
  end_date DATE,
  end_reason TEXT CHECK (end_reason IN ('term_expired', 'took_other_office', 'resigned', 'recalled', 'deceased', 'removed', 'other')),
  election_id INTEGER NOT NULL REFERENCES elections(id),
  politician_election_id INTEGER REFERENCES politician_elections(id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('election_result', 'cec_candidates')),
  cec_theme_id TEXT,
  cec_cand_id INTEGER,
  source_url TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT politician_offices_term_order CHECK (scheduled_end_date >= start_date),
  CONSTRAINT politician_offices_end_order CHECK (end_date IS NULL OR end_date >= start_date - 1),
  CONSTRAINT politician_offices_end_reason CHECK ((end_date IS NULL) = (end_reason IS NULL))
);

COMMENT ON TABLE politician_offices IS '任期（#345）：一個人一個民選公職的一個任期一列。現任＝start_date ≤ 今天而且 end_date 為空。第一階段由回填＋參選紀錄當選的觸發器＋每日卸任排程維護，網站職稱仍讀 politician_offices_derived';
COMMENT ON COLUMN politician_offices.election_type IS '職位（九種選舉別之一，跟參選紀錄同一套字）';
COMMENT ON COLUMN politician_offices.region_id IS '任職的地區：縣市、鄉鎮市區、村里或選舉區（regions 那一列，照產生它的參選紀錄）';
COMMENT ON COLUMN politician_offices.start_date IS '就任日（地方公職 12/25、立委 2/1、總統副總統 5/20；office_term_start）';
COMMENT ON COLUMN politician_offices.scheduled_end_date IS '任期屆滿日（下一屆就任日前一天；office_term_end）';
COMMENT ON COLUMN politician_offices.end_date IS '實際卸任日；在任中為空。只寫已經發生的（屆滿由每日排程寫，提前卸任要有出處）';
COMMENT ON COLUMN politician_offices.end_reason IS 'term_expired 任期屆滿／took_other_office 就任別的民選公職（我國不得同時擔任兩個民選公職）／resigned 辭職／recalled 罷免／deceased 死亡／removed 解職／other';
COMMENT ON COLUMN politician_offices.basis IS '認定依據：election_result＝參選紀錄標了當選（代理交件、同儕驗證）；cec_candidates＝中選會名單唯一對上且當選（只在 #345 回填時用過，之後不自動長）';
COMMENT ON COLUMN politician_offices.cec_theme_id IS '出處：中選會選舉資料庫的場次代號（basis=cec_candidates 時是對上的那一列）';
COMMENT ON COLUMN politician_offices.cec_cand_id IS '出處：中選會選舉資料庫的候選人代號（同場次內唯一）';

CREATE UNIQUE INDEX IF NOT EXISTS politician_offices_politician_election_key ON politician_offices (politician_election_id) WHERE politician_election_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS politician_offices_politician_idx ON politician_offices (politician_id);
CREATE INDEX IF NOT EXISTS politician_offices_open_idx ON politician_offices (politician_id) WHERE end_date IS NULL;

ALTER TABLE politician_offices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON politician_offices;
CREATE POLICY "Public read" ON politician_offices FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON politician_offices;
CREATE POLICY "Service role write" ON politician_offices FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT ON politician_offices TO anon, authenticated;

-- ⑤ 該卸任的關掉（每日排程呼叫；回填與觸發器也呼叫，只動那一位）。只寫 p_today 以前已經發生的卸任。
CREATE OR REPLACE FUNCTION politician_offices_close_ended(p_today DATE DEFAULT CURRENT_DATE, p_politician_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n INTEGER;
BEGIN
  WITH nxt AS (
    SELECT o.id,
           (SELECT min(o2.start_date) FROM politician_offices o2
             WHERE o2.politician_id = o.politician_id AND o2.id <> o.id
               AND o2.start_date > o.start_date AND o2.start_date <= p_today) AS next_start
      FROM politician_offices o
     WHERE o.end_date IS NULL
       AND (p_politician_id IS NULL OR o.politician_id = p_politician_id)
  ), closing AS (
    SELECT o.id, o.scheduled_end_date, n.next_start,
           (n.next_start IS NOT NULL AND n.next_start - 1 < o.scheduled_end_date) AS switched
      FROM politician_offices o JOIN nxt n ON n.id = o.id
     WHERE o.scheduled_end_date < p_today
        OR (n.next_start IS NOT NULL AND n.next_start - 1 < o.scheduled_end_date)
  ), upd AS (
    UPDATE politician_offices o
       SET end_date = CASE WHEN c.switched THEN c.next_start - 1 ELSE c.scheduled_end_date END,
           end_reason = CASE WHEN c.switched THEN 'took_other_office' ELSE 'term_expired' END,
           updated_at = now()
      FROM closing c
     WHERE o.id = c.id
    RETURNING o.id, o.end_date, o.end_reason
  ), hist AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    SELECT 'politician_offices', u.id::TEXT, 'end_date', NULL, to_jsonb(u.end_date::TEXT || ' ' || u.end_reason), 'office-sync'
      FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM hist;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION politician_offices_close_ended IS '把該卸任的任期關掉（#345）：任期屆滿 term_expired；同一人後來已就任別的公職 took_other_office（新任期就任前一天）。只寫已經發生的';

-- ③ 回填：照舊視圖的邏輯搬進來（中選會那條附上對到的那一列當出處）
INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date,
                                election_id, politician_election_id, basis, cec_theme_id, cec_cand_id, note)
SELECT d.politician_id, d.election_type, pe.region_id, d.term_start, d.term_end,
       d.election_id, d.politician_election_id, d.verified_by, c.cec_theme_id, c.cec_cand_id,
       '#345 回填（舊視圖 politician_offices 的邏輯）'
  FROM politician_offices_derived d
  JOIN politician_elections pe ON pe.id = d.politician_election_id
  JOIN politicians p ON p.id = d.politician_id
  LEFT JOIN LATERAL (
    SELECT c.cec_theme_id, c.cec_cand_id
      FROM cec_candidates c
     WHERE d.verified_by = 'cec_candidates'
       AND c.election_id = d.election_id AND c.election_type = d.election_type
       AND c.name_norm = cec_name_norm(p.name) AND c.region = d.region
     LIMIT 1
  ) c ON true
 WHERE NOT EXISTS (SELECT 1 FROM politician_offices o WHERE o.politician_election_id = d.politician_election_id);

-- 跨屆都當選的：前一個在後一個就任前一天卸任（10-04 裁決）。回填只記到今天為止已經發生的。
SELECT politician_offices_close_ended(CURRENT_DATE);

-- 回填核對：現任集合要跟舊視圖「每人取最近一屆」逐列一致，不一致整支退回
DO $$
DECLARE
  v_missing INTEGER;
  v_extra INTEGER;
  r RECORD;
BEGIN
  SELECT count(*) INTO v_missing FROM politician_offices_derived d
   WHERE NOT EXISTS (SELECT 1 FROM politician_offices_derived d2 WHERE d2.politician_id = d.politician_id AND d2.term_start > d.term_start)
     AND NOT EXISTS (SELECT 1 FROM politician_offices o WHERE o.politician_election_id = d.politician_election_id
                       AND o.end_date IS NULL AND o.start_date <= CURRENT_DATE);
  SELECT count(*) INTO v_extra FROM politician_offices o
   WHERE o.end_date IS NULL AND o.start_date <= CURRENT_DATE
     AND NOT EXISTS (SELECT 1 FROM politician_offices_derived d WHERE d.politician_election_id = o.politician_election_id
                       AND NOT EXISTS (SELECT 1 FROM politician_offices_derived d2 WHERE d2.politician_id = d.politician_id AND d2.term_start > d.term_start));
  IF v_missing > 0 OR v_extra > 0 THEN
    RAISE EXCEPTION '#345 任期回填跟舊視圖對不上：少 % 列、多 % 列', v_missing, v_extra;
  END IF;
  FOR r IN SELECT election_id, election_type, basis, count(*) AS n, count(*) FILTER (WHERE end_date IS NOT NULL) AS ended
             FROM politician_offices GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  LOOP
    RAISE NOTICE '#345 任期回填：% % % % 列（已卸任 %）', r.election_id, r.election_type, r.basis, r.n, r.ended;
  END LOOP;
END $$;

-- ④ 參選紀錄 → 任期（只認我們標的當選；中選會那條不自動長，見檔頭）
CREATE OR REPLACE FUNCTION sync_politician_office_from_election()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o politician_offices%ROWTYPE;
  v_year INTEGER;
  v_start DATE;
  v_end DATE;
  v_new politician_offices%ROWTYPE;
BEGIN
  SELECT * INTO o FROM politician_offices WHERE politician_election_id = NEW.id;

  IF NEW.election_result = 'elected' THEN
    SELECT EXTRACT(YEAR FROM e.election_date)::INTEGER INTO v_year FROM elections e WHERE e.id = NEW.election_id;
    IF v_year IS NULL OR NEW.election_type IS NULL
       OR NEW.election_type NOT IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                                    '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長') THEN
      RETURN NEW;  -- 選舉別不明的當選紀錄算不出任期，不建；politician_offices_gap 也看不到它（舊視圖同樣算不出）
    END IF;
    v_start := office_term_start(v_year, NEW.election_type);
    v_end := office_term_end(v_year, NEW.election_type);
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
    IF NEW.election_result IS NOT NULL OR o.basis = 'election_result' THEN
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
COMMENT ON FUNCTION sync_politician_office_from_election IS '#345：參選紀錄標了當選就建任期、當選被拿掉就刪；職位、地區、人物指認跟著改；每筆記 edit_history（office-sync）';

DROP TRIGGER IF EXISTS trg_sync_politician_office ON politician_elections;
CREATE TRIGGER trg_sync_politician_office
  AFTER INSERT OR UPDATE OF election_result, election_type, region_id, politician_id, election_id ON politician_elections
  FOR EACH ROW EXECUTE FUNCTION sync_politician_office_from_election();

-- 兩邊差多少：舊視圖（每人取最近一屆，跟網站顯示的職稱同一個集合）vs 表的現任
--   missing＝舊視圖算得出、表裡沒有（多半是中選會名單後來才對上的，要走任務補 election_result）
--   extra＝表裡是現任、舊視圖算不出（例如中選會那條回填的、參選紀錄後來換了選舉別）
CREATE OR REPLACE VIEW politician_offices_gap AS
SELECT 'missing'::TEXT AS gap, d.politician_id, d.politician_election_id, d.election_id, d.election_type,
       d.region, d.sub_region, d.village, d.verified_by AS basis
  FROM politician_offices_derived d
 WHERE NOT EXISTS (SELECT 1 FROM politician_offices_derived d2 WHERE d2.politician_id = d.politician_id AND d2.term_start > d.term_start)
   AND NOT EXISTS (SELECT 1 FROM politician_offices o WHERE o.politician_election_id = d.politician_election_id
                     AND o.end_date IS NULL AND o.start_date <= CURRENT_DATE)
UNION ALL
SELECT 'extra', o.politician_id, o.politician_election_id, o.election_id, o.election_type,
       r.region, r.sub_region, r.village, o.basis
  FROM politician_offices o
  LEFT JOIN regions r ON r.id = o.region_id
 WHERE o.end_date IS NULL AND o.start_date <= CURRENT_DATE
   AND NOT EXISTS (SELECT 1 FROM politician_offices_derived d WHERE d.politician_election_id = o.politician_election_id
                     AND NOT EXISTS (SELECT 1 FROM politician_offices_derived d2 WHERE d2.politician_id = d.politician_id AND d2.term_start > d.term_start));
COMMENT ON VIEW politician_offices_gap IS '（#345 過渡）舊視圖算出來的現任 vs 任期表的現任，差在哪裡；第二階段讀取端切到表之前要只剩預期的差異';
ALTER VIEW politician_offices_gap SET (security_invoker = on);
GRANT SELECT ON politician_offices_gap TO anon, authenticated;

-- ⑤ 每日排程：台灣時間 08:05（UTC 00:05，CURRENT_DATE 換日之後；舊視圖也是看 CURRENT_DATE）
SELECT cron.unschedule('politician-offices-close-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'politician-offices-close-daily');
SELECT cron.schedule('politician-offices-close-daily', '5 0 * * *', $$SELECT politician_offices_close_ended();$$);
