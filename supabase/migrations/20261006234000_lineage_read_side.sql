-- #349 第二階段 A：讀取端改讀政策脈絡，related_policies 互指退場（只加不刪；刪表與視圖欄位是第二階段 B）
--
-- 背景：政見之間的「相關」原本靠 related_policies 互指（政見頁的市政接力、/analysis/:policyId 的接力鏈）。
-- 政策脈絡（20261006034900）取代它——兩條政見是同一件事，就是歸入同一條脈絡（policies.lineage_id）。
-- 10-06 唯讀查正式庫：related_policies 0 列、從來沒有寫入者（Edge Function、SQL 函式、協議都不寫它），所以沒有互指需要搬進脈絡。
--
-- 做了什麼：
--   ① 前端、預渲染、邊緣渲染改讀 policies_with_logs.lineage（同一個 lineage id ＝同一組），不再讀視圖的 related_policy_ids
--      （這一支 migration 之外的事，列在這裡讓人知道資料庫這一側沒有要跟著動的欄位）
--   ② 寫入端守門：related_policies 上加 BEFORE INSERT OR UPDATE 觸發器，一律擋下並講清楚改走哪裡。
--      沒有人寫它，所以這是「以後也不會有人把它寫活」的保險，不是在擋既有流程；DELETE 不擋（policies 刪除要能連帶清掉）
--   ③ 視圖 related_policies_uncovered：互指的兩條政見不在同一條脈絡的那些對（正常是空的）。
--      第二階段 B 刪 related_policies 之前要先確認它是空的——有東西就代表有互指沒被脈絡涵蓋，要先讓派工臂（lineage_candidate）
--      把它們當成「可能同一件事」派出去，不是手動補資料也不是直接刪
--
-- 不動的：related_policies 表本身、視圖 policies_with_logs 的 related_policy_ids 欄位（CREATE OR REPLACE VIEW 拿不掉欄位，
-- 要 DROP＋CREATE；前端已經不讀它，第二階段 B 跟著刪表一起重建視圖）。

-- ── ② 寫入端守門 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION related_policies_retired() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'related_policies 已由政策脈絡取代（#349），不再寫入；兩條政見是同一件事，請交 lineage 把它們歸入同一條脈絡'
    USING ERRCODE = 'check_violation';
END
$$;
COMMENT ON FUNCTION related_policies_retired IS '#349 第二階段 A：related_policies 互指由政策脈絡（policies.lineage_id）取代，這張表不再接受新增或修改；第二階段 B 連表一起刪';

DROP TRIGGER IF EXISTS related_policies_no_write ON related_policies;
CREATE TRIGGER related_policies_no_write
  BEFORE INSERT OR UPDATE ON related_policies
  FOR EACH ROW EXECUTE FUNCTION related_policies_retired();

COMMENT ON TABLE related_policies IS '（#349 已由政策脈絡取代，待第二階段 B 刪除）政見互指；線上 0 列、沒有寫入者，新增與修改由觸發器 related_policies_no_write 擋下。讀取端改讀 policies.lineage_id';

-- ── ③ 互指沒被脈絡涵蓋的對（正常是空的）────────────────────────────
CREATE OR REPLACE VIEW related_policies_uncovered AS
SELECT
  rp.id,
  rp.policy_id,
  rp.related_policy_id,
  a.lineage_id AS policy_lineage_id,
  b.lineage_id AS related_lineage_id
FROM related_policies rp
JOIN policies a ON a.id = rp.policy_id
JOIN policies b ON b.id = rp.related_policy_id
WHERE a.lineage_id IS NULL OR b.lineage_id IS NULL OR a.lineage_id <> b.lineage_id;

COMMENT ON VIEW related_policies_uncovered IS '（#349 過渡）related_policies 互指裡，兩條政見不在同一條脈絡的那些對；正常是空的。第二階段 B 刪 related_policies 之前要先確認它是空的，有東西就先讓派工臂 lineage_candidate 當成「可能同一件事」派出去';
ALTER VIEW related_policies_uncovered SET (security_invoker = on);
GRANT SELECT ON related_policies_uncovered TO anon, authenticated;
