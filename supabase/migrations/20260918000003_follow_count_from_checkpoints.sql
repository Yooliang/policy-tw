-- 關注＝政見卡片上的⭐，只算登入的人（2026-09-18）。
--
-- 原本卡片上🔥那個數字讀的是 policy_stances 裡 stance=2（「更在意」）的表態票：以 IP 認人，
-- 而且跟支持／反對三選一——選了關注，原本的支持就被換掉。
--
-- 改成：關注數＝有幾個登入帳號把這條政見加進⭐（user_checkpoints，主鍵是帳號 × 政見，一人一票）。
-- 沒登入按⭐只存在自己的瀏覽器，不計數。誰關注了什麼不對外，畫面只看加總。
-- policies.stance_priority 欄位名不動，所有 view 與畫面照舊讀它，只是數字的來源改對了。
-- 表態只剩支持／反對。
--
-- 上線當下 policies.stance_priority 全部是 0（實查），沒有舊票。舊的 stance=2 以 IP 認人，
-- 對不回帳號，所以直接拿掉，不搬。

-- 表態的同步不再碰 stance_priority：兩支 trigger 寫同一欄會互相蓋掉
CREATE OR REPLACE FUNCTION policy_stances_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_pid UUID;
BEGIN
  v_pid := COALESCE(NEW.policy_id, OLD.policy_id);
  UPDATE policies SET
    stance_support = (SELECT COUNT(*) FROM policy_stances WHERE policy_id = v_pid AND stance = 1),
    stance_oppose  = (SELECT COUNT(*) FROM policy_stances WHERE policy_id = v_pid AND stance = -1)
  WHERE id = v_pid;
  RETURN NULL;
END;
$$;

-- user_checkpoints 是瀏覽器以登入者身分直接寫的。trigger 若以呼叫者身分執行，
-- 就是用那位使用者的權限去改 policies——policies 對一般使用者只能讀，UPDATE 會被 RLS 擋下，
-- 關注數永遠不動，而且不會報錯。所以要以定義者身分執行，search_path 固定。
CREATE OR REPLACE FUNCTION user_checkpoints_follow_sync() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_pid UUID;
BEGIN
  v_pid := COALESCE(NEW.policy_id, OLD.policy_id);
  UPDATE policies SET stance_priority = (SELECT COUNT(*) FROM user_checkpoints WHERE policy_id = v_pid)
  WHERE id = v_pid;
  RETURN NULL;
END;
$$;
-- 只給 trigger 用，不讓任何人直接呼叫
REVOKE ALL ON FUNCTION user_checkpoints_follow_sync() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_checkpoints_follow_sync_trg ON user_checkpoints;
CREATE TRIGGER user_checkpoints_follow_sync_trg
  AFTER INSERT OR DELETE ON user_checkpoints
  FOR EACH ROW EXECUTE FUNCTION user_checkpoints_follow_sync();

-- 舊的「更在意」表態：以 IP 認人、對不回帳號，拿掉（上線當下實查為 0 筆）
DELETE FROM policy_stances WHERE stance = 2;

-- 所有政見的關注數以登入者的⭐為準重算一次
UPDATE policies p SET stance_priority = COALESCE(c.n, 0)
FROM (SELECT pl.id, (SELECT COUNT(*) FROM user_checkpoints uc WHERE uc.policy_id = pl.id) AS n FROM policies pl) c
WHERE p.id = c.id AND p.stance_priority IS DISTINCT FROM COALESCE(c.n, 0);

COMMENT ON COLUMN policies.stance_priority IS '關注數：把這條政見加進⭐的登入帳號數（user_checkpoints 的 trigger 同步，不要手改）。欄位名是歷史遺留';
COMMENT ON TABLE user_checkpoints IS '登入者關注的政見（⭐）。也是政見關注數的來源。未登入者的清單留在瀏覽器 localStorage，不進這張表、不計數。';
