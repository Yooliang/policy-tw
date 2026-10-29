-- 號次交件（candidacy 且 payload 帶正整數 cand_no）不用「至少兩台不同機器」（維護者 2026-10-29 指示：拿掉）
--
-- 背景：#754（20261029020000）把號次的目標分降為 1，但刻意保留 contribution_needs_two_ips 的兩台機器規則；
-- 結果分數 1／目標 1 的件仍卡在等第二台。維護者要求拿掉：一張同意、目標分 1 就上線。
-- 裁決：docs/decisions/2026-10-29-號次免兩台機器.md
--
-- 只改 contribution_needs_two_ips，以 20261018030000 的現行定義為底，多一條例外：
--   p_type = 'candidacy' 且 cand_no 符合與 contribution_required_agree 相同的正整數判斷（'^0*[1-9][0-9]{0,5}$'），
--   且不是 past_result（election_result 為 elected／not_elected 且 politician_id 為 UUID，判斷同 contribution_required_agree）→ FALSE。
-- 其餘一律不變：merge_politician、removal、reassign_candidacy、一般 candidacy（無 cand_no）、補已投票結果 candidacy、
-- correction 退選／不參選、「中止」交接，照舊要兩台機器。
-- 簽名不變；呼叫端（計票 contribution_apply_consensus、驗證池、佇列預覽、unsure_penalty、overvoted_votes）本來就都看這支函式，不用動，
-- 其他函式沒有自己寫死 candidacy 要兩台（已查 migrations 最新定義）。policy_jp 那份不動。
-- 分數、目標、退件門檻都不動；一張反對照舊擋得住。名冊吻合免兩台的既有邏輯不動。
-- TS 鏡像：consensus.ts 的 needsTwoIps。守門測試從函式名後解析，所以這段說明不放在函式後面。

CREATE OR REPLACE FUNCTION contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT COALESCE(
           p_type = 'candidacy'
           AND p_payload->>'cand_no' ~ '^0*[1-9][0-9]{0,5}$'
           AND NOT COALESCE(
             p_payload->>'election_result' IN ('elected', 'not_elected')
             AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
             FALSE)
           , FALSE)
     AND (
      p_type IN ('merge_politician', 'candidacy', 'removal', 'reassign_candidacy')
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
     )
$$;
COMMENT ON FUNCTION contribution_needs_two_ips IS
  '分數不得由單一來源 IP 湊足的貢獻：同名合併、加減參選人、移除、參選紀錄改掛（2026-10-06）、「中止」交接（#349），以及把參選紀錄改成退選／不參選的更正（協議 1.98.0）；補號次的 candidacy（正整數 cand_no、非已投票結果）不用（維護者 2026-10-29）';
