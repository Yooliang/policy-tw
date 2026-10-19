-- 站務 GA 數字另存一份到 Supabase 私有表（2026-10-20，policy-ops 工作單 #148）
-- ============================================================
--
-- 為什麼：console-fetch 每小時抓 GA4 寫進 Firestore（專案 policy-tw），Firestore 規則只准站長以 Google 登入讀，
-- 代理（與 Supabase 連線）讀不到正見的流量。維護者 10-20 同意另存一份：console-fetch 寫 Firestore 的同一份資料，
-- 另外 upsert 進下面三張表。Firestore 與主控台照舊，這裡只是第二份。
--
-- 私有：三張表都開 RLS、不建任何 policy，並且 REVOKE PUBLIC／anon／authenticated 的全部權限
-- （比照 20261009120000_verify_dispatches_private.sql：只刪 policy 時誤用 anon 會靜靜回空，REVOKE 讓誤用直接 permission denied）。
-- 只有 service_role（Edge Function 寫、維護者與代理用 Supabase 連線讀）能碰。守門：ga-console-store.test.ts。
--
-- 日期 date 是台灣時間的日曆日（console-fetch 的 dayOffset 以 UTC+8 算；GA 依資源本身的時區解讀這個日期字串）。
-- 數字欄位與 Firestore 同名同義：users＝activeUsers、sessions、views＝screenPageViews、
-- engagement_sec＝userEngagementDuration 總秒數、avg_engagement_sec＝每位使用者平均互動秒數（Firestore 的 avgEngagementSec）。

CREATE TABLE IF NOT EXISTS public.ga_daily (
  site               text        NOT NULL CHECK (site ~ '^[a-z]+$'),
  date               date        NOT NULL,
  property_id        text        NOT NULL,
  users              integer     NOT NULL DEFAULT 0,
  sessions           integer     NOT NULL DEFAULT 0,
  views              integer     NOT NULL DEFAULT 0,
  engagement_sec     numeric     NOT NULL DEFAULT 0,
  avg_engagement_sec numeric     NOT NULL DEFAULT 0,
  sources            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  landing            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pages              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pairs              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  hosts              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, date)
);
COMMENT ON TABLE public.ga_daily IS
  'GA4 逐日數字（console-fetch 每小時 upsert，回填 30 天；date 為台灣時間日期）。與 Firestore daily/{site}_{date} 同一份。私有：只有 service_role（#148）';

CREATE TABLE IF NOT EXISTS public.ga_summary (
  site               text        NOT NULL CHECK (site ~ '^[a-z]+$'),
  range              text        NOT NULL CHECK (range IN ('today', 'yesterday', 'last7', 'last30')),
  start_date         date        NOT NULL,
  end_date           date        NOT NULL,
  property_id        text        NOT NULL,
  users              integer     NOT NULL DEFAULT 0,
  sessions           integer     NOT NULL DEFAULT 0,
  views              integer     NOT NULL DEFAULT 0,
  engagement_sec     numeric     NOT NULL DEFAULT 0,
  avg_engagement_sec numeric     NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, range)
);
COMMENT ON TABLE public.ga_summary IS
  'GA4 今日／昨日／近 7 日／近 30 日（GA 直接算的不重複使用者，不是逐日加總；日期為台灣時間）。與 Firestore summary/{site} 同一份。私有：只有 service_role（#148）';

CREATE TABLE IF NOT EXISTS public.ga_search_terms (
  site          text        NOT NULL CHECK (site ~ '^[a-z]+$'),
  date          date        NOT NULL,
  term          text        NOT NULL,
  results_count text        NOT NULL DEFAULT '',
  event_count   integer     NOT NULL DEFAULT 0,
  users         integer     NOT NULL DEFAULT 0,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, date, term, results_count)
);
COMMENT ON TABLE public.ga_search_terms IS
  '站內搜尋詞：GA4 search 事件依 customEvent:search_term × customEvent:results_count 的逐日事件數與使用者數（近 30 天，台灣時間日期）。GA 沒登記自訂維度時不會有資料。results_count 空字串＝該維度沒登記。私有：只有 service_role（#148）';

CREATE INDEX IF NOT EXISTS ga_search_terms_date_idx ON public.ga_search_terms (site, date DESC);

ALTER TABLE public.ga_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga_summary      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga_search_terms ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ga_daily        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ga_summary      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ga_search_terms FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ga_daily        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ga_summary      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ga_search_terms TO service_role;

NOTIFY pgrst, 'reload schema';
