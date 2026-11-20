-- 人物簡介：切掉「查證過程」句子，只留描述句（#975；維護者裁示，2026-11-20）
-- ============================================================
--
-- 起因：代理交件時把查證過程（「我用 pdftotext 核過…」「查詢結果回 0 筆，故留空」）寫進了 politicians.bio，人物頁直接顯示出來。
-- 以後不再進（交件守門另案處理）；這支 migration 處理既有的約 242 筆：
--   * 以 。；！？與換行切句（全形／半形括號內的標點不切，括號段落算所在那一句的一部分）；
--   * 括號段落裡有查證標記的，只拿掉那一段括號、句子留著（「…完成候選人登記（…第 81 頁，我用 pdftotext 核過）。」→「…完成候選人登記。」）；
--   * 拿掉括號後的句子仍符合 bio_is_process_sentence() 就整句刪：①標記字（我用／pdftotext／bbox／API／核對／查無／留空／任務／交件…，以及提到 AI／代理／本系統／本站／自動整理／語言模型／Claude／GPT／Jev 的句子；API、JSON、PDF、AI 要整字，「代理人」「代理鄉長」等職稱不算，「系統」「自動」「模型」單獨出現不算）
--     ②「出處」「來源」只在同句還有「查」「核」「附」才算（避免誤砍「依中選會公告…」這類描述）；
--   * 刪完去頭尾空白、連續標點壓成一個；整段切到只剩空白或標點 → 寫 NULL（讓 profile_gap 臂之後派代理重寫）；
--   * 只改「至少有一句命中」的列，改前後相同的不寫；沒命中的簡介一個字都不動。
-- 每一筆寫 edit_history（table_name＝politicians、field＝bio、agent_name＝maintainer:bio-cleanup、contribution_id 空）。
-- 還原：select bio_cleanup_revert();——只還原「現值仍等於 new_value」的列（之後被別人改過的不動），並在 edit_history 標 reverted_at／reverted_by；第二次呼叫不動任何列。
-- 可重跑：命中的句子刪掉後下一次一筆都不會選到。只動 politicians.bio 與 edit_history。
--
-- 引用到的既有物件（2026-11-20 唯讀查正式庫確認存在）：politicians（id、bio）、edit_history（table_name、record_id、field、old_value、new_value、contribution_id、agent_name、applied_at、reverted_at、reverted_by）。
-- 預覽：scripts/bio-cleanup-preview.sql（唯讀，同一套切句邏輯，改前先看會改哪些）。守門：_shared/bio-cleanup.test.ts（PGlite 跑本檔；含預覽與本檔邏輯一致的比對）。

-- 一句話是不是查證過程
CREATE OR REPLACE FUNCTION bio_is_process_sentence(s TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    s ~ '我用|pdftotext|bbox|PyMuPDF|curl|(?<![A-Za-z])API(?![A-Za-z])|(?<![A-Za-z])JSON(?![A-Za-z])|(?<![A-Za-z])PDF(?![A-Za-z])|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|第 ?[0-9]+ ?頁|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|任務|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)'
    OR (s ~ '出處|來源' AND s ~ '[查核附]'),
    false)
$$;

-- 括號段落（全形／半形）裡有查證標記的，只拿掉那一段括號、句子其餘部分留著：
-- 「…完成候選人登記（中選會《彙總表》第 81 頁，我用 pdftotext 核過）。」→「…完成候選人登記。」
CREATE OR REPLACE FUNCTION bio_strip_process_parens(s TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(s, '（(?=[^）\n]*(?:我用|pdftotext|bbox|PyMuPDF|curl|(?<![A-Za-z])API(?![A-Za-z])|(?<![A-Za-z])JSON(?![A-Za-z])|(?<![A-Za-z])PDF(?![A-Za-z])|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|第 ?[0-9]+ ?頁|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|任務|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)))[^）\n]*）|\((?=[^)\n]*(?:我用|pdftotext|bbox|PyMuPDF|curl|(?<![A-Za-z])API(?![A-Za-z])|(?<![A-Za-z])JSON(?![A-Za-z])|(?<![A-Za-z])PDF(?![A-Za-z])|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|第 ?[0-9]+ ?頁|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|任務|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)))[^)\n]*\)|（(?=[^）\n]*(?:出處|來源))(?=[^）\n]*[查核附])[^）\n]*）|\((?=[^)\n]*(?:出處|來源))(?=[^)\n]*[查核附])[^)\n]*\)', '', 'g')
$$;

-- 切掉查證句；沒有任何句子或括號命中就原樣回傳；切到沒內容回 NULL
CREATE OR REPLACE FUNCTION bio_strip_process_sentences(p_bio TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_hit BOOLEAN;
  v_kept TEXT;
BEGIN
  IF p_bio IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(bool_or(u.proc OR u.s2 <> u.s), false),
         string_agg(CASE WHEN u.proc THEN NULL ELSE u.s2 END, '' ORDER BY u.ord)
    INTO v_hit, v_kept
    FROM (
      SELECT t.ord, t.m[1] AS s, bio_strip_process_parens(t.m[1]) AS s2, bio_is_process_sentence(bio_strip_process_parens(t.m[1])) AS proc
        FROM regexp_matches(p_bio,
          '((?:(?:[^（(。；！？\n]|（[^）\n]*）?|\([^)\n]*\)?)+[。；！？]*\n*|[。；！？\n]+))', 'g') WITH ORDINALITY AS t(m, ord)
    ) u;
  IF NOT v_hit THEN RETURN p_bio; END IF;
  v_kept := regexp_replace(COALESCE(v_kept, ''), '([。；！？])[。；！？]+', '\1', 'g');
  v_kept := btrim(v_kept, E' \t\r\n　');
  v_kept := regexp_replace(v_kept, '；$', '。');
  IF v_kept ~ '^[。；！？，、]*$' THEN RETURN NULL; END IF;
  RETURN v_kept;
END
$$;

-- 還原：只還原「現值仍等於 new_value」的列，並在 edit_history 標已還原；回傳還原筆數
CREATE OR REPLACE FUNCTION bio_cleanup_revert() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_n INTEGER;
BEGIN
  WITH todo AS (
    SELECT h.id AS hid, p.id AS pid, h.old_value #>> '{}' AS old_bio
      FROM edit_history h
      JOIN politicians p ON p.id::TEXT = h.record_id
     WHERE h.table_name = 'politicians' AND h.field = 'bio' AND h.agent_name = 'maintainer:bio-cleanup'
       AND h.reverted_at IS NULL
       AND p.bio IS NOT DISTINCT FROM (h.new_value #>> '{}')
  ), upd AS (
    UPDATE politicians p SET bio = t.old_bio FROM todo t WHERE p.id = t.pid RETURNING t.hid
  )
  UPDATE edit_history h SET reverted_at = now(), reverted_by = 'bio_cleanup_revert'
    FROM upd WHERE h.id = upd.hid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

REVOKE EXECUTE ON FUNCTION bio_cleanup_revert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bio_cleanup_revert() TO service_role;

-- 套用：每筆一列 edit_history
WITH cand AS (
  SELECT p.id, p.bio AS old_bio, bio_strip_process_sentences(p.bio) AS new_bio
    FROM politicians p
   WHERE p.bio IS NOT NULL
), fixes AS (
  SELECT id, old_bio, new_bio FROM cand WHERE new_bio IS DISTINCT FROM old_bio
), upd AS (
  UPDATE politicians p SET bio = f.new_bio FROM fixes f WHERE p.id = f.id
  RETURNING p.id, f.old_bio, f.new_bio
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
SELECT 'politicians', u.id::TEXT, 'bio', to_jsonb(u.old_bio),
       CASE WHEN u.new_bio IS NULL THEN 'null'::jsonb ELSE to_jsonb(u.new_bio) END,
       'maintainer:bio-cleanup'
  FROM upd u;
