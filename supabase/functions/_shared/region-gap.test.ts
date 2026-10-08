/**
 * 補縣市、補選區、當選人缺參選紀錄三支派工臂的守門測試（migration 20261005000400；2026-10-05）。
 *
 * 這裡沒有資料庫，SQL 本身是在 PGlite（WASM Postgres）上灌 10-05 線上唯讀資料實跑驗過的（見 PR 說明）；
 * 這支守住「改掉就會出錯、而且不會報錯」的幾個條件：
 *   1. 重定義 contribution_auto_tasks_arms 時不可以默默掉臂——每支 migration 都是整支覆寫，
 *      兩個 PR 各自加一支臂，後上線的那支會把先上線的那支整個蓋掉，而派工照跑、測試照綠
 *   2. 「這一列算不算選區」SQL 與 TS（legislatorDistrictKey、districtRegionPatch）同一套寫法，
 *      不然代理照任務說明交了，落庫對不上，任務永遠派回來
 *   3. 表態不參選的不問選區；鄉鎮層級五種不在這裡（那是 township_gap）；當選缺紀錄不含村里長與代表
 *   4. 只用既有任務型別（沒有新增型別就不必清點四處）
 */
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { legislatorDistrictKey, normalizeDistrict } from "./electoral-district.ts";
import { TASK_TYPES } from "./contribution-schema.ts";
import { cecNameNorm } from "./cec-sync.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261005000400_region_district_gap.sql";
const sql = await Deno.readTextFile(new URL(FILE, MIGRATIONS));

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}

/**
 * 最後一支（照檔名排序）定義這個函式的 migration 全文——線上跑的是它（2026-10-05：20261005004300 重定義了
 * contribution_auto_tasks_region_gap，守門要看新的那一版，不能一直盯著 20261005000400）
 */
async function latestSqlDefining(fnName: string): Promise<string> {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  let last: string | null = null;
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, MIGRATIONS));
    if (text.includes(`CREATE OR REPLACE FUNCTION ${fnName}(`)) last = text;
  }
  assert(last, `找不到定義 ${fnName} 的 migration`);
  return last;
}
const regionGapSql = await latestSqlDefining("contribution_auto_tasks_region_gap");

/** 一支 migration 裡 contribution_auto_tasks_arms 的本體呼叫了哪幾支臂 */
function armsCalled(text: string): Set<string> {
  const body = between(text, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()", "COMMENT ON FUNCTION contribution_auto_tasks_arms");
  // 總表自己不是臂：同一支 migration 若也重定義了 seed_auto_task_queue（FROM contribution_auto_tasks_arms()），本體區間會把它算進來（2026-10-08 補號次那支只改總表、不動 seed）
  return new Set([...body.matchAll(/FROM\s+(contribution_auto_tasks_[a-z_]+)\(\)/g)].map((m) => m[1]).filter((n) => n !== "contribution_auto_tasks_arms"));
}

Deno.test("contribution_auto_tasks_arms：最新的定義要包含前一版的每一支臂（重定義不可以默默掉臂）", async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  const defining: string[] = [];
  for (const f of files) {
    const text = await Deno.readTextFile(new URL(f, MIGRATIONS));
    if (text.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()")) defining.push(f);
  }
  assert(defining.length >= 2);
  const [prevFile, lastFile] = defining.slice(-2);
  const prev = armsCalled(await Deno.readTextFile(new URL(prevFile, MIGRATIONS)));
  const last = armsCalled(await Deno.readTextFile(new URL(lastFile, MIGRATIONS)));
  // 刻意拿掉的臂寫在這裡，並附裁決出處
  const intentionallyDropped = new Set<string>([
    // 2026-10-02 /next statement timeout 止血，見 20261002000004_drop_profile_detail_arm.sql
    "contribution_auto_tasks_profile_details",
  ]);
  const dropped = [...prev].filter((a) => !last.has(a) && !intentionallyDropped.has(a));
  assertEquals(dropped, [], `${lastFile} 重定義 contribution_auto_tasks_arms 時掉了 ${prevFile} 的臂：${dropped.join("、")}`);
});

Deno.test("這次的兩支臂有接進 contribution_auto_tasks_arms", () => {
  const arms = armsCalled(sql);
  assert(arms.has("contribution_auto_tasks_region_gap"));
  assert(arms.has("contribution_auto_tasks_elected_missing"));
  assert(arms.has("contribution_auto_tasks_township_gap"), "前一版的臂要原樣保留");
});

Deno.test("只用既有任務型別（沒有新增型別，不必清點 DB CHECK／TS 清單／skill.md／task-labels 四處）", () => {
  const types = [...sql.matchAll(/'auto:([a-z_]+):/g)].map((m) => m[1]);
  assert(types.length >= 2);
  for (const t of types) assert((TASK_TYPES as readonly string[]).includes(t), `task_id 前綴 ${t} 不是既有任務型別`);
  // task_type 欄位的字面值也要是既有型別
  for (const m of sql.matchAll(/'auto:[a-z_]+:[^']*'[^,]*,\s*'([a-z_]+)'/g)) {
    assert((TASK_TYPES as readonly string[]).includes(m[1]), `task_type ${m[1]} 不是既有任務型別`);
  }
});

// ── 「這一列算不算選區」：SQL 的 region_is_electoral_district 跟 TS 寫進去的形狀要一致 ──────
const fn = between(sql, "CREATE OR REPLACE FUNCTION region_is_electoral_district", "COMMENT ON FUNCTION region_is_electoral_district");
const councilRe = new RegExp(fn.match(/WHEN '縣市議員' THEN COALESCE\(p_sub_region ~ '([^']+)'/)![1]);
const legislatorRe = new RegExp(fn.match(/WHEN '立法委員' THEN COALESCE\(p_sub_region ~ '([^']+)'/)![1]);
const atLarge = fn.match(/p_sub_region IN \(([^)]+)\)/)![1].split(",").map((s) => s.trim().replace(/'/g, ""));

Deno.test("算不算選區：縣市議員交件統一成的「第NN選舉區」SQL 認得，縣市層級與鄉鎮名不算", () => {
  for (const raw of ["第4選區", "第四選舉區", "臺北市第6選區(大安文山)"]) {
    const d = normalizeDistrict(raw)!.district;
    assertMatch(d, councilRe, `${raw} → ${d} 應該算選區`);
  }
  for (const notDistrict of ["中山大同區", "八德區", "高雄市"]) assertEquals(councilRe.test(notDistrict), false, notDistrict);
});

Deno.test("算不算選區：立委落庫指到的每一種 regions 列，SQL 都要認得（不然補完選區任務還是會派回來）", () => {
  const cases: Array<[string | null, string]> = [["台中市", "第1選區"], ["南投縣", "第二選區"], [null, "臺東縣第1選區"], ["全國", "不分區"], ["全國", "平地原住民"], ["全國", "山地原住民"]];
  for (const [region, district] of cases) {
    const key = legislatorDistrictKey(region, district)!;
    for (const sub of key.sub_regions) {
      const ok = legislatorRe.test(sub) || (key.region === "全國" && atLarge.includes(sub));
      assert(ok, `${region ?? ""}／${district} → ${key.region} ${sub}，SQL 不認得`);
    }
  }
  // 2024 線上 312 筆的實際寫法
  assertMatch("臺中市第01選區", legislatorRe);
  assertMatch("新北市第12選區", legislatorRe);
  assertEquals(legislatorRe.test("台中市"), false);
});

Deno.test("姓名鍵：SQL 的 cec_name_key 跟 cec_candidates.name_norm（TS 的 cecNameNorm）逐字相同，原住民姓名的拉丁拼音也一樣", () => {
  const keyFn = between(sql, "CREATE OR REPLACE FUNCTION cec_name_key", "COMMENT ON FUNCTION cec_name_key");
  const stripRe = new RegExp(keyFn.match(/regexp_replace\(cec_name_norm\(p\), '([^']+)', ''\)/)![1]);
  // SQL 的 cec_name_norm（20260926000003）：NFKC → 臺黄→台黃 → 去空白與間隔號
  const sqlKey = (p: string) => {
    const s = p.normalize("NFKC").replace(/臺/g, "台").replace(/黄/g, "黃").replace(/[\s·．.・‧•]/g, "").replace(stripRe, "");
    return s === "" ? null : s;
  };
  // 線上人物表的實際寫法＋中選會原字
  for (const name of ["伍麗華 Saidhai．Tahovecahe", "洪英雄Salizan.binkinuan", "蘇錦雄Paylang‧Caya", "谷辣斯．尤達卡 Kolas Yotaka", "黄珊珊", "陳臺生"]) {
    assertEquals(sqlKey(name), cecNameNorm(name), name);
  }
  assertEquals(sqlKey("Icyang"), null, "全是拉丁字母的姓名不拿來比（空字串會跟別的空字串對上）");
  // 臂裡跟 cec_candidates 比姓名的地方都要用這個鍵，不能用沒去拉丁拼音的 cec_name_norm
  for (const fnName of ["contribution_auto_tasks_region_gap", "contribution_auto_tasks_elected_missing"]) {
    const body = between(fnName === "contribution_auto_tasks_region_gap" ? regionGapSql : sql, `CREATE OR REPLACE FUNCTION ${fnName}`, `COMMENT ON FUNCTION ${fnName}`);
    assertEquals(/cec_name_norm\(/.test(body), false, `${fnName} 用了 cec_name_norm，原住民姓名會對不上`);
  }
});

Deno.test("補縣市／補選區：只管縣市長、縣市議員、立委；表態不參選的不問選區", () => {
  const body = between(regionGapSql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap", "COMMENT ON FUNCTION contribution_auto_tasks_region_gap");
  assertStringIncludes(body, "pe.election_type IN ('縣市長', '縣市議員', '立法委員')");
  assertMatch(body, /pe\.election_type IN \('縣市議員', '立法委員'\)\s+AND pe\.candidacy_status IS DISTINCT FROM 'withdrawn'/);
  assertStringIncludes(body, "pe.region_id IS NULL AS no_region");
  assertStringIncludes(body, "p.merged_into IS NULL");
  // 鄉鎮層級五種的「region_id 是空的」是 township_gap 的訊號，這裡不能搶。
  // #464（20261009050000）起代表（鄉鎮市民代表、區民代表）「只記到鄉鎮、沒有選舉區」也由這支臂派，但只放在 rep_gaps 那一段，
  // 而且那一段 INNER JOIN regions（region_id 是空的進不來）；其餘（縣市長／議員／立委那一段）仍然一個鄉鎮層級的選舉別都不能有
  const repCte = body.slice(body.indexOf("  rep_gaps AS ("), body.indexOf("  gaps AS ("));
  assert(repCte.includes("JOIN regions r ON r.id = pe.region_id") && !repCte.includes("LEFT JOIN regions") && !/region_id IS NULL/.test(repCte), "代表那一段要 INNER JOIN regions，不搶 township_gap 的 region_id 空缺");
  const rest = body.replace(repCte, "");
  for (const local of ["鄉鎮市長", "鄉鎮市民代表", "村里長", "直轄市山地原住民區長", "直轄市山地原住民區民代表"]) {
    assertEquals(rest.includes(`pe.election_type IN ('${local}'`), false);
  }
  // 中選會線索只在全國同名同選舉別唯一時給
  assertStringIncludes(body, "CASE WHEN count(*) = 1");
});

Deno.test("當選缺紀錄：只看當選、只看五種有任期政見的選舉，比對用跟 cec_candidates 同一套姓名正規化", () => {
  const body = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_elected_missing", "COMMENT ON FUNCTION contribution_auto_tasks_elected_missing");
  assertStringIncludes(body, "WHERE c.elected");
  const types = body.match(/c\.election_type IN \(([^)]+)\)/)![1];
  for (const t of ["立法委員", "縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長"]) assertStringIncludes(types, `'${t}'`);
  for (const t of ["村里長", "鄉鎮市民代表", "直轄市山地原住民區民代表"]) assertEquals(types.includes(t), false, `${t} 當選人上萬，不放這裡`);
  assertStringIncludes(body, "cec_name_key(p.name) AS nn");
  // task_id 不能用 cec_candidates.id：每週先刪後寫會換號，任務排隊位置與冷卻紀錄都會丟掉
  assertEquals(/\|\|\s*c\.id\b|\|\|\s*m\.id\b/.test(body), false);
  assertStringIncludes(body, "m.cec_cand_id");
});
