-- 目標分數一律 3（使用者 2026-09-21 裁示）；不動正式資料的型別（task_suggestion／no_change／roster_check）2。
--
-- 舊的票數矩陣（2/3/4/6/8，型別風險 × 來源等級）是票數制的遺物，分數制上線時被我原樣搬過來當目標。
-- 實測：媒體級參選紀錄目標 5～8（許甫 6、李眉蓁 8、何應明 5、許玉仙 5、許大鴻 5），全是官方名冊
-- 一秒可確認的登記；矩陣下等於要六張 +1，實務上到不了，案子停在 pending（全站 1,418 筆待驗證，55%）。
-- 使用者早上定的機制本來就是「總分 3 分」，風險差異之後由 Jev 的風險加成（vote-budget）動態調，
-- 不是靠一張靜態矩陣。系統票 supported 仍讓目標 −1（最少 1），not_supported +1（contribution_effective_agree 不變）。
--
-- 矩陣的形狀留著（四個來源等級同一個數字），因為守門測試按這個形狀比對 SQL／TS／skill.md 三處一致。

-- 守門測試從函式名最後一次出現處往後解析，所以註解不放在函式後面。
-- 目標分數：一律 3，不動正式資料的型別 2（2026-09-21 裁示）。系統票調整見 contribution_effective_agree。
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'correction' AND correction_only_from_rumor(p_payload) THEN 'normal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 3
  END;
END;
$$;

-- 目標降了，既有 pending 裡分數已達 3 的直接過：全部重算一次
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE status = 'pending' LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
