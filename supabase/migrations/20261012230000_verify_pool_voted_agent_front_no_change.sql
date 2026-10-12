-- 驗證池排除「同代號已投過」＋網站請求的「查無」回報驗證排前段（2026-10-13，主線配號前暫用此時間戳）。
--
-- 現象（10-12 23:00Z 主控台）：最近 30 分鐘派出 110 筆全是驗證、任務 0 筆；佇列最前面 14 張網站請求任務一直沒派出。
-- 唯讀查正式庫的原因：
--   1. 那 14 張本身不合格：9 張底下有一筆還在等票的「查無」回報（no_change，/next 的 filterReportedDeadEnds 等它定案），
--      5 張底下已有 5 筆政見在等票（TASK_INFLIGHT_CAP）。所以 /next 往下看，前段的驗證列（1970 段）比其餘任務都前面，全派驗證。
--   2. 前段那批驗證是網站請求的交件，只剩 QiLiang、小雯、a-zhen 三個代號在驗；它們換出口網段後，驗證池（只比網段）
--      又把自己投過的派回來——最近一小時派給 QiLiang／小雯的 143 筆有 127 筆是同代號早就投過的，只能 skip 或 409
--      （投票表有唯一索引（貢獻, 代號））。verify_front_keep 讓這些列一直留在前段，於是整群代理繞著同一批打轉。
--   3. 那 9 筆「查無」回報 task_id 欄是空的（任務編號只在 payload.task_id），contribution_queue_at 看不出它是網站請求，
--      驗證列排在一般段（09-24 的位置），10-10 之後一次都沒再派出，擋著的訪客任務也就一直不派。
--
-- 做法（只動正見自己的函式；contribution_queue_at、contribution_queue_row 日本站有逐字抄本，不碰）：
--   A. contribution_verify_pool：投過票的排除多比代號（大小寫不分），沒傳 p_agent_name＝與前一版相同。現行定義（20261011020000）做一處機械替換。
--   B. verify_front_keep：判斷前段時，任務編號用 COALESCE(task_id, payload->>'task_id')。
--   C. 新增 BEFORE INSERT 觸發器：新的驗證列若屬前段（同 B 的判準）而 queue_at 在 2000 年以後，入列就排到前段最後面
--      （contribution_queue_row 用 task_id 欄判斷，查無回報入列時落在一般段）。
--   D. 既有的：等票中、屬前段、但排在 2000 年以後的驗證列，照交件時間一次拉回前段（同 20261010130000 的做法）。

CREATE OR REPLACE FUNCTION contribution_verify_pool(
  p_ip_hash TEXT,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 30,
  p_type TEXT DEFAULT NULL,
  p_legacy_ip_hash TEXT DEFAULT NULL,
  p_agent_name TEXT DEFAULT NULL
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
    -- 同代號自己交的也不派給自己（policy-ops#70）：以前只有 TS 在 LIMIT 之後才濾，前段集中同代號時別的網段的同代號機器會拿不到
    AND (p_agent_name IS NULL OR lower(c.agent_name) <> lower(p_agent_name))
    AND NOT EXISTS (
      SELECT 1 FROM contribution_votes v
      WHERE v.contribution_id = c.id AND (v.verifier_ip_hash = p_ip_hash OR v.verifier_ip_hash = p_legacy_ip_hash
        -- 同代號在別的網段投過的也不派（2026-10-13）：投票有唯一索引 contribution_votes_one_per_agent（貢獻, 代號），
        -- 換了出口網段的同代號拿到也只能 409 already_voted 或 skip，而網站請求的驗證列一直留在前段，會被反覆派回來
        OR (p_agent_name IS NOT NULL AND lower(v.agent_name) = lower(p_agent_name)))
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
            OR (p_agent_name IS NOT NULL AND lower(o.agent_name) = lower(p_agent_name))
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
  '2026-10-09（#484）多 p_legacy_ip_hash：自交與投過票的排除（含裁決的原貢獻）新舊雜湊一起比；NULL＝與先前相同。'
  '2026-10-10（policy-ops#70）多 p_agent_name：同代號（含裁決原貢獻的代號）在 SQL、LIMIT 之前排除；NULL＝與先前相同。'
  '2026-10-13：同代號已投過票的也排除（投票表唯一索引是（貢獻, 代號），換網段的同代號派到也投不進去）。';

-- 前段判準：跟入列同一份（contribution_queue_at），只是任務編號在 task_id 欄空著時改看 payload.task_id（查無回報就是這樣交的）
CREATE OR REPLACE FUNCTION verify_row_is_front(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT contribution_queue_at(c.contribution_type, COALESCE(c.task_id, c.payload->>'task_id'), c.created_at) < TIMESTAMPTZ '2000-01-01'
      FROM contributions c
     -- 走主鍵；task_id 後段不是 uuid 的（不該有）就當不是這一類
     WHERE c.id = CASE WHEN substr(p_task_id, 8) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN substr(p_task_id, 8)::uuid END
       AND c.status = 'pending'), false);
$$;
COMMENT ON FUNCTION verify_row_is_front IS
  '驗證列（verify:<貢獻 id>）是否屬前段：貢獻在等票，且是公民提問的回答或網站請求的交件（含任務編號只在 payload.task_id 的查無回報）。2026-10-13';

-- 前段最後面（1970 段裡驗證列的最大 queue_at ＋ 1 秒）
CREATE OR REPLACE FUNCTION verify_front_tail() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT max(d.queue_at) FROM task_dispatches d
                    WHERE d.task_id LIKE 'verify:%'
                      AND d.queue_at >= TIMESTAMPTZ '1970-01-01' AND d.queue_at < TIMESTAMPTZ '1971-01-01'),
                  TIMESTAMPTZ '1970-01-01') + INTERVAL '1 second';
$$;

-- B：派出後留在前段（判準改用 verify_row_is_front，其餘同 20261010130000）
CREATE OR REPLACE FUNCTION verify_front_keep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF verify_row_is_front(NEW.task_id) THEN
    NEW.queue_at := verify_front_tail();
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION verify_front_keep IS
  '網站請求與公民提問的交件還在等票時，驗證列派出後留在前段輪流、不回隊尾（OPS #68，2026-10-10）；2026-10-13 起查無回報（任務編號在 payload）也算';

-- C：入列就排前段
CREATE OR REPLACE FUNCTION verify_front_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF verify_row_is_front(NEW.task_id) THEN
    NEW.queue_at := verify_front_tail();
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION verify_front_insert IS
  '驗證列入列時若屬前段（verify_row_is_front）而排在 2000 年以後，改排到前段最後面。2026-10-13';

DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front_insert ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_verify_front_insert
  BEFORE INSERT ON task_dispatches
  FOR EACH ROW
  WHEN (NEW.task_id LIKE 'verify:%' AND NEW.queue_at >= TIMESTAMPTZ '2000-01-01')
  EXECUTE FUNCTION verify_front_insert();

-- D：既有的拉回前段，照交件時間先後排在 1970 段驗證列的後面（UPDATE 觸發器不攔：dispatch_count 沒變）
WITH base AS (
  SELECT verify_front_tail() - INTERVAL '1 second' AS t
), back AS (
  SELECT d.task_id, row_number() OVER (ORDER BY c.created_at, c.id) AS rn
    FROM task_dispatches d
    JOIN contributions c ON 'verify:' || c.id = d.task_id
   WHERE c.status = 'pending' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
     AND contribution_queue_at(c.contribution_type, COALESCE(c.task_id, c.payload->>'task_id'), c.created_at) < TIMESTAMPTZ '2000-01-01'
)
UPDATE task_dispatches d SET queue_at = (SELECT t FROM base) + back.rn * INTERVAL '1 second'
  FROM back WHERE d.task_id = back.task_id;

-- 自我檢查：等票中的這一類沒有一列還在隊尾
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task_dispatches d JOIN contributions c ON 'verify:' || c.id = d.task_id
              WHERE c.status = 'pending' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
                AND contribution_queue_at(c.contribution_type, COALESCE(c.task_id, c.payload->>'task_id'), c.created_at) < TIMESTAMPTZ '2000-01-01') THEN
    RAISE EXCEPTION '網站請求／公民提問（含查無回報）的等票驗證列還有排在隊尾的';
  END IF;
END $$;
