-- 修正三筆被系統錯寫的參選紀錄（2026-09-25，小良哥看到高嘉瑜被顯示成「登記參選台北市長」）
--
-- 成因：upsertParticipation 同一年只找一列（主鍵 politician_id＋election_id），更新時只改狀態、不改選舉別。
-- 三位原本被 AI 匯入成「可能選縣市長」，後來中選會名冊證實登記的是縣市議員，驗證通過落庫時，
-- 縣市長那列被改成 registered——選舉別與職稱還是縣市長。程式修正見 _shared/candidate-import.ts 的 electionTypeSwitch。
--
-- 這不是手修資料：三筆的內容都是已經驗證通過的貢獻本來就寫的（縣市議員），這裡只把系統漏寫的兩欄補上。
-- 每筆寫 edit_history（agent_name='system-fix'），可還原。

WITH fix(contribution_id, politician_id, new_position) AS (
  VALUES
    ('1c0782fe-2934-4aaa-857e-5e504251dd8a'::uuid, '77efee1f-cbcb-46a4-8de3-fc89e10e1beb'::uuid, '台北市議員候選人'),
    ('d0bff0e0-fb83-4d30-874a-10422fc5c506'::uuid, '0e7f6107-75ba-4c6b-bfa0-109fe20e0a8f'::uuid, '縣市議員候選人'),
    ('d1d2e740-8d42-43c5-b8b8-64bb4ea05bea'::uuid, '977dc06b-3f89-46e7-b627-0f0ec041cdb8'::uuid, '縣市議員')
),
target AS (
  SELECT pe.id, pe.election_type AS old_type, pe.position AS old_position, f.new_position, f.contribution_id
    FROM politician_elections pe
    JOIN fix f ON f.politician_id = pe.politician_id
   WHERE pe.election_id = 2026 AND pe.election_type = '縣市長'
),
hist AS (
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name, applied_at)
  SELECT 'politician_elections', t.id::TEXT, x.field, x.old_value, x.new_value, 'system-fix', now()
    FROM target t
    CROSS JOIN LATERAL (VALUES
      ('election_type', to_jsonb(t.old_type), to_jsonb('縣市議員'::TEXT)),
      ('position', to_jsonb(t.old_position), to_jsonb(t.new_position))
    ) AS x(field, old_value, new_value)
  RETURNING record_id
)
UPDATE politician_elections pe
   SET election_type = '縣市議員', position = t.new_position
  FROM target t
 WHERE pe.id = t.id AND pe.id::TEXT IN (SELECT record_id FROM hist);
