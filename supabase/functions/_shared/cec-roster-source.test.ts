/**
 * 名冊來源選擇（2026-10-31，migration 20261031160000 的 source 段）的守門：
 * 派工判準（roster_reconcile_units.needs_agent）、系統自動建人物（roster_reconcile_next）與名冊對帳（roster_reconcile_rows）
 * 該單位有 3 天內成功抓取的中選會 JSON 鏡像時用 cec_roster_2026，沒有（或過期）才退回 9 月登記彙總表；村里長 JSON 沒有村里名，系統建人物仍用登記彙總表。
 * 還原驗證：拿掉鏡像優先（共用函式回空），這裡的測試必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { mutate, readMig } from "./arms-pglite.ts";
import { addOurs, buildReconcileDb, loadRegs, reconcile } from "./roster-reconcile-pglite.ts";

const MIG = await readMig("20261031160000_cec_roster_2026.sql");
const sec = (sql: string, name: string) => {
  const a = sql.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`);
  const b = sql.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`);
  assert(a >= 0 && b > a, name);
  return sql.slice(a, b).replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");
};
const JSON_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/T/63000.json";
const V_URL = "https://info.cec.gov.tw/vote2026/static/json/cand/V1/63000/63000110.json";

async function build(edit: (s: string) => string = (s) => s): Promise<PGlite> {
  const { db } = await buildReconcileDb();
  const m = edit(MIG);
  await db.exec(sec(m, "tables"));
  await db.exec(sec(m, "source"));
  await db.exec(sec(m, "rows"));
  // 登記彙總表（PDF）
  await loadRegs(db, [
    { type: "縣市議員", region: "台北市", name: "王一", district: "第01選舉區" },   // 我們有
    { type: "縣市議員", region: "台北市", name: "孫二", district: "第01選舉區" },   // 只有 PDF 有（JSON 沒有＝退選）
    { type: "縣市議員", region: "台北市", name: "趙六", district: "第01選舉區" },   // 同名兩位，只在 PDF → 派代理
    { type: "縣市議員", region: "台北市", name: "趙六", district: "第01選舉區" },
    { type: "縣市議員", region: "花蓮縣", name: "李三" },                            // 花蓮沒有鏡像：照舊用 PDF
    { type: "村里長", region: "台北市", sub: "士林區", village: "甲里", name: "村甲" },   // 村里長：系統建人物仍用 PDF
  ]);
  await addOurs(db, { name: "王一", type: "縣市議員", status: "filed", region: "台北市", sub: "第01選舉區" });
  return db;
}
async function mirror(db: PGlite, opts: { fetchedAt?: string } = {}) {
  const ins = async (url: string, kind: string, type: string, county: string, town: string, rows: { name: string; no: number; area?: string; town?: string }[]) => {
    await db.query(`INSERT INTO cec_roster_units (url, kind, election_type, county, county_code, town, town_code, status, row_count, fetched_at)
                    VALUES ($1, $2, $3, $4, '63000', $5, '', 'ok', $6, COALESCE($7::timestamptz, now()))`, [url, kind, type, county, town, rows.length, opts.fetchedAt ?? null]);
    for (const r of rows) {
      await db.query(`INSERT INTO cec_roster_2026 (election_type, county_code, county, town_code, town, district, area_code, li_code, name, name_key, cand_no, party, unit_key, unit_url)
                      VALUES ($1, '63000', $2, '', $3, '', $4, '', $5, roster_name_key($5), $6, '無', '', $7)`, [type, county, r.town ?? town, r.area ?? "", r.name, r.no, url]);
    }
  };
  await ins(JSON_URL, "T", "縣市議員", "臺北市", "", [{ name: "王一", no: 1, area: "01" }, { name: "錢四", no: 2, area: "01" }]);
  await ins(V_URL, "V1", "村里長", "臺北市", "士林區", [{ name: "村乙", no: 1 }]);
}
const unit = async (db: PGlite, county = "台北市") =>
  (await db.query<{ needs_agent: boolean; total: number; creatable_n: number }>(
    `SELECT needs_agent, total, creatable_n FROM roster_reconcile_units WHERE election_type = '縣市議員' AND county = $1`, [county])).rows[0];
const names = (rows: { election_type: string; county: string; name: string }[], type: string, county: string) =>
  rows.filter((r) => r.election_type === type && r.county === county).map((r) => r.name).sort();

Deno.test("沒有鏡像：全部照登記彙總表（孫二唯一可建、趙六同名多位要派代理）", async () => {
  const db = await build();
  await db.query(`SELECT roster_reconcile_refresh_units()`);
  const rows = await reconcile(db);
  assertEquals(names(rows, "縣市議員", "台北市"), ["孫二", "王一", "趙六", "趙六"].sort());
  assertEquals((await unit(db))!.needs_agent, true);
});

Deno.test("有鏡像的單位：名冊、派工判準、可建的人都改用 JSON；沒有鏡像的單位照舊", async () => {
  const db = await build();
  await mirror(db);
  await db.query(`SELECT roster_reconcile_refresh_units()`);
  const rows = await reconcile(db);
  assertEquals(names(rows, "縣市議員", "台北市"), ["王一", "錢四"]);                       // PDF 獨有的孫二、趙六不再出現
  const q = rows.find((r) => r.name === "錢四")!;
  assertEquals(q.category, "missing_creatable");
  assert(Number(q.reg_id) < 0, "鏡像列的 reg_id 是穩定的負數");
  const u = (await unit(db))!;
  assertEquals([u.needs_agent, u.total, u.creatable_n], [false, 2, 1]);                  // 趙六同名多位的「要派代理」不見了 → 臂不派
  assertEquals((await db.query<{ source_url: string }>(`SELECT source_url FROM roster_reconcile_next(100) WHERE name = '錢四'`)).rows[0].source_url, JSON_URL);
  assertEquals(names(rows, "縣市議員", "花蓮縣"), ["李三"]);                              // 花蓮沒有鏡像：照舊
  // 村里長：系統建人物要村里名，JSON 沒有，仍用登記彙總表
  assertEquals(names(rows, "村里長", "台北市"), ["村甲"]);
});

Deno.test("鏡像過期（超過 3 天）退回登記彙總表；reg_id 跨天穩定", async () => {
  const stale = await build();
  await mirror(stale, { fetchedAt: "2020-01-01T00:00:00Z" });
  assertEquals(names(await reconcile(stale), "縣市議員", "台北市"), ["孫二", "王一", "趙六", "趙六"].sort());
  const db = await build();
  await mirror(db);
  const id1 = (await reconcile(db)).find((r) => r.name === "錢四")!.reg_id;
  await db.exec(`DELETE FROM cec_roster_2026 WHERE unit_url = '${JSON_URL}'`);   // 模擬隔天整檔重抓：列 id 全換新
  await db.exec(`INSERT INTO cec_roster_2026 (election_type, county_code, county, town_code, town, district, area_code, li_code, name, name_key, cand_no, party, unit_key, unit_url)
                 SELECT '縣市議員', '63000', '臺北市', '', '', '', '01', '', n, roster_name_key(n), c, '無', '', '${JSON_URL}' FROM (VALUES ('王一', 1), ('錢四', 2)) AS v(n, c)`);
  assertEquals((await reconcile(db)).find((r) => r.name === "錢四")!.reg_id, id1);
});

Deno.test("還原驗證：拿掉鏡像優先（共用函式回空），名冊與派工判準都退回登記彙總表", async () => {
  const db = await build((s) => mutate(s, "WHERE u.status = 'ok' AND u.row_count > 0 AND u.fetched_at > now() - INTERVAL '3 days'", "WHERE false AND u.row_count > 0"));
  await mirror(db);
  await db.query(`SELECT roster_reconcile_refresh_units()`);
  const rows = await reconcile(db);
  assert(names(rows, "縣市議員", "台北市").includes("趙六"), "鏡像優先被拿掉時，PDF 的趙六應該回來（這個斷言在正式版會是假）");
  assertEquals((await unit(db))!.needs_agent, true);
});
