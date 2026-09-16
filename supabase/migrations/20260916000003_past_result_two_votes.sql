-- 補「已投票選舉的結果」只要 2 票，不再比照加減參選人的 4／6／8。
--
-- 2026-09-16 小良哥看一筆待驗證：「將 陳若翠 2024 高雄市立法委員參選狀態改為確認參選」，
-- payload 帶 election_result=not_elected、得票 64,261、得票率 34.69%，來源是維基與中央社，
-- 卻要 6 票同意。他說：「這種舊期的參選，我覺得 2 票就夠了」。
--
-- 為什麼可以降：加減參選人要 4／6／8，是因為那會憑空生出或抹掉一筆參選紀錄；
-- 但這一類是掛在「既有人物、既有屆別」上補一個查得到的既成事實，弄錯也容易改回來。
-- 判斷條件刻意要求 payload 帶 politician_id：不帶的那條路會順手建出新人物，
-- 風險跟新增參選人一樣，維持 high。
-- 不看來源等級：選舉結果連維基都抄得到，官方／媒體／社群分級在這裡沒有意義。
--
-- TS 那一半在 _shared/consensus.ts（AGREE_THRESHOLDS 與 riskLevel），兩邊必須一致，
-- thresholds.test.ts 會比對。

CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;

-- 已經在等票的那幾筆照新門檻重算一次：不然它們會繼續掛在舊的 6 票上，
-- 已經拿到 2 票的也不會自己變成 verified。只碰 pending 的 candidacy。
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE status = 'pending' AND contribution_type = 'candidacy' LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
