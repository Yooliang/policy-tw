/**
 * 中選會登記彙總表九份的資料表（cec_registrations；2026-10-08，10-08 缺口盤點 R1）的守門測試。
 *
 * 守的是三件「改掉了不會報錯、只是悄悄判錯」的事：
 *   1. 資料：migration 灌進 PGlite 的筆數、各類人數、逐列內容＝同一個 parser 對抽字原文（fixtures）解出來的；合計 19,695
 *   2. roster_batch：checkBatch 讀表與讀 PDF（parseRoster）的結果逐件一致——通過、不通過、不通過的原因全部一樣
 *   3. 名單缺口（roster_registration_gap）：不同鄉鎮的同名者不互相抵銷、舊版名冊不重複算、臺／台不分、有紀錄就不是缺
 * 每一組都有「還原驗證」：把被守的東西拿掉，確認測試會紅（標記字串必須剛好出現一次）。
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { checkBatch, parseRoster, type BatchItem, type RosterRow } from "./cec-roster.ts";
import {
  FLAG_NAME_EMPTY,
  FLAG_PLACE_UNMATCHED,
  FLAG_VILLAGE_EMPTY,
  loadRegistrationRows,
  registrationToRosterRow,
  ROSTER_SOURCES,
  ROSTER_TOTAL,
  splitPlace,
  toRegistrationRecords,
  type RegistrationRecord,
} from "./cec-registrations.ts";
import { mutate, readMig } from "./arms-pglite.ts";
import { buildRegistrationsDb, DATA_MIG, SCHEMA_MIG } from "./cec-registrations-pglite.ts";
import { ROSTER_CEC_GAP_HINT, ROSTER_GAP_LIMIT, ROSTER_REGISTRATION_GAP_HINT, shapeTaskCurrent } from "./task-context.ts";
import { readTownIndex, renderDataMigration, type ParsedSource } from "../../../scripts/cec-registrations-lib.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

const towns = await readTownIndex();
const fixtureText = async (f: string) => (await Deno.readTextFile(new URL(f, FIXTURES))).replace(/\r\n/g, "\n");

// ── 期望值：同一個 parser 對抽字原文解出來的（不經過 migration） ─────────────
const parsed: ParsedSource[] = [];
for (const s of ROSTER_SOURCES) {
  const rows = parseRoster(await fixtureText(s.fixture));
  parsed.push({ source: s, rows, records: toRegistrationRecords(s, rows, towns) });
}
const current = parsed.filter((p) => !p.source.superseded_by);

// ── PGlite：表、函式（真的 migration）＋ 最小的人物表（見 cec-registrations-pglite.ts）──
const buildDb = buildRegistrationsDb;

const db = await buildDb();

// ── 1. 資料 ────────────────────────────────────────────────────────────
Deno.test("九份現行版合計 19,695，逐份人數等於 PDF 的登記日期列數", async () => {
  assertEquals(ROSTER_TOTAL, 19_695);
  assertEquals(current.length, 9);
  for (const p of current) {
    const dates = (await fixtureText(p.source.fixture)).match(/\d{3}\/\d{2}\/\d{2}/g)?.length;
    assertEquals(dates, p.source.expected, `${p.source.label}：fixture 的日期數`);
    assertEquals(p.records.length, p.source.expected, `${p.source.label}：解析人數`);
  }
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM cec_registrations r JOIN cec_registration_sources s USING (source_url) WHERE s.superseded_by IS NULL",
  );
  assertEquals(r.rows[0].n, 19_695);
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM cec_registrations")).rows[0].n, 19_695 + 892);
});

Deno.test("各類人數（視圖 cec_registration_totals）：縣市長 81、縣市議員 1,502、鄉鎮市長 465、鄉鎮市民代表 3,437、區長 16、區民代表 94、村里長 14,100", async () => {
  const r = await db.query<{ election_type: string; sources: number; registered: number; flagged: number }>(
    "SELECT election_type, sources::int, registered::int, flagged::int FROM cec_registration_totals ORDER BY election_type",
  );
  const got = Object.fromEntries(r.rows.map((x) => [x.election_type, [x.sources, x.registered, x.flagged]]));
  assertEquals(got, {
    "縣市長": [2, 81, 0],
    "縣市議員": [2, 1502, 0],
    "鄉鎮市長": [1, 465, 0],
    "鄉鎮市民代表": [1, 3437, 3],
    "直轄市山地原住民區長": [1, 16, 0],
    "直轄市山地原住民區民代表": [1, 94, 0],
    "村里長": [1, 14100, 24],
  });
});

Deno.test("異常列照收並標記：姓名空白 21 列（鄉鎮市民代表 3、村里長 18）、村里長村里欄空白 6 列；沒有認不出鄉鎮的", async () => {
  const flags = await db.query<{ f: string; n: number }>("SELECT f, count(*)::int AS n FROM (SELECT unnest(flags) AS f FROM cec_registrations WHERE source_url IN (SELECT source_url FROM cec_registration_sources WHERE superseded_by IS NULL)) x GROUP BY 1 ORDER BY 1");
  assertEquals(Object.fromEntries(flags.rows.map((x) => [x.f, x.n])), { [FLAG_NAME_EMPTY]: 21, [FLAG_VILLAGE_EMPTY]: 6 });
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cec_registrations WHERE '${FLAG_PLACE_UNMATCHED}' = ANY(flags)`)).rows[0].n, 0);
  // 姓名空白的列 name_key 是 NULL（不會對上任何人）
  assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM cec_registrations WHERE name = '' AND name_key IS NULL")).rows[0].n, 21);
});

Deno.test("migration 灌進去的每一列＝同一個 parser 對抽字原文解出來的（十份逐列、逐欄）", async () => {
  for (const p of parsed) {
    const r = await db.query<Record<string, unknown>>(
      "SELECT election_id, election_type, region, place, sub_region, village, district, name, party, row_no, source_url, flags FROM cec_registrations WHERE source_url = $1 ORDER BY row_no",
      [p.source.url],
    );
    assertEquals(r.rows.length, p.records.length, p.source.label);
    assertEquals(JSON.stringify(r.rows), JSON.stringify(p.records.map((x: RegistrationRecord) => ({
      election_id: x.election_id, election_type: x.election_type, region: x.region, place: x.place, sub_region: x.sub_region, village: x.village,
      district: x.district, name: x.name, party: x.party, row_no: x.row_no, source_url: x.source_url, flags: x.flags,
    }))), `${p.source.label}：表裡的內容跟 parseRoster 的輸出不一樣`);
  }
});

Deno.test("產生腳本的輸出＝已提交的 migration（用 fixtures 離線重產；parsed_at 取檔案裡那一個）", async () => {
  const committed = await readMig(DATA_MIG);
  const stamp = /timestamptz '([^']+)'/.exec(committed)![1];
  const header = committed.slice(0, committed.indexOf("\n\nINSERT INTO cec_registration_sources"));
  assertEquals(renderDataMigration(parsed, stamp, header), committed);
});

Deno.test("村里長地名切鄉鎮市區與村里：用官方鄉鎮名單取最長前綴（板橋區鄉雲里、台西鄉台西村、大安區缺村里）", () => {
  assertEquals(splitPlace("村里長", "新北市", "板橋區鄉雲里", towns), { sub_region: "板橋區", village: "鄉雲里", unmatched: false });
  assertEquals(splitPlace("村里長", "桃園市", "平鎮區雙連里", towns), { sub_region: "平鎮區", village: "雙連里", unmatched: false });
  // 官方寫「臺西鄉」，名冊抽字出來是「台西鄉」：sub_region 存官方寫法，village 是名冊原樣
  assertEquals(splitPlace("村里長", "雲林縣", "台西鄉台西村", towns), { sub_region: "臺西鄉", village: "台西村", unmatched: false });
  assertEquals(splitPlace("村里長", "台中市", "大安區", towns), { sub_region: "大安區", village: null, unmatched: false });
  assertEquals(splitPlace("鄉鎮市長", "台東縣", "台東市", towns), { sub_region: "臺東市", village: null, unmatched: false });
  assertEquals(splitPlace("縣市議員", "台北市", null, towns), { sub_region: null, village: null, unmatched: false });
  assertEquals(splitPlace("村里長", "台北市", "不存在區某里", towns).unmatched, true);
});

Deno.test("資料表只有公開唯讀：RLS 開著、只有 SELECT 的 policy；健康檢查視圖是空的", async () => {
  const sql = await readMig(SCHEMA_MIG);
  for (const t of ["cec_registrations", "cec_registration_sources"]) {
    assert(sql.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), `${t} 沒開 RLS`);
    assert(new RegExp(`CREATE POLICY ${t}_read ON ${t} FOR SELECT USING \\(true\\);`).test(sql), `${t} 沒有公開唯讀 policy`);
  }
  assertEquals(/CREATE POLICY[^;]+FOR (INSERT|UPDATE|DELETE|ALL)/.test(sql), false, "不該有任何寫入的 policy");
  assertEquals((await db.query("SELECT * FROM cec_registration_drift")).rows.length, 0);
});

Deno.test("資料 migration 結尾有列數檢查：任何一份對不上整支失敗（全有或全無）", async () => {
  const sql = await readMig(DATA_MIG);
  assert(sql.includes("RAISE EXCEPTION 'cec_registrations 列數對不上"));
  assert(sql.includes("RAISE EXCEPTION 'cec_registrations 現行版合計不是 19695'"));
  // 登記的列數改成 24（實際灌 23 列）：檢查要失敗，整支 migration 回滾
  const bad = sql.replace(/('https:\/\/web\.cec\.gov\.tw\/api\/file\/bb9a8d7a[^']+', )23\)/, "$124)");
  assertNotEquals(bad, sql);
  const d = await buildDb({ withData: false });
  let msg = "";
  try { await d.exec(bad); } catch (e) { msg = String(e); }
  assert(msg.includes("列數對不上"), `應該因列數檢查失敗，實際：${msg.slice(0, 120)}`);
});

// ── 2. checkBatch 讀表與讀 PDF 一致 ─────────────────────────────────────
type Item = BatchItem;
/** 從名冊的一列造交件：照 roster_batch 的 payload 形狀（議員有選區；鄉鎮市長、代表、村里長有 sub_region、村里長有 village） */
function itemOf(id: string, r: RosterRow, type: string): Item {
  const town = type === "村里長" ? (splitPlace(type, r.region!, r.place ?? null, towns)) : null;
  return {
    id, name: r.name, party: r.party, region: r.region,
    district: r.district ?? null,
    sub_region: type === "村里長" ? town!.sub_region : (r.place ?? null),
    village: type === "村里長" ? town!.village : null,
  };
}
/** 每份名冊的測試批次：每 7 列取一位（通過），加上改政黨、改縣市、改鄉鎮、改選區、不存在的姓名各一批（不通過） */
function batchFor(p: ParsedSource): Item[] {
  const t = p.source.election_type;
  const items: Item[] = [];
  p.rows.forEach((r, i) => { if (i % 7 === 0 && r.name) items.push(itemOf(`ok-${i}`, r, t)); });
  p.rows.forEach((r, i) => {
    if (i % 97 !== 3 || !r.name) return;
    const base = itemOf(`x-${i}`, r, t);
    items.push({ ...base, id: `party-${i}`, party: r.party === "無" ? "中國國民黨" : "無" });
    items.push({ ...base, id: `region-${i}`, region: r.region === "台北市" ? "高雄市" : "台北市" });
    if (base.sub_region) items.push({ ...base, id: `town-${i}`, sub_region: "不存在區" });
    if (base.village) items.push({ ...base, id: `village-${i}`, village: "不存在里" });
    if (base.district) items.push({ ...base, id: `district-${i}`, district: "第99選舉區" });
    items.push({ ...base, id: `name-${i}`, name: "不在名冊上的人" });
  });
  // 空白姓名的列不該讓任何人通過
  return items;
}

Deno.test("checkBatch：讀表（逐列取出再轉成 RosterRow）與讀 PDF（parseRoster）的結果逐件一致，十份全部", async () => {
  for (const p of parsed) {
    const fromPdf = p.rows;
    const r = await db.query<{ name: string; party: string; region: string; district: string | null; place: string | null }>(
      "SELECT name, party, region, district, place FROM cec_registrations WHERE source_url = $1 ORDER BY row_no", [p.source.url],
    );
    const fromTable = r.rows.map(registrationToRosterRow);
    assertEquals(JSON.stringify(fromTable), JSON.stringify(fromPdf), `${p.source.label}：RosterRow 不一樣`);
    const batch = batchFor(p);
    assert(batch.length >= 5, `${p.source.label}：測試批次太少 ${batch.length}`);
    const a = checkBatch(fromPdf, batch);
    const b = checkBatch(fromTable, batch);
    assertEquals(b, a, `${p.source.label}：讀表與讀 PDF 的 checkBatch 結果不同`);
    // 兩邊都不是空轉：通過的與不通過的都有
    assert(a.passed.length > 0 && a.failed.length > 0, `${p.source.label}：通過 ${a.passed.length}、不通過 ${a.failed.length}`);
    // 該過的都過、該擋的都擋（不是只有「兩邊一樣」）
    assertEquals(a.passed.every((id) => id.startsWith("ok-")), true, `${p.source.label}：改過的交件通過了`);
    assertEquals(a.failed.filter((f) => f.id.startsWith("ok-")).length, 0, `${p.source.label}：原樣的交件被擋了`);
  }
});

// 一個最小的 supabase client 替身：cec_registration_sources／cec_registrations 兩張表
function fakeClient(sources: Array<{ source_url: string; row_count: number | null }>, rows: Array<Record<string, unknown>>, pageLog: number[] = []) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let range: [number, number] | null = null;
      const q = {
        select(_cols: string) { return q; },
        eq(k: string, v: unknown) { filters[k] = v; return q; },
        order(_c: string, _o: unknown) { return q; },
        range(a: number, b: number) { range = [a, b]; return q; },
        maybeSingle() {
          const hit = (table === "cec_registration_sources" ? sources : []).find((s) => Object.entries(filters).every(([k, v]) => (s as Record<string, unknown>)[k] === v));
          return Promise.resolve({ data: hit ?? null, error: null });
        },
        // deno-lint-ignore no-explicit-any
        then(res: (v: any) => unknown) {
          const all = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)).sort((x, y) => Number(x.row_no) - Number(y.row_no));
          const [a, b] = range ?? [0, all.length - 1];
          pageLog.push(a);
          return Promise.resolve({ data: all.slice(a, b + 1), error: null }).then(res);
        },
      };
      return q;
    },
  };
}

Deno.test("loadRegistrationRows：照 PDF 列序整份取回（村里長 14,100 列要翻 15 頁），列數對不上或沒登記就回 null（退回讀 PDF）", async () => {
  const village = parsed.find((p) => p.source.election_type === "村里長")!;
  const rows = village.records.map((r) => ({ ...r }));
  // 洗牌：表裡的順序不能影響結果
  const shuffled = [...rows].sort((a, b) => ((a.row_no * 7919) % 104729) - ((b.row_no * 7919) % 104729));
  const log: number[] = [];
  const got = await loadRegistrationRows(fakeClient([{ source_url: village.source.url, row_count: 14100 }], shuffled, log), village.source.url);
  assert(got);
  assertEquals(got!.length, 14100);
  assertEquals(JSON.stringify(got), JSON.stringify(village.rows));
  assertEquals(log.length, 15);
  // 沒登記的網址
  assertEquals(await loadRegistrationRows(fakeClient([], shuffled), "https://web.cec.gov.tw/api/file/00000000-0000-0000-0000-000000000000.pdf"), null);
  // 表被誤刪一列：列數 14,099 ≠ 登記的 14,100，不能拿殘缺的表判案
  assertEquals(await loadRegistrationRows(fakeClient([{ source_url: village.source.url, row_count: 14100 }], shuffled.slice(1)), village.source.url), null);
  // 登記了但列數是空的
  assertEquals(await loadRegistrationRows(fakeClient([{ source_url: village.source.url, row_count: null }], shuffled), village.source.url), null);
});

Deno.test("system-one roster_batch：先查表、查得到就不下載 PDF；查表不佔一輪 3 份的 PDF 名額；表裡沒有的照舊走 PDF 加大小保護", async () => {
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  const body = src.slice(src.indexOf('if (action === "roster_batch")'), src.indexOf("// ---- results_batch"));
  const iTable = body.indexOf("loadRegistrationRows(");
  const iPdf = body.indexOf("cecRosterText(");
  assert(iTable > 0 && iPdf > 0, "兩條路都要在");
  assert(iTable < iPdf, "先查表、再退回 PDF");
  assert(/RosterTooLargeError/.test(body), "PDF 的大小保護還在");
  assert(/read >= 3/.test(body), "一輪最多讀 3 份 PDF 的限制還在");
  // 查表那一段在 read 上限判斷之前（表裡有的名冊不被上限擋掉）
  assert(body.indexOf("loadRegistrationRows(") < body.indexOf("read >= 3"));
  // 表的結果與 PDF 的結果走同一個 checkBatch
  assertEquals(body.split("checkBatch(").length - 1, 1);
});

Deno.test("產生腳本的來源清單：現行九份的網址都登錄在 verification_sources 的 migration 裡（任務附的名冊就是這幾份）", async () => {
  const migs = ["20260930000002_cec_roster_sources.sql", "20261006100000_withdrawn_filing_qualified_wording.sql", "20261008111000_cec_roster_sources_rest.sql"];
  const all = (await Promise.all(migs.map(readMig))).join("\n");
  for (const s of ROSTER_SOURCES) {
    if (s.url.includes("9ccb6224")) continue; // 頁面現在掛的新版；登錄的是舊版 729644ff
    assert(all.includes(s.url), `${s.label} 的網址沒登錄在 verification_sources：${s.url}`);
  }
  // 舊版與現行版的關係
  const old = ROSTER_SOURCES.find((s) => s.superseded_by)!;
  assert(ROSTER_SOURCES.some((s) => s.url === old.superseded_by));
});

// ── 3. 名單缺口 ────────────────────────────────────────────────────────
type Ours = { name: string; county: string; type: string; town?: string; district?: string; status?: string; via?: "region" | "person" };
async function addOurs(d: PGlite, o: Ours) {
  const p = await d.query<{ id: string }>("INSERT INTO politicians (name, region, sub_region) VALUES ($1, $2, $3) RETURNING id", [o.name, o.county, o.town ?? null]);
  let regionId: number | null = null;
  if ((o.via ?? "region") === "region") {
    const sub = o.district ?? o.town ?? null;
    const r = await d.query<{ id: number }>("INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id", [o.county, sub]);
    regionId = r.rows[0].id;
  }
  await d.query("INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status) VALUES (2026, $1, $2, $3, $4)", [o.type, p.rows[0].id, regionId, o.status ?? "filed"]);
}
/** 一次灌很多筆（獨立重算用）：跟 addOurs 同一個形狀，只是用一個陳述式（id 用列號，只在這個測試資料庫裡用） */
let bulkSeq = 0;
async function addOursBulk(d: PGlite, list: Ours[]) {
  if (list.length === 0) return;
  const off = bulkSeq; bulkSeq += list.length;
  const json = JSON.stringify(list.map((o) => ({ name: o.name, county: o.county, type: o.type, sub: o.district ?? o.town ?? null, town: o.town ?? null, status: o.status ?? 'filed' })));
  await d.query(`
    WITH src AS (SELECT row_number() OVER () AS n, x.* FROM jsonb_to_recordset($1::jsonb) AS x(name text, county text, type text, sub text, town text, status text)),
    p AS (INSERT INTO politicians (id, name, region, sub_region) SELECT ('00000000-0000-0000-0000-' || lpad((n + $2::int)::text, 12, '0'))::uuid, name, county, town FROM src RETURNING id),
    r AS (INSERT INTO regions (id, region, sub_region) SELECT 100000 + n + $2::int, county, sub FROM src RETURNING id)
    INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status)
    SELECT 2026, type, ('00000000-0000-0000-0000-' || lpad((n + $2::int)::text, 12, '0'))::uuid, 100000 + n + $2::int, status FROM src`, [json, off]);
}
const gap = async (d: PGlite, type: string, county: string, town: string | null = null, limit = 120) =>
  (await d.query<{ g: Record<string, unknown> | null }>("SELECT roster_registration_gap(2026, $1, $2, $3, $4) AS g", [type, county, town, limit])).rows[0].g as
    | null | { registered: number; matched: number; needs_status_count: number; missing_count: number; unnamed_count: number; truncated: boolean; needs_status_truncated: boolean; source_urls: string[]; missing: Array<Record<string, string | number | null>>; needs_status: Array<Record<string, string | number | null>> };

Deno.test("名單缺口：沒有任何我們的人 → 名冊上的人全部列出來（附鄉鎮、村里、選舉區、列序）；沒有名冊的單位回 NULL", async () => {
  const d = await buildDb();
  const g = (await gap(d, "鄉鎮市長", "新竹縣"))!;
  const expected = current.find((p) => p.source.election_type === "鄉鎮市長")!.records.filter((r) => r.region === "新竹縣");
  assertEquals(g.registered, expected.length);
  assertEquals(g.matched, 0);
  assertEquals(g.missing_count, expected.length);
  assertEquals(g.missing.map((m) => m.name), expected.map((r) => r.name));
  assertEquals(g.missing[0], { name: "李貞秀", party: "無", region: "新竹縣", sub_region: "竹北市", village: null, district: null, row_no: expected[0].row_no });
  // 沒有名冊的單位：六都沒有鄉鎮市長
  assertEquals(await gap(d, "鄉鎮市長", "台北市"), null);
  assertEquals((await d.query<{ g: unknown }>("SELECT roster_registration_gap(2022, '縣市長', '台北市') AS g")).rows[0].g, null);
});

Deno.test("名單缺口：已有（算進名冊內人數）／要改狀態（considering、withdrawn）／缺 三分；臺／台、有沒有選區 id 都對得上", async () => {
  const d = await buildDb();
  const council = current.find((p) => p.source.label === "直轄市議員")!.records.filter((r) => r.region === "台北市");
  const [a, b, c, e] = [council[0], council[1], council[2], council[3]];
  await addOurs(d, { name: a.name, county: "臺北市", type: "縣市議員", district: a.district! });          // 縣市寫「臺」，已登記
  await addOurs(d, { name: b.name, county: "台北市", type: "縣市議員", status: "withdrawn" });            // 退選的：要改狀態
  await addOurs(d, { name: c.name, county: "台北市", type: "縣市議員", status: "considering", via: "person" }); // 沒選區 id、可能參選：要改狀態
  await addOurs(d, { name: "名冊上沒有的人", county: "台北市", type: "縣市議員" });
  await addOurs(d, { name: e.name, county: "新北市", type: "縣市議員" });                                  // 同名但是別的縣市：不抵銷
  const g = (await gap(d, "縣市議員", "台北市", null, 500))!;
  assertEquals(g.registered, council.length);
  assertEquals(g.matched, council.filter((r) => r.name === a.name).length);
  const needs = g.needs_status.map((m) => m.name).sort();
  assertEquals(needs, council.filter((r) => [b.name, c.name].includes(r.name)).map((r) => r.name).sort());
  assertEquals(g.needs_status_count, needs.length);
  const nb = g.needs_status.find((m) => m.name === b.name)!;
  assertEquals([nb.candidacy_status, typeof nb.politician_id, typeof nb.politician_election_id], ["withdrawn", "string", "number"]);
  assertEquals(g.needs_status.find((m) => m.name === c.name)!.candidacy_status, "considering");
  const missingNames = g.missing.map((m) => m.name);
  for (const n of [a.name, b.name, c.name]) assertEquals(missingNames.includes(n), false, `${n} 我們有紀錄（已有或要改狀態），不該列在缺`);
  assert(missingNames.includes(e.name), "別的縣市的同名者不能抵銷這個縣市的缺");
  assertEquals(g.missing[0].district, council.find((r) => ![a.name, b.name, c.name].includes(r.name))!.district);
  assertEquals(g.matched + g.needs_status_count + g.missing_count + g.unnamed_count, g.registered, "三分加姓名空白要剛好等於名冊人數");
  // 同一列對到好幾筆我們的紀錄：有一筆算進名冊內人數就是已有（不要求改狀態）
  await addOurs(d, { name: b.name, county: "台北市", type: "縣市議員", status: "filed" });
  const g2 = (await gap(d, "縣市議員", "台北市", null, 500))!;
  assertEquals(g2.needs_status.some((m) => m.name === b.name), false);
  assertEquals(g2.matched, g.matched + council.filter((r) => r.name === b.name).length);
});

Deno.test("名單缺口：不同鄉鎮的同名者不互相抵銷（村里長）；沒有鄉鎮資訊的紀錄才只比縣市", async () => {
  const d = await buildDb();
  const vill = current.find((p) => p.source.election_type === "村里長")!.records;
  // 找一個「同縣市、同姓名、不同鄉鎮」的兩位
  const byKey = new Map<string, RegistrationRecord[]>();
  for (const r of vill) if (r.name) byKey.set(`${r.region}|${r.name}`, [...(byKey.get(`${r.region}|${r.name}`) ?? []), r]);
  const pair = [...byKey.values()].find((rs) => new Set(rs.map((x) => x.sub_region)).size >= 2)!;
  assert(pair, "名冊裡找不到同縣市同名不同鄉鎮的村里長");
  const [x, y] = [pair[0], pair.find((r) => r.sub_region !== pair[0].sub_region)!];
  await addOurs(d, { name: x.name, county: x.region, type: "村里長", town: x.sub_region! });
  const gx = (await gap(d, "村里長", x.region, x.sub_region))!;
  assertEquals(gx.matched >= 1, true);
  assertEquals(gx.missing.some((m) => m.name === x.name && m.village === x.village), false, "x 所在鄉鎮的 x 我們有");
  const gy = (await gap(d, "村里長", y.region, y.sub_region))!;
  assertEquals(gy.missing.some((m) => m.name === y.name && m.village === y.village), true, "y 在另一個鄉鎮，x 的紀錄不能抵銷它");
  // 整個縣市看：y 不被抵銷，x 被抵銷
  const gc = (await gap(d, "村里長", x.region, null, 500))!;
  assertEquals(gc.missing.some((m) => m.name === y.name && m.sub_region === y.sub_region), true);
  assertEquals(gc.missing.some((m) => m.name === x.name && m.sub_region === x.sub_region), false);
});

Deno.test("名單缺口：舊版名冊不重複算（縣市議員 892 位只算現行版）、姓名空白的列不列但計數、上限與 truncated", async () => {
  const d = await buildDb();
  const g = (await gap(d, "縣市議員", "彰化縣", null, 500))!;
  const cur = current.find((p) => p.source.url.includes("9ccb6224"))!.records.filter((r) => r.region === "彰化縣");
  assertEquals(g.registered, cur.length);
  assertEquals(g.source_urls, [current.find((p) => p.source.url.includes("9ccb6224"))!.source.url]);
  // 現行版是「洪建興」，舊版是「洪健興」：只列現行版的寫法
  assertEquals(g.missing.some((m) => m.name === "洪建興"), true);
  assertEquals(g.missing.some((m) => m.name === "洪健興"), false);
  // 姓名空白
  const v = (await gap(d, "村里長", "台中市", "大安區"))!;
  const unnamed = current.find((p) => p.source.election_type === "村里長")!.records.filter((r) => r.region === "台中市" && r.sub_region === "大安區" && !r.name).length;
  assertEquals(v.unnamed_count, unnamed);
  // 上限
  const small = (await gap(d, "村里長", "新北市", null, 5))!;
  assertEquals(small.missing.length, 5);
  assertEquals(small.truncated, true);
  assertEquals(small.missing_count > 5, true);
  assertEquals((await gap(d, "鄉鎮市長", "連江縣", null, 500))!.truncated, false);
});

Deno.test("名單缺口：整個姓名都是拉丁字母的（「Laling Yumin」）不當成沒有姓名——照列出來；我們有同名的就對得上", async () => {
  const d = await buildDb();
  const before = (await gap(d, "縣市議員", "新竹縣", null, 500))!;
  assertEquals(before.unnamed_count, 0);
  assertEquals(before.missing.filter((m) => m.name === "Laling Yumin").length, 1, "現行版一位（舊版另有一列，不算）");
  await addOurs(d, { name: "Laling Yumin", county: "新竹縣", type: "縣市議員", district: "第14選舉區" });
  const after = (await gap(d, "縣市議員", "新竹縣", null, 500))!;
  assertEquals(after.missing.filter((m) => m.name === "Laling Yumin").length, 0, "同一屆同縣市同姓名鍵：我們有一筆就算有");
  assertEquals(after.matched, before.matched + 1);
});

Deno.test("名單缺口：用 JS 獨立重算全部單位（縣市層級＋每個鄉鎮的村里長），跟 SQL 的 registered／matched／missing 逐單位相同", async () => {
  const d = await buildDb();
  // 我們的紀錄：名冊的 6% 加上同名不同鄉鎮的干擾者、加上名冊上沒有的人
  const allRecs = current.flatMap((p) => p.records);
  const picked = allRecs.filter((r, i) => r.name && i % 16 === 5);
  const decoys = allRecs.filter((r, i) => r.name && i % 211 === 7 && r.election_type === "村里長").map((r) => ({ ...r, sub_region: r.sub_region === "大安區" ? "中山區" : "大安區" }));
  // 狀態：每 7 筆一筆 considering、每 11 筆一筆 withdrawn，其餘 filed
  const statusOf = (i: number) => (i % 7 === 3 ? "considering" : i % 11 === 4 ? "withdrawn" : "filed");
  await addOursBulk(d, [
    ...picked.map((r, i) => ({ status: statusOf(i), name: r.name, county: r.region, type: r.election_type, town: r.election_type === "縣市議員" ? undefined : r.sub_region ?? undefined, district: r.election_type === "縣市議員" ? r.district ?? undefined : undefined })),
    ...decoys.map((r) => ({ name: r.name, county: r.region, type: "村里長", town: r.sub_region! })),
  ]);
  const LISTED = (st: string) => !["considering", "withdrawn"].includes(st);
  // 獨立的姓名鍵（不呼叫任何 SQL）：NFKC、臺→台、黄→黃、去空白與間隔號、去尾端拉丁字母
  const norm0 = (s: string) => s.normalize("NFKC").replace(/臺/g, "台").replace(/黄/g, "黃").replace(/[\s·．.・‧•]/g, "");
  const key = (s: string) => norm0(s).replace(/[A-Za-z]+$/, "") || norm0(s) || null;
  const ours = [...picked.map((r, i) => ({ type: r.election_type, county: r.region, nn: key(r.name), town: r.election_type === "縣市議員" ? null : r.sub_region, listed: LISTED(statusOf(i)) })),
    ...decoys.map((r) => ({ type: r.election_type, county: r.region, nn: key(r.name), town: r.sub_region, listed: true }))];
  const norm = (s: string | null) => (s ?? "").replace(/臺/g, "台");
  // 索引：選舉別｜縣市｜姓名鍵 → 我們那幾筆的鄉鎮（已抹平臺／台）
  const oursBy = new Map<string, Array<{ town: string | null; listed: boolean }>>();
  for (const o of ours) {
    const k = `${o.type}|${o.county}|${o.nn}`;
    oursBy.set(k, [...(oursBy.get(k) ?? []), { town: o.town === null ? null : norm(o.town), listed: o.listed }]);
  }
  const units = new Map<string, { type: string; county: string; town: string | null }>();
  for (const r of allRecs) {
    units.set(`${r.election_type}|${r.region}|`, { type: r.election_type, county: r.region, town: null });
    if (r.election_type === "村里長") units.set(`${r.election_type}|${r.region}|${r.sub_region}`, { type: r.election_type, county: r.region, town: r.sub_region });
  }
  const all = [...units.values()];
  let checked = 0;
  for (const u of all) {
    const reg = allRecs.filter((r) => r.election_type === u.type && r.region === u.county && (u.town === null || norm(r.sub_region) === norm(u.town)));
    let matched = 0, needs = 0, missing = 0, unnamed = 0;
    const used = new Map<string, number>();
    for (const r of reg) {
      const k = key(r.name);
      if (k === null) { unnamed++; continue; }
      const key2 = `${u.type}|${r.region}|${k}`;
      const hits = (oursBy.get(key2) ?? []).filter((o) => o.town === null || r.sub_region === null || o.town === norm(r.sub_region));
      if (hits.some((o) => o.listed)) {
        // 一對一：我們算進名冊內人數的同名紀錄有 m 筆，名冊上同名的前 m 位算已有
        const m = (oursBy.get(key2) ?? []).filter((o) => o.listed).length;
        const rank = (used.get(key2) ?? 0) + 1;
        used.set(key2, rank);
        if (rank <= m) matched++; else if (hits.some((o) => !o.listed)) needs++; else missing++;
      } else if (hits.length > 0) needs++; else missing++;
    }
    const g = (await gap(d, u.type, u.county, u.town, 500))!;
    assertEquals([g.registered, g.matched, g.needs_status_count, g.missing_count, g.unnamed_count], [reg.length, matched, needs, missing, unnamed], `${u.type} ${u.county}${u.town ?? ""}`);
    checked++;
  }
  assert(checked > 350, `單位數 ${checked}`);
});

// ── 還原驗證：把被守的東西拿掉，上面的測試要紅 ─────────────────────────────
async function expectRed(label: string, body: () => Promise<void>) {
  let red = false;
  try { await body(); } catch { red = true; }
  assert(red, `還原驗證失敗：${label} 拿掉之後測試沒有變紅`);
}

Deno.test("還原驗證：缺口函式把舊版名冊也算進來 → 縣市議員的人數重複（測試要紅）", async () => {
  await expectRed("superseded_by IS NULL", async () => {
    const d = await buildDb({ schema: (s) => mutate(s, "JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL", "JOIN cec_registration_sources s ON s.source_url = r.source_url") });
    const g = (await gap(d, "縣市議員", "彰化縣", null, 500))!;
    const cur = current.find((p) => p.source.url.includes("9ccb6224"))!.records.filter((r) => r.region === "彰化縣");
    assertEquals(g.registered, cur.length);
  });
});

Deno.test("還原驗證：缺口函式不比鄉鎮 → 不同鄉鎮的同名里長互相抵銷（測試要紅）", async () => {
  await expectRed("o.town = reg.sub_region", async () => {
    const d = await buildDb({ schema: (s) => mutate(s, "AND (o.town IS NULL OR reg.sub_region IS NULL OR o.town = replace(reg.sub_region, '臺', '台'))", "") });
    const vill = current.find((p) => p.source.election_type === "村里長")!.records;
    const byKey = new Map<string, RegistrationRecord[]>();
    for (const r of vill) if (r.name) byKey.set(`${r.region}|${r.name}`, [...(byKey.get(`${r.region}|${r.name}`) ?? []), r]);
    const pair = [...byKey.values()].find((rs) => new Set(rs.map((x) => x.sub_region)).size >= 2)!;
    const y = pair.find((r) => r.sub_region !== pair[0].sub_region)!;
    await addOurs(d, { name: pair[0].name, county: pair[0].region, type: "村里長", town: pair[0].sub_region! });
    const gy = (await gap(d, "村里長", y.region, y.sub_region))!;
    assertEquals(gy.missing.some((m) => m.name === y.name && m.village === y.village), true);
  });
});

Deno.test("還原驗證：「已有」不分狀態（candidacy_is_listed 永遠為真）→ considering、withdrawn 被當成已有，要改狀態的人消失（測試要紅）", async () => {
  await expectRed("candidacy_is_listed", async () => {
    const d = await buildDb({ schema: (s) => mutate(s, "SELECT COALESCE(p_status, '') NOT IN ('considering', 'withdrawn')", "SELECT true") });
    const council = current.find((p) => p.source.label === "直轄市議員")!.records.filter((r) => r.region === "台北市");
    await addOurs(d, { name: council[1].name, county: "台北市", type: "縣市議員", status: "withdrawn" });
    const g = (await gap(d, "縣市議員", "台北市", null, 500))!;
    assertEquals(g.needs_status.some((m) => m.name === council[1].name), true);
  });
});

Deno.test("還原驗證：不做一對一 → 名冊上同名兩位只有我們一筆紀錄時，兩位都算已有，缺口顯示 0 但派工端永遠差 1（測試要紅）", async () => {
  await expectRed("rn <= c.n", async () => {
    const d = await buildDb({ schema: (s) => mutate(s, "WHERE r.rn <= c.n", "") });
    await dupNameScenario(d);
  });
});

Deno.test("還原驗證：資料 migration 少灌一列 → 逐列比對與列數檢查要紅", async () => {
  await expectRed("少一列", async () => {
    const sql = await readMig(DATA_MIG);
    const d = await buildDb({ withData: false });
    const cut = sql.replace(/\('台北市',NULL,NULL,NULL,'第01選舉區','[^']+','[^']+',1,''\),\n/, "");
    assertNotEquals(cut, sql);
    await d.exec(cut);
  });
});

Deno.test("還原驗證：loadRegistrationRows 不檢查列數 → 殘缺的表會被拿來判案（測試要紅）", async () => {
  await expectRed("rows.length !== src.row_count", async () => {
    const src = await Deno.readTextFile(new URL("./cec-registrations.ts", import.meta.url));
    const broken = mutate(src, "if (rows.length !== src.row_count) return null;", "");
    // 相對路徑的 import 換成絕對網址，才能當成 data: 模組載入（只要 --allow-read）
    const abs = broken.replace(/from "\.\/([^"]+)"/g, (_m, f) => `from "${new URL(`./${f}`, import.meta.url).href}"`);
    const mod = await import(`data:application/typescript;base64,${btoa(unescape(encodeURIComponent(abs)))}`);
    const village = parsed.find((p) => p.source.election_type === "村里長")!;
    const shuffled = village.records.slice(1).map((r) => ({ ...r }));
    const got = await mod.loadRegistrationRows(fakeClient([{ source_url: village.source.url, row_count: 14100 }], shuffled), village.source.url);
    assertEquals(got, null, "少一列的表應該回 null，改壞的版本卻回了殘缺的列");
  });
});

// ── 「已有」的定義與派工判準自洽（#447 的 n_listed）─────────────────────────
// 派工判準（contribution_auto_tasks_raw 的 roster_check，20261008112000）：最近一次回報的 cec_count > 我們的名冊內人數（n_listed）就繼續派。
// 這裡從那支 migration 原文抽出 ours 這段，在 PGlite 上對同一份資料算 n_listed，跟缺口函式的結果對起來。
const GAP_DISPATCH_MIG = "20261008112000_roster_check_gap_dispatch.sql";
async function dispatchOursCte(): Promise<string> {
  const src = await readMig(GAP_DISPATCH_MIG);
  const start = src.indexOf("  ours AS (");
  const end = src.indexOf("\n  )\n", start) + 4;
  assert(start > 0 && end > start, "抽不出派工判準的 ours 段");
  return src.slice(start, end).trim();
}
/** 派工端算的「我們的名冊內人數」（縣市層級單位） */
async function nListed(d: PGlite, type: string, county: string): Promise<number> {
  const cte = await dispatchOursCte();
  const r = await d.query<{ n: number }>(`WITH ${cte} SELECT COALESCE(sum(n_listed), 0)::int AS n FROM ours WHERE election_id = 2026 AND election_type = $1 AND region = $2`, [type, county]);
  return r.rows[0].n;
}
/** 全部單位一次算（派工端 ours 這段對全表只跑一次）：選舉別|縣市 → n_listed */
async function nListedAll(d: PGlite): Promise<Map<string, number>> {
  const cte = await dispatchOursCte();
  const r = await d.query<{ election_type: string; region: string; n: number }>(`WITH ${cte} SELECT election_type, region, n_listed::int AS n FROM ours WHERE election_id = 2026`);
  return new Map(r.rows.map((x) => [`${x.election_type}|${x.region}`, x.n]));
}
/** 派工端的判斷：回報的 cec_count 比我們的名冊內人數多就繼續派（#447） */
const dispatched = (cecCount: number, listed: number) => cecCount > listed;

async function dupNameScenario(d: PGlite) {
  // 名冊裡（現行版）沒有同縣市同選舉別同姓名的兩位，所以複製一列造出來：台北市第一位議員候選人在同一份名冊多一列（row_no 9999）
  const first = current.find((p) => p.source.label === "直轄市議員")!.records.find((r) => r.region === "台北市" && r.name)!;
  await d.query(
    `INSERT INTO cec_registrations (election_id, election_type, region, place, sub_region, village, district, name, party, row_no, source_url, flags, parsed_at)
     SELECT election_id, election_type, region, place, sub_region, village, district, name, party, 9999, source_url, flags, parsed_at
       FROM cec_registrations WHERE source_url = $1 AND row_no = $2`, [first.source_url, first.row_no]);
  await addOurs(d, { name: first.name, county: "台北市", type: "縣市議員", district: first.district! });
  const g = (await gap(d, "縣市議員", "台北市", null, 500))!;
  assertEquals(g.missing.filter((m) => m.name === first.name).length, 1, "名冊上同名兩位、我們一筆：另一位要算缺");
  assertEquals(g.matched, 1);
  assertEquals(g.matched + g.needs_status_count + g.missing_count + g.unnamed_count, g.registered);
  assertEquals(dispatched(g.registered, await nListed(d, "縣市議員", "台北市")), true, "派工端：名冊人數 > 我們的名冊內人數，會派；任務要看得到缺的是哪一位");
}

Deno.test("名單缺口：名冊上同縣市同姓名兩位、我們只有一筆 → 一位已有、另一位算缺（人數跟派工判準一致）", async () => {
  await dupNameScenario(await buildDb());
});

Deno.test("「已有」的定義跟 #447 的 n_listed 一個字不差：candidacy_is_listed 的條件＝派工判準裡 FILTER 的條件", async () => {
  const dispatch = await readMig(GAP_DISPATCH_MIG);
  const m = /COUNT\(\*\) FILTER \(WHERE (COALESCE\(pe\.candidacy_status, ''\) NOT IN \(([^)]+)\))\) AS n_listed/.exec(dispatch);
  assert(m, "找不到派工判準的 n_listed");
  const list = m![2].replace(/\s/g, "");
  const schema = await readMig(SCHEMA_MIG);
  const f = /FUNCTION candidacy_is_listed\(p_status TEXT\)[\s\S]*?SELECT COALESCE\(p_status, ''\) NOT IN \(([^)]+)\)/.exec(schema);
  assert(f, "找不到 candidacy_is_listed");
  assertEquals(f![1].replace(/\s/g, ""), list);
  // 派工端的 ours 本來就先排除 withdrawn（所以退選的不會進 n_listed、也不會進 n）
  assert(dispatch.includes("WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'"));
  // 缺口函式用的是這支函式，不是自己再寫一份
  assert(schema.includes("candidacy_is_listed(pe.candidacy_status) AS listed"));
  // 行為：每一種狀態，函式與派工的判斷相同
  const d = await buildDb();
  for (const st of [null, "considering", "declared", "filed", "withdrawn", "elected", "not_elected", "registered"]) {
    const fn = (await d.query<{ b: boolean }>("SELECT candidacy_is_listed($1) AS b", [st])).rows[0].b;
    const sqlExpr = (await d.query<{ b: boolean }>(`SELECT COALESCE($1::text, '') NOT IN (${m![2]}) AS b`, [st])).rows[0].b;
    assertEquals(fn, sqlExpr, `狀態 ${st}`);
  }
});

Deno.test("自洽：名冊 10 人、我們 10 筆但 1 筆是 considering → 任務要列出那 1 筆要改狀態；代理照做、回報後派工端不再派", async () => {
  const d = await buildDb();
  const unit = current.find((p) => p.source.election_type === "縣市長" && p.source.label === "縣市長（其餘 16 縣市）")!.records.filter((r) => r.region === "新竹縣");
  const N = unit.length;
  assert(N >= 2);
  // 我們全有，但第一位是 considering
  for (let i = 0; i < N; i++) await addOurs(d, { name: unit[i].name, county: "新竹縣", type: "縣市長", status: i === 0 ? "considering" : "filed" });
  const g = (await gap(d, "縣市長", "新竹縣"))!;
  // 以前的缺陷：任務說缺 0，派工端卻只算 N−1
  assertEquals([g.registered, g.matched, g.needs_status_count, g.missing_count], [N, N - 1, 1, 0]);
  assertEquals(g.needs_status[0].name, unit[0].name);
  assertEquals(g.needs_status[0].candidacy_status, "considering");
  assertEquals(dispatched(g.registered, await nListed(d, "縣市長", "新竹縣")), true, "回報 cec_count＝名冊人數，派工端只算到 N−1，所以會派（任務得看得到要改誰）");
  // 代理照任務做：correction 把那一筆改成 filed（登記階段），再回報 cec_count＝registered
  await d.query("UPDATE politician_elections SET candidacy_status = 'filed' WHERE id = $1", [g.needs_status[0].politician_election_id]);
  const after = (await gap(d, "縣市長", "新竹縣"))!;
  assertEquals([after.matched, after.needs_status_count, after.missing_count], [N, 0, 0]);
  assertEquals(dispatched(after.registered, await nListed(d, "縣市長", "新竹縣")), false, "改完狀態，下一輪不再派");
});

Deno.test("自洽（全部縣市層級單位）：considering、withdrawn、缺、姓名空白混在一起，代理照提示做完回報 → 每個單位下一輪都不再派，缺口函式歸零", async () => {
  const d = await buildDb();
  const types = ["縣市長", "縣市議員", "鄉鎮市長", "鄉鎮市民代表", "直轄市山地原住民區長", "直轄市山地原住民區民代表"];
  const recs = current.flatMap((p) => p.records).filter((r) => types.includes(r.election_type));
  // 名冊每 6 位一組輪流：沒有紀錄／considering／withdrawn／filed×3
  const ours: Ours[] = [];
  recs.forEach((r, i) => {
    if (!r.name) return;
    const m = i % 6;
    if (m === 0) return;
    ours.push({ name: r.name, county: r.region, type: r.election_type, town: r.election_type === "縣市議員" ? undefined : r.sub_region ?? undefined,
      district: r.election_type === "縣市議員" ? r.district ?? undefined : undefined, status: m === 1 ? "considering" : m === 2 ? "withdrawn" : "filed" });
  });
  await addOursBulk(d, ours);
  const units = [...new Map(recs.map((r) => [`${r.election_type}|${r.region}`, { type: r.election_type, county: r.region }])).values()];
  let before = 0, nextId = 5_000_000;
  const listedBefore = await nListedAll(d);
  const reports = new Map<string, number>();
  for (const u of units) {
    const g = (await gap(d, u.type, u.county, null, 500))!;
    if (dispatched(g.registered, listedBefore.get(`${u.type}|${u.county}`) ?? 0)) before++;
    // 代理照提示：缺的 → candidacy（filed）；要改狀態的 → correction；withdrawn 裡偶數列「確實登記後退選」→ 不改、cec_count 減掉；姓名空白的 → 打開 PDF 自己補
    let kept = 0;
    await addOursBulk(d, g.missing.map((m) => ({ name: String(m.name), county: u.county, type: u.type, town: u.type === "縣市議員" ? undefined : (m.sub_region as string | null) ?? undefined, district: u.type === "縣市議員" ? (m.district as string | null) ?? undefined : undefined })));
    for (const n of g.needs_status) {
      if (n.candidacy_status === "withdrawn" && Number(n.row_no) % 2 === 0) { kept++; continue; }
      await d.query("UPDATE politician_elections SET candidacy_status = 'filed' WHERE id = $1", [n.politician_election_id]);
    }
    await addOursBulk(d, Array.from({ length: g.unnamed_count }, () => ({ name: `名冊空白姓名${nextId++}`, county: u.county, type: u.type })));
    reports.set(`${u.type}|${u.county}`, g.registered - kept);
    // 做完之後缺口函式歸零：每 3 個單位抽 1 個驗（PGlite 一次呼叫要幾百毫秒）；派工端的判斷下面對每個單位都驗
    if (units.indexOf(u) % 3 === 0) {
      const after = (await gap(d, u.type, u.county, null, 500))!;
      assertEquals(after.missing_count, 0, `${u.type} ${u.county}：補完還有缺`);
      assertEquals(after.needs_status_count, kept, `${u.type} ${u.county}：只剩確實登記後退選的`);
    }
  }
  // 全部做完、回報之後：派工端對每個單位都不再派
  const listedAfter = await nListedAll(d);
  let loops = 0;
  for (const u of units) {
    const k = `${u.type}|${u.county}`;
    assertEquals(dispatched(reports.get(k)!, listedAfter.get(k) ?? 0), false, `${k}：回報 cec_count＝${reports.get(k)}，派工端 n_listed＝${listedAfter.get(k)}，下一輪還在派`);
    loops++;
  }
  assert(before > 50, `照做之前派工端會派的單位數 ${before}（太少代表情境沒有壓到）`);
  assertEquals(loops, units.length);
});

Deno.test("還原驗證：任務不列要改狀態的人（舊版：只算同名就是已有）→ 自洽測試要紅", async () => {
  await expectRed("considering 算已有", async () => {
    const d = await buildDb({ schema: (s) => mutate(s, "SELECT COALESCE(p_status, '') NOT IN ('considering', 'withdrawn')", "SELECT true") });
    const unit = current.find((p) => p.source.label === "縣市長（其餘 16 縣市）")!.records.filter((r) => r.region === "新竹縣");
    for (let i = 0; i < unit.length; i++) await addOurs(d, { name: unit[i].name, county: "新竹縣", type: "縣市長", status: i === 0 ? "considering" : "filed" });
    const g = (await gap(d, "縣市長", "新竹縣"))!;
    // 這個斷言是自洽測試裡「派工會派」與「任務看得到要改誰」同時成立的那一條
    assertEquals(dispatched(g.registered, await nListed(d, "縣市長", "新竹縣")) && g.needs_status_count === 0, false);
  });
});

// ── 4. 名單清查任務附上缺的名單（task-context）────────────────────────────
Deno.test("roster_check 的現況：有名冊比對結果就帶 registration 與專用提示；已投票屆別（list_source＝cec）仍用自己的提示；沒有就照舊", async () => {
  const d = await buildDb();
  const g = (await gap(d, "鄉鎮市長", "新竹縣"))!;
  const rows = [{ candidacy_status: "filed", position: null, regions: { region: "新竹縣", sub_region: "竹北市" }, politicians: { name: "王小明", party: "無" } }];
  const cur = shapeTaskCurrent("roster_check", { roster: { rows, history: [], region: "新竹縣", registration: g } });
  assertEquals(cur.hint, ROSTER_REGISTRATION_GAP_HINT);
  const reg = cur.registration as Record<string, unknown>;
  assertEquals(Object.keys(reg).sort(), ["matched", "missing", "missing_count", "needs_status", "needs_status_count", "needs_status_truncated", "registered", "source_urls", "truncated", "unnamed_count"]);
  assertEquals((reg.missing as unknown[]).length, g.missing.length);
  assertEquals(cur.ours_count, 1);
  // 已投票屆別：缺口在 target.missing，提示不變
  assertEquals(shapeTaskCurrent("roster_check", { roster: { rows, history: [], region: "新竹縣", list_source: "cec", registration: g } }).hint, ROSTER_CEC_GAP_HINT);
  // 這個單位名冊裡沒有人（回 NULL）：沒有 registration、也不是專用提示
  const none = shapeTaskCurrent("roster_check", { roster: { rows, history: [], region: "台北市" } });
  assertEquals("registration" in none, false);
  assertNotEquals(none.hint, ROSTER_REGISTRATION_GAP_HINT);
});

Deno.test("提示與函式對得上：提示講的欄位函式真的回得出來；上限與函式預設一致", async () => {
  const sql = await readMig(SCHEMA_MIG);
  for (const k of ["registered", "missing", "needs_status", "needs_status_count", "unnamed_count", "source_urls"]) {
    assert(ROSTER_REGISTRATION_GAP_HINT.includes(`registration.${k}`), `提示沒提到 registration.${k}`);
  }
  for (const k of ["registered", "matched", "needs_status_count", "needs_status", "needs_status_truncated", "missing_count", "unnamed_count", "source_urls", "truncated", "missing"]) assert(sql.includes(`'${k}'`), `函式沒有回 ${k}`);
  for (const k of ["politician_id", "politician_election_id", "candidacy_status"]) assert(sql.includes(`'${k}'`), `needs_status 沒有 ${k}`);
  for (const k of ["name", "party", "region", "sub_region", "village", "district", "row_no"]) assert(sql.includes(`'${k}'`), `missing 沒有 ${k}`);
  assertEquals(ROSTER_GAP_LIMIT, 120);
  assert(sql.includes("p_limit INTEGER DEFAULT 120"));
});

Deno.test("task-context 抓 roster_check 現況時才呼叫缺口函式：已投票屆別不呼叫、出錯不擋派工、傳縣市與鄉鎮", async () => {
  const src = await Deno.readTextFile(new URL("./task-context.ts", import.meta.url));
  const at = src.indexOf('supabase.rpc("roster_registration_gap"');
  assert(at > 0);
  const block = src.slice(src.lastIndexOf('if (target.list_source !== "cec")', at), at + 600);
  assert(block.startsWith('if (target.list_source !== "cec")'), "已投票屆別（list_source＝cec）不該呼叫");
  assert(/p_county: scope\.county, p_town: scope\.township, p_limit: ROSTER_GAP_LIMIT/.test(block));
  assert(/!gap\.error && gap\.data/.test(block), "出錯或沒資料就不附，不能丟錯擋派工");
});

Deno.test("派工臂、總表、seed 一個字沒動：這兩支 migration 不重新定義任何派工函式（缺的名單在 /next 派出時附，不改 task_dispatches 的內容）", async () => {
  for (const m of [SCHEMA_MIG, DATA_MIG]) {
    const sql = await readMig(m);
    assertEquals(/contribution_auto_tasks|seed_auto_task_queue|rebalance_queue|task_dispatches/.test(sql), false, `${m} 動到派工`);
    // 也沒有任何一行寫人物或參選紀錄
    assertEquals(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(politicians|politician_elections|contributions|regions)\b/i.test(sql), false, `${m} 寫了人物或貢獻`);
  }
  // roster_cec_gap 臂（已投票屆別）不讀這張表：它的 task_id 跟 2026 的 raw／roster_villages 撞號，見 DECISIONS 10-08
  const gapArm = await readMig("20261006100000_withdrawn_filing_qualified_wording.sql");
  assertEquals(gapArm.includes("cec_registrations"), false);
});

Deno.test("提示一定叫代理把名冊網址放進 source_urls（沒有名冊網址，roster_batch 不會核對，缺的人就只能逐筆湊票）", () => {
  assert(ROSTER_REGISTRATION_GAP_HINT.includes("source_urls 第一個放 registration.source_urls 裡的那份名冊"));
  // 還原驗證：拿掉這一句，上面這個斷言要紅
  const stripped = ROSTER_REGISTRATION_GAP_HINT.replace("source_urls 第一個放 registration.source_urls 裡的那份名冊", "");
  assertNotEquals(stripped, ROSTER_REGISTRATION_GAP_HINT);
  assertEquals(stripped.includes("source_urls 第一個放 registration.source_urls 裡的那份名冊"), false);
});
