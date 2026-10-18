-- 協議 1.98.0：把參選紀錄改成「退選／不參選」的更正，分數要來自 ≥2 個不同來源 IP（比照加減參選人）。
--
-- 背景：8d5c8372「劉雁祿」的「這人沒參選」更正，被既有的選舉結果（not_elected）蓋掉、判成 superseded。
-- 同一版（candidacy-status.ts 的 explicitCorrection）讓明講的「沒參選／退選」不再被規則 ② 蓋掉，
-- 等於放寬了規則——能把「已有結果」的紀錄改成退選。放寬就要提高門檻。
--
-- 只改 contribution_needs_two_ips：多一條「correction、target_table＝politician_elections、有一欄 candidate_status
-- 的 correct_value 是 not_running／withdrawn」。舊格式（field＋correct_value）與新格式（changes[]）都看。
-- 分數、目標、退件門檻都不動，只決定「分數到了之後，還要不要第二個來源 IP」。
-- payload 看不出現值有沒有結果（current_value 是自報的），所以不分現值，一律套用。
-- TS 鏡像：consensus.ts 的 needsTwoIps、correction.ts 的 correctionWithdrawsCandidacy。
-- 呼叫端（計票、驗證池、佇列預覽）本來就都看這支函式，不用動。

CREATE OR REPLACE FUNCTION contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('merge_politician', 'candidacy', 'removal', 'reassign_candidacy')
      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')
      OR (p_type = 'correction'
          AND COALESCE(p_payload->>'target_table', '') = 'politician_elections'
          AND (
            (COALESCE(p_payload->>'field', '') = 'candidate_status'
              AND COALESCE(p_payload->>'correct_value', '') IN ('not_running', 'withdrawn'))
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'changes') = 'array' THEN p_payload->'changes' ELSE '[]'::jsonb END) c
              WHERE jsonb_typeof(c) = 'object'
                AND COALESCE(c->>'field', '') = 'candidate_status'
                AND COALESCE(c->>'correct_value', '') IN ('not_running', 'withdrawn')
            )
          ))
$$;
COMMENT ON FUNCTION contribution_needs_two_ips IS
  '分數不得由單一來源 IP 湊足的貢獻：同名合併、加減參選人、移除、參選紀錄改掛（2026-10-06）、「中止」交接（#349），以及把參選紀錄改成退選／不參選的更正（協議 1.98.0）';
