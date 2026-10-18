-- 補政黨的 candidacy 落庫，政黨的改動要進 edit_history（查核履歷「改動 N 處」看得到、履歷回復看得到）。
--
-- 之前：觸發器 trg_contribution_applied_candidacy_party → politician_election_party_from_candidacy() 直接 UPDATE
-- politician_elections.party_id／party_basis，不寫 edit_history。結果（蘇清吉，politician_elections.id 36770，2026-10-18）：
-- 補政黨的交件在履歷只看得到 source_note 一處改動，政黨補了什麼看不出來，也沒辦法從 edit_history 回復。
--
-- 這支只做一件事：函式本體照 20261006073461_parties.sql 的版本，在 UPDATE 前記舊值、UPDATE 真的改到列時，
-- party_id 與 party_basis 有變的欄位各寫一筆 edit_history（record_id＝參選紀錄 id，欄位名照實），
-- 其他一字不動（migration-party-edit-history.test.ts 逐行比對）。
-- contribution_id、agent_name 從呼叫端帶進來，所以函式多兩個參數；呼叫端只有觸發器函式
-- contribution_applied_candidacy_party()（跟當初的回填，那已經跑完）。舊的兩參數版本 DROP 掉，不留兩個版本。
-- 不回填：10-10 以來補政黨的 99 筆，舊值已經拿不到了。
-- 回復：edit_history 的還原把同一列的欄位併成一個 patch（groupRestores），party_id／party_basis 一起寫回，
-- 不會單獨違反 politician_elections_party_needs_basis；沒有再判斷的需要。

CREATE OR REPLACE FUNCTION politician_election_party_from_candidacy(p_politician_id UUID, p_payload JSONB, p_contribution_id UUID, p_agent_name TEXT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alias party_aliases%ROWTYPE;
  v_eid INTEGER;
  v_pe INTEGER;
  v_n INTEGER;
  v_old_party BIGINT;
  v_old_basis TEXT;
BEGIN
  IF p_politician_id IS NULL OR party_alias_key(p_payload ->> 'party') IS NULL THEN RETURN 0; END IF;
  SELECT * INTO v_alias FROM party_aliases WHERE alias_key = party_alias_key(p_payload ->> 'party');
  IF NOT FOUND THEN RETURN 0; END IF;  -- 寫法還沒有對照：不猜（列在 party_alias_gaps）
  IF coalesce(p_payload ->> 'election_id', '') !~ '^[0-9]+$' THEN RETURN 0; END IF;
  v_eid := (p_payload ->> 'election_id')::INTEGER;
  -- 一人一屆只有一筆參選紀錄（主鍵 politician_id＋election_id），candidacy 落庫寫的就是這一筆
  SELECT pe.id INTO v_pe FROM politician_elections pe WHERE pe.politician_id = p_politician_id AND pe.election_id = v_eid;
  IF v_pe IS NULL THEN RETURN 0; END IF;
  SELECT pe.party_id, pe.party_basis INTO v_old_party, v_old_basis FROM politician_elections pe WHERE pe.id = v_pe;
  UPDATE politician_elections
     SET party_id = v_alias.party_id, party_basis = 'contribution'
   WHERE id = v_pe AND (party_id IS DISTINCT FROM v_alias.party_id OR party_basis IS DISTINCT FROM 'contribution');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    IF v_old_party IS DISTINCT FROM v_alias.party_id THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', v_pe::TEXT, 'party_id', to_jsonb(v_old_party), to_jsonb(v_alias.party_id), p_contribution_id, p_agent_name);
    END IF;
    IF v_old_basis IS DISTINCT FROM 'contribution' THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', v_pe::TEXT, 'party_basis', to_jsonb(v_old_basis), to_jsonb('contribution'::TEXT), p_contribution_id, p_agent_name);
    END IF;
  END IF;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION politician_election_party_from_candidacy(UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION politician_election_party_from_candidacy(UUID, JSONB, UUID, TEXT) IS
  'candidacy 交件寫的 party → 那一筆參選紀錄的 party_id（party_basis＝contribution）；落庫觸發器用，改到的欄位寫 edit_history（contribution_id、agent_name 由呼叫端帶）（#346）';

-- 觸發器改叫新版（本體只多帶 NEW.id、NEW.agent_name）
CREATE OR REPLACE FUNCTION contribution_applied_candidacy_party() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.contribution_type = 'candidacy' AND NEW.applied_politician_id IS NOT NULL THEN
    BEGIN
      PERFORM politician_election_party_from_candidacy(NEW.applied_politician_id, NEW.payload, NEW.id, NEW.agent_name);
    EXCEPTION WHEN OTHERS THEN
      -- 不擋落庫；漏掉的會留在 party_basis 空的那一堆
      RAISE WARNING 'politician_election_party_from_candidacy（交件 %）失敗：%', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- 觸發器已改叫四參數版，舊的兩參數版沒有呼叫端了：刪掉，不留兩個版本
DROP FUNCTION IF EXISTS politician_election_party_from_candidacy(UUID, JSONB);
