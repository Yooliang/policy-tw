-- 出處分類：新聞網域被標成「其他」（工作單 Yooliang/policy-ops#59，2026-10-10）
-- 三要素抽樣（OPS #58）發現 sources.source_kind＝other 的很多其實是新聞網域：媒體清單只有 16 個，
-- independent-sources.ts 另外列了 14 個新聞網站（EXTRA_NEWS_SITES），兩份真相。這支把媒體清單擴成單一份
-- （＝_shared/source-priority.ts 的 SOURCE_PRIORITY，thresholds.test.ts 逐字比對），
-- 自動分級另把 web.archive.org 的存檔看原網址（TS autoSourceKind 同步），再把既有 other 列重算。
-- 只取有編輯部的新聞機構；內容農場、政黨網站、維基、認不出的地方站維持 other。
-- 門檻矩陣各等級同值（20261006141500），不影響計分；影響在 #544 的獨立來源分組與本人來源資格（PR 說明）。

-- web.archive.org/web/<時間戳>/<原網址> → 原網址（sole-source-guard.ts unwrapArchiveUrl 的鏡像）
CREATE OR REPLACE FUNCTION source_unwrap_archive(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN m IS NULL THEN btrim(p_url)
    WHEN m[1] ~* '^https?://' THEN m[1]
    ELSE 'http://' || m[1]
  END
  FROM (SELECT regexp_match(btrim(p_url), '^https?://web\.archive\.org/web/[0-9]{1,14}[a-z_]{0,4}/(.+)$', 'i') AS m) x;
$$;
COMMENT ON FUNCTION source_unwrap_archive IS 'web.archive.org 存檔網址 → 原網址；不是存檔原樣回傳（OPS #59）';

CREATE OR REPLACE FUNCTION contribution_source_kind(p_urls TEXT[]) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  WITH ranked AS (
    SELECT CASE
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['cec.gov.tw', 'ly.gov.tw', 'gov.tw', 'gov.taipei', 'judicial.gov.tw']) THEN 3
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['cna.com.tw', 'pts.org.tw', 'twreporter.org', 'rti.org.tw', 'udn.com', 'ltn.com.tw', 'chinatimes.com', 'storm.mg', 'cw.com.tw', 'upmedia.mg', 'newtalk.tw', 'ftvnews.com.tw', 'tvbs.com.tw', 'ettoday.net', 'setn.com', 'yahoo.com', 'yahoo.com.tw', 'focustaiwan.tw', 'mirrormedia.mg', 'nownews.com', 'cts.com.tw', 'ttv.com.tw', 'ebc.net.tw', 'ctinews.com', 'thenewslens.com', 'businesstoday.com.tw', 'gvm.com.tw', 'cnyes.com', 'ctee.com.tw', 'ctwant.com', 'bnext.com.tw', 'cnews.com.tw', 'nextapple.com', 'epochtimes.com', 'taiwannews.com.tw', 'knews.com.tw']) THEN 2
      WHEN contribution_host_in(contribution_host_of(u), ARRAY['facebook.com', 'instagram.com', 'threads.net', 'youtube.com', 'x.com']) THEN 1
      ELSE 0
    END AS rank
    FROM unnest(coalesce(p_urls, ARRAY[]::TEXT[])) AS u
  )
  SELECT CASE coalesce(max(rank), 0) WHEN 3 THEN 'official' WHEN 2 THEN 'media' WHEN 1 THEN 'social' ELSE 'other' END FROM ranked;
$$;

-- 自動判斷的出處等級：社群沒有認定根據 → media；永遠不給 self；存檔看原網址
CREATE OR REPLACE FUNCTION source_auto_kind(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE contribution_source_kind(ARRAY[source_unwrap_archive(p_url)])
    WHEN 'official' THEN 'official'
    WHEN 'media' THEN 'media'
    WHEN 'social' THEN 'media'
    ELSE 'other'
  END;
$$;
COMMENT ON FUNCTION source_auto_kind IS '依網域自動判斷出處等級；社群貼文沒有認定根據一律算 media，自動判斷不會給 self；web.archive.org 存檔看原網址（#347；OPS #59）';

-- 本人來源（self）的列：分級改了也不能讓既有列違反 sources_self_eligible（正式庫 2026-10-10 是 0 列）
DO $$
DECLARE v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad FROM sources WHERE source_kind = 'self' AND NOT source_self_eligible(url);
  IF v_bad > 0 THEN RAISE EXCEPTION '有 % 列本人來源在新分級下不合格，先處理再上', v_bad; END IF;
END $$;

-- 既有 other 列重算：只往上調（other → media／official），不動 self、official、media，不動網址
UPDATE sources SET source_kind = source_auto_kind(url)
 WHERE source_kind = 'other' AND source_auto_kind(url) <> 'other';
