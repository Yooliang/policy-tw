/**
 * term_policy_missing 改設定表驅動的「部署前後差集」守門（2026-10-07，#332 選前必補第 2 項）。
 *
 * 做法：PGlite 灌正式庫唯讀快照（scripts/term-policy-parity.sql 產生），同一份資料跑
 *   ① 舊函式——20261006220000 那支 migration 裡的 contribution_auto_tasks_term_policies() 原文，改名 legacy_term_policies()
 *   ② 新函式——20261007225000_election_task_config.sql（建設定表＋種子＋新函式）整支執行
 * 然後逐件比對輸出（task_id、task_type、target、what_we_need、hint_sources、reward、region 全欄）：差集必須是空的。
 *
 * 判準不來自 fixture：快照的 hash／筆數是正式庫「現行函式」同一個查詢快照裡算出來的，PGlite 跑舊函式必須對得上，
 * 才證明 stub 表沒走樣（三方相等：正式庫＝舊函式＝新函式）。
 *
 * 另外三組檢查，確認設定表真的有效、不是裝飾：
 *   - 負向對照（還原驗證）：改動種子（關掉 2022、改 2024 的公報入口、改 2022 的結尾句、拿掉 positions 的閘門）後，差集必須「不是空的」；
 *     這一組不紅，代表上面那條「差集為空」什麼都驗不出來。
 *   - 合成情境：新增一屆（positions 只含縣市長）、2026 開／關。確認 positions 是閘門、enabled 是總開關、
 *     空的 bulletin_hint／scope_note 走通用文案。
 *
 * 用法（不進 CI：要網路抓 PGlite、要正式庫快照）：
 *   npx supabase db query --linked -f scripts/term-policy-parity.sql   # 取 rows[0].j 存成 snapshot.json
 *   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/term-policy-parity.ts snapshot.json
 * 另有兩個可選參數：舊 migration 路徑、新 migration 路徑。
 */
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const snapPath = Deno.args[0];
if (!snapPath) {
  console.error("用法：deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/term-policy-parity.ts <snapshot.json> [舊 migration] [新 migration]");
  Deno.exit(2);
}
const OLD_MIG: string | URL = Deno.args[1] ?? new URL("../supabase/migrations/20261006220000_candidacy_read_side.sql", import.meta.url);
const NEW_MIG: string | URL = Deno.args[2] ?? new URL("../supabase/migrations/20261007225000_election_task_config.sql", import.meta.url);
const snap = JSON.parse(Deno.readTextFileSync(snapPath));

const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "：" + detail : ""}`);
  if (!ok) fails.push(name);
}

// ── 舊函式原文：從 20261006220000 切出來改名 ─────────────────────────
const oldSql = Deno.readTextFileSync(OLD_MIG).replace(/\r\n/g, "\n");
const from = oldSql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()");
const to = oldSql.indexOf("$$;", from) + 3;
if (from < 0 || to < 3) throw new Error("舊 migration 裡找不到 contribution_auto_tasks_term_policies()");
const legacyFn = oldSql.slice(from, to).replace("contribution_auto_tasks_term_policies()", "legacy_term_policies()");

// ── stub 表（只有函式用到的欄位）＋灌快照 ───────────────────────────
const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE TABLE elections (id integer PRIMARY KEY);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text, party text, merged_into uuid, region text);
CREATE TABLE regions (id integer PRIMARY KEY, region text);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid, election_id integer, election_type text, region_id integer, candidacy_status text);
CREATE TABLE policies (politician_id uuid, election_id integer, removed_at timestamptz);
CREATE TABLE politician_bulletins (politician_id uuid, election_id integer, election_type text, election_result text, region text, sub_region text,
                                   village text, cand_no integer, elected boolean, urls text[], match_basis text);
CREATE TABLE task_dispatches (task_id text);
CREATE FUNCTION term_policy_village_cap() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT ${Number(snap.village_cap)} $$;
`);
async function load(table: string, rows: unknown[] | null) {
  if (!rows || rows.length === 0) return;
  await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows)]);
}
for (const t of ["elections", "politicians", "regions", "politician_elections", "policies", "politician_bulletins", "task_dispatches"]) await load(t, snap[t]);

await db.exec(legacyFn);
await db.exec(Deno.readTextFileSync(NEW_MIG));

const FINGERPRINT = "md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.task_id))";
async function fp(fn: string) {
  const r = (await db.query<{ n: number; h: string }>(`SELECT count(*)::int AS n, ${FINGERPRINT} AS h FROM ${fn}() t`)).rows[0];
  return r;
}
/** 兩支函式的輸出各算一次（物化成暫存表），逐欄全比：a 有 b 沒有、b 有 a 沒有各幾件 */
async function diff(a = "legacy_term_policies", b = "contribution_auto_tasks_term_policies") {
  await db.exec(`DROP TABLE IF EXISTS pa; DROP TABLE IF EXISTS pb_out;
    CREATE TEMP TABLE pa AS SELECT to_jsonb(x) AS j FROM ${a}() x;
    CREATE TEMP TABLE pb_out AS SELECT to_jsonb(y) AS j FROM ${b}() y;`);
  const q = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
  return {
    aOnly: await q("SELECT count(*)::int AS n FROM (SELECT j FROM pa EXCEPT SELECT j FROM pb_out) d"),
    bOnly: await q("SELECT count(*)::int AS n FROM (SELECT j FROM pb_out EXCEPT SELECT j FROM pa) d"),
    aN: await q("SELECT count(*)::int AS n FROM pa"),
    bN: await q("SELECT count(*)::int AS n FROM pb_out"),
  };
}

// ── ① 三方相等：正式庫 ＝ 舊函式 ＝ 新函式 ───────────────────────────
const prod = { n: Number(snap.n), h: String(snap.hash) };
const legacy = await fp("legacy_term_policies");
const next = await fp("contribution_auto_tasks_term_policies");
console.log(`正式庫 ${prod.n} 件 ${prod.h}（${snap.taken_at}）\n舊函式 ${legacy.n} 件 ${legacy.h}\n新函式 ${next.n} 件 ${next.h}`);
check("stub 沒走樣：PGlite 跑舊函式＝正式庫現行函式（筆數與全欄雜湊）", legacy.n === prod.n && legacy.h === prod.h);
check("部署前後筆數相同", next.n === legacy.n, `${legacy.n} → ${next.n}`);
const d0 = await diff();
check("部署前後差集為空（舊有新沒有 0 件、新有舊沒有 0 件；task_id、target、說明、hint_sources、reward、region 全欄逐件相同）", d0.aOnly === 0 && d0.bOnly === 0, JSON.stringify(d0));
check("部署前後全欄雜湊相同", next.h === legacy.h);
const byElection = (await db.query<{ e: string; n: number }>(`SELECT target->>'election_id' AS e, count(*)::int AS n FROM contribution_auto_tasks_term_policies() GROUP BY 1 ORDER BY 1`)).rows;
console.log("  分屆：", byElection.map((r) => `${r.e}=${r.n}`).join(" "));
check("樣本夠大：兩屆都有件、而且有當選人段與公報段（hint 有 bulletin 的與沒有的都有）", byElection.length >= 2 && byElection.every((r) => r.n > 0));
const kinds = (await db.query<{ withUrls: number; without: number }>(
  `SELECT count(*) FILTER (WHERE target ? 'bulletin_urls')::int AS "withUrls", count(*) FILTER (WHERE NOT target ? 'bulletin_urls')::int AS without FROM contribution_auto_tasks_term_policies()`)).rows[0];
console.log(`  有公報 ${kinds.withUrls} 件、沒有公報（走設定表的 bulletin_hint）${kinds.without} 件`);
check("沒有公報的那一段（吃 bulletin_hint 與 scope_note 的）有樣本", kinds.without > 0);

// ── ② 設定表種子：與原本寫死的逐字相同 ───────────────────────────────
const cfg = (await db.query<{ election_id: number; positions: string[]; bulletin_roc_year: number; enabled: boolean }>(
  `SELECT election_id, positions, bulletin_roc_year, enabled FROM election_task_config ORDER BY election_id`)).rows;
check("種子三列：2022（縣市長／縣市議員／鄉鎮市長、111、開）、2024（立法委員、113、開）、2026（縣市長／縣市議員／鄉鎮市長、115、關）",
  JSON.stringify(cfg) === JSON.stringify([
    { election_id: 2022, positions: ["縣市長", "縣市議員", "鄉鎮市長"], bulletin_roc_year: 111, enabled: true },
    { election_id: 2024, positions: ["立法委員"], bulletin_roc_year: 113, enabled: true },
    { election_id: 2026, positions: ["縣市長", "縣市議員", "鄉鎮市長"], bulletin_roc_year: 115, enabled: false },
  ]), JSON.stringify(cfg));

// ── ③ 負向對照（還原驗證）：動一下設定，差集必須不是空的 ─────────────────
async function mutated(name: string, sql: string, expectDiff = true) {
  await db.exec("BEGIN");
  await db.exec(sql);
  const d = await diff();
  await db.exec("ROLLBACK");
  const changed = d.aOnly + d.bOnly > 0;
  check(`負向對照：${name} → 差集${expectDiff ? "不為空" : "為空"}`, changed === expectDiff, JSON.stringify(d));
}
await mutated("關掉 2022", "UPDATE election_task_config SET enabled = false WHERE election_id = 2022");
await mutated("關掉 2024", "UPDATE election_task_config SET enabled = false WHERE election_id = 2024");
await mutated("2022 的公報入口改一個字", "UPDATE election_task_config SET bulletin_hint = bulletin_hint || '！' WHERE election_id = 2022");
await mutated("2022 的結尾句拿掉（改用通用文案）", "UPDATE election_task_config SET scope_note = NULL WHERE election_id = 2022");
await mutated("2024 的結尾句拿掉（改用通用文案）", "UPDATE election_task_config SET scope_note = NULL WHERE election_id = 2024");
// 對照：改動「沒開的 2026」不會影響輸出（正向：差集仍為空）
await mutated("改 2026 那一列的職位與公報年（它是關的）", "UPDATE election_task_config SET positions = ARRAY['縣市長'], bulletin_roc_year = 999, bulletin_hint = 'x', scope_note = 'y' WHERE election_id = 2026", false);
{
  const d2 = await diff();
  check("還原後（ROLLBACK）差集回到空", d2.aOnly === 0 && d2.bOnly === 0, JSON.stringify(d2));
}

// ── ③' 合成補強：真實資料碰不到的分支 ─────────────────────────────────
// 真實資料裡 2024 的 247 件全有公報、positions 以外的當選者也都靠公報進來（村里長有 cap），所以 2024 的 bulletin_hint
// 與 positions 閘門在真實資料上看不出差別（上面兩個對照當時就是這樣紅不起來）；補一批合成當選者，
// 讓舊函式與新函式在這些分支上也必須逐件相同，並讓下面的負向對照有東西可咬。
const U = (n: number) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;
const synthRows: ReadonlyArray<readonly [number, number, string, string]> = [
  [1, 2022, "縣市長", "elected"], [2, 2022, "縣市議員", "elected"], [3, 2022, "鄉鎮市長", "elected"],
  [4, 2022, "村里長", "elected"], //      positions 以外、沒有公報 → 兩邊都不派
  [5, 2024, "立法委員", "elected"], //    2024 沒有公報的當選立委 → 走 2024 的 bulletin_hint
  [6, 2024, "縣市議員", "elected"], //    positions 以外（閘門）→ 兩邊都不派
  [7, 2024, "立法委員", "not_elected"], // 落選、沒有公報 → 兩邊都不派
  [8, 4, "縣市長", "elected"], //         設定表沒有這一屆 → 兩邊都不派
  [9, 2026, "縣市長", "elected"], //      2026 關著 → 兩邊都不派
  [10, 2022, "縣市長", "elected"], //     被合併的人物（merged_into）
  [11, 2022, "縣市長", "elected"], //     該屆已有政見
];
await db.exec("BEGIN");
await db.exec(`INSERT INTO politicians VALUES ${synthRows.map(([n]) => `('${U(n)}', '合成${n}', '無黨籍', ${n === 10 ? `'${U(1)}'::uuid` : "NULL"}, '台北市')`).join(",")};
  INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status) VALUES
    ${synthRows.map(([n, e, t, st]) => `(${980000 + n}, '${U(n)}', ${e}, '${t}', NULL, '${st}')`).join(",")};
  INSERT INTO policies VALUES ('${U(11)}', 2022, NULL), ('${U(9)}', 2022, NULL);`);
const dS = await diff();
check("合成補強：加進這批當選者後，舊函式與新函式差集仍為空", dS.aOnly === 0 && dS.bOnly === 0, JSON.stringify(dS));
const synOut = (await db.query<{ task_id: string; hint: string }>(
  `SELECT task_id, hint_sources[1] AS hint FROM contribution_auto_tasks_term_policies() WHERE task_id LIKE 'auto:term_policy_missing:00000000-0000-0000-0000-0000000001%' ORDER BY task_id`)).rows;
const synIds = synOut.map((r) => Number(r.task_id.match(/-0000000001(\d\d):/)![1]));
check("合成補強：兩邊都只派該派的四位（2022 縣市長／縣市議員／鄉鎮市長、2024 沒有公報的立委）", JSON.stringify(synIds) === JSON.stringify([1, 2, 3, 5]), JSON.stringify(synIds));
check(
  "合成補強：2024 那位的入口＝2024 公報入口、2022 的＝2022 入口（逐字，不是通用文案）",
  synOut.find((r) => r.task_id.includes(":2024"))!.hint.startsWith("https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86") &&
    synOut.filter((r) => r.task_id.includes(":2022")).every((r) => r.hint.startsWith("https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）")),
);
/** 負向對照（在合成資料上咬得到）：改設定或改新函式，差集必須不是空的 */
async function mutatedSyn(name: string, sql: string, fnPatch?: (fnText: string) => string) {
  await db.exec("SAVEPOINT m");
  if (fnPatch) {
    const t = Deno.readTextFileSync(NEW_MIG).replace(/\r\n/g, "\n");
    const a = t.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()");
    await db.exec(fnPatch(t.slice(a, t.indexOf("$$;", a) + 3)));
  }
  if (sql) await db.exec(sql);
  const d = await diff();
  await db.exec("ROLLBACK TO SAVEPOINT m");
  check(`負向對照（合成資料）：${name} → 差集不為空`, d.aOnly + d.bOnly > 0, JSON.stringify(d));
}
await mutatedSyn("2024 的公報入口改一個字", "UPDATE election_task_config SET bulletin_hint = bulletin_hint || '！' WHERE election_id = 2024");
await mutatedSyn("拿掉 positions 閘門（positions 不是裝飾）", "", (t) => {
  const gate = " AND pe.election_type = ANY (cfg.positions)";
  if (!t.includes(gate)) throw new Error("找不到 positions 閘門");
  return t.replace(gate, "");
});
await mutatedSyn("拿掉當選人段的 enabled 條件（關掉 2022 仍會派）", "UPDATE election_task_config SET enabled = false WHERE election_id = 2022", (t) => {
  const g = "JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND cfg.enabled AND";
  if (!t.includes(g)) throw new Error("找不到當選人段的 enabled 條件");
  return t.replace(g, "JOIN election_task_config cfg ON cfg.election_id = pe.election_id AND");
});
await db.exec("ROLLBACK");
const afterSyn = await diff();
check("合成補強全部 ROLLBACK 後差集回到空、輸出筆數回到正式庫的筆數", afterSyn.aOnly === 0 && afterSyn.bOnly === 0 && afterSyn.bN === prod.n, JSON.stringify(afterSyn));

// ── ④ 合成情境：新增一屆、2026 開關 ─────────────────────────────────
await db.exec("BEGIN");
await db.exec(`
INSERT INTO elections VALUES (2030);
INSERT INTO politicians VALUES
  ('00000000-0000-0000-0000-000000000001', '合成縣市長', '無黨籍', NULL, '台北市'),
  ('00000000-0000-0000-0000-000000000002', '合成議員',   '無黨籍', NULL, '台北市'),
  ('00000000-0000-0000-0000-000000000003', '合成落選',   '無黨籍', NULL, '台北市'),
  ('00000000-0000-0000-0000-000000000004', '合成2026當選', '無黨籍', NULL, '台北市'),
  ('00000000-0000-0000-0000-000000000005', '合成2026當選零政見', '無黨籍', NULL, '台北市');
INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status) VALUES
  (990001, '00000000-0000-0000-0000-000000000001', 2030, '縣市長', NULL, 'elected'),
  (990002, '00000000-0000-0000-0000-000000000002', 2030, '縣市議員', NULL, 'elected'),
  (990003, '00000000-0000-0000-0000-000000000003', 2030, '縣市長', NULL, 'not_elected'),
  (990004, '00000000-0000-0000-0000-000000000004', 2026, '縣市長', NULL, 'elected'),
  (990005, '00000000-0000-0000-0000-000000000005', 2026, '縣市長', NULL, 'elected');
-- 2026 當選者之一有別屆的政見（去重：零政見的 2026 候選人留給 policy_missing，所以只有「已有政見、卻沒有 2026 政見」的人會派）
INSERT INTO policies VALUES ('00000000-0000-0000-0000-000000000004', 2022, NULL);
`);
const synth = async () => (await db.query<{ task_id: string; election_id: number; hint: string; what: string }>(
  `SELECT task_id, (target->>'election_id')::int AS election_id, hint_sources[1] AS hint, what_we_need AS what
     FROM contribution_auto_tasks_term_policies() WHERE task_id LIKE 'auto:term_policy_missing:00000000-0000-0000-0000-00000000000%' ORDER BY task_id`)).rows;

check("新增一屆但還沒設定列 → 一件都不派", (await synth()).length === 0);
await db.exec(`INSERT INTO election_task_config (election_id, positions, bulletin_roc_year, enabled) VALUES (2030, ARRAY['縣市長'], 119, true)`);
let s = await synth();
check("新增 2030 一列（positions＝縣市長）→ 只派當選的縣市長；縣市議員（不在 positions）與落選者不派", s.length === 1 && s[0].task_id.endsWith(":2030") && s[0].task_id.includes("0001"), JSON.stringify(s.map((r) => r.task_id.slice(-42))));
check("沒填 bulletin_hint → 通用文案：公報站首頁＋屆別與民國年", !!s[0] && s[0].hint.startsWith("https://eebulletin.cec.gov.tw/ ← 中選會 2030（119 年）選舉公報"), s[0]?.hint.slice(0, 80));
check("沒填 scope_note → 通用結尾，不點名 2026", !!s[0] && s[0].what.endsWith("任內才宣布的施政、之後新提出的政見不是這一屆的競選政見。") && !s[0].what.includes("2026 的新政見"));
await db.exec(`UPDATE election_task_config SET enabled = false WHERE election_id = 2030`);
check("enabled=false → 這一屆不派（總開關）", (await synth()).length === 0);
await db.exec(`UPDATE election_task_config SET enabled = true WHERE election_id = 2030`);
await db.exec(`UPDATE election_task_config SET positions = ARRAY['縣市長', '縣市議員'] WHERE election_id = 2030`);
s = await synth();
check("positions 加上縣市議員 → 議員也派", s.length === 2);
await db.exec(`UPDATE election_task_config SET bulletin_hint = '自訂入口', scope_note = '自訂結尾。' WHERE election_id = 2030`);
s = await synth();
check("填了 bulletin_hint、scope_note → 用填的", s.every((r) => r.hint === "自訂入口" && r.what.endsWith("別人交了還在等票的不要再交；自訂結尾。")));

// 2026：關著不派；開了之後只派「已有別屆政見、卻沒有 2026 政見」的當選縣市長（positions 內）
await db.exec(`DELETE FROM election_task_config WHERE election_id = 2030`);
check("2026 預設關著 → 合成的 2026 當選者不派", (await synth()).length === 0);
await db.exec(`UPDATE election_task_config SET enabled = true WHERE election_id = 2026`);
s = await synth();
check("2026 開了 → 派有別屆政見的當選縣市長；零政見的留給 policy_missing（去重照舊）", s.length === 1 && s[0].task_id.endsWith("0004:2026"), JSON.stringify(s.map((r) => r.task_id.slice(-42))));
check("2026 開了 → 說明與入口用通用文案（沒有 2022／2024 的字樣）",
  !!s[0] && s[0].hint.includes("2026（115 年）選舉公報") && !s[0].hint.includes("dir=111") && !s[0].what.includes("2026 的新政見"));
const withOthers = await fp("contribution_auto_tasks_term_policies");
const dOpen = await diff();
check("2026 開了之後，2022、2024 的既有派工一件不少（只多了 2026 的）", dOpen.aOnly === 0 && dOpen.bOnly === 1 && withOthers.n === legacy.n + 1, `${legacy.n} → ${withOthers.n}`);
await db.exec("ROLLBACK");
const back = await diff();
check("合成情境全部 ROLLBACK 後差集回到空", back.aOnly === 0 && back.bOnly === 0);

// ── ⑤ 其他：RLS、重跑 ───────────────────────────────────────────────
await db.exec(Deno.readTextFileSync(NEW_MIG)); // 同一支 migration 再跑一次
const cfg2 = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM election_task_config")).rows[0].n;
const d3 = await diff();
check("migration 可重跑（種子 ON CONFLICT DO NOTHING，不多列、輸出不變）", cfg2 === 3 && d3.aOnly === 0 && d3.bOnly === 0);
const pol = (await db.query<{ polname: string }>("SELECT polname FROM pg_policy WHERE polrelid = 'election_task_config'::regclass ORDER BY polname")).rows.map((r) => r.polname);
check("設定表開 RLS：公開讀、只有 service_role 能寫", pol.join() === "Public read,Service role write", pol.join());

console.log(fails.length === 0 ? "\n全部通過" : `\n失敗 ${fails.length} 項：${fails.join("、")}`);
if (fails.length) Deno.exit(1);
