import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { cutJpBlocks, cutTwSpans } from "./jp-contributions-feed.test.ts";
import { jpHistoryIdValid, JP_HISTORY_ENTRY_COLUMNS, withJpScore } from "./jp/history.ts";

/**
 * 日本站查核履歷（jp-history）的測試。
 *   1. 走樣守門：jp-history/index.ts 是正見 history/index.ts 的照搬，只有標 `jp-only:begin`～`jp-only:end` 的區段不同
 *      （比對方法與 jp-contributions-feed.test.ts 同一套）。正見改了任何一行，這裡就紅。
 *   2. 入口行為：真的載入入口、底下是假的 PostgREST；每個請求都要帶 policy_jp 標頭、不吐出雜湊。
 *   3. 純函式：id 格式、分數欄位。
 */

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

// ---- 1. 走樣守門 ----

const TW_SPANS = [
  { from: 'import "jsr:@supabase/functions-js/edge-runtime.d.ts";', to: "*/", why: "檔頭與 import" },
  { from: "const UUID_RE =", to: "const UUID_RE =", why: "id 的格式（日本站依對象不同）" },
  { from: "if (!UUID_RE.test(id))", to: "const supabase = createClient(", why: "id 檢查與 client" },
  { from: "const origin = describeOrigin(", to: 'if (target !== "contribution"', why: "沒有紀錄時的來源說明" },
  { from: 'console.error("history error:"', to: 'console.error("history error:"', why: "日誌名稱" },
];

const norm = (lines: string[]) => lines.map((l) => l.trim()).filter((l) => l !== "");

export function historyDrift(tw: string, jp: string): string[] {
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

const TW_FILE = "../history/index.ts";
const JP_FILE = "../jp-history/index.ts";

Deno.test("走樣守門：jp-history 去掉日本專屬區段後，跟 history 逐行相同", async () => {
  assertEquals(historyDrift(await read(TW_FILE), await read(JP_FILE)), [], "正見的 history 改了，日本站的 jp-history 要跟著改（或把差異標成 jp-only 並登記 TW_SPANS）");
});

Deno.test("走樣守門：偵測器本身——正見改一行、日本站私自改一行、區段不成對、區段數不符都抓得到", async () => {
  const tw = await read(TW_FILE);
  const jp = await read(JP_FILE);
  assert(historyDrift(tw.replace("const page = pageEntries(entries, limit, cursor);", "const page = pageEntries(entries, limit + 1, cursor);"), jp).length > 0, "正見改分頁");
  assert(historyDrift(tw, jp.replace("total: entries.length,", "total: entries.length + 0,")).length > 0, "日本站在區段外私自改一行");
  assert(historyDrift(tw, jp.replace("// jp-only:end", "")).length > 0, "區段不成對");
  assert(historyDrift(tw, jp.replace("const data = await collectHistory(", "// jp-only:begin x\n// jp-only:end\nconst data = await collectHistory(")).length > 0, "多一個區段");
  assertEquals(historyDrift(tw, jp), []);
});

Deno.test("日本站這支：走 jpClient、不直接 createClient、不查正見的表、select 不含雜湊", async () => {
  const jp = await read(JP_FILE);
  const shared = await read("./jp/history.ts");
  assert(jp.includes("jpClient(") && !jp.includes("createClient("), "client 要走 jpClient（schema policy_jp）");
  for (const table of ["politicians", "policies", "politician_elections", "contribution_tasks", "citizen_questions"]) {
    assert(!shared.includes(`from("${table}")`), `不得查正見的 ${table}`);
  }
  const code = shared.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!/ip_hash|actor_id|payload_hash/.test(code), "select 欄位不含任何雜湊或身份鍵");
});

// ---- 2. 入口行為 ----

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" } as Record<string, string>;
type Row = Record<string, unknown>;
const CID = "11111111-2222-4333-8444-555555555555";

const contribution: Row = {
  id: CID, contribution_type: "election", status: "applied", score: 3, target_score: 3, agree_count: 3, disagree_count: 0, unsure_count: 0,
  agent_name: "dave", agent_tool: "claude-code/claude-sonnet-5", source_urls: ["https://www.city.example.lg.jp/senkyo/"], note: null, task_id: "auto:x",
  created_at: "2026-10-01T00:00:00Z", applied_at: "2026-10-02T00:00:00Z", review_notes: null, applied_politician_id: null, applied_policy_id: null,
  payload: { lg_code: "232033", election_type: "mayor", election_reason: "regular", election_date: "2027-01-24" },
  contributor_ip_hash: "SECRET-IP-HASH", actor_id: "ditrust:SECRET",
};
const vote: Row = { contribution_id: CID, verdict: "agree", note: "告示ページの投票日を確認", evidence_url: "https://www.pref.example.lg.jp/x", agent_name: "erin", agent_tool: "gemini-cli/gemini-3.1-pro", resolved_politician_id: null, created_at: "2026-10-01T05:00:00Z", verifier_ip_hash: "SECRET-VOTER-HASH" };
const edit: Row = { id: 7, contribution_id: CID, table_name: "elections", record_id: "2027-01-24_mayor_232033", field: "*", old_value: null, new_value: { name: "一宮市長選挙" }, applied_at: "2026-10-02T00:00:00Z", reverted_at: null, reverted_by: null };

function router(c: RestCall): unknown {
  if (c.target === "contributions") return [contribution];
  if (c.target === "contribution_votes") return [vote];
  if (c.target === "edit_history") return [edit];
  if (c.target === "sources") return [];
  return undefined;
}

async function call(query: string): Promise<{ status: number; json: Row; calls: RestCall[]; text: string }> {
  const entry = await loadEntry("../../jp-history/index.ts", env, router);
  try {
    const res = await entry.call(new Request(`https://x/jp-history${query}`));
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as Row, calls: entry.calls, text };
  } finally { entry.restore(); }
}

Deno.test("jp-history：一筆貢獻的履歷帶出投票者、理由、反證與欄位變更；全程 policy_jp、不吐雜湊", async () => {
  const r = await call(`?target=contribution&id=${CID}`);
  assertEquals(r.status, 200, r.text);
  const entries = r.json.entries as Row[];
  assertEquals(entries.length, 1);
  const e = entries[0];
  assertEquals(e.agent_tool, "claude-code/claude-sonnet-5");
  assertEquals((e.verifiers as Row[])[0].note, "告示ページの投票日を確認");
  assertEquals((e.verifiers as Row[])[0].evidence_url, "https://www.pref.example.lg.jp/x");
  assertEquals((e.edits as Row[])[0].table, "elections");
  assertEquals(e.target_score, 3, "分數目標讀 policy_jp 的 target_score");
  assert(!/SECRET/.test(r.text), "不得吐出任何雜湊或身份鍵");
  assert(r.calls.length > 0);
  for (const c of r.calls) assertEquals(c.headers["accept-profile"] ?? c.headers["content-profile"], "policy_jp", `${c.method} ${c.target} 要帶 policy_jp 標頭`);
});

Deno.test("jp-history：id 格式不對 400、target 不認得 400、找不到的貢獻 404、團體沒有紀錄回空", async () => {
  assertEquals((await call("?target=contribution&id=nope")).status, 400);
  assertEquals((await call("?target=local_government&id=23203")).status, 400);
  assertEquals((await call("?target=politician&id=" + CID)).status, 400);
  const entry = await loadEntry("../../jp-history/index.ts", env, () => []);
  try {
    assertEquals((await entry.call(new Request(`https://x/jp-history?target=contribution&id=${CID}`))).status, 404);
    const lg = await entry.call(new Request("https://x/jp-history?target=local_government&id=232033"));
    assertEquals(lg.status, 200);
    assertEquals(((await lg.json()) as Row).entries, []);
  } finally { entry.restore(); }
});

// ---- 3. 純函式 ----

Deno.test("jpHistoryIdValid：contribution＝uuid、local_government＝6 位、election＝投票日_種類[_團體碼]", () => {
  assert(jpHistoryIdValid("contribution", CID));
  assert(!jpHistoryIdValid("contribution", "232033"));
  assert(jpHistoryIdValid("local_government", "232033"));
  assert(!jpHistoryIdValid("local_government", "23203x"));
  assert(jpHistoryIdValid("election", "2027-01-24_mayor_232033"));
  assert(jpHistoryIdValid("election", "2028-07-10_national_upper"));
  assert(!jpHistoryIdValid("election", "x; drop"));
});

Deno.test("withJpScore：target_score 放進 effective_agree；select 欄位撈 target_score 不撈 effective_agree", () => {
  // deno-lint-ignore no-explicit-any
  const [a] = withJpScore([{ ...contribution, target_score: 2 } as any]);
  assertEquals(a.effective_agree, 2);
  assert(JP_HISTORY_ENTRY_COLUMNS.includes("target_score") && !JP_HISTORY_ENTRY_COLUMNS.includes("effective_agree"));
});
