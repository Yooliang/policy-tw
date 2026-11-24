/**
 * 公報上的政見由系統直接派「從公報補政見」任務（2026-10-06，維護者點頭；migration 20261006160000）。
 *
 * 起因：a-zhen 交「查無異動」說台南安南區四草里 2022 里長吳文振查無政見，checked_urls 六個全是 google 搜尋；
 * https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf 公報裡就列了他四條政見（號次 2）。
 *
 * 守的事：
 *   1. 公報對照的規則（election-bulletin.ts）：各縣市檔名不一樣，對得到才給、對不到寧可不給
 *   2. 網址組法 TS 與 SQL 視圖同一套；吳文振那一份的網址就是維護者貼的那一個
 *   3. migration：資料段格式、吳文振那一列、派工臂沿用 term_policy_missing 與既有去重、村里長限量
 *   4. 任務現況把公報給代理看（連網站訪客請求的補政見任務也有）
 * SQL 另外在 PGlite（stub 表）整支跑過、派工臂在正式庫唯讀實跑過（見 PR 說明）。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BULLETIN_BASE,
  buildBulletinIndex,
  bulletinEntryFromHint,
  bulletinLookupNote,
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

Deno.test("吳文振那一份：台南安南四草里 → 維護者貼的那個網址", () => {
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

Deno.test("115 年（2026）：高雄資料夾叫「05里長」、台東議員檔名寫「(1、7、14選區)」", () => {
  assertEquals(districtNumbers("02-臺東市(1、7、14選區)"), [1, 7, 14]);
  assertEquals(districtNumbers("010-綠島鄉（6、11、14選區）"), [6, 11, 14]);
  const idx = buildBulletinIndex([
    "115/05高雄市/05里長/01鹽埕區/鹽埕區中原里里長.pdf",
    "115/14臺東縣/02縣議員/02-臺東市(1、7、14選區).pdf",
    "115/14臺東縣/02縣議員/03-蘭嶼鄉(2、8、16選區).pdf",
  ]);
  assert(!matchBulletin(unit("村里長", "台中市", "鹽埕區", "中原里"), idx, 2026).ok, "縣市不同不能對到");
  assertEquals(paths(matchBulletin(unit("村里長", "高雄市", "鹽埕區", "中原里"), idx, 2026)), ["115/05高雄市/05里長/01鹽埕區/鹽埕區中原里里長.pdf"]);
  assertEquals(paths(matchBulletin(unit("縣市議員", "台東縣", "第07選舉區"), idx, 2026)), ["115/14臺東縣/02縣議員/02-臺東市(1、7、14選區).pdf"]);
});

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

// 2026 公報索引（migration 20261117175329_election_bulletins_2026.sql、20261117175429_politician_bulletins_2026.sql）
const readMigration = async (name: string) => (await Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))).replace(/\r\n/g, "\n");
const IDX_2026 = await readMigration("20261117175329_election_bulletins_2026.sql");
const VIEW_2026 = await readMigration("20261117175429_politician_bulletins_2026.sql");

Deno.test("migration 2026：資料段每列 1～4 份、單位不重複、全是 115 年、ON CONFLICT 與 2022 同一組鍵", () => {
  const rows = [...IDX_2026.matchAll(/^\((\d{4}),'([^']*)','([^']*)','([^']*)','([^']*)',ARRAY\[([^\]]*)\],'([^']*)'\),?$/gm)];
  const dataLines = IDX_2026.split("\n").filter((l) => l.startsWith("(2026"));
  assertEquals(rows.length, dataLines.length, "每一行資料都要被格式正則認得，沒有漏掉的");
  assertEquals(rows.length, 7344, "對到 7,344 個單位（重跑腳本後要同步改這個數字與 PR 說明）");
  const keys = new Set<string>();
  for (const r of rows) {
    assertEquals(r[1], "2026");
    const ps = r[6].split("','").map((x) => x.replace(/^'|'$/g, ""));
    assert(ps.length >= 1 && ps.length <= 4, `${r.slice(1, 6).join("|")} 有 ${ps.length} 份`);
    for (const p of ps) assert(p.startsWith("115/"), `不是 115 年：${p}`);
    assert(!/[\s#?]/.test(r[6]), `路徑要先轉義：${r[6]}`);
    const k = r.slice(1, 6).join("|");
    assert(!keys.has(k), `單位重複：${k}`);
    keys.add(k);
  }
  assertStringIncludes(IDX_2026, "ON CONFLICT (election_id, election_type, region, sub_region, village) DO UPDATE");
  assert(!/DELETE|DROP|TRUNCATE/i.test(IDX_2026), "資料段不砍東西");
});

Deno.test("migration 2026：視圖 2022／2024 走 cec_candidates 照舊、其餘屆別走參選紀錄＋regions、退選不列", () => {
  assertStringIncludes(VIEW_2026, "WHERE m.n_match = 1");
  assertStringIncludes(VIEW_2026, "pe.election_id = ANY (ARRAY[2022, 2024])");
  assertStringIncludes(VIEW_2026, "pe.election_id <> ALL (ARRAY[2022, 2024])");
  assertStringIncludes(VIEW_2026, "pe.candidacy_status = ANY (ARRAY['filed', 'elected', 'not_elected'])");
  assertStringIncludes(VIEW_2026, "JOIN regions r ON r.id = pe.region_id");
  assertStringIncludes(VIEW_2026, "pe.cand_no");
  assertStringIncludes(VIEW_2026, `WHEN u.p LIKE '01選舉公報/%' THEN '${CENTRAL_BULLETIN_BASE}' ELSE '${BULLETIN_BASE}' END || u.p`);
});

Deno.test("migration 2026：索引保留「臺」（臺東市、霧臺鄉），視圖對 region／sub_region／village 都是原值等值、不經過 replace（才走得到唯一索引）", () => {
  assert(IDX_2026.includes("'臺東市'"), "資料段要有臺東市");
  assert(IDX_2026.includes("'霧臺鄉'"), "資料段要有霧臺鄉");
  // 只看 own 段，cec 段（2022／2024）本來就有 replace
  const own = VIEW_2026.slice(VIEW_2026.indexOf("own AS ("));
  assert(own.length > 100 && !own.includes("replace("), "own 段不能有 replace(");
  assertStringIncludes(own, "b.region = r.region");
  assertStringIncludes(own, "b.sub_region = COALESCE(r.sub_region, '')");
  assertStringIncludes(own, "b.village = COALESCE(r.village, '')");
});

Deno.test("公報入口由 elections 帶出：沒有 bulletin_dir 不附；找法說明不含年份與站名", () => {
  assertEquals(bulletinEntryFromHint("https://eebulletin.cec.gov.tw/?dir=115 ← 中選會 2026", "115"), "https://eebulletin.cec.gov.tw/?dir=115");
  assertEquals(bulletinEntryFromHint("https://eebulletin.cec.gov.tw/?dir=115 ← x", null), null);
  assertEquals(bulletinEntryFromHint(null, "115"), null);
  assertEquals(bulletinEntryFromHint("not a url ← x", "115"), null);
  const note = bulletinLookupNote("https://bulletin.cec.gov.tw/?dir=01");
  assertStringIncludes(note, "https://bulletin.cec.gov.tw/?dir=01");
  assertStringIncludes(note, "403");
  assert(!/115|111|eebulletin/.test(note), "說明本身不寫年份與站名");
});

Deno.test("current.hint：公報已上架但沒推出網址 → 找法接在既有 hint 後面；有推出網址、未上架、沒有入口都不接；不新開鍵", () => {
  const entry = "https://eebulletin.cec.gov.tw/?dir=115";
  const cur = (data: Record<string, unknown>) => shapeTaskCurrent("term_policy_missing", { politician: { id: "p" }, ...data } as never) as Record<string, unknown>;
  const note = bulletinLookupNote(entry);
  const on = cur({ bulletin_published: true, bulletin_entry: entry });
  assertStringIncludes(String(on.hint), note);
  assert(String(on.hint).startsWith(String(TASK_GUIDANCE.term_policy_missing)), "既有 hint 在前、換行接上");
  assertEquals("bulletins_lookup_note" in on, false, "不新開鍵");
  const found = cur({ bulletin_published: true, bulletin_entry: entry, bulletins: [{ urls: ["https://x/y.pdf"], election_id: 2026, election_type: "村里長" }] });
  assertEquals(String(found.hint).includes(note), false);
  assertEquals(String(cur({ bulletin_published: false, bulletin_entry: entry }).hint).includes(note), false);
  assertEquals(String(cur({ bulletin_published: true }).hint).includes(note), false);
});

// 2026-11-24：雲林縣公報站在 11-17 建索引後換過檔名，舊路徑 404（41 位鄉鎮市民代表候選人的補政見任務因此一直查無）。
// 下面的檔名取自 2026-11-24 的全站清單；莿桐、口湖、水林檔名只寫「代表N」，N 是公報開頭印的「第N選舉區」（逐份開啟確認）。
const yunlin2026 = buildBulletinIndex([
  "115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表 公報.pdf",
  "115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第一選區公報.pdf",
  "115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第二選區公報.pdf",
  "115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（三選區）-1.pdf",
  "115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（四選區）-2.pdf",
  "115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第1選區.pdf",
  "115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第2選區.pdf",
  "115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表1.pdf",
  "115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表2.pdf",
  "115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表3.pdf",
  "115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表1.pdf",
  "115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表2.pdf",
  "115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表3.pdf",
  "115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表4.pdf",
]);
const yl = (town: string) => paths(matchBulletin(unit("鄉鎮市民代表", "雲林縣", town), yunlin2026, 2026));

Deno.test("雲林 2026 鄉鎮市民代表：現行檔名對得到（二崙一鄉一份、古坑三四選區、大埤、崙背）", () => {
  assertEquals(yl("二崙鄉第05選舉區"), ["115/11雲林縣/04鄉鎮市民代表/二崙鄉/1118二崙-代表 公報.pdf"]);
  assertEquals(yl("古坑鄉第03選舉區"), ["115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（三選區）-1.pdf"]);
  assertEquals(yl("古坑鄉第04選舉區"), ["115/11雲林縣/04鄉鎮市民代表/古坑鄉/古坑鄉民代表選舉公報（四選區）-2.pdf"]);
  assertEquals(yl("大埤鄉第01選舉區"), ["115/11雲林縣/04鄉鎮市民代表/大埤鄉/大埤鄉民代表第一選區公報.pdf"]);
  assertEquals(yl("崙背鄉第02選舉區"), ["115/11雲林縣/04鄉鎮市民代表/崙背鄉/崙背鄉-第2選區.pdf"]);
});

Deno.test("雲林 2026：檔名只寫「代表N」時，第 N 份就是第 N 選舉區（莿桐、口湖、水林）", () => {
  assertEquals(yl("莿桐鄉第02選舉區"), ["115/11雲林縣/04鄉鎮市民代表/莿桐鄉/代表2.pdf"]);
  assertEquals(yl("口湖鄉第01選舉區"), ["115/11雲林縣/04鄉鎮市民代表/口湖鄉/口湖鄉民代表1.pdf"]);
  assertEquals(yl("水林鄉第04選舉區"), ["115/11雲林縣/04鄉鎮市民代表/水林鄉/水林鄉民代表4.pdf"]);
  // 沒有那一份就不給（不從別的號碼硬猜）
  assertEquals(matchBulletin(unit("鄉鎮市民代表", "雲林縣", "莿桐鄉第04選舉區"), yunlin2026, 2026).ok, false);
});

Deno.test("嘉義縣 2026：檔名是「中埔鄉第1選舉區代表」，用既有的選區號規則就對得到", () => {
  const chiayi = buildBulletinIndex([
    "115/12嘉義縣/04鄉鎮市民代表/中埔鄉第1選舉區代表.pdf",
    "115/12嘉義縣/04鄉鎮市民代表/中埔鄉第2選舉區代表.pdf",
  ]);
  assertEquals(paths(matchBulletin(unit("鄉鎮市民代表", "嘉義縣", "中埔鄉第02選舉區"), chiayi, 2026)), ["115/12嘉義縣/04鄉鎮市民代表/中埔鄉第2選舉區代表.pdf"]);
});
