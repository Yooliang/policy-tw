-- 公報來源的政見：驗證目標分數 3 → 2、驗證者不用找第二來源（維護者 2026-11-11 裁示第 6 項）
--
-- 背景：待驗的政見幾乎都來自中選會選舉公報，官方來源只有那一份 PDF，系統不解析 PDF、拿不到系統票與 +2，每票只 +1 卻要 3 個代理；
-- 正式庫 618 筆卡在 2 票 1.73 分，有投的中位 0.5 分鐘，沒人真的在找第二來源。
-- 做法：contribution_required_agree 加風險等級 bulletin_policy（四欄皆 2）：policy 型別、source_urls 任一個是公報站
-- （source_doc_kind() = 'election_bulletin'，即 bulletin.cec.gov.tw／eebulletin.cec.gov.tw，與 TS source-archive.ts 的 BULLETIN_HOSTS 同一份）。
-- 只有首頁（路徑是 / 或空、沒有查詢字串）不算公報來源，對應 TS isSiteRoot。
-- 判斷放在 cand_no 之後、candidacy／correction 一般級之前。退件門檻（−3）、一張反對擋得住、系統票規則都不動。
-- 以 20261030130000 的現行定義為底，整支重寫。不重算既有 pending（下一次投票自然用新目標；同 20261029020000 的做法）。
-- 裁決：docs/decisions/2026-11-11-公報來源政見目標2不找第二來源.md　TS 鏡像：_shared/consensus.ts 的 isBulletinPolicy／riskLevel／AGREE_THRESHOLDS.bulletin_policy
-- 守門測試從函式名最後一次出現處往後解析，所以這段說明不放在函式後面。

CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'election_results' THEN 'batch_result'
    WHEN p_type = 'regional_stat' THEN 'regional_stat'
    WHEN p_type = 'cand_numbers' THEN 'cand_no'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'candidacy' AND p_payload->>'cand_no' ~ '^0*[1-9][0-9]{0,5}$' THEN 'cand_no'
    WHEN p_type = 'policy'
         AND EXISTS (SELECT 1 FROM unnest(coalesce(p_source_urls, ARRAY[]::TEXT[])) AS u WHERE source_doc_kind(btrim(u)) = 'election_bulletin' AND btrim(u) !~* '^https?://[^/?#]+/?$')
      THEN 'bulletin_policy'
    WHEN p_type = 'correction' AND correction_only_from_rumor(p_payload) THEN 'normal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'batch_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'regional_stat' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END
    WHEN v_risk = 'cand_no' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END
    WHEN v_risk = 'bulletin_policy' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 3
  END;
END;
$$;
