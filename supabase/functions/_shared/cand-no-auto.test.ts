/**
 * 號次由中選會名冊鏡像唯一對上由系統寫入，對不上才派代理（維護者 2026-11-11；migration 20261111110000，更正 09-24／10-08「號次不做系統核對」）的守門測試。
 *
 * PGlite 實跑：把整支 migration 原樣載進迷你資料庫（真的 roster_name_key、cec_name_norm、ballot_number_unit、cec_roster_norm_unit、
 * 審計觸發器；只有表是簡化的），在合成資料上驗：
 *   1. 唯一對上 → 寫入（含臺／台、鄉鎮市長）
 *   2. 同名兩筆（我們這邊、鏡像那邊）→ 不寫；單位不 fresh → 不寫；鏡像沒有號次、鏡像找不到、算不出單位 → 不寫
 *   3. 同號次單位已有人用這個號次、同一輪兩位要寫同號次 → 不寫（duplicate_in_unit）
 *   4. 退選、已有號次、人物被併走的不碰；只補空白
 *   5. 每筆進 edit_history（cand-no-auto、contribution_id 空）、留證據、一輪一個 run；再跑一次不重寫；batch_limit
 *   6. 開關：預設關、關著 plan 回空、apply 不做事、乾跑不看開關
 *   7. revert：只還原現值仍是它寫的（被改過的算 blocked）、還原自動關開關、被還原的之後不再寫
 *   8. migration 本身不改任何參選紀錄
 *   9. 不一致視圖 cand_no_auto_mismatch：站上已有號次、鏡像唯一對上但不同的只列不寫
 *      視圖不公開、revert 與 apply 同一把鎖；村里長：同鄉鎮不同里同名不寫、沒村里不寫、按村里單位查重複
 *  10. 還原驗證：拿掉單位 fresh 判斷、拿掉同名多筆判斷、拿掉重複號次判斷都要紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261111110000_cand_no_auto.sql";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, region text, merged_into uuid);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer NOT NULL, election_type text,
  region_id integer, candidacy_status text, cand_no integer);
CREATE TABLE cec_roster_units (url text PRIMARY KEY, kind text, election_type text NOT NULL, county text NOT NULL, county_code text NOT NULL DEFAULT '',
  town text NOT NULL DEFAULT '', town_code text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending', row_count integer NOT NULL DEFAULT 0, fetched_at timestamptz);
CREATE TABLE cec_roster_2026 (id bigserial PRIMARY KEY, election_type text NOT NULL, county text NOT NULL, town text NOT NULL DEFAULT '', district text NOT NULL DEFAULT '',
  name text NOT NULL, name_key text, cand_no integer, unit_key text NOT NULL, unit_url text NOT NULL REFERENCES cec_roster_units(url));
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
`;

interface Pe { id: number; name: string; county: string; type?: string; sub?: string; village?: string; status?: string; no?: number | null; merged?: boolean }
const PES: Pe[] = [];
const pe = (id: number, name: string, county: string, o: Omit<Pe, "id" | "name" | "county"> = {}) => PES.push({ id, name, county, ...o });
interface Ro { type: string; county: string; town?: string; unit: string; name: string; no: number | null; url: string }
const ROS: Ro[] = [];
const UNITS: Array<{ url: string; type: string; county: string; town?: string; fresh: boolean }> = [];
const unit = (url: string, county: string, o: { type?: string; town?: string; fresh?: boolean } = {}) => UNITS.push({ url, type: o.type ?? "縣市長", county, town: o.town, fresh: o.fresh ?? true });
const ro = (url: string, county: string, name: string, no: number | null, o: { type?: string; town?: string; unit?: string } = {}) =>
  ROS.push({ type: o.type ?? "縣市長", county, town: o.town, unit: o.unit ?? county, name, no, url });

// ── 情境（pe id 就是 region id） ──────────────────────────────
// A 台北市：唯一對上 → 寫 3
unit("u-tp", "台北市"); ro("u-tp", "台北市", "甲A", 3); pe(1, "甲A", "台北市", { status: "filed" });
// B 新北市：我們同名兩筆（不同人）→ ambiguous_ours
unit("u-nt", "新北市"); ro("u-nt", "新北市", "乙B", 1); pe(2, "乙B", "新北市", { status: "filed" }); pe(3, "乙B", "新北市", { status: "filed" });
// C 桃園市：鏡像同名兩筆 → ambiguous_roster
unit("u-ty", "桃園市"); ro("u-ty", "桃園市", "丙C", 1); ro("u-ty", "桃園市", "丙C", 2); pe(4, "丙C", "桃園市", { status: "filed" });
// D 台中市：單位 5 天前才抓成功（不 fresh）→ unit_not_fresh
unit("u-tc", "台中市", { fresh: false }); ro("u-tc", "台中市", "丁D", 1); pe(5, "丁D", "台中市", { status: "filed" });
// E 高雄市：同單位已有人（已6）用 2 號 → duplicate_in_unit
unit("u-ks", "高雄市"); ro("u-ks", "高雄市", "戊E", 2); ro("u-ks", "高雄市", "己F", 2);
pe(6, "戊E", "高雄市", { status: "filed" }); pe(7, "己F", "高雄市", { status: "filed", no: 2 });
// F 台南市：鏡像找不到 → not_in_roster；鏡像那列沒號次 → roster_no_cand_no
unit("u-tn", "台南市"); ro("u-tn", "台南市", "辛H", null); pe(8, "庚G", "台南市", { status: "filed" }); pe(9, "辛H", "台南市", { status: "filed" });
// G 嘉義縣：鏡像兩位同號次（壬、癸都是 1）→ 這一輪兩位都不寫 duplicate_in_unit
unit("u-cy", "嘉義縣"); ro("u-cy", "嘉義縣", "壬I", 1); ro("u-cy", "嘉義縣", "癸J", 1); pe(10, "壬I", "嘉義縣", { status: "filed" }); pe(11, "癸J", "嘉義縣", { status: "filed" });
// H 鄉鎮市長 雲林縣：我們寫「臺西鄉」、鏡像寫「台西鄉」→ 寫 2
unit("u-yl", "雲林縣", { type: "鄉鎮市長" }); ro("u-yl", "雲林縣", "子K", 2, { type: "鄉鎮市長", unit: "雲林縣|台西鄉" });
pe(12, "子K", "雲林縣", { status: "filed", type: "鄉鎮市長", sub: "臺西鄉" });
// I 不碰：退選、已有號次（不重寫）、人物被併走
unit("u-hc", "新竹縣"); ro("u-hc", "新竹縣", "丑L", 1); ro("u-hc", "新竹縣", "寅M", 2); ro("u-hc", "新竹縣", "卯N", 3);
pe(13, "丑L", "新竹縣", { status: "withdrawn" }); pe(14, "寅M", "新竹縣", { status: "filed", no: 9 }); pe(15, "卯N", "新竹縣", { status: "filed", merged: true });
// J 算不出單位：鄉鎮市長沒記到鄉鎮 → no_unit
unit("u-ml", "苗栗縣", { type: "鄉鎮市長" }); ro("u-ml", "苗栗縣", "辰O", 1, { type: "鄉鎮市長", unit: "苗栗縣|頭份市" });
pe(16, "辰O", "苗栗縣", { status: "filed", type: "鄉鎮市長" });
// K 彰化縣：之後測還原用的兩位（寫了 1、2 號）
unit("u-ch", "彰化縣"); ro("u-ch", "彰化縣", "巳P", 1); ro("u-ch", "彰化縣", "午Q", 2); pe(17, "巳P", "彰化縣", { status: "filed" }); pe(18, "午Q", "彰化縣", { status: "filed" });

// 村里長（鏡像只到鄉鎮，單位 縣市|鄉鎮；我們的號次單位到村里）
const V = { type: "村里長" };
// V1 桃園市平鎮區：同鄉鎮兩個里各一位同名（子V）→ ambiguous_ours，兩位都不寫（兩個里的號次單位不同，同輪重複那道備援蓋不到）
unit("u-v1", "桃園市", { ...V, town: "平鎮區" }); ro("u-v1", "桃園市", "子V", 1, { ...V, town: "平鎮區", unit: "桃園市|平鎮區" });
pe(20, "子V", "桃園市", { ...V, status: "filed", sub: "平鎮區", village: "里甲" }); pe(21, "子V", "桃園市", { ...V, status: "filed", sub: "平鎮區", village: "里乙" });
// V2 宜蘭縣：我方沒記村里（也沒記鄉鎮）→ no_unit
unit("u-v2", "宜蘭縣", { ...V, town: "宜蘭市" }); ro("u-v2", "宜蘭縣", "丑V", 1, { ...V, town: "宜蘭市", unit: "宜蘭縣|宜蘭市" });
pe(22, "丑V", "宜蘭縣", { ...V, status: "filed" });
// V3 台北市中山區：不同里各自從 1 起，寅V（里甲）與卯V（里乙）都是 1 號 → 都寫；
//    己V（里丙）鏡像也是 1 號，但里丙已有庚V 用 1 號 → duplicate_in_unit（按村里單位檢查）
unit("u-v3", "台北市", { ...V, town: "中山區" });
for (const [n, no] of [["寅V", 1], ["卯V", 1], ["己V", 1]] as const) ro("u-v3", "台北市", n, no, { ...V, town: "中山區", unit: "台北市|中山區" });
pe(23, "寅V", "台北市", { ...V, status: "filed", sub: "中山區", village: "里甲" }); pe(24, "卯V", "台北市", { ...V, status: "filed", sub: "中山區", village: "里乙" });
pe(26, "庚V", "台北市", { ...V, status: "filed", sub: "中山區", village: "里丙", no: 1 }); pe(27, "己V", "台北市", { ...V, status: "filed", sub: "中山區", village: "里丙" });

const WRITABLE = [1, 12, 17, 18, 23, 24]; // A、H、K 兩位、V3 兩位
const seedSql = (): string => {
  const out: string[] = [];
  for (const u of UNITS) {
    out.push(`INSERT INTO cec_roster_units (url, kind, election_type, county, town, status, fetched_at) VALUES ('${u.url}', 'C1', '${u.type}', '${u.county}', '${u.town ?? ""}', 'ok',
      now() - interval '${u.fresh ? "1 hour" : "5 days"}');`);
  }
  for (const r of ROS) {
    out.push(`INSERT INTO cec_roster_2026 (election_type, county, town, name, name_key, cand_no, unit_key, unit_url)
      VALUES ('${r.type}', '${r.county}', '${r.town ?? ""}', '${r.name}', roster_name_key('${r.name}'), ${r.no ?? "NULL"}, '${r.unit}', '${r.url}');`);
  }
  for (const p of PES) {
    out.push(`INSERT INTO politicians (id, name, region, merged_into) VALUES ('${U(p.id)}', '${p.name}', '${p.county}', ${p.merged ? `'${U(999)}'` : "NULL"});`);
    out.push(`INSERT INTO regions VALUES (${p.id}, '${p.county}', ${p.sub ? `'${p.sub}'` : "NULL"}, ${p.village ? `'${p.village}'` : "NULL"});`);
    out.push(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status, cand_no)
      VALUES (${p.id}, '${U(p.id)}', 2026, '${p.type ?? "縣市長"}', ${p.id}, '${p.status ?? "filed"}', ${p.no ?? "NULL"});`);
  }
  return out.join("\n");
};

const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
const snapshot = async (db: PGlite) => JSON.stringify(await rows(db, `SELECT id, candidacy_status, cand_no FROM politician_elections ORDER BY id`));

async function build(edit: (sql: string) => string = (s) => s, enable = true) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of ["activity_touch_updated_at", "activity_audit", "cec_name_norm", "ballot_number_unit"]) await db.exec(await latestFn(n, MIG));
  const rec = await readMig("20261020030100_roster_reconcile_match_fix.sql");
  await db.exec(fnText(rec, "roster_name_fold"));
  await db.exec(fnText(rec, "roster_name_key"));
  await db.exec(fnText(await readMig("20261031160000_cec_roster_2026.sql"), "cec_roster_norm_unit"));
  await db.exec(seedSql());
  const before = await snapshot(db);
  await db.exec(edit(await readMig(MIG)));
  const after = await snapshot(db);
  const defaultEnabled = (await rows<{ enabled: boolean }>(db, `SELECT enabled FROM cand_no_auto_settings WHERE id = 1`))[0].enabled;
  if (enable) await db.exec(`UPDATE cand_no_auto_settings SET enabled = true WHERE id = 1`);
  return { db, before, after, defaultEnabled };
}

const planOf = async (db: PGlite) =>
  rows<{ politician_election_id: number; action: string; reason: string | null; cand_no: number | null }>(db,
    `SELECT politician_election_id, action, reason, cand_no FROM cand_no_auto_plan() ORDER BY 1`);
const reasonOf = (p: Array<{ politician_election_id: number; reason: string | null }>, id: number) => p.find((x) => Number(x.politician_election_id) === id)?.reason;

Deno.test("計畫：唯一對上才寫，其餘各有原因碼；不該碰的人不在計畫裡", async () => {
  const { db } = await build();
  const p = await planOf(db);
  assertEquals(p.filter((x) => x.action === "write").map((x) => Number(x.politician_election_id)), WRITABLE);
  assertEquals(p.find((x) => Number(x.politician_election_id) === 1)!.cand_no, 3);
  assertEquals(p.find((x) => Number(x.politician_election_id) === 12)!.cand_no, 2, "臺西鄉＝台西鄉");
  assertEquals(reasonOf(p, 2), "ambiguous_ours");
  assertEquals(reasonOf(p, 3), "ambiguous_ours");
  assertEquals(reasonOf(p, 4), "ambiguous_roster");
  assertEquals(reasonOf(p, 5), "unit_not_fresh");
  assertEquals(reasonOf(p, 6), "duplicate_in_unit", "同單位已有人用 2 號");
  assertEquals(reasonOf(p, 8), "not_in_roster");
  assertEquals(reasonOf(p, 9), "roster_no_cand_no");
  assertEquals([reasonOf(p, 10), reasonOf(p, 11)], ["duplicate_in_unit", "duplicate_in_unit"], "同一輪兩位要寫同號次：都不寫");
  assertEquals(reasonOf(p, 16), "no_unit");
  // 村里長：同鄉鎮兩個里同名兩人不寫；我方沒村里不寫；不同里各自從 1 起都寫；同一個里已有人用這個號次不寫
  assertEquals([reasonOf(p, 20), reasonOf(p, 21)], ["ambiguous_ours", "ambiguous_ours"]);
  assertEquals(reasonOf(p, 22), "no_unit");
  assertEquals(p.filter((x) => [23, 24].includes(Number(x.politician_election_id))).map((x) => [x.action, x.cand_no]), [["write", 1], ["write", 1]]);
  assertEquals(reasonOf(p, 27), "duplicate_in_unit");
  for (const id of [7, 13, 14, 15, 26]) assert(!p.some((x) => Number(x.politician_election_id) === id), `pe${id} 不在計畫裡（有號次／退選／人物被併走）`);
  await db.close();
});

Deno.test("寫入：只補空白、每筆進 edit_history、留證據、一個 run；再跑一次不重寫；重複的記 skipped", async () => {
  const { db } = await build();
  const res = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cand_no_auto_apply() AS r`))[0].r;
  assertEquals(res.written, WRITABLE.length);
  const st = await rows<{ id: number; cand_no: number | null; candidacy_status: string }>(db, `SELECT id, cand_no, candidacy_status FROM politician_elections ORDER BY id`);
  const by = (id: number) => st.find((s) => Number(s.id) === id)!;
  assertEquals([by(1).cand_no, by(12).cand_no, by(17).cand_no, by(18).cand_no, by(23).cand_no, by(24).cand_no], [3, 2, 1, 2, 1, 1]);
  for (const id of [2, 3, 4, 5, 6, 8, 9, 10, 11, 16, 20, 21, 22, 27]) assertEquals(by(id).cand_no, null, `pe${id} 不該被寫`);
  assertEquals([by(7).cand_no, by(14).cand_no], [2, 9], "已有號次的不動");
  assertEquals(by(13).cand_no, null, "退選的不寫");
  const eh = await rows<{ record_id: string; field: string; old_value: unknown; new_value: unknown; agent_name: string; contribution_id: string | null }>(db,
    `SELECT record_id, field, old_value, new_value, agent_name, contribution_id FROM edit_history WHERE table_name = 'politician_elections' ORDER BY id`);
  assertEquals(eh.length, WRITABLE.length);
  assert(eh.every((e) => e.agent_name === "cand-no-auto" && e.contribution_id === null && e.field === "cand_no" && e.old_value === null));
  assertEquals(eh.find((e) => e.record_id === "1")!.new_value, 3);
  const log = await rows<{ politician_election_id: number; result: string; reason: string | null; roster_name: string; cand_no: number }>(db,
    `SELECT politician_election_id, result, reason, roster_name, cand_no FROM cand_no_auto_log ORDER BY 1`);
  assertEquals(log.filter((l) => l.result === "written").map((l) => Number(l.politician_election_id)), WRITABLE);
  assertEquals(log.filter((l) => l.result === "skipped").map((l) => [Number(l.politician_election_id), l.reason]), [[6, "duplicate_in_unit"], [10, "duplicate_in_unit"], [11, "duplicate_in_unit"], [27, "duplicate_in_unit"]]);
  assertEquals(log.find((l) => Number(l.politician_election_id) === 1)!.roster_name, "甲A");
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_runs`)).length, 1);
  // 再跑一次：沒有東西可寫、不留空 run、不重複寫履歷
  const again = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cand_no_auto_apply() AS r`))[0].r;
  assertEquals(again.written, 0);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'politician_elections'`)).length, WRITABLE.length);
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_runs`)).length, 1);
  // 狀態視圖
  const s = (await rows<{ pending: number; written: number; unresolved: number }>(db, `SELECT pending, written, unresolved FROM cand_no_auto_status`))[0];
  assertEquals([Number(s.pending), Number(s.written)], [0, WRITABLE.length]);
  assertEquals(Number(s.unresolved), 14);
  await db.close();
});

Deno.test("batch_limit：一輪最多寫這麼多位，分幾輪寫完", async () => {
  const { db } = await build();
  const first = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cand_no_auto_apply(2) AS r`))[0].r;
  assertEquals(first.written, 2);
  let guard = 0;
  while (guard++ < 10) {
    const r = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cand_no_auto_apply(2) AS r`))[0].r;
    if (r.written === 0) break;
  }
  assertEquals((await rows(db, `SELECT 1 FROM politician_elections WHERE id IN (1,12,17,18,23,24) AND cand_no IS NOT NULL`)).length, 6);
  await db.close();
});

Deno.test("開關：預設關；關著 plan 一列都不回、apply 不做事、乾跑照常算；設定修改進 edit_history", async () => {
  const { db, defaultEnabled } = await build((s) => s, false);
  assertEquals(defaultEnabled, false, "上線時預設關");
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_plan()`)).length, 0);
  assertEquals((await rows<{ r: Record<string, unknown> }>(db, `SELECT cand_no_auto_apply() AS r`))[0].r.skipped, "disabled");
  assertEquals((await rows(db, `SELECT 1 FROM politician_elections WHERE cand_no IS NOT NULL AND id NOT IN (7, 14, 26)`)).length, 0);
  const dry = (await rows<{ r: { dry_run: boolean; would_write: number; unresolved: Record<string, number>; by_type: Array<{ election_type: string; write: number }> } }>(db,
    `SELECT cand_no_auto_apply(NULL, true) AS r`))[0].r;
  assertEquals(dry.dry_run, true);
  assertEquals(Number(dry.would_write), WRITABLE.length);
  assertEquals(dry.unresolved.ambiguous_ours, 4);
  assertEquals(dry.unresolved.duplicate_in_unit, 4);
  assertEquals(dry.by_type.find((t) => t.election_type === "鄉鎮市長")!.write, 1);
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_runs`)).length, 0, "乾跑不留 run");
  assertEquals((await rows(db, `SELECT pending FROM cand_no_auto_status`))[0].pending, WRITABLE.length, "狀態視圖不看開關");
  await db.exec(`UPDATE cand_no_auto_settings SET enabled = true WHERE id = 1`);
  assert((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'cand_no_auto_settings' AND agent_name = 'activity-audit'`)).length >= 1);
  await db.close();
});

Deno.test("還原：只還原現值仍是它寫的（被改過的算 blocked）、自動關開關、被還原的之後不再寫", async () => {
  const { db } = await build();
  const run = Number((await rows<{ r: { run_id: number } }>(db, `SELECT cand_no_auto_apply() AS r`))[0].r.run_id);
  // 有人把 pe18 的號次改成 5（之後別人改過的不動）
  await db.exec(`UPDATE politician_elections SET cand_no = 5 WHERE id = 18`);
  const out = (await rows<{ r: { reverted: number; blocked: number; auto_disabled: boolean } }>(db, `SELECT cand_no_auto_revert(${run}, 'tester') AS r`))[0].r;
  assertEquals([out.reverted, out.blocked, out.auto_disabled], [5, 1, true]);
  const st = await rows<{ id: number; cand_no: number | null }>(db, `SELECT id, cand_no FROM politician_elections WHERE id IN (1, 12, 17, 18, 23, 24) ORDER BY id`);
  assertEquals(st.map((s) => s.cand_no), [null, null, null, 5, null, null], "別人改過的 pe18 不動");
  assertEquals((await rows<{ enabled: boolean }>(db, `SELECT enabled FROM cand_no_auto_settings`))[0].enabled, false);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE agent_name = 'cand-no-auto' AND reverted_at IS NOT NULL AND reverted_by = 'tester'`)).length, 5);
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_log WHERE result = 'reverted'`)).length, 5);
  let again = false;
  try { await db.query(`SELECT cand_no_auto_revert(${run})`); } catch { again = true; }
  assert(again, "同一個 run 不能還原兩次");
  // 重新打開：被還原的三位系統不再寫
  await db.exec(`UPDATE cand_no_auto_settings SET enabled = true WHERE id = 1`);
  const p = await planOf(db);
  for (const id of [1, 12, 17, 23, 24]) assert(!p.some((x) => Number(x.politician_election_id) === id), `pe${id} 被還原後系統不再寫`);
  await db.close();
});

Deno.test("migration 本身不改任何參選紀錄、不留 run", async () => {
  const { db, before, after } = await build();
  assertEquals(after, before);
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_runs`)).length, 0);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'politician_elections'`)).length, 0);
  await db.close();
});

Deno.test("還原驗證：拿掉任一道守門，對應情境要紅", async () => {
  // 單位 fresh
  {
    const { db } = await build((s) => s.split("u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'").join("u.status = 'ok'"));
    const p = await planOf(db);
    assert(p.find((x) => Number(x.politician_election_id) === 5)!.action === "write", "拿掉 fresh 判斷，不 fresh 的單位就會被寫（測試要抓得到）");
    await db.close();
  }
  // 我們同名多筆
  {
    // 只拿掉這一道：縣市長那案被「同輪同號次」備援蓋住（仍不寫，但原因碼變了）；村里長兩個里的號次單位不同，備援蓋不到，會寫出去
    const { db } = await build((s) => mutate(s, "WHEN oc.n > 1 THEN 'ambiguous_ours'", "WHEN false THEN 'ambiguous_ours'"));
    const p = await planOf(db);
    assert(p.find((x) => Number(x.politician_election_id) === 20)!.action === "write", "村里長同名兩人只靠 ambiguous_ours 守住");
    assert(reasonOf(p, 2) !== "ambiguous_ours");
    await db.close();
  }
  // 鏡像同名多筆
  {
    const { db } = await build((s) => mutate(s, "WHEN rc.n > 1 THEN 'ambiguous_roster'", "WHEN false THEN 'ambiguous_roster'"));
    const p = await planOf(db);
    assert(p.find((x) => Number(x.politician_election_id) === 4)!.action === "write");
    await db.close();
  }
  // 同單位已有人用這個號次
  {
    const { db } = await build((s) => mutate(s, "WHEN ud.n > 0 THEN 'duplicate_in_unit'", "WHEN false THEN 'duplicate_in_unit'"));
    const p = await planOf(db);
    assert(p.find((x) => Number(x.politician_election_id) === 6)!.action === "write");
    await db.close();
  }
  // 同一輪兩位要寫同號次
  {
    const { db } = await build((s) => mutate(s, "CASE WHEN count(*) OVER (PARTITION BY j.fu, j.rno) > 1 THEN 'duplicate_in_unit' END", "NULL"));
    const p = await planOf(db);
    assert(p.find((x) => Number(x.politician_election_id) === 10)!.action === "write");
    await db.close();
  }
});

Deno.test("不一致視圖：站上已有號次、鏡像唯一對上但號次不同的只列不寫；一致的、單位不 fresh 的不列；status 帶計數", async () => {
  const { db } = await build((s) => s, false); // 開關關著也看得到
  const m = await rows<{ politician_election_id: number; our_name: string; our_cand_no: number; roster_cand_no: number; roster_fetched_at: string | null; unit: string }>(db,
    `SELECT politician_election_id, our_name, our_cand_no, roster_cand_no, roster_fetched_at, unit FROM cand_no_auto_mismatch ORDER BY 1`);
  // pe14 寅M：站上 9、鏡像 2；pe7 己F 站上 2＝鏡像 2 → 一致，不列
  assertEquals(m.map((x) => [Number(x.politician_election_id), x.our_name, Number(x.our_cand_no), Number(x.roster_cand_no)]), [[14, "寅M", 9, 2]]);
  assert(m[0].roster_fetched_at !== null && m[0].unit === "新竹縣");
  assertEquals(Number((await rows<{ mismatch: number }>(db, `SELECT mismatch FROM cand_no_auto_status`))[0].mismatch), 1);
  // 只列不寫：打開開關跑一輪，站上的 9 不動、沒有 edit_history
  await db.exec(`UPDATE cand_no_auto_settings SET enabled = true WHERE id = 1`);
  await db.exec(`SELECT cand_no_auto_apply()`);
  assertEquals((await rows<{ cand_no: number }>(db, `SELECT cand_no FROM politician_elections WHERE id = 14`))[0].cand_no, 9);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE record_id = '14'`)).length, 0);
  // 單位超過 3 天沒抓成功就不列
  await db.exec(`UPDATE cec_roster_units SET fetched_at = now() - interval '5 days' WHERE url = 'u-hc'`);
  assertEquals((await rows(db, `SELECT 1 FROM cand_no_auto_mismatch`)).length, 0);
  await db.close();
});

Deno.test("兩個視圖不公開（anon／authenticated 讀不到）；還原與寫入搶同一把鎖", async () => {
  const { db } = await build();
  for (const v of ["cand_no_auto_mismatch", "cand_no_auto_status"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const ok = (await rows<{ ok: boolean }>(db, `SELECT has_table_privilege('${role}', '${v}', 'SELECT') AS ok`))[0].ok;
      assertEquals(ok, role === "service_role", `${v} 對 ${role}`);
    }
  }
  const src = fnText(await readMig(MIG), "cand_no_auto_revert");
  assert(src.includes("pg_advisory_xact_lock(hashtext('cand_no_auto_apply'))"), "revert 開頭拿 apply 同一把 advisory lock");
  await db.close();
});
