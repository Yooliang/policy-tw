/**
 * 名冊對帳：系統建立的 TS 那一半（roster-reconcile.ts／apply-contribution.ts 的 applySystemCandidacy；#678 第一階段）。
 *
 * 分兩層：
 *   * applySystemCandidacy：真的 applyCandidacy（跟代理交件落庫同一支）跑在記憶體假 supabase 上——建人物／掛既有人物、參選紀錄、
 *     edit_history（agent_name＝system:*、contribution_id 空）、來源註記、名字對不上不寫、agent_name 不是 system: 就擋；
 *   * runRosterReconcile：開關、每輪上限、applied／unresolved／error 的記錄、重跑冪等（建過的對帳不再給）、時間預算。
 * 資料庫那一半（對帳判定、唯一才建、還原）在 roster-reconcile.test.ts（PGlite）。
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applySystemCandidacy } from "./apply-contribution.ts";
import { candidacyPayloadOf, DEFAULT_AGENT_NAME, type ReconcileCandidate, runRosterReconcile, systemRowOf } from "./roster-reconcile.ts";

const AGENT = DEFAULT_AGENT_NAME;
const URL_ = "https://web.cec.gov.tw/api/file/x.pdf";
const P_OLD = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";

const cand = (over: Partial<ReconcileCandidate> = {}): ReconcileCandidate => ({
  reg_id: 101, election_id: 2026, election_type: "縣市議員", county: "台北市", sub_region: null, village: null, district: "第02選舉區",
  name: "李二", party: "無", source_url: URL_, row_no: 7, person_action: "new", politician_id: null, ...over,
});

Deno.test("R1 登記彙總表那一列 → candidacy payload：協議的詞（registered），村里只對村里長帶，選舉區用 electoral_district", () => {
  assertEquals(candidacyPayloadOf(cand()), {
    name: "李二", election_id: 2026, election_type: "縣市議員", region: "台北市", candidate_status: "registered", party: "無", electoral_district: "第02選舉區",
  });
  const v = candidacyPayloadOf(cand({ election_type: "村里長", sub_region: "板橋區", village: "甲里", district: null }));
  assertEquals([v.sub_region, v.village, v.electoral_district], ["板橋區", "甲里", undefined]);
  // 非村里長不帶 village（名冊的 village 欄只有村里長有意義）
  assertEquals(candidacyPayloadOf(cand({ election_type: "鄉鎮市民代表", sub_region: "板橋區", village: "甲里" })).village, undefined);
  // 身份：new → 直接建；attach → 要掛的人物 id
  assertEquals(systemRowOf(cand(), AGENT).resolved_politician_id, "new");
  assertEquals(systemRowOf(cand({ person_action: "attach", politician_id: P_OLD }), AGENT).resolved_politician_id, P_OLD);
  assertEquals(systemRowOf(cand(), AGENT).source_urls, [URL_]);
  assertStringIncludes(systemRowOf(cand(), AGENT).note ?? "", "第 7 列");
  // attach 沒有人物 id 是對帳的錯，不能默默變成 new
  try { systemRowOf(cand({ person_action: "attach", politician_id: null }), AGENT); assert(false, "該丟錯"); } catch (e) { assertStringIncludes(String(e), "沒有給人物 id"); }
});

Deno.test("R2 applySystemCandidacy（new）：建人物＋參選紀錄，edit_history 記 system 代號、不帶 contribution_id，來源記名冊網址", async () => {
  const { client, db } = createFakeSupabase({
    regions: [{ id: 501, region: "台北市", sub_region: "第02選舉區", village: null }, { id: 900, region: "台北市", sub_region: null, village: null }],
    politicians: [], politician_elections: [],
  });
  const row = systemRowOf(cand(), AGENT);
  const out = await applySystemCandidacy(client, row);
  assertEquals(out.status, "applied");
  assertEquals(out.created_politician, true);
  assertEquals(db.politicians.length, 1);
  assertEquals(db.politicians[0].name, "李二");
  assertEquals(db.politician_elections.length, 1);
  assertEquals([db.politician_elections[0].election_id, db.politician_elections[0].candidacy_status, db.politician_elections[0].region_id], [2026, "filed", 501]);
  assertStringIncludes(String(db.politician_elections[0].source_note), URL_);
  assertStringIncludes(String(db.politician_elections[0].source_note), AGENT);
  // edit_history：人物整列＋參選紀錄整列，都是 system 代號、沒有 contribution_id
  const eh = db.edit_history;
  assertEquals(eh.map((e) => e.table_name).sort(), ["politician_elections", "politicians"]);
  assert(eh.every((e) => e.agent_name === AGENT && e.contribution_id === null && e.field === "*" && e.old_value === null), JSON.stringify(eh));
  // 出處標記：人物 key 的 source 不是 contribution:null
  const sources = new Set((db.politician_keys ?? []).map((k) => String(k.source)));
  assert(![...sources].some((s) => s.includes("null")), [...sources].join());
});

Deno.test("R3 applySystemCandidacy（attach）：掛上既有人物，不建新人物，只記參選紀錄的 edit_history", async () => {
  const { client, db } = createFakeSupabase({
    regions: [{ id: 900, region: "台北市", sub_region: null, village: null }],
    politicians: [{ id: P_OLD, name: "李二", merged_into: null }], politician_elections: [],
  });
  const out = await applySystemCandidacy(client, systemRowOf(cand({ person_action: "attach", politician_id: P_OLD }), AGENT));
  assertEquals(out.status, "applied");
  assertEquals(out.created_politician, false);
  assertEquals(db.politicians.length, 1);
  assertEquals(db.politician_elections[0].politician_id, P_OLD);
  assertEquals(db.edit_history.map((e) => e.table_name), ["politician_elections"]);
});

Deno.test("R4 掛上既有人物但姓名對不上 → disputed，什麼都不寫（不會把參選紀錄掛到別人名下）", async () => {
  const { client, db } = createFakeSupabase({ politicians: [{ id: P_OLD, name: "完全不同的人", merged_into: null }], politician_elections: [], regions: [] });
  const out = await applySystemCandidacy(client, systemRowOf(cand({ person_action: "attach", politician_id: P_OLD }), AGENT));
  assertEquals(out.status, "disputed");
  assertEquals((db.politician_elections ?? []).length, 0);
  assertEquals((db.edit_history ?? []).length, 0);
});

Deno.test("R5 agent_name 不是 system: 開頭、或沒有來源網址 → 直接丟錯，不寫（不能冒用代理或維護者的名字寫履歷）", async () => {
  const { client, db } = createFakeSupabase({ regions: [], politicians: [], politician_elections: [] });
  const row = systemRowOf(cand(), AGENT);
  await assertRejects(() => applySystemCandidacy(client, { ...row, agent_name: "maintainer" }), Error, "system:");
  await assertRejects(() => applySystemCandidacy(client, { ...row, agent_name: "Alice" }), Error, "system:");
  await assertRejects(() => applySystemCandidacy(client, { ...row, source_urls: [] }), Error, "來源");
  assertEquals((db.politicians ?? []).length + (db.politician_elections ?? []).length + (db.edit_history ?? []).length, 0);
});

// ── runRosterReconcile ──────────────────────────────────────────────────────────
/** 只模擬 runner 碰到的表與 RPC：settings、roster_reconcile_next、log、party、refresh */
function runnerDb(opts: { enabled?: boolean; batch?: number; candidates: ReconcileCandidate[]; lockFree?: boolean; logFailures?: number; logErrorCode?: string }) {
  const logs: Array<Record<string, unknown>> = [];
  let left = opts.logFailures ?? 0;
  const calls: Array<{ name: string; args: unknown }> = [];
  let pending = [...opts.candidates];
  const client = {
    from(table: string) {
      if (table === "roster_reconcile_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { enabled: opts.enabled ?? true, batch_limit: opts.batch ?? 100, agent_name: AGENT }, error: null }) }) }) };
      }
      if (table === "roster_reconcile_log") {
        return { insert: (e: Record<string, unknown>) => {
          if (left > 0) { left--; return Promise.resolve({ error: { message: "connection reset", code: opts.logErrorCode ?? "08006" } }); }
          logs.push(e);
          return Promise.resolve({ error: null });
        } };
      }
      throw new Error(`runner 不該碰 ${table}`);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      if (name === "roster_reconcile_lock") return Promise.resolve({ data: opts.lockFree !== false, error: null });
      if (name === "roster_reconcile_next") {
        const n = Number(args.p_limit);
        const out = pending.slice(0, n);
        return Promise.resolve({ data: out, error: null });
      }
      if (name === "roster_reconcile_refresh_units") return Promise.resolve({ data: 3, error: null });
      return Promise.resolve({ data: 0, error: null });
    },
  };
  return { client, logs, calls, settle: (names: string[]) => { pending = pending.filter((c) => !names.includes(c.name)); } };
}

const okApply = (created: boolean) => (_s: unknown, row: { payload: Record<string, unknown> }) =>
  Promise.resolve({ status: "applied" as const, message: "參選紀錄已建立", politician_id: "pid-" + String(row.payload.name), politician_election_id: "77", created_politician: created });

Deno.test("R6 runRosterReconcile：開關關著就空轉（不挑人、不寫 log）", async () => {
  const { client, logs, calls } = runnerDb({ enabled: false, candidates: [cand()] });
  const s = await runRosterReconcile(client, { apply: okApply(true) as never });
  assertEquals([s.skipped, s.picked, s.applied, logs.length], ["disabled", 0, 0, 0]);
  assert(!calls.some((c) => c.name === "roster_reconcile_next"));
});

Deno.test("R7 runRosterReconcile：建起來的記 applied（含來源 reg_id／row_no／網址、新建或掛上）並補政黨；每輪上限讀 settings；跑完刷新單位彙總", async () => {
  const { client, logs, calls } = runnerDb({ batch: 2, candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙", person_action: "attach", politician_id: P_OLD }), cand({ reg_id: 3, name: "丙" })] });
  const s = await runRosterReconcile(client, { apply: okApply(true) as never, runId: "run-1" });
  assertEquals([s.picked, s.applied], [2, 2], "settings.batch_limit＝2 → 只挑兩位");
  assertEquals(calls.find((c) => c.name === "roster_reconcile_next")?.args, { p_limit: 2 });
  assertEquals(logs.map((l) => [l.reg_id, l.outcome, l.run_id, l.source_url, l.row_no, l.agent_name]), [
    [1, "applied", "run-1", URL_, 7, AGENT], [2, "applied", "run-1", URL_, 7, AGENT],
  ]);
  assertEquals(logs[0].politician_election_id, 77);
  assertEquals(calls.filter((c) => c.name === "politician_election_party_from_candidacy").length, 2);
  assertEquals((calls.find((c) => c.name === "politician_election_party_from_candidacy")?.args as Record<string, unknown>).p_contribution_id, null);
  assertEquals(s.units_refreshed, 3);
  assertEquals(calls.map((c) => c.name).slice(-2), ["roster_reconcile_refresh_units", "roster_reconcile_unlock"], "跑完刷新彙總、再釋放租約");
  assertEquals(calls[0].name, "roster_reconcile_lock", "先搶租約才挑人");
  // limit 參數蓋過 settings
  const again = runnerDb({ batch: 2, candidates: [cand({ reg_id: 1 }), cand({ reg_id: 2 }), cand({ reg_id: 3 })] });
  assertEquals((await runRosterReconcile(again.client, { apply: okApply(true) as never, limit: 3 })).picked, 3);
});

Deno.test("R8 建不起來（disputed／failed）記 unresolved、丟例外記 error，其餘照做；不重試同一位", async () => {
  const { client, logs } = runnerDb({ candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙" }), cand({ reg_id: 3, name: "丙" })] });
  const apply = (_s: unknown, row: { payload: Record<string, unknown> }) => {
    if (row.payload.name === "甲") return Promise.resolve({ status: "disputed" as const, message: "身份判不出" });
    if (row.payload.name === "乙") throw new Error("regions lookup: timeout");
    return okApply(false)(_s, row);
  };
  const s = await runRosterReconcile(client, { apply: apply as never });
  assertEquals([s.applied, s.unresolved, s.errors, s.attached, s.created_politicians], [1, 1, 1, 1, 0]);
  assertEquals(logs.map((l) => [l.reg_id, l.outcome]), [[1, "unresolved"], [2, "error"], [3, "applied"]]);
  assertStringIncludes(String(logs[0].message), "身份判不出");
  assertStringIncludes(String(logs[1].message), "timeout");
  assertEquals(logs[1].politician_election_id, undefined, "失敗的不記參選紀錄");
  assertEquals(s.samples.map((x) => x.outcome), ["unresolved", "error", "applied"]);
});

Deno.test("R9 重跑冪等：對帳不再給建過的人 → 第二輪 picked＝0、不呼叫 apply、不寫 log", async () => {
  const db = runnerDb({ candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙" })] });
  let applied = 0;
  const apply = (s: unknown, row: { payload: Record<string, unknown> }) => { applied++; return okApply(true)(s, row); };
  const first = await runRosterReconcile(db.client, { apply: apply as never });
  assertEquals([first.picked, first.applied], [2, 2]);
  db.settle(["甲", "乙"]);   // 資料庫的對帳此時已經把他們算成「都對上」
  const second = await runRosterReconcile(db.client, { apply: apply as never });
  assertEquals([second.picked, second.applied, applied, db.logs.length], [0, 0, 2, 2]);
});

Deno.test("R10 時間預算：超過就停（剩下的下一輪再做），不丟例外", async () => {
  const { client, logs } = runnerDb({ candidates: [cand({ reg_id: 1 }), cand({ reg_id: 2 }), cand({ reg_id: 3 })] });
  let t = 0;
  const s = await runRosterReconcile(client, { apply: okApply(true) as never, now: () => (t += 40), budgetMs: 100 });
  assert(s.stopped_by_budget);
  assert(s.applied < 3 && s.applied === logs.length);
});

Deno.test("R11 執行租約：拿不到就空轉（回 skipped: concurrent_run，不挑人、不寫 log、也不釋放別人的租約）", async () => {
  const { client, logs, calls } = runnerDb({ lockFree: false, candidates: [cand()] });
  const s = await runRosterReconcile(client, { apply: okApply(true) as never });
  assertEquals([s.skipped, s.picked, s.applied, logs.length], ["concurrent_run", 0, 0, 0]);
  assert(!calls.some((c) => c.name === "roster_reconcile_next" || c.name === "roster_reconcile_unlock"));
});

Deno.test("R12 租約一定釋放：中途丟錯（log 寫不進去）也要 unlock", async () => {
  const { client, calls } = runnerDb({ logFailures: 9, candidates: [cand({ reg_id: 1 })] });
  await assertRejects(() => runRosterReconcile(client, { apply: okApply(true) as never }), Error);
  assertEquals(calls.at(-1)?.name, "roster_reconcile_unlock");
});

Deno.test("R13 log 寫入失敗：重試一次成功就照常；兩次都失敗就中止整輪並丟錯（不能落庫成功卻沒有紀錄）；唯一鍵衝突（別的執行先寫了）算成功", async () => {
  const once = runnerDb({ logFailures: 1, candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙" })] });
  const ok = await runRosterReconcile(once.client, { apply: okApply(true) as never });
  assertEquals([ok.applied, once.logs.length], [2, 2], "第一次失敗、重試成功：兩位都有紀錄");
  const twice = runnerDb({ logFailures: 2, candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙" })] });
  let applied = 0;
  const apply = (s: unknown, row: { payload: Record<string, unknown> }) => { applied++; return okApply(true)(s, row); };
  await assertRejects(() => runRosterReconcile(twice.client, { apply: apply as never }), Error, "roster_reconcile_log 寫入失敗");
  assertEquals(applied, 1, "第一位的紀錄寫不進去就中止，第二位不再動");
  const dup = runnerDb({ logFailures: 2, logErrorCode: "23505", candidates: [cand({ reg_id: 1 })] });
  assertEquals((await runRosterReconcile(dup.client, { apply: okApply(true) as never })).applied, 1);
});

Deno.test("R14 SSR 快取一輪結束統一清一次（去重），沒有建成功就不清", async () => {
  const purged: string[][] = [];
  const apply = (_s: unknown, row: { payload: Record<string, unknown> }) =>
    Promise.resolve({ status: "applied" as const, message: "ok", politician_id: row.payload.name === "甲" ? "pid-1" : row.payload.name === "乙" ? "pid-1" : "pid-3", politician_election_id: "7", created_politician: false });
  const db = runnerDb({ candidates: [cand({ reg_id: 1, name: "甲" }), cand({ reg_id: 2, name: "乙" }), cand({ reg_id: 3, name: "丙" })] });
  await runRosterReconcile(db.client, { apply: apply as never, purge: (p) => { purged.push(p); return Promise.resolve(); } });
  assertEquals(purged.length, 1, "整輪只清一次");
  assertEquals(new Set(purged[0]).size, purged[0].length, "路徑去重");
  const none = runnerDb({ candidates: [cand()] });
  const purged2: string[][] = [];
  await runRosterReconcile(none.client, { apply: (() => Promise.resolve({ status: "disputed", message: "x" })) as never, purge: (p) => { purged2.push(p); return Promise.resolve(); } });
  assertEquals(purged2.length, 0);
});

Deno.test("R15 applySystemCandidacy 自己不逐筆清快取（避免一輪 100 個請求）", async () => {
  const src = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const body = src.slice(src.indexOf("export async function applySystemCandidacy"), src.indexOf("async function supersedeDuplicates"));
  assert(!body.includes("purgeSsrPages("), "applySystemCandidacy 不該呼叫 purgeSsrPages");
});
