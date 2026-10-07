import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bulletinTitle,
  bulletinWatchUrl,
  classifyBulletinPage,
  parseWatchBody,
  parseWatchMode,
  runBulletinWatch,
  type WatchDeps,
  watchSucceeded,
} from "./bulletin-watch.ts";

// 公報上網日偵測：title 判斷（純函式＋2026-10-08 實測抓下來的兩個原頁）、整條流程（假的 fetch 與 RPC）、接線（函式、config.toml、migration 的排程與權限）。
const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url)).then((s) => s.replace(/\r\n/g, "\n"));
const HOME = await read("./fixtures/bulletin-home-no-dir-115.html"); // ?dir=115：那一年的資料夾還不存在 → 站回首頁
const DIR111 = await read("./fixtures/bulletin-dir-111.html"); // ?dir=111：資料夾存在

// ---------- title 判斷（純函式）----------

Deno.test("fixtures 是真的原頁：首頁的 title 是「首頁 - …」，111 的是「111 - …」（2026-10-08 實測，別拿手寫的片段充數）", () => {
  assertEquals(bulletinTitle(HOME), "首頁 - 中央選舉委員會選舉及公民投票公報");
  assertEquals(bulletinTitle(DIR111), "111 - 中央選舉委員會選舉及公民投票公報");
  assert(HOME.length > 5000 && DIR111.length > 10000, "是整頁 HTML，不是只剩 title 的片段");
  assert(DIR111.includes("?dir=111%2F02"), "111 的頁面有縣市資料夾的連結（資料夾真的存在的樣子）");
  assert(!HOME.includes("?dir=115"), "首頁沒有 115 的連結＝2026 的資料夾還沒上");
});

Deno.test("classifyBulletinPage：首頁＝absent（資料夾不存在）、「<年> - …」＝present", () => {
  assertEquals(classifyBulletinPage(HOME, "115"), "absent");
  assertEquals(classifyBulletinPage(DIR111, "111"), "present");
  // 同一個首頁，問 111 也是 absent（首頁就是首頁，跟問哪一年無關）
  assertEquals(classifyBulletinPage(HOME, "111"), "absent");
});

Deno.test("classifyBulletinPage：頁面是別年的資料夾（問 115 回 111）→ unknown，不能當成 115 出現了", () => {
  assertEquals(classifyBulletinPage(DIR111, "115"), "unknown");
  assertEquals(classifyBulletinPage(DIR111, "11"), "unknown");
  assertEquals(classifyBulletinPage(DIR111.replace("<title>111 -", "<title>1111 -"), "111"), "unknown");
});

Deno.test("classifyBulletinPage：認不得的頁面一律 unknown（錯誤頁、沒有 title、站改版、空字串），不是 absent", () => {
  assertEquals(classifyBulletinPage("", "115"), "unknown");
  assertEquals(classifyBulletinPage("<html><body>502 Bad Gateway</body></html>", "115"), "unknown");
  assertEquals(classifyBulletinPage("<title>502 Bad Gateway</title>", "115"), "unknown");
  assertEquals(classifyBulletinPage("<title></title>", "115"), "unknown");
  assertEquals(classifyBulletinPage("<title>首頁</title>", "115"), "unknown", "站名不對，不算首頁");
  assertEquals(classifyBulletinPage("<title>115 - 另一個網站</title>", "115"), "unknown", "站名不對，不算 115 出現");
  assertEquals(classifyBulletinPage(HOME.replace("首頁 - ", "Home - "), "115"), "unknown", "站把首頁標題改了：要被看見，不能吞成 absent");
  // dir 不是三位數字不拿去拼
  for (const bad of ["", "abc", "1150", ".*", "11 5"]) assertEquals(classifyBulletinPage(HOME, bad), "unknown", bad);
});

Deno.test("bulletinTitle：BOM、換行、實體、第一個 title（頁面裡後面的 title 字樣不算）", () => {
  assertEquals(bulletinTitle("﻿<html><head><title>\n  115  -  中央選舉委員會選舉及公民投票公報 \n</title></head>"), "115 - 中央選舉委員會選舉及公民投票公報");
  assertEquals(bulletinTitle("<TITLE>A&amp;B</TITLE>"), "A&B");
  assertEquals(bulletinTitle("<title>首頁 - X</title><svg><title>icon</title></svg>"), "首頁 - X");
  assertEquals(bulletinTitle("<p>沒有</p>"), null);
});

Deno.test("classifyBulletinPage：title 帶空白與換行也認得（站排版變動不影響）", () => {
  const spaced = "<title>\n   115   -   中央選舉委員會選舉及公民投票公報\n</title>";
  assertEquals(classifyBulletinPage(spaced, "115"), "present");
  assertEquals(classifyBulletinPage(spaced.replace("115", "首頁"), "115"), "absent");
});

// ---------- 要抓哪個網址 ----------

Deno.test("bulletinWatchUrl：只認 eebulletin.cec.gov.tw 的入口，網址由 bulletin_dir 組，不照抄 hint", () => {
  const hint = "https://eebulletin.cec.gov.tw/?dir=115 ← 中選會 2026（115 年）地方選舉公報";
  assertEquals(bulletinWatchUrl(hint, "115"), "https://eebulletin.cec.gov.tw/?dir=115");
  // hint 裡寫的資料夾與 dir 不同時以 dir 為準（dir 才是偵測的對象）
  assertEquals(bulletinWatchUrl(hint, "119"), "https://eebulletin.cec.gov.tw/?dir=119");
});

Deno.test("bulletinWatchUrl：別的站、非 https、沒有 hint、壞 dir 都回 null（不去抓）", () => {
  const central = "https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1 ← 中選會 2024 立委公報";
  assertEquals(bulletinWatchUrl(central, "113"), null, "立委公報在另一個站，標題規則沒量過");
  assertEquals(bulletinWatchUrl("http://eebulletin.cec.gov.tw/?dir=115 ← x", "115"), null);
  assertEquals(bulletinWatchUrl("https://eebulletin.cec.gov.tw.evil.example/?dir=115 ← x", "115"), null);
  assertEquals(bulletinWatchUrl("https://evil.example/?dir=115 ← https://eebulletin.cec.gov.tw/", "115"), null);
  assertEquals(bulletinWatchUrl(null, "115"), null);
  assertEquals(bulletinWatchUrl("", "115"), null);
  assertEquals(bulletinWatchUrl("說明文字沒有網址", "115"), null);
  assertEquals(bulletinWatchUrl("https://eebulletin.cec.gov.tw/?dir=115 ← x", null), null);
  assertEquals(bulletinWatchUrl("https://eebulletin.cec.gov.tw/?dir=115 ← x", "11"), null);
  assertEquals(bulletinWatchUrl("https://eebulletin.cec.gov.tw/?dir=115 ← x", "../x"), null);
});

Deno.test("parseWatchMode：預設 all，只收 all／hot", () => {
  assertEquals(parseWatchMode(undefined), "all");
  assertEquals(parseWatchMode(null), "all");
  assertEquals(parseWatchMode(""), "all");
  assertEquals(parseWatchMode("hot"), "hot");
  assertEquals(parseWatchMode("all"), "all");
  for (const bad of ["HOT", "daily", 1, true]) {
    let threw = false;
    try {
      parseWatchMode(bad);
    } catch {
      threw = true;
    }
    assert(threw, `mode=${String(bad)} 要丟錯`);
  }
});

Deno.test("parseWatchBody：空＝{}；JSON 物件收；null／陣列／字串／數字回「必須是 JSON 物件」；壞 JSON 回「不是合法的 JSON」", () => {
  assertEquals(parseWatchBody(""), { ok: true, body: {} });
  assertEquals(parseWatchBody("  \n"), { ok: true, body: {} });
  assertEquals(parseWatchBody('{"mode":"hot"}'), { ok: true, body: { mode: "hot" } });
  for (const bad of ["null", "[]", '["hot"]', '"hot"', "5", "true"]) assertEquals(parseWatchBody(bad), { ok: false, error: "body 必須是 JSON 物件" }, bad);
  for (const bad of ["{", "hot", "{mode:1}"]) assertEquals(parseWatchBody(bad), { ok: false, error: "body 不是合法的 JSON" }, bad);
});

// ---------- 整條流程（假 fetch、假 RPC）----------

const T2026 = { election_id: 2026, bulletin_dir: "115", bulletin_hint: "https://eebulletin.cec.gov.tw/?dir=115 ← 中選會 2026 公報" };
const T2022 = { election_id: 2022, bulletin_dir: "111", bulletin_hint: "https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022 公報" };

function fakeDeps(pages: Record<string, { status?: number; text?: string; throws?: string }>, markResult: () => Promise<string | null> = () => Promise.resolve("2026-11-12")) {
  const fetched: string[] = [];
  const marked: Array<{ election_id: number; url: string; title: string }> = [];
  const deps: WatchDeps = {
    fetchPage: (url) => {
      fetched.push(url);
      const p = pages[url];
      if (!p) return Promise.reject(new Error("no such fake page"));
      if (p.throws) return Promise.reject(new Error(p.throws));
      return Promise.resolve({ status: p.status ?? 200, text: p.text ?? "" });
    },
    markPublished: (t) => {
      marked.push(t);
      return markResult();
    },
  };
  return { deps, fetched, marked };
}

Deno.test("流程：2026 還在首頁（資料夾沒出現）→ absent、不記任何東西", async () => {
  const f = fakeDeps({ "https://eebulletin.cec.gov.tw/?dir=115": { text: HOME } });
  const out = await runBulletinWatch([T2026], f.deps);
  assertEquals(out, [{ election_id: 2026, dir: "115", state: "absent" }]);
  assertEquals(f.fetched, ["https://eebulletin.cec.gov.tw/?dir=115"]);
  assertEquals(f.marked, []);
  assert(watchSucceeded(out));
});

Deno.test("流程：資料夾出現（title＝「115 - …」）→ 記下實際上網日，帶網址與頁面標題", async () => {
  const page115 = DIR111.replace("<title>111 -", "<title>115 -"); // 111 的真頁換成 115 的標題＝資料夾出現後的樣子
  const f = fakeDeps({ "https://eebulletin.cec.gov.tw/?dir=115": { text: page115 } });
  const out = await runBulletinWatch([T2026], f.deps);
  assertEquals(out, [{ election_id: 2026, dir: "115", state: "present", marked_on: "2026-11-12" }]);
  assertEquals(f.marked, [{ election_id: 2026, url: "https://eebulletin.cec.gov.tw/?dir=115", title: "115 - 中央選舉委員會選舉及公民投票公報" }]);
  assert(watchSucceeded(out));
});

Deno.test("流程：多個選舉各自判斷，一個抓不到不影響其他的；有 unknown 就不算成功", async () => {
  const f = fakeDeps({
    "https://eebulletin.cec.gov.tw/?dir=115": { throws: "timeout" },
    "https://eebulletin.cec.gov.tw/?dir=111": { text: DIR111 },
  });
  const out = await runBulletinWatch([T2026, T2022], f.deps);
  assertEquals(out[0], { election_id: 2026, dir: "115", state: "unknown", reason: "抓取失敗：timeout" });
  assertEquals(out[1], { election_id: 2022, dir: "111", state: "present", marked_on: "2026-11-12" });
  assertEquals(f.marked.map((m) => m.election_id), [2022]);
  assert(!watchSucceeded(out));
});

Deno.test("流程：HTTP 不是 200（站掛了、被擋）→ unknown，不拿錯誤頁判斷、不記錄", async () => {
  const f = fakeDeps({ "https://eebulletin.cec.gov.tw/?dir=115": { status: 503, text: HOME } });
  const out = await runBulletinWatch([T2026], f.deps);
  assertEquals(out, [{ election_id: 2026, dir: "115", state: "unknown", reason: "HTTP 503" }]);
  assertEquals(f.marked, []);
  assert(!watchSucceeded(out));
});

Deno.test("流程：頁面標題認不得（站改版）→ unknown，不記錄也不當成還沒出現", async () => {
  const f = fakeDeps({ "https://eebulletin.cec.gov.tw/?dir=115": { text: "<html><title>系統維護中</title></html>" } });
  const out = await runBulletinWatch([T2026], f.deps);
  assertEquals(out.length, 1);
  assertEquals(out[0].state, "unknown");
  assert(out[0].state === "unknown" && out[0].reason.includes("系統維護中"));
  assertEquals(f.marked, []);
  assert(!watchSucceeded(out));
});

Deno.test("流程：資料夾已出現但記錄失敗（RPC 出錯）→ unknown，下次排程會再試", async () => {
  const f = fakeDeps({ "https://eebulletin.cec.gov.tw/?dir=111": { text: DIR111 } }, () => Promise.reject(new Error("rpc down")));
  const out = await runBulletinWatch([T2022], f.deps);
  assertEquals(out, [{ election_id: 2022, dir: "111", state: "unknown", reason: "資料夾已出現但記錄失敗：rpc down" }]);
  assert(!watchSucceeded(out));
});

Deno.test("流程：公報入口不是 eebulletin（2024 立委）→ skipped，連網都不連；skipped 不算失敗", async () => {
  const f = fakeDeps({});
  const out = await runBulletinWatch([{ election_id: 2024, bulletin_dir: "113", bulletin_hint: "https://bulletin.cec.gov.tw/?dir=x ← 立委公報" }, { election_id: 7, bulletin_dir: null, bulletin_hint: null }], f.deps);
  assertEquals(out.map((o) => o.state), ["skipped", "skipped"]);
  assertEquals(f.fetched, []);
  assert(watchSucceeded(out));
});

Deno.test("流程：沒有目標（hot 模式在窗口外）→ 什麼都不做、算成功", async () => {
  const f = fakeDeps({});
  const out = await runBulletinWatch([], f.deps);
  assertEquals(out, []);
  assertEquals(f.fetched, []);
  assert(watchSucceeded(out));
});

// ---------- 接線：函式、config.toml、migration ----------

const idx = await read("../bulletin-watch/index.ts");
const cfg = await read("../../config.toml");
const mig = await read("../../migrations/20261008113000_bulletin_watch.sql");
const code = (sql: string) => sql.replace(/--.*$/gm, "");

Deno.test("bulletin-watch：POST 才收，而且在查任何東西、抓任何網頁之前先驗呼叫者", () => {
  const verify = idx.indexOf("verifyCaller(");
  assert(verify > 0, "index.ts 要呼叫 verifyCaller");
  const reject = idx.indexOf("if (!check.ok) return json(");
  assert(reject > verify, "驗證沒過要直接回應、不能往下做（拿掉這一行等於公開）");
  for (const later of ['rpc("bulletin_watch_targets"', "runBulletinWatch(", "fetchPage,", 'rpc("bulletin_watch_mark_published"']) {
    const at = idx.indexOf(later);
    assert(at > reject, `${later} 要排在驗證之後`);
  }
  assert(idx.includes('req.method !== "POST"'), "只收 POST");
  assert(/createClient\(supabaseUrl, serviceRoleKey\)\s*\.rpc\("bulletin_watch_cron_secret_ok", \{ p_secret: secret \}\)/.test(idx), "x-cron-secret 交給資料庫比對");
  assert(!/BULLETIN_WATCH_CRON_SECRET/.test(idx), "函式端不持有密鑰（只在 Vault）");
});

Deno.test("bulletin-watch：函式呼叫的 RPC 名稱與參數，都在 migration 裡有定義、參數名一致", () => {
  const body = code(mig);
  assert(/FUNCTION public\.bulletin_watch_targets\(p_hot BOOLEAN/.test(body) && idx.includes('{ p_hot: mode === "hot" }'));
  assert(/FUNCTION public\.bulletin_watch_mark_published\(p_election_id INTEGER, p_url TEXT, p_title TEXT\)/.test(body) &&
    idx.includes("{ p_election_id: election_id, p_url: url, p_title: title }"));
  assert(/FUNCTION public\.bulletin_watch_cron_secret_ok\(p_secret text\)/.test(body));
  // 寫入只走 RPC：函式端沒有直接寫表
  assert(!/\.from\(["'`]/.test(idx), "index.ts 不直接讀寫表，一律走 RPC");
  assert(!/\.(insert|update|upsert|delete)\(/.test(idx), "index.ts 不直接寫表");
});

Deno.test("bulletin-watch：body 解析在驗證之後、查目標之前，錯誤一律回 400（不靠外層 catch）", () => {
  const reject = idx.indexOf("if (!check.ok) return json(");
  const parse = idx.indexOf("parseWatchBody(await req.text())");
  const targets = idx.indexOf('rpc("bulletin_watch_targets"');
  assert(reject > 0 && parse > reject && targets > parse);
  assert(idx.includes("if (!parsedBody.ok) return json({ success: false, error: parsedBody.error }, 400);"));
  assert(!idx.includes("JSON.parse("), "解析集中在 parseWatchBody，index.ts 不再自己 JSON.parse");
});

Deno.test("健康檢查視圖：新定義＝P1 的 activity_health 加 bulletin_milestone_missing 一段，其餘一字不差", async () => {
  const p1 = await read("../../migrations/20261008060000_activity_windows_p1.sql");
  const view = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE VIEW activity_health AS"), sql.indexOf(";\nCOMMENT ON VIEW activity_health"));
  const seg = /  UNION ALL\n  SELECT 'bulletin_milestone_missing'[\s\S]*?\n(?=  UNION ALL\n  SELECT 'clock_overridden')/;
  const mine = view(mig);
  assert(seg.test(mine), "要有 bulletin_milestone_missing 這一段，且在 clock_overridden 之前");
  assertEquals(mine.replace(seg, ""), view(p1));
  assertEquals((mig.match(/CREATE OR REPLACE VIEW activity_health/g) ?? []).length, 1);
});

Deno.test("bulletin-watch：config.toml 有登記，verify_jwt 關（pg_cron 不帶 JWT），entrypoint 指對", () => {
  const m = /\[functions\.bulletin-watch\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
  assert(m, "config.toml 要有 [functions.bulletin-watch]");
  assert(/verify_jwt = false/.test(m[1]));
  assert(m[1].includes('entrypoint = "./functions/bulletin-watch/index.ts"'));
  assert(/enabled = true/.test(m[1]));
});

Deno.test("bulletin-watch 排程：每天一次看全部、每小時看預估日前後；都打 bulletin-watch、帶 Vault 裡的 x-cron-secret、migration 裡沒有任何金鑰值", () => {
  const body = code(mig);
  assert(body.includes("cron.schedule('bulletin-watch-daily', '23 1 * * *'"), "每天 01:23 UTC（台北 09:23）");
  assert(body.includes("cron.schedule('bulletin-watch-hot', '41 * * * *'"), "每小時第 41 分");
  assert(body.includes(`body := '{"mode":"all"}'::jsonb`) && body.includes(`body := '{"mode":"hot"}'::jsonb`), "兩條排程各帶自己的 mode");
  const urls = body.match(/url := '[^']+'/g) ?? [];
  assertEquals(urls, ["url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/bulletin-watch'", "url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/bulletin-watch'"]);
  assertEquals((body.match(/'x-cron-secret', COALESCE\(\(SELECT decrypted_secret FROM vault\.decrypted_secrets WHERE name = 'bulletin_watch_cron_secret' LIMIT 1\), ''\)/g) ?? []).length, 2, "兩條都從 Vault 讀自己的密鑰，沒有時帶空字串（函式回 401）");
  assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(body), "不得有 JWT");
  assert(!/bearer\s+[A-Za-z0-9]/i.test(body), "SQL 本體不得寫死 Bearer");
  assert(!/create_secret\(\s*'/.test(body), "不得用寫死的字串建立 secret（值不進版控）");
  // 重複套用安全：先 unschedule（存在才做）再 schedule
  for (const name of ["bulletin-watch-daily", "bulletin-watch-hot"]) {
    assert(body.includes(`cron.unschedule('${name}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${name}')`), `${name} 要先 unschedule 再 schedule`);
  }
});

Deno.test("bulletin-watch：CI 的部署清單會包含它（index.ts 的相對 import 追得到 _shared）", () => {
  assert(idx.includes('from "../_shared/bulletin-watch.ts"') && idx.includes('from "../_shared/console-fetch-auth.ts"'));
});

Deno.test("單一真相：2026 預估列由 migration 從 elections.bulletin_published_on 回填，欄位之後只由觸發器寫（行為在 bulletin-watch-db.test.ts）", () => {
  const body = code(mig);
  assert(body.includes("CREATE TRIGGER trg_election_milestones_bulletin_sync AFTER INSERT OR UPDATE OR DELETE ON election_milestones"));
  assert(body.includes("CREATE TRIGGER trg_elections_bulletin_column_guard BEFORE INSERT OR UPDATE OF bulletin_published_on ON elections"));
  // migration 裡沒有任何一句直接把 2026 的日期寫進 elections（只有觸發器函式內的同步）
  const updates = body.match(/UPDATE elections SET bulletin_published_on[^;]*;/g) ?? [];
  assertEquals(updates.length, 2, "只有同步觸發器函式裡那兩句（設值、回到 NULL）寫這個欄位");
});
