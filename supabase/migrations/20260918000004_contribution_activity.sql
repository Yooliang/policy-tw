-- 動態牆改成「最近有變動的排最上面」，並記下變動是什麼（2026-09-18）。
--
-- 原本照提交時間排：一筆兩天前交的貢獻，就算剛剛有人投票、剛通過、剛退件，
-- 還是留在兩天前的位置——正在被核對的那些反而看不到。
--
-- 最常見的變動是「有人投了一票」，而那個時間只存在 contribution_votes，
-- 貢獻自己身上沒有。所以加兩個欄位，由 trigger 維護：
--   last_activity_at  最後一次變動的時間（排序與翻頁游標都用它）
--   last_activity     變動是什麼（agree／disagree／unsure／status:applied…），畫面用它講人話
--
-- 為什麼不用 GREATEST(created_at, verified_at, reviewed_at, applied_at) 就好：
-- 那樣「有人投票但還沒過門檻」的完全不會浮上來，而那正是最該被看見的一群。

ALTER TABLE contributions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS last_activity TEXT;
COMMENT ON COLUMN contributions.last_activity_at IS '最後一次變動（投票或狀態改變）的時間；由 trigger 維護，不要手改';
COMMENT ON COLUMN contributions.last_activity IS '最後一次變動是什麼：agree／disagree／unsure／status:<新狀態>／created';

-- 回填：現有資料取「自己的幾個時間」與「最後一票」的最大值
WITH last_vote AS (
  SELECT contribution_id, MAX(created_at) AS at FROM contribution_votes GROUP BY contribution_id
)
UPDATE contributions c SET
  last_activity_at = GREATEST(
    c.created_at,
    COALESCE(c.verified_at, c.created_at),
    COALESCE(c.reviewed_at, c.created_at),
    COALESCE(c.applied_at, c.created_at),
    COALESCE(v.at, c.created_at)
  ),
  last_activity = CASE
    WHEN c.applied_at IS NOT NULL AND c.applied_at >= COALESCE(v.at, c.created_at) THEN 'status:applied'
    WHEN c.reviewed_at IS NOT NULL AND c.reviewed_at >= COALESCE(v.at, c.created_at) THEN 'status:' || c.status
    WHEN v.at IS NOT NULL THEN 'vote'
    ELSE 'created'
  END
FROM (SELECT c2.id, lv.at FROM contributions c2 LEFT JOIN last_vote lv ON lv.contribution_id = c2.id) v
WHERE c.id = v.id AND c.last_activity_at IS NULL;

ALTER TABLE contributions ALTER COLUMN last_activity_at SET DEFAULT now();
UPDATE contributions SET last_activity_at = created_at, last_activity = 'created' WHERE last_activity_at IS NULL;

-- 排序與翻頁都吃這個欄位
CREATE INDEX IF NOT EXISTS idx_contributions_last_activity ON contributions (last_activity_at DESC);

-- 投進一票就算一次變動。verdict 直接記下來，畫面才講得出「剛拿到一票同意」還是「被投了反對」
CREATE OR REPLACE FUNCTION contribution_vote_activity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contributions SET last_activity_at = NEW.created_at, last_activity = NEW.verdict
  WHERE id = NEW.contribution_id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS contribution_vote_activity_trg ON contribution_votes;
CREATE TRIGGER contribution_vote_activity_trg
  AFTER INSERT ON contribution_votes
  FOR EACH ROW EXECUTE FUNCTION contribution_vote_activity();

-- 狀態改變也算一次變動（通過、上線、退件、還原、重試…）
CREATE OR REPLACE FUNCTION contribution_status_activity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.last_activity_at := now();
    NEW.last_activity := 'status:' || NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contribution_status_activity_trg ON contributions;
CREATE TRIGGER contribution_status_activity_trg
  BEFORE UPDATE ON contributions
  FOR EACH ROW EXECUTE FUNCTION contribution_status_activity();
