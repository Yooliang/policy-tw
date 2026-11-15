-- 政見三要素（規則 33）改成選後 50 天自動開、只派當選者（維護者 2026-11-15，正見VM 群組 #778；取代同日 20261115030000 的暫停）
-- 兩處：
--   1. 規則 33：window_kind='event'、from_kind='polling'、from_offset=50、無迄日、enabled=true（同 20261008120000 party_gap 的型，起點改成投票日 +50）。
--      這支臂的 target 帶 election_id、election_type（總表 contribution_auto_tasks_arms() 取 target->>'election_id' 問 activity_open），所以事件窗口算得出每列的投票日。
--      2026-11-28 投票 → 2027-01-17（台北日界）起開；params（elements=['target']、election_ids=[2026]）與 election_types（縣市長）不動。
--   2. 臂：限定當選者。本體＝緊接在前的那一版（20261010100000）把 WHERE 的「還沒投票的在選者 OR 已投票的當選者」換成「已投票且當選」一處機械式替換
--      （policy-elements-after-election.test.ts 逐字比對）。窗口沒開時總表本來就濾掉；這裡再限定是為了窗口開了之後也不派落選者。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  -- 派哪些要素、哪幾屆：讀規則 activity_rules（activity＝policy_elements）的 params（OPS #61，維護者 2026-10-10 各站可設定）；
  -- elements＝要派的要素、election_ids＝要派的屆別（elections.id），沒設＝三個要素、每一屆都派。
  -- 職位用規則本身的 election_types 欄（總表過濾，關掉的收回原因記 window），不在這裡。
  WITH cfg AS MATERIALIZED (
    SELECT COALESCE((SELECT ARRAY(SELECT jsonb_array_elements_text(r.params->'elements'))
                       FROM activity_rules r
                      WHERE r.activity = 'policy_elements' AND r.priority IS NULL AND jsonb_typeof(r.params->'elements') = 'array'
                      ORDER BY r.id LIMIT 1),
                    ARRAY['target', 'deadline', 'funding']) AS elements,
           (SELECT ARRAY(SELECT (jsonb_array_elements_text(r.params->'election_ids'))::INTEGER)
              FROM activity_rules r
             WHERE r.activity = 'policy_elements' AND r.priority IS NULL AND jsonb_typeof(r.params->'election_ids') = 'array'
             ORDER BY r.id LIMIT 1) AS election_ids
  ),
  inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS MATERIALIZED (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, policy_primary_url(pl.id) AS source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date, e.bulletin_hint, e.bulletin_published_on,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE u.k = ANY ((SELECT cfg.elements FROM cfg)::TEXT[])
                    AND NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND ((SELECT cfg.election_ids FROM cfg) IS NULL OR pl.election_id = ANY ((SELECT cfg.election_ids FROM cfg)::INTEGER[]))
       -- 只派當選者（維護者 2026-11-15）：投票之後、當選、而且還沒達成也沒跳票（期限要接得上追蹤）；選前在選的人不再派。何時開由規則 33 的窗口決定（投票日 +50）
       AND e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '只看上面列的要素（這一站目前只派這幾個；沒列的不用查、不用交），逐一看原文有沒有寫——數值目標＝做到多少、做到什麼程度；達成期限＝什麼時候之前；財源＝錢從哪裡來。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           -- 公報入口讀 elections.bulletin_hint（公報上架日 bulletin_published_on 之後才給；沒填或還沒上架就給下面那句）
           CASE WHEN c.bulletin_hint IS NOT NULL AND (c.bulletin_published_on IS NULL OR c.bulletin_published_on <= CURRENT_DATE)
                THEN c.bulletin_hint
                ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$function$
;

UPDATE activity_rules
   SET window_kind = 'event', from_kind = 'polling', from_offset = 50, until_kind = NULL, until_offset = 0,
       enabled = true,
       note = '維護者 2026-11-15（#778）：選後 50 天自動開（投票日 +50 起、無迄日）、臂只派當選者；取代同日暫停。params（只派數值目標、2026）與職位（縣市長）不動'
 WHERE id = 33 AND activity = 'policy_elements';

DO $$
DECLARE r activity_rules;
BEGIN
  IF (SELECT count(*) FROM activity_rules WHERE activity = 'policy_elements') <> 1 THEN
    RAISE EXCEPTION 'policy_elements 的規則不是預期的一條';
  END IF;
  SELECT * INTO r FROM activity_rules WHERE id = 33 AND activity = 'policy_elements';
  IF NOT FOUND OR NOT r.enabled OR r.window_kind IS DISTINCT FROM 'event' OR r.from_kind IS DISTINCT FROM 'polling'
     OR r.from_offset IS DISTINCT FROM 50 OR r.until_kind IS NOT NULL THEN
    RAISE EXCEPTION 'policy_elements 規則 33 不是預期的「投票日 +50 起」窗口：%', to_jsonb(r);
  END IF;
END $$;
