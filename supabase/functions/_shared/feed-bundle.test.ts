/**
 * contributions-feed 單一 RPC（contributions_feed_bundle）的守門測試（Edge Function 內部 REST 瘦身 第 1 期 PR-2）。
 *
 * PGlite 真的建表、執行真的 migration；真的載入 contributions-feed 入口、用真的 Request 打進去，
 * 入口檔發出去的 PostgREST 請求翻成真的 SQL（report-pglite.ts 的 pgrstRouter）。
 * 「舊路徑」＝兩支單一 RPC 回不存在、入口檔退回多次查詢；「新路徑」＝單一 RPC。同一份程式、同一份資料，整份回應逐 byte 比對。
 * 另外守：篩選與分頁各組合、limit 邊界、RPC 失敗退回舊路徑、權限（只給 service_role）、一次請求打幾次 REST（新 ≤ 2、舊 ≥ 6）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { loadEntry, type RestCall } from "./entry-harness.ts";
import { isFeedBundle } from "./feed-bundle.ts";
import { makeReportDb, pgrstRouter } from "./report-pglite.ts";
import { ATTENTION_STATUSES } from "./contribution-summary.ts";

const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const POL2 = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10ea";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const LIN = "0c9c1a5e-1111-4222-8333-666666666666";
const UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const F = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const SEED = `
INSERT INTO politicians VALUES ('${POL}', '王小明'), ('${POL2}', '李大華');
INSERT INTO policies VALUES ('${POLICY}', '長者健保全免', false, '2024-04-02', '${POL}');
INSERT INTO lineages VALUES ('${LIN}', '長照脈絡');
INSERT INTO parties VALUES (2, '丙黨'), (3, '甲黨'), (7, '乙黨');
INSERT INTO elections VALUES (2026, '2099-11-28', NULL);
INSERT INTO politician_elections VALUES (901, '${POL}', 2026, '縣市長', NULL), (902, '${POL}', 2026, '村里長', NULL);
INSERT INTO admin_divisions VALUES ('10007', '彰化縣', '彰化市', NULL);
INSERT INTO sources (url, source_kind, self_evidence, doc_kind, archive_url, title, publisher) VALUES
  ('https://www.cna.com.tw/a', 'media', NULL, NULL, NULL, '中央社報導', '中央社'),
  ('https://db.cec.gov.tw/c', 'official', NULL, 'election_bulletin', 'https://web.archive.org/web/2026/https://db.cec.gov.tw/c', '選舉公報', '中選會');

INSERT INTO contributions (id, contribution_type, payload, source_urls, agent_name, agent_tool, status, review_notes, applied_at, applied_politician_id, applied_policy_id,
  created_at, agree_count, disagree_count, unsure_count, score, contributor_ip_hash, actor_id, last_activity_at, last_activity) VALUES
 ('${F(1)}', 'policy', '{"politician_id":"${POL}","title":"長者健保全免","category":"社會福利"}', '{https://www.cna.com.tw/a}', 'alice', 'claude-code/opus', 'applied', '[auto] 政見已建立', '2026-09-10T01:00:00Z', '${POL}', '${POLICY}', '2026-09-09T23:00:00Z', 2, 0, 0, 3, 'secret', 'ditrust:A', '2026-09-10T01:00:00Z', 'applied'),
 ('${F(2)}', 'policy_progress', '{"policy_id":"${POLICY}","status":"In Progress","progress":40,"note":"預算三讀通過"}', '{https://www.ly.gov.tw/b}', 'bob', NULL, 'applied', NULL, '2026-09-11T02:00:00Z', NULL, '${POLICY}', '2026-09-11T01:00:00Z', 1, 0, 0, NULL, 'secret', NULL, '2026-09-11T02:00:00Z', 'applied'),
 ('${F(3)}', 'correction', '{"target_table":"policies","target_id":"${POLICY}","field":"proposed_date","correct_value":"2024-04-02"}', '{https://db.cec.gov.tw/c}', 'carol', NULL, 'disputed', NULL, NULL, NULL, NULL, '2026-09-12T03:00:00Z', 0, 2, 0, -2, 'secret', NULL, '2026-09-12T03:20:00Z', 'voted'),
 ('${F(4)}', 'adjudication', '{"contribution_id":"${F(3)}","verdict":"uphold","reason":"公報確實寫 2024-04-02"}', '{https://db.cec.gov.tw/c}', 'dave', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-12T05:00:00Z', 1, 0, 0, 1, 'secret', NULL, '2026-09-12T05:00:00Z', 'created'),
 ('${F(5)}', 'politician', '{"name":"王小明","birth_year":1966,"admin_code":"10007"}', '{https://www.ly.gov.tw/p}', 'erin', NULL, 'applied', NULL, '2026-09-08T00:00:00Z', '${POL}', NULL, '2026-09-07T00:00:00Z', 1, 0, 0, 1, 'secret', NULL, '2026-09-08T00:00:00Z', 'applied'),
 ('${F(6)}', 'candidacy', '{"name":"王小明","election_id":2026,"election_type":"縣市長","target_table":"politician_elections","target_id":901}', '{https://www.cna.com.tw/d}', 'frank', NULL, 'reverted', '[revert by xiaoliang] 還原 1 個變更', '2026-09-06T00:00:00Z', '${POL}', NULL, '2026-09-05T00:00:00Z', 6, 0, 0, NULL, 'secret', NULL, '2026-09-07T12:00:00Z', 'reverted'),
 ('${F(7)}', 'party_info', '{"parties":[{"party_id":3,"predecessor_id":2}]}', NULL, 'gina', NULL, 'applied', NULL, NULL, '${POL}', NULL, '2026-09-13T00:00:00Z', 1, 0, 0, 1, 'secret', NULL, '2026-09-13T00:00:00Z', 'applied'),
 ('${F(8)}', 'candidacy', '{"politician_election_id":902,"party":"乙黨"}', '{https://www.cna.com.tw/a}', 'hank', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-14T00:00:00Z', 1, 0, 0, 1, 'secret', NULL, '2026-09-14T01:00:00Z', 'voted'),
 ('${F(9)}', 'lineage', '{"lineage_id":"${LIN}","politician_id":"${POL}"}', '{https://www.cna.com.tw/a, "  https://db.cec.gov.tw/c  "}', 'ivy', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-15T00:00:00Z', 0, 0, 0, 0, 'secret', NULL, '2026-09-15T00:00:00Z', 'created'),
 ('${F(10)}', 'policy_progress', '{"policy_id":"${UNKNOWN}"}', '{https://www.ly.gov.tw/z}', 'jack', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-16T00:00:00Z', 0, 0, 0, NULL, 'secret', 'ditrust:A', NULL, NULL),
 ('${F(11)}', 'no_change', '{"task_id":"auto:x:1"}', NULL, 'kate', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-17T00:00:00Z', 0, 0, 0, 1, 'secret', NULL, '2026-09-17T00:00:00Z', 'voted'),
 ('${F(12)}', 'policy', '{"politician_id":"${POL2}","title":"夜間托育"}', '{https://www.cna.com.tw/a}', 'alice', NULL, 'rejected', '退件', NULL, NULL, NULL, '2026-09-18T00:00:00Z', 0, 3, 0, -3, 'secret', NULL, '2026-09-18T00:00:00Z', 'rejected'),
 ('${F(13)}', 'policy', '{"politician_id":"${POL2}","title":"長者免費接送"}', '{https://www.cna.com.tw/a}', 'alice', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-19T00:00:00Z', 0, 0, 2, 0, 'secret', NULL, '2026-09-19T00:00:00Z', 'voted');
`;

const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789" } as Record<string, string>;

let dbPromise: Promise<PGlite> | null = null;
const getDb = () => (dbPromise ??= (async () => { const db = await makeReportDb(); await db.exec(SEED); return db; })());

interface Called { status: number; text: string; calls: RestCall[]; warns: string[] }

async function callFeed(db: PGlite, query: string, mode: "new" | "legacy" | { bundleReply: unknown }): Promise<Called> {
  const opts = mode === "new" ? {} : mode === "legacy" ? { legacy: true } : { bundleReply: mode.bundleReply };
  const entry = await loadEntry("../contributions-feed/index.ts", env, pgrstRouter(db, opts));
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  try {
    const res = await entry.call(new Request(`https://x/contributions-feed${query}`));
    return { status: res.status, text: await res.text(), calls: entry.calls, warns };
  } finally { console.warn = orig; entry.restore(); }
}

const QUERIES: Array<[string, string]> = [
  ["預設（all，第一頁，帶統計與筆數）", ""],
  ["status=attention", "?status=attention"],
  ["status=voting", "?status=voting"],
  ["status=pending", "?status=pending"],
  ["status=applied", "?status=applied"],
  ["status=disputed", "?status=disputed"],
  ["status=rejected（有退件）", "?status=rejected"],
  ["status=verified（沒有任何一筆）", "?status=verified"],
  ["agent_name 篩選", "?agent_name=alice"],
  ["actor_id 篩選", "?actor_id=ditrust:A"],
  ["type 篩選", "?type=candidacy"],
  ["status＋agent＋type 疊在一起", "?status=pending&agent_name=alice&type=policy"],
  ["limit=2：多撈一筆判斷有下一頁", "?limit=2"],
  ["limit=1 與非法 limit 夾成預設", "?limit=1"],
  ["limit=999 夾成 50", "?limit=999"],
  ["summary=0：只要筆數、不要統計", "?summary=0"],
  ["翻頁（帶 cursor）：不算筆數、不算統計", `?limit=3&cursor=${encodeURIComponent("2026-09-14T00:00:00+00:00")}`],
  ["cursor 的 + 被解成空白（舊的壞網址）", "?limit=3&cursor=2026-09-14T00:00:00 00:00"],
  ["什麼都對不上", "?agent_name=nobody"],
];

for (const [name, query] of QUERIES) {
  Deno.test(`新舊路徑逐 byte 相同：${name}`, async () => {
    const db = await getDb();
    const legacy = await callFeed(db, query, "legacy");
    const viaRpc = await callFeed(db, query, "new");
    assertEquals(viaRpc.status, 200, viaRpc.text);
    assertEquals(viaRpc.text, legacy.text);
    assert(!/ip_hash|secret/.test(viaRpc.text), "不回任何 ip_hash");
    assert(viaRpc.calls.some((c) => c.target === "rpc/contributions_feed_bundle"), "新路徑有走單一 RPC");
    assert(legacy.calls.some((c) => c.target === "contributions"), "舊路徑照原本的多次查詢");
  });
}

Deno.test("內容：翻頁游標、筆數與統計、名稱對照、出處摘要都真的帶到（比對的不是兩份空的）", async () => {
  const db = await getDb();
  const all = JSON.parse((await callFeed(db, "?limit=50", "new")).text);
  assertEquals(all.count, 13);
  assertEquals(all.filtered_total, 13);
  assertEquals(all.has_more, false);
  assert(all.summary && all.summary.by_status.pending === 6,"第一頁帶統計");
  const text = JSON.stringify(all.items);
  assert(text.includes("王小明") && text.includes("長者健保全免"), "名稱對照");
  assert(text.includes("乙黨") || text.includes("甲黨"), "政黨名稱對照");
  const raw = (await db.query<{ b: { lookup: { regions: Array<{ code: string; county: string }>; originals: Array<{ id: string }> } } }>(
    `SELECT contributions_feed_bundle('{"limit": 50}'::jsonb) AS b`)).rows[0].b;
  assertEquals(raw.lookup.regions.map((r) => r.code), ["10007"], "行政區代碼的名稱原料");
  assertEquals(raw.lookup.originals.map((o) => o.id), [F(3)], "裁決指向的原貢獻");
  assert(text.includes("web.archive.org"), "出處摘要帶存檔網址");
  const sources = (all.items as Array<{ id: string; sources: Array<{ kind: string }> }>).find((i) => i.id === F(9))!.sources;
  assertEquals(sources.map((s) => s.kind).sort(), ["media", "official"], "前後空白的網址去空白後對得到出處表");
  const p1 = JSON.parse((await callFeed(db, "?limit=2", "new")).text);
  assertEquals(p1.count, 2);
  assertEquals(p1.has_more, true);
  assertEquals(p1.items.map((i: { id: string }) => i.id), [F(10), F(13)], "依最後變動時間由新到舊；空值排最前（資料庫 DESC 預設，PostgREST 同）");
  assert(typeof p1.next_cursor === "string");
  const p2 = JSON.parse((await callFeed(db, `?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, "new")).text);
  assertEquals(p2.filtered_total, null);
  assertEquals(p2.summary, null);
  assertEquals(p2.items.map((i: { id: string }) => i.id), [F(12), F(11)]);
});

Deno.test("limit 邊界：0 與負數夾成 1、999 夾成 50、空值 20（RPC 本身）", async () => {
  const db = await getDb();
  const n = async (lim: string) => (await db.query<{ n: number }>(`SELECT jsonb_array_length(contributions_feed_bundle('{"limit": ${lim}}'::jsonb)->'rows')::int AS n`)).rows[0].n;
  assertEquals(await n("0"), 2, "夾成 1，多撈一筆＝2");
  assertEquals(await n("-5"), 2);
  assertEquals(await n("1"), 2);
  assertEquals(await n("20"), 13);
  assertEquals(await n("999"), 13);
  const nul = (await db.query<{ n: number }>(`SELECT jsonb_array_length(contributions_feed_bundle('{}'::jsonb)->'rows')::int AS n`)).rows[0].n;
  assertEquals(nul, 13, "沒給 limit 當 20");
});

Deno.test("ATTENTION_STATUSES 與 SQL 裡寫的一樣（SQL 把它寫死成 disputed）", async () => {
  assertEquals([...ATTENTION_STATUSES], ["disputed"]);
  const sql = await Deno.readTextFile(new URL("../../migrations/20261127094500_feed_report_bundle_rpc.sql", import.meta.url));
  assert(sql.includes("c.status = ANY (ARRAY['disputed'])"));
});

Deno.test("RPC 失敗就退回舊路徑：函式不存在、形狀不對、回 null，輸出都與舊路徑相同並 console.warn 一行", async () => {
  const db = await getDb();
  const legacy = await callFeed(db, "", "legacy");
  const replies: Array<[string, unknown]> = [["形狀不對（空陣列）", []], ["缺欄位", { rows: [] }], ["回 null", null], ["函式不存在", undefined]];
  for (const [name, reply] of replies) {
    const r = await callFeed(db, "", { bundleReply: reply });
    assertEquals(r.text, legacy.text, name);
    assertEquals(r.warns.filter((w) => w.includes("contributions_feed_bundle")).length, 1, `${name}：warn 一行`);
    assert(r.calls.length >= 6, `${name}：確實走了舊路徑（${r.calls.length} 次）`);
  }
  assert(!isFeedBundle([]) && !isFeedBundle(null) && !isFeedBundle({ rows: [] }));
});

Deno.test("RPC 權限：只有 service_role 能執行；PUBLIC、anon、authenticated 都不行；SECURITY INVOKER、有 statement_timeout", async () => {
  const db = await getDb();
  for (const sig of ["contributions_feed_bundle(jsonb)", "report_context_bundle(text, jsonb)", "feed_summary_material(uuid[])"]) {
    const can = async (role: string) => (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS ok`)).rows[0].ok;
    assertEquals(await can("service_role"), true, sig);
    assertEquals(await can("anon"), false, sig);
    assertEquals(await can("authenticated"), false, sig);
  }
  for (const fn of ["contributions_feed_bundle", "report_context_bundle", "feed_summary_material"]) {
    const pub = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = '${fn}' AND a.grantee = 0`);
    assertEquals(pub.rows[0].n, 0, `${fn}：PUBLIC 不能有 EXECUTE`);
    const inv = await db.query<{ definer: boolean; c: string[] | null }>(`SELECT prosecdef AS definer, proconfig AS c FROM pg_proc WHERE proname = '${fn}'`);
    assertEquals(inv.rows[0].definer, false, `${fn} 用 SECURITY INVOKER`);
    assert(inv.rows[0].c?.some((x) => x.startsWith("search_path=")), `${fn} 要固定 search_path`);
  }
  for (const fn of ["contributions_feed_bundle", "report_context_bundle"]) {
    const cfg = await db.query<{ c: string[] }>(`SELECT proconfig AS c FROM pg_proc WHERE proname = '${fn}'`);
    assert(cfg.rows[0].c.some((x) => x === "statement_timeout=8s"), `${fn} 要有 statement_timeout 8s`);
  }
});

Deno.test("計數守門：新路徑一次請求最多打 2 次 REST（實際 1 次），舊路徑 6 次以上；翻頁也一樣", async () => {
  const db = await getDb();
  for (const q of ["", "?limit=3&cursor=" + encodeURIComponent("2026-09-14T00:00:00+00:00"), "?status=pending"]) {
    const a = await callFeed(db, q, "new");
    const b = await callFeed(db, q, "legacy");
    console.log(`[REST 次數] contributions-feed ${q || "（第一頁）"}：舊路徑 ${b.calls.length} 次，新路徑 ${a.calls.length} 次（${a.calls.map((c) => c.target).join(",")}）`);
    assert(a.calls.length <= 2, `新路徑 ${a.calls.length} 次：${a.calls.map((c) => c.target).join(",")}`);
    assertEquals(a.calls.filter((c) => c.target === "rpc/contributions_feed_bundle").length, 1);
    assert(b.calls.length >= 6, `舊路徑只有 ${b.calls.length} 次，守門比較對象不對了`);
  }
});
