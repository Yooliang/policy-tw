-- 參選狀態合一欄 candidacy_status（#345 第一階段之一；只加不刪）
--
-- 現況：參選狀態分兩欄——`candidate_status`（傳聞／可能參選／確認參選／已登記／審定合格／表態不參選，還有沒人用的
-- 當選、落選）與 `election_result`（當選／落選／退選）。兩欄重疊、會互相矛盾，人物頁的職稱就是這樣標錯的（10-04）。
-- 日本站（政策の系譜 SCHEMA v0.3 起）合併成一欄六值，正見照同一套：
--
--   considering 考慮參選　要有本人或政黨公開表態的報導（日本站「出馬を検討」）
--   declared    表明參選　本人宣布、政黨提名
--   filed       已登記　　向選委會登記（含審定合格、列在候選人名單上）
--   withdrawn   退選　　　表態不參選、登記後退選（日本站「取りやめ・辞退」）
--   elected     當選
--   not_elected 落選
--
-- **不收傳聞**：傳聞（rumored）沒有對應值，對到空值（NULL＝不顯示）。傳聞對當事人名譽風險最高、對讀者用處最小（兩站比較）。
-- 10-06 唯讀：線上 rumored 0 筆、likely 0 筆（登記截止後由 candidate_status_stale 任務清完），回填不會有傳聞被丟掉。
--
-- 第一階段：新欄位＋回填＋兩邊同步的觸發器；兩個舊欄位照舊保留、照舊被寫，讀取端照舊讀舊欄位。
-- 第二階段（讀取端與寫入端都改用新欄位、上線之後）才刪舊欄位——CLAUDE.md「刪欄位要分兩次上」。
-- 讀寫舊兩欄的地方盤點在 #345 第一階段 PR 的說明。
--
-- 舊值怎麼對到新值（`candidacy_status_from_legacy`，TS 鏡像在 _shared/candidacy-status.ts，測試盯兩邊一致）：
--   ① 先看 election_result：elected → elected、not_elected → not_elected、withdrawn → withdrawn（pending 當沒填）
--   ② 再看 candidate_status：elected → elected、defeated → not_elected、not_running → withdrawn、
--      registered／qualified → filed、likely → considering、rumored 與空值 → NULL（不收）
--   ③ confirmed 有兩個意思，看「這一屆這種選舉的正式候選人名單公告了沒」（`candidacy_list_published`）：
--      已投票、或已過名單公告日（roster_check_scope.list_announced_on）→ filed；之前 → declared。
--      依據：資料庫註解寫 confirmed＝「確認參選（宣布／黨提名）」，而協議的名單清查規定公告日之後才填 confirmed
--      （審定階段，見 skill.md「名單有兩個階段」）；已投票屆別的 confirmed 是早期照中選會名冊整批匯入的，都在選票上。
--      10-06 唯讀：2026 的 confirmed 只有 4 筆，都是登記截止前的宣布或早期匯入（陳琬惠那筆就是沒有登記的那位）→ declared。
--      這條依「寫入當下」判斷、存下來就不會因為日子過了自己變：公告前寫的 confirmed 永遠是 declared，
--      之後有登記證據要靠任務改成 registered／qualified（或第二階段直接寫 filed）。
--
-- 回填（10-06 唯讀預估，實際以上線當下為準，migration 會把分布印在 NOTICE）：
--   2022：filed 13,950（confirmed、結果空白）、elected 843、not_elected 745
--   2024：elected 75、not_elected 239、filed 4（其中 3 筆是「測試候選人」，另案）
--   2026：filed 1,081（registered）、withdrawn 108（not_running）、declared 4（confirmed）
--   共 17,049 筆，NULL 0 筆。
--
-- 同步（`sync_candidacy_status`，BEFORE INSERT／UPDATE）：
--   - 舊欄位有變（現在所有寫入端都只寫舊欄位）→ 新欄位照上面的規則重算
--   - 只有新欄位有變（第二階段的寫入端）→ 把舊欄位改成對得上的值（已經對得上就不動，例如 qualified 不會被改成 registered）
--   - 兩邊同時變 → 以舊欄位為準（第一階段的寫入端都寫舊欄位；第二階段的寫入端不再寫舊欄位）
--   - 有人把新欄位清成 NULL → 照舊欄位重算（不讓狀態被默默清掉）

ALTER TABLE politician_elections ADD COLUMN IF NOT EXISTS candidacy_status TEXT;
ALTER TABLE politician_elections DROP CONSTRAINT IF EXISTS politician_elections_candidacy_status_check;
ALTER TABLE politician_elections ADD CONSTRAINT politician_elections_candidacy_status_check
  CHECK (candidacy_status IS NULL OR candidacy_status IN ('considering', 'declared', 'filed', 'withdrawn', 'elected', 'not_elected'));

COMMENT ON COLUMN politician_elections.candidacy_status IS
  '參選狀態（選前到選後同一欄，#345）：considering 考慮參選（要有本人或政黨公開表態）／declared 表明參選／filed 已登記（含審定）／withdrawn 退選或表態不參選／elected 當選／not_elected 落選；不收傳聞（NULL＝不顯示）。過渡期由觸發器跟 candidate_status＋election_result 同步';
COMMENT ON COLUMN politician_elections.candidate_status IS
  '舊的參選狀態（rumored／likely／confirmed／registered／qualified／not_running／elected／defeated）。#345 過渡中：讀新欄 candidacy_status，這欄第二階段刪';
COMMENT ON COLUMN politician_elections.election_result IS
  '舊的選舉結果（elected／not_elected／withdrawn／pending）。#345 過渡中：讀新欄 candidacy_status，這欄第二階段刪';
COMMENT ON COLUMN politician_elections.votes_received IS
  '得票數：待刪（#345）。站上不顯示票數，2026-10-06 起各寫入端不再寫這欄，第二階段刪欄';
COMMENT ON COLUMN politician_elections.vote_percentage IS
  '得票率：待刪（#345）。站上不顯示票數，2026-10-06 起各寫入端不再寫這欄，第二階段刪欄';

CREATE INDEX IF NOT EXISTS idx_politician_elections_candidacy_status ON politician_elections (candidacy_status);

-- 這一屆這種選舉的正式候選人名單公告了沒（已投票也算）。
-- 名單公告日只有名單清查設定表有（roster_check_scope.list_announced_on，2026 是 11-17）；沒有設定的屆別只看投票日。
CREATE OR REPLACE FUNCTION candidacy_list_published(p_election_id INTEGER, p_election_type TEXT, p_on DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM elections e WHERE e.id = p_election_id AND e.election_date <= p_on)
      OR EXISTS (SELECT 1 FROM roster_check_scope s
                  WHERE s.election_id = p_election_id AND s.election_type = p_election_type
                    AND s.list_announced_on IS NOT NULL AND s.list_announced_on <= p_on)
$$;
COMMENT ON FUNCTION candidacy_list_published IS '這一屆這種選舉的正式候選人名單在 p_on 那天公告了沒（已投票也算）；決定舊值 confirmed 對到 filed 還是 declared（#345）';

-- 舊兩欄 → 新欄。純函式：同樣的輸入永遠同樣的輸出（名單公告了沒由呼叫端傳進來）。
CREATE OR REPLACE FUNCTION candidacy_status_from_legacy(p_candidate_status TEXT, p_election_result TEXT, p_list_published BOOLEAN)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_election_result = 'elected' THEN 'elected'
    WHEN p_election_result = 'not_elected' THEN 'not_elected'
    WHEN p_election_result = 'withdrawn' THEN 'withdrawn'
    WHEN p_candidate_status = 'elected' THEN 'elected'
    WHEN p_candidate_status = 'defeated' THEN 'not_elected'
    WHEN p_candidate_status = 'not_running' THEN 'withdrawn'
    WHEN p_candidate_status IN ('registered', 'qualified') THEN 'filed'
    WHEN p_candidate_status = 'confirmed' THEN CASE WHEN COALESCE(p_list_published, false) THEN 'filed' ELSE 'declared' END
    WHEN p_candidate_status = 'likely' THEN 'considering'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION candidacy_status_from_legacy IS '舊的 candidate_status＋election_result 對到新的 candidacy_status（#345）；rumored（傳聞）對到 NULL＝不收。TS 鏡像 _shared/candidacy-status.ts';

-- 新欄 → 舊兩欄（第二階段的寫入端只寫新欄位時用）。舊值本來就對得上就原樣留著。
CREATE OR REPLACE FUNCTION legacy_status_from_candidacy(
  p_candidacy_status TEXT, p_candidate_status TEXT, p_election_result TEXT, p_list_published BOOLEAN,
  OUT candidate_status TEXT, OUT election_result TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  candidate_status := p_candidate_status;
  election_result := p_election_result;
  IF p_candidacy_status IS NULL
     OR candidacy_status_from_legacy(p_candidate_status, p_election_result, p_list_published) IS NOT DISTINCT FROM p_candidacy_status THEN
    RETURN;
  END IF;
  CASE p_candidacy_status
    WHEN 'elected', 'not_elected' THEN
      election_result := p_candidacy_status;
      -- 參選過才會有結果：舊狀態不是參選中的值就記成 confirmed（已投票屆別早期匯入的寫法）
      IF p_candidate_status IS NULL OR p_candidate_status NOT IN ('confirmed', 'registered', 'qualified') THEN
        candidate_status := 'confirmed';
      END IF;
    WHEN 'withdrawn' THEN
      election_result := NULL;
      candidate_status := 'not_running';
    WHEN 'filed' THEN
      election_result := NULL;
      IF p_candidate_status IS NULL OR p_candidate_status NOT IN ('registered', 'qualified') THEN
        candidate_status := 'registered';
      END IF;
    WHEN 'declared' THEN
      election_result := NULL;
      candidate_status := 'confirmed';
    WHEN 'considering' THEN
      election_result := NULL;
      candidate_status := 'likely';
  END CASE;
END;
$$;
COMMENT ON FUNCTION legacy_status_from_candidacy IS '新的 candidacy_status 對回舊的 candidate_status＋election_result（#345 過渡期；舊值已對得上就不動）';

-- 回填：先回填、再掛同步觸發器（掛了再回填，觸發器會把「只改新欄位」當成第二階段的寫入、回頭改舊欄位）
DO $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::date;
  v_bad INTEGER;
  r RECORD;
BEGIN
  UPDATE politician_elections pe
     SET candidacy_status = candidacy_status_from_legacy(pe.candidate_status, pe.election_result,
                              candidacy_list_published(pe.election_id, pe.election_type, v_today))
   WHERE pe.candidacy_status IS DISTINCT FROM
         candidacy_status_from_legacy(pe.candidate_status, pe.election_result,
                                      candidacy_list_published(pe.election_id, pe.election_type, v_today));

  FOR r IN
    SELECT pe.election_id, COALESCE(pe.candidacy_status, '(NULL)') AS s, count(*) AS n
      FROM politician_elections pe GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE NOTICE '#345 candidacy_status 回填：% % %', r.election_id, r.s, r.n;
  END LOOP;

  -- 回填完要跟規則逐筆一致（自己核一次，不靠回填那句 UPDATE 的 WHERE）
  SELECT count(*) INTO v_bad FROM politician_elections pe
   WHERE pe.candidacy_status IS DISTINCT FROM
         candidacy_status_from_legacy(pe.candidate_status, pe.election_result,
                                      candidacy_list_published(pe.election_id, pe.election_type, v_today));
  IF v_bad > 0 THEN
    RAISE EXCEPTION '#345 candidacy_status 回填後還有 % 筆跟規則對不上', v_bad;
  END IF;
  -- 傳聞一律是 NULL（不收）
  SELECT count(*) INTO v_bad FROM politician_elections WHERE candidate_status = 'rumored' AND election_result IS NULL AND candidacy_status IS NOT NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '#345 傳聞參選有 % 筆被回填成有狀態', v_bad;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_candidacy_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_listed BOOLEAN;
  v_legacy_changed BOOLEAN;
  v_new_changed BOOLEAN;
  r RECORD;
BEGIN
  v_listed := candidacy_list_published(NEW.election_id, NEW.election_type, (now() AT TIME ZONE 'Asia/Taipei')::date);
  IF TG_OP = 'INSERT' THEN
    -- 新增時有給新欄位＝第二階段的寫入端（舊欄位那時只剩預設值 rumored）；沒給＝現在的寫入端
    v_new_changed := NEW.candidacy_status IS NOT NULL;
    v_legacy_changed := NOT v_new_changed;
  ELSE
    v_legacy_changed := NEW.candidate_status IS DISTINCT FROM OLD.candidate_status
                     OR NEW.election_result IS DISTINCT FROM OLD.election_result;
    v_new_changed := NEW.candidacy_status IS DISTINCT FROM OLD.candidacy_status;
  END IF;

  IF v_legacy_changed OR (v_new_changed AND NEW.candidacy_status IS NULL) THEN
    NEW.candidacy_status := candidacy_status_from_legacy(NEW.candidate_status, NEW.election_result, v_listed);
  ELSIF v_new_changed THEN
    SELECT * INTO r FROM legacy_status_from_candidacy(NEW.candidacy_status, NEW.candidate_status, NEW.election_result, v_listed);
    NEW.candidate_status := r.candidate_status;
    NEW.election_result := r.election_result;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION sync_candidacy_status IS '#345 過渡期：candidacy_status 跟 candidate_status＋election_result 兩邊同步（舊欄位有變以舊欄位為準）；第二階段刪舊欄位時一起拿掉';

DROP TRIGGER IF EXISTS trg_sync_candidacy_status ON politician_elections;
CREATE TRIGGER trg_sync_candidacy_status
  BEFORE INSERT OR UPDATE OF candidate_status, election_result, candidacy_status ON politician_elections
  FOR EACH ROW EXECUTE FUNCTION sync_candidacy_status();

GRANT EXECUTE ON FUNCTION candidacy_list_published(INTEGER, TEXT, DATE) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION candidacy_status_from_legacy(TEXT, TEXT, BOOLEAN) TO anon, authenticated;
