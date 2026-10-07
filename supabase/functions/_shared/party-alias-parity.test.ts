/**
 * 政黨別名「三份」對齊（盤點 #10，2026-10-07 維護者同意）。
 *
 * 政黨寫法的真相是資料庫的 party_aliases（#346）；另外還有兩份「身份比對鍵」用的對照，因為要純函式／IMMUTABLE
 * （寫進 politician_identity_keys 的鍵不能因為表變動而漂移），不能直接讀表：
 *   SQL identity_norm_party()   WHEN 清單
 *   TS  identity-normalize.ts   PARTY_ALIASES
 * 這裡把三邊釘在一起：TS＝SQL（逐字）、而且每一筆都對得上 party_aliases 的種子資料（lib/party-seed.json，
 * 與 migration 的資料段是同一份，lib/parties.test.ts 盯著）：同一個政黨、或同為無黨籍。
 * 新增寫法的順序：先 party_aliases（migration）→ 再同步 identity_norm_party 與 PARTY_ALIASES → 測試沒對上會紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { normParty, PARTY_ALIASES } from "./identity-normalize.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestDef(name: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\(`);
  let def: string | null = null;
  for (const n of names) {
    const sql = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r/g, "");
    const i = sql.search(re);
    if (i < 0) continue;
    const rest = sql.slice(i);
    const tag = /AS (\$[a-z]*\$)/.exec(rest);
    if (!tag) continue;
    const start = rest.indexOf(tag[0]) + tag[0].length;
    def = rest.slice(0, rest.indexOf(tag[1], start) + tag[1].length);
  }
  if (!def) throw new Error(`找不到 ${name}`);
  return def;
}

interface SeedAlias { alias_key: string; party_id: number | null; kind: string }
const seed = JSON.parse(await Deno.readTextFile(new URL("../../../lib/party-seed.json", import.meta.url))) as { aliases: SeedAlias[] };
const aliasByKey = new Map(seed.aliases.map((a) => [a.alias_key, a]));

Deno.test("SQL 與 TS 一致：identity_norm_party() 的 WHEN 清單＝PARTY_ALIASES（逐字，沒有多的也沒有少的）", async () => {
  const def = await latestDef("identity_norm_party");
  const sqlMap: Record<string, string> = {};
  for (const m of def.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)) sqlMap[m[1]] = m[2];
  assert(Object.keys(sqlMap).length > 0, "抓不到 SQL 的對照");
  assertEquals(sqlMap, { ...PARTY_ALIASES });
});

Deno.test("PARTY_ALIASES 每一筆都對得上 party_aliases：寫法和標準寫法是同一個政黨，或同為無黨籍", () => {
  for (const [from, to] of Object.entries(PARTY_ALIASES)) {
    const a = aliasByKey.get(from);
    const b = aliasByKey.get(to);
    assert(a, `party_aliases 裡沒有「${from}」（先加 party_aliases 再加身份比對）`);
    assert(b, `party_aliases 裡沒有標準寫法「${to}」`);
    assertEquals(a.kind === "independent", b.kind === "independent", `「${from}」與「${to}」一邊是無黨籍、一邊不是`);
    assertEquals(a.party_id, b.party_id, `「${from}」與「${to}」不是同一個政黨`);
  }
});

Deno.test("反向：party_aliases 裡所有的無黨籍寫法，身份比對都收斂成同一個「無黨籍」（或本來就是空值／標準寫法）", () => {
  for (const a of seed.aliases.filter((x) => x.kind === "independent")) {
    // 「無」在 normText 就被當空值（不產生政黨面向）；「無黨籍」本身就是標準寫法
    if (a.alias_key === "無") { assertEquals(normParty("無"), null); continue; }
    assertEquals(normParty(a.alias_key), "無黨籍", `無黨籍寫法「${a.alias_key}」沒有收斂到「無黨籍」`);
  }
});

Deno.test("反向：政黨通稱（kind=short）裡，身份比對有改字的三個（國民黨、民進黨、民眾黨）指的政黨就是標準寫法的那個", () => {
  for (const [from, to] of Object.entries(PARTY_ALIASES)) {
    const a = aliasByKey.get(from)!;
    if (a.kind !== "short") continue;
    const canonical = aliasByKey.get(to)!;
    assertEquals(a.party_id, canonical.party_id);
  }
  assertEquals(normParty("國民黨"), "中國國民黨");
  assertEquals(normParty("民進黨"), "民主進步黨");
  assertEquals(normParty("民眾黨"), "台灣民眾黨");
  assertEquals(normParty(" 臺灣民眾黨 "), "台灣民眾黨", "臺→台 在別名之前");
});

Deno.test("行為不變：拿掉 5 筆沒用的別名後，每個舊輸出都一樣（原字不變的、「無」、空值、沒登記的政黨）", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["中國國民黨", "中國國民黨"], ["民主進步黨", "民主進步黨"], ["台灣民眾黨", "台灣民眾黨"], ["無黨籍", "無黨籍"],
    ["無", null], ["", null], [null, null], [undefined, null], ["未知", null],
    ["時代力量", "時代力量"], ["台灣基進", "台灣基進"], ["無黨籍及未經政黨推薦者", "無黨籍"],
  ];
  for (const [input, out] of cases) assertEquals(normParty(input), out, String(input));
});
