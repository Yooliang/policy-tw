/**
 * 一人一包 PR3：交件端 bundle:true（migration 20261112030000；docs/PLAN-bundle-policies.md 第 2 節）。
 *
 *   A. 純函式 policy-bundle.ts：各種 400 條件
 *   B. handleContribute 端到端（假 supabase）：合格包落庫、各 400、旗標關忽略、配額、併掉剩太少
 *   C. 在途計數：SQL「合格：在途未額滿」與 /next 的程式計數都是一包算一筆（PGlite 真的跑 migration 裡的那一段）
 *   D. migration 結構：旗標預設關、函式其餘部分與前一版一字不差
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { handleContribute } from "./contribute-handler.ts";
import { validateContributionRequest } from "./contribution-schema.ts";
import { bundleProblems, normalizeBundleTitle, sharedBulletinUrl } from "./policy-bundle.ts";
import { resetQuotaCache } from "./quota-settings.ts";

const PID = "22222222-2222-4222-8222-222222222222";
const TASK = "auto:policy_missing:" + PID;
const BULLETIN = "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf";
const NEWS = "https://www.cna.com.tw/news/aipl/1.aspx";

function policy(n: number, over: Record<string, unknown> = {}, urls: string[] = [BULLETIN]) {
  return {
    contribution_type: "policy",
    task_id: TASK,
    payload: {
      politician_id: PID,
      election_id: 2026,
      title: `公報政見第${n}條：推動在地事項${"甲乙丙丁戊己庚辛壬癸"[n % 10]}${n}`,
      description: `公報上寫明第${n}項承諾：編列預算、限期完成，並每年向里民說明辦理進度，細節詳見公報第${n}頁。`,
      category: "都市發展與住宅",
      ...over,
    },
    source_urls: urls,
  };
}
const items = (k: number) => Array.from({ length: k }, (_, i) => policy(i));
const MIN_MAX = { minItems: 2, maxItems: 30 };

// ---------------- A. 純函式 ----------------
Deno.test("A1 合格包：回 null；共同公報網址取得到", () => {
  assertEquals(bundleProblems(items(5), MIN_MAX), null);
  assertEquals(sharedBulletinUrl(items(5)), BULLETIN);
});

Deno.test("A2 各種不合格：數量、型別、同人、同屆、同任務、非公報、重複標題", () => {
  assertEquals(bundleProblems(items(1), MIN_MAX)?.error, "bundle_too_small");
  assertEquals(bundleProblems(items(31), MIN_MAX)?.error, "bundle_too_large");
  assertEquals(bundleProblems([...items(2), { ...policy(9), contribution_type: "correction" }], MIN_MAX)?.error, "bundle_invalid");
  const otherPerson = [...items(2), policy(7, { politician_id: "33333333-3333-4333-8333-333333333333" })];
  const p1 = bundleProblems(otherPerson, MIN_MAX);
  assertEquals([p1?.error, p1?.indexes], ["bundle_invalid", [2]]);
  assertEquals(bundleProblems([...items(2), policy(7, { election_id: 2022 })], MIN_MAX)?.error, "bundle_invalid");
  assertEquals(bundleProblems([...items(2), { ...policy(7), task_id: "auto:policy_missing:other" }], MIN_MAX)?.error, "bundle_invalid");
  assertEquals(bundleProblems([...items(2), { ...policy(7), task_id: undefined }], MIN_MAX)?.error, "bundle_invalid");
  const noBulletin = bundleProblems([...items(2), policy(7, {}, [NEWS])], MIN_MAX);
  assertEquals([noBulletin?.error, noBulletin?.indexes], ["bundle_requires_bulletin", [2]]);
  // 每條都有公報、但不是同一份
  const split = bundleProblems([policy(0), policy(1, {}, ["https://eebulletin.cec.gov.tw/111/other.pdf"])], MIN_MAX);
  assertEquals(split?.error, "bundle_requires_bulletin");
  // 站台首頁不算公報
  assertEquals(bundleProblems([policy(0), policy(1, {}, ["https://bulletin.cec.gov.tw/"])], MIN_MAX)?.error, "bundle_requires_bulletin");
  const dup = bundleProblems([policy(0), policy(1), policy(2, { title: " 公報政見第0條：推動在地事項甲0！" })], MIN_MAX);
  assertEquals([dup?.error, dup?.indexes], ["bundle_duplicate_item", [2]]);
});

Deno.test("A3 標題正規化：全半形、大小寫、空白標點", () => {
  assertEquals(normalizeBundleTitle("ＡＢ c，d。 政見！"), normalizeBundleTitle("abcd政見"));
  assertEquals(normalizeBundleTitle(null), "");
});

Deno.test("A4 schema：bundle 要是布林；bundle:true 且給了 bundleCap 上限放寬到 30，否則仍是 20", () => {
  const body = (k: number, extra: Record<string, unknown> = {}) => ({ agent_name: "lampstand", contributions: items(k), ...extra });
  const paths = (r: { errors: Array<{ path: string }> }) => r.errors.map((e) => e.path);
  assert(paths(validateContributionRequest(body(21, { bundle: true }))).includes("contributions"), "沒給 bundleCap（旗標關）＝上限 20");
  assert(paths(validateContributionRequest(body(21), undefined, { bundleCap: 30 })).includes("contributions"), "沒帶 bundle:true 不放寬");
  const ok = validateContributionRequest(body(30, { bundle: true }), undefined, { bundleCap: 30 });
  assertEquals(ok.ok, true, JSON.stringify(ok.errors));
  assertEquals(ok.bundle, true);
  assert(paths(validateContributionRequest(body(31, { bundle: true }), undefined, { bundleCap: 30 })).includes("contributions"));
  assert(paths(validateContributionRequest(body(2, { bundle: "yes" }))).includes("bundle"));
  assertEquals(validateContributionRequest(body(2)).bundle, undefined);
});

// ---------------- B. handleContribute ----------------
interface FakeOpts {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  used?: number;
  /** 前 k 個雜湊視為 24 小時內已交過 */
  dupHashes?: number;
  settingsError?: boolean;
}
function fake(o: FakeOpts = {}) {
  const inserted: Array<{ table: string; rows: unknown }> = [];
  const order: string[] = [];
  const api = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const q: Record<string, unknown> = {};
      let hashes: string[] = [];
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => { q[c] = v; return chain; },
        in: (c: string, v: unknown[]) => { if (c === "payload_hash") hashes = v as string[]; return chain; },
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: { id: "bundle-1" }, error: null }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }), in: () => ({ error: null }) }),
        insert: (rows: unknown) => {
          inserted.push({ table, rows });
          order.push(table);
          if (table === "policy_bundles") return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "bundle-1" }, error: null }) }) };
          const arr = rows as Array<{ payload_hash: string }>;
          return { select: () => ({ data: arr.map((r, i) => ({ id: `c-${i}`, payload_hash: r.payload_hash })), error: null }) };
        },
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => {
          if (table === "queue_settings" && o.settingsError) return res({ data: null, error: { message: "column does not exist" } as never, count: 0 });
          if (table === "queue_settings") {
            return res({ data: [{ bundle_enabled: o.enabled ?? true, bundle_max_items: 30, bundle_min_items: 2, ...(o.settings ?? {}) }], error: null, count: 0 });
          }
          if (table === "contributions" && hashes.length > 0) {
            return res({ data: hashes.slice(0, o.dupHashes ?? 0).map((h, i) => ({ id: `old-${i}`, payload_hash: h, status: "pending" })), error: null, count: 0 });
          }
          if (table === "contributions") return res({ data: [], error: null, count: o.used ?? 0 });
          if (table === "politicians") return res({ data: [{ id: PID, merged_into: null, name: "王小明" }], error: null, count: 0 });
          return res({ data: [], error: null, count: 0 });
        },
      };
      return chain;
    },
  };
  return { api, inserted, order };
}
const call = (api: unknown, body: unknown) => handleContribute(api, "https://x", body, "ip-me", () => Promise.resolve({ status: 201, body: {} }));
const bundleBody = (list: unknown[], extra: Record<string, unknown> = {}) => ({ agent_name: "lampstand", bundle: true, contributions: list, ...extra });
const rowsOf = (f: ReturnType<typeof fake>, t: string) => f.inserted.filter((x) => x.table === t).flatMap((x) => x.rows as Array<Record<string, unknown>>);

Deno.test("B1 合格包落庫：先 policy_bundles 再 contributions，bundle_id 一致、index 0 起連續", async () => {
  resetQuotaCache();
  const f = fake();
  const res = await call(f.api, bundleBody(items(5)));
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(f.order, ["policy_bundles", "contributions"]);
  const [b] = rowsOf(f, "policy_bundles");
  assertEquals([b.task_id, b.politician_id, b.election_id, b.source_url, b.item_count, b.agent_name], [TASK, PID, 2026, BULLETIN, 5, "lampstand"]);
  const rows = rowsOf(f, "contributions");
  assertEquals(rows.length, 5);
  assertEquals(new Set(rows.map((r) => r.bundle_id)), new Set(["bundle-1"]));
  assertEquals(rows.map((r) => r.bundle_index), [0, 1, 2, 3, 4]);
  const body = res.body as Record<string, unknown>;
  assertEquals(body.bundle, { bundle_id: "bundle-1", item_count: 5 });
  assertEquals(body.bundle_ignored, undefined);
});

Deno.test("B2 一包 30 條可以收；31 條 400（schema 上限）", async () => {
  resetQuotaCache();
  const ok = fake();
  { const r30 = await call(ok.api, bundleBody(items(30))); assertEquals(r30.status, 201, JSON.stringify(r30.body).slice(0, 600)); }
  assertEquals(rowsOf(ok, "contributions").length, 30);
  resetQuotaCache();
  const big = fake();
  const res = await call(big.api, bundleBody(items(31)));
  assertEquals(res.status, 400);
  assertEquals(big.inserted.length, 0);
});

Deno.test("B3 同人／同任務／同屆／非公報／重複條／太小：各自 400、什麼都不寫", async () => {
  const cases: Array<[string, unknown[], string]> = [
    ["同人", [...items(2), policy(8, { politician_id: "33333333-3333-4333-8333-333333333333" })], "bundle_invalid"],
    ["同任務", [...items(2), { ...policy(8), task_id: "auto:policy_missing:x" }], "bundle_invalid"],
    ["同屆", [...items(2), policy(8, { election_id: 2022 })], "bundle_invalid"],
    ["非公報", [...items(2), policy(8, {}, [NEWS])], "bundle_requires_bulletin"],
    ["重複條", [...items(3), policy(9, { title: "公報政見第0條：推動在地事項甲0" })], "bundle_duplicate_item"],
    ["太小", items(1), "bundle_too_small"],
  ];
  for (const [name, list, code] of cases) {
    resetQuotaCache();
    const f = fake();
    const res = await call(f.api, bundleBody(list));
    assertEquals([name, res.status, (res.body as Record<string, unknown>).error], [name, 400, code]);
    assertEquals(f.inserted.length, 0, `${name}：400 不能寫任何東西`);
  }
});

Deno.test("B4 與既有的重複併掉後剩不到 2 條 → 400 bundle_too_small、不寫；剩夠就照收且 index 連續、item_count 是實收數", async () => {
  resetQuotaCache();
  const few = fake({ dupHashes: 4 });
  const res = await call(few.api, bundleBody(items(5)));
  assertEquals([res.status, (res.body as Record<string, unknown>).error], [400, "bundle_too_small"]);
  assertEquals(few.inserted.length, 0);

  resetQuotaCache();
  const enough = fake({ dupHashes: 2 });
  const ok = await call(enough.api, bundleBody(items(5)));
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
  assertEquals(rowsOf(enough, "contributions").map((r) => r.bundle_index), [0, 1, 2]);
  assertEquals(rowsOf(enough, "policy_bundles")[0].item_count, 3);
});

Deno.test("B5 旗標關：忽略 bundle、照舊逐條收（沒有 bundle_id），回應 bundle_ignored:true；上限仍是 20", async () => {
  resetQuotaCache();
  const f = fake({ enabled: false });
  const res = await call(f.api, bundleBody(items(5)));
  assertEquals(res.status, 201, JSON.stringify(res.body));
  assertEquals(f.order, ["contributions"]);
  assert(rowsOf(f, "contributions").every((r) => !("bundle_id" in r) && !("bundle_index" in r)));
  assertEquals((res.body as Record<string, unknown>).bundle_ignored, true);
  // 旗標關時，連「非公報」「只有一條」都不會被當包檢查（照舊逐條收）
  resetQuotaCache();
  const off2 = fake({ enabled: false });
  const news2 = [NEWS, "https://udn.com/news/story/1"];
  const off2r = await call(off2.api, bundleBody([policy(0, {}, news2), policy(1, {}, news2)]));
  assertEquals(off2r.status, 201, JSON.stringify(off2r.body).slice(0, 400));
  // 上限仍是 20
  resetQuotaCache();
  const off3 = fake({ enabled: false });
  assertEquals((await call(off3.api, bundleBody(items(21)))).status, 400);
  // 沒帶 bundle 的一般交件沒有 bundle_ignored
  resetQuotaCache();
  const plain = fake({ enabled: false });
  const r = await call(plain.api, { agent_name: "lampstand", contributions: items(2) });
  assertEquals((r.body as Record<string, unknown>).bundle_ignored, undefined);
});

Deno.test("B6 讀不到旗標（表或欄位還不存在）當關", async () => {
  resetQuotaCache();
  const f = fake({ settingsError: true });
  const res = await call(f.api, bundleBody(items(3)));
  assertEquals(res.status, 201);
  assertEquals((res.body as Record<string, unknown>).bundle_ignored, true);
  assertEquals(f.order, ["contributions"]);
});

Deno.test("B7 配額每條算一筆：已用 71＋這包 10 條＝81 > 80 → 429、不寫；已用 70 剛好放得下", async () => {
  resetQuotaCache();
  const over = fake({ used: 71 });
  const res = await call(over.api, bundleBody(items(10)));
  assertEquals(res.status, 429);
  assertEquals(over.inserted.length, 0);
  resetQuotaCache();
  const fit = fake({ used: 70 });
  const ok = await call(fit.api, bundleBody(items(10)));
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
  assertEquals((ok.body as { daily_quota: { used: number } }).daily_quota.used, 80);
});

// ---------------- C. 在途計數 ----------------
const MIG_NAME = "20261112030000_bundle_enabled_flag.sql";
const MIG = (await Deno.readTextFile(new URL(`../../migrations/${MIG_NAME}`, import.meta.url))).replace(/\r\n/g, "\n");
const PREV = (await Deno.readTextFile(new URL("../../migrations/20261111100000_work_key.sql", import.meta.url))).replace(/\r\n/g, "\n");

function clauseOf(sql: string): string {
  const m = /-- >>> 合格：在途未額滿\n([\s\S]*?)-- <<< 合格：在途未額滿/.exec(sql);
  assert(m, "找不到 合格：在途未額滿 標記");
  return m[1].split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
}

Deno.test("C1 SQL：在途未額滿＝COUNT(DISTINCT coalesce(bundle_id, id)) < 5（一包 30 條算一筆；4 包＋1 筆＝5 額滿）", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, status text, bundle_id uuid);
  `);
  const eligible = async (): Promise<string[]> => {
    const r = await db.query<{ task_id: string }>(`SELECT d.task_id FROM task_dispatches d WHERE true ${clauseOf(MIG)} ORDER BY 1`);
    return r.rows.map((x) => x.task_id);
  };
  await db.exec(`INSERT INTO task_dispatches VALUES ('t-bundle'), ('t-plain'), ('t-mixed'), ('t-done')`);
  // t-bundle：一包 30 條 pending → 算 1 筆 → 仍可派
  await db.exec(`INSERT INTO contributions (task_id, status, bundle_id) SELECT 't-bundle', 'pending', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' FROM generate_series(1, 30)`);
  // t-plain：5 條不在包裡 → 額滿
  await db.exec(`INSERT INTO contributions (task_id, status) SELECT 't-plain', 'pending' FROM generate_series(1, 5)`);
  // t-mixed：4 包各 3 條（算 4）＋0 條單獨 → 可派；再加 1 條單獨 → 5 額滿
  for (const b of ["b1", "b2", "b3", "b4"]) {
    await db.exec(`INSERT INTO contributions (task_id, status, bundle_id) SELECT 't-mixed', 'verified', md5('${b}')::uuid FROM generate_series(1, 3)`);
  }
  // t-done：已上線／退件的不算在途
  await db.exec(`INSERT INTO contributions (task_id, status, bundle_id) SELECT 't-done', 'applied', gen_random_uuid() FROM generate_series(1, 9)`);
  assertEquals(await eligible(), ["t-bundle", "t-done", "t-mixed"]);
  await db.exec(`INSERT INTO contributions (task_id, status) VALUES ('t-mixed', 'pending')`);
  assertEquals(await eligible(), ["t-bundle", "t-done"]);
});

Deno.test("C2 還原驗證：換回舊版的 count(*) 寫法，C1 的「一包算一筆」會翻面", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY);
    CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, status text, bundle_id uuid);
    INSERT INTO task_dispatches VALUES ('t-bundle');
    INSERT INTO contributions (task_id, status, bundle_id) SELECT 't-bundle', 'pending', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' FROM generate_series(1, 30);
  `);
  const old = clauseOf(PREV);
  const r = await db.query<{ task_id: string }>(`SELECT d.task_id FROM task_dispatches d WHERE true ${old}`);
  assertEquals(r.rows.length, 0, "舊寫法：一包 30 條讓任務額滿（這正是要改的）");
});

Deno.test("C3 /next 的程式計數也是一包算一筆（與 SQL 一致）", async () => {
  const src = (await Deno.readTextFile(new URL("../next/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(src.includes('select("id, task_id, bundle_id")'), "/next 在途查詢要帶 bundle_id");
  assert(src.includes("r.bundle_id ?? r.id"), "/next 在途計數要以 coalesce(bundle_id, id) 去重");
});

// ---------------- D. migration 結構 ----------------
Deno.test("D1 旗標預設關、上下限預設 30／2", () => {
  assert(/bundle_enabled\s+BOOLEAN\s+NOT NULL DEFAULT false/.test(MIG));
  assert(/bundle_max_items\s+SMALLINT\s+NOT NULL DEFAULT 30/.test(MIG));
  assert(/bundle_min_items\s+SMALLINT\s+NOT NULL DEFAULT 2/.test(MIG));
});

Deno.test("D2 contribution_queue_tasks 整支重貼：除了「在途未額滿」那一段，與 20261111100000 的版本一字不差", () => {
  const fn = (sql: string) => {
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION contribution_queue_tasks(");
    const end = sql.indexOf("\n$$;", start);
    assert(start >= 0 && end > start);
    return sql.slice(start, end);
  };
  const strip = (s: string) => s.replace(/-- >>> 合格：在途未額滿\n[\s\S]*?-- <<< 合格：在途未額滿\n/, "");
  assertEquals(strip(fn(MIG)), strip(fn(PREV)));
  assert(!MIG.includes("LIMIT 5\n    ) inflight"), "舊的 LIMIT 5 計數不能還在");
});
