import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { jpContributionScore, jpElectionIdOf, jpElectionIdsNeedingName, jpPayloadForSummary, jpSummarizeContribution, JP_SCORE_COLUMNS } from "./jp/contribution-feed.ts";
import { JP_PROTOCOL_URL } from "./jp/protocol.ts";

/**
 * 日本站貢獻看板（jp-contributions-feed）的測試。
 *   1. 走樣守門：jp-contributions-feed/index.ts 是正見 contributions-feed/index.ts 的照搬，只有標 `jp-only:begin`～`jp-only:end` 的區段不同。
 *      這裡把日本站那些區段拿掉、把正見對應的區段（下面 TW_SPANS，一一對應）拿掉，其餘逐行比對（忽略空行與行首縮排）；
 *      正見改了任何一行，這裡就紅，提醒日本站跟著改。區段的數量與順序要一致，所以日本站多開一個區段而這裡沒登記也會紅。
 *   2. 入口行為：真的載入入口、用真的 Request 打進去，底下是假的 PostgREST；每個請求都要帶 policy_jp 標頭。
 *   3. 純函式：分數欄位、選舉名稱解析、摘要。
 */

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

// ---- 1. 走樣守門 ----

/** 正見那支裡「日本站換掉的區段」：從 from 那行到 to 那行（含）；toExclusive＝到 to 那行之前（不含）。找不到或找到多於一處都算失敗 */
interface Span { from: string; to: string; toExclusive?: boolean; why: string }
const TW_SPANS: Span[] = [
  { from: 'import "jsr:@supabase/functions-js/edge-runtime.d.ts";', to: "*/", why: "檔頭與 import" },
  { from: "const supabase = createClient(", to: "const supabase = createClient(", why: "client 固定 schema policy_jp" },
  { from: "// 代理可以用 politician_id 取代姓名提交。", to: "// 交件的網址在出處表的等級", toExclusive: true, why: "標題解析（政策、人物、參選紀錄）" },
  { from: "const raw = (r.payload", to: "const s = summarizeContribution(", why: "摘要的 payload 補名稱與摘要本身" },
  { from: 'console.error("contributions-feed error:"', to: 'console.error("contributions-feed error:"', why: "日誌名稱" },
];

/** 拿掉空行、行首縮排與行尾空白，剩下要逐行相同 */
const norm = (lines: string[]) => lines.map((l) => l.trim()).filter((l) => l !== "");

export function cutTwSpans(src: string, spans: readonly Span[]): string[] {
  let lines = src.split("\n");
  for (const sp of spans) {
    const starts = lines.flatMap((l, i) => (l.trim().startsWith(sp.from) ? [i] : []));
    assertEquals(starts.length, 1, `正見的「${sp.why}」起點（${sp.from}）應該剛好出現一次，實際 ${starts.length} 次`);
    const i = starts[0];
    let j = i;
    if (sp.to !== sp.from) {
      j = lines.findIndex((l, k) => k >= i && l.trim().startsWith(sp.to));
      assert(j >= 0, `正見的「${sp.why}」終點（${sp.to}）找不到`);
    }
    lines = [...lines.slice(0, i), ...lines.slice(sp.toExclusive ? j : j + 1)];
  }
  return lines;
}

export function cutJpBlocks(src: string): { rest: string[]; blocks: number; unbalanced: boolean } {
  const rest: string[] = [];
  let open = false;
  let blocks = 0;
  let unbalanced = false;
  for (const l of src.split("\n")) {
    const t = l.trim();
    if (t.startsWith("// jp-only:begin")) { if (open) unbalanced = true; open = true; blocks++; continue; }
    if (t.startsWith("// jp-only:end")) { if (!open) unbalanced = true; open = false; continue; }
    if (!open) rest.push(l);
  }
  return { rest, blocks, unbalanced: unbalanced || open };
}

/** 回傳正見與日本站去掉專屬區段後的差異（空陣列＝一致） */
export function feedDrift(tw: string, jp: string): string[] {
  const j = cutJpBlocks(jp);
  if (j.unbalanced) return ["jp-only:begin／end 沒有成對"];
  if (j.blocks !== TW_SPANS.length) return [`日本站有 ${j.blocks} 個 jp-only 區段，但守門登記了 ${TW_SPANS.length} 個正見區段：新增或減少區段要同步改 TW_SPANS`];
  const a = norm(cutTwSpans(tw, TW_SPANS));
  const b = norm(j.rest);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { out.push(`第 ${i + 1} 行（去掉專屬區段後）不同\n  正見：${a[i] ?? "（沒有）"}\n  日本：${b[i] ?? "（沒有）"}`); if (out.length >= 3) break; }
  }
  return out;
}

const TW_FILE = "../contributions-feed/index.ts";
const JP_FILE = "../jp-contributions-feed/index.ts";

Deno.test("走樣守門：jp-contributions-feed 去掉日本專屬區段後，跟 contributions-feed 逐行相同", async () => {
  assertEquals(feedDrift(await read(TW_FILE), await read(JP_FILE)), [], "正見的 contributions-feed 改了，日本站的 jp-contributions-feed 要跟著改（或把差異標成 jp-only 並登記 TW_SPANS）");
});

Deno.test("走樣守門：偵測器本身——正見改一行、日本站私自改一行、區段不成對、區段數不符都抓得到", async () => {
  const tw = await read(TW_FILE);
  const jp = await read(JP_FILE);
  // 正見改了 FEED_COLUMNS
  assert(feedDrift(tw.replace("agree_count, disagree_count,", "agree_count, disagree_count, extra_col,"), jp).length > 0);
  // 正見的 status 驗證改了
  assert(feedDrift(tw.replace('status !== "voting"', 'status !== "voting2"'), jp).length > 0);
  // 日本站在區段外私自改一行（把 limit 上限 50 改 100）
  assert(feedDrift(tw, jp.replace("Math.min(Math.max(Number(url.searchParams.get(\"limit\")) || 20, 1), 50)", "Math.min(Math.max(Number(url.searchParams.get(\"limit\")) || 20, 1), 100)")).length > 0);
  // 日本站多拿掉 end
  assert(feedDrift(tw, jp.replace("// jp-only:end", "")).length > 0);
  // 日本站多開一個區段
  assert(feedDrift(tw, jp.replace("const hasMore =", "// jp-only:begin x\nconst hasMore =\n// jp-only:end")).length > 0);
  // 還原後是綠的
  assertEquals(feedDrift(tw, jp), []);
});

Deno.test("日本站這支：公開唯讀、走 jpClient、分數走 contributionScore／SCORE_COLUMNS、不碰正見的表與雜湊", async () => {
  const jp = await read(JP_FILE);
  assert(jp.includes("照搬 contributions-feed，只換 schema 與標題解析；改正見那支時這支要跟著改"));
  assert(jp.includes("jpClient("), "client 要走 jpClient（schema policy_jp）");
  assert(!jp.includes("createClient("), "不得直接 createClient（會讀到 public）");
  assert(jp.includes("contributionScore(") && jp.includes("SCORE_COLUMNS"), "分數走共用的 contributionScore／SCORE_COLUMNS");
  for (const table of ["policies", "politician_elections", "politicians"]) assert(!jp.includes(`from("${table}")`), `不得查正見的 ${table}`);
  assert(!/contributor_ip_hash|payload_hash|voter_ips/.test(jp.replace(/\/\*[\s\S]*?\*\//g, "")), "select 欄位不含任何雜湊");
});

// ---- 2. 入口行為 ----

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" } as Record<string, string>;
type Row = Record<string, unknown>;

const rowOf = (extra: Row): Row => ({
  id: "11111111-2222-4333-8444-555555555555", contribution_type: "no_change", payload: { task_id: "auto:x:1", finding: "公式サイトで一致を確認した" }, status: "pending",
  score: 1, target_score: 2, agree_count: 1, disagree_count: 0, unsure_count: 0, agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5",
  source_urls: ["https://www.pref.example.lg.jp/a"], note: null, task_id: "auto:x:1", created_at: "2026-10-01T00:00:00Z", applied_at: null, review_notes: null,
  applied_politician_id: null, applied_policy_id: null, last_activity_at: "2026-10-02T00:00:00Z", last_activity: "voted",
  // 這三個不在 select 欄位裡，真的資料庫不會回；假的回了，入口也不得原樣吐出去
  contributor_ip_hash: "SECRET-IP-HASH", actor_id: "ditrust:SECRET", payload_hash: "SECRET-PAYLOAD-HASH",
  ...extra,
});

function makeRouter(rows: Row[]) {
  return (c: RestCall): unknown => {
    if (c.target === "contributions") return rows;
    if (c.target === "elections") return [{ id: "2027-04-11_governor_130001", name: "東京都知事選挙" }];
    if (c.target === "rpc/contribution_feed_summary") return { by_status: { pending: rows.length }, daily_last_7: [], leaderboard: [] };
    return undefined;
  };
}

async function callFeed(rows: Row[], query = ""): Promise<{ status: number; json: Row; calls: RestCall[] }> {
  const entry = await loadEntry("../../jp-contributions-feed/index.ts", env, makeRouter(rows));
  try {
    const res = await entry.call(new Request(`https://x/jp-contributions-feed${query}`));
    return { status: res.status, json: await res.json() as Row, calls: entry.calls };
  } finally { entry.restore(); }
}

Deno.test("入口：每個 REST／RPC 請求都帶 policy_jp 標頭；回 items、summary、docs，不回任何雜湊", async () => {
  const { status, json, calls } = await callFeed([rowOf({})]);
  assertEquals(status, 200);
  assertEquals(json.success, true);
  assertEquals(json.docs, JP_PROTOCOL_URL);
  assert(calls.length > 0);
  for (const c of calls) assertEquals(c.headers["accept-profile"] ?? c.headers["content-profile"], "policy_jp", `${c.method} ${c.target} 沒帶 policy_jp`);
  assert(calls.some((c) => c.target === "rpc/contribution_feed_summary"), "第一頁要呼叫 contribution_feed_summary");
  const select = calls.find((c) => c.target === "contributions")!.url.searchParams.get("select")!;
  assertEquals(JP_SCORE_COLUMNS.split(",").every((c) => select.includes(c.trim())), true);
  assert(!select.includes("effective_agree"), "policy_jp.contributions 沒有 effective_agree 這個計算欄位，撈了整頁會 400");
  assertEquals((json.summary as Row).by_status, { pending: 1 });
  const text = JSON.stringify(json);
  for (const secret of ["SECRET-IP-HASH", "SECRET-PAYLOAD-HASH", "ditrust:SECRET", "ip_hash", "actor_id"]) assert(!text.includes(secret), `回應不得含 ${secret}`);
  const item = (json.items as Row[])[0];
  assertEquals(item.score, 1);
  assertEquals(item.target_score, 2);
  assertEquals(item.score_needed, 1);
  assertEquals(item.votes_needed, 1);
  assertEquals(item.required_agree, 2);
});

Deno.test("入口：status 參數不合法回 400；合法值照過；翻頁（帶 cursor）不呼叫 summary", async () => {
  const bad = await callFeed([], "?status=bogus");
  assertEquals(bad.status, 400);
  assertEquals(bad.json.success, false);
  for (const ok of ["all", "attention", "voting", "pending", "verified", "applied", "disputed", "apply_failed", "rejected", "reverted", "superseded", "withdrawn"]) {
    assertEquals((await callFeed([], `?status=${ok}`)).status, 200, ok);
  }
  const paged = await callFeed([rowOf({})], "?cursor=2026-10-02T00:00:00+00:00&limit=5");
  assertEquals(paged.status, 200);
  assert(!paged.calls.some((c) => c.target === "rpc/contribution_feed_summary"), "翻頁不算 summary");
  assertEquals(paged.json.filtered_total, null);
});

Deno.test("入口：分頁——多撈一筆判斷 has_more，next_cursor 是最後一筆的 last_activity_at", async () => {
  const rows = [1, 2, 3].map((n) => rowOf({ id: `00000000-0000-4000-8000-00000000000${n}`, last_activity_at: `2026-10-0${4 - n}T00:00:00Z` }));
  const r = await callFeed(rows, "?limit=2");
  assertEquals((r.json.items as Row[]).length, 2);
  assertEquals(r.json.has_more, true);
  assertEquals(r.json.next_cursor, "2026-10-02T00:00:00Z");
});

Deno.test("入口：votes_needed／score_needed——pending 才有，已落庫的是 0；目標分數空的退回日本站門檻", async () => {
  const r = await callFeed([
    rowOf({ id: "00000000-0000-4000-8000-000000000001", score: 0, target_score: 3, agree_count: 1, contribution_type: "correction", payload: {} }),
    rowOf({ id: "00000000-0000-4000-8000-000000000002", status: "applied", score: 3, target_score: 3, agree_count: 3 }),
    rowOf({ id: "00000000-0000-4000-8000-000000000003", score: 0, target_score: null, agree_count: 0, contribution_type: "election", payload: {} }),
  ]);
  const [a, b, c] = r.json.items as Row[];
  assertEquals([a.score_needed, a.votes_needed], [3, 2]);
  assertEquals([b.score_needed, b.votes_needed], [0, 0]);
  assertEquals([c.target_score, c.score_needed, c.votes_needed], [3, 3, 3], "election 的日本站門檻是 3，不是正見矩陣的值");
});

Deno.test("入口：election 沒帶 name 就用 policy_jp.elections 的名稱；查 elections 時 id＝投票日_種類_團體碼", async () => {
  const r = await callFeed([
    rowOf({ contribution_type: "election", payload: { election_date: "2027-04-11", election_type: "governor", election_reason: "regular", lg_code: "130001" } }),
  ]);
  const el = r.calls.find((c) => c.target === "elections")!;
  assertEquals(el.url.searchParams.get("id"), "in.(2027-04-11_governor_130001)");
  const item = (r.json.items as Row[])[0];
  assertEquals(item.summary, "回報選舉「東京都知事選挙」（投票日 2027-04-11）");
  assertEquals(item.target_name, "東京都知事選挙");
  assertEquals(item.politician_url, null);
});

// ---- 3. 純函式 ----

Deno.test("jpContributionScore：target_score 優先；空的退回日本站門檻（no_change／task_suggestion 2，其餘 3）", () => {
  const base = { payload: {}, source_urls: [] as string[] };
  assertEquals(jpContributionScore({ ...base, contribution_type: "correction", score: -1, target_score: 5 }), { score: -1, target_score: 5 });
  assertEquals(jpContributionScore({ ...base, contribution_type: "no_change", score: null, target_score: null }), { score: 0, target_score: 2 });
  assertEquals(jpContributionScore({ ...base, contribution_type: "task_suggestion" }).target_score, 2);
  for (const t of ["correction", "election", "local_government", "regional_stat"]) assertEquals(jpContributionScore({ ...base, contribution_type: t }).target_score, 3, t);
});

Deno.test("jpElectionIdOf／jpElectionIdsNeedingName：id 規則同 elections.id；已有 name 的、欄位不全的、非 election 的都不查", () => {
  assertEquals(jpElectionIdOf({ election_date: "2027-04-11", election_type: "governor", lg_code: "130001" }), "2027-04-11_governor_130001");
  assertEquals(jpElectionIdOf({ election_date: "2024-10-27", election_type: "national_lower" }), "2024-10-27_national_lower_national");
  assertEquals(jpElectionIdOf({ election_date: "2027-04-11", election_type: "governor" }), null);
  assertEquals(jpElectionIdOf(null), null);
  const payloads = [
    { election_date: "2027-04-11", election_type: "governor", lg_code: "130001" },
    { election_date: "2027-04-11", election_type: "governor", lg_code: "130001" },
    { name: "已有名稱", election_date: "2027-04-12", election_type: "mayor", lg_code: "131130" },
    { election_date: "2027-04-13", election_type: "mayor" },
    { election_date: "2027-04-14", election_type: "mayor", lg_code: "131130" },
  ];
  assertEquals(jpElectionIdsNeedingName(payloads, ["election", "election", "election", "election", "correction"]), ["2027-04-11_governor_130001"]);
});

Deno.test("jpPayloadForSummary：只有 election 沒帶 name 時補名稱，其他原樣", () => {
  const names = new Map([["2027-04-11_governor_130001", "東京都知事選挙"]]);
  const p = { election_date: "2027-04-11", election_type: "governor", lg_code: "130001" };
  assertEquals(jpPayloadForSummary("election", p, names), { ...p, name: "東京都知事選挙" });
  assertEquals(jpPayloadForSummary("election", { ...p, name: "自己填的" }, names), { ...p, name: "自己填的" });
  assertEquals(jpPayloadForSummary("election", { ...p, lg_code: "999999" }, names), { ...p, lg_code: "999999" });
  assertEquals(jpPayloadForSummary("correction", p, names), p);
});

Deno.test("jpSummarizeContribution：日本站四種型別的摘要；其餘走正見摘要但不回人物／政見連結", () => {
  const s = (contribution_type: string, payload: unknown, extra: Row = {}) => jpSummarizeContribution({ contribution_type, payload, ...extra });
  assertEquals(s("election", { name: "東京都知事選挙", election_date: "2027-04-11" }).summary, "回報選舉「東京都知事選挙」（投票日 2027-04-11）");
  assertEquals(s("election", { election_date: "2027-04-11", election_type: "governor" }).summary, "回報選舉「知事選舉」（投票日 2027-04-11）");
  assertEquals(s("local_government", { name: "一宮市", kind: "city" }), { summary: "回報地方公共團體「一宮市」的基本資料", target_name: "一宮市", politician_id: null, policy_id: null, politician_url: null, policy_url: null });
  assertEquals(s("regional_stat", { lg_code: "232190", stat_key: "population", year: 2020, value: 385000, unit: "人" }).summary, "補團體 232190 2020 年的人口：385000 人");
  assertEquals(s("regional_stat", { lg_code: "232190", stat_key: "aging_rate", year: 2020, value: 29.6 }).summary, "補團體 232190 2020 年的高齡化率：29.6 %");
  const nc = s("no_change", { task_id: "auto:policy_missing:abc123", finding: "公式サイトで一致を確認した" });
  assertEquals(nc.summary, "核對後回報沒有異動：公式サイトで一致を確認した");
  assert(!nc.summary.includes("auto:policy_missing"), "任務代號是內部識別碼，不印在摘要上");
  assertEquals(s("no_change", { task_id: "auto:x:1" }).summary, "核對後回報沒有異動");
  const c = s("task_suggestion", { politician_id: "abc" }, { applied_politician_id: "p-1" });
  assertEquals([c.politician_url, c.policy_url, c.politician_id, c.policy_id], [null, null, null, null]);
});
