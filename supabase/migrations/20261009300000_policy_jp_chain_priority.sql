-- 日本站選舉鏈任務依「離投票日多近」派工：層（前／中／後段）＋層內順序（步驟 → 日期 → 先進先出）
-- ============================================================
--
-- 維護者要求：最近的選舉的缺口任務先派，每 10 分鐘重排（seed_auto_task_queue 的 cron 本來就是 10 分鐘一次，尾端呼叫 rebalance_queue）。
-- 以前 policy_jp 只有 priority:manual_visitor 一條優先層規則，所有自動缺口都在預設層（中段）、層內先進先出（照 queue_at＝開出來的先後），跟投票日無關。
--
-- 1. 優先層（照搬正見的機制：activity_rules 的 priority:<臂名> 規則 → activity_priority() → task_dispatches.priority，seed 每輪重算）：
--      前段＝投票日前 60 天內（含已投票但鏈還開著的 90 天）、中段＝61～180 天（預設層，不用規則）、後段＝181 天以上。
--      規則寫法照正見 priority:*（from polling -180 → 前段、from polling +181 → 後段）：
--        前段  from_kind=polling, from_offset=-60                 （今天 >= 投票日 -60）
--        後段  until_kind=polling, until_offset=-181              （今天 <= 投票日 -181）
--      中段兩個條件都不成立＝落到預設層。兩條規則的天數與 chain_date_tier() 的 60／180 是同一組數字（守門測試對過）。
--      * regional_stats_missing、local_government_missing：target 有 election_id，總表的 keyed 會問 activity_priority(臂, election_id, 職位)，
--        靠 election_milestones_all 的投票日（polling）。例外：「已通過驗證、只在等團體落庫」的選舉（chain_open_elections.basis=verified_waiting）
--        還沒有 elections 列、也就沒有 polling 里程碑，規則對它不成立；
--      * election_discovery：任期満了快到、還沒有對應選舉，target 沒有 election_id、沒有里程碑可讀。
--      這兩類「沒有 polling 里程碑」的缺口，最簡單又不失真的做法：日本版 seed 在算完規則的層之後多一段（>>> 日本版：選舉發現的層），
--      用 target.election_date（沒有就 vote_window_from）呼叫 chain_date_tier()，天數同上。不為選舉發現另外種 priority:election_discovery
--      規則（'always' 窗口的規則會被 activity_priority 取成最高層號＝後段，反而誤導）。有 polling 里程碑的缺口（已上線的選舉）照規則算，這一段不碰。
-- 2. 層內順序（日本專屬，台灣不動）：rebalance_queue 的層內排序鍵從 queue_at 改成
--      鏈的步驟（chain_step_rank：非 auto: 的手動任務 0 → election_discovery 1 → local_government_missing 2 → regional_stats_missing 3 → 其他 auto 型別 9）
--      → 日期（chain_sort_date：target.election_date，沒有就 vote_window_from、term_end，由近到遠）→ queue_at → task_id。
--      之後鏈上加步驟（候選人／人物 4、政見 5、政黨 6）只要在 chain_step_rank 多一行 WHEN；沒登記的 auto 型別一律排在已登記的後面。
--      驗證列（verify:）不在這裡（他們是另一條行列，2:1 交錯照舊）；手動任務（沒有 auto: 前綴）步驟 0 排在同層最前、層內仍照 queue_at 先進先出，
--      1970／1980 的插隊段本來就不參與重排（queue_at < 2000-01-01）。層間的 6:3:1 交錯、起點錨定、「位置沒變不重寫」（#465）一字不改。
--      這兩支（rebalance_queue、seed_auto_task_queue）因此不再逐字等於正見：日本專屬的片段用標記包起來／行尾註解「日本版」，
--      守門 policy-jp-dispatch-drift.test.ts 登記了「拿掉這些片段後，要逐字等於緊接在前的那一版」。
-- 3. 兩支鏈上的臂（contribution_auto_tasks_local_government_missing／regional_stats_missing）：cap 截斷前的 ORDER BY 拿掉「都道府県先」的鍵
--    （1,965 團體都已建好，當初為了讓都道府県比市區町村先進庫的理由不在了），cap 截斷也優先留下最近的選舉。
--    regional_stats_missing 保留 lg_present DESC（團體還沒進庫的列會被 gate 擋，排前面佔名額＝餓死，#503）。其餘本體一字不改。
--
-- 沒動的：public schema、台灣的任何函式與規則；task_priority_tiers（種子 6:3:1 不變）；manual_visitor 規則。

-- ------------------------------------------------------------
-- 1. 排序用的小函式（日本專屬）
-- ------------------------------------------------------------
-- 鏈上的步驟順位：手動任務（沒有 auto: 前綴）0、選舉發現 1、團體 2、統計 3；之後加步驟在這裡多一行 WHEN（候選人／人物 4、政見 5、政黨 6），沒登記的 auto 型別 9 排最後
CREATE OR REPLACE FUNCTION policy_jp.chain_step_rank(p_task_id TEXT, p_task_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_task_id IS NULL OR p_task_id NOT LIKE 'auto:%' THEN 0
           ELSE CASE p_task_type
                  WHEN 'election_discovery' THEN 1
                  WHEN 'local_government_missing' THEN 2
                  WHEN 'regional_stats_missing' THEN 3
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈的步驟順位（層內排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3，沒登記的 auto 型別 9。之後的步驟（候選人／人物 4、政見 5、政黨 6）在這裡多一行 WHEN';

-- 派工列的排序日期：自動缺口取 target 的 election_date，沒有就 vote_window_from（選舉發現）、term_end；手動任務、驗證列＝NULL
CREATE OR REPLACE FUNCTION policy_jp.chain_sort_date(p_task_id TEXT, p_target JSONB) RETURNS DATE
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN p_task_id LIKE 'auto:%'
              THEN COALESCE(policy_jp.date_or_null(p_target->>'election_date'), policy_jp.date_or_null(p_target->>'vote_window_from'), policy_jp.date_or_null(p_target->>'term_end'))
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_sort_date IS '派工列的排序日期（層內由近到遠）：target.election_date → vote_window_from → term_end；非 auto: 的列 NULL（排在同步驟的最後）';

-- 日期 → 層：投票日（或投票窗口起日）前 60 天內＝前段（已過的也算前段）、61～180 天＝中段、更遠＝後段；沒有日期＝預設層。
-- 與規則 priority:regional_stats_missing／priority:local_government_missing 的 -60／-181 天同一組數字
CREATE OR REPLACE FUNCTION policy_jp.chain_date_tier(p_date DATE, p_today DATE DEFAULT policy_jp.activity_today()) RETURNS SMALLINT
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_date IS NULL THEN (SELECT t.id FROM policy_jp.task_priority_tiers t WHERE t.is_default)
           WHEN p_date - p_today <= 60 THEN 1::SMALLINT
           WHEN p_date - p_today <= 180 THEN 2::SMALLINT
           ELSE 3::SMALLINT
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_date_tier IS '日期 → 優先層：<=60 天（含已過）＝1 前段、61～180 天＝2 中段、更遠＝3 後段；NULL＝預設層。選舉發現（沒有選舉列）用它定層，鏈上兩支臂靠 activity_rules 的規則（同一組天數）';

-- ------------------------------------------------------------
-- 2. 優先層規則（鏈上兩支臂；新增、冪等）
-- ------------------------------------------------------------
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:local_government_missing', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 天內（含投票後鏈還開著的期間）的選舉鏈團體任務（維護者 10-09：最近的選舉先派）'),
    ('priority:local_government_missing', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 天以上的選舉鏈團體任務；61～180 天落預設層（中段）'),
    ('priority:regional_stats_missing',   'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 天內（含投票後鏈還開著的期間）的選舉鏈統計任務（維護者 10-09：最近的選舉先派）'),
    ('priority:regional_stats_missing',   NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 天以上的選舉鏈統計任務；61～180 天落預設層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- ------------------------------------------------------------
-- 3. 鏈上兩支臂：只改 cap 截斷前的 ORDER BY（其餘本體同 20261009250400）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_local_government_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'local_government_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  -- 開著的選舉的團體與所屬的都道府県；同一個碼在好幾場選舉裡時，掛在投票日最早的那一場
  codes AS (
    SELECT DISTINCT ON (c.code) c.code, o.election_id, o.election_type, o.election_date, o.lg_code AS chain_lg_code
      FROM policy_jp.chain_open_elections o
      CROSS JOIN LATERAL (VALUES (policy_jp.lg_pref_code(o.lg_code)), (o.lg_code)) AS c(code)
     ORDER BY c.code, o.election_date, o.election_id
  ),
  gaps AS (
    SELECT c.*, (substr(c.code, 3, 3) = '000') AS is_prefecture,
           COALESCE(x.name, '（名称未確認）') AS lg_name,
           COALESCE(xp.name, (SELECT g.name FROM policy_jp.local_governments g WHERE g.lg_code = policy_jp.lg_pref_code(c.code)), '（都道府県名未確認）') AS pref_name
      FROM codes c
      CROSS JOIN p
      LEFT JOIN policy_jp.lg_code_registry x ON x.lg_code = c.code
      LEFT JOIN policy_jp.lg_code_registry xp ON xp.lg_code = policy_jp.lg_pref_code(c.code)
     WHERE p.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = c.code)
       AND NOT policy_jp.task_unavailable('auto:local_government_missing:' || c.code)
     -- 日本版 20261009300000：拿掉「都道府県先」的鍵（1,965 團體都已建好，沒有「團體還沒進庫」的餓死問題），cap 截斷也照投票日由近到遠
     ORDER BY c.election_date, c.code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:local_government_missing:' || g.code, 'local_government_missing',
         jsonb_build_object('lg_code', g.code, 'pref_name', g.pref_name, 'lg_name', g.lg_name, 'pref_code', policy_jp.lg_pref_code(g.code),
                            'is_prefecture', g.is_prefecture, 'election_id', g.election_id, 'election_type', g.election_type,
                            'election_date', g.election_date, 'chain_lg_code', g.chain_lg_code, 'chain_step', 'local_government'),
         g.lg_name || '（団体コード ' || g.code || '、' || g.pref_name || '）が地方公共団体の一覧（local_governments）にまだありません。'
           || g.election_date || ' 投票の選挙（' || g.election_id || '）の準備として、まず団体の基本情報が必要です。'
           || '総務省「全国地方公共団体コード」（https://www.soumu.go.jp/denshijiti/code.html）で団体コード・名称・読みを確かめ、contribution_type=local_government で回報してください。'
           || 'payload は lg_code・kind・pref_code・name・kana（読みは「ひらがな」に直す）。source_urls には総務省の団体コード表（またはその団体の公式サイト）を入れてください。'
           || '総務省のコード表と一致すれば、交件と同時に機械照合で確定します。'
           || CASE WHEN g.is_prefecture
                   THEN 'これは都道府県です：kind=prefecture、pref_code は lg_code と同じ値にします。'
                   ELSE 'kind は 政令指定都市＝designated_city、中核市＝core_city、その他の市＝city、東京23区＝special_ward、町＝town、村＝village から選びます'
                        || '（政令指定都市・中核市かどうかは総務省の指定都市・中核市の一覧で確かめる）。pref_code は ' || policy_jp.lg_pref_code(g.code) || '（所属の都道府県）です。'
              END
           || 'コード表で確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['総務省 全国地方公共団体コード', g.lg_name || ' 公式サイト', '総務省 指定都市・中核市の一覧']::TEXT[], 1, g.pref_name
    FROM gaps g
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'regional_stats_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  -- 開著的選舉的團體；同一個團體有好幾場時，掛在投票日最早的那一場
  els AS (
    SELECT DISTINCT ON (o.lg_code) o.lg_code, o.election_id, o.election_type, o.election_date
      FROM policy_jp.chain_open_elections o
     ORDER BY o.lg_code, o.election_date, o.election_id
  ),
  cand AS (
    SELECT e.*, (g.lg_code IS NOT NULL) AS lg_present, COALESCE(g.name, x.name, '（名称未確認）') AS name, COALESCE(g.kind, x.kind) AS kind,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), x.pref_name, '（都道府県名未確認）') AS pref_name,
           policy_jp.chain_regional_stats_missing(e.lg_code) AS missing
      FROM els e
      CROSS JOIN p
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
      LEFT JOIN policy_jp.lg_code_registry x ON x.lg_code = e.lg_code
     WHERE p.cap IS NOT NULL
  ),
  gaps AS (
    SELECT c.* FROM cand c
     WHERE c.missing IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:regional_stats_missing:' || c.lg_code)
     -- 團體已經進庫的排前面：cap 在總表的 gate 之前截斷，團體還沒進來的列（gate 會擋）排在前面會佔掉名額，
     -- 後面團體已經進庫、可以開的反而開不出來（#503 同一種餓死）。只影響排序，開不開仍由 gate 決定
     -- 日本版 20261009300000：拿掉「都道府県先」的鍵（團體都已進庫），保留 lg_present DESC（防餓死），其後照投票日由近到遠
     ORDER BY c.lg_present DESC, c.election_date, c.lg_code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:regional_stats_missing:' || g.lg_code, 'regional_stats_missing',
         jsonb_build_object('lg_code', g.lg_code, 'lg_name', g.name, 'pref_name', g.pref_name, 'kind', g.kind, 'missing', g.missing,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'chain_lg_code', g.lg_code, 'chain_step', 'regional_stats'),
         g.name || '（団体コード ' || g.lg_code || '）の統計値が足りません：'
           || (SELECT string_agg(policy_jp.regional_stat_label(m->>'stat_key') || '＝' || (m->>'min_year') || ' 年以降の最新値（stat_key=' || (m->>'stat_key') || '、unit=' || (m->>'unit') || '）', '、' ORDER BY m->>'stat_key')
                 FROM jsonb_array_elements(g.missing) m)
           || '。' || g.election_date || ' 投票の選挙（' || g.election_id || '）の地域データです。'
           || 'e-Stat「統計でみる市区町村のすがた」や総務省の市町村決算カード・国勢調査などの公的統計で確かめ、値 1 つにつき 1 件、contribution_type=regional_stat で回報してください。'
           || 'payload は lg_code・stat_key・year（西暦。歳出は会計年度の開始年）・value（数値）・unit（上の unit のとおり）・as_of（基準日 YYYY-MM-DD、任意）。'
           || 'source_urls には統計の公表元（e-Stat・総務省・その団体の公式統計ページ）を入れてください。'
           || '人口・面積・高齢化率は、令和7年国勢調査（e-Stat「都道府県・市区町村別の主な結果」、year=2025、as_of=2025-10-01）の値と一致すれば、交件と同時に機械照合で確定します。'
           || '公表されていない・確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['e-Stat 令和7年国勢調査 都道府県・市区町村別の主な結果', 'e-Stat 統計でみる市区町村のすがた', '総務省 市町村決算カード', g.name || ' 公式サイトの統計ページ']::TEXT[], 2, g.pref_name
    FROM gaps g
$$;

COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_local_government_missing IS
  '選挙鎖の第 1 歩：開いている選挙（chain_open_elections）の団体と所属の都道府県で、local_governments にないもの → local_government_missing 任務。params.cap は可派（task_unavailable でない）の前 N 件を投票日の近い順に（20261009300000：都道府県先の鍵を外した）。名称は lg_code_registry（説明文だけに使う）';
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing IS
  '選挙鎖の第 1 歩：開いている選挙の団体で、統計（chain_regional_stats_missing）が足りないもの → regional_stats_missing 任務（1 団体 1 件）。団体が local_governments にまだなくても出す（開くかどうかは総表の chain_gate：after_step=local_government、後備は投票日前 45 日）。cap は可派の前 N 件（団体が庫にあるものを先、次に投票日の近い順。20261009300000：都道府県先の鍵を外した）';

-- ------------------------------------------------------------
-- 4. 派工：層內排序（日本專屬）＋選舉發現的層。本體同前一版，只多標記的片段（守門逐字比對）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  -- >>> #490：沒有任何驗證列時，隊頭是任務列（排在 v_start＋1.5 秒），起點要退回 1.5 秒，不然每輪往後漂 1.5 秒
  IF NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01')
     AND EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01') THEN
    SELECT LEAST(MIN(queue_at) - INTERVAL '1.5 seconds', now()) INTO v_start FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  END IF;
  -- <<< #490
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM policy_jp.contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM policy_jp.task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id
     AND d.queue_at IS DISTINCT FROM v_start + v.rn * INTERVAL '1 second'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM policy_jp.task_priority_tiers x WHERE x.is_default)) AS tier,
           policy_jp.chain_step_rank(d.task_id, d.task_type) AS srank, policy_jp.chain_sort_date(d.task_id, d.target) AS sdate  -- 日本版：層內排序鍵
      FROM policy_jp.task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.srank, w.sdate NULLS LAST, w.queue_at, w.task_id) AS k FROM w  -- 日本版：同層內 步驟 → 日期 → 先進先出
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN policy_jp.task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM policy_jp.task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM policy_jp.contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先層：每個缺口現在在哪一層（每組「臂×選舉×職位」問一次）
  ALTER TABLE _gaps ADD COLUMN priority SMALLINT, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority = p.priority, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.priority, x.rule_id
            FROM (SELECT DISTINCT y.arm, policy_jp.election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL policy_jp.activity_priority(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM policy_jp.election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先層

  -- >>> 日本版：選舉發現的層
  -- 鏈上的臂裡「還沒有選舉列＝沒有 polling 里程碑」的缺口（選舉發現；等團體落庫的選舉的團體任務），規則算不出層，改用 target 的日期
  -- （election_date，沒有就 vote_window_from）定層：60 天內前段、180 天內中段、更遠後段（chain_date_tier）。有 polling 里程碑的照上面規則算的
  UPDATE _gaps g SET priority = policy_jp.chain_date_tier(policy_jp.chain_sort_date(g.task_id, g.target))
   WHERE g.arm IN ('election_discovery', 'local_government_missing', 'regional_stats_missing')
     AND NOT EXISTS (SELECT 1 FROM policy_jp.election_milestones_all m WHERE m.election_id = NULLIF(g.target->>'election_id', '') AND m.kind = 'polling');
  -- <<< 日本版：選舉發現的層

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE policy_jp.task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先層：既有的派工列跟著規則換層（排隊時間不動；下一步的 rebalance 依新的層交錯）
  UPDATE policy_jp.task_dispatches d SET priority = g.priority
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層

  -- 新缺口排進任務行列
  v_base := policy_jp.queue_slot('task');
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority)
  SELECT g.task_id, now(), COALESCE(CASE WHEN g.arm LIKE 'manual\_%' THEN policy_jp.manual_front_at(g.task_id) END,
                                    v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds'), 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), policy_jp.contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM policy_jp.contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）
  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM policy_jp.refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM policy_jp.refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM policy_jp.manual_front_pull();
  -- <<< 固定時段插隊
  PERFORM policy_jp.rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;

-- ------------------------------------------------------------
-- 5. 權限（CREATE OR REPLACE 保留原有權限；新函式預設對 PUBLIC 可執行，明寫收回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.chain_step_rank(TEXT, TEXT), policy_jp.chain_sort_date(TEXT, JSONB), policy_jp.chain_date_tier(DATE, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.chain_step_rank(TEXT, TEXT), policy_jp.chain_sort_date(TEXT, JSONB), policy_jp.chain_date_tier(DATE, DATE)
  TO service_role;

-- ------------------------------------------------------------
-- 6. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM policy_jp.activity_rules r
       WHERE r.activity IN ('priority:local_government_missing', 'priority:regional_stats_missing') AND r.priority IS NOT NULL AND r.enabled) <> 4 THEN
    RAISE EXCEPTION 'policy_jp：鏈上兩支臂的優先層規則應各有前段、後段兩條（共 4 條）';
  END IF;
  IF policy_jp.chain_step_rank('auto:election_discovery:x', 'election_discovery') >= policy_jp.chain_step_rank('auto:local_government_missing:x', 'local_government_missing')
     OR policy_jp.chain_step_rank('auto:local_government_missing:x', 'local_government_missing') >= policy_jp.chain_step_rank('auto:regional_stats_missing:x', 'regional_stats_missing') THEN
    RAISE EXCEPTION 'policy_jp：步驟順位必須是 選舉發現 < 團體 < 統計';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.chain_date_tier(date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：chain_date_tier 不該給 anon';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
