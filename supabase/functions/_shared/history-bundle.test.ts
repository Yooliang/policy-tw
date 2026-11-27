/**
 * history 單一 RPC（history_bundle）的守門測試（Edge Function 內部 REST 瘦身 第 1 期 PR-1）。
 *
 * PGlite 真的建表、執行真的 migration；「舊路徑」（多次查詢）與「新路徑」（單一 RPC）打同一份資料，
 * 組出 history/index.ts 回給瀏覽器的整份 JSON，逐 byte 比對。另外守：limit 邊界、RPC 失敗退回舊路徑、
 * RPC 權限（只給 service_role，PUBLIC／anon／authenticated 都不行）、一次請求打幾次 REST（新 ≤ 2、舊 ≥ 10）。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  buildHistory, collectHistory, collectHistoryLegacy, collectWebRequests, collectWebRequestsLegacy, describeOrigin,
  type HistoryTarget, pageEntries,
} from "./history.ts";
import { isHistoryBundle } from "./history-bundle.ts";
import { makeHistoryDb, sqlBackedClient } from "./history-pglite.ts";

const POL = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9";
const POL2 = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10ea";
const POL_EMPTY = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10eb";
const POLICY = "0c9c1a5e-1111-4222-8333-444444444444";
const POLICY_EMPTY = "0c9c1a5e-1111-4222-8333-555555555555";
const LIN = "0c9c1a5e-1111-4222-8333-666666666666";
const TL = "0c9c1a5e-1111-4222-8333-777777777777";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const C4 = "44444444-4444-4444-8444-444444444444";
const C5 = "55555555-5555-4555-8555-555555555555";
const C6 = "66666666-6666-4666-8666-666666666666";
const C7 = "77777777-7777-4777-8777-777777777777";
const C8 = "88888888-8888-4888-8888-888888888888";
const C9 = "99999999-9999-4999-8999-999999999999";
const C10 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C11 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_ADJ = "cccccccc-0000-4ccc-8ccc-000000000000";
const W1 = "dddddddd-0000-4ddd-8ddd-000000000001";
const W2 = "dddddddd-0000-4ddd-8ddd-000000000002";
const W3 = "dddddddd-0000-4ddd-8ddd-000000000003";
const W4 = "dddddddd-0000-4ddd-8ddd-000000000004";
const UNKNOWN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const SEED = `
INSERT INTO politicians VALUES ('${POL}', '王小明'), ('${POL2}', '李大華'), ('${POL_EMPTY}', '陳無紀錄');
INSERT INTO policies VALUES ('${POLICY}', '長者健保全免', false, '2024-04-02', '${POL}'), ('${POLICY_EMPTY}', '空白政見', true, NULL, '${POL}');
INSERT INTO lineages VALUES ('${LIN}', '長照脈絡');
INSERT INTO parties VALUES (2, '丙黨'), (3, '甲黨'), (7, '乙黨');
INSERT INTO elections VALUES (2026, '2099-11-28', NULL), (2022, '2022-11-26', NULL);
INSERT INTO politician_elections VALUES
  (901, '${POL}', 2026, '縣市長', '中央社 2026-09-04 登記參選名單'), (902, '${POL}', 2026, '村里長', ''),
  (903, '${POL_EMPTY}', 2026, '縣市長', '某報導；另一則'), (904, '${POL2}', 2026, '縣市議員', NULL);
INSERT INTO tracking_logs VALUES ('${TL}', '${POLICY}', '預算通過');
INSERT INTO admin_divisions VALUES ('10007', '彰化縣', '彰化市', NULL);
INSERT INTO sources (url, source_kind, self_evidence, doc_kind, archive_url, title, publisher) VALUES
  ('https://www.cna.com.tw/a', 'media', NULL, NULL, NULL, '中央社報導', '中央社'),
  ('https://db.cec.gov.tw/c', 'official', NULL, 'election_bulletin', 'https://web.archive.org/web/2026/https://db.cec.gov.tw/c', '選舉公報', '中選會');
INSERT INTO source_refs (source_id, target_table, target_id, role) VALUES (1, 'policies', '${POLICY}', 'primary'), (2, 'policies', '${POLICY_EMPTY}', 'primary');

INSERT INTO contributions (id, contribution_type, payload, source_urls, agent_name, agent_tool, status, review_notes, applied_at, applied_politician_id, applied_policy_id, created_at, agree_count, disagree_count, score, contributor_ip_hash) VALUES
 ('${C1}', 'policy', '{"politician_id":"${POL}","title":"長者健保全免","category":"社會福利"}', '{https://www.cna.com.tw/a}', 'alice', 'claude-code/opus', 'applied', '[auto] 政見已建立', '2026-09-10T01:00:00Z', '${POL}', '${POLICY}', '2026-09-09T23:00:00Z', 2, 0, 3, 'secret'),
 ('${C2}', 'policy_progress', '{"policy_id":"${POLICY}","status":"In Progress","progress":40,"note":"預算三讀通過"}', '{https://www.ly.gov.tw/b}', 'bob', NULL, 'applied', NULL, '2026-09-11T02:00:00Z', NULL, '${POLICY}', '2026-09-11T01:00:00Z', 1, 0, NULL, 'secret'),
 ('${C3}', 'correction', '{"target_table":"policies","target_id":"${POLICY}","field":"proposed_date","correct_value":"2024-04-02"}', '{https://db.cec.gov.tw/c}', 'carol', NULL, 'disputed', NULL, NULL, NULL, NULL, '2026-09-12T03:00:00Z', 0, 2, -2, 'secret'),
 ('${C4}', 'adjudication', '{"contribution_id":"${C3}","verdict":"uphold","reason":"公報確實寫 2024-04-02","checked_urls":["https://db.cec.gov.tw/c"]}', '{https://db.cec.gov.tw/c}', 'dave', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-12T05:00:00Z', 1, 0, NULL, 'secret'),
 ('${C5}', 'politician', '{"name":"王小明","birth_year":1966,"admin_code":"10007"}', '{https://www.ly.gov.tw/p}', 'erin', NULL, 'applied', NULL, '2026-09-08T00:00:00Z', '${POL}', NULL, '2026-09-07T00:00:00Z', 1, 0, 1, 'secret'),
 ('${C6}', 'candidacy', '{"name":"王小明","election_id":2026,"election_type":"縣市長","target_table":"politician_elections","target_id":901}', '{https://www.cna.com.tw/d}', 'frank', NULL, 'reverted', '[revert by xiaoliang] 還原 1 個變更', '2026-09-06T00:00:00Z', '${POL}', NULL, '2026-09-05T00:00:00Z', 6, 0, NULL, 'secret'),
 ('${C7}', 'party_info', '{"parties":[{"party_id":3,"predecessor_id":2}]}', NULL, 'gina', NULL, 'applied', NULL, NULL, '${POL}', NULL, '2026-09-13T00:00:00Z', 1, 0, 1, 'secret'),
 ('${C8}', 'candidacy', '{"politician_election_id":902,"party":"乙黨"}', '{https://www.cna.com.tw/a}', 'hank', NULL, 'applied', NULL, '2026-09-14T01:00:00Z', NULL, NULL, '2026-09-14T00:00:00Z', 1, 0, 1, 'secret'),
 ('${C9}', 'lineage', '{"lineage_id":"${LIN}","politician_id":"${POL}"}', '{https://www.cna.com.tw/a, "  https://db.cec.gov.tw/c  "}', 'ivy', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-15T00:00:00Z', 0, 0, 0, 'secret'),
 ('${C10}', 'policy_progress', '{"policy_id":"${UNKNOWN}"}', '{https://www.ly.gov.tw/z}', 'jack', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-16T00:00:00Z', 0, 0, 0, 'secret'),
 ('${C11}', 'no_change', '{"task_id":"${W1}"}', NULL, 'kate', NULL, 'pending', NULL, NULL, NULL, NULL, '2026-09-17T00:00:00Z', 0, 0, 0, 'secret');
UPDATE contributions SET task_id = '${W2}' WHERE id = '${C10}';

INSERT INTO contribution_votes VALUES
 ('${C1}', 'agree', NULL, NULL, 'bob', 'gemini-cli/2.5', NULL, '2026-09-10T00:30:00Z', 'secret'),
 ('${C1}', 'agree', '中央社報導第二段', NULL, 'carol', NULL, NULL, '2026-09-10T00:50:00Z', 'secret'),
 ('${C3}', 'disagree', '公報寫的是 2026-05-26', 'https://db.cec.gov.tw/x', 'bob', NULL, NULL, '2026-09-12T03:10:00Z', 'secret'),
 ('${C3}', 'disagree', '同上', 'https://db.cec.gov.tw/y', 'erin', NULL, '${POL2}', '2026-09-12T03:20:00Z', 'secret');
INSERT INTO edit_history (contribution_id, table_name, record_id, field, old_value, new_value, applied_at, reverted_at, reverted_by) VALUES
 ('${C1}', 'policies', '${POLICY}', '*', NULL, '{"id":"${POLICY}","title":"長者健保全免"}', '2026-09-10T01:00:00Z', NULL, NULL),
 ('${C2}', 'policies', '${POLICY}', 'progress', '10', '40', '2026-09-11T02:00:00Z', NULL, NULL),
 ('${C2}', 'tracking_logs', '${TL}', '*', NULL, '{"id":"${TL}","policy_id":"${POLICY}"}', '2026-09-11T02:00:00Z', NULL, NULL),
 ('${C5}', 'politicians', '${POL}', 'birth_year', NULL, '1966', '2026-09-08T00:00:00Z', NULL, NULL),
 ('${C6}', 'politician_elections', '901', 'candidacy_status', '"considering"', '"filed"', '2026-09-06T00:00:00Z', '2026-09-07T12:00:00Z', 'xiaoliang'),
 ('${C8}', 'politician_elections', '902', 'party_id', '3', '7', '2026-09-14T01:00:00Z', NULL, NULL),
 ('${C8}', 'politician_elections', '902', 'party_basis', NULL, '"cec"', '2026-09-14T01:00:00Z', NULL, NULL);

INSERT INTO contribution_tasks (id, task_type, status, target, created_at, closed_at, source) VALUES
 ('${T_ADJ}', 'adjudicate', 'open', '{"contribution_id":"${C3}"}', '2026-09-12T03:21:00Z', NULL, NULL),
 ('${W1}', 'policy_missing', 'open', '{"politician_id":"${POL}"}', '2026-09-20T00:00:00Z', NULL, 'web_request'),
 ('${W2}', 'profile_gap', 'open', '{"politician_id":"${POL}"}', '2026-09-21T00:00:00Z', NULL, 'web_request'),
 ('${W3}', 'policy_validity', 'closed', '{"politician_id":"${POL}"}', '2026-09-18T00:00:00Z', '2026-09-19T00:00:00Z', 'web_request'),
 ('${W4}', 'progress_stale', 'open', '{"policy_id":"${POLICY}"}', '2026-09-22T00:00:00Z', NULL, 'web_request');
`;

type Path = "new" | "legacy";

/** history/index.ts 組回應的那一段（collect → buildHistory → pageEntries → describeOrigin），回 JSON 字串 */
async function render(client: unknown, target: HistoryTarget, id: string, path: Path, limit = 20): Promise<string> {
  const data = path === "new" ? await collectHistory(client, target, id) : await collectHistoryLegacy(client, target, id);
  const webRequests = path === "new" ? await collectWebRequests(client, target, id) : await collectWebRequestsLegacy(client, target, id);
  const entries = buildHistory(data);
  const page = pageEntries(entries, limit, null);
  const origin = describeOrigin(target, data.origin_row, data.election_notes, entries.length > 0);
  if (target !== "contribution" && !data.origin_row && entries.length === 0) return JSON.stringify({ success: false, error: "not_found" });
  return JSON.stringify({
    success: true, target, id, total: entries.length, count: page.items.length, has_more: page.has_more, next_cursor: page.next_cursor,
    origin, web_requests: webRequests, entries: page.items,
  });
}

let dbPromise: Promise<PGlite> | null = null;
const getDb = () => (dbPromise ??= (async () => { const db = await makeHistoryDb(); await db.exec(SEED); return db; })());

const CASES: Array<{ name: string; target: HistoryTarget; id: string; expect: (body: Record<string, unknown>) => void }> = [
  {
    name: "人物（直接掛、payload 引用、經修改紀錄補撈、政黨名稱、停放的網站請求）", target: "politician", id: POL,
    expect: (b) => {
      assertEquals(b.total, 6, "人物履歷：直接掛 4 筆、payload 引用 1 筆、經修改紀錄補撈 1 筆");
      const s = JSON.stringify(b);
      assert(s.includes("乙黨") && s.includes("甲黨"), "履歷 party_id 與 party_info 的政黨名稱");
      assert(s.includes("長照脈絡"), "payload 的 lineage_id 換成名稱");
      const wr = b.web_requests as Array<{ id: string; status: string; reports: unknown[] }>;
      assertEquals(wr.map((w) => w.status).sort(), ["closed", "open", "parked"]);
      assertEquals(wr.find((w) => w.id === W1)!.reports.length, 1, "no_change 只寫在 payload.task_id 的回報");
      assertEquals(wr.find((w) => w.id === W2)!.reports.length, 1, "掛在任務 task_id 欄的回報");
    },
  },
  {
    name: "政見（出處、更正與裁決、追蹤紀錄的修改）", target: "policy", id: POLICY,
    expect: (b) => {
      assertEquals((b.entries as unknown[]).length, 3);
      assert(JSON.stringify(b).includes("web.archive.org"), "交件網址帶出處表的存檔網址");
      assertEquals((b.web_requests as unknown[]).length, 1);
    },
  },
  {
    name: "單筆貢獻：更正（有票、有裁決與裁決任務）", target: "contribution", id: C3,
    expect: (b) => {
      assertEquals((b.entries as unknown[]).length, 1);
      const e = (b.entries as Array<{ verifiers: unknown[]; adjudications: unknown[] }>)[0];
      assertEquals(e.verifiers.length, 2);
      assertEquals(e.adjudications.length, 1);
    },
  },
  { name: "單筆貢獻：裁決本身（履歷不列裁決）", target: "contribution", id: C4, expect: (b) => assertEquals(b.entries, []) },
  {
    name: "政見沒有任何貢獻：只有來源說明（出處清單）", target: "policy", id: POLICY_EMPTY,
    expect: (b) => {
      assertEquals(b.entries, []);
      assertEquals((b.origin as { kind: string }).kind, "imported");
      assert((b.origin as { source_url: string }).source_url.includes("db.cec.gov.tw"));
    },
  },
  {
    name: "人物沒有任何貢獻：來源說明帶參選紀錄備註", target: "politician", id: POL_EMPTY,
    expect: (b) => {
      assertEquals(b.entries, []);
      assertEquals((b.origin as { kind: string }).kind, "imported");
      assertEquals((b.origin as { source_notes: string[] }).source_notes, ["某報導；另一則"]);
    },
  },
  { name: "找不到的人物：not_found", target: "politician", id: UNKNOWN, expect: (b) => assertEquals(b.error, "not_found") },
  { name: "找不到的貢獻：空履歷", target: "contribution", id: UNKNOWN, expect: (b) => assertEquals(b.entries, []) },
];

for (const c of CASES) {
  Deno.test(`新舊路徑逐 byte 相同：${c.name}`, async () => {
    const db = await getDb();
    const legacy = await render(sqlBackedClient(db).client, c.target, c.id, "legacy");
    const viaRpc = await render(sqlBackedClient(db).client, c.target, c.id, "new");
    assertEquals(viaRpc, legacy);
    c.expect(JSON.parse(legacy));
    assert(!/ip_hash|secret/.test(viaRpc), "不回任何 ip_hash");
  });
}

Deno.test("新舊路徑逐 byte 相同：分頁（limit 1、帶 cursor）", async () => {
  const db = await getDb();
  for (const limit of [1, 2, 50]) {
    assertEquals(await render(sqlBackedClient(db).client, "politician", POL, "new", limit), await render(sqlBackedClient(db).client, "politician", POL, "legacy", limit));
  }
});

Deno.test("limit 邊界：0、20、101 夾成 100、負數與空值", async () => {
  const db = await getDb();
  const lim = async (v: string) => (await db.query<{ l: number }>(`SELECT (history_bundle('contribution', '${C3}', ${v})->>'limit')::int AS l`)).rows[0].l;
  assertEquals(await lim("0"), 0);
  assertEquals(await lim("20"), 20);
  assertEquals(await lim("100"), 100);
  assertEquals(await lim("101"), 100);
  assertEquals(await lim("-5"), 0);
  assertEquals(await lim("NULL"), 20);
});

Deno.test("history_bundle：不支援的對象（question）與不是 uuid 的 id 直接報錯", async () => {
  const db = await getDb();
  let msg = "";
  try { await db.query(`SELECT history_bundle('question', '${C3}', 20)`); } catch (e) { msg = String(e); }
  assert(msg.includes("unsupported target"), msg);
  msg = "";
  try { await db.query(`SELECT history_bundle('policy', 'not-a-uuid', 20)`); } catch (e) { msg = String(e); }
  assert(msg.includes("uuid"), msg);
});

Deno.test("question 對象沒做進 RPC：不會呼叫 history_bundle，照舊多次查詢", async () => {
  const db = await getDb();
  const q = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await db.exec(`INSERT INTO citizen_questions VALUES ('${q}', '長照補助怎麼領？', 'open', 0, '2026-09-01T00:00:00Z')`);
  const { client, calls } = sqlBackedClient(db);
  const data = await collectHistory(client, "question", q);
  assertEquals(data.origin_row?.question, "長照補助怎麼領？");
  assert(!calls.includes("rpc:history_bundle"));
});

Deno.test("RPC 失敗就退回舊路徑：函式不存在、連線例外、回傳形狀不對，輸出都與舊路徑相同並 console.warn", async () => {
  const db = await getDb();
  const legacy = await render(sqlBackedClient(db).client, "politician", POL, "legacy");
  const failures = [
    { name: "PGRST202", fail: { error: { message: "Could not find the function public.history_bundle", code: "PGRST202" } } },
    { name: "例外", fail: { throws: true } },
    { name: "形狀不對", fail: { data: [] } },
    { name: "回 null", fail: { data: null } },
  ];
  for (const f of failures) {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
    try {
      const { client, calls } = sqlBackedClient(db, { failRpc: { history_bundle: f.fail } });
      assertEquals(await render(client, "politician", POL, "new"), legacy, f.name);
      assertEquals(warns.filter((w) => w.includes("history_bundle")).length, 1, `${f.name}：warn 一行`);
      assert(calls.length >= 10, `${f.name}：確實走了舊路徑（${calls.length} 次）`);
    } finally { console.warn = orig; }
  }
});

Deno.test("RPC 權限：只有 service_role 能執行；PUBLIC、anon、authenticated 都不行", async () => {
  const db = await getDb();
  const sig = "history_bundle(text, text, int)";
  const can = async (role: string) => (await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS ok`)).rows[0].ok;
  assertEquals(await can("service_role"), true);
  assertEquals(await can("anon"), false);
  assertEquals(await can("authenticated"), false);
  const pub = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'history_bundle' AND a.grantee = 0`);
  assertEquals(pub.rows[0].n, 0, "PUBLIC 不能有 EXECUTE");
  const inv = await db.query<{ definer: boolean }>(`SELECT prosecdef AS definer FROM pg_proc WHERE proname = 'history_bundle'`);
  assertEquals(inv.rows[0].definer, false, "唯讀 RPC 用 SECURITY INVOKER");
  const cfg = await db.query<{ c: string[] }>(`SELECT proconfig AS c FROM pg_proc WHERE proname = 'history_bundle'`);
  assert(cfg.rows[0].c.some((x) => x.startsWith("statement_timeout=")) && cfg.rows[0].c.some((x) => x.startsWith("search_path=")));
});

Deno.test("計數守門：新路徑一次請求最多打 2 次 REST（實際 1 次），舊路徑 10 次以上", async () => {
  const db = await getDb();
  for (const [target, id] of [["politician", POL], ["policy", POLICY], ["contribution", C3]] as Array<[HistoryTarget, string]>) {
    const a = sqlBackedClient(db);
    await render(a.client, target, id, "new");
    const b = sqlBackedClient(db);
    await render(b.client, target, id, "legacy");
    console.log(`[REST 次數] ${target}：舊路徑 ${b.calls.length} 次，新路徑 ${a.calls.length} 次（${a.calls.join(",")}）`);
    assert(a.calls.length <= 2, `${target} 新路徑 ${a.calls.length} 次：${a.calls.join(",")}`);
    assertEquals(a.calls.filter((c) => c === "rpc:history_bundle").length, 1);
    assert(b.calls.length >= (target === "contribution" ? 6 : 10), `${target} 舊路徑只有 ${b.calls.length} 次，守門比較對象不對了`);
    assertNotEquals(a.calls.length, b.calls.length);
  }
});

Deno.test("網站請求的資料帶一次就用掉：不跨請求殘留，沒走 RPC 的另一個 client 照舊查", async () => {
  const db = await getDb();
  const a = sqlBackedClient(db);
  await collectHistory(a.client, "politician", POL);
  const first = await collectWebRequests(a.client, "politician", POL);
  assertEquals(first.length, 3);
  assertEquals(a.calls, ["rpc:history_bundle"]);
  const again = await collectWebRequests(a.client, "politician", POL);
  assertEquals(again, first, "第二次拿不到暫存，退回舊路徑查出同一份");
  assert(a.calls.length > 1);
});

Deno.test("isHistoryBundle：認得 RPC 的回傳，空陣列、null、缺欄位都不算", async () => {
  const db = await getDb();
  const res = await db.query<{ r: unknown }>(`SELECT history_bundle('policy', '${POLICY}', 20) AS r`);
  assert(isHistoryBundle(res.rows[0].r));
  assert(!isHistoryBundle([]) && !isHistoryBundle(null) && !isHistoryBundle({ contributions: [] }));
});
