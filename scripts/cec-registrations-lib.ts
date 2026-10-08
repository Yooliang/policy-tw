/**
 * 產生 cec_registrations 的資料 migration 用的函式庫（給 scripts/gen-cec-registrations.ts 與 cec-registrations.test.ts 共用）。
 *
 * 地名切鄉鎮市區與村里用 admin_divisions（內政部官方行政區）的鄉鎮名單；名單直接從 repo 裡建表的 migration
 * 20261005000480_admin_divisions.sql 的資料段讀，產生腳本不需要連資料庫。
 */
import type { RosterRow } from "../supabase/functions/_shared/cec-roster.ts";
import {
  REGISTRATION_ELECTION_ID,
  ROSTER_SOURCES,
  ROSTER_TOTAL,
  toRegistrationRecords,
  type RegistrationRecord,
  type RosterSource,
  type TownIndex,
} from "../supabase/functions/_shared/cec-registrations.ts";

export const ADMIN_MIGRATION = new URL("../supabase/migrations/20261005000480_admin_divisions.sql", import.meta.url);

/** admin_divisions 的鄉鎮市區（level='town'）→ 縣市（臺→台）對應的鄉鎮名單，長的在前 */
export function townIndexFromMigration(sql: string): TownIndex {
  const byCounty = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/\('(\d{8})','town','\d{5}','([^']+)','([^']+)',NULL,/g)) {
    const county = m[2].replace(/臺/g, "台");
    if (!byCounty.has(county)) byCounty.set(county, new Set());
    byCounty.get(county)!.add(m[3]);
  }
  return new Map([...byCounty].map(([c, ts]) => [c, [...ts].sort((a, b) => b.length - a.length || a.localeCompare(b))]));
}

export async function readTownIndex(): Promise<TownIndex> {
  return townIndexFromMigration((await Deno.readTextFile(ADMIN_MIGRATION)).replace(/\r\n/g, "\n"));
}

export const DATA_MIGRATION_HEADER = `-- 中選會 115 年候選人登記彙總表九份的資料（cec_registrations 的內容；2026-10-08，10-08 缺口盤點 R1）
--
-- 由 scripts/gen-cec-registrations.ts 產生，不要手改。同一個 parser（_shared/cec-roster.ts 的 parseRoster）、
-- 同一個抽字法（unpdf 0.12.1，cecRosterText）解析中選會頁面 https://web.cec.gov.tw/central/article/64709 的九份 PDF，
-- 逐份核對人數等於 PDF 裡「登記日期」的列數（合計 19,695：縣市長 81、縣市議員 1,502、鄉鎮市長 465、鄉鎮市民代表 3,437、
-- 直轄市山地原住民區長 16、區民代表 94、村里長 14,100）；對不上整支 migration 失敗（最後一段的列數檢查）。
-- 縣市議員（其餘 16 縣市）另收舊版 729644ff-…（verification_sources 登錄的網址，892 列）：它跟現行版 9ccb6224-… 只差一個字
-- （彰化縣第 08 選舉區「洪健興」→「洪建興」，中選會更正姓名），引用哪一版的交件 roster_batch 都查得到表；舊版標 superseded_by，算缺口看現行版。
-- 異常列照收並在 flags 標出來：姓名欄在 PDF 裡是空的（罕用字抽不出來，name_empty，21 列）、村里欄是空的（village_empty，6 列）。
-- 只加資料，**不碰任何人物或參選紀錄**（資料走流程）。重跑不會重複（ON CONFLICT DO NOTHING）。`;

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const qn = (s: string | null) => (s == null ? "NULL" : q(s));

export interface ParsedSource { source: RosterSource; rows: RosterRow[]; records: RegistrationRecord[] }

export const CHUNK_ROWS = 1000;

/** 一份名冊的 INSERT（每 1,000 列一個陳述式；網址、選舉別、屆別每個陳述式只寫一次） */
export function renderSourceInserts(p: ParsedSource, parsedAt: string): string {
  const out: string[] = [`-- ${p.source.election_type}：${p.source.label}（${p.records.length} 位）${p.source.url}`];
  for (let i = 0; i < p.records.length; i += CHUNK_ROWS) {
    const chunk = p.records.slice(i, i + CHUNK_ROWS);
    const tuples = chunk.map((r) =>
      `(${q(r.region)},${qn(r.place)},${qn(r.sub_region)},${qn(r.village)},${qn(r.district)},${q(r.name)},${q(r.party)},${r.row_no},${q(r.flags.join(","))})`
    );
    out.push(
      `INSERT INTO cec_registrations (election_id, election_type, region, place, sub_region, village, district, name, party, row_no, source_url, flags, parsed_at)\n` +
      `SELECT ${REGISTRATION_ELECTION_ID}, ${q(p.source.election_type)}, v.region, v.place, v.sub_region, v.village, v.district, v.name, v.party, v.row_no, ${q(p.source.url)},\n` +
      `       COALESCE(string_to_array(NULLIF(v.flags, ''), ','), '{}'), timestamptz ${q(parsedAt)}\n` +
      `  FROM (VALUES\n${tuples.join(",\n")}\n) AS v(region, place, sub_region, village, district, name, party, row_no, flags)\n` +
      `ON CONFLICT (source_url, row_no) DO NOTHING;`,
    );
  }
  return out.join("\n");
}

/** 資料 migration 全文。parsedAt＝這次解析 PDF 的時間（ISO） */
export function renderDataMigration(parsed: readonly ParsedSource[], parsedAt: string, header: string): string {
  const total = parsed.filter((p) => !p.source.superseded_by).reduce((n, p) => n + p.records.length, 0);
  const allRows = parsed.reduce((n, p) => n + p.records.length, 0);
  const srcRows = parsed.map((p) =>
    `  (${q(p.source.url)}, ${REGISTRATION_ELECTION_ID}, ${q(p.source.election_type)}, ${q(p.source.label)}, ${p.records.length}, ${qn(p.source.superseded_by ?? null)}, timestamptz ${q(parsedAt)})`
  );
  const guard = parsed.map((p) => `    (${q(p.source.url)}, ${p.records.length})`).join(",\n");
  const check = [
    "DO $guard$",
    "DECLARE bad TEXT;",
    "BEGIN",
    "  SELECT string_agg(g.source_url || ' 預期 ' || g.expected || ' 實際 ' || COALESCE(a.n, 0), ', ') INTO bad",
    "    FROM (VALUES",
    guard,
    "    ) AS g(source_url, expected)",
    "    LEFT JOIN (SELECT source_url, count(*) AS n FROM cec_registrations GROUP BY 1) a ON a.source_url = g.source_url",
    "   WHERE COALESCE(a.n, 0) <> g.expected;",
    "  IF bad IS NOT NULL THEN RAISE EXCEPTION 'cec_registrations 列數對不上：%', bad; END IF;",
    `  IF (SELECT count(*) FROM cec_registrations WHERE election_id = ${REGISTRATION_ELECTION_ID}) <> ${allRows} THEN`,
    `    RAISE EXCEPTION 'cec_registrations 合計不是 ${allRows}';`,
    "  END IF;",
    `  IF (SELECT count(*) FROM cec_registrations r JOIN cec_registration_sources s USING (source_url) WHERE s.superseded_by IS NULL) <> ${total} THEN`,
    `    RAISE EXCEPTION 'cec_registrations 現行版合計不是 ${total}';`,
    "  END IF;",
    "END",
    "$guard$;",
  ].join("\n");
  return [
    header,
    `INSERT INTO cec_registration_sources (source_url, election_id, election_type, label, row_count, superseded_by, parsed_at) VALUES\n${srcRows.join(",\n")}\nON CONFLICT (source_url) DO NOTHING;`,
    ...parsed.map((p) => renderSourceInserts(p, parsedAt)),
    // 全有或全無：任何一份的列數對不上就整支 migration 失敗（交易回滾），不會留下半張表
    check,
    "ANALYZE cec_registrations;",
    "",
  ].join("\n\n");
}

export { ROSTER_SOURCES, ROSTER_TOTAL, toRegistrationRecords };
