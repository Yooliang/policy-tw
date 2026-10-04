-- 人物表清成「只放人」第一波（2026-10-04，維護者：「好，先做第一波清理」）
--
-- upsert_politician()：2026-01 早期匯入用的 RPC，全專案（前端、Edge Functions、腳本）已無任何呼叫者，
-- 但 PostgREST 仍公開它，任何人都能直接呼叫、往 politicians 寫 status／election_type／position／region／
-- sub_region／village／region_id——正好是要淘汰的那幾欄。人物與參選一律走貢獻協議，這支直接拿掉。
DROP FUNCTION IF EXISTS upsert_politician(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, INT);
