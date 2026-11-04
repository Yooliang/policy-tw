/**
 * 插隊改成維護者才能寫＋取消 #92 還沒領走的部分（migration 20261104110000_boost_maintainer_only.sql，policy-ops#196）：
 *   A. 入口：boost／jp-boost 的 POST 沒帶憑證、帶錯憑證 → 401 且不寫任何東西；對的憑證（service role bearer 或 x-cron-secret）才寫；
 *      驗證服務壞掉 → 503 且不寫；GET 維持公開
 *   B. migration 文字：Vault 密鑰、RPC 只給 service_role、三個插隊函式與 task_boosts 寫入權限收回、密鑰不在版控
 *   C. #92 取消（PGlite，用 migration 裡真正的 DO 區塊）：只扣一份、最低 0、別份保留、#92 之後派出的不碰、驗證票不碰、冪等、沒有 #92 的環境不動；
 *      queue_at 觸發器真的跟著重算
 *   D. 還原驗證：拿掉任何一個守門，對應測試就紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { loadEntry, type RestCall } from "./jp/entry-harness.ts";
import { latestFn, mutate } from "./arms-pglite.ts";

const MIG_NAME = "20261104110000_boost_maintainer_only.sql";
const MIG = (await Deno.readTextFile(new URL(`../../migrations/${MIG_NAME}`, import.meta.url))).replace(/\r\n/g, "\n");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// =============================================================================================
// A. 入口
// =============================================================================================
const KEY = "service-role-key-0123456789";
const SECRET = "cron-secret-value-0123456789abcdef";
const env = { SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, CONTRIBUTION_IP_SALT: "salt" } as Record<string, string>;
type Row = Record<string, unknown>;
const isWrite = (c: RestCall) => c.target === "rpc/task_boost" || (c.target === "task_boosts" && c.method !== "GET"); // task_boosts 的 HEAD 是限流計數，也算「已經往下走」

function makeRouter(opts: { secretOk?: boolean } = {}) {
  return (c: RestCall): unknown => {
    if (c.target === "rpc/boost_maintainer_secret_ok") return opts.secretOk === true;
    if (c.target === "rpc/task_boost") return { id: 7, label: (c.body as Row).p_label, matched_tasks: 1, matched_verifies: 0, queue_at: null };
    if (c.target === "rpc/task_boost_remaining") return { tasks: 1, verifies: 0 };
    if (c.target === "task_boosts" && c.method === "GET") return [{ id: 1, label: "b", filter: { kinds: ["task"] }, agent_name: null, matched_tasks: 1, matched_verifies: 0, created_at: "2027-03-01T00:00:00Z" }];
    return undefined;
  };
}

const SITES = [
  { name: "boost", path: "../../boost/index.ts", body: { label: "測試", filter: { kinds: ["task"] } } },
  { name: "jp-boost", path: "../../jp-boost/index.ts", body: { label: "テスト", filter: { kinds: ["task"] } } },
];

async function call(path: string, method: string, headers: Record<string, string>, body: unknown, router = makeRouter()) {
  const entry = await loadEntry(path, env, router);
  try {
    const res = await entry.call(new Request("https://x/boost", {
      method, headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, json: JSON.parse(await res.text()) as Row, calls: entry.calls };
  } finally { entry.restore(); }
}

for (const s of SITES) {
  Deno.test(`A1 ${s.name}：POST 沒帶憑證 → 401，不往下走（不讀限流、不呼叫 task_boost、連驗證 RPC 都不用打）`, async () => {
    const r = await call(s.path, "POST", {}, s.body);
    assertEquals(r.status, 401);
    assertEquals(r.json.success, false);
    assertEquals(r.calls.filter(isWrite), []);
    assertEquals(r.calls.length, 0);
  });

  Deno.test(`A2 ${s.name}：帶錯的 bearer、帶錯或太短的 x-cron-secret → 401 且不寫`, async () => {
    for (const headers of [{ authorization: "Bearer wrong-key-0123456789" } as Record<string, string>, { authorization: KEY }, { "x-cron-secret": SECRET }, { "x-cron-secret": "short" }]) {
      const r = await call(s.path, "POST", headers, s.body, makeRouter({ secretOk: false }));
      assertEquals(r.status, 401, JSON.stringify(headers));
      assertEquals(r.calls.filter(isWrite), [], JSON.stringify(headers));
      assert(r.calls.every((c) => c.target === "rpc/boost_maintainer_secret_ok"), "最多只問資料庫密鑰對不對");
    }
  });

  Deno.test(`A3 ${s.name}：對的 service role bearer → 寫入（呼叫 task_boost）`, async () => {
    const r = await call(s.path, "POST", { authorization: `Bearer ${KEY}` }, s.body);
    assertEquals(r.status, 200, JSON.stringify(r.json));
    assertEquals(r.calls.some((c) => c.target === "rpc/task_boost"), true);
  });

  Deno.test(`A4 ${s.name}：x-cron-secret 經資料庫比對通過 → 寫入；密鑰只拿去問資料庫、不出現在回應`, async () => {
    const r = await call(s.path, "POST", { "x-cron-secret": SECRET }, s.body, makeRouter({ secretOk: true }));
    assertEquals(r.status, 200, JSON.stringify(r.json));
    const check = r.calls.find((c) => c.target === "rpc/boost_maintainer_secret_ok")!;
    assertEquals((check.body as Row).p_secret, SECRET);
    assert(!JSON.stringify(r.json).includes(SECRET));
    assertEquals(r.calls.some((c) => c.target === "rpc/task_boost"), true);
  });

  Deno.test(`A5 ${s.name}：驗證服務壞掉（RPC 回 500）→ 503 且不寫（fail closed）`, async () => {
    const entry = await loadEntry(s.path, env, makeRouter());
    const inner = globalThis.fetch;
    try {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.url.includes("rpc/boost_maintainer_secret_ok")) {
          return Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
        }
        return inner(req);
      }) as typeof fetch;
      const res = await entry.call(new Request("https://x/boost", { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": SECRET }, body: JSON.stringify(s.body) }));
      assertEquals(res.status, 503);
      assertEquals(entry.calls.filter(isWrite), []);
    } finally { globalThis.fetch = inner; entry.restore(); }
  });

  Deno.test(`A6 ${s.name}：GET 不用憑證（公開），其他方法仍 405`, async () => {
    const g = await call(s.path, "GET", {}, undefined);
    assertEquals(g.status, 200);
    assertEquals((g.json.boosts as Row[]).length, 1);
    assert(!g.calls.some((c) => c.target === "rpc/boost_maintainer_secret_ok"), "GET 不驗憑證");
    assertEquals((await call(s.path, "DELETE", {}, undefined)).status, 405);
  });
}

Deno.test("A7 jp-boost：驗證 RPC 走 policy_jp（日本站 client 固定 schema）", async () => {
  const r = await call("../../jp-boost/index.ts", "POST", { "x-cron-secret": SECRET }, SITES[1].body, makeRouter({ secretOk: true }));
  const check = r.calls.find((c) => c.target === "rpc/boost_maintainer_secret_ok")!;
  assertEquals(check.headers["content-profile"] ?? check.headers["accept-profile"], "policy_jp");
});

// =============================================================================================
// B. migration 文字
// =============================================================================================
Deno.test("B1 密鑰在 Vault 自己產、不在版控；RPC 是 SECURITY DEFINER、清空 search_path、只授權 service_role", () => {
  const c = code(MIG);
  assert(c.includes("vault.create_secret(") && c.includes("'boost_maintainer_secret'"));
  assert(c.includes("IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'boost_maintainer_secret')"), "已經有就不動");
  assert(!/[0-9a-f]{40,}/i.test(MIG), "檔案裡沒有長得像密鑰的十六進位字串");
  for (const schema of ["public", "policy_jp"]) {
    assert(c.includes(`CREATE OR REPLACE FUNCTION ${schema}.boost_maintainer_secret_ok(p_secret text)`));
    assert(c.includes(`GRANT EXECUTE ON FUNCTION ${schema}.boost_maintainer_secret_ok(text) TO service_role;`));
    for (const role of ["PUBLIC", "anon", "authenticated"]) assert(c.includes(`REVOKE ALL ON FUNCTION ${schema}.boost_maintainer_secret_ok(text) FROM ${role};`), `${schema} 收回 ${role}`);
  }
  assert((c.match(/SECURITY DEFINER/g) ?? []).length >= 2);
  assert((c.match(/SET search_path = ''/g) ?? []).length >= 2);
});

Deno.test("B2 三個插隊函式只留 service_role；task_boosts 收回 anon／authenticated 的寫入，讀取不動；沒有把任何東西授權給 anon／authenticated", () => {
  const c = code(MIG);
  for (const sig of ["public.task_boost(text, jsonb, text, text)", "public.task_boost_matches(jsonb)", "public.task_boost_remaining(bigint)"]) {
    for (const role of ["PUBLIC", "anon", "authenticated"]) assert(c.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`), `${sig} 收回 ${role}`);
    assert(c.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`), `${sig} 留給 service_role`);
  }
  assert(c.includes("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.task_boosts FROM anon, authenticated;"));
  assert(!/GRANT[^;]*\sTO\s[^;]*\b(anon|authenticated|PUBLIC)\b/.test(c), "沒有授權給 anon／authenticated／PUBLIC");
  assert(!/task_boosts_public_read/.test(c), "公開讀取的 policy 不動");
});

Deno.test("B3 取消 #92 的區塊在收回權限之前（migration 以擁有者身分跑），且只動 #92 這一個插隊", () => {
  assert(MIG.indexOf("task_boost_matches(v_filter)") < MIG.indexOf("REVOKE ALL ON FUNCTION public.task_boost(text"));
  assert(MIG.includes("FROM task_boosts b WHERE b.id = 92"));
  for (const other of ["93", "94", "95", "96"]) assert(!new RegExp(`id = ${other}\\b`).test(code(MIG)), `不碰 #${other}`);
});

// =============================================================================================
// C. #92 取消（PGlite）
// =============================================================================================
const BS = 157680000;
const T92 = "2026-11-04 08:02:35+00";
const DO_BLOCK = (() => {
  const a = MIG.indexOf("DO $$\nDECLARE\n  v_at timestamptz;");
  assert(a >= 0, "找得到取消 #92 的 DO 區塊");
  const b = MIG.indexOf("\n$$;", a);
  return MIG.slice(a, b + 4);
})();

const QUEUE_FN = await latestFn("task_dispatches_queue_key");
const KEY_FN = await latestFn("task_queue_key");
const SCHEMA = `
CREATE TABLE queue_settings (id INT PRIMARY KEY, boost_seconds BIGINT, verify_priority_seconds BIGINT DEFAULT 0);
INSERT INTO queue_settings VALUES (1, ${BS}, 0);
CREATE TABLE task_boosts (id BIGINT PRIMARY KEY, label TEXT, filter JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE edit_history (id BIGSERIAL PRIMARY KEY, table_name TEXT, record_id TEXT, field TEXT, old_value JSONB, new_value JSONB, agent_name TEXT);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, boost_seconds BIGINT NOT NULL DEFAULT 0, last_dispatched_at TIMESTAMPTZ, priority_seconds INT, cool_until TIMESTAMPTZ,
  dispatch_count INT NOT NULL DEFAULT 0, defer_seconds BIGINT NOT NULL DEFAULT 0, verify_follows_task BOOLEAN NOT NULL DEFAULT true, queue_at TIMESTAMPTZ);
-- 命中名單：假的 task_boost_matches（回放 _hits）
CREATE TABLE _hits (task_id TEXT, kind TEXT);
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql AS $f$ SELECT task_id, kind FROM _hits $f$;
CREATE FUNCTION verify_ticket_priority_seconds(p_task_id TEXT) RETURNS INT LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION verify_inherited_priority_seconds(p_task_id TEXT) RETURNS INT LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION verify_ticket_defer_seconds(p_task_id TEXT, p_flag BOOLEAN) RETURNS INT LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION verify_queue_key(a TEXT, b BOOLEAN, c TIMESTAMPTZ, d INT, e BIGINT, f BIGINT) RETURNS TIMESTAMPTZ LANGUAGE sql AS $f$ SELECT now() $f$;
CREATE TABLE _refreshed (n INT);
CREATE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO _refreshed VALUES (1); RETURN 1; END $f$;
${KEY_FN}
${QUEUE_FN}
DROP TRIGGER IF EXISTS trg_task_dispatches_queue_key ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
`;
const SEED = `
INSERT INTO task_boosts (id, label, filter, created_at) VALUES (92, 'x', '{"task_types":["profile_gap"]}', '${T92}');
INSERT INTO task_dispatches (task_id, boost_seconds, last_dispatched_at) VALUES
 ('auto:a', ${BS}, '2026-11-01 00:00:00+00'),        -- 只有 #92 一份 → 0
 ('auto:b', ${BS * 2}, '2026-11-01 00:00:00+00'),    -- #92 與 #93 兩份 → 留一份
 ('auto:c', ${BS}, '2026-11-01 00:00:00+00'),        -- 沒被 #92 命中（別的插隊）→ 不動
 ('auto:d', ${BS}, '2026-11-04 08:30:00+00'),        -- 命中，但 #92 之後派出過、現在這一份是別的插隊的 → 不動
 ('auto:e', 0, '2026-11-01 00:00:00+00'),            -- 命中，早就沒有插隊秒數（派出過）→ 不動，不能變負
 ('auto:g', ${BS * 3}, '2026-11-01 00:00:00+00'),    -- 三份 → 兩份
 ('auto:n', ${BS}, NULL),                            -- 命中，last_dispatched_at 空 → 算還沒派過 → 0
 ('verify:v1', ${BS}, '2026-11-01 00:00:00+00');     -- 驗證列：就算 _hits 夾了 verify 也不碰
INSERT INTO _hits VALUES ('auto:a','task'),('auto:b','task'),('auto:d','task'),('auto:e','task'),('auto:g','task'),('auto:n','task'),('verify:v1','verify');
`;
async function freshDb(seed = true, block = DO_BLOCK): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (seed) await db.exec(SEED);
  await db.exec(block);
  return db;
}
const shares = async (db: PGlite) => Object.fromEntries((await db.query<{ task_id: string; n: string }>(`SELECT task_id, (boost_seconds / ${BS})::text AS n FROM task_dispatches ORDER BY 1`)).rows.map((r) => [r.task_id, Number(r.n)]));
const countLog = async (db: PGlite) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM edit_history`)).rows[0].n;

Deno.test("C1 只扣一份、最低 0：#92 獨有的歸零、多份的留別份、沒命中／#92 之後派出過／沒有插隊秒數／驗證列都不動", async () => {
  const db = await freshDb();
  try {
    assertEquals(await shares(db), { "auto:a": 0, "auto:b": 1, "auto:c": 1, "auto:d": 1, "auto:e": 0, "auto:g": 2, "auto:n": 0, "verify:v1": 1 });
    const log = (await db.query<{ record_id: string; field: string; new_value: Row; agent_name: string }>(`SELECT * FROM edit_history`)).rows;
    assertEquals(log.length, 1);
    assertEquals([log[0].record_id, log[0].field, log[0].agent_name], ["92", "cancel_unclaimed", "boost-cancel"]);
    assertEquals([log[0].new_value.rows_reduced_by_one_share, log[0].new_value.rows_back_to_zero], [4, 2]); // a、b、g、n 被扣；a、n 歸零
    assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM _refreshed`)).rows[0].n, 1, "驗證票排序鍵重算過");
  } finally { await db.close(); }
});

Deno.test("C2 冪等：再跑一次不再扣；沒有 #92 的環境（本機、測試）整段不動", async () => {
  const db = await freshDb();
  try {
    const once = await shares(db);
    await db.exec(DO_BLOCK);
    await db.exec(DO_BLOCK);
    assertEquals(await shares(db), once);
    assertEquals(await countLog(db), 1);
  } finally { await db.close(); }
  const empty = await freshDb(false);
  try {
    await empty.exec(`INSERT INTO task_dispatches (task_id, boost_seconds, last_dispatched_at) VALUES ('auto:a', ${BS}, now()); INSERT INTO _hits VALUES ('auto:a','task');`);
    await empty.exec(DO_BLOCK);
    assertEquals((await shares(empty))["auto:a"], 1);
    assertEquals(await countLog(empty), 0);
  } finally { await empty.close(); }
});

Deno.test("C3 queue_at 觸發器跟著重算：歸零的列排序鍵往後移、沒被扣的列不變", async () => {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA);
    await db.exec(SEED);
    await db.exec(`UPDATE task_dispatches SET boost_seconds = boost_seconds`); // 讓每列帶上「有插隊秒數」時的 queue_at
    const read = async () => Object.fromEntries((await db.query<{ task_id: string; q: number }>(`SELECT task_id, extract(epoch FROM queue_at)::float8 AS q FROM task_dispatches`)).rows.map((r) => [r.task_id, r.q]));
    const before = await read();
    await db.exec(DO_BLOCK);
    const after = await read();
    assert(after["auto:a"] > before["auto:a"], "歸零後排序鍵往後移（不再插隊）");
    assert(after["auto:g"] > before["auto:g"], "三份扣成兩份也往後移");
    assertEquals(after["auto:c"], before["auto:c"], "沒被扣的列 queue_at 不變");
  } finally { await db.close(); }
});

// =============================================================================================
// D. 還原驗證
// =============================================================================================
Deno.test("D1 還原驗證：拿掉『#92 之後派出過的不碰』→ auto:d 被扣到 0（C1 要求 1，會紅）", async () => {
  const bad = mutate(DO_BLOCK, "AND (d.last_dispatched_at IS NULL OR d.last_dispatched_at <= v_at)", "");
  const db = await freshDb(true, bad);
  try { assertEquals((await shares(db))["auto:d"], 0); } finally { await db.close(); }
});

Deno.test("D2 還原驗證：不看 kind='task' → 驗證列被扣（C1 要求 1，會紅）；不是只扣一份（扣光）→ auto:b 變 0", async () => {
  const noKind = mutate(DO_BLOCK, "WHERE m.kind = 'task'", "WHERE true");
  const db = await freshDb(true, noKind);
  try { assertEquals((await shares(db))["verify:v1"], 0); } finally { await db.close(); }
  const all = mutate(DO_BLOCK, "GREATEST(d.boost_seconds - v_share, 0)", "0");
  const db2 = await freshDb(true, all);
  try { assertEquals((await shares(db2))["auto:b"], 0); } finally { await db2.close(); }
});

Deno.test("D3 入口：憑證檢查在讀 body 與任何寫入之前（順序被改掉這裡就紅）", async () => {
  for (const f of ["../boost/index.ts", "../jp-boost/index.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    const at = src.indexOf("boostCaller(req.headers");
    assert(at > 0, `${f} 有呼叫 boostCaller`);
    assert(at < src.indexOf("req.json()"), `${f} 憑證檢查在讀 body 之前`);
    assert(at < src.indexOf('rpc("task_boost"'), `${f} 憑證檢查在 task_boost 之前`);
    assert(at < src.indexOf('from("task_boosts").select("id", { count'), `${f} 憑證檢查在限流計數之前`);
  }
});
