-- 「我看不到」不是「我反對」（使用者 2026-09-19 裁決）。
--
-- 兩個案例：卡伊．馬賴 4 張 agree 被一張「無法開啟來源 PDF」＋一張判錯的系統票推進 4 票的裁決；
-- 傅崐萁那筆 correction 2 張 agree 被一張「來源無法確定」卡成爭議。
--
-- 三條改法：
--   1. 盲反對（備註是打不開／確認不了）在 verify 端點就改記 unsure（TS isBlindDisagree）；這裡把既有的一併改記。
--   2. 轉爭議要 2 張代理反對；達標而只有 1 張反對 → 通過。
--   3. 系統票 not_supported 不再算一張反對，改成門檻 +1：只擋自動上線，不觸發裁決。
-- TS 鏡像：_shared/consensus.ts（thresholds.test 盯兩邊一致）。

-- 1. 既有的盲反對改記 unsure（規則與 TS 相同）
UPDATE contribution_votes
SET verdict = 'unsure',
    note = '（系統改記 unsure：反對票要有反證，「來源打不開／確認不了」不是反證）' || COALESCE(note, '')
WHERE verdict = 'disagree'
  AND COALESCE(note, '') ~* '無法(開啟|連線|確定|下載|讀取|存取|核對|取得|驗證|確認|載入|打開)|打不開|開不了|抓不到|連不上|逾時|timeout|timed out|HTTP ?(403|404|5[0-9][0-9])|連線失敗|讀不到'
  AND COALESCE(note, '') !~ '不符|矛盾|不一致|應為|應該是|實為|寫的是|錯誤|有誤|不是|並非|查無|沒有這個人|不存在|沒有任何|沒有提|沒提|未提|無此|只是|而非|才是|年生|經.{1,12}(報|網|資料|公報|名單)';

-- 2+3. 計票
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_status TEXT; v_new TEXT; v_need INTEGER;
  v_sys TEXT; v_need_eff INTEGER;
BEGIN
  SELECT
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'agree'),
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'disagree'),
    COUNT(*) FILTER (WHERE verdict = 'unsure')
  INTO v_agree, v_disagree, v_unsure
  FROM contribution_votes WHERE contribution_id = p_contribution_id;

  SELECT status, contribution_required_agree(contribution_type, payload, source_urls) INTO v_status, v_need
  FROM contributions WHERE id = p_contribution_id;

  -- 系統來源票：supported 佔一席（最少仍要 1 張代理票）；not_supported 多要一張人票，不算反對、不觸發裁決
  v_sys := contribution_system_vote(p_contribution_id);
  v_need_eff := CASE WHEN v_sys = 'supported' THEN GREATEST(1, v_need - 1)
                     WHEN v_sys = 'not_supported' THEN v_need + 1
                     ELSE v_need END;

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 兩張代理反對＝爭議；達標且反對 ≤1 通過；其餘 pending。沒有懸空。
    IF v_disagree >= 2 THEN v_new := 'disputed';
    ELSIF v_agree >= v_need_eff AND v_disagree <= 1 THEN v_new := 'verified';
    ELSE v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;
COMMENT ON FUNCTION contribution_apply_consensus IS
  '代理票依來源 IP 去重；系統票 supported 讓門檻 −1（最少 1）、not_supported 讓門檻 +1（不算反對）；兩張反對才是爭議，達標且反對 ≤1 通過。';

-- 4. 依新規則重算：所有還在投票中的、以及目前的爭議案（可能是被單張盲反對或系統票推進去的）
DO $$
DECLARE r RECORD; v_new TEXT;
BEGIN
  FOR r IN SELECT id, status FROM contributions WHERE status IN ('pending', 'verified', 'disputed') LOOP
    v_new := contribution_apply_consensus(r.id);
    -- 從爭議回到通過／待驗證：關掉還開著的裁決任務（裁決已經沒有對象）
    IF r.status = 'disputed' AND v_new <> 'disputed' THEN
      UPDATE contribution_tasks SET status = 'closed'
      WHERE task_type = 'adjudicate' AND status = 'open' AND target::text LIKE '%' || r.id::text || '%';
    END IF;
  END LOOP;
END $$;
