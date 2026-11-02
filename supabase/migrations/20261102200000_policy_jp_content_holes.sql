-- 日本站 内容三洞（工作単 Yooliang/policy-ops#178 C）：政党の種子任務、手動任務臂の「測試」override 解除
-- ============================================================
--
-- 1. 手動任務臂 manual_visitor／manual_open の override 解除
--    policy_jp.activity_overrides の id 1・2：force=closed、reason=「測試」、2026-10-10 に主控台から設定（created_by＝維護者）。
--    期限（expires_at）なしで 3 週間残り、ネットの「この人を調べて」請求（manual_visitor）と手動任務（manual_open）の缺口が
--    總表に出ても窓が閉じていたため、1 件も派れなかった（contribution_tasks は 0 件）。
--    解除は既存のやり方（主控台の「例外を消す」＝activity_overrides の行を消す）と同じ。reason が「測試」の closed だけを消す
--    （他の人が後から入れた override を巻き込まない）。
--
-- 2. 政党の種子（party_info 臂に params.seed_parties を足す）
--    parties は 0 件のまま：party_info 臂は『参選に書かれた政党の書き方が名簿に当たらない』ときだけ任務を出すが、
--    その書き方（party_text）は candidacy の落庫でしか入らず、落庫は検証待ち（pending 75 件）で止まっているため、任務が 1 件も出ない。
--    政党の名簿自体を先に作る入口がない。
--    種子：主要な政党の名前だけを params に持ち、『名簿にも別名にも当たらない種子』を party_info_missing 任務（target.kind='seed_party'）として出す。
--    名前と読みは手がかりで、正しい名前・読み・結成日は代理が総務省の政党届出（政党助成法）・政治団体名簿・政党の公式サイトで確かめて
--    party_info で交件する（系統は parties に直接書かない：交件＋検証＋落庫）。落庫で parties に同名の政党が入る（または別名に結ばれる）と種子は自然に消える。
--    task_id は書き方の鍵の md5 前 12 字（既存の party_info_missing と同じ形）：同じ書き方が参選にも使われていれば 1 件にまとまる。
--    種子は『実在の参選で使われている書き方』より後ろ（first_date が空＝最後）に並ぶ。

-- ------------------------------------------------------------
-- 1. override 解除
-- ------------------------------------------------------------
DELETE FROM policy_jp.activity_overrides
 WHERE activity IN ('manual_visitor', 'manual_open') AND "force" = 'closed' AND btrim(reason) = '測試';

-- ------------------------------------------------------------
-- 2. 種子（規則 party_info の params）
-- ------------------------------------------------------------
UPDATE policy_jp.activity_rules
   SET params = params || jsonb_build_object('seed_parties', jsonb_build_array(
         jsonb_build_object('name', '自由民主党', 'kana', 'じゆうみんしゅとう'),
         jsonb_build_object('name', '立憲民主党', 'kana', 'りっけんみんしゅとう'),
         jsonb_build_object('name', '公明党', 'kana', 'こうめいとう'),
         jsonb_build_object('name', '日本維新の会', 'kana', 'にほんいしんのかい'),
         jsonb_build_object('name', '国民民主党', 'kana', 'こくみんみんしゅとう'),
         jsonb_build_object('name', '日本共産党', 'kana', 'にほんきょうさんとう'),
         jsonb_build_object('name', 'れいわ新選組', 'kana', 'れいわしんせんぐみ'),
         jsonb_build_object('name', '社会民主党', 'kana', 'しゃかいみんしゅとう'),
         jsonb_build_object('name', '参政党', 'kana', 'さんせいとう'),
         jsonb_build_object('name', '日本保守党', 'kana', 'にほんほしゅとう'),
         jsonb_build_object('name', '沖縄社会大衆党', 'kana', 'おきなわしゃかいたいしゅうとう')
       )),
       updated_at = now()
 WHERE activity = 'party_info' AND priority IS NULL AND NOT (params ? 'seed_parties');

-- ------------------------------------------------------------
-- 3. 臂 party_info：20261011230000 の版に、種子（seeds）を grp に足しただけ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_party_info()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap, COALESCE(r.params->'seed_parties', '[]'::JSONB) AS seeds
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'party_info' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  used AS (
    SELECT policy_jp.party_text_key(pe.party_text) AS k, pe.party_text, pe.id AS pe_id, pp.name, e.name AS election_name, e.election_date
      FROM policy_jp.politician_elections pe
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
     WHERE pe.review_status = 'published' AND pe.party_basis IS NULL AND pe.party_text IS NOT NULL
  ),
  grp_used AS (
    SELECT u.k, min(u.party_text) AS txt, count(*)::INTEGER AS n, min(u.election_date) AS first_date,
           (array_agg(DISTINCT u.party_text))[1:5] AS texts,
           (SELECT jsonb_agg(jsonb_build_object('politician_election_id', y.pe_id, 'name', y.name, 'election_name', y.election_name, 'election_date', y.election_date))
              FROM (SELECT z.pe_id, z.name, z.election_name, z.election_date FROM used z WHERE z.k = u.k ORDER BY z.election_date, z.pe_id LIMIT 5) y) AS examples,
           false AS seed, NULL::TEXT AS kana
      FROM used u
     WHERE u.k IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.party_aliases a WHERE a.alias_key = u.k)
     GROUP BY u.k
  ),
  -- 種子：名簿（parties の同名・party_aliases の鍵）にまだない主要政党。実際に使われている書き方と同じ鍵なら使われている方にまとめる
  grp_seed AS (
    SELECT policy_jp.party_text_key(s->>'name') AS k, s->>'name' AS txt, 0 AS n, NULL::DATE AS first_date,
           ARRAY[s->>'name']::TEXT[] AS texts, '[]'::JSONB AS examples, true AS seed, NULLIF(btrim(s->>'kana'), '') AS kana
      FROM p, jsonb_array_elements(p.seeds) s
     WHERE policy_jp.party_text_key(s->>'name') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.parties x WHERE x.name = s->>'name')
       AND NOT EXISTS (SELECT 1 FROM policy_jp.party_aliases a WHERE a.alias_key = policy_jp.party_text_key(s->>'name'))
       AND NOT EXISTS (SELECT 1 FROM grp_used g WHERE g.k = policy_jp.party_text_key(s->>'name'))
  ),
  grp AS (
    SELECT * FROM grp_used UNION ALL SELECT * FROM grp_seed
  ),
  gaps AS (
    SELECT g.* FROM grp g CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:party_info_missing:' || left(md5(g.k), 12))
     ORDER BY g.seed, g.first_date, g.n DESC, g.k
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:party_info_missing:' || left(md5(g.k), 12), 'party_info_missing',
         jsonb_build_object('kind', CASE WHEN g.seed THEN 'seed_party' ELSE 'unmatched_text' END, 'party_text', g.txt, 'alias_key', g.k, 'texts', to_jsonb(g.texts), 'count', g.n,
                            'election_date', g.first_date, 'examples', g.examples, 'known_parties', policy_jp.party_known_list(g.first_date))
           || CASE WHEN g.seed THEN jsonb_build_object('kana_hint', g.kana) ELSE '{}'::JSONB END,
         CASE WHEN g.seed THEN
           '政党の名簿（target.known_parties）に「' || g.txt || '」がまだありません。主要な政党なので、名簿に入れてください（読みの手がかり：' || COALESCE(g.kana, 'なし') || '。名前も読みも手がかりで、出典で確かめたとおりに書きます）。'
           || '総務省の政党助成法に基づく政党の届出の公表、政治団体名簿、その政党の公式サイト（党の概要・綱領のページ）で、正式名称・読み（ひらがな）・略称・結成の日が分かる出典を探します。'
           || '見つかったら contribution_type=party_info：name（正式名）・kana（ひらがな）・short_name（略称があれば）・valid_from（結成の日が公的な資料で分かれば）、'
           || 'aliases に「' || g.txt || '」と一般に使われる別の書き方（略称・通称）を入れます。出典（source_urls）はその政党が実在することを示すページです。'
           || '改名・合併を経た政党は、現在の党名を新しい政党として扱い（name を現在の党名にして predecessor_id に前身の party_id を指定）、前身が名簿にないときは前身を先に party_info で作ります。'
           || '政党かどうか・名前が確かめられないときは party_info を出さず、no_change、outcome=not_found（開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。推測で政党を作らない。'
         ELSE
           '候補者の所属として「' || g.txt || '」と記録された参選が ' || g.n || ' 件ありますが、この書き方が政党の名簿（target.known_parties）に結ばれていません。次のどれかで答えてください。'
           || '【新しい政党】名簿にない政党なら contribution_type=party_info：name（正式名）・kana（ひらがな）・short_name（略称があれば）・valid_from（結成の日が公的な資料で分かれば）、'
           || 'aliases に「' || g.txt || '」を入れます。政党の公式サイトや総務省の公表資料など、その政党が実在することを示す出典を source_urls に付けます。'
           || '【名簿にある政党の別の書き方】target.known_parties のどれかの略称・旧称・表記ゆれなら party_info に party_id と aliases（「' || g.txt || '」）を出します。'
           || '【無所属の書き方】無所属を意味するだけの書き方なら party_info に independent_aliases（「' || g.txt || '」）を出します。「諸派」や団体名のように無所属と断定できないものは入れません。'
           || '政党かどうか確かめられないときは party_info を出さず、no_change、outcome=not_found（開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。'
           || '改名は新しい政党として扱います（name を新しくして predecessor_id に前身の party_id）。推測で政党を作らない。'
         END,
         ARRAY['政党の公式サイト', '総務省 政党助成法に基づく政党の届出・政治団体名簿', '選挙管理委員会の立候補者一覧（党派欄）']::TEXT[],
         1, NULL::TEXT
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_party_info IS '政党資訊の臂（正見 party_info_missing の「書き方が名簿に当たらない」だけの日本版）：参選に書かれた政党の書き方が party_aliases に当たらない → party_info_missing 任務（書き方の鍵ごと一件）。'
  '加えて規則の params.seed_parties（主要政党の名前と読みの手がかり）のうち名簿にまだないものを target.kind=seed_party の任務として後ろに出す（政党は交件＋検証＋落庫でしか入らない）。規則は常時窓。params.cap は可派の前 N 件';
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_party_info() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM policy_jp.activity_overrides WHERE activity IN ('manual_visitor', 'manual_open') AND "force" = 'closed' AND btrim(reason) = '測試') THEN
    RAISE EXCEPTION '測試 override が残っている';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'party_info' AND priority IS NULL AND jsonb_array_length(params->'seed_parties') >= 10) THEN
    RAISE EXCEPTION 'party_info の seed_parties が入っていない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_party_info()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contribution_auto_tasks_party_info を anon が実行できる';
  END IF;
END $$;
