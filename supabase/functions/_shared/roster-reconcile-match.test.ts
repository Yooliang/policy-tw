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
import { FOLD_PAIRS, foldNameVariants } from "./identity-normalize.ts";
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
  assertEquals(cat("王大明", "台北市"), [["missing_creatable", null]], "站上「王」只有 1 字，不算子字串");
  assertEquals(cat("李", "台北市"), [["missing_creatable", null]], "名冊只有 1 字也不算");
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
      red: (r) => first(r, "王大明", "台北市").category !== "missing_creatable" },
    { name: "同單位比對不分縣市", edit: (m) => mutate(m, "JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type AND o.county = g.county\n                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)\n     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL", "JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type\n                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)\n     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL"),
      red: (r) => first(r, LONG, "台中市").category !== "missing_creatable" },
    { name: "同單位比對不看鄉鎮", edit: (m) => mutate(m, "                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)\n     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL", "     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL"),
      red: (r) => first(r, "陳大文大", "新北市").category !== "missing_creatable" },
    { name: "同單位比對只看還沒對上的紀錄", edit: (m) => mutate(m, "     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key\n", "     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key AND o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)\n"),
      red: (r) => first(r, LONG, "桃園市").category === "missing_creatable" },
    { name: "全庫同名查詢不用正規化鍵", edit: (m) => mutate(m, "    SELECT p.id, roster_name_key(p.name) AS nn, replace(p.region", "    SELECT p.id, COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) AS nn, replace(p.region"),
      red: (r) => first(r, "林峰").person_action !== "attach" },
    { name: "站上那筆還是列成我們多出來", edit: (m) => mutate(m, "       AND o.pe_id NOT IN (SELECT s2.pe_id FROM sim s2)", "       AND TRUE"),
      red: (r) => r.some((x) => x.name === "佀廣洋") },
  ];
  for (const m of MUT) {
    const db = await seed(m.edit);
    const rows = await reconcile(db);
    assert(m.red(rows), `還原驗證「${m.name}」：指定的情境應該轉紅`);
    await db.close();
  }
});
