import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  autoSourceKind, detailsOfPayload, parseSourceDetails, SELF_EVIDENCES, SELF_INELIGIBLE_HOSTS, selfIneligibleReason,
  sourceLevelNotice, sourcesForWrite, sourceTargetFor, writeSourcesAfterApply,
} from "./source-write.ts";
import { UNREADABLE_SOCIAL_HOSTS } from "./lineage.ts";
import { SOURCE_PRIORITY } from "./source-priority.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

// issue #347 第二階段 A：出處的寫入端。純函式＋對 migration 文字的守門＋假資料庫跑 applyContribution。
// migration 本身在 PGlite（本機 Postgres）實跑過，見 PR 說明；這裡盯的是 SQL 與 TS 兩份規則不要分歧。

const MIGRATION = new URL("../../migrations/20261006210000_sources_stage2a.sql", import.meta.url);
const sql = await Deno.readTextFile(MIGRATION);
/** 去掉 SQL 註解，斷言只看程式本體 */
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const body = code(sql);
const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));

const firstSql = await Deno.readTextFile(new URL("../../migrations/20261005000347_sources_table.sql", import.meta.url));
function sqlFunction(name: string, from = sql): string {
  const at = from.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(at >= 0, `migration 裡找不到 ${name}`);
  const open = from.indexOf("$$", at);
  const close = from.indexOf("$$;", open + 2);
  return from.slice(at, close + 3);
}

const OFFICIAL = "https://www.ly.gov.tw/Pages/Detail.aspx?nodeid=1";
const NEWS = "https://news.ltn.com.tw/news/politics/1";
const OWN_SITE = "https://www.candidate-wang.tw/policy";
const PARTY_PAGE = "https://www.dpp.org.tw/candidate/12";
const FB = "https://www.facebook.com/candidate.wang";

// ── 1. SQL 與 TS 同一份規則 ─────────────────────────────────────────────────

Deno.test("SQL 與 TS 一致：source_self_eligible() 的社群清單＝SELF_INELIGIBLE_HOSTS（臉書、IG、Threads 另加 YouTube、X、LINE、TikTok、Telegram）", () => {
  const fn = sqlFunction("source_self_eligible");
  const m = /ARRAY\[([^\]]+)\]/.exec(fn);
  assert(m, "抓不到 SQL 的網域清單");
  const sqlHosts = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  assertEquals(sqlHosts, [...SELF_INELIGIBLE_HOSTS].sort());
  // 讀不到的社群全在裡面；source-priority 標成 social 的也全在裡面（漏一個，那個平台就能標本人來源）
  for (const h of UNREADABLE_SOCIAL_HOSTS) assert((SELF_INELIGIBLE_HOSTS as readonly string[]).includes(h), h);
  for (const s of SOURCE_PRIORITY.filter((x) => x.kind === "social")) assert((SELF_INELIGIBLE_HOSTS as readonly string[]).includes(s.host), s.host);
  // 另一半規則：自動判斷不是 other 的（官方、媒體、社群）不能是本人來源
  assertStringIncludes(fn, "source_auto_kind(btrim(p_url)) = 'other'");
});

Deno.test("SQL 與 TS 一致：source_auto_kind（官方→official、媒體與社群→media、其餘→other）＝autoSourceKind", () => {
  const fn = sqlFunction("source_auto_kind", firstSql);
  assertStringIncludes(fn, "WHEN 'official' THEN 'official'");
  assertStringIncludes(fn, "WHEN 'media' THEN 'media'");
  assertStringIncludes(fn, "WHEN 'social' THEN 'media'");
  for (const [url, want] of [
    [OFFICIAL, "official"], ["https://web.cec.gov.tw/x", "official"], ["https://www.taipei.gov.taipei/x", "official"],
    [NEWS, "media"], ["https://www.cna.com.tw/n", "media"],
    [FB, "media"], ["https://www.youtube.com/watch?v=1", "media"], ["https://x.com/a/status/1", "media"],
    [OWN_SITE, "other"], [PARTY_PAGE, "other"], ["https://example.org/x", "other"],
  ] as const) assertEquals(autoSourceKind(url), want, url);
});

Deno.test("本人來源：只有打得開的本人官網、政黨刊載頁；社群、官方網域、媒體都不行（SQL 的 source_self_eligible 與 TS 的 selfIneligibleReason 同一份）", () => {
  for (const ok of [OWN_SITE, PARTY_PAGE, "https://candidate.example.com/"]) assertEquals(selfIneligibleReason(ok), null, ok);
  for (const [bad, why] of [
    [FB, "社群平台"], ["https://m.facebook.com/x", "社群平台"], ["https://fb.com/x", "社群平台"], ["https://fb.watch/x", "社群平台"],
    ["https://www.instagram.com/x", "社群平台"], ["https://www.threads.net/@x", "社群平台"], ["https://www.youtube.com/@x", "社群平台"],
    ["https://youtu.be/x", "社群平台"], ["https://x.com/x", "社群平台"], ["https://twitter.com/x", "社群平台"], ["https://www.tiktok.com/@x", "社群平台"],
    ["https://line.me/R/ti/p/x", "社群平台"], ["https://t.me/x", "社群平台"],
    [OFFICIAL, "官方網站"], ["https://www.tncc.gov.tw/x", "官方網站"], [NEWS, "新聞媒體"], ["ftp://candidate.tw/x", "http(s)"], ["不是網址", "http(s)"],
  ] as const) assertStringIncludes(selfIneligibleReason(bad) ?? "", why, bad);
});

Deno.test("資料庫另有一道 CHECK：社群、官方網域就算漏了也寫不成 self；self 的根據約束（第一階段）不動", () => {
  assert(/ALTER TABLE sources ADD CONSTRAINT sources_self_eligible CHECK \(source_kind <> 'self' OR source_self_eligible\(url\)\)/.test(body));
  assert(firstSql.includes("sources_self_needs_evidence CHECK ((source_kind = 'self') = (self_evidence IS NOT NULL))"), "第一階段的約束被改了");
});

Deno.test("source_write 只有 service_role 能呼叫；source_briefs 公開讀", () => {
  assert(/REVOKE EXECUTE ON FUNCTION source_write\(TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ\) FROM PUBLIC, anon, authenticated;/.test(body));
  assert(/GRANT EXECUTE ON FUNCTION source_write\(TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ\) TO service_role;/.test(body));
  assert(/GRANT EXECUTE ON FUNCTION source_briefs\(TEXT\[\]\) TO anon, authenticated, service_role;/.test(body));
});

Deno.test("source_write 的等級規則：只有 self 由交件決定，要認定根據（不含 platform_verified）而且通過 source_self_eligible", () => {
  const fn = sqlFunction("source_write");
  assertStringIncludes(fn, "v_self_ok := v_want_self AND v_ev IN ('linked_by_official', 'mutual_link') AND source_self_eligible(v_url);");
  assertStringIncludes(fn, "source_kind <> 'self'", "已經是 self 的不降級、不改根據");
  // 參選紀錄：讀不到的社群不掛（跟學經歷同一條）
  assertStringIncludes(fn, "p_target_table = 'politician_elections' AND NOT career_source_readable(v_url)");
  // 沒有目標：只補既有出處的等級，不新增沒人引用的列
  assertStringIncludes(fn, "SELECT id INTO v_sid FROM sources WHERE url = v_url;");
  // 協議收的認定根據與 SQL 這裡一致
  for (const e of SELF_EVIDENCES) assertStringIncludes(fn, `'${e}'`);
  assert(!fn.includes("platform_verified"), "協議不收平台認證，SQL 寫入端也不該認它");
});

Deno.test("引用範圍加參選紀錄，而且是在前一版（20261006073461）的清單上只加不減", () => {
  const prev = Deno.readTextFileSync(new URL("../../migrations/20261006073461_parties.sql", import.meta.url));
  const list = (s: string) => /CHECK \(target_table IN \(([^)]+)\)\)/.exec(s)![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
  const before = list(prev);
  const after = list(body);
  for (const t of before) assert(after.includes(t), `引用範圍少了 ${t}`);
  assert(after.includes("politician_elections"));
  assertEquals(after.length, before.length + 1);
});

Deno.test("migration 只加不刪：不刪欄位、不刪表、不改欄位型別、不動舊欄位的值；唯一的 DROP 是重建 policies_with_logs", () => {
  for (const bad of [/DROP\s+COLUMN/i, /DROP\s+TABLE/i, /ALTER\s+COLUMN[^;]*TYPE/i, /RENAME\s+(COLUMN|TO)/i, /DROP\s+FUNCTION/i, /DROP\s+TRIGGER/i, /TRUNCATE/i]) {
    assert(!bad.test(body), `migration 有 ${bad}`);
  }
  const drops = [...body.matchAll(/DROP\s+VIEW\s+IF\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
  assertEquals(drops, ["policies_with_logs"]);
  assert(!/UPDATE\s+(policies|tracking_logs|policy_sources)\s+SET/i.test(body), "migration 不該動舊欄位的值");
  assert(!/DELETE\s+FROM\s+(policies|tracking_logs|policy_sources|sources)\b/i.test(body), "migration 不該刪舊資料");
  // 同步觸發器是第二階段 B 才拿掉的，這支不能碰
  assert(!/sources_sync_(policy|tracking_log|policy_source|contribution)/.test(body));
});

Deno.test("policies_with_logs：前面的欄位一字不差，新欄位 sources 接在最後，logs 多帶舊欄位 source_url（退路）與 sources", () => {
  const prev = Deno.readTextFileSync(new URL("../../migrations/20261006034900_policy_lineages.sql", import.meta.url));
  const norm = (s: string) => s.replace(/\s+/g, " ");
  const prevView = prev.slice(prev.indexOf("CREATE VIEW policies_with_logs AS"), prev.indexOf("FROM policies p;", prev.indexOf("CREATE VIEW policies_with_logs AS")));
  const newView = sql.slice(sql.indexOf("CREATE VIEW policies_with_logs AS"), sql.indexOf("FROM policies p;", sql.indexOf("CREATE VIEW policies_with_logs AS")));
  // elements 與 lineage 那兩段原樣照抄
  for (const marker of ["AS elements,", "AS related_policy_ids,"]) {
    const grab = (v: string) => norm(v.slice(v.lastIndexOf("COALESCE(", v.indexOf(marker)), v.indexOf(marker) + marker.length));
    assertEquals(grab(newView), grab(prevView), marker);
  }
  assert(/FROM lineages l WHERE l\.id = p\.lineage_id\) AS lineage,\s*source_brief_list\('policies', p\.id::text\) AS sources\s*$/.test(norm(newView).trim() + "") ||
    norm(newView).includes("AS lineage, source_brief_list('policies', p.id::text) AS sources"));
  assertStringIncludes(norm(newView), "'source_url', tl.source_url, 'sources', source_brief_list('tracking_logs', tl.id::text)");
  assert(/ALTER VIEW policies_with_logs SET \(security_invoker = on\);/.test(body));
  assert(/GRANT SELECT ON policies_with_logs TO anon, authenticated;/.test(body));
});

Deno.test("核對視圖 source_refs_drift 涵蓋切換前要對的每一項，公開可讀；回填後只記警告、不擋部署", () => {
  for (const p of [
    "policy_url_not_in_refs", "policy_primary_differs", "policy_ref_without_url", "policy_multi_primary",
    "log_url_not_in_refs", "log_primary_differs", "log_ref_without_url", "policy_source_not_in_refs",
    "applied_policy_url_not_in_refs", "dangling_ref",
  ]) assertStringIncludes(sql, `'${p}'`);
  assert(/GRANT SELECT ON source_refs_drift TO anon, authenticated;/.test(body));
  assert(/RAISE WARNING '出處新舊兩邊有/.test(body));
  assert(!/RAISE EXCEPTION/.test(body), "差異是資料不是這支 migration 的錯，不該擋住整條部署");
});

// ── 2. 交件的 source_details ────────────────────────────────────────────────

Deno.test("source_details：本人官網附認定根據 → 收；標題、發布者照收", () => {
  const { details, problems } = parseSourceDetails(
    [{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link", title: " 政見頁 ", publisher: "候選人官網" }, { url: NEWS }],
    [OWN_SITE, NEWS],
  );
  assertEquals(problems, []);
  assertEquals(details, [{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link", title: "政見頁", publisher: "候選人官網" }, { url: NEWS }]);
});

Deno.test("source_details：社群不能標 self（臉書、IG、Threads、YouTube、X…），官方與媒體也不行", () => {
  for (const url of [FB, "https://www.instagram.com/x", "https://www.threads.net/@x", "https://www.youtube.com/@x", "https://x.com/x", OFFICIAL, NEWS]) {
    const { problems } = parseSourceDetails([{ url, kind: "self", self_evidence: "linked_by_official" }], [url]);
    assertEquals(problems.length, 1, url);
    assertEquals(problems[0].path, "source_details[0].kind");
    assertStringIncludes(problems[0].message, "不能標成本人來源");
  }
});

Deno.test("source_details：self 沒有根據、有根據不是 self、平台認證、亂填的值，各自講清楚", () => {
  const one = (item: Record<string, unknown>) => parseSourceDetails([{ url: OWN_SITE, ...item }], [OWN_SITE]).problems;
  assertStringIncludes(one({ kind: "self" })[0].message, "要附認定根據");
  assertStringIncludes(one({ self_evidence: "mutual_link" })[0].message, "只在 kind=self 時填");
  assertStringIncludes(one({ kind: "self", self_evidence: "platform_verified" })[0].message, "平台認證不收");
  assertStringIncludes(one({ kind: "self", self_evidence: "亂寫" })[0].message, "linked_by_official");
  assertStringIncludes(one({ kind: "官方" })[0].message, "official");
  assertEquals(one({ title: "x".repeat(201) }).length, 1);
  assertEquals(one({ publisher: "x".repeat(101) }).length, 1);
});

Deno.test("source_details：url 要是 source_urls 之一、不能重複、不能比 source_urls 多、格式要對", () => {
  assertEquals(parseSourceDetails([{ url: NEWS }], [OWN_SITE]).problems.length, 1, "不在 source_urls");
  assertEquals(parseSourceDetails([{ url: OWN_SITE }, { url: OWN_SITE }], [OWN_SITE]).problems.length >= 1, true, "重複");
  assertEquals(parseSourceDetails("不是陣列", [OWN_SITE]).problems.length, 1);
  assertEquals(parseSourceDetails(["字串"], [OWN_SITE]).problems.length, 1);
  assertEquals(parseSourceDetails([{ kind: "self" }], [OWN_SITE]).problems.length, 1, "沒有 url");
  assertEquals(parseSourceDetails(undefined, [OWN_SITE]), { details: [], problems: [] });
});

Deno.test("source_details：說了 self 以外的等級不報錯，伺服器照網域重判並講一聲", () => {
  const { details, problems } = parseSourceDetails([{ url: NEWS, kind: "official" }, { url: OFFICIAL, kind: "official" }, { url: OWN_SITE, kind: "other" }], [NEWS, OFFICIAL, OWN_SITE]);
  assertEquals(problems, []);
  const notice = sourceLevelNotice(details);
  assertStringIncludes(notice, NEWS);
  assertStringIncludes(notice, "記為 media");
  assert(!notice.includes(OFFICIAL), "說對的不用提醒");
  assertEquals(sourceLevelNotice([{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link" }]), "");
});

// ── 3. 交件端：schema 收下、存進 payload ────────────────────────────────────

const policyBody = (extra: Record<string, unknown>) => ({
  agent_name: "tester",
  contribution_type: "policy",
  source_urls: [OWN_SITE, NEWS],
  payload: {
    politician_id: "8aa6ee40-231a-447a-a967-99bcf8b35d3f", title: "社會住宅", category: "交通建設", status: "Campaign Pledge", election_id: 2026,
    description: "在任內興建兩萬戶社會住宅，並提高包租代管的租金補貼比例。",
  },
  ...extra,
});

Deno.test("交件：source_details 驗過後存進 payload.source_details，落庫時讀得回來", () => {
  const v = validateContributionRequest(policyBody({ source_details: [{ url: OWN_SITE, kind: "self", self_evidence: "linked_by_official", title: "候選人官網政見頁" }] }));
  assertEquals(v.errors, []);
  assertEquals(v.items[0].payload.source_details, [{ url: OWN_SITE, kind: "self", self_evidence: "linked_by_official", title: "候選人官網政見頁" }]);
  assertEquals(detailsOfPayload(v.items[0].payload, v.items[0].source_urls).length, 1);
});

Deno.test("交件：臉書標 self 整批退回，錯誤指到哪一個網址哪一欄；沒帶 source_details 照舊", () => {
  const bad = validateContributionRequest({ ...policyBody({}), source_urls: [FB, NEWS], source_details: [{ url: FB, kind: "self", self_evidence: "linked_by_official" }] });
  assertEquals(bad.ok, false);
  assertEquals(bad.errors.map((e) => e.path), ["source_details[0].kind"]);
  assertStringIncludes(bad.errors[0].message, FB);
  const plain = validateContributionRequest(policyBody({}));
  assertEquals(plain.errors, []);
  assertEquals("source_details" in plain.items[0].payload, false, "沒帶就不多一個欄位");
});

Deno.test("交件：source_details 放在 payload 裡不收（免得繞過驗證）", () => {
  const v = validateContributionRequest({ ...policyBody({}), payload: { ...policyBody({}).payload, source_details: [{ url: FB, kind: "self", self_evidence: "mutual_link" }] } });
  assertEquals(v.ok, false);
  assert(v.errors.some((e) => e.path === "payload.source_details"));
});

Deno.test("交件：平台認證當認定根據也退回", () => {
  const v = validateContributionRequest(policyBody({ source_details: [{ url: OWN_SITE, kind: "self", self_evidence: "platform_verified" }] }));
  assertEquals(v.ok, false);
  assertStringIncludes(v.errors[0].message, "平台認證不收");
});

// ── 4. 落庫：寫給資料庫的清單與目標 ──────────────────────────────────────────

Deno.test("sourcesForWrite：照 source_urls 順序，每個網址帶它的 source_details；重複與非 http(s) 略過", () => {
  const list = sourcesForWrite([NEWS, " " + OWN_SITE + " ", NEWS, "不是網址", "ftp://x.tw/a"], [{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link" }]);
  assertEquals(list, [{ url: NEWS }, { url: OWN_SITE, kind: "self", self_evidence: "mutual_link" }]);
});

Deno.test("sourceTargetFor：政見→policies、進度→tracking_logs、參選紀錄→politician_elections；其他型別或拿不到 id 沒有目標", () => {
  assertEquals(sourceTargetFor("policy", { policy_id: "p1" }), { table: "policies", id: "p1" });
  assertEquals(sourceTargetFor("policy_progress", { policy_id: "p1", tracking_log_id: "7" }), { table: "tracking_logs", id: "7" });
  assertEquals(sourceTargetFor("candidacy", { politician_election_id: "9" }), { table: "politician_elections", id: "9" });
  assertEquals(sourceTargetFor("candidacy", { politician_election_id: 0 }), { table: "politician_elections", id: "0" });
  assertEquals(sourceTargetFor("policy_progress", { policy_id: "p1" }), null, "進度要掛在進度紀錄上，不是政見上");
  assertEquals(sourceTargetFor("correction", { policy_id: "p1" }), null);
  assertEquals(sourceTargetFor("policy", {}), null);
});

type RpcCall = { name: string; args: Record<string, unknown> };
function fakeRpc(result: { error: { message: string } | null } | "throw") {
  const calls: RpcCall[] = [];
  const client = { rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); if (result === "throw") throw new Error("連不上"); return Promise.resolve(result); } };
  return { client, calls };
}

Deno.test("writeSourcesAfterApply：政見落庫 → 掛在 policies，全部網址照順序、帶本人來源的根據", async () => {
  const { client, calls } = fakeRpc({ error: null });
  const payload = { source_details: [{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link" }] };
  const n = await writeSourcesAfterApply(client, { contribution_type: "policy", payload, source_urls: [OWN_SITE, NEWS] }, { policy_id: "pol-1" });
  assertEquals(n, 2);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "source_write");
  assertEquals(calls[0].args.p_target_table, "policies");
  assertEquals(calls[0].args.p_target_id, "pol-1");
  assertEquals(calls[0].args.p_sources, [{ url: OWN_SITE, kind: "self", self_evidence: "mutual_link" }, { url: NEWS }]);
  assertEquals(calls[0].args.p_origin, "contribution");
});

Deno.test("writeSourcesAfterApply：進度 → tracking_logs；參選紀錄 → politician_elections；沒有目標又沒有 self → 不打資料庫", async () => {
  const a = fakeRpc({ error: null });
  await writeSourcesAfterApply(a.client, { contribution_type: "policy_progress", payload: {}, source_urls: [NEWS] }, { policy_id: "p", tracking_log_id: "12" });
  assertEquals([a.calls[0].args.p_target_table, a.calls[0].args.p_target_id], ["tracking_logs", "12"]);
  const b = fakeRpc({ error: null });
  await writeSourcesAfterApply(b.client, { contribution_type: "candidacy", payload: {}, source_urls: [OFFICIAL] }, { politician_election_id: "88" });
  assertEquals([b.calls[0].args.p_target_table, b.calls[0].args.p_target_id], ["politician_elections", "88"]);
  const c = fakeRpc({ error: null });
  assertEquals(await writeSourcesAfterApply(c.client, { contribution_type: "correction", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 0);
  assertEquals(c.calls.length, 0);
});

Deno.test("writeSourcesAfterApply：其他型別帶了 self → 沒有目標、只補既有出處的等級", async () => {
  const { client, calls } = fakeRpc({ error: null });
  const payload = { source_details: [{ url: PARTY_PAGE, kind: "self", self_evidence: "linked_by_official" }] };
  await writeSourcesAfterApply(client, { contribution_type: "policy_elements", payload, source_urls: [PARTY_PAGE] }, {});
  assertEquals(calls[0].args.p_target_table, null);
  assertEquals(calls[0].args.p_target_id, null);
});

Deno.test("writeSourcesAfterApply：資料庫出錯或例外都不丟出來（落庫已經成功，舊欄位的觸發器同步過主要出處）", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    assertEquals(await writeSourcesAfterApply(fakeRpc({ error: { message: "壞了" } }).client, { contribution_type: "policy", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 0);
    assertEquals(await writeSourcesAfterApply(fakeRpc("throw").client, { contribution_type: "policy", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 0);
    assertEquals(await writeSourcesAfterApply({}, { contribution_type: "policy", payload: {}, source_urls: [NEWS] }, { policy_id: "p" }), 0, "沒有 rpc 的舊測試替身也不炸");
  } finally {
    console.error = origError;
  }
});

// ── 5. 接到落庫：applyContribution 真的寫出處表 ──────────────────────────────

type Row = Record<string, unknown>;
function makeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const rpcCalls: RpcCall[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push((r) => String(r[col]) === String(val)); return api; },
      is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return api; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return api; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return api; },
      ilike: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: (tables.get(table) ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => unknown) => res({ data: (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: (row: Row | Row[]) => {
        const arr = Array.isArray(row) ? row : [row];
        const base = (tables.get(table) ?? []).length;
        const withIds = arr.map((r, i) => ({ id: `${table}-${base + i + 1}`, ...r }));
        tables.set(table, [...(tables.get(table) ?? []), ...withIds]);
        // deno-lint-ignore no-explicit-any
        const done: any = Promise.resolve({ error: null });
        done.select = () => ({ maybeSingle: () => Promise.resolve({ data: withIds[0], error: null }) });
        return done;
      },
      update: (patch: Row) => ({
        eq: (col: string, val: unknown) => {
          for (const r of tables.get(table) ?? []) if (String(r[col]) === String(val)) Object.assign(r, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return api;
  }
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from,
    rpc: (name: string, args: Row) => { rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }); },
  };
  return { client, tables, rpcCalls };
}

const POL = "8aa6ee40-231a-447a-a967-99bcf8b35d3f";
const baseRow = { note: null, agent_name: "tester", contributor_url: null };

Deno.test("落庫：新增政見 → 出處表直接寫（掛在新政見上，本人來源的根據帶過去）", async () => {
  const { client, rpcCalls } = makeDb({ politicians: [{ id: POL, name: "王小明", merged_into: null }], policies: [], edit_history: [] });
  const out = await applyContribution(client, {
    ...baseRow, id: "c1", contribution_type: "policy", source_urls: [OWN_SITE, NEWS],
    payload: {
      politician_id: POL, title: "社會住宅", description: "在任內興建兩萬戶社會住宅，並提高包租代管的租金補貼比例。", category: "交通建設", status: "Campaign Pledge", election_id: 2026,
      source_details: [{ url: OWN_SITE, kind: "self", self_evidence: "linked_by_official" }],
    },
  });
  assertEquals(out.status, "applied");
  const w = rpcCalls.filter((c) => c.name === "source_write");
  assertEquals(w.length, 1);
  assertEquals(w[0].args.p_target_table, "policies");
  assertEquals(w[0].args.p_target_id, out.policy_id);
  assertEquals((w[0].args.p_sources as Row[]).map((s) => s.url), [OWN_SITE, NEWS]);
  assertEquals((w[0].args.p_sources as Row[])[0].kind, "self");
});

Deno.test("落庫：進度更新 → 出處掛在進度紀錄上；參選紀錄 → 掛在參選紀錄上", async () => {
  const db = makeDb({
    politicians: [{ id: POL, name: "王小明", merged_into: null }],
    policies: [{ id: "pol-1", politician_id: POL, title: "社會住宅", status: "Campaign Pledge", progress: 0, last_updated: "2026-01-01", removed_at: null }],
    tracking_logs: [], edit_history: [], politician_elections: [],
  });
  const progress = await applyContribution(db.client, {
    ...baseRow, id: "c2", contribution_type: "policy_progress", source_urls: [OFFICIAL, NEWS],
    payload: { policy_id: "pol-1", status: "In Progress", progress: 30, date: "2026-10-01", note: "市府公布第一批基地。" },
  });
  assertEquals(progress.status, "applied");
  assert(progress.tracking_log_id, "落庫結果帶出進度紀錄 id");
  const w = db.rpcCalls.filter((c) => c.name === "source_write");
  assertEquals(w[0].args.p_target_table, "tracking_logs");
  assertEquals(w[0].args.p_target_id, progress.tracking_log_id);

  const cand = await applyContribution(db.client, {
    ...baseRow, id: "c3", contribution_type: "candidacy", source_urls: ["https://web.cec.gov.tw/announce/1"],
    payload: { politician_id: POL, name: "王小明", election_id: 2026, election_type: "縣市長", region: "台北市", candidate_status: "registered" },
  });
  assertEquals(cand.status, "applied");
  assert(cand.politician_election_id, "落庫結果帶出參選紀錄 id");
  const w2 = db.rpcCalls.filter((c) => c.name === "source_write").at(-1)!;
  assertEquals(w2.args.p_target_table, "politician_elections");
  assertEquals(w2.args.p_target_id, cand.politician_election_id);
});

Deno.test("落庫：失敗的不寫出處（找不到人 → failed，不打 source_write）", async () => {
  const { client, rpcCalls } = makeDb({ politicians: [], policies: [] });
  const out = await applyContribution(client, {
    ...baseRow, id: "c4", contribution_type: "policy", source_urls: [NEWS],
    payload: { politician_id: POL, title: "社會住宅", description: "在任內興建兩萬戶社會住宅，並提高包租代管的租金補貼比例。", category: "交通建設", status: "Campaign Pledge", election_id: 2026 },
  });
  assertEquals(out.status, "failed");
  assertEquals(rpcCalls.filter((c) => c.name === "source_write").length, 0);
});

// ── 6. 協議 ────────────────────────────────────────────────────────────────

Deno.test("協議 1.62.0：skill.md 寫清楚 source_details、self 的條件、社群不收、平台認證不收、不改計分", () => {
  // 版號只要不比 1.62.0 舊（每次升版都回頭改這一行，並行的 PR 一定撞）
  const [maj, min] = PROTOCOL_VERSION.split(".").map(Number);
  assert(maj > 1 || (maj === 1 && min >= 62), `協議版號 ${PROTOCOL_VERSION} 比 1.62.0 舊`);
  const at = skill.indexOf("1c. **出處可以標等級");
  assert(at > 0, "skill.md 缺第 1c 條");
  const rule = skill.slice(at, skill.indexOf("\n2. **來源必須證明", at));
  for (const need of [
    "source_details", "self_evidence", "linked_by_official", "mutual_link", "臉書、IG、Threads", "YouTube、X、LINE、TikTok、Telegram",
    "platform_verified", "官方網域", "新聞媒體不是本人來源", "不改計分", "不改門檻", "沒有認定根據的本人帳號一律算媒體",
  ]) assertStringIncludes(rule, need);
  for (const kind of ["official", "self", "media", "other"]) assertStringIncludes(rule, `\`${kind}\``);
  // 協議文字講的清單＝程式的清單
  for (const e of SELF_EVIDENCES) assertStringIncludes(rule, e);
});
