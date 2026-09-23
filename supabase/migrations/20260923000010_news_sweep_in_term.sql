-- 新聞掃描任務的做法把「任內施政承諾」講進去（小良哥 2026-09-23，協議 1.28.0）
-- 例：2024 年當選的總統在 2026 年宣布普發一萬——不是競選承諾，是這一任要做的事，也要追蹤。
-- 原本只寫「2026 候選人具體政見、既有政見新進度」，現任者任內新宣布的承諾沒有位置。函式其餘照 migrations\20260912000030_news_sweep.sql。

CREATE OR REPLACE FUNCTION news_sweep_refresh_tasks() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  f RECORD;
  v_open_id UUID;
  v_created INTEGER := 0;
BEGIN
  FOR f IN SELECT * FROM news_sweep_feeds WHERE enabled ORDER BY id LOOP
    SELECT id INTO v_open_id
    FROM contribution_tasks
    WHERE task_type = 'news_sweep' AND status = 'open' AND target->>'feed_url' = f.feed_url
    ORDER BY created_at DESC LIMIT 1;

    IF v_open_id IS NOT NULL THEN
      -- 還在冷卻期內就什麼都不做
      IF EXISTS (
        SELECT 1 FROM contribution_tasks
        WHERE id = v_open_id AND created_at > now() - (f.recheck_hours || ' hours')::INTERVAL
      ) THEN
        CONTINUE;
      END IF;
      -- 逾期了：關掉舊的
      UPDATE contribution_tasks SET status = 'closed' WHERE id = v_open_id;
    END IF;

    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, source, created_by)
    VALUES (
      '掃 ' || f.label || ' 找新政見',
      '打開 ' || f.feed_url || '（RSS，最新 20～40 筆），挑出提到 2026 候選人「具體政見」、現任者在任內新宣布的「具體施政承諾」（例：總統宣布普發現金、市長宣布新計畫），或既有政見「新進度」的報導。'
        || '每一筆分開提交：新政見用 policy，既有政見的新進度用 policy_progress。'
        || '任內施政承諾用 policy，status 填 Proposed、election_id 填他這一任當選那屆、proposed_date 填宣布日——不是競選承諾，不要填 Campaign Pledge。'
        || 'source_urls 一律放新聞原文網址（RSS 裡 <link> 的值，不是這個 RSS 網址、不是搜尋結果、不是轉貼）。'
        || '只收具體承諾與可查證的進度；民調、評論、行程、站台花絮不要收。一則報導提到多個人就分成多筆。'
        || '提交前先用 lookup 看那個人現有的政見，同一個承諾換句話說不要再送一次。'
        || '看完沒有可提交的就用 no_change 回報，note 寫你看了幾筆、為什麼都不符合——那也是成果，會關掉這筆任務。',
      'news_sweep',
      jsonb_build_object('feed_url', f.feed_url, 'label', f.label, 'recheck_hours', f.recheck_hours),
      NULL,
      1,
      2,
      'manual',
      'news_sweep_refresh_tasks'
    );
    v_created := v_created + 1;
  END LOOP;
  RETURN v_created;
END;
$$;
