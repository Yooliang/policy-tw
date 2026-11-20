SET default_transaction_read_only = on;
-- 人物簡介切掉查證句子：唯讀預覽（#975）。邏輯與 supabase/migrations/20261120190000_bio_cleanup_process_sentences.sql 相同（那邊是函式、這裡 inline，
-- 因為唯讀交易不能建函式）；_shared/bio-cleanup.test.ts 會比對兩者結果一致。
-- 跑法：npx -y supabase@2 db query --linked -f scripts/bio-cleanup-preview.sql
WITH tok AS (
  SELECT p.id, m.ord, m.s[1] AS s, regexp_replace(m.s[1], '（(?=[^）\n]*(?:我用|pdftotext|bbox|PyMuPDF|curl|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|本任務|任務單|任務卡|任務型別|任務 ?[Ii][Dd]|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)|(?<![A-Za-z])(?:API|JSON|PDF)(?![A-Za-z])|第 ?[0-9]+ ?頁))[^）\n]*）|\((?=[^)\n]*(?:我用|pdftotext|bbox|PyMuPDF|curl|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|本任務|任務單|任務卡|任務型別|任務 ?[Ii][Dd]|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)|(?<![A-Za-z])(?:API|JSON|PDF)(?![A-Za-z])|第 ?[0-9]+ ?頁))[^)\n]*\)|（(?=[^）\n]*(?:出處|來源))(?=[^）\n]*(?:查證|查核|核對|核過|附))[^）\n]*）|\((?=[^)\n]*(?:出處|來源))(?=[^)\n]*(?:查證|查核|核對|核過|附))[^)\n]*\)', '', 'g') AS s0
    FROM politicians p,
         regexp_matches(p.bio, '((?:(?:[^（(。；！？\n]|（[^）\n]*）?|\([^)\n]*\)?)+[。；！？]*\n*|[。；！？\n]+))', 'g') WITH ORDINALITY AS m(s, ord)
   WHERE p.bio IS NOT NULL
     AND p.bio ~ '我用|pdftotext|bbox|PyMuPDF|curl|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|本任務|任務單|任務卡|任務型別|任務 ?[Ii][Dd]|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)|(?<![A-Za-z])(?:API|JSON|PDF)(?![A-Za-z])|第 ?[0-9]+ ?頁|出處|來源'
), sent AS (
  SELECT id, ord, s, s0,
         (s0 ~ '我用|pdftotext|bbox|PyMuPDF|curl|核過|核對|查詢結果|回 ?0 ?筆|回 ?[0-9]+ ?筆|搜尋了|搜了|查無|未載|留空|不填|尚未發布|尚未上架|故.{0,6}(?:不填|留空)|本任務|任務單|任務卡|任務型別|任務 ?[Ii][Dd]|交件|驗證者|politician_id|(?<![A-Za-z])[Aa]gent|本系統|本站|系統自動|自動產生|自動抓取|自動整理|語言模型|大模型|LLM|Claude|GPT|Gemini|Jev|(?<![A-Za-z])AI ?(?:代理|整理|產生|生成|撰寫|彙整|抓取|查證|查核|判定|摘要|協助)|(?:由|經|交由|透過|使用|利用|藉由) ?(?<![A-Za-z])AI(?![A-Za-z])|人工智慧(?:整理|產生|生成|撰寫|彙整)|(?:外部|貢獻|協議|自動)代理|代理(?:整理|查證|查核|抓取|彙整|產生|撰寫|搜尋|判定|填寫|回報|驗證|編輯|蒐集|檢索|提交|處理|交件)' OR (s0 ~ '出處|來源' AND s0 ~ '查證|查核|核對|核過|附') OR (s0 ~ '(?<![A-Za-z])(?:API|JSON|PDF)(?![A-Za-z])' AND s0 ~ '查無|回 ?[0-9]+ ?筆|留空|空白|不填')) AS proc,
         regexp_replace(regexp_replace(s0, '[^，、；。！？\n]*第 ?[0-9]+ ?頁[^，、；。！？\n]*[，、]?', '', 'g'), '(?:查詢 ?)?(?<![A-Za-z])(?:API|JSON|PDF)(?![A-Za-z]) ?', '', 'g') AS s2
    FROM tok
), agg AS (
  SELECT id, bool_or(proc OR s2 <> s) AS hit, string_agg(CASE WHEN proc THEN NULL ELSE s2 END, '' ORDER BY ord) AS kept
    FROM sent GROUP BY id
), k AS (
  SELECT a.id, a.hit, btrim(regexp_replace(regexp_replace(COALESCE(a.kept, ''), '([。；！？])[。；！？]+', '\1', 'g'), '[，、]+([。；！？])', '\1', 'g'), E' 	
　') AS t FROM agg a
), c AS (
  SELECT k.id, p.bio AS old_bio,
         CASE WHEN k.t ~ '^[。；！？，、]*$' THEN NULL ELSE regexp_replace(k.t, '；$', '。') END AS new_bio
    FROM k JOIN politicians p ON p.id = k.id
   WHERE k.hit
)
-- ▼▼ 輸出 ▼▼
SELECT kind, n, id, old_bio, new_bio FROM (
  SELECT 'summary' AS kind, count(*) FILTER (WHERE new_bio IS DISTINCT FROM old_bio) AS n, NULL::uuid AS id, 'changed' AS old_bio, NULL AS new_bio, 0 AS o FROM c
  UNION ALL
  SELECT 'summary', count(*) FILTER (WHERE new_bio IS NULL), NULL, 'becomes NULL', NULL, 1 FROM c
  UNION ALL
  (SELECT 'sample', NULL, id, old_bio, new_bio, 2 FROM c WHERE new_bio IS NOT NULL AND new_bio IS DISTINCT FROM old_bio ORDER BY md5(id::text) LIMIT 20)
  UNION ALL
  (SELECT 'null', NULL, id, old_bio, NULL, 3 FROM c WHERE new_bio IS NULL ORDER BY md5(id::text) LIMIT 15)
) x ORDER BY o;
