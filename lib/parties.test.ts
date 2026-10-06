/**
 * 政黨表與寫法對照（#346 第一階段）的守門測試。這裡沒有資料庫，守的是「兩份要一致的東西」：
 *   1. migration 的資料段跟 lib/party-seed.json 一模一樣（建置端在 migration 還沒套上的那一次用 seed，兩邊不一致畫面就跟資料庫不同）
 *   2. 比對規則 SQL party_alias_key()、前端 partyAliasKey()、產資料的腳本 alias_key() 三邊同一套
 *   3. 無黨籍那一族不是政黨（party_id 空的）、每一條對照都指得到政黨、資料裡真的出現過的寫法都對得到
 * SQL 本身另外在 PGlite 上灌 10-06 唯讀快照實跑過，見 PR 說明。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildPartyIndex, matchParty, partyAliasKey, partySpellings, partyStatusText, type PartyRegistry } from "./parties.ts";

const seed: PartyRegistry & { source: string; fetched_on: string } = JSON.parse(
  await Deno.readTextFile(new URL("./party-seed.json", import.meta.url)),
);
const migration = (await Deno.readTextFile(new URL("../supabase/migrations/20261006073461_parties.sql", import.meta.url))).replace(/\r/g, "");
const script = (await Deno.readTextFile(new URL("../scripts/fetch-moi-parties.py", import.meta.url))).replace(/\r/g, "");
const index = buildPartyIndex(seed);

/** 解析 SQL 的 VALUES 一列：'字串'（'' 是單引號）、NULL、整數 */
function parseTuple(line: string): Array<string | number | null> {
  const out: Array<string | number | null> = [];
  let i = line.indexOf("(") + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      let s = "";
      i++;
      while (i < line.length) {
        if (line[i] === "'" && line[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (line[i] === "'") { i++; break; }
        s += line[i++];
      }
      out.push(s);
    } else if (line.startsWith("NULL", i)) {
      out.push(null);
      i += 4;
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?\d+/.exec(line.slice(i))!;
      out.push(Number(m[0]));
      i += m[0].length;
    } else if (c === ")") {
      break;
    } else {
      i++;
    }
  }
  return out;
}
function valuesAfter(header: string): Array<Array<string | number | null>> {
  const start = migration.indexOf(header);
  assert(start >= 0, `migration 找不到「${header}」`);
  const lines = migration.slice(start).split("\n").slice(1);
  const rows: Array<Array<string | number | null>> = [];
  for (const line of lines) {
    if (!line.startsWith("(")) break;
    rows.push(parseTuple(line));
  }
  return rows;
}

Deno.test("migration 的資料段＝lib/party-seed.json（政黨與寫法對照逐列逐欄一樣）", () => {
  const parties = valuesAfter("INSERT INTO parties (id, name, short_name, moi_no, moi_name, moi_status, valid_from, valid_to, note) OVERRIDING SYSTEM VALUE VALUES");
  assertEquals(parties.length, seed.parties.length);
  assertEquals(parties, seed.parties.map((p) => [p.id, p.name, p.short_name, p.moi_no, p.moi_name, p.moi_status, p.valid_from, p.valid_to, p.note]));
  const aliases = valuesAfter("INSERT INTO party_aliases (alias_key, alias, party_id, kind, note) VALUES");
  assertEquals(aliases, seed.aliases.map((a) => [a.alias_key, a.alias, a.party_id, a.kind, a.note]));
  // 改名：現名那一列的 predecessor 在資料段裡另外寫
  for (const p of seed.parties.filter((x) => x.predecessor_id !== null)) {
    assert(migration.includes(`UPDATE parties SET predecessor_id = ${p.predecessor_id} WHERE id = ${p.id};`), `${p.name} 的前身沒寫進 migration`);
  }
  assert(migration.includes(`擷取日 ${seed.fetched_on}`));
});

Deno.test("比對規則：SQL、前端、腳本三邊同一套（NFKC → 去所有空白 → 臺當台；空的是 null）", () => {
  const sqlFn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION party_alias_key"), migration.indexOf("COMMENT ON FUNCTION party_alias_key"));
  assert(sqlFn.includes("normalize(coalesce(p_text, ''), NFKC)"), "SQL 少了 NFKC");
  assert(sqlFn.includes("regexp_replace(") && sqlFn.includes("'\\s', '', 'g'"), "SQL 少了去空白");
  assert(sqlFn.includes("'臺', '台'"), "SQL 少了臺當台");
  assert(sqlFn.includes("nullif("), "SQL 空字串要回 NULL");
  const pyFn = script.slice(script.indexOf("def alias_key"), script.indexOf("def roc_date"));
  assert(pyFn.includes('unicodedata.normalize("NFKC"') && pyFn.includes('re.sub(r"\\s+", ""') && pyFn.includes('.replace("臺", "台")'), "腳本的 alias_key 跟 SQL 不一樣");
  assertEquals(partyAliasKey("臺灣 人民共產黨"), "台灣人民共產黨");
  assertEquals(partyAliasKey("　民進黨　"), "民進黨", "全形空白也要去掉");
  assertEquals(partyAliasKey("ＤＰＰ"), "DPP", "全形英數轉半形");
  assertEquals(partyAliasKey("台灣SoR無法黨"), "台灣SoR無法黨", "大小寫不動");
  assertEquals(partyAliasKey("   "), null);
  assertEquals(partyAliasKey(null), null);
  // seed 的 alias_key 都是用同一套算出來的
  for (const a of seed.aliases) assertEquals(partyAliasKey(a.alias), a.alias_key, a.alias);
});

Deno.test("無黨籍不是政黨：六種寫法都對到無黨籍、party_id 空的；其餘每一條都指得到政黨", () => {
  const independent = seed.aliases.filter((a) => a.kind === "independent").map((a) => a.alias).sort();
  assertEquals(independent, ["無", "無黨", "無黨籍", "無黨籍及未經政黨推薦", "無黨籍及未經政黨推薦者", "未經政黨推薦"].sort());
  for (const a of seed.aliases) {
    if (a.kind === "independent") assertEquals(a.party_id, null, a.alias);
    else assert(a.party_id !== null && index.byId.has(a.party_id), `「${a.alias}」指不到政黨`);
  }
  // 無黨籍沒有政黨列
  assert(!seed.parties.some((p) => partyAliasKey(p.name)?.startsWith("無黨籍")), "無黨籍不該是 parties 的一列");
});

Deno.test("資料裡出現過的寫法都對得到（10-06 人物表＋交件裡 77 種的代表）", () => {
  const cases: Array<[string, string | null]> = [
    ["無黨籍及未經政黨推薦", null], ["無黨籍", null], ["無", null],
    ["中國國民黨", "中國國民黨"], ["國民黨", "中國國民黨"], ["民主進步黨", "民主進步黨"], ["民進黨", "民主進步黨"],
    ["台灣民眾黨", "台灣民眾黨"], ["民眾黨", "台灣民眾黨"], ["綠黨", "台灣綠黨"], ["台灣綠黨", "台灣綠黨"],
    ["台灣基進", "台灣基進"], ["台灣基進黨", "台灣基進"], ["台灣SoR無法黨", "臺灣SoR無法黨"], ["臺灣人民共產黨", "臺灣人民共產黨"],
    ["中華統一促進黨", "中華統一促進黨"], ["台聯黨", "台聯黨"], ["台灣團結聯盟", "台灣團結聯盟"], ["制度救世島", "制度救世島"],
    ["臺灣雙語無法黨", "臺灣雙語無法黨"], ["夏潮聯合會", "夏潮聯合會"], ["家庭基本收入", "家庭基本收入"],
  ];
  for (const [text, want] of cases) {
    const m = matchParty(text, index);
    if (want === null) assertEquals(m.kind, "independent", text);
    else {
      assertEquals(m.kind, "party", text);
      assertEquals(m.kind === "party" ? index.byId.get(m.partyId)?.name : null, want, text);
    }
  }
  assertEquals(matchParty("不存在的黨", index).kind, "unknown");
  assertEquals(matchParty("", index).kind, "unknown");
});

Deno.test("名冊：id＝政黨編號；名冊外的 10001 起；同名重新備案的只對到狀態一般的那一個；改名有前身", () => {
  for (const p of seed.parties) {
    if (p.moi_no !== null) assertEquals(p.id, p.moi_no, p.name);
    else assert(p.id >= 10001, p.name);
  }
  assertEquals(index.byId.get(matchParty("台灣民主黨", index).kind === "party" ? (matchParty("台灣民主黨", index) as { partyId: number }).partyId : -1)?.moi_status, "一般");
  const tsu = seed.parties.find((p) => p.name === "台聯黨")!;
  const old = seed.parties.find((p) => p.id === tsu.predecessor_id)!;
  assertEquals(old.name, "台灣團結聯盟");
  assertEquals(tsu.valid_from, null, "改過名的現名：改名日不知道就空著，不拿建黨日充當");
  assertEquals(old.valid_from, "2001-08-12");
  // 名冊的註記不是名稱
  const cup = seed.parties.find((p) => p.moi_no === 113)!;
  assertEquals(cup.name, "中華統一促進黨");
  assert(cup.moi_name!.startsWith("中華統一促進黨（"));
  // 解散、廢止沒有日期：valid_to 一律空著（看 moi_status）
  assert(seed.parties.every((p) => p.valid_to === null));
});

Deno.test("partySpellings／partyStatusText", () => {
  const kmt = partySpellings(1, seed);
  for (const s of ["中國國民黨", "國民黨"]) assert(kmt.includes(s), s);
  const ccp = partySpellings(315, seed);
  assert(ccp.includes("臺灣人民共產黨") && ccp.includes("台灣人民共產黨"), "臺／台兩種都要有");
  assertEquals(partyStatusText({ moi_no: 1, moi_status: "一般" }), null);
  assertEquals(partyStatusText({ moi_no: 356, moi_status: "自行解散" }), "內政部登記狀態：自行解散");
  assertEquals(partyStatusText({ moi_no: null, moi_status: null }), "內政部政黨名冊查無此名稱");
});
