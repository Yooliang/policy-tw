import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyCaller } from "../_shared/console-fetch-auth.ts";
import { siteUrl } from "../_shared/site.ts";
import {
  type FetchedPage,
  parseWatchBody,
  parseWatchMode,
  runBulletinWatch,
  type WatchTarget,
  watchSucceeded,
} from "../_shared/bulletin-watch.ts";

/**
 * bulletin-watch — 偵測中選會公報站某一屆的資料夾出現了沒，出現就記下實際上網日（2026-10-08）。
 *
 * 流程：RPC bulletin_watch_targets 列出「公報上架日還是預估、或還沒到」的選舉 → 逐一抓 https://eebulletin.cec.gov.tw/?dir=<民國年>，
 * 用 <title> 判斷資料夾存在與否（_shared/bulletin-watch.ts）→ 存在就呼叫 RPC bulletin_watch_mark_published，
 * 把 election_milestones 的 bulletin_published 那一列改成實際日期、status=done、basis=official
 * （elections.bulletin_published_on 由觸發器跟著變，任務說明的公報入口就從那天開始給）。
 *
 * 寫入走資料庫的 SECURITY DEFINER RPC（只授權 service_role），不是在這裡直接寫表；每次異動 election_milestones 的審計觸發器記一筆 edit_history。
 * 這是系統對官方網站的機械觀察，沒有判斷空間，所以不走貢獻投票（先例：cec-sync 用 service role 寫 elections.turnout、election_districts）。
 *
 * 呼叫者驗證照 console-fetch：x-cron-secret（密鑰只在 Vault，函式用 RPC bulletin_watch_cron_secret_ok 請資料庫比對）或 service role bearer。
 * 驗證邏輯本身就用 _shared/console-fetch-auth.ts（與哪支函式無關的通用實作）。
 *
 * 請求 body（可省略）：{ mode?: "all" | "hot" }。all＝所有還沒確定上架日的選舉（每天一次那條排程）；
 * hot＝只看預估上架日前後各 14 天內的（每小時那條排程）。
 * 回應：{ success, mode, checked: [{ election_id, dir, state, … }], elapsed_ms }。有任何一個選舉狀態是 unknown（抓不到、錯誤頁、標題格式認不得）回 502。
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FETCH_TIMEOUT_MS = 20_000;

async function fetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { "User-Agent": `policy-tw-bulletin-watch/1.0 (+${siteUrl()})`, "Accept": "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const check = await verifyCaller(req.headers, {
    serviceRoleKey,
    checkCronSecret: serviceRoleKey && supabaseUrl
      ? async (secret) => {
        const { data, error } = await createClient(supabaseUrl, serviceRoleKey).rpc("bulletin_watch_cron_secret_ok", { p_secret: secret });
        if (error) throw new Error(error.message);
        return data === true;
      }
      : undefined,
  });
  if (!check.ok) return json({ success: false, error: check.error }, check.status);
  if (!serviceRoleKey || !supabaseUrl) return json({ success: false, error: "缺少 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const started = Date.now();
  const parsedBody = parseWatchBody(await req.text());
  if (!parsedBody.ok) return json({ success: false, error: parsedBody.error }, 400);
  const body = parsedBody.body;
  let mode: "all" | "hot";
  try {
    mode = parseWatchMode(body.mode);
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: targets, error: tErr } = await supabase.rpc("bulletin_watch_targets", { p_hot: mode === "hot" });
  if (tErr) {
    console.error("bulletin-watch：取目標失敗：", tErr.message);
    return json({ success: false, mode, error: `取目標失敗：${tErr.message}`, elapsed_ms: Date.now() - started }, 500);
  }

  const checked = await runBulletinWatch((targets ?? []) as WatchTarget[], {
    fetchPage,
    markPublished: async ({ election_id, url, title }) => {
      const { data, error } = await supabase.rpc("bulletin_watch_mark_published", { p_election_id: election_id, p_url: url, p_title: title });
      if (error) throw new Error(error.message);
      return typeof data === "string" ? data : null;
    },
  });
  const success = watchSucceeded(checked);
  for (const c of checked) if (c.state === "unknown") console.error(`bulletin-watch：選舉 ${c.election_id}（dir=${c.dir}）狀態不明：${c.reason}`);
  return json({ success, mode, checked, elapsed_ms: Date.now() - started }, success ? 200 : 502);
});
