-- 出處第二階段 A：讀寫端改用出處表（#347；小良哥 2026-10-06 點頭）。**只加不刪、不改簽名**：
-- policies.source_url、tracking_logs.source_url、policy_sources 與同步觸發器全部保留，刪除是第二階段 B（另開 PR），
-- 前置條件見 docs/DECISIONS.md 2026-10-06「出處第二階段 A」與本檔最後的自我檢查。
--
-- 這支做的事：
--   1. 引用範圍擴到參選紀錄：source_refs.target_table 加 politician_elections（政策、進度、要素、脈絡、學經歷、政黨已有）。
--      回填：已落庫的 candidacy 交件，把 source_urls 掛到對得上的那一筆參選紀錄上（臉書、IG、Threads 讀不到，不掛）。
--   2. 本人來源的認定守在資料庫：source_self_eligible()＋sources 表的 CHECK——self 的網址必須是「打得開的本人官網、
--      政黨刊載頁」這一類：不是官方網域、不是媒體、不是任何社群（臉書、IG、Threads、YouTube、X、LINE、TikTok…）。
--      小良哥 10-05：臉書讀不到、不能當出處，「本人來源」只收打得開的本人官網、政黨刊載頁。
--      （self_evidence 的 platform_verified 這個值資料庫仍收、協議不收：平台認證只會出現在社群上。）
--   3. 落庫直接寫出處表：source_write()＝一次寫好出處（等級、認定根據）與引用（主要／佐證）。舊欄位與觸發器照舊，
--      兩邊寫的是同一個網址，所以過渡期不會不一致。
--   4. 讀取：source_brief_list()（一筆資料的出處清單，有等級、存檔網址）、source_briefs()（一批網址的等級與存檔，
--      給查核履歷與貢獻看板）；policies_with_logs 多一欄 sources、每則 logs 多帶 source_url 與 sources。
--   5. 切換前的核對：視圖 source_refs_drift（新舊兩邊對不上的地方，正常是空的）——第二階段 B 要等它是空的才動手。

-- ------------------------------------------------------------
-- 1. 引用範圍：加參選紀錄（前一版見 20261006073461）
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements', 'lineage_participants', 'handovers', 'lineage_links', 'politician_careers', 'parties', 'politician_elections'));

-- ------------------------------------------------------------
-- 2. 本人來源：打得開的本人官網、政黨刊載頁。其他一律不能是 self
-- ------------------------------------------------------------
-- 清單與 supabase/functions/_shared/source-write.ts 的 SELF_INELIGIBLE_HOSTS 一致（source-write.test.ts 盯）。
-- 前五個是讀不到的社群（臉書、IG、Threads），其餘是讀得到但不是「本人官網」的社群平台；
-- 官方網域、媒體網域另外由 source_auto_kind() 擋（自動判斷不是 other 的都不能是 self）。
CREATE OR REPLACE FUNCTION source_self_eligible(p_url TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(btrim(p_url), '') ~* '^https?://[^/\s]+'
     AND source_auto_kind(btrim(p_url)) = 'other'
     AND NOT contribution_host_in(contribution_host_of(btrim(p_url)), ARRAY[
       'facebook.com', 'fb.com', 'fb.watch', 'instagram.com', 'threads.net',
       'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'tiktok.com', 'line.me', 'lin.ee', 't.me'])
$$;
COMMENT ON FUNCTION source_self_eligible IS
  '這個網址能不能是「本人來源」：要是 http(s)、自動判斷是 other（不是官方、不是媒體、不是已知社群），而且不在社群平台清單上（#347 第二階段 A，2026-10-06）';

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_self_eligible;
ALTER TABLE sources ADD CONSTRAINT sources_self_eligible CHECK (source_kind <> 'self' OR source_self_eligible(url));

-- ------------------------------------------------------------
-- 3. 落庫直接寫出處表
--    p_sources：[{url, role?, kind?, self_evidence?, title?, publisher?}, ...]，照順序處理
--      · 等級：只有 self 由交件決定（要有 self_evidence 而且網址通過 source_self_eligible），其餘一律依網域自動判斷；
--        交件說 self 但不合格 → 照自動判斷，不報錯（交件當下的守門已經擋過，這裡是最後一道）。
--        已經是 self 的不降級、不改根據。
--      · role：沒給或給 primary＝這筆資料還沒有主要出處時，第一個被收下的網址當主要、其餘佐證（已經有主要出處的一律記佐證；
--        所以第一個網址被略過〔參選紀錄的臉書〕時，下一個頂上）；給 supporting 一律記佐證。
--      · 參選紀錄：臉書、IG、Threads 讀不到，不掛（跟學經歷同一條）。
--    p_target_table 為空：只補等級，且只動已經存在的出處列（不新增沒人引用的出處）。
--    回傳每個網址落成的等級，給呼叫端記錄。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION source_write(
  p_target_table TEXT, p_target_id TEXT, p_sources JSONB,
  p_origin TEXT DEFAULT 'contribution', p_fetched_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item JSONB;
  v_url TEXT;
  v_sid BIGINT;
  v_ev TEXT;
  v_want_self BOOLEAN;
  v_self_ok BOOLEAN;
  v_role TEXT;
  v_out JSONB := '[]'::JSONB;
  v_kind TEXT;
BEGIN
  IF p_sources IS NULL OR jsonb_typeof(p_sources) <> 'array' THEN RETURN v_out; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_sources) LOOP
    v_url := btrim(coalesce(v_item ->> 'url', ''));
    CONTINUE WHEN v_url !~* '^https?://[^/\s]+';
    IF p_target_table = 'politician_elections' AND NOT career_source_readable(v_url) THEN CONTINUE; END IF;

    IF p_target_table IS NULL THEN
      SELECT id INTO v_sid FROM sources WHERE url = v_url;
      CONTINUE WHEN v_sid IS NULL;
    ELSE
      v_sid := source_upsert(v_url, coalesce(p_origin, 'contribution'), nullif(btrim(coalesce(v_item ->> 'title', '')), ''),
                             nullif(btrim(coalesce(v_item ->> 'publisher', '')), ''), NULL, coalesce(p_fetched_at, now()));
      CONTINUE WHEN v_sid IS NULL;
    END IF;

    v_ev := v_item ->> 'self_evidence';
    v_want_self := (v_item ->> 'kind') = 'self';
    v_self_ok := v_want_self AND v_ev IN ('linked_by_official', 'mutual_link') AND source_self_eligible(v_url);
    IF v_self_ok THEN
      UPDATE sources SET source_kind = 'self', self_evidence = v_ev WHERE id = v_sid AND source_kind <> 'self';
    END IF;

    IF p_target_table IS NOT NULL AND p_target_id IS NOT NULL THEN
      -- role 沒給或給 primary：這筆資料還沒有主要出處就當主要（第一個被收下的網址），否則記佐證；給 supporting 一律佐證
      v_role := CASE WHEN v_item ->> 'role' = 'supporting' THEN 'supporting' ELSE 'primary' END;
      IF v_role = 'primary'
         AND NOT EXISTS (SELECT 1 FROM source_refs r WHERE r.target_table = p_target_table AND r.target_id = p_target_id
                            AND r.role = 'primary' AND r.source_id <> v_sid) THEN
        INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
        VALUES (v_sid, p_target_table, p_target_id, 'primary', coalesce(p_origin, 'contribution'))
        ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
      ELSE
        INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
        VALUES (v_sid, p_target_table, p_target_id, 'supporting', coalesce(p_origin, 'contribution'))
        ON CONFLICT (target_table, target_id, source_id) DO NOTHING;
      END IF;
    END IF;

    SELECT source_kind INTO v_kind FROM sources WHERE id = v_sid;
    v_out := v_out || jsonb_build_array(jsonb_build_object('url', v_url, 'kind', v_kind,
                                                           'self_declined', (v_want_self AND NOT v_self_ok AND v_kind <> 'self')));
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE EXECUTE ON FUNCTION source_write(TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION source_write(TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ) TO service_role;
COMMENT ON FUNCTION source_write IS
  '落庫直接寫出處與引用（等級只有 self 由交件決定，且要認定根據、網址要通過 source_self_eligible）；p_target_table 空＝只補既有出處的等級（#347 第二階段 A）';

-- ------------------------------------------------------------
-- 4. 讀取
-- ------------------------------------------------------------
-- 一筆資料的出處清單：主要出處在前；有等級、認定根據、存檔網址
CREATE OR REPLACE FUNCTION source_brief_list(p_table TEXT, p_id TEXT) RETURNS JSON
LANGUAGE sql STABLE AS $$
  SELECT coalesce(json_agg(json_build_object(
           'url', s.url, 'title', s.title, 'publisher', s.publisher, 'published_date', s.published_date,
           'kind', s.source_kind, 'self_evidence', s.self_evidence, 'archive_url', s.archive_url, 'role', r.role)
         ORDER BY (r.role = 'primary') DESC, r.created_at, s.id), '[]'::json)
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = p_table AND r.target_id = p_id
$$;
COMMENT ON FUNCTION source_brief_list IS '一筆資料的出處清單（主要在前）：網址、標題、發布者、等級、認定根據、存檔網址（#347 第二階段 A）';

-- 一批網址的等級與存檔（查核履歷、貢獻看板：交件的 source_urls 掛上等級）；一次最多 500 個
CREATE OR REPLACE FUNCTION source_briefs(p_urls TEXT[])
RETURNS TABLE (url TEXT, source_kind TEXT, self_evidence TEXT, doc_kind TEXT, archive_url TEXT, title TEXT, publisher TEXT)
LANGUAGE sql STABLE AS $$
  SELECT s.url, s.source_kind, s.self_evidence, s.doc_kind, s.archive_url, s.title, s.publisher
    FROM sources s
   WHERE s.url = ANY (p_urls[1:500])
$$;
GRANT EXECUTE ON FUNCTION source_briefs(TEXT[]) TO anon, authenticated, service_role;
COMMENT ON FUNCTION source_briefs IS '一批網址在出處表裡的等級與存檔網址（一次最多 500 個；#347 第二階段 A）';

-- policies_with_logs：最後多一欄 sources；每則 logs 多帶舊欄位 source_url（退路）與 sources。
-- 前面 p.*、logs（前四個鍵）、related_policy_ids、elements、lineage 與 20261006034900 一字不差。
-- 沒有別的視圖依賴它（2026-10-06 pg_depend 查過）；policies 若之後加欄位，p.* 會插在中間，所以照舊 DROP＋CREATE。
DROP VIEW IF EXISTS policies_with_logs;
CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description,
                        'source_url', tl.source_url, 'sources', source_brief_list('tracking_logs', tl.id::text))
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'element', e.element, 'stated', e.stated, 'text', e.text, 'deadline_date', e.deadline_date,
        'source_locator', e.source_locator, 'source_url', e.source_url, 'updated_at', e.updated_at,
        'source', (SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher,
                                            'kind', s.source_kind, 'archive_url', s.archive_url)
                     FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policy_elements' AND r.target_id = e.id::text AND r.role = 'primary'
                    LIMIT 1)
      )
      ORDER BY array_position(ARRAY['target', 'deadline', 'funding'], e.element)
    )
    FROM policy_elements e
    WHERE e.policy_id = p.id),
    '[]'::json
  ) AS elements,
  (SELECT json_build_object('id', l.id, 'title', l.title, 'level', l.level, 'region', l.region, 'sub_region', l.sub_region,
                            'category', l.category, 'summary', l.summary)
     FROM lineages l WHERE l.id = p.lineage_id) AS lineage,
  source_brief_list('policies', p.id::text) AS sources
FROM policies p;
ALTER VIEW policies_with_logs SET (security_invoker = on);
GRANT SELECT ON policies_with_logs TO anon, authenticated;
COMMENT ON VIEW policies_with_logs IS
  '政見＋進度紀錄＋相關政見＋三要素＋脈絡＋出處。新欄位一律接在最後（目前最後是 sources，#347 第二階段 A）；policies 加欄位時 p.* 會插在中間，要 DROP＋CREATE';

-- ------------------------------------------------------------
-- 5. 回填：參選紀錄的出處（搬移，不是新資料）
--    已落庫的 candidacy 交件，照落庫順序，把 source_urls 掛到「同一人、同一屆」的參選紀錄上；
--    第一個網址是主要出處（那一筆還沒有主要出處時），其餘佐證。對不上參選紀錄的（人被合併、紀錄被改掛）略過。
-- ------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_contribs INTEGER := 0;
  v_pe INTEGER;
BEGIN
  FOR r IN
    SELECT c.id, pe.id AS pe_id, c.source_urls, coalesce(c.applied_at, c.created_at) AS at
      FROM contributions c
      JOIN politician_elections pe ON pe.politician_id = c.applied_politician_id AND pe.election_id::TEXT = c.payload ->> 'election_id'
     WHERE c.contribution_type = 'candidacy' AND c.status = 'applied' AND c.applied_politician_id IS NOT NULL
     ORDER BY coalesce(c.applied_at, c.created_at), c.id
  LOOP
    PERFORM source_write('politician_elections', r.pe_id::TEXT,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('url', btrim(u.url)) ORDER BY u.n), '[]'::JSONB)
         FROM unnest(coalesce(r.source_urls, ARRAY[]::TEXT[])) WITH ORDINALITY AS u(url, n)),
      'backfill:contribution', r.at);
    v_contribs := v_contribs + 1;
  END LOOP;
  SELECT count(DISTINCT target_id) INTO v_pe FROM source_refs WHERE target_table = 'politician_elections';
  RAISE NOTICE '參選紀錄出處回填：看過 % 筆已落庫 candidacy 交件；% 筆參選紀錄有出處', v_contribs, v_pe;
END $$;

-- ------------------------------------------------------------
-- 6. 切換前的核對：新舊兩邊對不上的地方（正常是空的）
--    problem：
--      policy_url_not_in_refs        政見有 source_url，但出處表沒有這個網址當主要出處
--      policy_primary_differs        主要出處的網址跟 source_url 不同
--      policy_ref_without_url        政見沒有 source_url，出處表卻有主要出處
--      policy_multi_primary          一條政見有兩個以上的主要出處
--      log_url_not_in_refs / log_primary_differs / log_ref_without_url   進度紀錄同上
--      policy_source_not_in_refs     policy_sources（舊的政見來源表）有的網址，出處表沒有
--      applied_policy_url_not_in_refs  已落庫的「新增政見」交件附的網址，沒掛到那條政見上
--      dangling_ref                  引用指到已經不存在的政見或進度紀錄
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW source_refs_drift AS
WITH pol AS (
  SELECT r.target_id, count(*) AS n, min(s.url) AS url
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = 'policies' AND r.role = 'primary' GROUP BY r.target_id
), lg AS (
  SELECT r.target_id, count(*) AS n, min(s.url) AS url
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = 'tracking_logs' AND r.role = 'primary' GROUP BY r.target_id
)
SELECT 'policy_url_not_in_refs'::TEXT AS problem, 'policies'::TEXT AS target_table, p.id::TEXT AS target_id, p.source_url AS url
  FROM policies p WHERE btrim(coalesce(p.source_url, '')) <> '' AND NOT EXISTS (SELECT 1 FROM pol WHERE pol.target_id = p.id::TEXT)
UNION ALL
SELECT 'policy_primary_differs', 'policies', p.id::TEXT, p.source_url
  FROM policies p JOIN pol ON pol.target_id = p.id::TEXT WHERE btrim(coalesce(p.source_url, '')) <> '' AND pol.url <> btrim(p.source_url) AND pol.n = 1
UNION ALL
SELECT 'policy_ref_without_url', 'policies', p.id::TEXT, pol.url
  FROM policies p JOIN pol ON pol.target_id = p.id::TEXT WHERE btrim(coalesce(p.source_url, '')) = ''
UNION ALL
SELECT 'policy_multi_primary', 'policies', pol.target_id, pol.url FROM pol WHERE pol.n > 1
UNION ALL
SELECT 'log_url_not_in_refs', 'tracking_logs', t.id::TEXT, t.source_url
  FROM tracking_logs t WHERE btrim(coalesce(t.source_url, '')) <> '' AND NOT EXISTS (SELECT 1 FROM lg WHERE lg.target_id = t.id::TEXT)
UNION ALL
SELECT 'log_primary_differs', 'tracking_logs', t.id::TEXT, t.source_url
  FROM tracking_logs t JOIN lg ON lg.target_id = t.id::TEXT WHERE btrim(coalesce(t.source_url, '')) <> '' AND lg.url <> btrim(t.source_url) AND lg.n = 1
UNION ALL
SELECT 'log_ref_without_url', 'tracking_logs', t.id::TEXT, lg.url
  FROM tracking_logs t JOIN lg ON lg.target_id = t.id::TEXT WHERE btrim(coalesce(t.source_url, '')) = ''
UNION ALL
SELECT 'policy_source_not_in_refs', 'policies', ps.policy_id::TEXT, ps.url
  FROM policy_sources ps
 WHERE btrim(coalesce(ps.url, '')) ~* '^https?://[^/\s]+'
   AND NOT EXISTS (SELECT 1 FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policies' AND r.target_id = ps.policy_id::TEXT AND s.url = btrim(ps.url))
UNION ALL
SELECT 'applied_policy_url_not_in_refs', 'policies', c.applied_policy_id::TEXT, btrim(u)
  FROM contributions c CROSS JOIN LATERAL unnest(coalesce(c.source_urls, ARRAY[]::TEXT[])) AS u
 WHERE c.contribution_type = 'policy' AND c.status = 'applied' AND c.applied_policy_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM policies p WHERE p.id = c.applied_policy_id)
   AND btrim(u) ~* '^https?://[^/\s]+'
   AND NOT EXISTS (SELECT 1 FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policies' AND r.target_id = c.applied_policy_id::TEXT AND s.url = btrim(u))
UNION ALL
SELECT 'dangling_ref', r.target_table, r.target_id, NULL
  FROM source_refs r
 WHERE (r.target_table = 'policies' AND NOT EXISTS (SELECT 1 FROM policies p WHERE p.id::TEXT = r.target_id))
    OR (r.target_table = 'tracking_logs' AND NOT EXISTS (SELECT 1 FROM tracking_logs t WHERE t.id::TEXT = r.target_id));
COMMENT ON VIEW source_refs_drift IS
  '出處新舊兩邊對不上的地方（policies.source_url／tracking_logs.source_url／policy_sources／已落庫交件 vs 出處表），正常是空的。第二階段 B 刪舊欄位前要先確認它是空的（#347）';
ALTER VIEW source_refs_drift SET (security_invoker = on);
GRANT SELECT ON source_refs_drift TO anon, authenticated;

-- ------------------------------------------------------------
-- 7. 自我檢查：回填完，核對視圖要是空的
--    只記警告、不整支退回：差異是資料（上線前新進的一筆壞網址）不是這支 migration 的錯，
--    讓它擋住整條部署（10-05 出過一次引用錯誤擋住部署）不划算；有差異就看視圖、第二階段 B 不動手。
-- ------------------------------------------------------------
DO $$
DECLARE v_drift INTEGER;
BEGIN
  SELECT count(*) INTO v_drift FROM source_refs_drift;
  IF v_drift > 0 THEN
    RAISE WARNING '出處新舊兩邊有 % 項對不上（看 source_refs_drift）', v_drift;
  ELSE
    RAISE NOTICE '出處核對：新舊兩邊一致（source_refs_drift 是空的）';
  END IF;
END $$;
