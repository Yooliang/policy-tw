/**
 * 名冊對帳：系統建的人物姓名要用名冊原文（20261020050000，#678 #708 重新試跑後）。
 *
 * 試跑建出「LalingYumin」，名冊原文是「Laling Yumin」：ensurePolitician 建新人物時寫進 politicians.name 的是比對用的 normText(name)
 * （去空白、NFKC、臺→台），不是原文。這裡守兩件事：
 *   1. 系統建人物（applySystemCandidacy）姓名一律是名冊原文（只 trim、連續空白壓成一個）；代理交件的行為不動；
 *   2. migration 把已建、名字跟名冊原文不同的人物改回原文，寫 edit_history，只動該動的（系統建的、沒被別人動過、還是同一個人）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { applyContribution, applySystemCandidacy } from "./apply-contribution.ts";
import { displayNameOf } from "./candidate-import.ts";
import { candidacyPayloadOf, type ReconcileCandidate, systemRowOf } from "./roster-reconcile.ts";
import { mutate, readMig } from "./arms-pglite.ts";
import { addPerson, buildReconcileDb, loadRegs } from "./roster-reconcile-pglite.ts";

const MIG = "20261020050000_roster_reconcile_keep_name.sql";
const AGENT = "system:roster-reconcile";

const cand = (name: string): ReconcileCandidate => ({
  reg_id: 1, election_id: 2026, election_type: "縣市議員", county: "花蓮縣", sub_region: null, village: null, district: "第01選舉區",
  name, party: "無", source_url: "https://web.cec.gov.tw/api/file/x.pdf", row_no: 3, person_action: "new", politician_id: null,
});

Deno.test("K1 系統建人物：姓名是名冊原文——空白、中間點（·．）、羅馬拼音、臺都保留；只 trim 與連續空白壓成一個", async () => {
  for (
    const [reg, want] of [
      ["Laling Yumin", "Laling Yumin"], ["谷辣斯·尤達卡", "谷辣斯·尤達卡"], ["谷辣斯．尤達卡", "谷辣斯．尤達卡"], ["鄭萬正Ipay-Kaeti", "鄭萬正Ipay-Kaeti"],
      ["  王  小　明 ", "王 小 明"], ["臺北王", "臺北王"], ["黄某某", "黄某某"],
    ] as const
  ) {
    const { client, db } = createFakeSupabase({ regions: [{ id: 900, region: "花蓮縣", sub_region: null, village: null }], politicians: [], politician_elections: [] });
    const out = await applySystemCandidacy(client, systemRowOf(cand(reg), AGENT));
    assertEquals(out.status, "applied", `${reg}：${out.message}`);
    assertEquals(db.politicians.length, 1);
    assertEquals(db.politicians[0].name, want, `名冊「${reg}」建出來的人物名`);
  }
  assertEquals(candidacyPayloadOf(cand("  Laling   Yumin ")).name, "Laling Yumin");
  assertEquals(displayNameOf(" a\t b\n\nc "), "a b c");
});

Deno.test("K2 代理交件的行為不動：applyContribution 建新人物仍用比對用的正規化姓名（只改系統寫入）", async () => {
  const { client, db } = createFakeSupabase({ regions: [{ id: 900, region: "花蓮縣", sub_region: null, village: null }], politicians: [], politician_elections: [] });
  const out = await applyContribution(client, {
    id: "11111111-1111-4111-8111-111111111111", contribution_type: "candidacy", source_urls: ["https://web.cec.gov.tw/x"], note: null, agent_name: "tester", contributor_url: null,
    payload: { name: "Laling Yumin", election_id: 2026, election_type: "縣市議員", region: "花蓮縣", candidate_status: "registered" }, resolved_politician_id: "new",
  });
  assertEquals(out.status, "applied");
  assertEquals(db.politicians[0].name, "LalingYumin", "代理路徑沒動（正規化姓名）；這次只修系統寫入");
});

Deno.test("K3 掛上既有人物不改人物的名字（attach 只掛參選紀錄）", async () => {
  const PID = "33333333-3333-4333-8333-333333333333";
  const { client, db } = createFakeSupabase({
    regions: [{ id: 900, region: "花蓮縣", sub_region: null, village: null }], politicians: [{ id: PID, name: "Laling Yumin", merged_into: null }], politician_elections: [],
  });
  const out = await applySystemCandidacy(client, systemRowOf({ ...cand("LalingYumin"), person_action: "attach", politician_id: PID }, AGENT));
  assertEquals(out.status, "applied");
  assertEquals(db.politicians.map((p) => p.name), ["Laling Yumin"]);
});

// ── migration ───────────────────────────────────────────────────────────────────
const MIG_SQL = await readMig(MIG);

async function seed(editMig?: (m: string) => string) {
  const { db } = await buildReconcileDb();
  await loadRegs(db, [
    { type: "縣市議員", region: "花蓮縣", name: "Laling Yumin" },      // 系統建成「LalingYumin」→ 該改回
    { type: "縣市議員", region: "花蓮縣", name: "谷辣斯．尤達卡" },     // 系統建成「谷辣斯.尤達卡」→ 該改回
    { type: "縣市議員", region: "花蓮縣", name: "王小明" },            // 名字本來就對 → 不動
    { type: "縣市議員", region: "花蓮縣", name: "Ipay Kaeti" },        // 已被別的 agent 改過 → 不動
    { type: "縣市議員", region: "花蓮縣", name: "Sakinu Tjuku" },      // 人物被還原／log 標還原 → 不動
    { type: "縣市議員", region: "花蓮縣", name: "Panay Mulu" },        // attach（不是系統建的人物）→ 不動
    { type: "縣市議員", region: "花蓮縣", name: "Kolas Yotaka" },      // 站上這位的名字跟名冊不是同一個人（鍵不同）→ 不動
    { type: "縣市議員", region: "花蓮縣", name: "Lu Ming" },           // 已被合併走 → 不動
  ]);
  const regId = async (name: string) => (await db.query<{ id: string }>(`SELECT id::text FROM cec_registrations WHERE name = $1`, [name])).rows[0].id;
  const mk = async (siteName: string, reg: string, o: { action?: string; created?: boolean; reverted?: boolean; outcome?: string } = {}) => {
    const pid = await addPerson(db, siteName, { region: "花蓮縣" });
    await db.query(
      `INSERT INTO roster_reconcile_log (reg_id, run_id, outcome, source_url, row_no, person_action, politician_id, created_politician, agent_name, reverted_at)
       VALUES ($1, gen_random_uuid(), $2, 'https://example.test/x.pdf', 1, $3, $4, $5, $6, $7)`,
      [await regId(reg), o.outcome ?? "applied", o.action ?? "new", pid, o.created ?? true, AGENT, o.reverted ? new Date().toISOString() : null]);
    await db.query(`INSERT INTO edit_history (table_name, record_id, field, new_value, agent_name) VALUES ('politicians', $1, '*', '{}'::jsonb, $2)`, [pid, AGENT]);
    return pid;
  };
  const ids = {
    laling: await mk("LalingYumin", "Laling Yumin"),
    dot: await mk("谷辣斯.尤達卡", "谷辣斯．尤達卡"),
    ok: await mk("王小明", "王小明"),
    touched: await mk("IpayKaeti", "Ipay Kaeti"),
    reverted: await mk("SakinuTjuku", "Sakinu Tjuku", { reverted: true }),
    attach: await mk("PanayMulu", "Panay Mulu", { action: "attach", created: false }),
    other: await mk("KolasYotakaX", "Kolas Yotaka"),
    merged: await mk("LuMing", "Lu Ming"),
  };
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politicians', $1, 'bio', 'null', '"x"', 'some-agent')`, [ids.touched]);
  const keeper = await addPerson(db, "保留者", {});
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [keeper, ids.merged]);
  await db.exec(editMig ? editMig(MIG_SQL) : MIG_SQL);
  const nameOf = async (id: string) => (await db.query<{ name: string }>(`SELECT name FROM politicians WHERE id = $1`, [id])).rows[0].name;
  return { db, ids, nameOf };
}

Deno.test("K4 migration：系統建、名字跟名冊原文不同、沒被別人動過、還是同一個人的 → 改回原文並寫 edit_history；其餘一個都不動", async () => {
  const { db, ids, nameOf } = await seed();
  assertEquals(await nameOf(ids.laling), "Laling Yumin");
  assertEquals(await nameOf(ids.dot), "谷辣斯．尤達卡");
  assertEquals(await nameOf(ids.ok), "王小明");
  assertEquals(await nameOf(ids.touched), "IpayKaeti", "別的 agent 動過的不動");
  assertEquals(await nameOf(ids.reverted), "SakinuTjuku", "log 標已還原的不動");
  assertEquals(await nameOf(ids.attach), "PanayMulu", "掛上既有人物（不是系統建的）不動");
  assertEquals(await nameOf(ids.other), "KolasYotakaX", "姓名鍵跟名冊不同（不是同一個人）不動");
  assertEquals(await nameOf(ids.merged), "LuMing", "已被合併走的不動");
  const { rows: eh } = await db.query<{ record_id: string; old_value: string; new_value: string; agent_name: string; field: string; contribution_id: string | null }>(
    `SELECT record_id, old_value #>> '{}' AS old_value, new_value #>> '{}' AS new_value, agent_name, field, contribution_id::text FROM edit_history WHERE table_name = 'politicians' AND field = 'name' ORDER BY id`);
  assertEquals(eh.map((e) => [e.record_id, e.old_value, e.new_value, e.agent_name, e.contribution_id]), [
    [ids.laling, "LalingYumin", "Laling Yumin", AGENT, null], [ids.dot, "谷辣斯.尤達卡", "谷辣斯．尤達卡", AGENT, null],
  ]);
  // 可重跑：再跑一次沒有東西可改
  await db.exec(MIG_SQL);
  const { rows: [n] } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'politicians' AND field = 'name'`);
  assertEquals(n.n, 2);
  await db.close();
});

Deno.test("K5 還原驗證：把 migration 的條件拿掉，指定的人物必須被誤改（＝上面的測試會轉紅）", async () => {
  const MUT: Array<{ name: string; edit: (m: string) => string; wrong: (n: Record<string, string>) => boolean }> = [
    { name: "不看別人動過", edit: (m) => mutate(m, "     AND NOT EXISTS (\n       SELECT 1 FROM edit_history h\n        WHERE h.table_name = 'politicians' AND h.record_id = l.politician_id::TEXT\n          AND h.agent_name IS DISTINCT FROM l.agent_name AND h.reverted_at IS NULL)\n", ""),
      wrong: (n) => n.touched !== "IpayKaeti" },
    { name: "不看是不是系統新建（attach 也改）", edit: (m) => mutate(m, "l.outcome = 'applied' AND l.person_action = 'new' AND l.created_politician AND l.reverted_at IS NULL", "l.outcome = 'applied' AND l.reverted_at IS NULL"),
      wrong: (n) => n.attach !== "PanayMulu" },
    { name: "不看有沒有被還原", edit: (m) => mutate(m, " AND l.created_politician AND l.reverted_at IS NULL", " AND l.created_politician"),
      wrong: (n) => n.reverted !== "SakinuTjuku" },
    { name: "不看是不是同一個人（姓名鍵）", edit: (m) => mutate(m, "     AND roster_name_key(p.name) IS NOT DISTINCT FROM roster_name_key(r.name)\n", ""),
      wrong: (n) => n.other !== "KolasYotakaX" },
    { name: "不看已被合併", edit: (m) => mutate(m, "     AND p.merged_into IS NULL\n", ""),
      wrong: (n) => n.merged !== "LuMing" },
    { name: "不壓空白（只 trim）", edit: (m) => mutate(m, "btrim(regexp_replace(r.name, '[\\s　]+', ' ', 'g')) AS new_name", "btrim(r.name) AS new_name"),
      wrong: () => false /* 名冊原文沒有多餘空白，這一種由 K1 的 TS 版守 */ },
  ];
  for (const m of MUT.filter((x) => x.name !== "不壓空白（只 trim）")) {
    const { ids, nameOf, db } = await seed(m.edit);
    const names = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, v]) => [k, await nameOf(v)])));
    assert(m.wrong(names), `還原驗證「${m.name}」：指定的人物應該被誤改`);
    await db.close();
  }
});

Deno.test("K6 還原驗證（TS）：拿掉 keep_original_name，系統建的人物名就被壓成正規化姓名", async () => {
  const src = await Deno.readTextFile(new URL("./apply-contribution.ts", import.meta.url));
  const body = src.slice(src.indexOf("export async function applySystemCandidacy"), src.indexOf("async function supersedeDuplicates"));
  assert(body.includes("keep_original_name: true"), "applySystemCandidacy 要帶 keep_original_name");
  const imp = await Deno.readTextFile(new URL("./candidate-import.ts", import.meta.url));
  assert(imp.includes("name: options.keep_original_name ? (displayNameOf(candidate.name) || name) : name"), "ensurePolitician 建人物要用原文");
});
