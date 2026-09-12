-- roster_check 的門檻：程式說 1 票，資料庫算 2 票——代理被告知過關了，其實沒有。
--
-- consensus.ts 的 riskLevel() 把 roster_check 跟 task_suggestion／no_change 同列 light
-- （它不改核心資料），官方來源 1 票。但 SQL 的 contribution_required_agree 那行
-- 只寫了 ('task_suggestion', 'no_change')，roster_check 掉進 ELSE 'normal'，
-- 官方來源要 2 票。
--
-- 後果：/next、/verifications、貢獻牆顯示的 required_agree 走 TS，寫「需 1 票」；
-- 但真正決定狀態的是 SQL 的 contribution_apply_consensus。Yooliang 交的新竹縣、
-- 金門縣兩筆拿到 1 票之後，畫面顯示 1/1 卻永遠停在 pending，沒有任何錯誤訊息。
--
-- 這是今天第三次同一個型態的錯：新增貢獻型別時，資料庫與程式碼對它的認定不一致
-- （removal 的 CHECK、roster_check 的 CONTRIBUTION_TYPES，現在是門檻）。所以這顆
-- 除了修 SQL，也在 protocol-guard.test.ts 補上「每一種型別的風險等級 SQL 與 TS 要
-- 一致」的比對——光比對門檻矩陣抓不到型別分錯級。

CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;

-- 卡在門檻不一致上的 roster_check 重算一次，讓它們依新門檻該過的就過。
-- 只碰 roster_check、只碰還在 pending 的，不動其他型別也不動已落庫的。
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE contribution_type = 'roster_check' AND status = 'pending' LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
