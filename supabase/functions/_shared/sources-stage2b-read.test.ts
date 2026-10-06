/**
 * #347 第二階段 B-1：程式與資料庫的讀寫端都不再碰 policies.source_url／tracking_logs.source_url／policy_sources 的守門。
 *
 * B-1 只加不刪（欄位、舊表、同步觸發器都還在，B-2 才刪），但之後要刪的東西，這裡先確認已經沒有人讀寫：
 * 「誰還在讀、誰還在寫」只能靠掃原始碼擋——任何一處回頭讀寫舊欄位，B-2 刪欄時才會炸，而測試全綠。
 * 每一條都做過還原驗證（見 PR 說明）：拿掉被守的東西，對應那條要轉紅。
 *
 * 不算讀舊欄位的：交件協議的欄位名（correction 的 changes[].field＝source_url、任務 target／current 裡給代理看的 source_url 鍵）——
 * 那是協議的介面，值來自出處表；policy_elements、lineage_*、politician_offices、roster_checks、ai_prompts 各自的 source_url 是別張表自己的欄位。
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applyContribution } from "./apply-contribution.ts";
import { executeRevert, planRevert } from "./edit-history.ts";
import { writeSourcesAfterApply } from "./source-write.ts";
import { buildLookup } from "./task-context.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replaceAll("\r\n", "\n");
const MIGRATION = await read("../../migrations/20261007110000_sources_stage2b_read_side.sql");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = code(MIGRATION);

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const NEWS = "https://news.ltn.com.tw/news/politics/1";
const OFFICIAL = "https://www.ly.gov.tw/Pages/Detail.aspx?nodeid=1";

// ── migration（B-1）────────────────────────────────────────────────

Deno.test("B-1 migration 只加不刪：不刪欄位、不刪表、不刪觸發器；四支派工臂不再讀 pl.source_url", () => {
  assertEquals(/DROP\s+(COLUMN|TABLE|TRIGGER\s+(?!IF EXISTS trg_sources_register_contribution))/i.test(sql), false, "B-1 不刪任何東西（唯一的 DROP TRIGGER IF EXISTS 是重建自己新加的觸發器）");
  assertEquals(/ALTER TABLE/i.test(sql), false);
  // 派工臂那一段（⑤ 核對自己要讀舊欄位來比對，不算）；c.source_url 是 policy_elements 那一臂 CTE 的別名
  const arms = code(MIGRATION.slice(MIGRATION.indexOf("-- ── ③ 派工臂"), MIGRATION.indexOf("-- ── ⑤")));
  assert(arms.length > 10000, "派工臂那一段沒抓到");
  assertEquals(/\bpl\.source_url\b/.test(arms), false, "派工臂不再讀 policies.source_url");
  assertMatch(code(MIGRATION.slice(MIGRATION.indexOf("-- ── ⑤"))), /btrim\(coalesce\(pl\.source_url, ''\)\) IS DISTINCT FROM coalesce\(policy_primary_url\(pl\.id\), ''\)/, "核對段比對新舊兩邊");
  for (const arm of ["raw", "legacy", "mismatch", "policy_elements"]) assertMatch(sql, new RegExp(`CREATE OR REPLACE FUNCTION contribution_auto_tasks_${arm}\\(\\)`));
  assertMatch(sql, /policy_primary_url\(pl\.id\)/);
  // 「沒有出處」改成「沒有主要出處列」
  assertMatch(sql, /NOT EXISTS \(SELECT 1 FROM source_refs sr WHERE sr\.target_table = 'policies' AND sr\.target_id = pl\.id::TEXT AND sr\.role = 'primary'\)/);
});

Deno.test("source_set_primary：只有 service_role、只支援政見與進度、舊的主要出處引用整個刪掉再換新的", () => {
  assertMatch(sql, /REVOKE EXECUTE ON FUNCTION source_set_primary\(TEXT, TEXT, TEXT, TEXT\) FROM PUBLIC, anon, authenticated;/);
  assertMatch(sql, /GRANT EXECUTE ON FUNCTION source_set_primary\(TEXT, TEXT, TEXT, TEXT\) TO service_role;/);
  assertMatch(sql, /IF p_target_table NOT IN \('policies', 'tracking_logs'\) THEN/);
  const del = sql.indexOf("DELETE FROM source_refs WHERE target_table = p_target_table AND target_id = p_target_id AND role = 'primary'");
  assert(del >= 0, "要刪舊的主要出處引用");
  assert(del < sql.indexOf("v_sid := source_upsert("), "先刪舊的主要出處、再寫新的");
  assertMatch(sql, /ON CONFLICT \(target_table, target_id, source_id\) DO UPDATE SET role = 'primary'/);
  assertMatch(sql, /SECURITY DEFINER SET search_path = public/);
});

Deno.test("交件當下登記：拆成獨立觸發器（只在 INSERT、只登記選舉公報與選委會公告）；舊的 sources_sync_contribution 這一支不動", () => {
  assertMatch(sql, /CREATE TRIGGER trg_sources_register_contribution AFTER INSERT ON contributions/);
  assertMatch(sql, /IF source_doc_kind\(btrim\(v_url\)\) IS NOT NULL THEN\s+PERFORM source_upsert\(v_url, 'contribution'/);
  assertEquals(/source_refs/.test(sql.slice(sql.indexOf("sources_register_contribution() RETURNS trigger"), sql.indexOf("CREATE TRIGGER trg_sources_register_contribution"))), false, "只登記、不掛引用");
  assertEquals(/sources_sync_contribution/.test(sql.replace(/COMMENT ON FUNCTION[^;]*;/g, "")), false, "B-1 不碰舊觸發器（B-2 才刪）");
});

// ── 程式碼：不讀不寫舊欄位與舊表 ─────────────────────────────────────

async function* walk(dir: URL, prefix: string, skip: (rel: string, isDir: boolean) => boolean): AsyncGenerator<{ rel: string; url: URL }> {
  for await (const e of Deno.readDir(dir)) {
    const rel = prefix + e.name;
    if (skip(rel, e.isDirectory)) continue;
    if (e.isDirectory) yield* walk(new URL(e.name + "/", dir), rel + "/", skip);
    else yield { rel, url: new URL(e.name, dir) };
  }
}
/** 一條 supabase 查詢鏈：從 .from("表") 之後，一路吃 .方法(…)（括號配對、字串裡的括號不算），到下一個不是 .方法 的字為止 */
function chainAfter(text: string, from: number): string {
  let i = from;
  for (;;) {
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ".") break;
    j++;
    while (j < text.length && /[\w$]/.test(text[j])) j++;
    if (text[j] !== "(") { i = j; continue; }
    let depth = 0;
    let quote = "";
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) { if (ch === "\\") j++; else if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return text.slice(from, i);
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

Deno.test("Edge Function 的查詢不再選／寫 policies 與 tracking_logs 的 source_url 欄", async () => {
  const hits: string[] = [];
  let scanned = 0;
  const functions = new URL("../", import.meta.url);
  for await (const f of walk(functions, "", (rel, dir) => dir ? rel === "node_modules" || rel.startsWith(".") : !rel.endsWith(".ts") || rel.endsWith(".test.ts"))) {
    scanned++;
    const text = stripComments(await Deno.readTextFile(f.url));
    // 一條查詢鏈：從 .from("policies"|"tracking_logs") 到下一個分號
    for (const m of text.matchAll(/\.from\(\s*["'](policies|tracking_logs)["']\s*\)/g)) {
      const chain = chainAfter(text, m.index! + m[0].length);
      if (/\bsource_url\b(?!s)/.test(chain)) hits.push(`${f.rel}: from("${m[1]}")${chain.replace(/\s+/g, " ").slice(0, 100)}`);
    }
    // 選欄位的字串常數（LINEAGE_POLICY_COLUMNS 這類）
    for (const m of text.matchAll(/(?:const|let)\s+(\w*POLICY\w*COLUMNS\w*)\s*=\s*["'`]([^"'`]*)["'`]/g)) {
      if (/\bsource_url\b(?!s)/.test(m[2])) hits.push(`${f.rel}: ${m[1]}`);
    }
  }
  assert(scanned > 100, `只掃到 ${scanned} 支檔案，路徑可能錯了`);
  assertEquals(hits, [], "這些查詢還在選／寫舊欄位（B-2 刪欄會炸）");
});

Deno.test("不再讀寫舊表 policy_sources（程式碼；註解可以提）", async () => {
  const hits: string[] = [];
  for await (const f of walk(new URL("../", import.meta.url), "", (rel, dir) => dir ? rel === "node_modules" || rel.startsWith(".") : !rel.endsWith(".ts") || rel.endsWith(".test.ts"))) {
    const text = stripComments(await Deno.readTextFile(f.url));
    for (const m of text.matchAll(/from\(\s*["']policy_sources["']\s*\)/g)) hits.push(`${f.rel}: ${m[0]}`);
  }
  assertEquals(hits, []);
});

Deno.test("前端與預渲染不讀舊欄位：型別、轉換、出處工具都沒有 source_url 的退路", async () => {
  const types = await read("../../../types.ts");
  const raw = types.slice(types.indexOf("export interface RawPolicy"), types.indexOf("export interface RawLineageSummary"));
  assertEquals(/\bsource_url\b/.test(stripComments(raw)), false, "RawPolicy／RawTrackingLog 沒有 source_url");
  const rawLog = types.slice(types.indexOf("export interface RawTrackingLog"), types.indexOf("export interface RawPolicy"));
  assertEquals(/\bsource_url\b/.test(stripComments(rawLog)), false);
  const sup = stripComments(await read("../../../composables/useSupabase.ts"));
  const mapper = sup.slice(sup.indexOf("export function mapPolicy"), sup.indexOf("function mapLogSources") + 400);
  assert(mapper.includes("mapSourceRefs(row.sources)") && mapper.includes("mapSourceRefs(l.sources)"), "mapPolicy／mapLogSources 只讀 sources");
  assertEquals(/source_url/.test(mapper), false, "mapPolicy／mapLogSources 不讀 source_url（任期的 source_url 是另一張表，在別處）");
  const src = stripComments(await read("../../../lib/sources.ts"));
  assertEquals(/legacyUrl/.test(src), false, "lib/sources.ts 沒有舊欄位的退路");
});

Deno.test("舊 AI 管線（ai-action／ai-contribute／ai-update-progress）改寫出處表：insert 物件不帶 source_url，落庫後呼叫 writeLegacySources", async () => {
  for (const name of ["ai-action", "ai-contribute", "ai-update-progress"]) {
    const text = stripComments(await read(`../${name}/index.ts`));
    assert(text.includes("writeLegacySources("), `${name} 要用 writeLegacySources 寫出處`);
    for (const m of text.matchAll(/\.from\(\s*["'](policies|tracking_logs)["']\s*\)\s*\.(insert|update)\(\s*\{([^}]*)\}/g)) {
      assertEquals(/\bsource_url\s*:/.test(m[3]), false, `${name} 的 ${m[1]}.${m[2]}({…}) 還在寫 source_url`);
    }
  }
  const action = stripComments(await read("../ai-action/index.ts"));
  assert(action.includes("listPolicySources("), "ai-action 查來源讀出處表");
});

Deno.test("派給代理的 lookup（REST 網址）不再叫代理 select 政見／進度的 source_url 欄（改讀視圖的 sources）", () => {
  const l = buildLookup({ politician_id: POL, policy_id: POLICY });
  for (const [k, url] of Object.entries(l)) {
    if (/\/(policies|tracking_logs)\?/.test(url)) assertEquals(/select=[^&]*source_url/.test(url), false, `lookup.${k} 還在 select source_url：${url}`);
  }
  assertMatch(l.policies, /policies_with_logs\?select=[^&]*sources/);
  assertMatch(l.policy, /policies_with_logs\?select=\*/);
});

// ── 落庫：政見與進度的出處只走 source_write ──────────────────────────

type Row = Record<string, unknown>;
const baseRow = { note: null, agent_name: "tester", contributor_url: null };

Deno.test("落庫：新增政見與進度更新的 insert 不帶 source_url；出處只經 source_write（第一個網址當主要）", async () => {
  const rpc: Array<{ name: string; args: Row }> = [];
  const fake = createFakeSupabase({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    policies: [{ id: "pol-1", politician_id: POL, title: "舊政見", status: "Campaign Pledge", progress: 0, last_updated: "2026-01-01", removed_at: null }],
    tracking_logs: [], edit_history: [],
  }, { source_write: (a) => { rpc.push({ name: "source_write", args: a }); return []; } });
  const created = await applyContribution(fake.client, {
    ...baseRow, id: "c1", contribution_type: "policy", source_urls: [OFFICIAL, NEWS],
    payload: { politician_id: POL, title: "社會住宅", description: "在任內興建兩萬戶社會住宅，並提高包租代管的租金補貼比例。", category: "交通建設", status: "Campaign Pledge", election_id: 2026 },
  });
  assertEquals(created.status, "applied");
  const pol = fake.db.policies.find((p) => p.title === "社會住宅")!;
  assertEquals("source_url" in pol, false, "政見那一列不寫 source_url");
  assertEquals((rpc[0].args.p_sources as Row[]).map((s) => s.url), [OFFICIAL, NEWS]);
  assertEquals(rpc[0].args.p_target_table, "policies");

  const progress = await applyContribution(fake.client, {
    ...baseRow, id: "c2", contribution_type: "policy_progress", source_urls: [OFFICIAL],
    payload: { policy_id: "pol-1", status: "In Progress", progress: 30, date: "2026-10-01", note: "市府公布第一批基地。" },
  });
  assertEquals(progress.status, "applied");
  assertEquals("source_url" in fake.db.tracking_logs[0], false, "進度那一列不寫 source_url");
  assertEquals(rpc[1].args.p_target_table, "tracking_logs");
  assertEquals(rpc[1].args.p_target_id, progress.tracking_log_id);
});

Deno.test("出處寫入失敗：政見與進度會再試一次、還是失敗落庫結果要提醒（不沉默）；其他型別不加提醒", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    let calls = 0;
    const failing = { rpc: () => { calls++; return Promise.resolve({ error: { message: "壞了" } }); } };
    assertEquals(await writeSourcesAfterApply(failing, { contribution_type: "policy", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 0);
    assertEquals(calls, 2, "政見要試兩次");
    calls = 0;
    await writeSourcesAfterApply(failing, { contribution_type: "candidacy", payload: {}, source_urls: [NEWS] }, { politician_election_id: "9" });
    assertEquals(calls, 1, "參選紀錄的舊欄位路徑本來就沒有，不用重試");
    // 先失敗一次、第二次成功：寫成了
    let n = 0;
    const flaky = { rpc: () => Promise.resolve(++n === 1 ? { error: { message: "暫時的" } } : { error: null }) };
    assertEquals(await writeSourcesAfterApply(flaky, { contribution_type: "policy", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 1);

    const fake = createFakeSupabase({
      politicians: [{ id: POL, name: "王小明", merged_into: null }], policies: [], edit_history: [],
    });
    // 預設的假 rpc 回 { error: null }；這裡換成壞的
    // deno-lint-ignore no-explicit-any
    (fake.client as any).rpc = () => Promise.resolve({ data: null, error: { message: "壞了" } });
    const out = await applyContribution(fake.client, {
      ...baseRow, id: "c3", contribution_type: "policy", source_urls: [NEWS],
      payload: { politician_id: POL, title: "社會住宅", description: "在任內興建兩萬戶社會住宅，並提高包租代管的租金補貼比例。", category: "交通建設", status: "Campaign Pledge", election_id: 2026 },
    });
    assertEquals(out.status, "applied", "資料已經在了，不回頭變成失敗");
    assert(String(out.message).includes("出處沒有寫進出處表"), String(out.message));
  } finally {
    console.error = origError;
  }
});

// ── correction 改政見出處：走 source_set_primary ──────────────────────

function correctionSetup(primary: string | null) {
  const setPrimary: Row[] = [];
  const fake = createFakeSupabase({
    policies: [{ id: POLICY, title: "候車亭改建", description: "舊描述", category: "交通建設", updated_at: "2026-01-01T00:00:00Z" }],
    source_refs: primary ? [{ target_table: "policies", target_id: POLICY, role: "primary", sources: { url: primary } }] : [],
    edit_history: [],
  }, { source_set_primary: (a) => { setPrimary.push(a); return a.p_url; } });
  const row = (changes: Row[]) => ({
    id: "c-1", contribution_type: "correction" as const, source_urls: [OFFICIAL], note: null, agent_name: "tester", contributor_url: null,
    payload: { target_table: "policies", target_id: POLICY, changes, reason: "公報與新聞稿寫得很清楚" },
  });
  return { fake, setPrimary, row };
}

Deno.test("correction：只換出處 → 不更新資料表的 source_url、呼叫 source_set_primary、履歷記舊→新、updated_at 照樣刷新", async () => {
  const { fake, setPrimary, row } = correctionSetup(NEWS);
  const out = await applyContribution(fake.client, row([{ field: "source_url", current_value: NEWS, correct_value: OFFICIAL }]));
  assertEquals(out.status, "applied");
  assertEquals(setPrimary, [{ p_target_table: "policies", p_target_id: POLICY, p_url: OFFICIAL, p_origin: "correction" }]);
  const policy = fake.db.policies[0];
  assertEquals("source_url" in policy, false);
  assert(policy.updated_at !== "2026-01-01T00:00:00Z", "以前換出處會刷新 updated_at（source_url 在更新觸發清單裡），現在要自己刷新");
  assertEquals(fake.db.edit_history.map((e) => [e.table_name, e.field, e.old_value, e.new_value]), [["policies", "source_url", NEWS, OFFICIAL]]);
});

Deno.test("correction：新值跟現在的主要出處一樣 → superseded（不寫假履歷、不呼叫 source_set_primary）；沒有主要出處時補上也走 source_set_primary", async () => {
  const same = correctionSetup(NEWS);
  const out = await applyContribution(same.fake.client, same.row([{ field: "source_url", current_value: NEWS, correct_value: NEWS }]));
  assertEquals(out.status, "superseded");
  assertEquals(same.setPrimary, []);
  assertEquals(same.fake.db.edit_history.length, 0);

  const none = correctionSetup(null);
  const filled = await applyContribution(none.fake.client, none.row([{ field: "source_url", current_value: "", correct_value: OFFICIAL }, { field: "description", correct_value: "新描述。" }]));
  assertEquals(filled.status, "applied");
  assertEquals(none.setPrimary.length, 1);
  assertEquals(none.fake.db.policies[0].description, "新描述。", "同一筆的其他欄位照常更新");
  assertEquals(none.fake.db.edit_history.map((e) => e.field), ["source_url", "description"], "履歷照 changes 的順序");
  assertEquals(none.fake.db.edit_history[0].old_value, null);
});

Deno.test("correction：讀不到出處表就丟出去稍後重試——不能把「查不到」當成「現值是空的」", async () => {
  const fake = createFakeSupabase({ policies: [{ id: POLICY, title: "x" }], edit_history: [] });
  // deno-lint-ignore no-explicit-any
  const base = fake.client as any;
  const client = { ...base, from: (t: string) => (t === "source_refs" ? { select: () => ({ eq: () => ({ eq: () => ({ in: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "連不上" } }) }) }) }) }) } : base.from(t)) };
  const origError = console.error;
  console.error = () => {};
  try {
    let threw = false;
    try {
      await applyContribution(client, {
        id: "c-2", contribution_type: "correction", source_urls: [OFFICIAL], note: null, agent_name: "t", contributor_url: null,
        payload: { target_table: "policies", target_id: POLICY, changes: [{ field: "source_url", correct_value: OFFICIAL }], reason: "公報寫得很清楚啊" },
      });
    } catch { threw = true; }
    assert(threw, "讀出處表失敗要丟出去（上線失敗會自動重試），不是當成沒有出處");
    assertEquals(fake.db.edit_history.length, 0);
  } finally {
    console.error = origError;
  }
});

// ── 履歷還原：source_url 在出處表 ────────────────────────────────────

const edit = (id: number, o: Row) => ({ id, table_name: "policies", record_id: POLICY, field: "x", old_value: null, new_value: null, contribution_id: "c-1", agent_name: "t", reverted_at: null, ...o });

Deno.test("還原：政見的 source_url 履歷＝把主要出處換回舊網址（source_set_primary），不寫資料表；其他欄位照常 update", async () => {
  const writes: string[] = [];
  const rpc: Row[] = [];
  const history = [
    edit(1, { field: "source_url", old_value: NEWS, new_value: OFFICIAL }),
    edit(2, { field: "description", old_value: "舊描述", new_value: "新描述" }),
  ];
  const client = {
    from: (t: string) => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: history, error: null }) }) }),
      update: (patch: Row) => { writes.push(`update ${t} ${JSON.stringify(patch)}`); return { eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }; },
      insert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    rpc: (name: string, args: Row) => { rpc.push({ name, ...args }); return Promise.resolve({ error: null }); },
  };
  await executeRevert(client, "c-1", "tester");
  assertEquals(writes.filter((w) => w.startsWith("update policies")), ['update policies {"description":"舊描述"}'], "資料表的 update 不帶 source_url");
  assertEquals(rpc, [{ name: "source_set_primary", p_target_table: "policies", p_target_id: POLICY, p_url: NEWS, p_origin: "revert" }]);
  // 只改出處的更正：不 update 資料表
  history.splice(1, 1);
  writes.length = 0; rpc.length = 0;
  await executeRevert(client, "c-1", "tester");
  assertEquals(writes.filter((w) => w.startsWith("update policies")), []);
  assertEquals(rpc.length, 1);
  // 舊值是空（原本沒有出處）：還原＝刪掉主要出處
  history[0] = edit(1, { field: "source_url", old_value: null, new_value: OFFICIAL });
  rpc.length = 0;
  await executeRevert(client, "c-1", "tester");
  assertEquals(rpc[0].p_url, null);
  // 還原失敗要丟出去，不能標成已還原
  const broken = { ...client, rpc: () => Promise.resolve({ error: { message: "壞了" } }) };
  let threw = false;
  try { await executeRevert(broken, "c-1", "tester"); } catch { threw = true; }
  assert(threw);
});

Deno.test("還原：被刪掉的政見放回去——整列快照的 source_url 不寫資料表，放回去之後把主要出處接回去", async () => {
  const inserts: Row[] = [];
  const rpc: Row[] = [];
  const history = [edit(1, { field: "*", old_value: { id: POLICY, title: "x", source_url: NEWS }, new_value: null })];
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: history, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }),
      insert: (row: Row) => { inserts.push(row); return Promise.resolve({ error: null }); },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
    rpc: (name: string, args: Row) => { rpc.push({ name, ...args }); return Promise.resolve({ error: null }); },
  };
  await executeRevert(client, "c-1", "tester");
  assertEquals(inserts, [{ id: POLICY, title: "x" }]);
  assertEquals(rpc.map((r) => [r.name, r.p_url]), [["source_set_primary", NEWS]]);
  // planRevert 本身不變：履歷還是 restore／reinsert，換成出處表的動作在 executeRevert
  assertEquals(planRevert([edit(1, { field: "source_url", old_value: NEWS, new_value: OFFICIAL })]).map((s) => s.op), ["restore"]);
});

// ── 協議文件 ──────────────────────────────────────────────────────

Deno.test("協議 1.69.0：skill.md 的 REST 範例不再 select policies 的 source_url；講清楚出處在 policies_with_logs.sources、correction 的欄位名照舊", async () => {
  const skill = await read("../../../public/skill.md");
  for (const m of skill.matchAll(/rest\/v1\/(policies|tracking_logs)\?select=([^&`"\s]*)/g)) {
    assertEquals(m[2].split(",").includes("source_url"), false, `skill.md 的 ${m[1]} REST 範例還在 select source_url`);
  }
  assertMatch(skill, /政見的出處不在 `policies` 資料表裡\*\*（1\.69\.0 起資料表沒有 `source_url` 欄/);
  assertMatch(skill, /policies_with_logs\?select=id,title,status,progress,sources/);
  assertMatch(skill, /changes: \[\{field:"source_url", …\}\]/, "correction 的欄位名照舊（待裁：要不要改名）");
});
