-- 政見加真正的時間戳 updated_at（2026-09-22）
--
-- 選舉頁「最近更新」排序用的 last_updated 只有「日」：2026 縣市長有六位同停在 09-20，並列時「政見多的在前」
-- → 李四川（23 筆）永遠第一，系統等於替他站台（違反 DECISIONS「資料庫順序讓先建檔的永遠排第一＝系統替他站台」的精神）。
-- 而且 last_updated 只在建檔與進度更新時才動，代理套用的更正（標題、描述、來源、屆別）完全不會反映在「最近更新」。
--
-- 加 updated_at timestamptz：內容欄位任何 UPDATE 都由觸發器蓋 now()（表態計數 stance_* 不算「政見有變動」，排除）。
-- 回填取 last_updated 與 edit_history 最後一次套用時間較晚者，讓已被代理修過的政見有真正的時間。

ALTER TABLE policies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE policies p
   SET updated_at = GREATEST(
     p.last_updated::timestamptz,
     COALESCE((SELECT max(eh.applied_at) FROM edit_history eh
                WHERE eh.table_name = 'policies' AND eh.record_id::text = p.id::text), p.last_updated::timestamptz)
   );

CREATE OR REPLACE FUNCTION policies_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_policies_updated_at ON policies;
CREATE TRIGGER trg_policies_updated_at
  BEFORE UPDATE OF title, description, category, status, proposed_date, last_updated, progress, tags, source_url,
                   election_id, politician_id, removed_at
  ON policies FOR EACH ROW EXECUTE FUNCTION policies_touch_updated_at();

-- view 用 p.*，建立時就展開了，新欄位不會自己出現；欄位插在 logs 前面所以 CREATE OR REPLACE 不行，得重建。
-- 沒有別的 view 依賴它（pg_depend 查過）。內容照 20260913000001。
DROP VIEW policies_with_logs;
CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description)
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids
FROM policies p;

-- 跟其他 view 一樣以呼叫者身分執行，底層表的 RLS 才會生效（見 20260912000016）
ALTER VIEW policies_with_logs SET (security_invoker = on);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'policies_with_logs' AND column_name = 'updated_at';
  IF n <> 1 THEN RAISE EXCEPTION 'policies_with_logs 沒有 updated_at'; END IF;
  SELECT count(*) INTO n FROM policies WHERE updated_at > last_updated::timestamptz;
  RAISE NOTICE 'policies.updated_at 回填：% 筆的時間比 last_updated 晚（來自 edit_history）', n;
END $$;
