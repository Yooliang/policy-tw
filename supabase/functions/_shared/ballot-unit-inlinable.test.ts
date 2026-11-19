/**
 * ballot_number_unit 改成可展開的純運算式（#981，migration 20261119190000_ballot_unit_inlinable.sql）。
 *   ① 文字層：新定義是單一 SELECT CASE、沒有子查詢（有子查詢 SQL 函式就不能被規劃器展開）、仍是 IMMUTABLE
 *   ② PGlite：舊定義（20261009070000）與新定義對一整排代表性輸入逐列回傳相同（含 NULL、臺→台、第4＝第04、鄉鎮與選舉區矛盾）
 * 只要 --allow-read。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const OLD_MIG = "20261009070000_rep_district_ballot_unit.sql";
const NEW_MIG = "20261119190000_ballot_unit_inlinable.sql";
const oldDef = fnText(await readMig(OLD_MIG), "ballot_number_unit");
const stripComments = (s: string) => s.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("--")).join(String.fromCharCode(10));
const newDef = fnText(await readMig(NEW_MIG), "ballot_number_unit");
const newCode = stripComments(newDef);

Deno.test("I1 新定義無子查詢、單一 SELECT、IMMUTABLE", () => {
  assert(/IMMUTABLE/.test(newDef), "必須是 IMMUTABLE");
  assertEquals(newCode.match(/\bSELECT\b/gi)?.length, 1, "只能有最外層一個 SELECT（不可有子查詢）");
  assert(!/\bFROM\b/i.test(newCode), "不可有 FROM（子查詢會讓函式無法展開）");
  assert(/LANGUAGE sql/i.test(newDef), "必須是 SQL 函式");
  // 舊定義確實有子查詢，證明這個守門抓得到問題
  assert(/\bFROM\s*\(\s*SELECT\b/i.test(oldDef), "舊定義應含子查詢");
});

Deno.test("I2 新舊定義對代表性輸入逐列相同", async () => {
  const db = new PGlite();
  await db.exec(oldDef.replace("ballot_number_unit(", "ballot_number_unit_old("));
  await db.exec(newDef);
  const T = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "村里長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "立法委員", "", null];
  const C = [null, "", " ", "臺北市", "彰化縣", "連江縣"];
  const D = [null, "", "第1選舉區", "第01選舉區", "第 02 選舉區", "第00選舉區", "二林鎮第01選舉區", "二林鎮第4選舉區", "大城鄉第01選舉區", "臺西鄉第03選舉區", "選舉區", "第1選舉區X"];
  const TW = [null, "", "二林鎮", "二林鎮第01選舉區", "臺西鄉", "大城鄉", "第01選舉區"];
  const V = [null, "", "中山里", "臺中里"];
  const q = (x: string | null) => (x === null ? "NULL" : `'${x.replaceAll("'", "''")}'`);
  const vals: string[] = [];
  for (const t of T) for (const c of C) for (const d of D) for (const tw of TW) for (const v of V) vals.push(`(${q(t)},${q(c)},${q(d)},${q(tw)},${q(v)})`);
  const r = await db.query<{ n: number; diff: number }>(
    `SELECT count(*)::int n, count(*) FILTER (WHERE ballot_number_unit(t,c,d,tw,v) IS DISTINCT FROM ballot_number_unit_old(t,c,d,tw,v))::int diff FROM (VALUES ${vals.join(",")}) q(t,c,d,tw,v)`);
  assert(r.rows[0].n > 5000);
  assertEquals(r.rows[0].diff, 0);
  const nn = await db.query<{ n: number }>(`SELECT count(*)::int n FROM (VALUES ${vals.join(",")}) q(t,c,d,tw,v) WHERE ballot_number_unit(t,c,d,tw,v) IS NOT NULL`);
  assert(nn.rows[0].n > 100, "輸入組合要有足夠的非 NULL 結果，否則比對沒意義");
  await db.close();
});
