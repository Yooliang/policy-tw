-- 名單時程的日期搬成里程碑：candidacy_list_published() 改讀里程碑，roster_check_scope 的五個日期欄由里程碑衍生（2026-10-08，派工時間窗 P2，docs/PLAN-task-activation.md）
-- ============================================================
--
-- 起因：P0 把 roster_check_scope 的登記截止日、名單公告日「回填」成里程碑（registration_close、list_published），之後兩邊各有一份、靠健康檢查 milestone_scope_drift 對帳。
-- 另外三個日期（資格審查完成日 qualification_review_by、抽號次日 ballot_draw_on、直轄市長名單公告日 municipal_mayor_list_on）20261008000001 才加在這張表上，一直沒搬。
-- 派工臂（7 支：6 支加 #452 的 ballot_numbers）判斷「名單公告了沒」呼叫 candidacy_list_published()，它讀的是 roster_check_scope.list_announced_on——不是規則讀的那份里程碑。
-- 日期有兩份真相就會走鐘（改了一份、忘了另一份：規則說名單 11-12 公告，任務說明卻還說 11-17）。
--
-- ── 單一真相的選擇：election_milestones（里程碑表）為真，roster_check_scope 的五個日期欄由觸發器衍生（做法照 #446 公報上網日）──
-- 為什麼是里程碑表、不是 roster_check_scope 欄位：
--   * 里程碑有欄位表達「這個日期有多確定」——basis（statutory 法定推算／official 官方公告／agent 代理交件／override 例外覆寫）與 status（expected 預估／announced 已公告／done 已發生）；
--     scope 的日期欄只是一個日期，分不出「預估」與「官方已公告」。日期都有「預估→公告→改期」的生命週期，這正是里程碑表要記的；
--   * 每次異動有審計（activity_audit → edit_history：舊值、新值），裸欄位沒有；
--   * 規則（activity_rules）讀的是 election_milestones_all，計畫本來就把這些日期列為里程碑 kind（2.1）；日本站（policy-jp）沒有 roster_check_scope 這張表，只能共用里程碑；
--   * 沒有兩個方向都能寫的雙向同步（那會有誰贏的問題）：只有一個方向，里程碑 → 欄位。
-- 為什麼欄位還留著：派工臂 raw（roster_check、candidate_status_stale）、not_running、roster_villages、roster_scope_covers、Edge Function（elections.ts、contribute-handler）
--   都讀這幾個欄位，留著就一個都不用改（這支 PR 不碰任何臂），但它們從此只是「快取」：
--   * AFTER 觸發器 roster_scope_sync_from_milestones（里程碑表）：里程碑列一變，同一場選舉的清查範圍列跟著重算（空更新一下，讓下面那個 BEFORE 觸發器算）；
--   * BEFORE 觸發器 roster_scope_derive_dates（清查範圍表）：這五欄永遠是從里程碑算出來的值——直接寫成別的值會被擋（pg_trigger_depth() < 2 才檢查，同 #446）；
--     新增一列清查範圍時這五欄可以不給（給了而且跟里程碑一致也行），會從里程碑填；登記截止、名單公告兩個 NOT NULL 欄找不到里程碑就整列失敗，
--     所以下一屆選舉的順序是：先建里程碑、再建清查範圍（以前 NOT NULL「強迫填日期」的用意不變，只是改成強迫先有里程碑）。
--   * 刪掉清查範圍還在用的登記截止／名單公告里程碑會被擋（兩個 NOT NULL 欄沒有日期）；資格審查／抽號次／直轄市長名單三個欄位可以是 NULL（＝不提那一項），刪里程碑欄位就回到 NULL。
--   * 健康檢查 milestone_scope_drift 保留並擴到五個欄位：觸發器被停掉或繞過（例如 session_replication_role = replica）時，會在 activity_health 看到。
--
-- ── 三個新日期怎麼放 ──
--   * 資格審查完成日 → 新 kind「qualification_review」（election_type 填職位，同 registration_close／list_published 一列一職位）。
--   * 抽號次日 → 既有 kind「draw」（計畫 2.1 本來就有）。
--   * 直轄市長名單公告日 → kind「list_published」、election_type＝'直轄市長'（整場選舉共用一列）。
--       '直轄市長' 不是我們參選紀錄的 election_type（中選會的直轄市長併在「縣市長」，見 cec-sync.ts），它是里程碑專用的細分職位：
--       直轄市長的名單 11-12 公告，比縣市長（含直轄市議員）的 11-17 早五天，而 (選舉, kind, election_type) 唯一，
--       縣市長那一格已經是 11-17，所以直轄市長要另一個職位值。因為 activity_open() 與 candidacy_list_published() 找里程碑都是「職位相同、或整場（空）」，
--       '直轄市長' 的列不會被任何縣市長的查詢誤取。要放行這個值，election_milestones.election_type 的 CHECK 多一個 '直轄市長'
--       （activity_rules／activity_overrides 的職位 CHECK 不動：規則範圍用的是參選紀錄的職位）。
--   * 要讓規則能用新 kind：election_milestones.kind、activity_rules.from_kind／until_kind 的 CHECK 都加 'qualification_review'。
--
-- ── candidacy_list_published(election_id, election_type, p_on) ──
--   原本：投票日已到（elections.election_date <= p_on），或 roster_check_scope 有那個 (選舉, 職位) 的 list_announced_on 而且 <= p_on。
--   現在：投票日已到，或 election_milestones_all 的 list_published 里程碑 <= p_on。查找順序同 activity_open()：「職位相同」那一列優先，沒有才用「整場選舉（election_type 空）」那一列。
--   優先「職位相同」是為了讓例外更正（某職位的名單公告日與整場不同）生效；原本只認職位相同那一列，現在整場的列也算——線上沒有整場的 list_published 列，所以今天結果相同；
--   以後代理交「整場名單公告日」不會被默默忽略。回傳永遠是 true／false（不是 NULL）。簽名、回傳型別、語言、穩定度不動，ACL 不動（CREATE OR REPLACE）。
--   呼叫它的 7 支臂（party_gap、party_roster、raw、region_gap、township_gap、withdrawn_filing，以及 #452 的 ballot_numbers）仍然傳 CURRENT_DATE（資料庫 UTC 日期）；
--   換成 activity_today()（台北日界）要改這 7 支臂，留給各臂自己的 P2／P3 PR（差別只在台北 00:00～08:00 這 8 小時，且只有名單公告日當天）。
--
-- ── 今天輸出逐件不變 ──
--   * 新增的里程碑列全是從 scope 欄位回填的，值相同；scope 欄位的值一個都沒變（migration 裡有檢查：回填完每個欄位都等於衍生值，否則整支失敗）。
--   * roster_schedule_text()、raw 的 roster_check、candidate_status_stale 讀 scope 欄位，值相同，文字相同。
--   * candidacy_list_published 在所有 (選舉, 職位, 日期) 上與舊版結果相同（正式庫唯讀快照逐格比對，見 scripts/roster-milestones-parity.ts）。
--
-- 守門：supabase/functions/_shared/roster-milestones.test.ts（文字層：candidacy_list_published＝前一版加一處替換、這支只動這幾樣、活動健康視圖＝前一版只換一段；
--   PGlite：回填、衍生、直接寫入被擋、新增清查範圍、刪里程碑被擋、假時鐘 09-04／10-16／10-23／11-12／11-17、與舊函式逐格相同；每條守門做還原驗證）；
--   scripts/roster-milestones-parity.ts：正式庫唯讀快照（不進 CI，PR 說明附結果）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：election_milestones（P0，含 election_milestones_kind_check／election_type_check 兩個自動命名的 CHECK）、election_milestones_all、
-- activity_today()、activity_audit 觸發器、activity_rules（activity_rules_from_kind_check／until_kind_check）、roster_check_scope（七列，五個日期欄、無觸發器）、
-- elections、視圖 activity_health（20261008150000 補號次 #452 的版本)、candidacy_list_published（20261006034500，與正式庫 pg_get_functiondef 一字不差）。
-- 沒有 Edge Function 呼叫 candidacy_list_published，也沒有視圖依賴它（唯讀查 pg_proc／pg_class）。

-- ------------------------------------------------------------
-- 1. 放行新的 kind 與職位值
-- ------------------------------------------------------------
ALTER TABLE election_milestones DROP CONSTRAINT IF EXISTS election_milestones_kind_check;
ALTER TABLE election_milestones ADD CONSTRAINT election_milestones_kind_check
  CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',
                  'bulletin_published', 'result_announced', 'certified'));
ALTER TABLE election_milestones DROP CONSTRAINT IF EXISTS election_milestones_election_type_check;
ALTER TABLE election_milestones ADD CONSTRAINT election_milestones_election_type_check
  CHECK (election_type IS NULL OR election_type IN ('總統副總統', '立法委員', '縣市長', '直轄市長', '縣市議員', '鄉鎮市長',
                                                    '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長'));
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_from_kind_check;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_from_kind_check
  CHECK (from_kind IS NULL OR from_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',
                                            'bulletin_published', 'polling', 'result_announced', 'certified', 'term_start', 'term_end'));
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_until_kind_check;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_until_kind_check
  CHECK (until_kind IS NULL OR until_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',
                                              'bulletin_published', 'polling', 'result_announced', 'certified', 'term_start', 'term_end'));

COMMENT ON COLUMN election_milestones.election_type IS
  '空＝整場選舉；填職位＝只對該職位有效。除了參選紀錄的九種職位，多一個里程碑專用的 ''直轄市長''（直轄市長的名單 11-12 公告、比縣市長 11-17 早；我們的參選紀錄把直轄市長併在縣市長，所以這個值只用在 list_published，由 roster_check_scope.municipal_mayor_list_on 衍生）';

-- ------------------------------------------------------------
-- 2. 找一場選舉的某個日期里程碑：職位相同的優先，沒有才取整場（election_type 空）
-- ------------------------------------------------------------
-- p_whole=false：只認職位相同那一列（直轄市長名單用，不退回整場的名單公告日）
CREATE OR REPLACE FUNCTION roster_scope_milestone_date(p_election_id INTEGER, p_kind TEXT, p_election_type TEXT, p_whole BOOLEAN DEFAULT true)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT m.on_date
    FROM election_milestones m
   WHERE m.election_id = p_election_id AND m.kind = p_kind
     AND (m.election_type = p_election_type OR (p_whole AND m.election_type IS NULL))
   ORDER BY (m.election_type IS NULL)
   LIMIT 1
$$;
COMMENT ON FUNCTION roster_scope_milestone_date IS
  'roster_check_scope 的日期欄從里程碑衍生時用的查找：同一場選舉、同一個 kind，職位相同那一列優先，沒有才取整場（election_type 空）；p_whole=false 只認職位相同。與 activity_open() 的查找順序一致。2026-10-08';

-- ------------------------------------------------------------
-- 3. 回填：scope 欄位 → 里程碑（P0 已回填登記截止、名單公告；這裡補沒有的，再加另外三個）
-- ------------------------------------------------------------
INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'registration_close', s.election_type, s.registration_closed_on, 'official',
       CASE WHEN s.registration_closed_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.registration_closed_on 回填'
  FROM roster_check_scope s
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'list_published', s.election_type, s.list_announced_on, 'official',
       CASE WHEN s.list_announced_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.list_announced_on 回填'
  FROM roster_check_scope s
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'draw', s.election_type, s.ballot_draw_on, 'official',
       CASE WHEN s.ballot_draw_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.ballot_draw_on 回填'
  FROM roster_check_scope s
 WHERE s.ballot_draw_on IS NOT NULL
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'qualification_review', s.election_type, s.qualification_review_by, 'official',
       CASE WHEN s.qualification_review_by <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.qualification_review_by 回填'
  FROM roster_check_scope s
 WHERE s.qualification_review_by IS NOT NULL
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

-- 直轄市長名單公告日是「整場選舉」的值，scope 卻是每個職位一列各存一份：同一場選舉的幾列必須一致（都有值而且相同，或都沒有），否則無法搬成一列里程碑
DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(x.election_id::TEXT, '、') INTO v_bad
    FROM (SELECT s.election_id FROM roster_check_scope s GROUP BY s.election_id
           HAVING count(DISTINCT s.municipal_mayor_list_on) > 1
               OR (count(*) FILTER (WHERE s.municipal_mayor_list_on IS NULL) > 0 AND count(s.municipal_mayor_list_on) > 0)) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '直轄市長名單公告日（municipal_mayor_list_on）在選舉 % 的幾列清查範圍不一致，無法搬成一列整場里程碑：先把它們改成一致', v_bad;
  END IF;
END
$$;
INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT DISTINCT s.election_id, 'list_published', '直轄市長', s.municipal_mayor_list_on, 'official',
       CASE WHEN s.municipal_mayor_list_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.municipal_mayor_list_on 回填'
  FROM roster_check_scope s
 WHERE s.municipal_mayor_list_on IS NOT NULL
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

-- 回填完，每個清查範圍列的五個日期都必須等於從里程碑算出來的值。不一致（例如 P0 回填之後有人只改了其中一邊）就整支失敗，不替人決定誰對
DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(s.election_id || '/' || s.election_type, '、') INTO v_bad
    FROM roster_check_scope s
   WHERE s.registration_closed_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'registration_close', s.election_type)
      OR s.list_announced_on      IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', s.election_type)
      OR s.qualification_review_by IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'qualification_review', s.election_type)
      OR s.ballot_draw_on         IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'draw', s.election_type)
      OR s.municipal_mayor_list_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', '直轄市長', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'roster_check_scope 與 election_milestones 的日期對不上（%）：先對帳（哪一邊對）再上這支 migration', v_bad;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 4. 衍生：里程碑 → roster_check_scope 的五個日期欄
-- ------------------------------------------------------------
-- 4a. BEFORE：清查範圍列的五個日期欄永遠是從里程碑算出來的值
CREATE OR REPLACE FUNCTION roster_scope_derive_dates() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_reg    DATE := roster_scope_milestone_date(NEW.election_id, 'registration_close', NEW.election_type);
  v_list   DATE := roster_scope_milestone_date(NEW.election_id, 'list_published', NEW.election_type);
  v_review DATE := roster_scope_milestone_date(NEW.election_id, 'qualification_review', NEW.election_type);
  v_draw   DATE := roster_scope_milestone_date(NEW.election_id, 'draw', NEW.election_type);
  v_mayor  DATE := roster_scope_milestone_date(NEW.election_id, 'list_published', '直轄市長', false);
BEGIN
  -- 里程碑同步觸發器（第 1 層）再 UPDATE 這張表時，這裡在第 2 層：那是「衍生」，不檢查。第 1 層＝有人直接寫：寫成跟里程碑不一樣的值就擋掉
  IF pg_trigger_depth() < 2 THEN
    IF (TG_OP = 'INSERT' AND ((NEW.registration_closed_on IS NOT NULL AND NEW.registration_closed_on IS DISTINCT FROM v_reg)
                              OR (NEW.list_announced_on IS NOT NULL AND NEW.list_announced_on IS DISTINCT FROM v_list)
                              OR (NEW.qualification_review_by IS NOT NULL AND NEW.qualification_review_by IS DISTINCT FROM v_review)
                              OR (NEW.ballot_draw_on IS NOT NULL AND NEW.ballot_draw_on IS DISTINCT FROM v_draw)
                              OR (NEW.municipal_mayor_list_on IS NOT NULL AND NEW.municipal_mayor_list_on IS DISTINCT FROM v_mayor)))
       OR (TG_OP = 'UPDATE' AND ((NEW.registration_closed_on IS DISTINCT FROM OLD.registration_closed_on AND NEW.registration_closed_on IS DISTINCT FROM v_reg)
                                 OR (NEW.list_announced_on IS DISTINCT FROM OLD.list_announced_on AND NEW.list_announced_on IS DISTINCT FROM v_list)
                                 OR (NEW.qualification_review_by IS DISTINCT FROM OLD.qualification_review_by AND NEW.qualification_review_by IS DISTINCT FROM v_review)
                                 OR (NEW.ballot_draw_on IS DISTINCT FROM OLD.ballot_draw_on AND NEW.ballot_draw_on IS DISTINCT FROM v_draw)
                                 OR (NEW.municipal_mayor_list_on IS DISTINCT FROM OLD.municipal_mayor_list_on AND NEW.municipal_mayor_list_on IS DISTINCT FROM v_mayor)))
    THEN
      RAISE EXCEPTION 'roster_check_scope 的登記截止／名單公告／資格審查／抽號次／直轄市長名單公告五個日期是 election_milestones 的衍生欄位，不能直接寫；要改日期請改 election_milestones 那一列（kind＝registration_close／list_published／qualification_review／draw，直轄市長名單是 list_published 且 election_type＝直轄市長）'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 兩個 NOT NULL 欄找不到里程碑：給清楚的訊息（不然只看到 not-null violation）
  IF v_reg IS NULL THEN
    RAISE EXCEPTION 'roster_check_scope（% / %）沒有登記截止日里程碑（新增清查範圍前沒先建里程碑，或刪掉了它還在用的里程碑）：先在 election_milestones 建 kind＝registration_close、election_type＝% 的那一列（或整場、election_type 空）', NEW.election_id, NEW.election_type, NEW.election_type
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF v_list IS NULL THEN
    RAISE EXCEPTION 'roster_check_scope（% / %）沒有名單公告日里程碑（新增清查範圍前沒先建里程碑，或刪掉了它還在用的里程碑）：先在 election_milestones 建 kind＝list_published、election_type＝% 的那一列（或整場、election_type 空）', NEW.election_id, NEW.election_type, NEW.election_type
      USING ERRCODE = 'not_null_violation';
  END IF;
  NEW.registration_closed_on := v_reg;
  NEW.list_announced_on := v_list;
  NEW.qualification_review_by := v_review;
  NEW.ballot_draw_on := v_draw;
  NEW.municipal_mayor_list_on := v_mayor;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION roster_scope_derive_dates IS
  'roster_check_scope 的五個日期欄（registration_closed_on、list_announced_on、qualification_review_by、ballot_draw_on、municipal_mayor_list_on）永遠等於 election_milestones 算出來的值；直接寫成別的值會被擋（pg_trigger_depth() < 2）。2026-10-08';

DROP TRIGGER IF EXISTS trg_roster_scope_derive_dates ON roster_check_scope;
CREATE TRIGGER trg_roster_scope_derive_dates BEFORE INSERT OR UPDATE ON roster_check_scope
  FOR EACH ROW EXECUTE FUNCTION roster_scope_derive_dates();

-- 4b. AFTER：里程碑一變，同一場選舉的清查範圍列重算（空更新，讓上面的 BEFORE 觸發器算；此時在第 2 層）
CREATE OR REPLACE FUNCTION roster_scope_sync_from_milestones() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old INTEGER;  -- 舊的那一列若是名單時程的里程碑，它的選舉 id
  v_new INTEGER;  -- 新的那一列若是，它的選舉 id
BEGIN
  -- OLD 只在 UPDATE／DELETE 存在、NEW 只在 INSERT／UPDATE 存在：分開取
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.kind IN ('registration_close', 'list_published', 'draw', 'qualification_review') THEN
    v_old := OLD.election_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.kind IN ('registration_close', 'list_published', 'draw', 'qualification_review') THEN
    v_new := NEW.election_id;
  END IF;
  -- 只改了備註／確定程度／時間戳不用重算
  IF TG_OP = 'UPDATE' AND OLD.election_id = NEW.election_id AND OLD.kind = NEW.kind AND OLD.election_type IS NOT DISTINCT FROM NEW.election_type AND OLD.on_date = NEW.on_date THEN
    RETURN NULL;
  END IF;
  IF v_old IS NOT NULL THEN
    UPDATE roster_check_scope SET recheck_days = recheck_days WHERE election_id = v_old;
  END IF;
  IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN
    UPDATE roster_check_scope SET recheck_days = recheck_days WHERE election_id = v_new;
  END IF;
  RETURN NULL;  -- AFTER 觸發器，回傳值不看
END;
$$;
COMMENT ON FUNCTION roster_scope_sync_from_milestones IS
  'election_milestones 的名單時程里程碑（registration_close、list_published、draw、qualification_review）一有異動，就讓同一場選舉的 roster_check_scope 列重算五個日期欄（由 roster_scope_derive_dates 算）。刪掉清查範圍還在用的登記截止／名單公告里程碑會被擋。2026-10-08';

DROP TRIGGER IF EXISTS trg_election_milestones_roster_scope_sync ON election_milestones;
CREATE TRIGGER trg_election_milestones_roster_scope_sync AFTER INSERT OR UPDATE OR DELETE ON election_milestones
  FOR EACH ROW EXECUTE FUNCTION roster_scope_sync_from_milestones();

COMMENT ON COLUMN roster_check_scope.registration_closed_on IS '候選人登記截止日（衍生快取：真相在 election_milestones 的 registration_close，不能直接寫）。過了這天，rumored／likely 的參選紀錄就該被確認成 registered 或 not_running';
COMMENT ON COLUMN roster_check_scope.list_announced_on IS '官方審定候選人名單的公告日（衍生快取：真相在 election_milestones 的 list_published，不能直接寫）。在這天之前任務要代理補 registered，之後補 confirmed＋號次';
COMMENT ON COLUMN roster_check_scope.qualification_review_by IS '候選人資格審查完成日（含當天；衍生快取：真相在 election_milestones 的 qualification_review，不能直接寫）。名單清查任務的登記階段說明用；過了這天說明就不再提。NULL＝不提';
COMMENT ON COLUMN roster_check_scope.ballot_draw_on IS '候選人號次抽籤日（含當天；衍生快取：真相在 election_milestones 的 draw，不能直接寫）。名單清查任務的登記階段說明用；過了這天說明就不再提、也不再說「還沒有號次可填」。NULL＝不提日期、仍說還沒有號次';
COMMENT ON COLUMN roster_check_scope.municipal_mayor_list_on IS '直轄市長候選人名單公告日（含當天；衍生快取：真相在 election_milestones 的 list_published、election_type＝直轄市長，整場共用一列，不能直接寫；比全部名單公告日 list_announced_on 早）。名單清查任務的登記階段說明用；過了這天說明就不再提。NULL＝不提';
COMMENT ON TABLE roster_check_scope IS '名單清查的範圍與重查週期；加一列就多一種選舉類型進任務池。登記截止、名單公告、資格審查、抽號次、直轄市長名單公告五個日期是 election_milestones 的衍生快取（2026-10-08）：新增一列之前先建好里程碑';

-- ------------------------------------------------------------
-- 5. candidacy_list_published：改讀 election_milestones_all 的 list_published
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION candidacy_list_published(p_election_id INTEGER, p_election_type TEXT, p_on DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM elections e WHERE e.id = p_election_id AND e.election_date <= p_on)
      OR COALESCE((SELECT m.on_date <= p_on
                     FROM election_milestones_all m
                    WHERE m.election_id = p_election_id AND m.kind = 'list_published'
                      AND (m.election_type = p_election_type OR m.election_type IS NULL)
                    ORDER BY (m.election_type IS NULL)
                    LIMIT 1), false)
$$;
COMMENT ON FUNCTION candidacy_list_published IS '這一屆這種選舉的正式候選人名單在 p_on 那天公告了沒（已投票也算）；決定舊值 confirmed 對到 filed 還是 declared（#345）｜2026-10-08（派工時間窗 P2）：名單公告日讀 election_milestones_all 的 list_published（職位相同的優先，沒有才取整場），不再讀 roster_check_scope.list_announced_on';

-- ------------------------------------------------------------
-- 6. 健康檢查：milestone_scope_drift 擴到五個日期欄（視圖＝20261008150000（補號次 #452）的版本，只換這一段）
-- ------------------------------------------------------------
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
         'roster_check_scope 的五個日期欄（登記截止、名單公告、資格審查、抽號次、直轄市長名單公告）與 election_milestones 對不上：它們該由里程碑衍生（觸發器 roster_scope_derive_dates），對不上表示觸發器被停掉或繞過了'
    FROM roster_check_scope s
   WHERE s.registration_closed_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'registration_close', s.election_type)
      OR s.list_announced_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', s.election_type)
      OR s.qualification_review_by IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'qualification_review', s.election_type)
      OR s.ballot_draw_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'draw', s.election_type)
      OR s.municipal_mayor_list_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', '直轄市長', false)
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
  SELECT 'ballot_number_anomaly', a.election_id || ' / ' || a.election_type,
         count(*) || ' 個號次單位的號次有重複或跳號（重複 ' || count(*) FILTER (WHERE a.kind = 'duplicate') || '、跳號 ' || count(*) FILTER (WHERE a.kind = 'gap') || '）：看視圖 ballot_number_anomalies；名單缺人時也會這樣，派工臂 cand_no_recheck 會請代理對公告重查'
    FROM ballot_number_anomalies a JOIN elections e ON e.id = a.election_id
   WHERE e.election_date >= activity_today()
   GROUP BY a.election_id, a.election_type
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 的五個日期與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）';

NOTIFY pgrst, 'reload schema';

