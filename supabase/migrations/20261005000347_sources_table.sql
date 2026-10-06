-- 出處獨立成表（issue #347 第一階段；維護者 2026-10-05：比較表 35 項全部選前做）
--
-- 做了什麼：
--   1. 新表 sources（一個網址一列）與 source_refs（哪一筆資料引用了哪個出處），公開讀。
--      參考日本站（政策の系譜）docs/SCHEMA.md 的 sources：網址、標題、發布者、發布日、等級、擷取時間、
--      存檔網址、文件類別。
--   2. 把既有的 policies.source_url、policy_sources、tracking_logs.source_url，以及「新增政見」貢獻
--      附的其他來源網址，回填成出處與引用。**舊欄位一律保留**：CLAUDE.md 規定刪欄位、改名要分兩次上，
--      讀取端切到新表、上線之後才是第二階段。
--   3. 在舊欄位被寫入時同步寫新表（觸發器），讓第二階段切換讀取時新表是完整的。觸發器出錯只記警告、
--      不擋原本的寫入——落庫是正式資料的唯一路徑，不能因為出處表的問題讓貢獻落庫失敗。
--   4. 選舉公報、選委會公告類的出處要有存檔網址：交件當下就把這類網址登記進 sources，由排程
--      source-archive 每 10 分鐘送 Wayback Machine 存檔並記下 archive_url（理由見 PR 說明與
--      docs/DECISIONS.md 2026-10-05）。
--
-- 出處等級（source_kind，依可信度排序）：
--   official：政府、選委會、議會、法院等官方網站與文件（選舉公報、公告、議事錄）——可當唯一出處
--   self    ：本人來源——本人官網、本人認證社群帳號、政黨刊載的本人政見。**必須附認定根據**
--             （self_evidence），沒有根據的一律視為 media（防冒名帳號）。這條由下面的
--             CHECK 約束擋在資料庫：self 沒有根據寫不進來，有根據卻不是 self 也寫不進來。
--   media   ：新聞報導，以及沒有認定根據的社群貼文——不可當唯一出處（規則另案，見 #347 第 3 項）
--   other   ：其他（個人整理站、首頁、搜尋結果…）——不可當唯一出處
-- 自動判斷沿用既有的網域清單 contribution_source_kind()（migration 20260912000009，與
-- _shared/source-priority.ts 由 thresholds.test 盯一致）：官方→official、媒體→media、
-- 社群→media（沒有認定根據）、其餘→other。**自動判斷永遠不會給 self**，self 只能由之後的流程
-- （代理附根據、同儕驗證）設定。

-- ------------------------------------------------------------
-- 判斷函式
-- ------------------------------------------------------------

-- 文件類別：選舉公報（election_bulletin）、選委會公告與名冊（election_notice），其他為 NULL。
-- 這兩類要有存檔網址：中選會的公報站只掛最近一屆，投票後就換下來。
-- 網域清單與 _shared/source-archive.ts 的 BULLETIN_HOSTS／NOTICE_HOSTS 一致（source-archive.test.ts 盯）。
-- db.cec.gov.tw（選舉資料庫）是長期保存的，不算。
CREATE OR REPLACE FUNCTION source_doc_kind(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_url IS NULL OR p_url !~* '^https?://' THEN NULL
    WHEN contribution_host_of(p_url) = ANY (ARRAY['bulletin.cec.gov.tw', 'eebulletin.cec.gov.tw']) THEN 'election_bulletin'
    WHEN contribution_host_of(p_url) = ANY (ARRAY['web.cec.gov.tw', 'cec.gov.tw']) THEN 'election_notice'
    ELSE NULL
  END;
$$;
COMMENT ON FUNCTION source_doc_kind IS '出處的文件類別：選舉公報 election_bulletin、選委會公告與名冊 election_notice，其餘 NULL（#347）';

-- 自動判斷的出處等級：社群沒有認定根據 → media；永遠不給 self
CREATE OR REPLACE FUNCTION source_auto_kind(p_url TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE contribution_source_kind(ARRAY[p_url])
    WHEN 'official' THEN 'official'
    WHEN 'media' THEN 'media'
    WHEN 'social' THEN 'media'
    ELSE 'other'
  END;
$$;
COMMENT ON FUNCTION source_auto_kind IS '依網域自動判斷出處等級；社群貼文沒有認定根據一律算 media，自動判斷不會給 self（#347）';

-- ------------------------------------------------------------
-- 資料表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id               BIGSERIAL PRIMARY KEY,
  url              TEXT NOT NULL UNIQUE,
  title            TEXT,
  publisher        TEXT,
  published_date   DATE,
  source_kind      TEXT NOT NULL DEFAULT 'other' CHECK (source_kind IN ('official', 'self', 'media', 'other')),
  self_evidence    TEXT CHECK (self_evidence IN ('linked_by_official', 'mutual_link', 'platform_verified')),
  doc_kind         TEXT CHECK (doc_kind IN ('election_bulletin', 'election_notice')),
  fetched_at       TIMESTAMPTZ,
  archive_url      TEXT,
  archived_at      TIMESTAMPTZ,
  archive_attempts INTEGER NOT NULL DEFAULT 0,
  archive_next_at  TIMESTAMPTZ,
  archive_error    TEXT,
  origin           TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_url_http CHECK (url ~* '^https?://'),
  -- 本人來源一定要有認定根據；有根據就一定是本人來源（防冒名：沒有根據的本人帳號視為媒體）
  CONSTRAINT sources_self_needs_evidence CHECK ((source_kind = 'self') = (self_evidence IS NOT NULL)),
  CONSTRAINT sources_archive_url_http CHECK (archive_url IS NULL OR archive_url ~* '^https?://')
);

COMMENT ON TABLE sources IS '出處（一個網址一列），任何資料都用 source_refs 引用（#347 第一階段；舊的 policies.source_url 等欄位仍保留）';
COMMENT ON COLUMN sources.source_kind IS 'official 官方／self 本人（需 self_evidence）／media 媒體與未認定的社群／other 其他';
COMMENT ON COLUMN sources.self_evidence IS '本人來源的認定根據：linked_by_official 被議會・選委會・政黨官網連結／mutual_link 與本人官網互相連結／platform_verified 平台認證';
COMMENT ON COLUMN sources.doc_kind IS 'election_bulletin 選舉公報／election_notice 選委會公告與名冊；這兩類要有 archive_url';
COMMENT ON COLUMN sources.fetched_at IS '這個網址第一次進入正見資料的時間（代理交件或落庫當下）；回填的舊政見不知道代理何時讀的，留空不編造';
COMMENT ON COLUMN sources.archive_url IS 'Wayback Machine 的存檔網址（排程 source-archive 寫入）';
COMMENT ON COLUMN sources.archive_next_at IS '下次可以再試存檔的時間（失敗退避；NULL＝馬上可以）';
COMMENT ON COLUMN sources.origin IS '這列最早從哪裡來：backfill:policies.source_url、policies.source_url、contribution 等';

CREATE INDEX IF NOT EXISTS idx_sources_archive_backlog ON sources (archive_next_at NULLS FIRST, id)
  WHERE doc_kind IS NOT NULL AND archive_url IS NULL;

CREATE TABLE IF NOT EXISTS source_refs (
  source_id    BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_table TEXT NOT NULL CHECK (target_table IN ('policies', 'tracking_logs')),
  target_id    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'supporting')),
  origin       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_table, target_id, source_id)
);
COMMENT ON TABLE source_refs IS '哪一筆資料引用了哪個出處（#347）。role：primary＝那筆資料的主要出處（舊的 source_url 欄）／supporting＝交件時一併附上的其他來源';
CREATE INDEX IF NOT EXISTS idx_source_refs_source ON source_refs (source_id);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON sources;
CREATE POLICY "Public read" ON sources FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON sources;
CREATE POLICY "Service role write" ON sources FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE source_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON source_refs;
CREATE POLICY "Public read" ON source_refs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON source_refs;
CREATE POLICY "Service role write" ON source_refs FOR ALL USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 寫入：一個網址 → 一列（同網址只留一列；已經有的欄位不覆蓋，擷取時間取最早）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION source_upsert(
  p_url TEXT, p_origin TEXT,
  p_title TEXT DEFAULT NULL, p_publisher TEXT DEFAULT NULL, p_published DATE DEFAULT NULL,
  p_fetched_at TIMESTAMPTZ DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_url TEXT := btrim(coalesce(p_url, ''));
  v_id BIGINT;
BEGIN
  IF v_url !~* '^https?://[^/\s]+' THEN RETURN NULL; END IF;
  INSERT INTO sources (url, title, publisher, published_date, source_kind, doc_kind, fetched_at, origin)
  VALUES (v_url, p_title, p_publisher, p_published, source_auto_kind(v_url), source_doc_kind(v_url), p_fetched_at, p_origin)
  ON CONFLICT (url) DO UPDATE SET
    title          = coalesce(sources.title, EXCLUDED.title),
    publisher      = coalesce(sources.publisher, EXCLUDED.publisher),
    published_date = coalesce(sources.published_date, EXCLUDED.published_date),
    fetched_at     = least(sources.fetched_at, EXCLUDED.fetched_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION source_upsert(TEXT, TEXT, TEXT, TEXT, DATE, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 觸發器：舊欄位被寫入時同步新表。出錯只記警告，不擋原本的寫入。
-- ------------------------------------------------------------

-- policies.source_url → 主要出處。改了網址（correction 換 source_url）就換掉主要出處：
-- 換掉的原因通常是舊網址沒寫到這筆宣稱，留著當佐證會誤導。
CREATE OR REPLACE FUNCTION sources_sync_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sid BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_url IS NOT DISTINCT FROM OLD.source_url THEN RETURN NEW; END IF;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM source_refs WHERE target_table = 'policies' AND target_id = NEW.id::text AND role = 'primary';
    END IF;
    v_sid := source_upsert(NEW.source_url, 'policies.source_url', NULL, NULL, NULL, now());
    IF v_sid IS NOT NULL THEN
      INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
      VALUES (v_sid, 'policies', NEW.id::text, 'primary', 'policies.source_url')
      ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sources_sync_policy(%): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sources_sync_policy ON policies;
CREATE TRIGGER trg_sources_sync_policy AFTER INSERT OR UPDATE OF source_url ON policies
  FOR EACH ROW EXECUTE FUNCTION sources_sync_policy();

-- tracking_logs.source_url → 主要出處
CREATE OR REPLACE FUNCTION sources_sync_tracking_log() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sid BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_url IS NOT DISTINCT FROM OLD.source_url THEN RETURN NEW; END IF;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      DELETE FROM source_refs WHERE target_table = 'tracking_logs' AND target_id = NEW.id::text AND role = 'primary';
    END IF;
    v_sid := source_upsert(NEW.source_url, 'tracking_logs.source_url', NULL, NULL, NULL, now());
    IF v_sid IS NOT NULL THEN
      INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
      VALUES (v_sid, 'tracking_logs', NEW.id::text, 'primary', 'tracking_logs.source_url')
      ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sources_sync_tracking_log(%): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sources_sync_tracking_log ON tracking_logs;
CREATE TRIGGER trg_sources_sync_tracking_log AFTER INSERT OR UPDATE OF source_url ON tracking_logs
  FOR EACH ROW EXECUTE FUNCTION sources_sync_tracking_log();

-- policy_sources（舊的政見來源表，線上 0 筆）→ 佐證出處
CREATE OR REPLACE FUNCTION sources_sync_policy_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sid BIGINT;
BEGIN
  BEGIN
    v_sid := source_upsert(NEW.url, 'policy_sources', NEW.title, NEW.source_name, NEW.published_date, coalesce(NEW.created_at, now()));
    IF v_sid IS NOT NULL THEN
      INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
      VALUES (v_sid, 'policies', NEW.policy_id::text, 'supporting', 'policy_sources')
      ON CONFLICT (target_table, target_id, source_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sources_sync_policy_source(%): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sources_sync_policy_source ON policy_sources;
CREATE TRIGGER trg_sources_sync_policy_source AFTER INSERT ON policy_sources
  FOR EACH ROW EXECUTE FUNCTION sources_sync_policy_source();

-- contributions：
--   交件當下：選舉公報／選委會公告類的網址先登記進 sources，排程才能在投票前就存檔
--   （公報投票後下架，等驗證通過才存可能來不及）；其他網址等落庫才進來。
--   「新增政見」落庫（applied_policy_id 填上）：交件附的其他網址記成那筆政見的佐證出處——
--   舊的 policies.source_url 只放得下第一個網址。
CREATE OR REPLACE FUNCTION sources_sync_contribution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_url TEXT;
  v_sid BIGINT;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      FOREACH v_url IN ARRAY coalesce(NEW.source_urls, ARRAY[]::TEXT[]) LOOP
        IF source_doc_kind(btrim(v_url)) IS NOT NULL THEN
          PERFORM source_upsert(v_url, 'contribution', NULL, NULL, NULL, coalesce(NEW.created_at, now()));
        END IF;
      END LOOP;
    ELSIF NEW.contribution_type = 'policy' AND NEW.applied_policy_id IS NOT NULL
          AND OLD.applied_policy_id IS DISTINCT FROM NEW.applied_policy_id THEN
      FOREACH v_url IN ARRAY coalesce(NEW.source_urls, ARRAY[]::TEXT[]) LOOP
        v_sid := source_upsert(v_url, 'contribution', NULL, NULL, NULL, coalesce(NEW.created_at, now()));
        IF v_sid IS NOT NULL THEN
          INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
          VALUES (v_sid, 'policies', NEW.applied_policy_id::text, 'supporting', 'contribution')
          ON CONFLICT (target_table, target_id, source_id) DO NOTHING;
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sources_sync_contribution(%): %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sources_sync_contribution ON contributions;
CREATE TRIGGER trg_sources_sync_contribution AFTER INSERT OR UPDATE OF applied_policy_id ON contributions
  FOR EACH ROW EXECUTE FUNCTION sources_sync_contribution();

-- ------------------------------------------------------------
-- 回填（舊欄位保留，只是多寫一份到新表）
-- 擷取時間：舊政見不知道代理何時讀的，留空；從貢獻來的用交件時間。
-- ------------------------------------------------------------

-- 1. 「新增政見」貢獻附的網址（含第一個以外的）：先寫，交件時間才是最早的擷取時間
WITH c AS (
  SELECT c.applied_policy_id, btrim(u) AS url, min(c.created_at) AS created_at
    FROM contributions c
    CROSS JOIN LATERAL unnest(coalesce(c.source_urls, ARRAY[]::TEXT[])) AS u
   WHERE c.contribution_type = 'policy' AND c.status = 'applied' AND c.applied_policy_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM policies p WHERE p.id = c.applied_policy_id)
   GROUP BY 1, 2
)
INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
SELECT s.sid, 'policies', c.applied_policy_id::text, 'supporting', 'backfill:contribution'
  FROM c CROSS JOIN LATERAL (SELECT source_upsert(c.url, 'backfill:contribution', NULL, NULL, NULL, c.created_at) AS sid) s
 WHERE s.sid IS NOT NULL
ON CONFLICT (target_table, target_id, source_id) DO NOTHING;

-- 2. policies.source_url → 主要出處（同一網址若已是佐證，升成主要）
INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
SELECT s.sid, 'policies', p.id::text, 'primary', 'backfill:policies.source_url'
  FROM policies p CROSS JOIN LATERAL (SELECT source_upsert(p.source_url, 'backfill:policies.source_url') AS sid) s
 WHERE p.source_url IS NOT NULL AND s.sid IS NOT NULL
ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';

-- 3. policy_sources（線上 0 筆，照寫以防萬一）→ 佐證出處
INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
SELECT s.sid, 'policies', ps.policy_id::text, 'supporting', 'backfill:policy_sources'
  FROM policy_sources ps
  CROSS JOIN LATERAL (SELECT source_upsert(ps.url, 'backfill:policy_sources', ps.title, ps.source_name, ps.published_date, ps.created_at) AS sid) s
 WHERE s.sid IS NOT NULL
ON CONFLICT (target_table, target_id, source_id) DO NOTHING;

-- 4. tracking_logs.source_url → 主要出處
INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
SELECT s.sid, 'tracking_logs', t.id::text, 'primary', 'backfill:tracking_logs.source_url'
  FROM tracking_logs t CROSS JOIN LATERAL (SELECT source_upsert(t.source_url, 'backfill:tracking_logs.source_url') AS sid) s
 WHERE t.source_url IS NOT NULL AND s.sid IS NOT NULL
ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';

-- 5. 所有交件（不論狀態）裡的選舉公報／選委會公告網址：登記進來等存檔。
--    還在等票、甚至被退件的也存——存檔的成本是一次 Wayback 請求，漏存的代價是公報下架後永遠拿不回來。
SELECT count(source_upsert(btrim(u), 'backfill:contribution', NULL, NULL, NULL, c.created_at))
  FROM contributions c CROSS JOIN LATERAL unnest(coalesce(c.source_urls, ARRAY[]::TEXT[])) AS u
 WHERE source_doc_kind(btrim(u)) IS NOT NULL;

-- ------------------------------------------------------------
-- 存檔排程用的函式
-- ------------------------------------------------------------

-- 領一筆待存檔的出處：先把 archive_next_at 推後 30 分鐘當租約（兩個呼叫同時進來不會搶同一筆），
-- 存檔結果由 source-archive 寫回（成功清掉、失敗依次數退避）。
CREATE OR REPLACE FUNCTION source_archive_claim(p_limit INTEGER DEFAULT 1)
RETURNS TABLE (id BIGINT, url TEXT, doc_kind TEXT, fetched_at TIMESTAMPTZ, archive_attempts INTEGER)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sources s
     SET archive_attempts = s.archive_attempts + 1,
         archive_next_at = now() + interval '30 minutes'
   WHERE s.id IN (
     SELECT x.id FROM sources x
      WHERE x.doc_kind IS NOT NULL AND x.archive_url IS NULL
        AND (x.archive_next_at IS NULL OR x.archive_next_at <= now())
      ORDER BY x.archive_next_at NULLS FIRST, x.id
      LIMIT least(greatest(coalesce(p_limit, 1), 1), 20)
      FOR UPDATE SKIP LOCKED)
  RETURNING s.id, s.url, s.doc_kind, s.fetched_at, s.archive_attempts;
$$;
REVOKE EXECUTE ON FUNCTION source_archive_claim(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION source_archive_claim(INTEGER) TO service_role;
COMMENT ON FUNCTION source_archive_claim IS '排程 source-archive 領待存檔的出處（選舉公報／選委會公告且還沒有 archive_url），一次最多 20 筆（#347）';

-- 存檔進度（公開）：每種文件類別有幾個、存了幾個、還在等、試了 3 次以上還沒成功的
CREATE OR REPLACE FUNCTION source_archive_status()
RETURNS TABLE (doc_kind TEXT, total BIGINT, archived BIGINT, waiting BIGINT, failing BIGINT, last_archived_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.doc_kind,
         count(*),
         count(*) FILTER (WHERE s.archive_url IS NOT NULL),
         count(*) FILTER (WHERE s.archive_url IS NULL),
         count(*) FILTER (WHERE s.archive_url IS NULL AND s.archive_attempts >= 3),
         max(s.archived_at)
    FROM sources s
   WHERE s.doc_kind IS NOT NULL
   GROUP BY s.doc_kind
   ORDER BY s.doc_kind;
$$;
GRANT EXECUTE ON FUNCTION source_archive_status() TO anon, authenticated;
COMMENT ON FUNCTION source_archive_status IS '選舉公報／選委會公告類出處的存檔進度（#347）';

-- ------------------------------------------------------------
-- 排程：每 10 分鐘存一輪（第 7 分起）。source-archive 不驗 JWT，外人重複打只會多領幾筆、
-- 而每筆有 30 分鐘租約與失敗退避，不會對 Wayback 連續送同一個網址。
-- ------------------------------------------------------------
SELECT cron.unschedule('source-archive-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'source-archive-10min');
SELECT cron.schedule('source-archive-10min', '7-59/10 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/source-archive',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);
