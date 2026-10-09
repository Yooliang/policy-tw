-- 日本站：自治體清單由總務省表一次建入 policy_jp.local_governments（policy-jp #69）
-- ============================================================
--
-- 前提：20261009250000／250100（lg_code_registry 與總務省資料）、20261009000000（local_governments、source_refs）、
--       20261009130000（edit_history）、20261009210000（local_government_slug）。
--
-- 為什麼（維護者 10-09 定案）：自治體名單是日本站一切資料的外鍵根，逐筆等代理交件太慢（約 2,000 筆）。
--   總務省「全国地方公共団体コード」（R6.1.1）已在 lg_code_registry（1,965 列：47 都道府県＋市區町村＋政令市行政区），
--   改成一次從這張表建進 local_governments；**之後地區的缺口只補異動**（表基準日之後新設、合併、改名的團體，
--   走原本的 local_government 交件與 lg_registry_decide 機器核對，這支不再管）。
--   這是 10-08「自治體只從代理交件來」的例外（只限這一次建入）；lg_registry_* 兩支函式本身仍不從參考表建列。
--
-- 做法：
--   * 只補還沒有的團體（NOT EXISTS）：已交件落庫的列（52 列）一律不動，重跑也不會重複寫（冪等）。
--   * 欄位照 apply_local_government 的寫法：lg_code、kind、pref_code、name、kana 取自 registry，slug 用 local_government_slug()；
--     local_governments 沒有 review_status 欄（公開讀不分審核狀態），assembly_seats／valid_* 留空（不編造）。
--   * 出處照 apply 的 source_write 結果（source_refs、origin 區分來源）：主要出處＝registry.source_id（總務省團體碼表，
--     頁面 https://www.soumu.go.jp/denshijiti/code.html 底下的檔案）；中核市另掛 kind_source_id（中核市一覧）當佐證。
--     registry 已經登記好 sources，所以直接用它的 source_id，不再用網址重新解析一次。
--   * edit_history 每列一筆（field='*'、old_value NULL、new_value＝to_jsonb(整列)、agent_name='soumu-seed'），
--     跟落庫一樣；沒有 contribution_id（不是交件來的）。
--   * 一個語句寫完三張表（資料修改 CTE），要嘛全部成功、要嘛全部不寫；都道府県與市區町村在同一語句內插入，
--     自我參照外鍵在語句結束時才檢查，不用排順序。
--   * 不 DROP、不改既有列、不碰 public／ditrust。

WITH ins AS (
  INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug)
  SELECT r.lg_code, r.kind, r.pref_code, r.name, r.kana, policy_jp.local_government_slug(r.lg_code)
    FROM policy_jp.lg_code_registry r
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = r.lg_code)
  RETURNING *
), refs AS (
  INSERT INTO policy_jp.source_refs (source_id, target_table, target_id, role, origin)
  SELECT x.source_id, 'local_governments', x.lg_code, x.role, 'soumu-seed'
    FROM (
      SELECT r.source_id, i.lg_code, 'primary' AS role
        FROM ins i JOIN policy_jp.lg_code_registry r ON r.lg_code = i.lg_code
      UNION ALL
      SELECT r.kind_source_id, i.lg_code, 'supporting'
        FROM ins i JOIN policy_jp.lg_code_registry r ON r.lg_code = i.lg_code
       WHERE r.kind_source_id IS NOT NULL
    ) x
  ON CONFLICT (target_table, target_id, source_id) DO NOTHING
  RETURNING 1
)
INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
SELECT 'local_governments', i.lg_code, '*', NULL, to_jsonb(i), NULL, 'soumu-seed'
  FROM ins i;

-- ------------------------------------------------------------
-- 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE
  v_registry INTEGER := (SELECT count(*) FROM policy_jp.lg_code_registry);
  v_total INTEGER := (SELECT count(*) FROM policy_jp.local_governments);
  v_pref INTEGER := (SELECT count(*) FROM policy_jp.local_governments WHERE kind = 'prefecture');
  v_missing INTEGER := (SELECT count(*) FROM policy_jp.lg_code_registry r
                         WHERE NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = r.lg_code));
  -- 只查這支建的列（edit_history 的 soumu-seed）：之前交件落庫的列，出處是當時的交件記的
  v_norefs INTEGER := (SELECT count(*) FROM policy_jp.local_governments g
                        WHERE EXISTS (SELECT 1 FROM policy_jp.edit_history h
                                       WHERE h.table_name = 'local_governments' AND h.record_id = g.lg_code AND h.agent_name = 'soumu-seed')
                          AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs s
                                           WHERE s.target_table = 'local_governments' AND s.target_id = g.lg_code AND s.role = 'primary'));
BEGIN
  ASSERT v_registry >= 1965, format('lg_code_registry 只有 %s 列，應有 1965 列', v_registry);
  ASSERT v_total >= v_registry, format('local_governments 只有 %s 列，比團體碼表的 %s 列少', v_total, v_registry);
  ASSERT v_missing = 0, format('團體碼表有 %s 個團體沒進 local_governments', v_missing);
  ASSERT v_pref = 47, format('都道府県應有 47 個，實際 %s 個', v_pref);
  ASSERT v_norefs = 0, format('有 %s 個團體沒有主要出處', v_norefs);
END
$$;
