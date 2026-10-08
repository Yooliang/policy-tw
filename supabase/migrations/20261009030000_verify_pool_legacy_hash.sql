-- 驗證池的自交排除要新舊雜湊一起比（#484，承接 #481／#482 的過渡期）。
--
-- 背景：1.79.0 起來源改看網段（IPv4 /24、IPv6 /64），切換前交的貢獻、投的票存的是「單一 IP」的舊雜湊。
-- #482 的過渡期做法是投票端（handleVerify）與 /next 的 my_votes 新舊都比，但驗證池 contribution_verify_pool
-- 只收新雜湊（p_ip_hash）：切換前自己交的待驗證貢獻，會被 /next 當成別人的派給自己，
-- 代理做完整套查證才在 POST /report 吃到 403 self_vote，白做一輪。裁決的「原貢獻是我交的／我投過票」同理。
--
-- 做法：現行定義（20261006034900）加一個有預設值的參數 p_legacy_ip_hash，四處「= p_ip_hash」旁邊多一個 OR 舊雜湊，
-- 其餘一字不動。沒傳（NULL）＝行為與現行完全相同，所以舊版 /next、/verifications（只傳 p_ip_hash）照常運作。
--
-- 簽名多一個參數，舊的四參數版本要先 DROP：留著會讓只傳 p_ip_hash／p_region／p_limit 的 rpc 呼叫
-- 同時符合兩個版本（PGRST203 找不到最佳候選）。新版本的前四個參數與預設值跟舊版相同，
-- 所以舊程式（具名參數呼叫）在 migration 與部署之間的幾分鐘內照常解析到新版，不會中斷
-- （CLAUDE.md「改簽名分兩次上」針對的是刪除或改名；這裡是同名同序、只在尾巴加有預設值的參數）。
--
-- 限制（同 isLegacySource）：舊雜湊是 hash(salt|單一 IP)，只認得「切換前後同一個 IP」的固定 IP 機器；
-- 輪換 IP 的代理切換前用別的 IP 交的，單向雜湊換算不出網段，這裡認不出來。

DROP FUNCTION IF EXISTS contribution_verify_pool(TEXT, TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[], note TEXT, task_id TEXT,
  agent_name TEXT, contributor_ip_hash TEXT, status TEXT,
  agree_count INTEGER, disagree_count INTEGER, unsure_count INTEGER, created_at TIMESTAMPTZ,
  effective_required INTEGER,
  visitor_facing BOOLEAN,
  adjudication_facing BOOLEAN,
  score INTEGER,
  target_score INTEGER,
  queue_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.task_id,
         c.agent_name, c.contributor_ip_hash, c.status,
         c.agree_count, c.disagree_count, c.unsure_count, c.created_at,
         COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) AS effective_required,
         (c.contribution_type = 'question_answer'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.source = 'web_request')) AS visitor_facing,
         (c.contribution_type = 'adjudication') AS adjudication_facing,
         c.score,
         -- 高風險型別分數到了但只有一台機器：對代理講「還差一票」（agy 審查 09-23）
         CASE WHEN c.score >= COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
                   AND contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2
              THEN c.score + 1 ELSE COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id)) END AS target_score,
         -- 沒有列的（觸發器與排程之間的十分鐘）用 created_at 頂著；別用 COALESCE 繞過佇列的理由見 000020，
         -- 驗證這邊不同：貢獻一進來就該能被驗，觸發器已經保證有列，這裡只是保險。
         d.queue_at AS queue_at
  -- 從快照驅動（2026-10-02）：照 queue_at 走 task_dispatches 的索引，逐筆用主鍵找貢獻，
  -- 走到 p_limit 就停。原本是把全部待驗證（約 2,931 筆）每筆算完再排序取 30 筆，實測 2.3 秒。
  -- 每筆待驗證一寫入就有 verify: 列（觸發器 trg_contribution_queue_row），排程再補漏，所以不會漏掉新貢獻。
  FROM task_dispatches d
  JOIN contributions c ON c.id = substring(d.task_id FROM 8)::uuid
  WHERE d.task_id LIKE 'verify:%'
    AND c.status = 'pending'
    AND (p_type IS NULL OR c.contribution_type = p_type)
    AND (p_region IS NULL OR c.payload->>'region' = p_region)
    AND c.contributor_ip_hash IS DISTINCT FROM p_ip_hash
    -- 過渡期（#484）：切換前自己交的（存單一 IP 的舊雜湊）也不派給自己
    AND (p_legacy_ip_hash IS NULL OR c.contributor_ip_hash IS DISTINCT FROM p_legacy_ip_hash)
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash)
    )
    -- 剛派給這台機器的不要再派（2026-09-21，見 000021）
    AND NOT EXISTS (
      SELECT 1 FROM verify_dispatches vd
      WHERE vd.contribution_id = c.id AND vd.ip_hash = p_ip_hash
        AND vd.dispatched_at > now() - interval '15 minutes'
    )
    -- 目標分數讀欄位（計票時寫），不逐筆呼叫函式；還沒計過票的（NULL）才現算
    AND (c.score < COALESCE(c.target_score, d.verify_target, contribution_effective_agree(c.id))
         OR (contribution_needs_two_ips(c.contribution_type, c.payload) AND c.voter_ips < 2))
    AND (
      c.contribution_type <> 'adjudication'
      OR NOT EXISTS (
        SELECT 1 FROM contributions o
        WHERE o.id::TEXT = c.payload->>'contribution_id'
          AND (
            (o.contributor_ip_hash = p_ip_hash OR o.contributor_ip_hash = p_legacy_ip_hash)
            OR EXISTS (
              SELECT 1 FROM contribution_votes v2
              WHERE v2.contribution_id = o.id AND (v2.verifier_ip_hash = p_ip_hash OR v2.verifier_ip_hash = p_legacy_ip_hash)
            )
          )
      )
    )
  ORDER BY d.queue_at ASC, d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
$$;
COMMENT ON FUNCTION contribution_verify_pool IS
  '驗證池：從 task_dispatches 照 queue_at 取，跳過不合格的，到 p_limit 就停。目標分數優先用欄位、其次快照（排程算），都沒有才現算。'
  '2026-10-02。2026-10-06（#349）兩台機器的型別改看 contribution_needs_two_ips（多了「中止」交接）。'
  '2026-10-09（#484）多 p_legacy_ip_hash：自交與投過票的排除（含裁決的原貢獻）新舊雜湊一起比；NULL＝與先前相同。';
