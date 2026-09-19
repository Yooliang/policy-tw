-- 驗證池改在 SQL 裡排除，撈出來的 30 筆就是「這台機器真的能投」的 30 筆。
--
-- 原本 /next 是先取最早的 30 筆 pending，再在 TS 裡排掉自己提交的、投過的、已達門檻的。
-- 問題：排除在 LIMIT 之後做。一台勤勞的機器把最早的 30 筆投完，池子就整池是死的——
-- /next 說「沒東西可驗」，可是第 31 筆之後還有 1,400 多筆在等（2026-09-19，全站 pending 1,473）。
-- 排除搬到 LIMIT 之前，池子永遠是還能投的那 30 筆。
--
-- 身份用來源 IP，不用代號（2026-09-19 裁決）：代號是自報的、兩個人可以共用同一個；
-- IP 雜湊不會重複。/verify 的去重（isDuplicateVote）與 /verifications 同一天改成同一個標準——
-- 三處的排除標準必須一致，不然代理會被派到投不進去的東西，查證做完才吃 already_voted。
--
-- 這裡不排「同代號提交的」：那是自驗排除，代號還是留給它用（skill.md 第 93 行），仍在 TS 做。

CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30
) RETURNS SETOF contributions
LANGUAGE sql STABLE AS $$
  SELECT c.*
  FROM contributions c
  WHERE c.status = 'pending'
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    -- 不驗自己這台機器提交的
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    -- 這台機器投過的不再派
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash
    )
    -- 已經湊夠票的不用再驗（門檻 SQL 與 TS 各一份，thresholds.test 盯著一致）
    AND c.agree_count < contribution_required_agree(c.contribution_type, c.payload, c.source_urls)
  ORDER BY c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;

COMMENT ON FUNCTION contribution_verify_pool IS
  '/next 的驗證候選池：同 IP 提交／投過的、已達門檻的都在 LIMIT 之前排掉，回最早的 N 筆。';
