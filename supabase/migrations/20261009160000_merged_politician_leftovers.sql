-- 已合併人物身上殘留的子列清掉（維護者裁決，#466 A）
--
-- 陳瑩 54472fee 併進 8aa6ee40 之後，舊 id 底下又長出一筆參選紀錄與三筆重複身份鍵；另有 4 位已合併人物留著過期的政見重複審查結論。
-- 處理比照 merge_politician（20260923000009）：撞鍵的子列「整列記一筆 edit_history（field='*', old_value=整列, new_value=NULL）再刪」，
-- /apply 的 revert 能依整列倒回；agent_name 記 migration-466。
--
--   politician_elections 36446（54472fee, 2026）：保留者 8aa6ee40 已有同屆的 35367（撞 (politician_id, election_id)）
--   politician_keys 77586、77587、77588：保留者各已有同 (key_type, key_value) 的 34426、34424、34427
--   policy_dupe_reviews 4 筆（a356d6d1、732cbaa2、54472fee、90378e6f）：PK 是 politician_id，內容是舊政見集合的指紋，人物已併走所以過期
--
-- 防呆（用完整 id；列已不在＝重跑，安靜略過；列在但條件不符一律 RAISE、整支不動）：
--   參選紀錄／身份鍵：那一列要掛在預期的已合併人物上、該人物 merged_into 指向預期保留者、保留者確實有同鍵的列
--   重複審查：那位人物要真的已合併（merged_into 不為空）

DO $$
DECLARE
  v_old CONSTANT UUID := '54472fee-1dc4-475c-a104-64529aa0797a';
  v_keep CONSTANT UUID := '8aa6ee40-231a-447a-a967-99bcf8b35d3f';
  v_agent CONSTANT TEXT := 'migration-466';
  v_merged_into UUID;
  r RECORD;
  v_elections INTEGER := 0; v_keys INTEGER := 0; v_reviews INTEGER := 0;
BEGIN
  SELECT merged_into INTO v_merged_into FROM politicians WHERE id = v_old;
  IF v_merged_into IS DISTINCT FROM v_keep THEN
    RAISE EXCEPTION '人物 % 的 merged_into 是 %，不是預期的 %，不處理殘列', v_old, v_merged_into, v_keep;
  END IF;

  -- 參選紀錄 36446
  FOR r IN SELECT * FROM politician_elections WHERE id = 36446 LOOP
    IF r.politician_id <> v_old THEN
      RAISE EXCEPTION '參選紀錄 36446 掛在 %，不是預期的 %', r.politician_id, v_old;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM politician_elections k WHERE k.politician_id = v_keep AND k.election_id = r.election_id) THEN
      RAISE EXCEPTION '保留者 % 沒有第 % 屆的參選紀錄，36446 不是撞鍵的殘列，不刪', v_keep, r.election_id;
    END IF;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_elections', r.id::TEXT, '*', to_jsonb(r), NULL, NULL, v_agent);
    DELETE FROM politician_elections WHERE id = r.id;
    v_elections := v_elections + 1;
  END LOOP;

  -- 三筆重複身份鍵
  FOR r IN SELECT * FROM politician_keys WHERE id IN (77586, 77587, 77588) ORDER BY id LOOP
    IF r.politician_id <> v_old THEN
      RAISE EXCEPTION '身份鍵 % 掛在 %，不是預期的 %', r.id, r.politician_id, v_old;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM politician_keys k WHERE k.politician_id = v_keep AND k.key_type = r.key_type AND k.key_value = r.key_value) THEN
      RAISE EXCEPTION '保留者 % 沒有同鍵（% / %），身份鍵 % 不是重複的，不刪', v_keep, r.key_type, r.key_value, r.id;
    END IF;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_keys', r.id::TEXT, '*', to_jsonb(r), NULL, NULL, v_agent);
    DELETE FROM politician_keys WHERE id = r.id;
    v_keys := v_keys + 1;
  END LOOP;

  -- 過期的重複審查結論（人物已併走）
  FOR r IN SELECT d.*, p.merged_into AS _merged_into FROM policy_dupe_reviews d JOIN politicians p ON p.id = d.politician_id
            WHERE d.politician_id IN (
              'a356d6d1-1e2a-4987-b884-532f5f3d9abf', '732cbaa2-e596-4609-980c-a7800f946e65',
              '54472fee-1dc4-475c-a104-64529aa0797a', '90378e6f-00c3-4981-904e-7b050b3c3d3d'
            ) ORDER BY d.politician_id LOOP
    IF r._merged_into IS NULL THEN
      RAISE EXCEPTION '人物 % 沒有被合併，它的重複審查結論不算過期，不刪', r.politician_id;
    END IF;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policy_dupe_reviews', r.politician_id::TEXT, '*',
            to_jsonb(r) - '_merged_into', NULL, NULL, v_agent);
    DELETE FROM policy_dupe_reviews WHERE politician_id = r.politician_id;
    v_reviews := v_reviews + 1;
  END LOOP;

  RAISE NOTICE '已合併人物殘列：參選紀錄 % 列、身份鍵 % 列、重複審查 % 列', v_elections, v_keys, v_reviews;
END;
$$;
