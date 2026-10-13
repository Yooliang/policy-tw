-- 日本站：存檔網址照原網址分級（工作單 Yooliang/policy-ops#95、正見 1.89.0 / 20261010080000 source_unwrap_archive 的日本版）
--
-- 正見做了什麼：source_unwrap_archive() 把 web.archive.org/web/<時間>/<原網址> 還原成原網址，自動分級看原網址
--   （存檔的選舉公報、新聞原本一律被標成 other）。日本版同一件事，另外多兩種存檔：
--     archive.today 系（archive.ph／.is／.li／.md／.vn／.fo／.today）：<host>/<時間|newest|oldest|o/<碼>>/<原網址>
--     国立国会図書館 WARP：warp.ndl.go.jp／warp.da.ndl.go.jp/info:ndljp/pid/<n>/<原ホスト/パス>（原網址沒有 scheme）
--   WARP 的主機本身是 *.go.jp：不處理的話「任何網站的 WARP 存檔」都會被當成 official（比正見的漏洞更糟）。
--   所以：WARP 解得出原網址 → 看原網址；解不出（首頁、新型 waid 網址…）→ other，不因為是 ndl.go.jp 就算官方。
-- 正見的 `news` 出處等級不移植：日本站 sources.source_kind 本來就有 media，自動分級不給 media（沒有新聞網域清單，
--   不是日本站任何守門依賴的東西；#95 步驟 5 只要求存檔照原網址）。
-- 協議可見：存檔的官方頁（Wayback／archive.today／WARP）現在滿足「official 等級の出典」要求（discontinued、stop、
--   official_record、local_government／regional_stat、candidacy_source_missing）→ JP_PROTOCOL_VERSION 0.21.0 → 0.22.0。
-- source_kind_for_url 的最新版是 20261009210000_policy_jp_apply.sql；這支只在最前面加一層「還原存檔」，其餘分支一字不動。

CREATE OR REPLACE FUNCTION policy_jp.source_unwrap_archive(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
    WHEN w IS NOT NULL THEN CASE WHEN w[1] ~* '^https?://' THEN w[1] ELSE 'http://' || w[1] END
    WHEN a IS NOT NULL THEN CASE WHEN a[1] ~* '^https?://' THEN a[1] ELSE 'http://' || a[1] END
    WHEN n IS NOT NULL THEN CASE WHEN n[1] ~* '^https?://' THEN n[1] ELSE 'http://' || n[1] END
    ELSE btrim(p_url)
  END
  FROM (SELECT
    regexp_match(btrim(p_url), '^https?://web\.archive\.org/web/[0-9]{1,14}[a-z_]{0,4}/(.+)$', 'i') AS w,
    regexp_match(btrim(p_url), '^https?://(?:www\.)?archive\.(?:today|ph|is|li|md|vn|fo)/(?:[0-9]{1,14}|newest|oldest|timegate|o/[A-Za-z0-9]{1,16})/(.+)$', 'i') AS a,
    regexp_match(btrim(p_url), '^https?://warp(?:\.da)?\.ndl\.go\.jp/info:ndljp/pid/[0-9]+/(.+)$', 'i') AS n) x;
$$;
COMMENT ON FUNCTION policy_jp.source_unwrap_archive IS
  '存檔網址 → 原網址（Wayback、archive.today 系、国立国会図書館 WARP info:ndljp/pid 形）；不是存檔原樣回傳。TS 版 _shared/jp/source-kind.ts unwrapJpArchiveUrl（對齊測試 policy-jp-source-archive.test.ts）';

CREATE OR REPLACE FUNCTION policy_jp.source_kind_for_url(p_url TEXT, p_contribution_type TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN x.h IS NULL THEN 'other'
           WHEN x.h ~ '^warp(\.da)?\.ndl\.go\.jp$' THEN 'other'   -- 還原不了的 WARP 網址：保存庫本身不是原發布者，不算官方
           WHEN x.h ~ '(^|\.)(e-stat|stat)\.go\.jp$' THEN 'statistics'
           WHEN x.h ~ '(^|\.)soumu\.go\.jp$' AND p_contribution_type = 'regional_stat' THEN 'statistics'
           WHEN x.h ~ '\.(go|lg)\.jp$' THEN 'official'
           WHEN x.h ~ '(^|\.)(city|town|vill|village|pref|ward)\.[a-z0-9.-]+\.jp$' THEN 'official'
           ELSE 'other'
         END
    FROM (SELECT substring(lower(policy_jp.source_unwrap_archive(policy_jp.source_unwrap_archive(p_url))) FROM '^https?://([^/:?#@]+)') AS h) x
$$;

REVOKE EXECUTE ON FUNCTION policy_jp.source_unwrap_archive(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.source_unwrap_archive(TEXT) TO service_role;

-- 既有列重算：只動存檔形的網址，只動自動分級會給的三級（official／statistics／other）；self、assembly、media 不動。
-- WARP 形的舊列原本被主機 .go.jp 誤標成 official，這裡一併改正（可能往下調）。
UPDATE policy_jp.sources
   SET source_kind = policy_jp.source_kind_for_url(url)
 WHERE source_kind IN ('official', 'statistics', 'other')
   AND (url ~* '^https?://web\.archive\.org/web/' OR url ~* '^https?://(www\.)?archive\.(today|ph|is|li|md|vn|fo)/' OR url ~* '^https?://warp(\.da)?\.ndl\.go\.jp/')
   AND policy_jp.source_kind_for_url(url) <> source_kind;
