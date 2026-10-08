/**
 * 名冊逐位吻合的 candidacy 大批次（150 筆）走真的 handleContribute（假 supabase）的整合測試（#455 agy 審查要求）。
 *
 * 守的是：
 *  1. 網址過長：150 個 politician_id／雜湊／task_id 放進一個 .in() 會 414——假 client 對超過 IN_CHUNK 的 in() 回 error，並記下來
 *  2. 整表載入：核對只撈這一批的縣市＋鄉鎮，不把村里長 14,100 列整份拉回來（rowsServed、fullScans）
 *  3. 同一批裡同一位候選人重複：整批 400（gate），一般型別的重複只寫第一筆、回應不會被覆寫成同一個編號
 *  4. 沒有名冊網址的項目不能靜默略過
 * 每一組都有還原驗證：以改壞的原始碼載入模組（data: URL），確認上面的斷言會紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";
import { parseRoster } from "./cec-roster.ts";
import { ROSTER_SOURCES, toRegistrationRecords } from "./cec-registrations.ts";
import { rosterBatchProblems, scopesOf } from "./roster-batch-gate.ts";
import { fakeRosterSupabase, type FakeTables } from "./roster-fake-supabase.ts";
import { readTownIndex } from "../../../scripts/cec-registrations-lib.ts";
import { IN_CHUNK } from "./in-chunks.ts";
import { clearElectionCaches } from "./elections.ts";

const towns = await readTownIndex();
const VILLAGE = ROSTER_SOURCES.find((s) => s.election_type === "村里長")!;
const records = toRegistrationRecords(
  VILLAGE,
  parseRoster((await Deno.readTextFile(new URL(`./fixtures/${VILLAGE.fixture}`, import.meta.url))).replace(/\r\n/g, "\n")),
  towns,
);
const URL_ = VILLAGE.url;
const named = records.filter((r) => r.name);
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });
const okFetch = (() => Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof fetch;

/** 名冊全表（14,100 列）＋登記＋這批的人物 */
function tablesFor(n: number, extra: FakeTables = {}): FakeTables {
  return {
    cec_registration_sources: [{ source_url: URL_, row_count: records.length }],
    cec_registrations: records.map((r) => ({ source_url: r.source_url, row_no: r.row_no, name: r.name, party: r.party, region: r.region, district: r.district, place: r.place, sub_region: r.sub_region })),
    politicians: Array.from({ length: n + 5 }, (_, i) => ({ id: uuid(i + 1), merged_into: null })),
    ...extra,
  };
}

/** 新北市的前 n 位有名字的村里長登記者（跨好幾個鄉鎮） */
function pick(n: number, county = "新北市") {
  return named.filter((r) => r.region === county).slice(0, n);
}
const itemOf = (r: (typeof records)[number], i: number, over: Record<string, unknown> = {}) => ({
  contribution_type: "candidacy",
  payload: { politician_id: uuid(i + 1), name: r.name, party: r.party, region: r.region, sub_region: r.sub_region, village: r.village, election_id: 2026, election_type: "村里長", candidate_status: "registered", ...over },
  source_urls: [URL_],
  task_id: `auto:roster_check:2026:${r.region}${r.sub_region}:村里長`,
});
const body150 = (rs = pick(150), over?: (i: number) => Record<string, unknown>) => ({ agent_name: "roster-bulk-test", contributions: rs.map((r, i) => itemOf(r, i, over?.(i))) });
const call = (client: unknown, b: unknown) => handleContribute(client, "https://x", b, "ip-roster-1", noVote, "contribute", okFetch);
const fresh = () => clearElectionCaches();

Deno.test("整合：150 筆名冊逐位吻合的 candidacy 走完整個交件流程 → 201、寫進 150 筆、編號各不相同；沒有任何 in() 超過 IN_CHUNK", async () => {
  fresh();
  const { client, log } = fakeRosterSupabase(tablesFor(150));
  const res = await call(client, body150());
  assertEquals(res.status, 201, JSON.stringify(res.body).slice(0, 600));
  const rows = log.inserted.filter((x) => x.table === "contributions");
  assertEquals(rows.length, 150);
  const results = (res.body as { results: Array<{ contribution_id: string; status: string }> }).results;
  assertEquals(results.length, 150);
  assertEquals(new Set(results.map((r) => r.contribution_id)).size, 150, "每一筆各自一個編號");
  assert(results.every((r) => r.status === "pending"));
  assertEquals(log.oversize, [], "有 in() 一次帶超過 IN_CHUNK 個值（網址過長）");
  // 150 個人物 id 確實是分批查的（不是被略過）
  assert(log.inSizes.some((x) => x.table === "politicians" && x.n === IN_CHUNK), "人物 id 沒有分批查");
  assert(log.inSizes.some((x) => x.col === "payload_hash" && x.n === IN_CHUNK), "雜湊沒有分批查");
});

Deno.test("整合：核對只撈這一批的範圍——不把村里長 14,100 列整份拉回來", async () => {
  fresh();
  const { client, log } = fakeRosterSupabase(tablesFor(150));
  const res = await call(client, body150());
  assertEquals(res.status, 201, JSON.stringify(res.body).slice(0, 300));
  assertEquals(log.fullScans, 0, "有查詢沒帶 region 條件（整表掃）");
  const newTaipei = records.filter((r) => r.region === "新北市").length;
  assert(log.rowsServed <= newTaipei, `撈了 ${log.rowsServed} 列，超過新北市全部 ${newTaipei} 列`);
  assert(log.rowsServed < records.length / 4, `撈了 ${log.rowsServed} 列／${records.length}`);
  // 單一鄉鎮的批次：只撈那個鄉鎮
  const byTown = new Map<string, typeof named>();
  for (const r of named) byTown.set(`${r.region}|${r.sub_region}`, [...(byTown.get(`${r.region}|${r.sub_region}`) ?? []), r]);
  const [townKey, townRows] = [...byTown].find(([, rs]) => rs.length >= 25)!;
  fresh();
  const second = fakeRosterSupabase(tablesFor(30));
  const r2 = await call(second.client, body150(townRows.slice(0, 25)));
  assertEquals(r2.status, 201, `${townKey}：${JSON.stringify(r2.body).slice(0, 300)}`);
  const total = records.filter((r) => `${r.region}|${r.sub_region}` === townKey).length;
  assertEquals(second.log.rowsServed, total, "單一鄉鎮的批次應該只撈那個鄉鎮的列");
});

Deno.test("整合：同一批裡同一位候選人重複 → 整批 400 roster_batch_duplicate，指出是哪一筆，什麼都不寫", async () => {
  fresh();
  const rs = pick(60);
  const b = body150(rs);
  b.contributions[41] = { ...b.contributions[40], payload: { ...b.contributions[40].payload, politician_id: uuid(42) } };
  const { client, log } = fakeRosterSupabase(tablesFor(60));
  const res = await call(client, b);
  assertEquals(res.status, 400, JSON.stringify(res.body).slice(0, 300));
  const body = res.body as { error: string; errors: Array<{ index: number; message: string }> };
  assertEquals(body.error, "roster_batch_duplicate");
  assertEquals(body.errors.map((e) => e.index), [41]);
  assertEquals(log.inserted.filter((x) => x.table === "contributions").length, 0);
});

Deno.test("整合：對不上名冊的一筆 → 整批 400 roster_batch_mismatch；名冊沒有資料表 → roster_batch_unavailable；資料表壞掉也不放行", async () => {
  fresh();
  const bad = body150(pick(50), (i) => (i === 7 ? { party: "不存在的政黨" } : {}));
  const a = fakeRosterSupabase(tablesFor(50));
  const r1 = await call(a.client, bad);
  assertEquals(r1.status, 400);
  assertEquals((r1.body as { error: string; errors: Array<{ index: number }> }).error, "roster_batch_mismatch");
  assertEquals((r1.body as { errors: Array<{ index: number }> }).errors.map((e) => e.index), [7]);
  assertEquals(a.log.inserted.filter((x) => x.table === "contributions").length, 0);
  fresh();
  const none = fakeRosterSupabase(tablesFor(50, { cec_registration_sources: [] }));
  assertEquals(((await call(none.client, body150(pick(50)))).body as { error: string }).error, "roster_batch_unavailable");
  fresh();
  const broken = fakeRosterSupabase(tablesFor(50), { failRegistrationCount: true });
  const r3 = await call(broken.client, body150(pick(50)));
  assertEquals(r3.status, 400);
  assertEquals((r3.body as { error: string }).error, "roster_batch_unavailable");
  assertEquals(broken.log.inserted.filter((x) => x.table === "contributions").length, 0);
});

Deno.test("整合：有一筆沒引用名冊 → 整批 400（結構關）；直接叫 gate 也不會靜默略過，記成那一筆的錯誤", async () => {
  fresh();
  const b = body150(pick(40));
  (b.contributions[9] as { source_urls: string[] }).source_urls = ["https://www.cna.com.tw/news/aipl/202609045002.aspx"];
  const res = await call(fakeRosterSupabase(tablesFor(40)).client, b);
  assertEquals(res.status, 400);
  const direct = await rosterBatchProblems(fakeRosterSupabase(tablesFor(40)).client, b.contributions.map((c) => ({ contribution_type: c.contribution_type, payload: c.payload, source_urls: c.source_urls })));
  assertEquals(direct.ok, false);
  if (!direct.ok) assertEquals(direct.errors.filter((e) => e.path === "source_urls").map((e) => e.index), [9]);
});

Deno.test("整合：一般型別同一批裡內容相同的兩筆 → 只寫第一筆，第二筆回 duplicate 沿用第一筆的編號（不是被 Map 覆寫成同一個而各寫一筆）", async () => {
  fresh();
  const one = { contribution_type: "candidacy", payload: { politician_id: uuid(1), name: "某某人", region: "彰化縣", election_id: 2026, election_type: "縣市長", candidate_status: "registered" }, source_urls: ["https://www.cec.gov.tw/central/cms/test"] };
  const other = { ...one, payload: { ...one.payload, politician_id: uuid(2), name: "另一人" } };
  const { client, log } = fakeRosterSupabase({ politicians: [{ id: uuid(1), merged_into: null }, { id: uuid(2), merged_into: null }] });
  const res = await call(client, { agent_name: "dup-batch-test", contributions: [one, other, structuredClone(one)] });
  assertEquals(res.status, 201, JSON.stringify(res.body).slice(0, 400));
  assertEquals(log.inserted.filter((x) => x.table === "contributions").length, 2, "內容相同的只寫一筆");
  const results = (res.body as { results: Array<{ contribution_id: string; status: string }> }).results;
  assertEquals(results[2].status, "duplicate");
  assertEquals(results[2].contribution_id, results[0].contribution_id);
  assert(results[0].contribution_id !== results[1].contribution_id);
});

Deno.test("scopesOf：這批出現的縣市與鄉鎮；有一筆沒給鄉鎮，那個縣市整個撈；「縣市＋鄉鎮」寫法拆得開", () => {
  const item = (region: string, sub_region: string | null) => ({ id: "x", name: "甲", party: null, region, district: null, sub_region, village: null });
  assertEquals(scopesOf([item("新北市", "板橋區"), item("新北市", "三重區"), item("台北市", "大安區")]), [
    { region: "新北市", towns: ["板橋區", "三重區"] }, { region: "台北市", towns: ["大安區"] },
  ]);
  assertEquals(scopesOf([item("新北市", "板橋區"), item("新北市", null)]), [{ region: "新北市", towns: null }]);
  assertEquals(scopesOf([item("新北市板橋區", null)]), [{ region: "新北市", towns: ["板橋區"] }]);
});

// ── 還原驗證：以改壞的原始碼載入模組，上面對應的斷言要紅 ────────────────────────
async function mutant(file: string, edits: Array<[string, string] | [string, string, number]>, overrides: Record<string, string> = {}) {
  let src = (await Deno.readTextFile(new URL(`./${file}`, import.meta.url))).replaceAll("\r\n", "\n");
  for (const [from, to, times] of edits) {
    assertEquals(src.split(from).length - 1, times ?? 1, `標記字串必須剛好出現 ${times ?? 1} 次：${from.slice(0, 60)}`);
    src = src.replaceAll(from, to);
  }
  const abs = src.replace(/from "\.\/([^"]+)"/g, (_m, f) => `from "${overrides[f] ?? new URL(`./${f}`, import.meta.url).href}"`);
  const url = `data:application/typescript;base64,${btoa(unescape(encodeURIComponent(abs)))}`;
  return { url, mod: await import(url) };
}
async function expectRed(label: string, body: () => Promise<void> | void) {
  let red = false;
  try { await body(); } catch { red = true; }
  assert(red, `還原驗證失敗：${label} 拿掉之後測試沒有變紅`);
}
const handlerOk = async (mod: { handleContribute: typeof handleContribute }, b: unknown, tables: FakeTables) => {
  fresh();
  const { client, log } = fakeRosterSupabase(tables);
  const res = await mod.handleContribute(client, "https://x", b, "ip-roster-1", noVote, "contribute", okFetch);
  return { res, log };
};

Deno.test("還原驗證：重複宣稱查詢（fetchClaimCandidates）不分批 → 150 個 id 一次帶，網址過長（測試要紅）", async () => {
  const { mod } = await mutant("contribute-handler.ts", [["chunksOf([...g.values]).map(async (chunk) => {", "[[...g.values]].map(async (chunk) => {"]]);
  await expectRed("fetchClaimCandidates 分批", async () => {
    const { res, log } = await handlerOk(mod, body150(), tablesFor(150));
    assertEquals(log.oversize, []);
    assertEquals(res.status, 201);
  });
});

Deno.test("還原驗證：去重雜湊不分批 → 150 個雜湊一次帶（測試要紅）", async () => {
  const { mod } = await mutant("contribute-handler.ts", [[".in(\"payload_hash\", hashes.slice(i, i + 40))", ".in(\"payload_hash\", hashes)"]]);
  await expectRed("雜湊分批", async () => {
    const { log } = await handlerOk(mod, body150(), tablesFor(150));
    assertEquals(log.oversize, []);
  });
});

Deno.test("還原驗證：落庫前置檢查（apply-precheck）的人物查詢不分批 → 150 個 id 一次帶（測試要紅）", async () => {
  const pre = await mutant("apply-precheck.ts", [["for (const chunk of chunksOf(ids)) {\n      // query-bounds: ok — ids 來自這一批交件，每段 IN_CHUNK 個，變數 in()\n      const { data, error } = await supabase.from(\"politicians\")", "for (const chunk of [ids]) {\n      // query-bounds: ok — ids 來自這一批交件，每段 IN_CHUNK 個，變數 in()\n      const { data, error } = await supabase.from(\"politicians\")"]]);
  const { mod } = await mutant("contribute-handler.ts", [], { "apply-precheck.ts": pre.url });
  await expectRed("apply-precheck 分批", async () => {
    const { log } = await handlerOk(mod, body150(), tablesFor(150));
    assertEquals(log.oversize, []);
  });
});

Deno.test("還原驗證：核對整表載入（不帶縣市條件）→ 14,100 列整份拉回（測試要紅）", async () => {
  const reg = await mutant("cec-registrations.ts", [[".eq(\"source_url\", url).eq(\"region\", region)", ".eq(\"source_url\", url)", 2]]);
  const gate = await mutant("roster-batch-gate.ts", [], { "cec-registrations.ts": reg.url });
  const { mod } = await mutant("contribute-handler.ts", [], { "roster-batch-gate.ts": gate.url });
  await expectRed("縣市範圍", async () => {
    const { log } = await handlerOk(mod, body150(), tablesFor(150));
    assertEquals(log.fullScans, 0);
    assert(log.rowsServed < records.length / 4);
  });
});

Deno.test("還原驗證：gate 不查同批重複 → 重複的整批通過（測試要紅）", async () => {
  const gate = await mutant("roster-batch-gate.ts", [["if (indexes.length < 2) continue;", "continue;"]]);
  const { mod } = await mutant("contribute-handler.ts", [], { "roster-batch-gate.ts": gate.url });
  await expectRed("同批重複", async () => {
    const b = body150(pick(60));
    b.contributions[41] = { ...b.contributions[40], payload: { ...b.contributions[40].payload, politician_id: uuid(42) } };
    const { res } = await handlerOk(mod, b, tablesFor(60));
    assertEquals(res.status, 400);
  });
});

Deno.test("還原驗證：gate 對沒有名冊網址的項目靜默略過 → 直接叫 gate 時整批過關（測試要紅）", async () => {
  const gate = await mutant("roster-batch-gate.ts", [["errors.push({ index, path: \"source_urls\", message: \"缺少中選會登記名冊網址", "void ({ index, path: \"source_urls\", message: \"缺少中選會登記名冊網址"]]);
  await expectRed("沒有網址不能略過", async () => {
    const b = body150(pick(40));
    (b.contributions[9] as { source_urls: string[] }).source_urls = ["https://www.cna.com.tw/news/aipl/202609045002.aspx"];
    const direct = await gate.mod.rosterBatchProblems(fakeRosterSupabase(tablesFor(40)).client, b.contributions.map((c) => ({ contribution_type: c.contribution_type, payload: c.payload, source_urls: c.source_urls })));
    assertEquals(direct.ok, false);
  });
});

Deno.test("還原驗證：一般型別同批重複不去重 → 寫兩筆、編號被覆寫（測試要紅）", async () => {
  const { mod } = await mutant("contribute-handler.ts", [["if (seenInBatch.has(h)) dupInBatch.add(i); else seenInBatch.add(h);", "seenInBatch.add(h);"]]);
  await expectRed("同批重複只寫一筆", async () => {
    const one = { contribution_type: "candidacy", payload: { politician_id: uuid(1), name: "某某人", region: "彰化縣", election_id: 2026, election_type: "縣市長", candidate_status: "registered" }, source_urls: ["https://www.cec.gov.tw/central/cms/test"] };
    const { log } = await handlerOk(mod, { agent_name: "dup-batch-test", contributions: [one, structuredClone(one)] }, { politicians: [{ id: uuid(1), merged_into: null }] });
    assertEquals(log.inserted.filter((x) => x.table === "contributions").length, 1);
  });
});
