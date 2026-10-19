-- 名冊對帳：系統建的人物姓名改回名冊原文（#678 #708 重新試跑後修正；2026-10-20）
-- ============================================================
--
-- 起因：重新試跑建出人物「LalingYumin」，名冊原文是「Laling Yumin」（空白被拿掉）。
-- 查清楚：roster_reconcile_next() 回的 name 是 cec_registrations.name 原文，沒問題；問題在 TS——ensurePolitician()（candidate-import.ts）建新人物時
-- 寫進 politicians.name 的是 identityInputOf() 算出來、比對用的 normText(name)（NFKC、去空白、全形轉半形、臺→台），不是原文。
-- 這個行為對所有走 candidacy 落庫的新人物都一樣（代理交的也會被壓掉空白），這次只改系統寫入：applySystemCandidacy 帶 keep_original_name，
-- 建人物時用名冊原文（displayNameOf：只 trim、連續空白壓成一個），比對與 identity key 仍用正規化後的姓名。代理交件的行為不動。
--
-- 這支 migration 把「已經由系統建立、名字跟名冊原文不同」的人物改回名冊原文，每一筆寫 edit_history（agent_name＝system:roster-reconcile）：
--   * 範圍：roster_reconcile_log 裡 outcome＝applied、person_action＝new、created_politician、沒被還原的；
--   * 人物沒被別人動過：edit_history 裡沒有別的 agent_name（未還原）改過這個人物；也沒被合併走（merged_into 空）；
--   * 改完仍是同一個人：roster_name_key（比對用的姓名鍵）新舊相同，只是顯示名不同；
--   * 名冊原文空白（name_empty）的不動。
-- 可重跑：改完之後名字等於名冊原文，下一次一筆都不會選到。只動 politicians.name 與 edit_history，不動參選紀錄與 log。
--
-- 引用到的既有物件（2026-10-20 唯讀查正式庫確認存在）：roster_reconcile_log、cec_registrations、politicians（name、merged_into）、edit_history、roster_name_key()（20261020030100）。
-- 守門：_shared/roster-reconcile-name.test.ts（PGlite 跑本檔、TS 建人物保留原文、還原驗證）。

WITH fixes AS (
  SELECT l.politician_id, l.agent_name, p.name AS old_name,
         btrim(regexp_replace(r.name, '[\s　]+', ' ', 'g')) AS new_name
    FROM roster_reconcile_log l
    JOIN cec_registrations r ON r.id = l.reg_id
    JOIN politicians p ON p.id = l.politician_id
   WHERE l.outcome = 'applied' AND l.person_action = 'new' AND l.created_politician AND l.reverted_at IS NULL
     AND p.merged_into IS NULL
     AND btrim(r.name) <> ''
     AND p.name IS DISTINCT FROM btrim(regexp_replace(r.name, '[\s　]+', ' ', 'g'))
     AND roster_name_key(p.name) IS NOT DISTINCT FROM roster_name_key(r.name)
     AND NOT EXISTS (
       SELECT 1 FROM edit_history h
        WHERE h.table_name = 'politicians' AND h.record_id = l.politician_id::TEXT
          AND h.agent_name IS DISTINCT FROM l.agent_name AND h.reverted_at IS NULL)
), upd AS (
  UPDATE politicians p SET name = f.new_name
    FROM fixes f
   WHERE p.id = f.politician_id
  RETURNING p.id, f.old_name, f.new_name, f.agent_name
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
SELECT 'politicians', u.id::TEXT, 'name', to_jsonb(u.old_name), to_jsonb(u.new_name), u.agent_name FROM upd u;
