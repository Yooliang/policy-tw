/**
 * 名冊對帳修正（20261020030100，#678 #689 試跑後）：異體字正規化＋同單位先比對。
 *
 * 試跑出的兩筆重複人物：
 *   (1) 名冊「張啓楷」（嘉義市長）／站上「張啟楷」（已有 2026 嘉義市長參選紀錄）——異體字 啓／啟 沒正規化，被判成「我們漏了」；
 *   (2) 名冊「王妃天崩開局穿越整頓霸凌者佀廣洋」（桃園市議員，法定全名）／站上「佀廣洋」同職位 2026 參選紀錄——全名與暱稱沒處理。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applySystemCandidacy } from "./apply-contribution.ts";
import { FOLD_PAIRS, foldNameVariants, rosterNameKey } from "./identity-normalize.ts";
import { mutate, readMig } from "./arms-pglite.ts";
import { addOurs, addPerson, buildReconcileDb, byName, FIX_MIG_NAME, loadRegs, reconcile } from "./roster-reconcile-pglite.ts";

const MAYOR = "縣市長";
const COUNCIL = "縣市議員";
const VILLAGE = "村里長";
const LONG = "王妃天崩開局穿越整頓霸凌者佀廣洋";

async function seed(editFix?: (m: string) => string) {
  const { db } = await buildReconcileDb(undefined, editFix);
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new', 'attach']`);
  await loadRegs(db, [
    { type: MAYOR, region: "嘉義市", name: "張啓楷" },                                             // 異體字：站上是「張啟楷」
    { type: COUNCIL, region: "桃園市", name: "佀廣洋", district: "第01選舉區" },                  // 正式庫的名冊真的同時有「佀廣洋」與下一列的全名：前者對上站上那筆
    { type: COUNCIL, region: "桃園市", name: LONG, district: "第01選舉區" },                       // 全名：站上是「佀廣洋」
    { type: COUNCIL, region: "台北市", name: "王大明" },                                           // 單字名不算子字串（站上「王」只有 1 字）
    { type: COUNCIL, region: "台北市", name: "李" },                                               // 名冊只有 1 字（站上「李大華」）也不算
    { type: COUNCIL, region: "台中市", name: LONG },                                               // 不同縣市：站上的佀廣洋在桃園，不受影響
    { type: VILLAGE, region: "新北市", sub: "三重區", village: "甲里", name: "陳大文大" },          // 站上的「陳大文」在板橋區：鄉鎮不同，不受影響
    { type: VILLAGE, region: "新北市", sub: "板橋區", village: "乙里", name: "趙大衛大" },          // 站上的「趙大衛」在板橋區：同鄉鎮，名字是子字串 → 派代理
    { type: COUNCIL, region: "高雄市", name: "吳明德" },                                           // 站上已經有一筆「吳明德」對上它
    { type: COUNCIL, region: "高雄市", name: "吳明德明" },   // 站上的吳明德雖然已經對上名冊的吳明德，名字仍是這位的子字串 → 派代理（寧可多問，不要多建一個人）
    { type: COUNCIL, region: "台南市", name: "林峰" },                                             // 全庫有「林峯」（異體字）：不能當成沒有同名者而新建
    { type: COUNCIL, region: "台南市", name: "黃志" },                                             // 子字串剛好 2 字（站上「黃志偉」）→ 派代理
  ]);
  await addOurs(db, { name: "張啟楷", type: MAYOR, status: "filed", region: "嘉義市" });
  await addOurs(db, { name: "佀廣洋", type: COUNCIL, status: "filed", region: "桃園市", sub: "第01選舉區" });
  await addOurs(db, { name: "王", type: COUNCIL, status: "filed", region: "台北市" });
  await addOurs(db, { name: "李大華", type: COUNCIL, status: "filed", region: "台北市" });
  await addOurs(db, { name: "陳大文", type: VILLAGE, status: "filed", region: "新北市", sub: "板橋區" });
  await addOurs(db, { name: "趙大衛", type: VILLAGE, status: "filed", region: "新北市", sub: "板橋區" });
  await addOurs(db, { name: "吳明德", type: COUNCIL, status: "filed", region: "高雄市" });
  await addOurs(db, { name: "黃志偉", type: COUNCIL, status: "filed", region: "台南市" });
  await addPerson(db, "林峯", { region: "台南市", past: { election: 2022, type: COUNCIL, region: "台南市" } });
  return db;
}

Deno.test("M1 張啓楷／張啟楷：異體字正規化後相同＝都對上，不建人物", async () => {
  const db = await seed();
  const rows = await reconcile(db);
  const r = byName(rows, "張啓楷")[0];
  assertEquals([r.category, r.reason, r.person_action], ["both", null, null]);
  assert(r.pe_id !== null, "帶出站上那一筆參選紀錄");
  assert(!(await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_next(500)`)).rows.some((x) => x.name === "張啓楷"));
  await db.close();
});

Deno.test("M2 佀廣洋全名：同單位已有名字是子字串的紀錄 → 不建，派代理（similar_name_in_unit），站上那筆不再另列成我們多出來", async () => {
  const db = await seed();
  const rows = await reconcile(db);
  const long = rows.filter((r) => r.name === LONG && r.county === "桃園市");
  assertEquals(long.length, 1);
  assertEquals([long[0].category, long[0].reason, long[0].person_action], ["missing_ambiguous", "similar_name_in_unit", null]);
  assert(long[0].pe_id !== null && long[0].politician_id !== null, "帶出站上那一筆，代理才看得到是誰");
  assertEquals(byName(rows, "佀廣洋")[0].category, "both", "名冊的「佀廣洋」那一列對上站上那筆");
  assertEquals(long[0].pe_id, byName(rows, "佀廣洋")[0].pe_id, "全名那一列帶出的就是同一筆參選紀錄");
  const next = (await db.query<{ name: string; county: string }>(`SELECT name, county FROM roster_reconcile_next(500)`)).rows;
  assert(!next.some((x) => x.name === LONG && x.county === "桃園市"), "不在系統要建的清單裡");
  await db.close();
});

Deno.test("M3 子字串規則：較短的一方至少 2 字；單字不算、不同單位不受影響；已對上名冊別列的紀錄也算（名冊真的會有「佀廣洋」與全名兩列）", async () => {
  const db = await seed();
  const rows = await reconcile(db);
  const cat = (name: string, county: string) => rows.filter((r) => r.name === name && r.county === county).map((r) => [r.category, r.reason]);
  // 台北市還有站上沒對上名冊的「王」「李大華」，所以 new 被安全網擋（unmatched_candidacy_in_unit）——重點是 reason 不是 similar_name_in_unit
  assertEquals(cat("王大明", "台北市"), [["missing_ambiguous", "unmatched_candidacy_in_unit"]], "站上「王」只有 1 字，不算子字串（被擋的是安全網）");
  assertEquals(cat("李", "台北市"), [["missing_ambiguous", "unmatched_candidacy_in_unit"]], "名冊只有 1 字也不算子字串");
  assertEquals(cat(LONG, "台中市"), [["missing_creatable", null]], "不同縣市的同職位紀錄不擋");
  assertEquals(cat("陳大文大", "新北市"), [["missing_creatable", null]], "鄉鎮層級的選舉：不同鄉鎮不擋");
  assertEquals(cat("趙大衛大", "新北市"), [["missing_ambiguous", "similar_name_in_unit"]], "同鄉鎮、子字串 → 派代理");
  assertEquals(cat("吳明德明", "高雄市"), [["missing_ambiguous", "similar_name_in_unit"]], "站上的吳明德已對上名冊的吳明德，但仍是這位的子字串 → 派代理");
  assertEquals(cat("黃志", "台南市"), [["missing_ambiguous", "similar_name_in_unit"]], "剛好 2 字的子字串算");
  await db.close();
});

Deno.test("M4 新建人物前也用異體字正規化後的名字查全庫同名：全庫有「林峯」，名冊「林峰」不當成全新的人（掛上去，不新建）", async () => {
  const db = await seed();
  const r = byName(await reconcile(db), "林峰")[0];
  assertEquals([r.category, r.person_action], ["missing_creatable", "attach"]);
  assert(r.politician_id !== null);
  await db.close();
});

Deno.test("M5 已撤回的兩位：修好後張啓楷對上站上的張啟楷（不看 log）、佀廣洋全名落在 similar_name_in_unit，都不會再被建", async () => {
  const db = await seed();
  for (const name of ["張啓楷", LONG]) {
    const { rows: [x] } = await db.query<{ id: string }>(`SELECT id::text FROM cec_registrations WHERE name = $1 AND region IN ('嘉義市', '桃園市')`, [name]);
    await db.query(`INSERT INTO roster_reconcile_log (reg_id, run_id, outcome, source_url, row_no, agent_name, reverted_at, reverted_by)
                    VALUES ($1, gen_random_uuid(), 'applied', 'https://example.test/x.pdf', 1, 'system:roster-reconcile', now(), 'maintainer')`, [x.id]);
  }
  const rows = await reconcile(db);
  assertEquals(byName(rows, "張啓楷")[0].category, "both");
  const long = rows.filter((r) => r.name === LONG && r.county === "桃園市")[0];
  assertEquals([long.category, long.reason], ["missing_ambiguous", "similar_name_in_unit"]);
  const next = (await db.query<{ name: string; county: string }>(`SELECT name, county FROM roster_reconcile_next(500)`)).rows;
  assert(!next.some((x) => x.name === "張啓楷" || (x.name === LONG && x.county === "桃園市")));
  await db.close();
});

Deno.test("M6 單位彙總與任務說明：similar_name_in_unit 有中文標籤、帶出名字", async () => {
  const db = await seed();
  await db.exec(`SELECT roster_reconcile_refresh_units()`);
  const { rows: [tx] } = await db.query<{ t: string }>(`SELECT roster_reconcile_text(roster_reconcile_unit(2026, '${COUNCIL}', '桃園市')) AS t`);
  assert(tx.t.includes("同單位已有名字相近的紀錄") && tx.t.includes("佀廣洋"), tx.t);
  await db.close();
});

Deno.test("M7 SQL 與 TS 的異體字對照同一份；TS 掛上既有人物時異體字不算姓名對不上", async () => {
  const sql = await readMig(FIX_MIG_NAME);
  const m = /translate\(p, '([^']+)', '([^']+)'\)/.exec(sql);
  assert(m, "找不到 roster_name_fold 的 translate");
  assertEquals([...m[1]], FOLD_PAIRS.map(([a]) => a));
  assertEquals([...m[2]], FOLD_PAIRS.map(([, b]) => b));
  assertEquals(foldNameVariants("張啓楷"), "張啟楷");
  assertEquals(foldNameVariants("林峯"), "林峰");
  // 掛上既有人物：名冊「張啓楷」、站上「張啟楷」→ 不是 disputed
  const PID = "11111111-1111-4111-8111-111111111111";
  const { client, db } = createFakeSupabase({
    regions: [{ id: 900, region: "嘉義市", sub_region: null, village: null }],
    politicians: [{ id: PID, name: "張啟楷", merged_into: null }], politician_elections: [],
  });
  const out = await applySystemCandidacy(client, {
    agent_name: "system:roster-reconcile", source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"], resolved_politician_id: PID,
    payload: { name: "張啓楷", election_id: 2026, election_type: "縣市長", region: "嘉義市", candidate_status: "registered" },
  });
  assertEquals(out.status, "applied");
  assertEquals(db.politicians.length, 1, "沒有新建人物");
  // 真的不同人仍然擋
  const other = createFakeSupabase({ politicians: [{ id: PID, name: "王大明", merged_into: null }], politician_elections: [], regions: [] });
  const bad = await applySystemCandidacy(other.client, {
    agent_name: "system:roster-reconcile", source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"], resolved_politician_id: PID,
    payload: { name: "張啓楷", election_id: 2026, election_type: "縣市長", region: "嘉義市", candidate_status: "registered" },
  });
  assertEquals(bad.status, "disputed");
});

Deno.test("M8 還原驗證：把修正拿掉，指定的情境必須轉紅", async () => {
  type Rows = Awaited<ReturnType<typeof reconcile>>;
  const first = (rows: Rows, name: string, county?: string) => rows.filter((r) => r.name === name && (!county || r.county === county))[0];
  const MUT: Array<{ name: string; edit: (m: string) => string; red: (r: Rows) => boolean }> = [
    { name: "異體字不正規化", edit: (m) => m.replace(/SELECT translate\(p, '[^']+', '[^']+'\)/, "SELECT p"),
      red: (r) => first(r, "張啓楷").category !== "both" },
    { name: "拿掉同單位先比對", edit: (m) => mutate(m, "             WHEN sm.reg_id IS NOT NULL THEN 'missing_ambiguous'\n", ""),
      red: (r) => first(r, LONG, "桃園市").category === "missing_creatable" },
    { name: "子字串長度不要求 2 字", edit: (m) => mutate(m, "AND ((length(o.nn) >= 2 AND strpos(g.name_key, o.nn) > 0) OR (length(g.name_key) >= 2 AND strpos(o.nn, g.name_key) > 0))", "AND (strpos(g.name_key, o.nn) > 0 OR strpos(o.nn, g.name_key) > 0)"),
      red: (r) => first(r, "王大明", "台北市").reason === "similar_name_in_unit" },
    { name: "同單位比對不分縣市", edit: (m) => mutate(m, "      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type AND o.county = g.county\n", "      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type\n"),
      red: (r) => first(r, LONG, "台中市").category !== "missing_creatable" },
    { name: "同單位比對不看鄉鎮", edit: (m) => mutate(m, "                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)\n                 AND (g.election_type <> '縣市議員' OR o.district IS NULL OR g.district IS NULL OR o.district = g.district)\n     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL", "                 AND (g.election_type <> '縣市議員' OR o.district IS NULL OR g.district IS NULL OR o.district = g.district)\n     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL"),
      red: (r) => first(r, "陳大文大", "新北市").category !== "missing_creatable" },
    { name: "同單位比對只看還沒對上的紀錄", edit: (m) => mutate(m, "     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key\n", "     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key AND o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)\n"),
      red: (r) => first(r, LONG, "桃園市").category === "missing_creatable" },
    { name: "全庫同名查詢不用正規化鍵", edit: (m) => mutate(m, "    SELECT p.id, roster_name_key(p.name) AS nn, replace(p.region", "    SELECT p.id, COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) AS nn, replace(p.region"),
      red: (r) => first(r, "林峰").person_action !== "attach" },
    { name: "sim 把站上那筆從我們多出來移除", edit: (m) => mutate(m, "           NULL::TEXT AS person_action, FALSE AS system_applied\n      FROM ours o\n     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)\n", "           NULL::TEXT AS person_action, FALSE AS system_applied\n      FROM ours o\n     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)\n       AND o.pe_id NOT IN (SELECT s2.pe_id FROM sim s2)\n"),
      red: (r) => !r.some((x) => x.name === "黃志偉" && x.category === "ours_extra") },
  ];
  for (const m of MUT) {
    const db = await seed(m.edit);
    const rows = await reconcile(db);
    assert(m.red(rows), `還原驗證「${m.name}」：指定的情境應該轉紅`);
    await db.close();
  }
});

// ── agy 審查（#708）後加：安全網、選舉區、尾端羅馬拼音、黄、ours_extra 不被 sim 移除 ──────────────────────
async function seed2(editFix?: (m: string) => string) {
  const { db } = await buildReconcileDb(undefined, editFix);
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new', 'attach']`);
  await loadRegs(db, [
    { type: COUNCIL, region: "台東縣", name: "趙甲甲", district: "第01選舉區" },   // 站上「趙甲」在第 02 選舉區：選舉區不同 → 不算相近、安全網也不擋 → 可建 new
    { type: COUNCIL, region: "台東縣", name: "趙甲乙", district: "第02選舉區" },   // 同選舉區、子字串 → similar_name_in_unit
    { type: COUNCIL, region: "台東縣", name: "錢乙", district: "第02選舉區" },     // 同選舉區還有站上沒對上的紀錄 → 安全網擋 new（unmatched_candidacy_in_unit）
    { type: COUNCIL, region: "台東縣", name: "孫戊", district: "第02選舉區" },     // 全庫剛好一位同名者在台東縣出現過 → attach 不受安全網影響
    { type: MAYOR, region: "宜蘭縣", name: "鄭萬正" },                              // 站上「鄭萬正Ipay-Kaeti」（尾端羅馬拼音）→ 都對上
    { type: COUNCIL, region: "苗栗縣", name: "黄某某" },                            // 站上「黃某某」（黄／黃）→ 掛上去
    { type: COUNCIL, region: "苗栗縣", name: "新甲" },                              // 苗栗縣沒有任何未對上的紀錄、全庫沒有同名者 → new
  ]);
  await addOurs(db, { name: "趙甲", type: COUNCIL, status: "filed", region: "台東縣", sub: "第02選舉區" });
  await addOurs(db, { name: "鄭萬正Ipay-Kaeti", type: MAYOR, status: "filed", region: "宜蘭縣" });
  await addPerson(db, "孫戊", { region: "台東縣", past: { election: 2022, type: COUNCIL, region: "台東縣" } });
  await addPerson(db, "黃某某", { region: "苗栗縣", past: { election: 2022, type: COUNCIL, region: "苗栗縣" } });
  return db;
}

Deno.test("M9 安全網：同單位還有站上沒對上名冊的紀錄，就不給 new（派代理）；attach、別的單位不受影響；選舉區不同不擋", async () => {
  const db = await seed2();
  const rows = await reconcile(db);
  const r = (name: string) => byName(rows, name)[0];
  assertEquals([r("錢乙").category, r("錢乙").reason, r("錢乙").person_action], ["missing_ambiguous", "unmatched_candidacy_in_unit", null]);
  assertEquals([r("趙甲甲").category, r("趙甲甲").person_action], ["missing_creatable", "new"], "選舉區不同：不算相近、安全網也不擋");
  assertEquals([r("孫戊").category, r("孫戊").person_action], ["missing_creatable", "attach"], "attach 不受安全網影響");
  assertEquals([r("新甲").category, r("新甲").person_action], ["missing_creatable", "new"], "沒有未對上紀錄的單位照建");
  const next = (await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_next(500)`)).rows.map((x) => x.name);
  assert(!next.includes("錢乙") && next.includes("新甲"));
  // 單位彙總：被安全網擋下的人在 people 裡，有中文標籤
  await db.exec(`SELECT roster_reconcile_refresh_units()`);
  const { rows: [tx] } = await db.query<{ t: string }>(`SELECT roster_reconcile_text(roster_reconcile_unit(2026, '${COUNCIL}', '台東縣')) AS t`);
  assert(tx.t.includes("錢乙") && tx.t.includes("對不上名冊的紀錄"), tx.t);
  await db.close();
});

Deno.test("M10 縣市議員的子字串比對雙方都有選舉區時必須同選舉區", async () => {
  const db = await seed2();
  const rows = await reconcile(db);
  const r = (name: string) => byName(rows, name)[0];
  assertEquals([r("趙甲乙").category, r("趙甲乙").reason], ["missing_ambiguous", "similar_name_in_unit"], "同選舉區、子字串");
  assertEquals(r("趙甲甲").reason, null, "不同選舉區：不算相近");
  await db.close();
});

Deno.test("M11 尾端羅馬拼音：「鄭萬正Ipay-Kaeti」與「鄭萬正」直接對上（both），不用派代理", async () => {
  const db = await seed2();
  const r = byName(await reconcile(db), "鄭萬正")[0];
  assertEquals([r.category, r.reason], ["both", null]);
  await db.close();
});

Deno.test("M12 名冊「黄某某」掛上站上「黃某某」：SQL 判 attach，TS 落庫（applySystemCandidacy）不誤判 disputed；中間點與尾端拼音也不誤判", async () => {
  const db = await seed2();
  const r = byName(await reconcile(db), "黄某某")[0];
  assertEquals([r.category, r.person_action], ["missing_creatable", "attach"]);
  assert(r.politician_id !== null);
  await db.close();
  const PID = "22222222-2222-4222-8222-222222222222";
  const apply = async (siteName: string, regName: string) => {
    const { client, db: fake } = createFakeSupabase({
      regions: [{ id: 900, region: "苗栗縣", sub_region: null, village: null }],
      politicians: [{ id: PID, name: siteName, merged_into: null }], politician_elections: [],
    });
    const out = await applySystemCandidacy(client, {
      agent_name: "system:roster-reconcile", source_urls: ["https://web.cec.gov.tw/api/file/x.pdf"], resolved_politician_id: PID,
      payload: { name: regName, election_id: 2026, election_type: "縣市議員", region: "苗栗縣", candidate_status: "registered" },
    });
    return { out, people: fake.politicians.length };
  };
  for (const [site, reg] of [["黃某某", "黄某某"], ["谷辣斯·尤達卡", "谷辣斯．尤達卡"], ["鄭萬正", "鄭萬正Ipay-Kaeti"], ["鄭萬正Ipay-Kaeti", "鄭萬正"], ["張啟楷", "張啓楷"], ["谷辣斯・尤達卡", "谷辣斯·尤達卡"]]) {
    const { out, people } = await apply(site, reg);
    assertEquals([out.status, people], ["applied", 1], `${reg} 掛上 ${site}：${out.message}`);
  }
  const { out } = await apply("王大明", "黄某某");
  assertEquals(out.status, "disputed", "真的不同人仍然擋");
});

Deno.test("M13 TS rosterNameKey 與 SQL roster_name_key 同一套（逐字比對一批寫法）；杰／傑、堃／坤 不摺疊", async () => {
  const { db } = await buildReconcileDb();
  const samples = ["張啓楷", "鄭萬正Ipay-Kaeti", "谷辣斯．尤達卡", "谷辣斯·尤達卡", "黄某某", "林峯", "游錫堃", "邱威杰", "强某", "勛某", "傅崐萁", "Kolas Yotaka", "臺北 王", "Ka'ay-Lin", ""];
  for (const s of samples) {
    const { rows: [x] } = await db.query<{ k: string | null }>(`SELECT roster_name_key($1) AS k`, [s]);
    assertEquals(rosterNameKey(s), x.k, `「${s}」TS 與 SQL 的姓名鍵要一樣`);
  }
  assertEquals(rosterNameKey("游錫堃"), "游錫堃", "堃不摺疊成坤（在台灣是不同的字）");
  assertEquals(rosterNameKey("邱威杰"), "邱威杰", "杰不摺疊成傑");
  assertEquals(rosterNameKey("鄭萬正Ipay-Kaeti"), "鄭萬正");
  assertEquals(rosterNameKey("Kolas Yotaka"), "KolasYotaka", "全是拉丁字母的原樣留著（去空白）");
  await db.close();
});

Deno.test("M14 站上沒對上名冊的紀錄仍然列在 ours_extra（sim 只影響不建，不把它從清查清單移除）", async () => {
  const db = await seed();
  const rows = await reconcile(db);
  const extra = rows.filter((r) => r.name === "黃志偉");
  assertEquals(extra.map((r) => [r.category, r.reason]), [["ours_extra", "not_in_registration"]]);
  assertEquals(byName(rows, "黃志")[0].reason, "similar_name_in_unit", "名冊那一列同時照樣標相近");
  await db.close();
});

Deno.test("M15 還原驗證（審查後加的）：安全網、選舉區、尾端拼音拿掉，指定的情境必須轉紅", async () => {
  type Rows = Awaited<ReturnType<typeof reconcile>>;
  const r1 = (rows: Rows, name: string) => byName(rows, name)[0];
  const MUT: Array<{ name: string; edit: (m: string) => string; red: (r: Rows) => boolean }> = [
    { name: "拿掉安全網", edit: (m) => mutate(m, "             WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'missing_ambiguous'\n", ""),
      red: (r) => r1(r, "錢乙").category === "missing_creatable" },
    { name: "安全網不看選舉區", edit: (m) => mutate(m, "                AND (g.election_type <> '縣市議員' OR u.district IS NULL OR g.district IS NULL OR u.district = g.district)\n", ""),
      red: (r) => r1(r, "趙甲甲").category !== "missing_creatable" },
    { name: "子字串比對不看選舉區", edit: (m) => mutate(m, "                 AND (g.election_type <> '縣市議員' OR o.district IS NULL OR g.district IS NULL OR o.district = g.district)\n", ""),
      red: (r) => r1(r, "趙甲甲").reason === "similar_name_in_unit" },
    { name: "不去尾端羅馬拼音", edit: (m) => mutate(m, "'[-''A-Za-z]+$'", "'^$'"),
      red: (r) => r1(r, "鄭萬正").category !== "both" },
    { name: "安全網連 attach 也擋", edit: (m) => mutate(m, "WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'missing_ambiguous'", "WHEN uh.reg_id IS NOT NULL THEN 'missing_ambiguous'"),
      red: (r) => r1(r, "孫戊").category !== "missing_creatable" },
  ];
  for (const m of MUT) {
    const db = await seed2(m.edit);
    const rows = await reconcile(db);
    assert(m.red(rows), `還原驗證「${m.name}」：指定的情境應該轉紅`);
    await db.close();
  }
});
