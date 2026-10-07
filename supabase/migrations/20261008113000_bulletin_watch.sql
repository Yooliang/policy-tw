-- 公報上網日自動偵測（2026-10-08）：單一真相放 election_milestones，elections.bulletin_published_on 變成衍生，pg_cron 叫 Edge Function bulletin-watch
-- ============================================================
--
-- 起因：2026 的公報上架日是 20261008000002 暫填的 2026-11-18（投票日前十日的預估）。實際上網日不一定是那天，
-- 而任務說明的公報入口（policy_elements_missing 的 hint_sources）、佇列優先層（#443 的「公報之前」）都靠它。
-- 中選會公報站 https://eebulletin.cec.gov.tw/?dir=<民國年> 在那一年的資料夾還不存在時回整站首頁（<title> 是「首頁 - …」），
-- 存在時 <title> 是「115 - …」（2026-10-08 實測：?dir=115、?dir=999 回首頁，?dir=111 回「111 - …」），所以可以每天看一次、11 月每小時看一次。
--
-- ── 單一真相的選擇：election_milestones（kind=bulletin_published、election_type 空），elections.bulletin_published_on 由觸發器衍生 ──
-- 為什麼是里程碑表、不是 elections 欄位：
--   * 里程碑表有欄位表達「這個日期有多確定」——basis（statutory 法定推算／official 官方）與 status（expected 預估／announced／done 已發生），
--     elections.bulletin_published_on 只是一個日期，分不出「預估的 11-18」與「偵測到的 11-12」；
--   * 每次異動有審計（activity_audit → edit_history：舊值、新值），裸欄位沒有；
--   * 計畫（docs/PLAN-task-activation.md 2.1）本來就把公報上架日列為里程碑 kind，規則（activity_rules）讀的是 election_milestones_all。
-- 為什麼欄位還留著：政見三要素任務（contribution_auto_tasks_policy_elements，20261008000002）讀 elections.bulletin_published_on，
--   留著欄位就不必改那支函式（行為不變），但它從此只是「快取」：
--   * AFTER INSERT/UPDATE/DELETE 觸發器 election_bulletin_sync_column：里程碑列一變，欄位跟著變（刪掉里程碑＝欄位回到 NULL）；
--   * BEFORE INSERT/UPDATE 守門 election_bulletin_column_guard：不是從上面那個觸發器來的寫入（pg_trigger_depth() < 2）一律擋掉，
--     所以不可能再有兩份真相走鐘——要改日期就改里程碑那一列。
-- 與 #443（佇列優先層，已在 main）接起來——它在 election_milestones_all 加了一段「讀 elections.bulletin_published_on」的 bulletin_published
--   （表裡有同一場選舉整場的列時以表為準）。欄位改成衍生之後，那一段永遠被表擋掉，留著只是讓視圖看起來有兩個來源，所以第 6 段把視圖
--   回到 P0 的定義（bulletin_published 只來自里程碑表）。另外預估列的 status 是 expected，而 #443 的種子規則 priority:raw:policy_missing
--   （until＝bulletin_published −1，「公報之前」非縣市長的政見任務降級）用預設 min_status＝announced——expected 的日期不會讓它開窗，
--   偵測之前降級就無聲失效。所以第 6 段把那條規則的 min_status 改成 expected（偵測到之後 status＝done，滿足任何 min_status）。
--   這兩處都不改派工的輸出：上線前後 activity_open('priority:raw:policy_missing', …) 對 2026 各職位的開關逐日相同（守門測試跑 #443 的原版視圖與種子規則對照）。
--
-- ── 寫入走流程 ──
-- 這是系統對官方網站的機械觀察（資料夾在不在），沒有判斷空間，不走貢獻投票；先例是 cec-sync 用 service role 直接寫 elections.turnout、election_districts。
-- 但比先例更窄：Edge Function 不直接寫表，只能呼叫兩支只授權 service_role 的 SECURITY DEFINER RPC——
--   bulletin_watch_targets（列出要查的選舉）、bulletin_watch_mark_published（把那一列改成實際日期、status=done、basis=official）；
--   每次異動 election_milestones 的審計觸發器記一筆 edit_history（舊值／新值），note 欄寫明是偵測到的、依據哪個網址與頁面標題、原預估是哪天。
-- 偵測到之前，暫填的 11-18 照舊當預估（status=expected、basis=statutory）；偵測到後改成偵測當天（Taipei 日界）並標 done。
-- 偵測日是「我們看到的那天」：每小時那條排程（預估上架日前後各 14 天內）誤差不超過一小時，每天那條誤差最多一天。
--
-- ── 呼叫者驗證：照 console-fetch（20261008030000）──
-- 函式會寫資料，不能公開：Vault 的 bulletin_watch_cron_secret（沒有才自己產一個隨機值）→ pg_cron 從 Vault 讀出來放 x-cron-secret →
-- 函式用 RPC bulletin_watch_cron_secret_ok（SECURITY DEFINER、只授權 service_role）請資料庫比對。函式端不持有密鑰。
--
-- 排程兩條（UTC）：bulletin-watch-daily 每天 01:23（台北 09:23）看所有還沒確定上架日的選舉；
--   bulletin-watch-hot 每小時第 41 分只看「預估上架日前後各 14 天內」的（11-18 前後＝11-04～12-02），其他時候目標清單是空的、函式空轉。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：elections.bulletin_dir／bulletin_hint／bulletin_published_on（20261008000002，2026 一列有值、2022 與 2024 的 published_on 是 NULL）、
-- election_milestones（P0，含唯一索引 election_id＋kind＋COALESCE(election_type,'')、審計與 updated_at 觸發器）、activity_today()（P0）、
-- 視圖 election_milestones_all（P0，#443 重定義過）、election_term_start／end、activity_rules（id 39 的 priority:raw:policy_missing，min_status 目前是 announced；#443 的種子）、
-- 擴充 pg_cron、pg_net、supabase_vault（schema vault）、pgcrypto（schema extensions）；cron.job 沒有 bulletin-watch-*；沒有叫 bulletin_watch_* 的函式。
-- 這支 migration 比函式早一點點上線沒有風險：函式還沒部署時，net.http_post 只會收到 404。
--
-- 守門：supabase/functions/_shared/bulletin-watch.test.ts（純函式＋fixtures＋整條流程）、bulletin-watch-db.test.ts（PGlite 跑本檔的資料庫段）。
--
-- ▼▼ SECTION: milestone ▼▼
-- ── 1. 回填：elections.bulletin_published_on 有值的列 → 預估的里程碑列（目前只有 2026 一列）──
INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT e.id, 'bulletin_published', NULL, e.bulletin_published_on, 'statutory', 'expected',
       '2026-10-08 由 elections.bulletin_published_on 回填：投票日前十日的預估；bulletin-watch 偵測到公報資料夾後改成實際日期、status=done'
  FROM elections e
 WHERE e.bulletin_published_on IS NOT NULL
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

-- ── 2. 衍生：里程碑列 → elections.bulletin_published_on ──
CREATE OR REPLACE FUNCTION election_bulletin_sync_column() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_eid INTEGER;  -- 舊的那一列若是「整場的公報上架日」，它的選舉 id
  v_new_eid INTEGER;  -- 新的那一列若是，它的選舉 id
  v_new_on DATE;
BEGIN
  -- OLD 只在 UPDATE／DELETE 存在、NEW 只在 INSERT／UPDATE 存在：分開取，不在同一個運算式裡同時碰到
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.kind = 'bulletin_published' AND OLD.election_type IS NULL THEN
    v_old_eid := OLD.election_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.kind = 'bulletin_published' AND NEW.election_type IS NULL THEN
    v_new_eid := NEW.election_id;
    v_new_on := NEW.on_date;
  END IF;
  -- 舊的那一列不再是「整場的公報上架日」了（刪除，或改了選舉／種類／職位）：那場選舉的欄位回到 NULL（NULL＝沒有這個里程碑）
  IF v_old_eid IS NOT NULL AND v_old_eid IS DISTINCT FROM v_new_eid THEN
    UPDATE elections SET bulletin_published_on = NULL WHERE id = v_old_eid AND bulletin_published_on IS NOT NULL;
  END IF;
  IF v_new_eid IS NOT NULL THEN
    UPDATE elections SET bulletin_published_on = v_new_on WHERE id = v_new_eid AND bulletin_published_on IS DISTINCT FROM v_new_on;
  END IF;
  RETURN NULL;  -- AFTER 觸發器，回傳值不看
END;
$$;
COMMENT ON FUNCTION election_bulletin_sync_column IS
  'election_milestones 的 bulletin_published（整場、election_type 空）一有異動，就把 elections.bulletin_published_on 改成同一天（刪掉＝NULL）。欄位只是這一列的衍生快取；不是這條路的寫入會被 election_bulletin_column_guard 擋。2026-10-08';

DROP TRIGGER IF EXISTS trg_election_milestones_bulletin_sync ON election_milestones;
CREATE TRIGGER trg_election_milestones_bulletin_sync AFTER INSERT OR UPDATE OR DELETE ON election_milestones
  FOR EACH ROW EXECUTE FUNCTION election_bulletin_sync_column();

-- ── 3. 守門：elections.bulletin_published_on 只能由上面的觸發器寫 ──
-- pg_trigger_depth()：使用者直接 UPDATE／INSERT elections 時守門在第 1 層；經由 election_milestones 的觸發器（第 1 層）再 UPDATE elections，守門在第 2 層。
CREATE OR REPLACE FUNCTION election_bulletin_column_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.bulletin_published_on IS NOT NULL THEN
        RAISE EXCEPTION 'elections.bulletin_published_on 是 election_milestones（kind=bulletin_published）的衍生欄位，不能直接寫；要設公報上架日請在 election_milestones 新增那一列'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.bulletin_published_on IS DISTINCT FROM OLD.bulletin_published_on THEN
      RAISE EXCEPTION 'elections.bulletin_published_on 是 election_milestones（kind=bulletin_published）的衍生欄位，不能直接改；要改公報上架日請改 election_milestones 那一列'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION election_bulletin_column_guard IS
  '擋掉對 elections.bulletin_published_on 的直接寫入（只有 election_milestones 的同步觸發器能改它），免得公報上架日又有兩份真相。2026-10-08';

DROP TRIGGER IF EXISTS trg_elections_bulletin_column_guard ON elections;
CREATE TRIGGER trg_elections_bulletin_column_guard BEFORE INSERT OR UPDATE OF bulletin_published_on ON elections
  FOR EACH ROW EXECUTE FUNCTION election_bulletin_column_guard();

COMMENT ON COLUMN elections.bulletin_published_on IS
  '公報上架日（約投票前十日）的衍生快取：真相在 election_milestones（kind=bulletin_published、election_type 空），由觸發器同步，不能直接寫（2026-10-08，bulletin-watch 偵測到資料夾後改成實際日期）。這天之前 bulletin_hint 不給。NULL＝已上架（或沒有這個里程碑）';

-- ── 4. 兩支 RPC（只授權 service_role）──
-- 要查的選舉：有公報資料夾（bulletin_dir）、整場的 bulletin_published 里程碑還不是 done。
-- p_hot＝true 時只留「預估日前後各 p_hot_days 天內」的（每小時那條排程用）。
CREATE OR REPLACE FUNCTION public.bulletin_watch_targets(p_hot BOOLEAN DEFAULT false, p_hot_days INTEGER DEFAULT 14)
RETURNS TABLE (election_id INTEGER, bulletin_dir TEXT, bulletin_hint TEXT, expected_on DATE, status TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.bulletin_dir, e.bulletin_hint, m.on_date, m.status
    FROM public.elections e
    JOIN public.election_milestones m ON m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL
   WHERE e.bulletin_dir IS NOT NULL
     AND m.status <> 'done'
     AND (NOT p_hot OR public.activity_today() BETWEEN m.on_date - p_hot_days AND m.on_date + p_hot_days)
   ORDER BY e.id
$$;
COMMENT ON FUNCTION public.bulletin_watch_targets IS
  'bulletin-watch 要查的選舉：有 bulletin_dir、整場的 bulletin_published 里程碑 status 不是 done。p_hot＝只留預估日前後 p_hot_days 天內的。只授權 service_role。2026-10-08';

-- 偵測到資料夾：把那一列改成實際日期（偵測當天，台北日界）、status=done、basis=official。已經是 done 就不動（回傳原日期）；沒有那一列回 NULL。
-- 審計：election_milestones 的 activity_audit 觸發器記舊值與新值；note 寫明依據。
CREATE OR REPLACE FUNCTION public.bulletin_watch_mark_published(p_election_id INTEGER, p_url TEXT, p_title TEXT)
RETURNS DATE
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.election_milestones%ROWTYPE;
  v_today DATE := public.activity_today();
BEGIN
  SELECT * INTO v_row FROM public.election_milestones
   WHERE election_id = p_election_id AND kind = 'bulletin_published' AND election_type IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.status = 'done' THEN
    RETURN v_row.on_date;
  END IF;
  UPDATE public.election_milestones
     SET on_date = v_today, basis = 'official', status = 'done',
         note = format('bulletin-watch 偵測到公報資料夾已上網（%s，頁面標題「%s」），日期是偵測當天；原預估 %s（%s）',
                       left(p_url, 200), left(p_title, 80), v_row.on_date, v_row.basis)
   WHERE id = v_row.id;
  RETURN v_today;
END;
$$;
COMMENT ON FUNCTION public.bulletin_watch_mark_published IS
  '公報資料夾已出現：election_milestones 的 bulletin_published 改成偵測當天、status=done、basis=official（elections.bulletin_published_on 由觸發器跟著變）。已是 done 不動。只授權 service_role。2026-10-08';

REVOKE ALL ON FUNCTION public.bulletin_watch_targets(boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulletin_watch_targets(boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.bulletin_watch_targets(boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bulletin_watch_targets(boolean, integer) TO service_role;
REVOKE ALL ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bulletin_watch_mark_published(integer, text, text) TO service_role;
-- ▲▲ SECTION: milestone ▲▲

-- ▼▼ SECTION: auth ▼▼
-- ── 5. 密鑰：沒有才產（64 字元十六進位，32 位元組隨機）；驗證用 RPC ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'bulletin_watch_cron_secret',
      'bulletin-watch 的 pg_cron 呼叫憑證（migration 自動產生；函式端用 bulletin_watch_cron_secret_ok 驗，不持有這個值）'
    );
  END IF;
END
$$;

-- 比對兩邊的 SHA-256 摘要而不是原字串；太短的輸入一律不通過；search_path 清空、全部寫全名
CREATE OR REPLACE FUNCTION public.bulletin_watch_cron_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_secret IS NOT NULL
     AND length(p_secret) >= 16
     AND EXISTS (
       SELECT 1
         FROM vault.decrypted_secrets s
        WHERE s.name = 'bulletin_watch_cron_secret'
          AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256')
     );
$$;

REVOKE ALL ON FUNCTION public.bulletin_watch_cron_secret_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulletin_watch_cron_secret_ok(text) FROM anon;
REVOKE ALL ON FUNCTION public.bulletin_watch_cron_secret_ok(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bulletin_watch_cron_secret_ok(text) TO service_role;

COMMENT ON FUNCTION public.bulletin_watch_cron_secret_ok(text) IS
  'bulletin-watch 驗 x-cron-secret 用（2026-10-08）：拿輸入值跟 Vault 的 bulletin_watch_cron_secret 比對，只授權 service_role；密鑰由 migration 產生、不離開資料庫';
-- ▲▲ SECTION: auth ▲▲

-- ▼▼ SECTION: priority ▼▼
-- ── 6. 與佇列優先層（#443）接起來 ──
-- (a) 視圖回到 P0 的定義：bulletin_published 只來自 election_milestones（origin='table'），不再有第二個來源（elections.bulletin_published_on 是衍生快取）。
--     欄位與順序跟 #443 的版本一樣，CREATE OR REPLACE 不會動到相依物件。
CREATE OR REPLACE VIEW election_milestones_all AS
  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,
         'table'::TEXT AS origin, m.id AS milestone_id
    FROM election_milestones m
  UNION ALL
  SELECT e.id, 'polling'::TEXT, NULL::TEXT, e.election_date, 'official'::TEXT,
         CASE WHEN e.election_date < activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM elections e
   WHERE e.election_date IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_start'::TEXT, t.election_type, election_term_start(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_start(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_start(e.id, t.election_type) IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_end'::TEXT, t.election_type, election_term_end(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_end(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_end(e.id, t.election_type) IS NOT NULL;
COMMENT ON VIEW election_milestones_all IS
  '規則讀的里程碑全貌：election_milestones（origin=table，含公報上架日 bulletin_published：單一真相在這張表，elections.bulletin_published_on 是它的衍生快取）＋投票日 polling（來自 elections.election_date）'
  '＋就任日／屆滿日 term_start／term_end（來自 election_term_start／end，一個職位一列；罷免沒有任期不列）。polling／term 不重複存。polling／term 的 status：日期已過＝done，否則 announced。2026-10-08';

-- (b) 「公報之前」的降級規則接受預估日期：預估列 status=expected，預設的 min_status（announced）會讓它在偵測到之前就失效
UPDATE activity_rules
   SET min_status = 'expected'
 WHERE activity = 'priority:raw:policy_missing'
   AND from_kind IS NULL
   AND until_kind = 'bulletin_published'
   AND min_status <> 'expected';
-- ▲▲ SECTION: priority ▲▲

-- ▼▼ SECTION: health ▼▼
-- ── 6b. 健康檢查：有公報資料夾的選舉缺里程碑要報出來 ──
-- bulletin_watch_targets 是 INNER JOIN 里程碑表：以後新增選舉漏建那一列，偵測和「公報之前」的降級都會悄悄失效。視圖 = P1 的定義加這一段（其餘一字不差）。
CREATE OR REPLACE VIEW activity_health AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM activity_rules r GROUP BY r.activity HAVING NOT bool_or(r.enabled)
  UNION ALL
  SELECT 'override_without_rule', o.activity, '有覆寫但這個活動沒有任何規則（拼錯活動名？）'
    FROM activity_overrides o WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = o.activity) GROUP BY o.activity
  UNION ALL
  SELECT 'window_inverted', 'rule ' || r.id || ' / election ' || f.election_id,
         '起日 ' || (f.on_date + r.from_offset) || ' 晚於迄日 ' || (u.on_date + r.until_offset) || '，這條規則在這場選舉永遠不會開'
    FROM activity_rules r
    JOIN election_milestones_all f ON f.kind = r.from_kind
    JOIN election_milestones_all u ON u.kind = r.until_kind AND u.election_id = f.election_id
         AND (u.election_type IS NOT DISTINCT FROM f.election_type OR u.election_type IS NULL OR f.election_type IS NULL)
   WHERE r.enabled AND f.on_date + r.from_offset > u.on_date + r.until_offset
  UNION ALL
  SELECT 'milestone_scope_drift', s.election_id || ' / ' || s.election_type,
         'roster_check_scope 的登記截止／名單公告日與 election_milestones 對不上（兩份真相）：改了舊欄位沒同步到里程碑，或相反'
    FROM roster_check_scope s
   WHERE NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'registration_close'
                        AND m.election_type = s.election_type AND m.on_date = s.registration_closed_on)
      OR NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'list_published'
                        AND m.election_type = s.election_type AND m.on_date = s.list_announced_on)
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'bulletin_milestone_missing', e.id::TEXT,
         '選舉有公報資料夾（bulletin_dir）、還沒投票，卻沒有整場的 bulletin_published 里程碑：bulletin-watch 不會偵測它（bulletin_watch_targets 只看有里程碑列的選舉），「公報之前」的降級規則也開不起來。新增選舉時要在 election_milestones 補那一列（預估用 expected／statutory；公報已上架就補 done／official）'
    FROM elections e
   WHERE e.bulletin_dir IS NOT NULL
     AND e.election_date >= activity_today()
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）';-- ▲▲ SECTION: health ▲▲

-- ── 7. 排程 ──
SELECT cron.unschedule('bulletin-watch-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'bulletin-watch-daily');
SELECT cron.unschedule('bulletin-watch-hot') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'bulletin-watch-hot');

SELECT cron.schedule('bulletin-watch-daily', '23 1 * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/bulletin-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret' LIMIT 1), '')
    ),
    body := '{"mode":"all"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

SELECT cron.schedule('bulletin-watch-hot', '41 * * * *', $$
  SELECT net.http_post(
    url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/bulletin-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret' LIMIT 1), '')
    ),
    body := '{"mode":"hot"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

NOTIFY pgrst, 'reload schema';
