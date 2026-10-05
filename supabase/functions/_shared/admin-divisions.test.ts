/**
 * 地區官方代碼與髒列清理的守門測試（migration 20261005000480／20261005000481；#348，2026-10-05）。
 *
 * 這裡沒有資料庫。兩支 SQL 是在 PGlite（WASM Postgres）上灌 10-05 線上唯讀資料實跑驗過的（見 PR 說明）；
 * 這支守住「改壞了不會報錯」的幾件事：
 *   1. 官方清單資料段完整（22 縣市、368 鄉鎮市區、7,781 村里，代碼層層接得上）
 *   2. 寫法不同的 37 個村里對照表：目標是同一縣市同一鄉鎮的村里、一對一、每一列都符合註解寫的規則
 *   3. region_kind 認得 TS 落庫寫進去的每一種選區形狀（不然新建的選區列會被 region_audit 當成髒列）
 *   4. 清髒列只搬指標、縣市一律不變；刪除一定先確認沒有任何資料掛著
 *   5. 扣統計找不到列時不新建（不然清掉的錯誤組合會長回來）
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { COUNCIL_ABORIGINAL_DISTRICTS, LEGISLATOR_AT_LARGE_SEATS, legislatorDistrictKey, normalizeDistrict } from "./electoral-district.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const codesSql = await Deno.readTextFile(new URL("20261005000480_admin_divisions.sql", MIGRATIONS));
const cleanupSql = await Deno.readTextFile(new URL("20261005000481_regions_cleanup.sql", MIGRATIONS));

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}

/** SQL 字串常值（含 U&'…' 的 \XXXX、\+XXXXXX 跳脫）→ JS 字串；NULL → null */
function sqlLiterals(line: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of line.matchAll(/(U&)?'((?:[^']|'')*)'|\bNULL\b/g)) {
    if (m[0] === "NULL") {
      out.push(null);
      continue;
    }
    let s = m[2].replace(/''/g, "'");
    if (m[1]) {
      s = s.replace(/\\\+([0-9A-Fa-f]{6})|\\([0-9A-Fa-f]{4})/g, (_, six, four) => String.fromCodePoint(parseInt(six ?? four, 16)));
    }
    out.push(s);
  }
  return out;
}

/** 跟 SQL 的 admin_name_key 同一套：去空白（含全形）、臺→台 */
const nameKey = (s: string | null) => (s ?? "").replace(/[\s　]/g, "").replace(/臺/g, "台");

// ── 1. 官方清單資料段 ──────────────────────────────────────────────
const data = between(codesSql, "-- ↓↓↓ 資料段", "-- ↑↑↑ 資料段結束");
interface Division { code: string; level: "county" | "town" | "village"; parent: string | null; county: string; town: string | null; village: string | null }
const divisions: Division[] = [];
// Windows 上 core.autocrlf 會把 migration 檢出成 CRLF，一律用 \r?\n 切行
for (const line of data.split(/\r?\n/)) {
  const head = line.match(/^\('(\d+)','(county|town)',/);
  if (head) {
    const [code, level, parent, county, town] = sqlLiterals(line);
    divisions.push({ code: code!, level: level as Division["level"], parent, county: county!, town, village: null });
    continue;
  }
  const vil = line.match(/^\('(\d{11})','((?:[^']|'')*)'\),?$/);
  if (vil) divisions.push({ code: vil[1], level: "village", parent: vil[1].slice(0, 8), county: "", town: null, village: vil[2] });
}
const byCode = new Map(divisions.map((d) => [d.code, d]));
// 村里的縣市、鄉鎮名在 SQL 裡是從鄉鎮那一列 JOIN 帶過來的，這裡照做一次
for (const d of divisions) {
  if (d.level !== "village") continue;
  const t = byCode.get(d.parent!);
  if (t) Object.assign(d, { county: t.county, town: t.town });
}

Deno.test("官方清單：22 縣市、368 鄉鎮市區、7,781 村里，跟 migration 自己的筆數檢查一致", () => {
  const n = (lv: string) => divisions.filter((d) => d.level === lv).length;
  assertEquals([n("county"), n("town"), n("village")], [22, 368, 7781]);
  assert(codesSql.includes("<> (22, 368, 7781)"), "migration 裡的筆數檢查要跟資料段一致");
  assertEquals(byCode.size, divisions.length, "代碼不可重複");
});

Deno.test("官方清單：縣市代碼就是戶政的 22 個；鄉鎮市區、村里的代碼都接在上一層底下", () => {
  const counties = divisions.filter((d) => d.level === "county").map((d) => d.code).sort();
  assertEquals(counties, [
    "09007", "09020", "10002", "10004", "10005", "10007", "10008", "10009", "10010", "10013", "10014",
    "10015", "10016", "10017", "10018", "10020", "63000", "64000", "65000", "66000", "67000", "68000",
  ]);
  for (const d of divisions) {
    if (d.level === "county") continue;
    const parent = byCode.get(d.parent ?? "");
    assert(parent, `${d.code} 的上一層 ${d.parent} 不在清單裡`);
    assertEquals(parent.level, d.level === "town" ? "county" : "town", `${d.code} 的上一層層級不對`);
    assert(d.code.startsWith(parent.code), `${d.code} 不在 ${parent.code} 底下`);
  }
  // 同一個鄉鎮裡不可以有同名的村里（比對鍵是唯一索引，重複的話 migration 會整支失敗）
  const keys = divisions.map((d) => `${nameKey(d.county)}|${nameKey(d.town)}|${nameKey(d.village)}`);
  assertEquals(new Set(keys).size, keys.length);
});

// ── 2. 寫法不同的村里對照表 ──────────────────────────────────────────
const aliasBlock = between(codesSql, "INSERT INTO _admin_alias VALUES", "DO $$");
const aliases = aliasBlock.split(/\r?\n/).filter((l) => /^\s*\(/.test(l)).map((l) => {
  const [region, sub_region, village, code, official, why] = sqlLiterals(l);
  return { region: region!, sub_region: sub_region!, village: village!, code: code!, official: official!, why: why! };
});

const PUA: Record<string, string> = { "": "廍", "": "磘", "": "\u{26C21}" };
const VARIANT: Record<string, string> = { "濓": "濂" };
/** 官方名拆成字：[X] 是一個「造字標記」位置 */
function officialChars(name: string): { c: string; mark: boolean }[] {
  return [...name.matchAll(/\[([^\]]+)\]|(.)/gu)].map((m) => (m[1] ? { c: m[1], mark: true } : { c: m[2], mark: false }));
}
/** 註解寫的四條規則：a 私用區造字換回正字、b 去掉方括號、c 方括號位置我們有字、d 異體字 */
function followsRule(ours: string, official: string): boolean {
  const a = officialChars(official);
  const o = [...ours].map((c) => PUA[c] ?? VARIANT[c] ?? c);
  if (o.length !== a.length) return false;
  return a.every((x, i) => x.mark || x.c === o[i]) && a.some((x, i) => x.mark || [...ours][i] !== o[i]);
}

Deno.test("對照表：37 列，目標代碼是同一縣市、同一鄉鎮的村里，一對一", () => {
  assertEquals(aliases.length, 37);
  assertEquals(new Set(aliases.map((a) => a.code)).size, aliases.length, "兩個寫法不可以對到同一個官方村里");
  for (const a of aliases) {
    const d = byCode.get(a.code);
    assert(d && d.level === "village", `${a.code} 不是官方村里`);
    assertEquals(nameKey(d.county), nameKey(a.region), `${a.village} 的縣市對不上`);
    assertEquals(nameKey(d.town), nameKey(a.sub_region), `${a.village} 的鄉鎮對不上`);
    assertEquals(d.village, a.official, `${a.code} 官方名稱欄抄錯`);
  }
});

Deno.test("對照表：每一列名字確實對不上（對得上的第一步就補了），而且符合註解寫的規則", () => {
  for (const a of aliases) {
    assertNotEquals(nameKey(a.village), nameKey(a.official), `${a.village} 其實名稱相同，不該在對照表`);
    assert(followsRule(a.village, a.official), `${a.region}${a.sub_region}「${a.village}」→「${a.official}」不符合任何一條規則`);
  }
});

Deno.test("還原驗證用的反例：規則不會把不同的村里當成同一個", () => {
  assert(!followsRule("新生里", "新廍里"), "差一個一般字不算");
  assert(!followsRule("北里", "廍後里"), "造字換回來之後還是不同字");
  assert(!followsRule("北里", "廟北里"), "少一個一般字不算");
  assert(followsRule("新里", "新廍里"));
});

// ── 3. region_kind 認得 TS 寫進去的選區形狀 ──────────────────────────
const kindFn = between(codesSql, "CREATE OR REPLACE FUNCTION region_kind", "COMMENT ON FUNCTION region_kind");
const reOf = (label: string) => {
  const m = kindFn.match(new RegExp(`--[^\\n]*${label}[^\\n]*\\n\\s*WHEN p_sub_region ~ '([^']+)'`));
  assert(m, `region_kind 找不到「${label}」那一條`);
  return new RegExp(m[1]);
};
const councilRe = reOf("縣市議員選舉區");
const townshipRe = reOf("鄉鎮市民代表");
const legislatorRe = reOf("區域立委選區");

Deno.test("region_kind：縣市議員交件統一成的「第NN選舉區」（含原住民選區）都算議員選區", () => {
  for (const raw of ["第4選區", "第四選舉區", "新北市第4選舉區", "第 12 選舉區"]) {
    const d = normalizeDistrict(raw);
    assert(d && councilRe.test(d.district), `${raw} → ${d?.district}`);
  }
  for (const list of Object.values(COUNCIL_ABORIGINAL_DISTRICTS)) for (const d of list) assert(councilRe.test(d), d);
  assert(!councilRe.test("第2選舉區"), "沒補零的寫法不算（regions 裡出現過，是髒列）");
  assert(!councilRe.test("中山大同區"));
});

Deno.test("region_kind：區域立委落庫指的「臺北市第01選區」算立委選區，縣市要對得上", () => {
  const key = legislatorDistrictKey("台北市", "第1選區");
  assert(key);
  for (const sub of key.sub_regions) assert(legislatorRe.test(sub), sub);
  // 縣市一致與否是 SQL 另外比的（left(sub_region, 3)），正則本身只管形狀
  assert(kindFn.includes("admin_name_key(left(p_sub_region, 3)) = admin_name_key(p_region)"));
  const atLarge = legislatorDistrictKey(null, "不分區");
  assert(atLarge && atLarge.region === "全國");
  for (const seat of LEGISLATOR_AT_LARGE_SEATS) assert(kindFn.includes(`'${seat}'`), `全國選區 ${seat} 要認得`);
});

Deno.test("region_kind：原住民區代表的「那瑪夏區第01選舉區」算鄉鎮層級選區，議員選區不會被誤認", () => {
  assert(townshipRe.test("那瑪夏區第01選舉區"));
  assert(townshipRe.test("峨眉鄉第02選舉區"));
  assert(!townshipRe.test("第01選舉區"));
});

// ── 4. 清髒列：只搬指標、縣市不變；刪之前確認沒有資料掛著 ──────────────
const moveBlock = between(cleanupSql, "INSERT INTO _region_move VALUES", "CREATE TEMP TABLE _region_repoint");
const moves = moveBlock.split(/\r?\n/).filter((l) => /^\s*\('/.test(l)).map((l) => {
  const [kind, fromRegion, fromSub, fromVillage, toRegion, toSub, toVillage] = sqlLiterals(l);
  return { kind, fromRegion, fromSub, fromVillage, toRegion, toSub, toVillage };
});

Deno.test("清髒列：每一筆搬移縣市都不變，退的層級跟類別一致", () => {
  assertEquals(moves.length, 11);
  for (const m of moves) {
    const label = `${m.fromRegion} ${m.fromSub ?? ""} ${m.fromVillage ?? ""}`;
    assertEquals(m.toRegion, m.fromRegion, `${label}：搬移不可以改縣市（人的縣市錯了要走任務流程）`);
    if (m.kind === "county") assertEquals([m.toSub, m.toVillage], [null, null], `${label}：鄉鎮不在縣市 → 退到縣市層級`);
    else if (m.kind === "town") assertEquals([m.toSub, m.toVillage], [m.fromSub, null], `${label}：村里不存在 → 退到同一鄉鎮`);
    else {
      assertEquals(m.kind, "alias");
      assertEquals(m.toVillage, null);
      assert(m.toSub === null || councilRe.test(m.toSub), `${label}：俗名要搬到正式的議員選區`);
    }
  }
});

Deno.test("清髒列：每一個刪除都先確認沒有參選紀錄、也沒有人物指著", () => {
  const deletes = [...cleanupSql.matchAll(/DELETE FROM regions r([\s\S]*?)RETURNING/g)].map((m) => m[1]);
  assertEquals(deletes.length, 2);
  for (const d of deletes) {
    assert(d.includes("NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id)"), "刪除要確認沒有參選紀錄");
    assert(d.includes("NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)"), "刪除要確認沒有人物指著");
  }
  // 歷屆村里靠中選會名單認；名單不齊時整段不刪
  assert(/n_cec < 10000[\s\S]*?RETURN;[\s\S]*?DELETE FROM regions r/.test(cleanupSql));
});

Deno.test("清髒列：點名刪的議員選區（金門縣第04選舉區）確實不在原住民選區清單裡", () => {
  assert(cleanupSql.includes("r.region = '金門縣' AND r.sub_region = '第04選舉區'"));
  assert(!(COUNCIL_ABORIGINAL_DISTRICTS["金門縣"] ?? []).includes("第04選舉區"));
});

// ── 5. 扣統計不新建列 ───────────────────────────────────────────────
Deno.test("update_region_stats：最新的定義在扣統計（p_delta < 0）找不到列時直接返回，不新建", async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  let last = "";
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, MIGRATIONS));
    if (/CREATE OR REPLACE FUNCTION update_region_stats\(/.test(text)) last = text;
  }
  const body = between(last, "CREATE OR REPLACE FUNCTION update_region_stats(", "$$ LANGUAGE plpgsql");
  const guard = body.search(/IF p_delta < 0 THEN\s+RETURN;/);
  const insert = body.indexOf("INSERT INTO regions");
  assert(guard >= 0, "扣統計找不到列要直接返回");
  assert(guard < insert, "返回要在新建列之前");
});
