/**
 * 把中選會 115 年候選人登記彙總表九份（web.cec.gov.tw/central/article/64709）解析成 cec_registrations 的資料 migration。
 *
 *   deno run -A scripts/gen-cec-registrations.ts [--out supabase/migrations/20261008130100_cec_registrations_data.sql] [--parsed-at 2026-10-08T05:00:00Z]
 *   deno run -A scripts/gen-cec-registrations.ts --offline --check      # 用 fixtures 的抽字原文重產一遍，跟已提交的 migration 比（CI 的測試也做這件事）
 *
 * 跟 roster_batch 用同一個 parser（_shared/cec-roster.ts 的 parseRoster）與同一個抽字法（cecRosterText＝unpdf 0.12.1 mergePages），
 * 只差本機放寬了 3 MB 的大小上限（村里長那份 7.5 MB）。逐份核對：解析人數必須等於 ROSTER_SOURCES 的 expected
 * （PDF 裡「登記日期」的個數＝一列一位），合計 19,695；對不上就停，不寫檔。
 *
 * 名冊更新（11/17 公告後的新版、補件）：新的網址是新的一份，加進 ROSTER_SOURCES、用新的 migration 灌；舊網址的資料保留，
 * roster_batch 按交件引用的網址查，不會互相覆蓋。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { cecRosterText, parseRoster } from "../supabase/functions/_shared/cec-roster.ts";
import { ROSTER_SOURCES, ROSTER_TOTAL, toRegistrationRecords } from "../supabase/functions/_shared/cec-registrations.ts";
import { DATA_MIGRATION_HEADER, readTownIndex, renderDataMigration, type ParsedSource } from "./cec-registrations-lib.ts";

const args = new Map<string, string>();
const flags = new Set<string>();
for (let i = 0; i < Deno.args.length; i++) {
  const a = Deno.args[i];
  if (!a.startsWith("--")) continue;
  const next = Deno.args[i + 1];
  if (next && !next.startsWith("--")) { args.set(a, next); i++; } else flags.add(a);
}
const offline = flags.has("--offline");
const check = flags.has("--check");
const out = args.get("--out") ?? "supabase/migrations/20261008130100_cec_registrations_data.sql";
const parsedAt = args.get("--parsed-at") ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const FIXTURES = new URL("../supabase/functions/_shared/fixtures/", import.meta.url);
// 本機抽字放寬到 20 MB（村里長 7.5 MB）；Edge 上仍是 ROSTER_MAX_BYTES
const LOCAL_MAX_BYTES = 20_000_000;

async function parseSource(s: typeof ROSTER_SOURCES[number]): Promise<ParsedSource["rows"]> {
  const text = offline
    ? (await Deno.readTextFile(new URL(s.fixture, FIXTURES))).replace(/\r\n/g, "\n")
    : await cecRosterText(s.url, fetch, LOCAL_MAX_BYTES);
  return parseRoster(text);
}

const towns = await readTownIndex();
const parsed: ParsedSource[] = [];
for (const s of ROSTER_SOURCES) {
  const rows = await parseSource(s);
  const dates = (offline ? await Deno.readTextFile(new URL(s.fixture, FIXTURES)) : "").match(/\d{3}\/\d{2}\/\d{2}/g)?.length;
  if (dates !== undefined) assertEquals(dates, s.expected, `${s.label}：fixture 的日期數不是 ${s.expected}`);
  assertEquals(rows.length, s.expected, `${s.label}：解析出 ${rows.length} 位，預期 ${s.expected}`);
  const records = toRegistrationRecords(s, rows, towns);
  console.error(`${s.label}\t${records.length}\t異常 ${records.filter((r) => r.flags.length).length}`);
  parsed.push({ source: s, rows, records });
}
// 合計 19,695 指現行九份；舊版（superseded_by）另收，不算
assertEquals(parsed.filter((p) => !p.source.superseded_by).reduce((n, p) => n + p.records.length, 0), ROSTER_TOTAL);
assertEquals(ROSTER_TOTAL, 19_695);

if (!offline) {
  // 抽字原文跟 fixtures 一致：測試（離線）用 fixtures 重產，要跟線上現在的 PDF 產出同一份資料
  for (const p of parsed) {
    const fx = parseRoster((await Deno.readTextFile(new URL(p.source.fixture, FIXTURES))));
    assertEquals(JSON.stringify(fx), JSON.stringify(p.rows), `${p.source.label}：fixture 跟線上 PDF 現在抽出來的不一樣（${p.source.fixture} 該更新）`);
  }
  console.error("fixtures 跟線上 PDF 逐列相同");
}

const sql = renderDataMigration(parsed, parsedAt, DATA_MIGRATION_HEADER);
if (check) {
  const existing = (await Deno.readTextFile(out)).replace(/\r\n/g, "\n");
  const stamp = /timestamptz '([^']+)'/.exec(existing)?.[1];
  const again = stamp ? renderDataMigration(parsed, stamp, DATA_MIGRATION_HEADER) : sql;
  if (again !== existing) { console.error("已提交的 migration 跟重新產生的不一樣"); Deno.exit(1); }
  console.error("一致");
} else {
  await Deno.writeTextFile(out, sql);
  console.error(`寫入 ${out}（${(sql.length / 1e6).toFixed(2)} MB）`);
}
