-- 日本站：政見任務逐人開（工作單 Yooliang/policy-ops 決定 2026-10-11-日本站政見任務逐人開）
-- ============================================================
--
-- 維護者 2026-10-11：「为什么要等到全部的人都到齐才开始补呢…人物一进来之后就可以开始针对单一开始补齐了」。
-- 20261010060000 第 8 節把 policy_missing 的 after_step 設成 'profile'（整場人物檔案補齊才開），
-- 結果 69 場沒有一場 profile done，政見任務全被擋。這支把它原地改成 'candidacy'：
-- 該場有人正式表明（declared 以上、已上線）後，每位已建檔的參選人各開一件，不等整場人物檔案。
--   * rule_id 不變（原地 UPDATE）；chain_fallback（告示日翌日）與 cap 不變
--   * 臂本體不動：對象本來就是逐人（declared／filed／elected／not_elected、上線、沒有政見）；改的只是鏈上的 gate
--   * 規則表上的審計觸發器（trg_activity_rules_audit → edit_history）照常記這次修改
--   * 冪等：已經是 candidacy 時 WHERE 不命中
-- ============================================================

UPDATE policy_jp.activity_rules
   SET after_step = 'candidacy',
       note = '選挙鎖の第 4 歩（この選挙の公約）：開いている選挙の立候補者で公約が 1 件もない人を、選挙公報・公式サイトで確かめて policy を提出させる。その選挙に正式に表明した人（declared 以上）が出たら、建檔済みの立候補者 1 人ごとに 1 件ずつ開く（選挙全体の人物建檔が揃うのを待たない）；止まっていても告示日の翌日（選挙公報が出る日）には開く（後備）。同時に開くのは最大 200 件'
 WHERE activity = 'policy_missing' AND priority IS NULL AND after_step IS DISTINCT FROM 'candidacy';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'policy_missing' AND r.priority IS NULL AND r.enabled
                  AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：policy_missing の規則は after_step=candidacy かつ chain_fallback／cap つきでなければならない';
  END IF;
END
$$;
