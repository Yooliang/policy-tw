-- 插隊改成維護者才能寫，並取消 #92 還沒領走的部分（2026-11-04，工作單：Yooliang/policy-ops#196，小良哥同意）
-- ============================================================
--
-- 一、插隊要維護者憑證
--   Edge Function boost／jp-boost 的 POST 改成要帶憑證（沒帶或不對回 401、驗證服務壞掉回 503，都不寫任何東西；GET 維持公開），
--   憑證做法同 console-fetch（20261008030000）：
--     1. 這支 migration 在 Vault 沒有 boost_maintainer_secret 時自己產一個隨機值（已經有就不動，重跑安全；值不在版控、不在任何人手上）；
--     2. 函式端不持有這個值，而是用 Edge runtime 自帶的 SUPABASE_SERVICE_ROLE_KEY 呼叫 RPC boost_maintainer_secret_ok(p_secret)，
--        請資料庫拿 x-cron-secret 標頭的值跟 Vault 比對（SECURITY DEFINER，只授權 service_role）；
--     3. 維護者手動呼叫仍可用 Authorization: Bearer <service role key>。
--   日本站的 jp-boost 用 policy_jp 的 client，所以 policy_jp 也有同名 RPC（轉呼叫 public 那支）。
--
--   同時把直接打 PostgREST 的路也收起來（2026-11-04 唯讀查正式庫 has_function_privilege／has_table_privilege）：
--     public.task_boost、task_boost_matches、task_boost_remaining 只留 service_role；public.task_boosts 收回 anon／authenticated 的寫入權限（公開讀取的 policy 不動）。
--   task_boost_remaining 一併收：它內部呼叫 task_boost_matches，只收後者的話 anon 呼叫它會報權限錯；GET /boost 用 service_role，不受影響。
--   policy_jp 那邊的 task_boost 三個函式本來就只有 service_role（正式庫查過），不用動。
--
-- 二、取消 #92（優先排入六都村里長基本資料缺口任務）還沒領走的部分
--   #92 對 2,579 筆任務加了一份 queue_settings.boost_seconds；做法同 task_boost：task_dispatches.boost_seconds 加份數，
--   觸發器 task_dispatches_queue_key 照排序鍵重算 queue_at，派出就歸零（dispatch_count 變動時）。
--   這裡只對「#92 的 filter 命中、boost_seconds > 0、而且 #92 之後沒有被派出過」的任務列扣掉一份（最低 0）：
--     - 別的插隊（例如 #93）也命中的列，boost_seconds 有兩份以上，扣一份後保留另一份；
--     - #92 之後已派出過的列（last_dispatched_at 晚於 #92 的時間）不碰，它現在的插隊秒數是之後別的插隊加的；
--     - 不動 #96、#94、#95、#93 與其他任何插隊，不動 task_boosts 的紀錄列；task_boost 當時順手解除的 cooling 不還原。
--   冪等：做過會在 edit_history 留一列（table_name＝task_boosts、record_id＝92、field＝cancel_unclaimed），有這一列就整段跳過。
--   2026-11-04 唯讀查正式庫實際會影響的列數：命中且在佇列 2,576、目前仍有插隊秒數 1,778、其中本次會扣的 1,762（歸零 1,722、仍保留別份 40）、
--   #92 之後已派出而不碰的 16。
--
-- 引用到的既有物件（2026-11-04 唯讀查正式庫確認存在）：public.task_boost(text,jsonb,text,text)、task_boost_matches(jsonb)、task_boost_remaining(bigint)、
--   task_boosts(id, filter, created_at)、task_dispatches(task_id, boost_seconds, last_dispatched_at)、queue_settings(id, boost_seconds)、
--   edit_history(table_name, record_id, field, old_value, new_value, agent_name)、refresh_verify_ticket_keys()、擴充 supabase_vault／pgcrypto（schema extensions）。

-- ── 1. 密鑰：沒有才產（64 字元十六進位，32 位元組隨機） ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'boost_maintainer_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'boost_maintainer_secret',
      'boost／jp-boost 的維護者憑證（migration 自動產生；函式端用 boost_maintainer_secret_ok 驗，不持有這個值）'
    );
  END IF;
END
$$;

-- ── 2. 驗證用 RPC：Edge Function 以 service_role 呼叫 ───────────────────
-- 比對兩邊的 SHA-256 摘要而不是原字串；太短的輸入一律不通過。search_path 清空、全部寫全名。
CREATE OR REPLACE FUNCTION public.boost_maintainer_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_secret IS NOT NULL
     AND length(p_secret) >= 16
     AND EXISTS (
       SELECT 1
         FROM vault.decrypted_secrets s
        WHERE s.name = 'boost_maintainer_secret'
          AND extensions.digest(s.decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256')
     );
$$;
REVOKE ALL ON FUNCTION public.boost_maintainer_secret_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.boost_maintainer_secret_ok(text) FROM anon;
REVOKE ALL ON FUNCTION public.boost_maintainer_secret_ok(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.boost_maintainer_secret_ok(text) TO service_role;
COMMENT ON FUNCTION public.boost_maintainer_secret_ok(text) IS
  'boost 驗 x-cron-secret 用（2026-11-04）：拿輸入值跟 Vault 的 boost_maintainer_secret 比對，只授權 service_role；密鑰由 migration 產生、不離開資料庫';

-- 日本站的 client 固定 schema policy_jp，RPC 要在 policy_jp 找得到：轉呼叫 public 那支
CREATE OR REPLACE FUNCTION policy_jp.boost_maintainer_secret_ok(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.boost_maintainer_secret_ok(p_secret); $$;
REVOKE ALL ON FUNCTION policy_jp.boost_maintainer_secret_ok(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION policy_jp.boost_maintainer_secret_ok(text) FROM anon;
REVOKE ALL ON FUNCTION policy_jp.boost_maintainer_secret_ok(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.boost_maintainer_secret_ok(text) TO service_role;

-- ── 3. 取消 #92 還沒領走的部分（要在收回函式權限之前做；migration 以擁有者身分跑） ──
DO $$
DECLARE
  v_at timestamptz;
  v_filter jsonb;
  v_share bigint;
  v_n integer;
  v_zero integer;
BEGIN
  IF EXISTS (SELECT 1 FROM edit_history WHERE table_name = 'task_boosts' AND record_id = '92' AND field = 'cancel_unclaimed') THEN
    RETURN; -- 做過了
  END IF;
  SELECT b.created_at, b.filter INTO v_at, v_filter FROM task_boosts b WHERE b.id = 92;
  IF NOT FOUND THEN
    RETURN; -- 沒有 #92 的環境（本機、測試）
  END IF;
  SELECT q.boost_seconds INTO v_share FROM queue_settings q WHERE q.id = 1;

  WITH hits AS (
    SELECT m.task_id FROM task_boost_matches(v_filter) m WHERE m.kind = 'task'
  ), upd AS (
    UPDATE task_dispatches d
       SET boost_seconds = GREATEST(d.boost_seconds - v_share, 0)
      FROM hits h
     WHERE h.task_id = d.task_id
       AND d.boost_seconds > 0
       AND (d.last_dispatched_at IS NULL OR d.last_dispatched_at <= v_at)
    RETURNING d.boost_seconds AS after_seconds
  )
  SELECT count(*)::integer, (count(*) FILTER (WHERE after_seconds = 0))::integer INTO v_n, v_zero FROM upd;

  -- 母任務的插隊少了，跟著它的驗證票排序鍵也要重算
  PERFORM refresh_verify_ticket_keys();

  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  VALUES ('task_boosts', '92', 'cancel_unclaimed',
          jsonb_build_object('filter', v_filter, 'boost_created_at', v_at),
          jsonb_build_object('rows_reduced_by_one_share', v_n, 'rows_back_to_zero', v_zero, 'share_seconds', v_share),
          'boost-cancel');
END
$$;

-- ── 4. 收回直接打 PostgREST 的路：只留 service_role ─────────────────────
REVOKE ALL ON FUNCTION public.task_boost(text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_boost(text, jsonb, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.task_boost(text, jsonb, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.task_boost(text, jsonb, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.task_boost_matches(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_boost_matches(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.task_boost_matches(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.task_boost_matches(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.task_boost_remaining(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.task_boost_remaining(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.task_boost_remaining(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.task_boost_remaining(bigint) TO service_role;

-- 插隊紀錄表：公開讀取（policy task_boosts_public_read）不動，收回 anon／authenticated 的寫入權限
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.task_boosts FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
