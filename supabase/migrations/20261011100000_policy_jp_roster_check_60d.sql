-- 日本站：名簿清查（roster_check）投票日前 60 天才開
--   維護者 2026-10-11 裁決（policy-ops docs/decisions/2026-10-11-日本站名簿清查投票前60天才開.md；
--   工作單 docs/work/2026-10-11-日本站名簿清查60天.md）。取代 2026-10-10 讀音選填決定第 4 點的「暫不做」。
--   理由：太早派多半回 not_found，白費代理輪次。
--
--   只改一處：roster_check 的開窗規則（priority IS NULL 那一列）原地 UPDATE 加起點 polling −60，rule_id 不變。
--   迄點（投票日當天）、after_step=region、後備（告示日 −30）、cap 200、min_status 都不動。
--   優先層規則 priority:roster_check（60／181 天）不動。
--   已開的任務若投票日在 60 天外，下一輪 seed 由窗口收回（gap_events reason=window）；鏈的 sticky 只管前一步，不管窗口。
--   冪等：重跑結果相同。

UPDATE policy_jp.activity_rules
   SET from_kind = 'polling', from_offset = -60, updated_at = now(),
       note = note || '投票日の 60 日前から開く（維護者 2026-10-11）。'
 WHERE activity = 'roster_check' AND priority IS NULL
   AND (from_kind IS DISTINCT FROM 'polling' OR from_offset IS DISTINCT FROM -60);

-- 自我檢查：做錯就讓這支 migration 失敗
DO $$
BEGIN
  IF (SELECT count(*) FROM policy_jp.activity_rules r WHERE r.activity = 'roster_check' AND r.priority IS NULL) <> 1 THEN
    RAISE EXCEPTION 'policy_jp：roster_check の開窓規則が 1 列ではない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'roster_check' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'event'
                    AND r.from_kind = 'polling' AND r.from_offset = -60 AND r.until_kind = 'polling' AND r.until_offset = 0
                    AND r.after_step = 'region' AND r.params ? 'chain_fallback' AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：roster_check の規則が「投票日 −60 〜 当日、after_step=region、後備・cap あり」になっていない';
  END IF;
END $$;
