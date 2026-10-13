import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { cutJpBlocks, cutTwSpans } from "./jp-contributions-feed.test.ts";
import { JP_PROTOCOL_URL, JP_PROTOCOL_VERSION } from "./jp/protocol.ts";

/**
 * 日本站任務看板（jp-tasks）的測試。
 *   1. 走樣守門：jp-tasks/index.ts 是正見 tasks/index.ts 的照搬，只有標 `jp-only:begin`～`jp-only:end` 的區段不同
 *      （比對方法與 jp-history.test.ts 同一套）。正見改了任何一行，這裡就紅。
 *   2. 入口行為：真的載入入口、底下是假的 PostgREST；每個請求都要帶 policy_jp 標頭、個資欄位不出現、票數摘要在。
 */

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

// ---- 1. 走樣守門 ----

const TW_SPANS = [
  { from: 'import "jsr:@supabase/functions-js/edge-runtime.d.ts";', to: "*/", why: "檔頭與 import" },
  { from: "const VOTE_COLUMNS =", to: "const VOTE_COLUMNS =", why: "票數欄位（日本站撈 target_score）" },
  { from: "return summarizeTaskVotes(", to: "return summarizeTaskVotes(", why: "分數目標改讀 target_score" },
  { from: "return new Response(JSON.stringify(body)", to: "return new Response(JSON.stringify(body)", why: "快取標頭" },
  { from: "const supabase = createClient(", to: "const supabase = createClient(", why: "client 固定 policy_jp" },
  { from: '.select("id, title, description, task_type', to: '.select("id, title, description, task_type', why: "手動任務的欄位（不撈個資）" },
  { from: "suggested_by: t.suggested_by", to: "created_by: t.created_by", why: "不回 suggested_by、created_by" },
  { from: "const auto = (autoRes.data", to: "const auto = (autoRes.data", why: "自動缺口也附票數摘要" },
  { from: "// 每筆附現況與 lookup", to: ": picked;", why: "with_current 一律關" },
  { from: "how_to:", to: "how_to:", why: "指向日本站的手引き" },
  { from: "docs: PROTOCOL_URL,", to: "docs: PROTOCOL_URL,", why: "日本站的手引き網址與版號" },
  { from: 'console.error("tasks error:"', to: 'console.error("tasks error:"', why: "日誌名稱" },
];

const norm = (lines: string[]) => lines.map((l) => l.trim()).filter((l) => l !== "");

export function tasksDrift(tw: string, jp: string): string[] {
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

const TW_FILE = "../tasks/index.ts";
const JP_FILE = "../jp-tasks/index.ts";

Deno.test("走樣守門：jp-tasks 去掉日本專屬區段後，跟 tasks 逐行相同", async () => {
  assertEquals(tasksDrift(await read(TW_FILE), await read(JP_FILE)), [], "正見的 tasks 改了，日本站的 jp-tasks 要跟著改（或把差異標成 jp-only 並登記 TW_SPANS）");
});

Deno.test("走樣守門：偵測器本身——正見改一行、日本站私自改一行、區段不成對、區段數不符都抓得到", async () => {
  const tw = await read(TW_FILE);
  const jp = await read(JP_FILE);
  assert(tasksDrift(tw.replace("Math.min(Math.max(Number(url.searchParams.get(\"limit\")) || 10, 1), 50)", "Math.min(Math.max(Number(url.searchParams.get(\"limit\")) || 10, 1), 60)"), jp).length > 0, "正見改 limit 上限");
  assert(tasksDrift(tw, jp.replace("count: tasks.length,", "count: tasks.length + 0,")).length > 0, "日本站在區段外私自改一行");
  assert(tasksDrift(tw, jp.replace("// jp-only:end", "")).length > 0, "區段不成對");
  assert(tasksDrift(tw, jp.replace("const votesByTask = await", "// jp-only:begin x\n// jp-only:end\nconst votesByTask = await")).length > 0, "多一個區段");
  assertEquals(tasksDrift(tw, jp), []);
});

Deno.test("日本站這支：走 jpClient、不 import 正見的 task-context、不撈個資欄位", async () => {
  const jp = await read(JP_FILE);
  assert(jp.includes("jpClient(") && !jp.includes("createClient("), "client 要走 jpClient（schema policy_jp）");
  const code = jp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!code.includes("task-context"), "不得 import task-context（with_current 在日本站一律關）");
  assert(!/requester_ip_hash|created_by|suggested_by|effective_agree"/.test(code.replace(/effective_agree: typeof/, "")), "select 欄位不含個資或正見的計算欄位");
});

// ---- 2. 入口行為 ----

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" } as Record<string, string>;
type Row = Record<string, unknown>;
const MANUAL_ID = "11111111-2222-4333-8444-555555555555";
const AUTO_ID = "auto:local_government_missing:232033";

// 假資料庫的列帶了個資欄位：就算被選進來也不得出現在回應（入口 select 不撈，這裡雙保險：整個回應不得含 SECRET）
const manualRow: Row = {
  id: MANUAL_ID, title: "市の公式サイトを確認", description: "最新の議員名簿", task_type: "audit", target: { source_url: "https://www.city.example.lg.jp/" },
  region: null, priority: 2, reward: 1, created_at: "2026-10-01T00:00:00Z", source: "manual", hint_sources: [], status: "open", closed_at: null,
  created_by: "SECRET-CREATOR", suggested_by: "SECRET-SUGGESTER", requester_ip_hash: "SECRET-IP-HASH",
};
const autoRow: Row = { task_id: AUTO_ID, task_type: "local_government_missing", target: { lg_code: "232033" }, what_we_need: "団体の基本情報", hint_sources: [], reward: 1, queue_at: "2026-10-01T00:00:00Z" };
const contribution: Row = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", contribution_type: "local_government", payload: { lg_code: "232033" }, source_urls: [], status: "pending",
  agree_count: 1, disagree_count: 0, unsure_count: 0, score: 1, target_score: 2, task_id: AUTO_ID,
};

function router(c: RestCall): unknown {
  if (c.target === "rpc/contribution_auto_tasks") return [autoRow];
  if (c.target === "rpc/contribution_auto_task_counts") return [{ task_type: "local_government_missing", total: 7 }];
  if (c.target === "contribution_tasks") return c.method === "HEAD" ? undefined : [manualRow];
  if (c.target === "contributions") {
    const q = c.url.searchParams.get("task_id") ?? "";
    return q.includes(AUTO_ID) ? [contribution] : [];
  }
  return undefined;
}

async function call(query: string): Promise<{ status: number; json: Row; calls: RestCall[]; text: string; headers: Headers }> {
  const entry = await loadEntry("../../jp-tasks/index.ts", env, router);
  try {
    const res = await entry.call(new Request(`https://x/jp-tasks${query}`));
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as Row, calls: entry.calls, text, headers: res.headers };
  } finally { entry.restore(); }
}

Deno.test("jp-tasks：手動＋自動任務、全程 policy_jp、不吐個資、自動任務的票數摘要在、docs 指向日本站手引き", async () => {
  const r = await call("?limit=10");
  assertEquals(r.status, 200, r.text);
  assert(!/SECRET/.test(r.text), "不得吐出 created_by／suggested_by／IP 雜湊");
  assertEquals(r.headers.get("cache-control"), "public, max-age=30");
  assertEquals(r.json.docs, JP_PROTOCOL_URL);
  assertEquals(r.json.protocol_version, JP_PROTOCOL_VERSION);
  assertEquals((r.json.totals as Row).local_government_missing, 7);
  const tasks = r.json.tasks as Row[];
  assertEquals(tasks.map((t) => t.task_id), [MANUAL_ID, AUTO_ID]);
  for (const t of tasks) {
    assert(!("created_by" in t) && !("suggested_by" in t) && !("requester_ip_hash" in t) && !("current" in t) && !("lookup" in t));
  }
  const auto = tasks[1];
  assertEquals(auto.suggested_contribution_type, "local_government");
  assertEquals(auto.source, "auto");
  const votes = auto.votes as { submissions: number; leading: Row | null };
  assertEquals(votes.submissions, 1);
  assertEquals(votes.leading?.target_score, 2, "目標分數讀 target_score");
  assertEquals(votes.leading?.required_agree, 2);
  assertEquals((tasks[0].votes as Row).submissions, 0);
  assert(r.calls.length > 0);
  for (const c of r.calls) assertEquals(c.headers["accept-profile"] ?? c.headers["content-profile"], "policy_jp", `${c.method} ${c.target} 要帶 policy_jp 標頭`);
  assert(!r.calls.some((c) => c.target === "contributions" && /effective_agree/.test(c.url.search)), "不得撈 policy_jp 沒有的 effective_agree");
});

Deno.test("jp-tasks：include_closed 與 limit 的處理", async () => {
  const open = await call("");
  const manualOpen = open.calls.find((c) => c.target === "contribution_tasks" && c.method === "GET")!;
  assertEquals(manualOpen.url.searchParams.get("status"), "eq.open");
  assertEquals(manualOpen.url.searchParams.get("limit"), "10", "limit 預設 10");
  const all = await call("?include_closed=1&limit=999&source=manual");
  const manualAll = all.calls.find((c) => c.target === "contribution_tasks" && c.method === "GET")!;
  assertEquals(manualAll.url.searchParams.get("status"), null, "include_closed=1 不濾 status");
  assertEquals(manualAll.url.searchParams.get("limit"), "50", "limit 上限 50");
  assertEquals(manualAll.url.searchParams.get("source"), "eq.manual");
  assertEquals(((all.json.tasks as Row[]).map((t) => t.task_id)), [MANUAL_ID], "source 過濾只回手動任務");
  const rpc = all.calls.find((c) => c.target === "rpc/contribution_auto_tasks")!;
  assertEquals((rpc.body as Row).p_limit, 50);
});

Deno.test("jp-tasks：with_current=1 也不回 current／lookup；OPTIONS 通", async () => {
  const r = await call("?with_current=1");
  for (const t of r.json.tasks as Row[]) assert(!("current" in t) && !("lookup" in t));
  const entry = await loadEntry("../../jp-tasks/index.ts", env, () => []);
  try { assertEquals((await entry.call(new Request("https://x/jp-tasks", { method: "OPTIONS" }))).status, 200); } finally { entry.restore(); }
});
