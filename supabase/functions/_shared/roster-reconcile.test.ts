/**
 * 名冊比對表（20261019120000_roster_reconcile.sql，#678 第一階段）的 PGlite 實跑：
 * 各分類、唯一才建、同名多筆不建、人物不唯一不建、系統處理過的不重建、單位彙總、還原。
 * 落庫那一半（TS：roster-reconcile.ts／apply-contribution.ts）在 roster-reconcile-run.test.ts；派工臂在 roster-reconcile-arms.test.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { mutate } from "./arms-pglite.ts";
import { addOurs, addPerson, buildReconcileDb, byName, loadRegs, reconcile } from "./roster-reconcile-pglite.ts";

const T_COUNCIL = "縣市議員";
const T_VILLAGE = "村里長";

/** 一組涵蓋所有分類的小名冊 */
async function seedAll(edit?: (m: string) => string) {
  const { db, mig } = await buildReconcileDb(edit);
  await loadRegs(db, [
    // 縣市議員（台北市）
    { type: T_COUNCIL, region: "台北市", name: "王一", district: "第01選舉區" },   // 都對上
    { type: T_COUNCIL, region: "台北市", name: "李二" },                            // 全新的人 → 可建 new
    { type: T_COUNCIL, region: "台北市", name: "張三" },                            // 全庫剛好一位同名、在台北出現過 → 可建 attach
    { type: T_COUNCIL, region: "台北市", name: "陳四" },                            // 全庫兩位同名 → person_unclear
    { type: T_COUNCIL, region: "台北市", name: "趙五" },                            // 名冊上同縣市同名兩位 → same_name_multi
    { type: T_COUNCIL, region: "台北市", name: "趙五" },
    { type: T_COUNCIL, region: "台北市", name: "孫六" },                            // 我們標 considering → status_mismatch
    { type: T_COUNCIL, region: "台北市", name: "周七" },                            // 我們標 withdrawn、沒標登記後退選 → status_mismatch
    { type: T_COUNCIL, region: "台北市", name: "吳八" },                            // 我們標 withdrawn 且登記後退選 → both
    { type: T_COUNCIL, region: "台北市", name: "鄭九" },                            // 我們有兩筆同名 → match_ambiguous
    { type: T_COUNCIL, region: "台北市", name: "蔡五" },                            // 這個人這一屆在高雄已有一筆參選紀錄 → person_unclear
    { type: T_COUNCIL, region: "台北市", name: "" },                                // 姓名抽不出來 → missing_ambiguous unreadable_name
    { type: T_COUNCIL, region: "台北市", name: "何十二" },                          // 全庫只有已合併的同名者 → 當作沒有 → 可建 new
    { type: T_COUNCIL, region: "台北市", name: "沈十三" },                          // 系統試過、建不起來 → system_unresolved
    { type: T_COUNCIL, region: "台北市", name: "韓十四" },                          // 系統建過但那筆不在了 → system_applied_gone
    { type: T_COUNCIL, region: "台北市", name: "楊十五" },                          // 系統建了又被還原 → system_reverted
    // 村里長（新北市）：鄉鎮層級的選舉，人物要同鄉鎮才掛
    { type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "甲里", name: "郭一" },   // 都對上
    { type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "乙里", name: "郭二" },   // 全新 → new
    { type: T_VILLAGE, region: "新北市", sub: "三重區", village: "丙里", name: "林三" },   // 同名者在三重區出現過 → attach
    { type: T_VILLAGE, region: "新北市", sub: "三重區", village: "丁里", name: "林四" },   // 同名者在板橋區出現過、不是三重區 → person_unclear
    { type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "戊里", name: "同名甲" }, // 不同鄉鎮同名：兩個縣內同名 → same_name_multi（縣市層級）
    { type: T_VILLAGE, region: "新北市", sub: "三重區", village: "己里", name: "同名甲" },
    { type: T_VILLAGE, region: "新北市", sub: "三重區", village: "庚里", name: "吳新" },
    { type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "丙里", name: "甲甲" },   // 同名者在板橋區的乙里（不同里）→ person_unclear
    { type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "乙里", name: "乙乙" },   // 同名者在板橋區的乙里（同一里）→ attach
    { type: T_COUNCIL, region: "台北市", name: "黨甲", party: "中國國民黨" },             // 同名者是民進黨 → 政黨互斥，不掛
    { type: T_COUNCIL, region: "台北市", name: "黨乙", party: "民主進步黨" },             // 同名者同黨 → attach
    { type: T_COUNCIL, region: "台北市", name: "黨丙", party: "無" },                      // 名冊無黨籍 → attach
   // 我們有同名的，但在板橋區（不是同一個地方）→ 不算對上
  ]);
  const w = await addOurs(db, { name: "王一", type: T_COUNCIL, status: "filed", region: "台北市", sub: "第01選舉區" });
  await addOurs(db, { name: "孫六", type: T_COUNCIL, status: "considering", region: "台北市" });
  await addOurs(db, { name: "周七", type: T_COUNCIL, status: "withdrawn", region: "台北市" });
  await addOurs(db, { name: "吳八", type: T_COUNCIL, status: "withdrawn", region: "台北市", filedOut: true });
  await addOurs(db, { name: "鄭九", type: T_COUNCIL, status: "filed", region: "台北市" });
  await addOurs(db, { name: "鄭九", type: T_COUNCIL, status: "filed", region: "台北市" });
  await addOurs(db, { name: "馬十", type: T_COUNCIL, status: "filed", region: "台北市" });                    // 我們多出來
  await addOurs(db, { name: "錢十一", type: T_COUNCIL, status: "withdrawn", region: "台北市", filedOut: true }); // 登記後退選卻不在名冊
  await addOurs(db, { name: "蔡五", type: T_COUNCIL, status: "filed", region: "高雄市" });                    // 同名者這一屆已有別筆
  await addOurs(db, { name: "郭一", type: T_VILLAGE, status: "filed", region: "新北市", sub: "板橋區" });
  await addOurs(db, { name: "吳新", type: T_VILLAGE, status: "filed", region: "新北市", sub: "板橋區" });
  await db.exec(`UPDATE politicians SET region = '台北市' WHERE name = '蔡五'`);   // 讓「地方看得出一致」成立，只剩「這一屆已有別筆」擋著
  await addPerson(db, "甲甲", { region: "新北市", past: { election: 2022, type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "乙里" } });
  await addPerson(db, "乙乙", { region: "新北市", past: { election: 2022, type: T_VILLAGE, region: "新北市", sub: "板橋區", village: "乙里" } });
  await addPerson(db, "黨甲", { region: "台北市", party: "民主進步黨", past: { election: 2022, type: T_COUNCIL, region: "台北市" } });
  await addPerson(db, "黨乙", { region: "台北市", party: "民主進步黨", past: { election: 2022, type: T_COUNCIL, region: "台北市" } });
  await addPerson(db, "黨丙", { region: "台北市", party: "民主進步黨", past: { election: 2022, type: T_COUNCIL, region: "台北市" } });
  await addPerson(db, "張三", { region: "台北市", past: { election: 2022, type: T_COUNCIL, region: "台北市" } });
  await addPerson(db, "陳四", { region: "台北市" });
  await addPerson(db, "陳四", { region: "新北市" });
  await addPerson(db, "何十二", { region: "台北市", merged: true });
  await addPerson(db, "林三", { region: "新北市", past: { election: 2022, type: T_VILLAGE, region: "新北市", sub: "三重區" } });
  await addPerson(db, "林四", { region: "新北市", past: { election: 2022, type: T_VILLAGE, region: "新北市", sub: "板橋區" } });
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new', 'attach']`);   // 預設只做 new；這組情境要看到 attach 的判定
  // 系統的處理紀錄
  const logFor = async (name: string, outcome: string, reverted = false) => {
    const { rows: [r] } = await db.query<{ id: string }>(`SELECT id::text FROM cec_registrations WHERE name = $1`, [name]);
    await db.query(
      `INSERT INTO roster_reconcile_log (reg_id, run_id, outcome, source_url, row_no, agent_name, reverted_at)
       VALUES ($1, gen_random_uuid(), $2, 'https://example.test/x.pdf', 1, 'system:roster-reconcile', $3)`, [r.id, outcome, reverted ? new Date().toISOString() : null]);
  };
  await logFor("沈十三", "unresolved");
  await logFor("韓十四", "applied");
  await logFor("楊十五", "applied", true);
  return { db, mig, wangPeId: w.peId };
}

Deno.test("N1 各分類：都對上／唯一可建（new、attach）／同名多筆／人物不唯一／兩邊不一對一／姓名抽不出來／我們多出來／狀態不一致／系統處理過的", async () => {
  const { db } = await seedAll();
  const rows = await reconcile(db);
  const one = (name: string, county = "") => {
    const r = byName(rows, name).filter((x) => !county || x.county === county);
    assertEquals(r.length, 1, `${name} 應該剛好一列，實際 ${r.length}`);
    return r[0];
  };
  assertEquals([one("王一").category, one("王一").reason], ["both", null]);
  assertEquals([one("李二").category, one("李二").person_action], ["missing_creatable", "new"]);
  assertEquals([one("張三").category, one("張三").person_action], ["missing_creatable", "attach"]);
  assert(one("張三").politician_id !== null, "attach 要帶出要掛的人物 id");
  assertEquals([one("陳四").category, one("陳四").reason, one("陳四").person_action], ["missing_ambiguous", "person_unclear", null]);
  assertEquals(byName(rows, "趙五").map((r) => [r.category, r.reason]), [["missing_ambiguous", "same_name_multi"], ["missing_ambiguous", "same_name_multi"]]);
  assertEquals([one("孫六").category, one("孫六").reason], ["status_mismatch", "ours_considering"]);
  assertEquals([one("周七").category, one("周七").reason], ["status_mismatch", "ours_withdrawn_not_after_filing"]);
  assertEquals(one("吳八").category, "both", "登記後才退選（withdrawn_after_filing）且名冊上有：算對上");
  assertEquals(byName(rows, "鄭九").map((r) => [r.category, r.reason]), [["match_ambiguous", "match_not_one_to_one"]], "名冊一位對到我們兩筆：兩邊都不是一對一，不建、派代理");
  assertEquals([one("蔡五", "台北市").category, one("蔡五", "台北市").reason], ["missing_ambiguous", "person_unclear"]);
  assertEquals(rows.filter((r) => r.name === "" || r.reason === "unreadable_name").map((r) => r.category), ["missing_ambiguous"]);
  assertEquals([one("何十二").category, one("何十二").person_action], ["missing_creatable", "new"], "已合併的同名者不算");
  assertEquals([one("沈十三").category, one("沈十三").reason], ["missing_ambiguous", "system_unresolved"]);
  assertEquals([one("韓十四").category, one("韓十四").reason], ["missing_ambiguous", "system_applied_gone"]);
  assertEquals([one("楊十五").category, one("楊十五").reason], ["missing_ambiguous", "system_reverted"]);
  assertEquals([one("馬十").category, one("馬十").reason], ["ours_extra", "not_in_registration"]);
  assertEquals([one("錢十一").category, one("錢十一").reason], ["status_mismatch", "filed_flag_no_registration"]);
  // 村里長：鄉鎮層級的選舉，人物要同鄉鎮才掛
  assertEquals(one("郭一").category, "both");
  assertEquals(byName(rows, "吳新").map((r) => [r.election_type, r.category, r.reason]).sort(), [[T_VILLAGE, "missing_ambiguous", "person_unclear"], [T_VILLAGE, "ours_extra", "not_in_registration"]],
    "鄉鎮不同的同名者不算對上：名冊那位（三重區）因為同名者這一屆已有紀錄而不建，我們這位（板橋區）不在名冊上");
  assertEquals([one("郭二").category, one("郭二").person_action], ["missing_creatable", "new"]);
  assertEquals([one("林三").category, one("林三").person_action], ["missing_creatable", "attach"]);
  assertEquals([one("林四").category, one("林四").reason], ["missing_ambiguous", "person_unclear"], "同名者在板橋區、名冊是三重區：不掛");
  assertEquals(byName(rows, "同名甲").map((r) => [r.category, r.reason]), [["missing_ambiguous", "same_name_multi"], ["missing_ambiguous", "same_name_multi"]]);
  // 村里長：既有紀錄在這個鄉鎮有明確村里而名冊村里不同 → 不掛；同一里 → 掛
  assertEquals([one("甲甲").category, one("甲甲").reason], ["missing_ambiguous", "person_unclear"], "同鄉鎮不同里的同名者是兩個人");
  assertEquals([one("乙乙").category, one("乙乙").person_action], ["missing_creatable", "attach"]);
  // 政黨互斥（兩邊都不是無黨籍、不同黨）不掛；同黨、名冊無黨籍照掛
  assertEquals([one("黨甲").category, one("黨甲").reason], ["missing_ambiguous", "person_unclear"]);
  assertEquals([one("黨乙").category, one("黨乙").person_action], ["missing_creatable", "attach"]);
  assertEquals([one("黨丙").category, one("黨丙").person_action], ["missing_creatable", "attach"]);
  await db.close();
});

Deno.test("N2 唯一才建：missing_creatable 的每一位都滿足「我們一筆都沒有、名冊同縣市同名只有他、人物全新或唯一可掛」；其他一個都不建；系統只做 settings.actions 允許的種類（預設只 new）", async () => {
  const { db } = await seedAll();
  const creatable = (await reconcile(db)).filter((r) => r.category === "missing_creatable");
  const ALL = ["何十二", "李二", "林三", "張三", "郭二", "乙乙", "黨乙", "黨丙"].sort();
  assertEquals(creatable.map((r) => r.name).sort(), ALL);
  for (const r of creatable) {
    assertEquals(r.pe_id, null, `${r.name} 我們不能已經有參選紀錄`);
    assert(r.person_action === "new" || r.person_action === "attach");
  }
  // roster_reconcile_next 給系統的清單：actions 允許哪幾種就給哪幾種
  const names = async () => (await db.query<{ name: string; person_action: string; politician_id: string | null }>(`SELECT name, person_action, politician_id FROM roster_reconcile_next(100) ORDER BY name`)).rows;
  const both = await names();
  assertEquals(both.map((r) => r.name).sort(), ALL);
  assert(both.filter((r) => r.person_action === "attach").every((r) => r.politician_id !== null));
  assert(both.filter((r) => r.person_action === "new").every((r) => r.politician_id === null));
  // 預設（migration 的值）只放 new：attach 一個都不給
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new']`);
  assertEquals((await names()).map((r) => r.name).sort(), ["何十二", "李二", "郭二"].sort());
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['attach']`);
  assertEquals((await names()).map((r) => r.name).sort(), ["乙乙", "林三", "張三", "黨乙", "黨丙"].sort());
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new', 'attach']`);
  // 上限
  const { rows: lim } = await db.query(`SELECT 1 FROM roster_reconcile_next(2)`);
  assertEquals(lim.length, 2);
  await db.close();
});

Deno.test("N3 單位彙總：refresh 寫 roster_reconcile_units；needs_agent 只在有對不上的人時為真；沒變的單位不重寫；roster_reconcile_unit 彙總縣市與鄉鎮", async () => {
  const { db } = await seedAll();
  const n1 = Number((await db.query<{ n: number }>(`SELECT roster_reconcile_refresh_units() AS n`)).rows[0].n);
  assert(n1 > 0);
  const { rows: units } = await db.query<{ election_type: string; county: string; town: string; total: number; both_n: number; creatable_n: number; needs_agent: boolean }>(
    `SELECT election_type, county, town, total, both_n, creatable_n, needs_agent FROM roster_reconcile_units ORDER BY election_type, county, town`);
  const council = units.find((u) => u.election_type === T_COUNCIL && u.county === "台北市")!;
  assertEquals([council.total, council.both_n, council.needs_agent], [19, 2, true]);
  assertEquals(council.creatable_n, 5);
  const village = units.filter((u) => u.election_type === T_VILLAGE);
  assertEquals(village.map((u) => u.town), ["三重區", "板橋區"]);
  // 第二次刷新：沒變 → 0 個單位被改
  assertEquals(Number((await db.query<{ n: number }>(`SELECT roster_reconcile_refresh_units() AS n`)).rows[0].n), 0);
  // 彙總 jsonb
  const { rows: [u] } = await db.query<{ u: { total: number; needs_agent: boolean; people: Array<{ name: string; reason: string }> } }>(
    `SELECT roster_reconcile_unit(2026, '${T_VILLAGE}', '新北市') AS u`);
  assertEquals(u.u.total, 9);
  assertEquals(u.u.needs_agent, true);
  assertEquals(u.u.people.map((p) => p.name).sort(), ["同名甲", "同名甲", "吳新", "吳新", "林四", "甲甲"].sort());
  const { rows: [ban] } = await db.query<{ u: { total: number; needs_agent: boolean } }>(`SELECT roster_reconcile_unit(2026, '${T_VILLAGE}', '新北市', '板橋區') AS u`);
  assertEquals([ban.u.total, ban.u.needs_agent], [5, true]);
  const { rows: [none] } = await db.query<{ u: unknown }>(`SELECT roster_reconcile_unit(2026, '${T_VILLAGE}', '高雄市') AS u`);
  assertEquals(none.u, null, "沒有對帳資料的單位回 NULL（派工臂照舊派）");
  // 文字：純中文、只列對不上的人、講明系統會自己建
  const { rows: [tx] } = await db.query<{ t: string }>(`SELECT roster_reconcile_text(roster_reconcile_unit(2026, '${T_VILLAGE}', '新北市')) AS t`);
  assert(tx.t.includes("【名冊對帳】") && tx.t.includes("林四") && tx.t.includes("由系統自己建"), tx.t);
  assert(!tx.t.includes("郭一"), "都對上的人不列");
  await db.close();
});

Deno.test("N4 單位全部對上（或只剩系統會建的）→ needs_agent 為假，臂就不派", async () => {
  const { db } = await buildReconcileDb();
  await loadRegs(db, [
    { type: T_COUNCIL, region: "台中市", name: "甲一" },
    { type: T_COUNCIL, region: "台中市", name: "乙二" },
  ]);
  await addOurs(db, { name: "甲一", type: T_COUNCIL, status: "filed", region: "台中市" });
  await db.exec(`SELECT roster_reconcile_refresh_units()`);
  const { rows } = await db.query<{ needs_agent: boolean; creatable_n: number; both_n: number }>(`SELECT needs_agent, creatable_n, both_n FROM roster_reconcile_units`);
  assertEquals(rows, [{ needs_agent: false, creatable_n: 1, both_n: 1 }]);
  await db.close();
});

Deno.test("N5 擴充點：announce_id、announce_state 兩欄在（第二階段名單公告接進來用），現在都是 NULL", async () => {
  const { db } = await seedAll();
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM roster_reconcile WHERE announce_id IS NOT NULL OR announce_state IS NOT NULL`);
  assertEquals(rows[0].n, 0);
  const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'roster_reconcile'`)).rows.map((r) => r.column_name);
  assert(cols.includes("announce_id") && cols.includes("announce_state"));
  await db.close();
});

// ── 系統寫入之後：冪等與還原 ─────────────────────────────────────────────────────
/** 模擬 roster-reconcile 落庫（TS 那一半的寫入結果）：建人物（new 才建）、建參選紀錄、edit_history、處理紀錄 */
async function simulateApply(db: Awaited<ReturnType<typeof buildReconcileDb>>["db"], name: string, runId: string): Promise<{ pid: string; peId: number }> {
  const { rows: [r] } = await db.query<{ reg_id: string; election_type: string; county: string; sub_region: string | null; person_action: string; politician_id: string | null; source_url: string; row_no: number }>(
    `SELECT reg_id::text, election_type, county, sub_region, person_action, politician_id, source_url, row_no FROM roster_reconcile_next(500) WHERE name = $1`, [name]);
  let pid = r.politician_id;
  const created = r.person_action === "new";
  if (created) {
    pid = (await db.query<{ id: string }>(`INSERT INTO politicians (name, party, region) VALUES ($1, '無黨籍', $2) RETURNING id`, [name, r.county])).rows[0].id;
    await db.query(`INSERT INTO edit_history (table_name, record_id, field, new_value, agent_name) VALUES ('politicians', $1, '*', '{}'::jsonb, 'system:roster-reconcile')`, [pid]);
  }
  const rg = (await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id`, [r.county, r.sub_region])).rows[0].id;
  const peId = (await db.query<{ id: number }>(
    `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status) VALUES (2026, $1, $2, $3, 'filed') RETURNING id`,
    [r.election_type, pid, rg])).rows[0].id;
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, new_value, agent_name) VALUES ('politician_elections', $1, '*', '{}'::jsonb, 'system:roster-reconcile')`, [String(peId)]);
  await db.query(`INSERT INTO source_refs (target_table, target_id, source_url) VALUES ('politician_elections', $1, $2)`, [String(peId), r.source_url]);
  await db.query(
    `INSERT INTO roster_reconcile_log (reg_id, run_id, outcome, source_url, row_no, person_action, politician_id, politician_election_id, created_politician, agent_name)
     VALUES ($1, $2, 'applied', $3, $4, $5, $6, $7, $8, 'system:roster-reconcile')`, [r.reg_id, runId, r.source_url, r.row_no, r.person_action, pid, peId, created]);
  return { pid: pid!, peId };
}

Deno.test("N6 重跑冪等：系統建過的人，對帳變成「都對上」且標 system_applied，不再出現在要建的清單", async () => {
  const { db } = await seedAll();
  const run = crypto.randomUUID();
  await simulateApply(db, "李二", run);
  await simulateApply(db, "張三", run);
  const rows = await reconcile(db);
  for (const n of ["李二", "張三"]) {
    const r = byName(rows, n)[0];
    assertEquals([r.category, r.system_applied], ["both", true], n);
  }
  const { rows: next } = await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_next(500)`);
  assert(!next.some((r) => r.name === "李二" || r.name === "張三"), "建過的不再出現");
  assertEquals(next.length, 6, "其餘六位還在");
  // 同一位登記者不能被處理兩次（reg_id 唯一）
  let dup = false;
  try {
    await db.query(`INSERT INTO roster_reconcile_log (reg_id, run_id, outcome, source_url, row_no, agent_name)
                    SELECT reg_id, gen_random_uuid(), 'applied', source_url, row_no, 'system:roster-reconcile' FROM roster_reconcile WHERE name = '李二'`);
  } catch { dup = true; }
  assert(dup, "log 的 reg_id 要唯一");
  await db.close();
});

Deno.test("N7 還原：整輪還原刪掉系統建的參選紀錄與（系統建的）人物，edit_history 標已還原；還原過的不再被重建；掛上既有人物的不刪人物", async () => {
  const { db } = await seedAll();
  const run = crypto.randomUUID();
  const a = await simulateApply(db, "李二", run);       // new：人物與參選紀錄都是系統建的
  const b = await simulateApply(db, "張三", run);       // attach：人物是既有的
  const before = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM politicians`)).rows[0].n);
  const res = (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert($1::uuid, NULL, 'test') AS r`, [run])).rows[0].r;
  assertEquals(res, { politician_elections_deleted: 2, politicians_deleted: 1, politicians_kept: 0, skipped_touched: 0 });
  assertEquals(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM politicians`)).rows[0].n), before - 1);
  assertEquals((await db.query(`SELECT 1 FROM politician_elections WHERE id = ANY($1)`, [[a.peId, b.peId]])).rows.length, 0);
  assertEquals((await db.query(`SELECT 1 FROM politicians WHERE id = $1`, [b.pid])).rows.length, 1, "既有人物留著");
  assertEquals((await db.query(`SELECT 1 FROM source_refs WHERE target_table = 'politician_elections'`)).rows.length, 0, "出處引用一起刪");
  const { rows: eh } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM edit_history WHERE agent_name = 'system:roster-reconcile' AND reverted_at IS NULL`);
  assertEquals(eh[0].n, 0, "系統寫的 edit_history 全部標成已還原");
  const { rows: lg } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM roster_reconcile_log WHERE reverted_at IS NOT NULL`);
  assertEquals(lg[0].n, 3, "原本就還原過的一筆加這次兩筆");
  // 還原過的不再被系統重建，轉去派代理
  const rows = await reconcile(db);
  for (const n of ["李二", "張三"]) assertEquals([byName(rows, n)[0].category, byName(rows, n)[0].reason], ["missing_ambiguous", "system_reverted"], n);
  assert(!(await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_next(500)`)).rows.some((r) => r.name === "李二"));
  // 再還原一次：沒有東西可還原（冪等）
  const again = (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert($1::uuid, NULL, 'test') AS r`, [run])).rows[0].r;
  assertEquals(again.politician_elections_deleted, 0);
  await db.close();
});

Deno.test("N8 還原保護：別的 agent 在系統建立之後動過那筆參選紀錄就不還原（回報 skipped_touched）；逐筆還原可只還原指定的", async () => {
  const { db } = await seedAll();
  const run = crypto.randomUUID();
  const a = await simulateApply(db, "李二", run);
  const b = await simulateApply(db, "郭二", run);
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politician_elections', $1, 'candidacy_status', '"filed"', '"declared"', 'some-agent')`, [String(a.peId)]);
  const res = (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert($1::uuid, NULL, 'test') AS r`, [run])).rows[0].r;
  assertEquals([res.politician_elections_deleted, res.skipped_touched], [1, 1]);
  assertEquals((await db.query(`SELECT 1 FROM politician_elections WHERE id = $1`, [a.peId])).rows.length, 1, "被動過的留著");
  assertEquals((await db.query(`SELECT 1 FROM politician_elections WHERE id = $1`, [b.peId])).rows.length, 0);
  // 指定 reg_ids 逐筆還原
  const run2 = crypto.randomUUID();
  const c = await simulateApply(db, "林三", run2);
  const regId = (await db.query<{ reg_id: string }>(`SELECT reg_id::text FROM roster_reconcile_log WHERE politician_election_id = $1`, [c.peId])).rows[0].reg_id;
  const r2 = (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert(NULL, ARRAY[$1::bigint], 'test') AS r`, [regId])).rows[0].r;
  assertEquals(r2.politician_elections_deleted, 1);
  // 沒指定範圍要報錯，不可以整張表亂還原
  let threw = false;
  try { await db.query(`SELECT roster_reconcile_revert()`); } catch { threw = true; }
  assert(threw);
  await db.close();
});

Deno.test("N9 設定與審計：settings 單列、預設關著、只做 new、每輪 100；改值進 edit_history；agent_name 必須是 system: 開頭", async () => {
  const { db } = await buildReconcileDb();
  const { rows: [s] } = await db.query<{ enabled: boolean; batch_limit: number; agent_name: string }>(`SELECT enabled, batch_limit, agent_name FROM roster_reconcile_settings`);
  assertEquals([s.enabled, s.batch_limit, s.agent_name], [false, 100, "system:roster-reconcile"], "預設關：部署後先手動試跑，再開");
  const { rows: [act] } = await db.query<{ actions: string[] }>(`SELECT actions FROM roster_reconcile_settings`);
  assertEquals(act.actions, ["new"], "預設只建新人物，掛既有人物要另外開");
  let badAction = false;
  try { await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['delete']`); } catch { badAction = true; }
  assert(badAction, "actions 只能是 new／attach");
  await db.exec(`UPDATE roster_reconcile_settings SET enabled = false WHERE id = 1`);
  const { rows: eh } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'roster_reconcile_settings' AND agent_name = 'activity-audit'`);
  assertEquals(eh[0].n, 1, "修改一筆（初始那一列在觸發器之前建）");
  let bad = false;
  try { await db.exec(`UPDATE roster_reconcile_settings SET agent_name = 'maintainer'`); } catch { bad = true; }
  assert(bad, "系統寫入的 agent_name 必須是 system:*，不能冒用代理或維護者的名字");
  await db.close();
});

// ── 還原驗證：把 migration 改壞，指定的情境必須轉紅（這組不紅，上面的全綠什麼都證明不了）──────────────
Deno.test("N10 還原驗證：把對帳判準改壞（12 種），指定的情境必須轉紅", async () => {
  type Rows = Awaited<ReturnType<typeof reconcile>>;
  const first = (rows: Rows, name: string) => byName(rows, name)[0];
  const MUTATIONS: Array<{ name: string; edit: (m: string) => string; red: (rows: Rows) => boolean }> = [
    { name: "拿掉「名冊同縣市同名多位不建」", edit: (m) => mutate(m, "             WHEN g.dup_n > 1 THEN 'missing_ambiguous'\n", ""),
      red: (r) => first(r, "趙五").category === "missing_creatable" },
    { name: "attach 不看鄉鎮（鄉鎮層級的選舉只要同縣市就掛）", edit: (m) => mutate(m, "                           ELSE pt.politician_id IS NOT NULL END)", "                           ELSE TRUE END)"),
      red: (r) => first(r, "林四").category === "missing_creatable" },
    { name: "拿掉「這一屆已有別筆參選紀錄就不掛」", edit: (m) => mutate(m, "                 AND h.politician_id IS NULL\n", ""),
      red: (r) => byName(r, "蔡五").some((x) => x.category === "missing_creatable") },
    { name: "已合併的人物也算同名者", edit: (m) => mutate(m, "     WHERE p.merged_into IS NULL\n       AND COALESCE(cec_name_key(p.name)", "     WHERE COALESCE(cec_name_key(p.name)"),
      red: (r) => first(r, "何十二").person_action !== "new" },
    { name: "系統處理過的（log）不擋重建", edit: (m) => mutate(m, "             WHEN ap.reg_id IS NOT NULL THEN 'missing_ambiguous'\n", ""),
      red: (r) => ["沈十三", "韓十四", "楊十五"].some((n) => first(r, n).category === "missing_creatable") },
    { name: "withdrawn 沒標登記後退選也當對上", edit: (m) => mutate(m, "CASE WHEN o.status = 'considering' OR (o.status = 'withdrawn' AND NOT o.filed_out) THEN 'status_mismatch' ELSE 'both' END", "CASE WHEN o.status = 'considering' THEN 'status_mismatch' ELSE 'both' END"),
      red: (r) => first(r, "周七").category === "both" },
    { name: "一對多也當對上（拿掉 match_ambiguous）", edit: (m) => mutate(m, "             WHEN rd.n >= 1 THEN 'match_ambiguous'\n", ""),
      red: (r) => first(r, "鄭九").category !== "match_ambiguous" },
    { name: "對帳不比鄉鎮（不同鄉鎮的同名者算對上）", edit: (m) => mutate(m, "                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)\n", ""),
      red: (r) => byName(r, "吳新").every((x) => x.category === "both") },
    { name: "村里長不看村里（同鄉鎮不同里也掛）", edit: (m) => mutate(m, "                 AND NOT (g.election_type = '村里長' AND g.village_n IS NOT NULL AND va.politician_id IS NOT NULL AND ve.politician_id IS NULL)\n", ""),
      red: (r) => first(r, "甲甲").category === "missing_creatable" },
    { name: "不看政黨互斥", edit: (m) => mutate(m, "                          AND strpos(n.party, g.party) = 0 AND strpos(g.party, n.party) = 0)", "                          AND FALSE)"),
      red: (r) => first(r, "黨甲").category === "missing_creatable" },
    { name: "名冊無黨籍也當成黨衝突", edit: (m) => mutate(m, "COALESCE(btrim(g.party), '') NOT IN ('', '無', '無黨籍') AND COALESCE(btrim(n.party)", "COALESCE(btrim(g.party), '') NOT IN ('', '無黨籍') AND COALESCE(btrim(n.party)"),
      red: (r) => first(r, "黨丙").category !== "missing_creatable" },
    { name: "next 不看 settings.actions", edit: (m) => mutate(m, "     AND r.person_action IN (SELECT unnest(s.actions) FROM roster_reconcile_settings s WHERE s.id = 1)\n", ""),
      red: () => false /* 由下面專門檢查 */ },
    { name: "我們多出來的不列", edit: (m) => mutate(m, "     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)\n       AND (o.status IN", "     WHERE FALSE AND (o.status IN"),
      red: (r) => byName(r, "馬十").length === 0 },
  ];
  for (const m of MUTATIONS.filter((x) => x.name !== "next 不看 settings.actions")) {
    const { db } = await seedAll(m.edit);
    const rows = await reconcile(db);
    assert(m.red(rows), `還原驗證「${m.name}」：指定的情境應該轉紅`);
    await db.close();
  }
  // actions 過濾：只放 new 時，拿掉過濾就會多給 attach
  const noFilter = MUTATIONS.find((x) => x.name === "next 不看 settings.actions")!;
  const { db } = await seedAll(noFilter.edit);
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new']`);
  const { rows } = await db.query<{ person_action: string }>(`SELECT person_action FROM roster_reconcile_next(100)`);
  assert(rows.some((r) => r.person_action === "attach"), "還原驗證「next 不看 actions」：只放 new 時應該多出 attach");
  await db.close();
  // 租約：拿掉「沒過期不給」就會讓第二個也拿到
  const { db: db2 } = await buildReconcileDb((m) => mutate(m, "WHERE id = 1 AND (lock_until IS NULL OR lock_until < now()) RETURNING 1)", "WHERE id = 1 RETURNING 1)"));
  await db2.query(`SELECT roster_reconcile_lock(5)`);
  assertEquals((await db2.query<{ ok: boolean }>(`SELECT roster_reconcile_lock(5) AS ok`)).rows[0].ok, true, "還原驗證「租約不擋第二個」：應該拿得到（＝N12 會轉紅）");
  await db2.close();
});

Deno.test("N11 單位彙總的 truncated：對不上的人超過 40 位，彙總標截斷、任務說明改成「沒列的不是系統會建的」；沒超過就不標", async () => {
  const { db } = await buildReconcileDb();
  const regs = [];
  for (let i = 0; i < 45; i++) for (let k = 0; k < 2; k++) regs.push({ type: T_COUNCIL, region: "台南市", name: `重名${String(i).padStart(2, "0")}` });   // 45 組名冊同名兩位 → 90 位 same_name_multi
  regs.push({ type: T_COUNCIL, region: "高雄市", name: "重名甲" }, { type: T_COUNCIL, region: "高雄市", name: "重名甲" });
  await loadRegs(db, regs);
  await db.exec(`SELECT roster_reconcile_refresh_units()`);
  const { rows: [big] } = await db.query<{ u: { truncated: boolean; people: unknown[]; ambiguous: number } }>(`SELECT roster_reconcile_unit(2026, '${T_COUNCIL}', '台南市') AS u`);
  assertEquals([big.u.truncated, big.u.people.length, big.u.ambiguous], [true, 40, 90]);
  const { rows: [tx] } = await db.query<{ t: string }>(`SELECT roster_reconcile_text(roster_reconcile_unit(2026, '${T_COUNCIL}', '台南市')) AS t`);
  assert(tx.t.includes("已截斷") && tx.t.includes("**不是**系統會建的") && !tx.t.includes("這一段以外的人系統都處理了"), tx.t);
  const { rows: [small] } = await db.query<{ u: { truncated: boolean } }>(`SELECT roster_reconcile_unit(2026, '${T_COUNCIL}', '高雄市') AS u`);
  assertEquals(small.u.truncated, false);
  const { rows: [tx2] } = await db.query<{ t: string }>(`SELECT roster_reconcile_text(roster_reconcile_unit(2026, '${T_COUNCIL}', '高雄市')) AS t`);
  assert(!tx2.t.includes("已截斷") && tx2.t.includes("這一段以外的人系統都處理了"));
  await db.close();
});

Deno.test("N12 執行租約：第二個拿不到、釋放後拿得到、租約過期（5 分鐘）也拿得到", async () => {
  const { db } = await buildReconcileDb();
  const lock = async () => (await db.query<{ ok: boolean }>(`SELECT roster_reconcile_lock(5) AS ok`)).rows[0].ok;
  assertEquals(await lock(), true);
  assertEquals(await lock(), false, "別人持有中");
  await db.exec(`SELECT roster_reconcile_unlock()`);
  assertEquals(await lock(), true, "釋放後可以再拿");
  await db.exec(`UPDATE roster_reconcile_lock SET lock_until = now() - interval '1 second'`);
  assertEquals(await lock(), true, "租約過期（持有者當掉沒釋放）也拿得到，不會永遠卡死");
  await db.close();
});
