/**
 * 公報上的政見由系統直接派「從公報補政見」任務（2026-10-06，小良哥點頭；migration 20261006160000）。
 *
 * 起因：a-zhen 交「查無異動」說台南安南區四草里 2022 里長吳文振查無政見，checked_urls 六個全是 google 搜尋；
 * https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf 公報裡就列了他四條政見（號次 2）。
 *
 * 守的事：
 *   1. 公報對照的規則（election-bulletin.ts）：各縣市檔名不一樣，對得到才給、對不到寧可不給
 *   2. 網址組法 TS 與 SQL 視圖同一套；吳文振那一份的網址就是小良哥貼的那一個
 *   3. migration：資料段格式、吳文振那一列、派工臂沿用 term_policy_missing 與既有去重、村里長限量
 *   4. 任務現況把公報給代理看（連網站訪客請求的補政見任務也有）
 * SQL 另外在 PGlite（stub 表）整支跑過、派工臂在正式庫唯讀實跑過（見 PR 說明）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BULLETIN_BASE,
  buildBulletinIndex,
  bulletinRelPath,
  bulletinUrl,
  CENTRAL_BULLETIN_BASE,
  districtNumbers,
  matchBulletin,
  zhNumber,
} from "./election-bulletin.ts";
import { shapeBulletins, shapeTaskCurrent } from "./task-context.ts";
import { TASK_GUIDANCE } from "./task-guidance.ts";

// 2026-10-06 兩個公報站 ?action=sitemap 清單裡的真實路徑（節錄）
const FILES = [
  "111/06臺南市/01市長/市長.pdf",
  "111/06臺南市/02市議員/第一選舉區.pdf",
  "111/06臺南市/02市議員/第七選舉區.pdf",
  "111/06臺南市/05村里長/36安南/四草里.pdf",
  "111/06臺南市/05村里長/36安南/佃東里.pdf",
  "111/06臺南市/05村里長/01後壁/01後壁區公報 - 後壁里.pdf",
  "111/08新竹縣/05村里長/【五峰鄉】村長選舉公報.pdf",
  "111/08新竹縣/03鄉鎮市長/【五峰鄉】鄉長選舉公報.pdf",
  "111/13嘉義縣/05村里長/中埔鄉第1選舉區村長.pdf",
  "111/13嘉義縣/05村里長/中埔鄉第2選舉區村長.pdf",
  "111/22新竹市/03村里長/新竹市北門聯里.pdf",
  "111/14屏東縣/02縣議員/第8、9、10、11、12選區.pdf",
  "111/14屏東縣/02縣議員/第5-7選區.pdf",
  "111/21基隆市/02市議員/01.基隆市選舉公報_第一、八選區(中正區議員、平地原住民議員).pdf",
  "111/15宜蘭縣/03鄉鎮市長/南澳鄉鄉長選舉公報/南澳鄉鄉長選舉公報.pdf",
  "111/15宜蘭縣/03鄉鎮市長/南澳鄉鄉長選舉公報/大同鄉長選舉公報/大同鄉長選舉公報.pdf",
  "111/15宜蘭縣/04鄉鎮市民代表/三星鄉鄉民代表選舉公報/三星鄉第1選舉區鄉民代表選舉公報.pdf",
  "111/15宜蘭縣/04鄉鎮市民代表/三星鄉鄉民代表選舉公報/三星鄉第２選舉區鄉民代表選舉公報.pdf",
  "111/17臺東縣/05村里長/臺東市第一選區.pdf",
  "111/17臺東縣/05村里長/臺東市第二選區.pdf",
  "111/04桃園市/04原住民區民代表/1桃園市復興鄉第一選區選舉公報(正面).pdf",
  "111/04桃園市/04原住民區民代表/1桃園市復興鄉第一選區選舉公報(背面).pdf",
  "111/04桃園市/05村里長/八德區/桃園市八德區里長大仁里.pdf",
  "111/12雲林縣/05村里長/元長鄉村長公報/元長下寮村選舉公報24.pdf",
  "111/12雲林縣/05村里長/元長鄉村長公報/元長長安村選舉公報02.pdf",
  "111/03新北市/05村里長/新莊區/新莊區中泰里立志里中港里中全里中美里中誠里中隆里中信里中華里中和里恆安里里長.pdf",
  "01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/第5選舉區/臺南市立委第5.6選舉區.pdf",
  "01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/第6選舉區/臺南市立委第5.6選舉區.pdf",
  "01選舉公報/02立法委員/113年第11屆/02區域立法委員/22新竹市/01新竹市立委選舉.pdf",
  "01選舉公報/02立法委員/113年第11屆/02區域立法委員/22新竹市/02新竹市投開票所.pdf",
];
const index = buildBulletinIndex(FILES);
const unit = (election_type: string, region: string, sub_region = "", village = "") => ({ election_type, region, sub_region, village });
const paths = (m: ReturnType<typeof matchBulletin>) => (m.ok ? m.paths : m.reason);

Deno.test("中文數字與選區號", () => {
  assertEquals([zhNumber("七"), zhNumber("十"), zhNumber("十二"), zhNumber("二十一"), zhNumber("07"), zhNumber("百")], [7, 10, 12, 21, 7, null]);
  assertEquals(districtNumbers("第1、7、14選舉區"), [1, 7, 14]);
  assertEquals(districtNumbers("第5-7選區"), [5, 6, 7]);
  assertEquals(districtNumbers("南投縣中寮鄉鄉民代表選舉第1.2.3.4選區"), [1, 2, 3, 4]);
  assertEquals(districtNumbers("01.基隆市選舉公報_第一、八選區(中正區議員)"), [1, 8], "開頭的 01. 是排序號，不算");
  assertEquals(districtNumbers("三星鄉第２選舉區"), [2], "全形數字");
  assertEquals(districtNumbers("員林市第 03選舉區"), [3], "第 後面有空白");
  assertEquals(districtNumbers("臺南市第一選區公報"), [1]);
  assertEquals(districtNumbers("市長選舉公報"), []);
});

Deno.test("吳文振那一份：台南安南四草里 → 小良哥貼的那個網址", () => {
  const m = matchBulletin(unit("村里長", "台南市", "安南區", "四草里"), index);
  assertEquals(paths(m), ["111/06臺南市/05村里長/36安南/四草里.pdf"]);
  assertEquals(bulletinUrl("111/06臺南市/05村里長/36安南/四草里.pdf"), "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf");
});

Deno.test("一村里一檔、一鄉鎮一檔都對得到；檔名的村里名前面要是邊界（長安村不能算安村）", () => {
  assertEquals(paths(matchBulletin(unit("村里長", "台南市", "後壁區", "後壁里"), index)), ["111/06臺南市/05村里長/01後壁/01後壁區公報 - 後壁里.pdf"]);
  assertEquals(paths(matchBulletin(unit("村里長", "新竹縣", "五峰鄉", "桃山村"), index)), ["111/08新竹縣/05村里長/【五峰鄉】村長選舉公報.pdf"], "一鄉鎮一檔");
  assertEquals(paths(matchBulletin(unit("村里長", "桃園市", "八德區", "大仁里"), index)), ["111/04桃園市/05村里長/八德區/桃園市八德區里長大仁里.pdf"], "「里長大仁里」");
  assertEquals(paths(matchBulletin(unit("村里長", "雲林縣", "元長鄉", "下寮村"), index)), ["111/12雲林縣/05村里長/元長鄉村長公報/元長下寮村選舉公報24.pdf"], "「元長下寮村」");
  assert(!matchBulletin(unit("村里長", "雲林縣", "元長鄉", "安村"), index).ok, "「長安村」裡的「安村」不算");
  assertEquals(paths(matchBulletin(unit("村里長", "新北市", "新莊區", "中信里"), index)).length, 1, "多里合印的檔名");
});

Deno.test("推不出來的不給：依選區分檔看不出村里在哪一區、聯合里、只有別的村里的檔", () => {
  const split = matchBulletin(unit("村里長", "嘉義縣", "中埔鄉", "中埔村"), index);
  assert(!split.ok && split.reason.includes("依選區"), String(!split.ok && split.reason));
  assert(!matchBulletin(unit("村里長", "新竹市", "北區", "北門里"), index).ok, "新竹市北門聯里：不知道含哪些里");
  assert(!matchBulletin(unit("村里長", "台南市", "安南區", "城中里"), index).ok, "安南區是一里一檔，沒有城中里的檔就不給");
  assert(!matchBulletin(unit("村里長", "台東縣", "台東市", "中山里"), index).ok, "臺東市依選區分檔");
});

Deno.test("議員：合印的選區、範圍、中文數字；縣市長一份", () => {
  assertEquals(paths(matchBulletin(unit("縣市議員", "屏東縣", "第10選舉區"), index)), ["111/14屏東縣/02縣議員/第8、9、10、11、12選區.pdf"]);
  assertEquals(paths(matchBulletin(unit("縣市議員", "屏東縣", "第06選舉區"), index)), ["111/14屏東縣/02縣議員/第5-7選區.pdf"]);
  assertEquals(paths(matchBulletin(unit("縣市議員", "台南市", "第07選舉區"), index)), ["111/06臺南市/02市議員/第七選舉區.pdf"]);
  assertEquals(paths(matchBulletin(unit("縣市議員", "基隆市", "第08選舉區"), index)).length, 1);
  assertEquals(paths(matchBulletin(unit("縣市長", "台南市"), index)), ["111/06臺南市/01市長/市長.pdf"]);
});

Deno.test("鄉鎮：只看檔名與上一層資料夾（大同鄉的公報放在南澳鄉資料夾底下）；復興區的公報寫復興鄉；代表依選區", () => {
  assertEquals(paths(matchBulletin(unit("鄉鎮市長", "宜蘭縣", "南澳鄉"), index)), ["111/15宜蘭縣/03鄉鎮市長/南澳鄉鄉長選舉公報/南澳鄉鄉長選舉公報.pdf"]);
  assertEquals(paths(matchBulletin(unit("鄉鎮市民代表", "宜蘭縣", "三星鄉第02選舉區"), index)), ["111/15宜蘭縣/04鄉鎮市民代表/三星鄉鄉民代表選舉公報/三星鄉第２選舉區鄉民代表選舉公報.pdf"]);
  assertEquals(paths(matchBulletin(unit("直轄市山地原住民區民代表", "桃園市", "復興區第01選舉區"), index)).length, 2, "正反面兩份");
  assertEquals(paths(matchBulletin(unit("鄉鎮市長", "新竹縣", "五峰鄉"), index)), ["111/08新竹縣/03鄉鎮市長/【五峰鄉】鄉長選舉公報.pdf"]);
});

Deno.test("2024 區域立委在 bulletin.cec.gov.tw：選區資料夾優先；投開票所一覽不是公報", () => {
  assertEquals(paths(matchBulletin(unit("立法委員", "台南市", "台南市第06選區"), index, 2024)), ["01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/第6選舉區/臺南市立委第5.6選舉區.pdf"]);
  assertEquals(paths(matchBulletin(unit("立法委員", "新竹市", "新竹市第01選區"), index, 2024)), ["01選舉公報/02立法委員/113年第11屆/02區域立法委員/22新竹市/01新竹市立委選舉.pdf"]);
  assert(bulletinUrl("01選舉公報/02立法委員/113年第11屆/02區域立法委員/22新竹市/01新竹市立委選舉.pdf").startsWith(CENTRAL_BULLETIN_BASE));
  assert(!matchBulletin(unit("縣市長", "台南市"), index, 2026).ok, "2026 還沒有公報");
});

Deno.test("存進資料庫的路徑：中文照原樣、空白轉 %20", () => {
  assertEquals(bulletinRelPath("111/06臺南市/05村里長/01後壁/01後壁區公報 - 後壁里.pdf"), "111/06臺南市/05村里長/01後壁/01後壁區公報%20-%20後壁里.pdf");
  assertEquals(bulletinRelPath("a/b(正面)#1.pdf"), "a/b(正面)%231.pdf");
});

// ---- migration ----
const MIGRATION = "20261006160000_bulletin_policy_tasks.sql";
const sql = (await Deno.readTextFile(new URL(`../../migrations/${MIGRATION}`, import.meta.url))).replace(/\r\n/g, "\n");

Deno.test("migration：資料段格式、吳文振那一列、每列 1～4 份、單位不重複", () => {
  const rows = [...sql.matchAll(/^\((\d{4}),'([^']*)','([^']*)','([^']*)','([^']*)',ARRAY\[([^\]]*)\],'([^']*)'\),?$/gm)];
  assert(rows.length > 7000, `資料段 ${rows.length} 列`);
  const keys = new Set<string>();
  for (const r of rows) {
    const n = r[6].split("','").length;
    assert(n >= 1 && n <= 4, `${r[0]} 有 ${n} 份`);
    const k = r.slice(1, 6).join("|");
    assert(!keys.has(k), `單位重複：${k}`);
    keys.add(k);
    assert(!/[\s#?]/.test(r[6]), `路徑要先轉義：${r[6]}`);
  }
  assertStringIncludes(sql, "(2022,'村里長','台南市','安南區','四草里',ARRAY['111/06臺南市/05村里長/36安南/四草里.pdf'],'一村里一份')");
});

Deno.test("migration：視圖組網址的兩個站跟 TS 同一套；同名多人不給", () => {
  assertStringIncludes(sql, `WHEN u.p LIKE '01選舉公報/%' THEN '${CENTRAL_BULLETIN_BASE}' ELSE '${BULLETIN_BASE}' END || u.p`);
  assertStringIncludes(sql, "WHERE m.n_match = 1");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION politician_bulletins_for(UUID) TO anon, authenticated");
});

Deno.test("migration：派工臂沿用 term_policy_missing、task_id 不變、去重照舊、村里長限量、不動派工總表", () => {
  const arm = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()"));
  const flat = arm.replace(/\s+/g, " ");
  assertStringIncludes(flat, "'auto:term_policy_missing:' || i0.politician_id || ':' || i0.election_id");
  assertStringIncludes(flat, "'term_policy_missing'");
  assertStringIncludes(flat, "c.election_id = 2026 AND c.candidate_status NOT IN ('not_running')");
  assertStringIncludes(flat, "pl.election_id = i0.election_id AND pl.removed_at IS NULL");
  assertStringIncludes(flat, "term_policy_village_cap()");
  assertStringIncludes(flat, "'bulletin_urls', to_jsonb(x.urls), 'cand_no', x.cand_no");
  assertStringIncludes(flat, "號次");
  assertStringIncludes(flat, "逐條");
  assert(!sql.includes("FUNCTION contribution_auto_tasks_arms"), "不重寫派工總表（同時有別的 PR 在改），只改這一支臂");
  assertStringIncludes(sql, "SELECT 300");
});

// ---- 任務現況 ----
const BUL = [{ election_id: 2022, election_type: "村里長", cand_no: 2, elected: false, region: "台南市", sub_region: "安南區", village: "四草里", urls: ["https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf"] }];

Deno.test("任務現況：補政見（含網站訪客請求）有公報就給 bulletins 與說明；沒有就不附", () => {
  const s = shapeBulletins(BUL)!;
  assertEquals(s.bulletins[0].unit, "台南市 安南區 四草里");
  assertStringIncludes(s.bulletins_note, "號次 2");
  assertStringIncludes(s.bulletins_note, "四草里.pdf");
  assertEquals(shapeBulletins([]), null);
  assertEquals(shapeBulletins([{ ...BUL[0], urls: [] }]), null);
  const cur = shapeTaskCurrent("policy_missing", { politician: { id: "x", name: "吳文振" }, bulletins: BUL }, { task_id: "42e4ee7c-369c-473f-8bdc-9c851b366758", target: {} });
  assert(Array.isArray(cur.bulletins));
  const none = shapeTaskCurrent("term_policy_missing", { politician: { id: "x", name: "某人" } }, { task_id: "auto:term_policy_missing:x:2022", target: {} });
  assertEquals(none.bulletins, undefined);
  assertStringIncludes(TASK_GUIDANCE.term_policy_missing, "bulletin_urls");
  assertStringIncludes(TASK_GUIDANCE.policy_missing, "bulletins");
});
