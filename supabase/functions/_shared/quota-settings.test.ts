/**
 * 額度四個數字可在主控台調整（2026-10-29，#769；migration 20261029080000_quota_settings.sql）。
 *
 * SQL（PGlite 實跑）：
 *   1. 表初值＝handler 常數（正見、日本站各一列）；CHECK 上下限（邊界內可、邊界外不可）與 TS QUOTA_BOUNDS 相同
 *   2. console_admin_quota_settings_save：只有 service_role 能叫；理由必填（空字串、純空白、NULL 都 RAISE）；site 不對、有 NULL 擋；
 *      回傳新值；改前改後（觸發器）與理由（RPC）進 edit_history；updated_by 記 console:<信箱>
 *   3. console_quota_settings：anon 可讀、只有設定值與 updated_at／updated_by
 *   4. console_quota_now 的上限欄位讀這張表（正見那一列），日本站那列不影響；表裡沒有 tw 列時退回初值
 * TS：
 *   5. loadQuotaLimits：讀表生效；壞值（非整數、超界、字串、NULL）逐欄退回常數；查詢丟錯／回 error／空結果退回常數；
 *      快取 60 秒（59.9 秒內不再查、滿 60 秒重查）；站別各自一份；日本站走 .schema("public")
 *   6. submitQuotaFor／verifyQuotaFor 帶 limits 後額度生效（DiTrust 與匿名各自）；不帶用常數
 *   7. 名冊批次上限 min(80, 網段提交額度)、驗證函式吃 rosterBatchCap
 *   8. 接線：四個入口／handler 都有讀表並把值傳進 *QuotaFor（原始碼掃描）
 * 還原驗證（做過）：把 quota_limits() 改回寫死常數 → 第 4 組紅；把 loadQuotaLimits 的 row 套用拿掉（永遠用常數）→ 第 5 組紅；
 *   把 handler 的 loadQuotaLimits 呼叫拿掉 → 第 8 組紅。
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";
import { CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, CONTRIBUTE_DAILY_LIMIT_PER_IP, QUOTA_DEFAULTS, submitQuotaFor } from "./contribute-handler.ts";
import { VERIFY_DAILY_LIMIT_PER_DITRUST, VERIFY_DAILY_LIMIT_PER_IP, verifyQuotaFor } from "./verify-handler.ts";
import * as jpC from "./jp/contribute-handler.ts";
import * as jpV from "./jp/verify-handler.ts";
import { effectiveRosterBatchCap, isValidQuotaValue, loadQuotaLimits, QUOTA_BOUNDS, QUOTA_CACHE_MS, resetQuotaCache } from "./quota-settings.ts";
import { MAX_BATCH, MAX_BATCH_ROSTER, validateContributionRequest } from "./contribution-schema.ts";

import { parseRoster } from "./cec-roster.ts";
import { ROSTER_SOURCES, toRegistrationRecords } from "./cec-registrations.ts";
import { readTownIndex } from "../../../scripts/cec-registrations-lib.ts";

const towns = await readTownIndex();
const VILLAGE = ROSTER_SOURCES.find((s) => s.election_type === "村里長")!;
const records = toRegistrationRecords(VILLAGE, parseRoster((await Deno.readTextFile(new URL(`./fixtures/${VILLAGE.fixture}`, import.meta.url))).replace(/\r\n/g, "\n")), towns).filter((r) => r.name);
const candidacyOf = (r: (typeof records)[number]) => ({
  contribution_type: "candidacy",
  payload: { name: r.name, party: r.party, region: r.region, sub_region: r.sub_region, village: r.village, election_id: 2026, election_type: "村里長", candidate_status: "registered" },
  source_urls: [VILLAGE.url],
});

const MIG_NAME = "20261029080000_quota_settings.sql";
const MIG = await readMig(MIG_NAME);
const Q1 = await readMig("20261029060000_console_quota_now.sql");
const Q2 = await readMig("20261029070000_console_quota_now_split.sql");

async function db(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('request.jwt.role', true), current_user) $$;
    CREATE TABLE edit_history (id serial PRIMARY KEY, table_name text, record_id text, field text, old_value jsonb, new_value jsonb, agent_name text, created_at timestamptz DEFAULT now());
    CREATE FUNCTION activity_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now() + interval '1 second'; RETURN NEW; END $$;
    CREATE TABLE contributions (id serial PRIMARY KEY, agent_name text, contributor_ip_hash text, actor_id text, created_at timestamptz);
    CREATE TABLE contribution_votes (id serial PRIMARY KEY, agent_name text, verifier_ip_hash text, actor_id text, created_at timestamptz);
  `);
  await d.exec(Q1);
  await d.exec(Q2);
  await d.exec(MIG);
  await d.exec(`GRANT SELECT ON quota_settings TO anon, authenticated`);
  return d;
}

type Row = { site: string; per_ip_submit: number; per_ip_verify: number; per_ditrust_submit: number; per_ditrust_verify: number; updated_by: string | null };
const SAVE = `SELECT site, per_ip_submit, per_ip_verify, per_ditrust_submit, per_ditrust_verify, updated_by FROM console_admin_quota_settings_save($1, $2, $3, $4, $5, $6, 'owner@example.com')`;
async function save(d: PGlite, site: string, v: [number | null, number | null, number | null, number | null], reason: string | null, role = "service_role"): Promise<Row> {
  return await d.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<Row>(SAVE, [site, ...v, reason])).rows[0];
  });
}

Deno.test(`1. 初值＝handler 常數（正見、日本站各一列）；CHECK 上下限（${MIG_NAME}）`, async () => {
  const d = await db();
  const rows = (await d.query<Row>(`SELECT * FROM quota_settings ORDER BY site`)).rows;
  assertEquals(rows.map((r) => r.site), ["jp", "tw"]);
  for (const r of rows) {
    assertEquals([r.per_ip_submit, r.per_ip_verify, r.per_ditrust_submit, r.per_ditrust_verify], [80, 200, 500, 1000]);
  }
  const tw = [CONTRIBUTE_DAILY_LIMIT_PER_IP, VERIFY_DAILY_LIMIT_PER_IP, CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, VERIFY_DAILY_LIMIT_PER_DITRUST];
  assertEquals(tw, [80, 200, 500, 1000]);
  const jp = [jpC.CONTRIBUTE_DAILY_LIMIT_PER_IP, jpV.VERIFY_DAILY_LIMIT_PER_IP, jpC.CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, jpV.VERIFY_DAILY_LIMIT_PER_DITRUST];
  assertEquals(jp, [80, 200, 500, 1000]);
  assertEquals(Object.values(QUOTA_DEFAULTS), tw);
  assertEquals(Object.values(jpC.QUOTA_DEFAULTS), jp);

  // 上下限：SQL CHECK 與 TS QUOTA_BOUNDS 同一份
  const cols = Object.keys(QUOTA_BOUNDS) as Array<keyof typeof QUOTA_BOUNDS>;
  for (const c of cols) {
    const [lo, hi] = QUOTA_BOUNDS[c];
    for (const ok of [lo, hi]) await d.exec(`UPDATE quota_settings SET ${c} = ${ok} WHERE site = 'tw'`);
    for (const bad of [lo - 1, hi + 1, 0, -5]) {
      await assertRejects(() => d.exec(`UPDATE quota_settings SET ${c} = ${bad} WHERE site = 'tw'`), Error, "check", `${c}=${bad} 該被擋`);
    }
    await d.exec(`UPDATE quota_settings SET ${c} = ${c === "per_ip_submit" ? 80 : c === "per_ip_verify" ? 200 : c === "per_ditrust_submit" ? 500 : 1000} WHERE site = 'tw'`);
  }
  assertEquals(QUOTA_BOUNDS, { per_ip_submit: [10, 2000], per_ip_verify: [10, 5000], per_ditrust_submit: [10, 5000], per_ditrust_verify: [10, 10000] });
  await assertRejects(() => d.exec(`INSERT INTO quota_settings (site) VALUES ('xx')`), Error, "check");
});

Deno.test("2. 寫入 RPC：回傳新值、記履歷、updated_by；其他站不動", async () => {
  const d = await db();
  const r = await save(d, "tw", [60, 150, 400, 900], "先收緊一點");
  assertEquals(r, { site: "tw", per_ip_submit: 60, per_ip_verify: 150, per_ditrust_submit: 400, per_ditrust_verify: 900, updated_by: "console:owner@example.com" });
  const jp = (await d.query<Row>(`SELECT * FROM quota_settings WHERE site = 'jp'`)).rows[0];
  assertEquals([jp.per_ip_submit, jp.updated_by], [80, "初值"]);

  const hist = (await d.query<{ field: string; record_id: string; agent_name: string; old_value: any; new_value: any }>(
    `SELECT field, record_id, agent_name, old_value, new_value FROM edit_history WHERE table_name = 'quota_settings' ORDER BY id`,
  )).rows;
  const audit = hist.filter((h) => h.field === "*" && h.old_value && h.new_value);
  assertEquals(audit.length, 1, "改前改後各一份整列");
  assertEquals([audit[0].record_id, audit[0].old_value.per_ip_submit, audit[0].new_value.per_ip_submit, audit[0].agent_name], ["tw", 80, 60, "activity-audit"]);
  const why = hist.filter((h) => h.field === "reason");
  assertEquals(why.length, 1);
  assertEquals([why[0].record_id, why[0].new_value, why[0].agent_name], ["tw", "先收緊一點", "console:owner@example.com"]);

  // 沒給 p_set_by 也能叫（六個參數）
  const six = await d.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE service_role`);
    return (await tx.query<Row>(`SELECT updated_by FROM console_admin_quota_settings_save('jp', 90, 210, 510, 1010, '日本放寬')`)).rows[0];
  });
  assertEquals(six.updated_by, "console:未知");
});

Deno.test("2b. 寫入 RPC：理由必填、site 與 NULL、CHECK 上下限都擋；權限只有 service_role", async () => {
  const d = await db();
  const ok: [number, number, number, number] = [70, 170, 470, 970];
  for (const reason of ["", "   ", "\n\t", null]) {
    await assertRejects(() => save(d, "tw", ok, reason), Error, "reason 必填");
  }
  await assertRejects(() => save(d, "xx", ok, "理由"), Error, "site 只能是 tw 或 jp");
  await assertRejects(() => save(d, "tw", [null, 170, 470, 970], "理由"), Error, "四個額度都要給");
  await assertRejects(() => save(d, "tw", [9, 170, 470, 970], "理由"), Error, "check");
  await assertRejects(() => save(d, "tw", [70, 5001, 470, 970], "理由"), Error, "check");
  await assertRejects(() => save(d, "tw", [70, 170, 5001, 970], "理由"), Error, "check");
  await assertRejects(() => save(d, "tw", [70, 170, 470, 10001], "理由"), Error, "check");
  // 失敗的都沒寫進去
  const r = (await d.query<Row>(`SELECT * FROM quota_settings WHERE site = 'tw'`)).rows[0];
  assertEquals([r.per_ip_submit, r.per_ip_verify, r.per_ditrust_submit, r.per_ditrust_verify], [80, 200, 500, 1000]);
  assertEquals((await d.query(`SELECT 1 FROM edit_history WHERE field = 'reason'`)).rows.length, 0);
  // 權限：anon／authenticated 不能叫（比照 console_admin_rule_save）
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => save(d, "tw", ok, "理由", role), Error, "permission denied", role);
  }
  assertStringIncludes(MIG, "GRANT EXECUTE ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) TO service_role");
  assertStringIncludes(MIG, "REVOKE ALL ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) FROM anon");
  assertStringIncludes(MIG, "SECURITY DEFINER");
});

Deno.test("3. console_quota_settings：anon 可讀，只回設定值與 updated_at／updated_by", async () => {
  const d = await db();
  await save(d, "jp", [100, 250, 600, 1200], "日本放寬");
  const j = await d.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE anon`);
    return (await tx.query<{ j: any }>(`SELECT console_quota_settings() AS j`)).rows[0].j;
  });
  assertEquals(Object.keys(j).sort(), ["jp", "tw"]);
  assertEquals(Object.keys(j.tw).sort(), ["per_ditrust_submit", "per_ditrust_verify", "per_ip_submit", "per_ip_verify", "updated_at", "updated_by"]);
  assertEquals([j.jp.per_ip_submit, j.jp.per_ip_verify, j.jp.per_ditrust_submit, j.jp.per_ditrust_verify, j.jp.updated_by], [100, 250, 600, 1200, "console:owner@example.com"]);
  assertEquals([j.tw.per_ip_submit, j.tw.updated_by], [80, "初值"]);
  assertStringIncludes(MIG, "GRANT EXECUTE ON FUNCTION console_quota_settings() TO anon, authenticated, service_role");
});

Deno.test("4. console_quota_now 的上限欄位讀這張表（正見列），其他欄位不變", async () => {
  const d = await db();
  const get = async () => (await d.query<{ j: any }>(`SELECT console_quota_now() AS j`)).rows[0].j;
  let j = await get();
  assertEquals([j.per_ip_submit_limit, j.per_ip_verify_limit, j.per_ditrust_submit_limit, j.per_ditrust_verify_limit], [80, 200, 500, 1000]);
  await save(d, "tw", [33, 44, 555, 666], "測試");
  j = await get();
  assertEquals([j.per_ip_submit_limit, j.per_ip_verify_limit, j.per_ditrust_submit_limit, j.per_ditrust_verify_limit], [33, 44, 555, 666]);
  assert("window_start" in j && "per_agent" in j && "per_network" in j);
  await save(d, "jp", [11, 12, 13, 14], "日本不影響正見");
  assertEquals((await get()).per_ip_submit_limit, 33);
  // 沒有 tw 列：退回初值，不丟錯
  await d.exec(`DELETE FROM quota_settings WHERE site = 'tw'`);
  j = await get();
  assertEquals([j.per_ip_submit_limit, j.per_ditrust_verify_limit], [80, 1000]);
});

// ---------------- TS ----------------

type Resp = { data: unknown; error: unknown };
function fakeClient(respond: (site: string) => Resp | Promise<Resp>, log: string[] = []) {
  const make = (schemaName: string) => ({
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_c: string, site: string) => ({
          limit: async (_n: number) => {
            log.push(`${schemaName}.${table}:${site}`);
            return await respond(site);
          },
        }),
      }),
    }),
  });
  return { ...make("default"), schema: (s: string) => make(s) };
}
const DEF = { per_ip_submit: 80, per_ip_verify: 200, per_ditrust_submit: 500, per_ditrust_verify: 1000 };
const row = (o: Record<string, unknown> = {}) => ({ data: [{ per_ip_submit: 40, per_ip_verify: 90, per_ditrust_submit: 300, per_ditrust_verify: 700, ...o }], error: null });

Deno.test("5. loadQuotaLimits：讀表生效、壞值逐欄退回常數、缺表／錯誤退回常數", async () => {
  resetQuotaCache();
  assertEquals(await loadQuotaLimits(fakeClient(() => row()), "tw", DEF, 1000), { per_ip_submit: 40, per_ip_verify: 90, per_ditrust_submit: 300, per_ditrust_verify: 700 });

  // 壞值：非整數、超界、字串、NULL——只有壞的那一欄退回常數
  resetQuotaCache();
  assertEquals(
    await loadQuotaLimits(fakeClient(() => row({ per_ip_submit: 40.5, per_ip_verify: 5001, per_ditrust_submit: "300", per_ditrust_verify: null })), "tw", DEF, 1000),
    DEF,
  );
  resetQuotaCache();
  assertEquals(await loadQuotaLimits(fakeClient(() => row({ per_ip_submit: 9 })), "tw", DEF, 1000), { ...DEF, per_ip_verify: 90, per_ditrust_submit: 300, per_ditrust_verify: 700 });

  // 缺表（PostgREST 回 error）、丟例外、空結果、沒有 schema 方法的舊假 client
  const cases: Array<[string, unknown]> = [
    ["error", fakeClient(() => ({ data: null, error: { message: 'relation "quota_settings" does not exist' } }))],
    ["throw", fakeClient(() => { throw new Error("boom"); })],
    ["empty", fakeClient(() => ({ data: [], error: null }))],
    ["no-from", {}],
    ["null", null],
  ];
  for (const [name, c] of cases) {
    resetQuotaCache();
    assertEquals(await loadQuotaLimits(c, "tw", DEF, 1000), DEF, name);
  }
  assert(isValidQuotaValue("per_ip_submit", 10) && isValidQuotaValue("per_ip_submit", 2000));
  assert(!isValidQuotaValue("per_ip_submit", 2001) && !isValidQuotaValue("per_ip_submit", NaN));
});

Deno.test("5b. 快取 60 秒、站別各一份、日本站讀 public schema 的 jp 列", async () => {
  resetQuotaCache();
  const log: string[] = [];
  let ip = 40;
  const c = fakeClient(() => row({ per_ip_submit: ip }), log);
  const t0 = 1_000_000;
  assertEquals((await loadQuotaLimits(c, "tw", DEF, t0)).per_ip_submit, 40);
  ip = 55; // 資料表被改了
  assertEquals((await loadQuotaLimits(c, "tw", DEF, t0 + QUOTA_CACHE_MS - 1)).per_ip_submit, 40, "60 秒內用快取");
  assertEquals(log.length, 1);
  assertEquals((await loadQuotaLimits(c, "tw", DEF, t0 + QUOTA_CACHE_MS)).per_ip_submit, 55, "滿 60 秒重查");
  assertEquals(log.length, 2);

  // 站別各自一份；jp 走 .schema("public")
  const jpLimits = await loadQuotaLimits(c, "jp", { ...DEF, per_ip_submit: 77 }, t0 + QUOTA_CACHE_MS);
  assertEquals(jpLimits.per_ip_submit, 55);
  assertEquals(log, ["public.quota_settings:tw", "public.quota_settings:tw", "public.quota_settings:jp"]);

  // 壞掉的結果（退回常數）也快取，不會每個請求都去敲資料庫
  resetQuotaCache();
  const log2: string[] = [];
  const bad = fakeClient(() => ({ data: null, error: { message: "x" } }), log2);
  await loadQuotaLimits(bad, "tw", DEF, t0);
  await loadQuotaLimits(bad, "tw", DEF, t0 + 1000);
  assertEquals(log2.length, 1);
  resetQuotaCache();
});

Deno.test("6. 帶 limits 後 *QuotaFor 的額度生效（正見與日本站、DiTrust 與匿名）；不帶用常數", () => {
  const lim = { per_ip_submit: 40, per_ip_verify: 90, per_ditrust_submit: 300, per_ditrust_verify: 700 };
  const dt = { level: "ditrust", actor_id: "ditrust:u1", handle: "x" } as const;
  const ip = { level: "ip", actor_id: "ip:h", handle: "y" } as const;
  assertEquals(submitQuotaFor(ip, "h", lim).limit, 40);
  assertEquals(submitQuotaFor(dt, "h", lim).limit, 300);
  assertEquals(verifyQuotaFor(ip, "h", lim).limit, 90);
  assertEquals(verifyQuotaFor(dt, "h", lim).limit, 700);
  assertEquals(jpC.submitQuotaFor(ip, "h", lim).limit, 40);
  assertEquals(jpC.submitQuotaFor(dt, "h", lim).limit, 300);
  assertEquals(jpV.verifyQuotaFor(ip, "h", lim).limit, 90);
  assertEquals(jpV.verifyQuotaFor(dt, "h", lim).limit, 700);
  // 不帶＝常數
  assertEquals([submitQuotaFor(ip, "h").limit, submitQuotaFor(dt, "h").limit, verifyQuotaFor(ip, "h").limit, verifyQuotaFor(dt, "h").limit], [80, 500, 200, 1000]);
});

Deno.test("7. 名冊批次上限＝min(80, 網段提交額度)，不低於一般批次；驗證函式吃 rosterBatchCap", () => {
  assertEquals(effectiveRosterBatchCap(MAX_BATCH_ROSTER, 80, MAX_BATCH), 80);
  assertEquals(effectiveRosterBatchCap(MAX_BATCH_ROSTER, 2000, MAX_BATCH), 80, "額度調高也不超過常數");
  assertEquals(effectiveRosterBatchCap(MAX_BATCH_ROSTER, 50, MAX_BATCH), 50);
  assertEquals(effectiveRosterBatchCap(MAX_BATCH_ROSTER, 10, MAX_BATCH), MAX_BATCH, "額度比一般批次還小時不放寬名冊批次");

  const batch = (n: number) => ({ agent_name: "roster-batch-test", contributions: records.slice(0, n).map((r) => candidacyOf(r)) });
  const accepted = (n: number, cap?: number) => validateContributionRequest(batch(n), undefined, cap === undefined ? undefined : { rosterBatchCap: cap }).ok;
  assert(accepted(80) && !accepted(81), "沒給＝常數 80");
  assert(accepted(50, 50) && !accepted(51, 50), "上限跟著額度走");
  assert(accepted(20, 10), "一般批次上限 20 不受影響");
  assert(!accepted(21, 10), "額度比一般批次還小時不放寬名冊批次");
  const msg = validateContributionRequest(batch(51), undefined, { rosterBatchCap: 50 });
  assert(!msg.ok && msg.errors.some((e) => e.message.includes("最多 50 筆")));
});

Deno.test("8. 接線：入口與 handler 都讀 quota_settings 並把值傳進 *QuotaFor", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const [tw, vh, jc, jv, next, jnext] = await Promise.all([
    read("./contribute-handler.ts"), read("./verify-handler.ts"), read("./jp/contribute-handler.ts"), read("./jp/verify-handler.ts"),
    read("../next/index.ts"), read("../jp-next/index.ts"),
  ]);
  assertStringIncludes(tw, 'loadQuotaLimits(supabase, "tw", QUOTA_DEFAULTS)');
  assertStringIncludes(tw, "submitQuotaFor(actor, ipHash, quotaLimits)");
  assertStringIncludes(tw, "effectiveRosterBatchCap(MAX_BATCH_ROSTER, quotaLimits.per_ip_submit, MAX_BATCH)");
  assertStringIncludes(vh, 'verifyQuotaFor(actor, ipHash, await loadQuotaLimits(supabase, "tw", QUOTA_DEFAULTS))');
  assertStringIncludes(jc, 'submitQuotaFor(actor, ipHash, await loadQuotaLimits(supabase, "jp", QUOTA_DEFAULTS))');
  assertStringIncludes(jv, 'verifyQuotaFor(actor, ipHash, await loadQuotaLimits(supabase, "jp", QUOTA_DEFAULTS))');
  assertStringIncludes(next, 'loadQuotaLimits(supabase, "tw", QUOTA_DEFAULTS)');
  assertStringIncludes(next, "submitQuotaFor(identity.actor, ipHashForIdentity, quotaLimits)");
  assertStringIncludes(next, "verifyQuotaFor(identity.actor, ipHashForIdentity, quotaLimits)");
  assertStringIncludes(jnext, 'loadQuotaLimits(supabase, "jp", QUOTA_DEFAULTS)');
  assertStringIncludes(jnext, "submitQuotaFor(actor, ipHash, quotaLimits)");
  assertStringIncludes(jnext, "verifyQuotaFor(actor, ipHash, quotaLimits)");
});
