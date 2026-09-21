-- 同名人物那一對的兩條永久排除（2026-09-21，子代理掃「不可逆蓋章」時找到）。
--
-- 合併是全站唯一沒有回頭路的動作，所以「這一對還要不要給人看」特別重要。
-- 但讓它不再被看見的兩條路，都不需要任何內容檢查：
--
--   1. 代理交一筆 merge_politician same_person=false → politician_pair_resolutions 寫一列
--      → duplicate_politician 從此不派這一對。schema 只驗 uuid／boolean／reason ≥20 字，
--      沒有一處看 reason 或來源支不支持「不同人」這個結論。（票數是 high 級 4／6／8，
--      那是票的保護，不是內容檢查。）這條這次用 TS 補上查核履歷，判錯至少還原得回來。
--
--   2. Jev 一次高信心的 diff 判定 → 這一對從此不派。這支 migration 修的是這條，兩個問題：
--      a. 沒有時間窗。而 precheck 自己重用舊判定時有 30 天窗（system-one/index.ts），
--         代表我們早就承認「判定會過期」——只有這裡當它永久有效。
--      b. 看的是「有沒有任何一筆 diff」而不是最新一筆：後來 Jev 改判 same，舊的 diff 仍壓著。
--
--      而且 consensus.ts 自己寫著：Jev 看的是我們資料庫裡的欄位，不構成獨立證據，
--      所以不讓它在 merge_politician 上投系統票——卻讓它在「派不派任務」上一票否決。
--
-- 90 天窗要大於 precheck 的 30 天快取窗，兩者才自洽：第 91 天任務重新出現 → 代理提貢獻 →
-- precheck 發現舊判定已過 30 天 → 重問一次 → 新判定再壓 90 天。
-- 反過來（任務窗 < 快取窗）會讓代理白跑：任務派出來了，precheck 卻回頭拿同一筆舊判定。

CREATE OR REPLACE FUNCTION jev_pair_exclusion_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 90 $$;
COMMENT ON FUNCTION jev_pair_exclusion_days IS
  'Jev 判「不同人」之後，這一對多久不派 duplicate_politician 任務；必須大於 system-one precheck 的 30 天快取窗，否則任務派出來時 precheck 只會回同一筆舊判定，代理白跑';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_dup()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH n AS (
    SELECT p.id, p.name, p.party, p.region, p.birth_year, p.current_position,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
    FROM politicians p WHERE p.merged_into IS NULL
  )
  SELECT 'auto:duplicate_politician:' || a.id || '|' || b.id, 'duplicate_politician',
         jsonb_build_object(
           'pair_key', a.id || '|' || b.id,
           'a', jsonb_build_object('id', a.id, 'name', a.name, 'party', a.party, 'region', a.region, 'birth_year', a.birth_year, 'current_position', a.current_position),
           'b', jsonb_build_object('id', b.id, 'name', b.name, 'party', b.party, 'region', b.region, 'birth_year', b.birth_year, 'current_position', b.current_position)),
         '「' || a.name || '」有兩筆人物資料（' || COALESCE(a.region, '') || ' ' || COALESCE(a.party, '') || '／' || COALESCE(b.region, '') || ' ' || COALESCE(b.party, '') || '），很可能是同一個人。'
           || '請查中選會候選人資料庫（歷屆參選、出生年、政黨）或官方名單，確認是不是同一人。'
           || '用 merge_politician 回報：same_person=true 帶 keep_id（保留資料較完整、參選紀錄較多的那筆）與 remove_id；確認是不同人就 same_person=false。'
           || '兩種都要 reason（≥20 字）與 source_urls。item.current.a／b 是兩筆的全欄＋參選紀錄＋政見標題，current.system_vote 是系統的判定。'
           || '**system_vote 只看我們自己資料庫裡的欄位，不是獨立證據**——它說不同人，你還是要自己查一次官方來源。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，同一人會列在同一筆', 'POST /functions/v1/fetch-cec-data {"queryName":"姓名"}', '該縣市議會／政府官網的人物簡介'],
         2, COALESCE(a.region, b.region)
  FROM n a JOIN n b ON a.nkey = b.nkey AND a.id < b.id
  WHERE (COALESCE(a.region, '') = COALESCE(b.region, '') OR (a.birth_year IS NOT NULL AND a.birth_year = b.birth_year))
    AND NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = a.id || '|' || b.id)
    -- Jev 判「不同人」：只認**最新一筆**判定（原本是「有沒有任何一筆 diff」，後來改判 same 也壓不掉舊的），
    -- 而且只壓 jev_pair_exclusion_days() 天（原本永久）。
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT j.choice, j.probability, j.asked_at
        FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.subject_id = a.id || '|' || b.id
        ORDER BY j.asked_at DESC
        LIMIT 1
      ) latest
      WHERE latest.choice = 'diff'
        AND latest.probability >= system_one_min_probability()
        AND latest.asked_at > now() - (jev_pair_exclusion_days() || ' days')::INTERVAL
    )
    AND NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_type = 'merge_politician' AND c.status IN ('pending', 'verified', 'disputed')
        AND c.payload->>'keep_id' ~* '^[0-9a-f-]{36}$' AND c.payload->>'remove_id' ~* '^[0-9a-f-]{36}$'
        AND politician_pair_key((c.payload->>'keep_id')::UUID, (c.payload->>'remove_id')::UUID) = a.id || '|' || b.id)
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_dup IS
  '同名人物配對 → duplicate_politician 任務；已有人類結論的不派，Jev 最新一筆高信心「不同人」的壓 90 天（不是永久）';
