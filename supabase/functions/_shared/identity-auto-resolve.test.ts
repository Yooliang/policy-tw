/**
 * 同名先比生年、真模糊先建新人物掛疑似標記；身分退件改待指認不丟隊尾（協議 1.130.0，migration 20261111170000，2026-11-11）。
 * 裁決：docs/decisions/2026-11-11-同名身分系統先比生年真模糊先建新人物掛疑似標記.md
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { autoApplyContribution } from "./auto-apply.ts";
import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";
import { identityInputOf } from "./candidate-import.ts";
import { identityPickRequired } from "./identity-pick-gate.ts";
import { identityCandidateOf, identityFieldsOf } from "./identity-candidate.ts";
import { checkIdentityPick } from "./identity-pick-gate.ts";
import { readMig } from "./arms-pglite.ts";
import { addPerson, buildReconcileDb, reconcile } from "./roster-reconcile-pglite.ts";

const C1 = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // 同名、1960 年生
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // 同名、缺生年
const BIRTH = (id: string, name: string, year: number) => ({ politician_id: id, key_type: "birth", key_value: `${name}|${year}`, strength: 3 });

const payload = (extra: Record<string, unknown> = {}) => ({ name: "林大同", party: "無黨籍", region: "宜蘭縣", election_type: "村里長", ...extra });
const row = (p: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: C1, contribution_type: "politician", status: "verified", agent_name: "alice", contributor_ip_hash: "ip-a", contributor_url: null, note: null, retry_count: 0,
  payload: p, source_urls: ["https://www.cec.gov.tw/x"], ...extra,
});
const people = (...p: Array<Record<string, unknown>>) => p;

async function resolveWith(politicians: Array<Record<string, unknown>>, keys: Array<Record<string, unknown>>, p: Record<string, unknown>) {
  const fake = createFakeSupabase({ politicians, politician_keys: keys });
  const candidate = identityFieldsOf("politician", p)!;
  return await resolvePolitician(createSupabaseIdentityStore(fake.client), identityInputOf(candidate), { persist: false });
}

Deno.test("A1 交件帶生年、站上同名者全有生年且全不同 → 新人物，不要求指認、沒有疑似標記", async () => {
  const r = await resolveWith(
    people({ id: P1, name: "林大同", region: "彰化縣", birth_year: 1960 }, { id: P2, name: "林大同", region: "台北市", birth_year: 1970 }),
    [BIRTH(P1, "林大同", 1960), BIRTH(P2, "林大同", 1970)], payload({ birth_year: 1980 }));
  assertEquals(r.decision, "new");
  assertEquals(r.flag, "same_name_exists");
  assertEquals(r.possible_duplicate_of, undefined);
  assertEquals(identityPickRequired(r), false);
});

Deno.test("A2 有同名者缺生年 → 先建新人物並掛疑似標記（只掛缺生年的那位）；不要求指認", async () => {
  const r = await resolveWith(
    people({ id: P1, name: "林大同", region: "彰化縣", birth_year: 1960 }, { id: P2, name: "林大同", region: "台北市" }),
    [BIRTH(P1, "林大同", 1960)], payload({ birth_year: 1980 }));
  assertEquals(r.decision, "new");
  assertEquals(r.flag, "possible_duplicate");
  assertEquals(r.possible_duplicate_of, [P2]);
  assertEquals(identityPickRequired(r), false);
});

Deno.test("A3 生年相同照既有規則比對（不是新人物）；交件沒帶生年、同名者缺生年 → 仍要指認（真模糊）", async () => {
  const same = await resolveWith(
    people({ id: P1, name: "林大同", region: "宜蘭縣", birth_year: 1980 }),
    [BIRTH(P1, "林大同", 1980), { politician_id: P1, key_type: "region_type", key_value: "林大同|宜蘭縣|村里長", strength: 2 }], payload({ birth_year: 1980 }));
  assert(same.decision !== "new", `生年相同不能判新人物：${same.decision}`);
  const noBirth = await resolveWith(people({ id: P2, name: "林大同", region: "台北市" }), [], payload());
  assertEquals(noBirth.decision, "ambiguous");
  assertEquals(identityPickRequired(noBirth), true);
});

Deno.test("A4 落庫：缺生年同名者 → 建新人物並寫 possible_duplicate_of；生年全不同 → 建新人物沒有標記", async () => {
  const seed = (extra: Array<Record<string, unknown>>, keys: Array<Record<string, unknown>>) => ({
    contributions: [row(payload({ birth_year: 1980 }))],
    politicians: extra, politician_keys: keys,
    contribution_votes: [{ contribution_id: C1, verdict: "agree", resolved_politician_id: null }, { contribution_id: C1, verdict: "agree", resolved_politician_id: null }],
  });
  const a = createFakeSupabase(seed(people({ id: P1, name: "林大同", region: "彰化縣", birth_year: 1960 }, { id: P2, name: "林大同", region: "台北市" }), [BIRTH(P1, "林大同", 1960)]));
  const ra = await autoApplyContribution(a.client, C1);
  assertEquals(ra.status, "applied");
  const created = a.db.politicians.find((p) => p.id !== P1 && p.id !== P2)!;
  assertEquals(created.possible_duplicate_of, [P2]);

  const b = createFakeSupabase(seed(people({ id: P1, name: "林大同", region: "彰化縣", birth_year: 1960 }), [BIRTH(P1, "林大同", 1960)]));
  assertEquals((await autoApplyContribution(b.client, C1)).status, "applied");
  assertEquals(b.db.politicians.find((p) => p.id !== P1)!.possible_duplicate_of, undefined);
});

Deno.test("B1 身分原因退件改待指認：回 pending＋needs_identity_pick、重發驗證票、票數分數保留；只改一次，再判不出才退件", async () => {
  const mk = (extra: Record<string, unknown> = {}) => createFakeSupabase({
    contributions: [row(payload(), { agree_count: 2, score: 2, ...extra })],
    politicians: people({ id: P2, name: "林大同", region: "台北市" }),
    contribution_votes: [{ contribution_id: C1, verdict: "agree", resolved_politician_id: null }, { contribution_id: C1, verdict: "agree", resolved_politician_id: null }],
  });
  const f = mk();
  const r = await autoApplyContribution(f.client, C1);
  assertEquals(r.status, "pending");
  const c = f.db.contributions[0];
  assertEquals([c.status, c.needs_identity_pick, c.agree_count, c.score], ["pending", true, 2, 2]);
  assertEquals(f.db.politicians.length, 1, "沒有硬建人物");
  assert((f.db.task_dispatches ?? []).some((d) => d.task_id === `verify:${C1}`), "重發了驗證票");

  const again = mk({ needs_identity_pick: true });
  assertEquals((await autoApplyContribution(again.client, C1)).status, "rejected", "已經退回過一次，再判不出就照舊退件");

  const sys = mk({ reviewed_by: "cec-auto" });
  assertEquals((await autoApplyContribution(sys.client, C1)).status, "rejected", "系統驗證者簽名的件照舊退件");
});

Deno.test("C1 identityCandidateOf（gate 與落庫共用）：已指明是誰的件沒有同名問題；組法與落庫端同一份", async () => {
  assertEquals(identityCandidateOf("politician", payload({ politician_id: P1 }), null), null);
  assertEquals(identityCandidateOf("politician", { region: "x" }, null), null);
  assertEquals(identityCandidateOf("correction", payload(), null), null);
  const c = identityCandidateOf("candidacy", payload({ birth_year: 1980 }), null)!;
  assertEquals([c.name, c.birth_year, c.election_type], ["林大同", 1980, "村里長"]);
  // gate：缺生年同名者 + 交件帶生年 → 不必指認
  const fake = createFakeSupabase({ politicians: people({ id: P2, name: "林大同", region: "台北市" }), politician_keys: [] });
  assertEquals((await checkIdentityPick(fake.client, "politician", payload({ birth_year: 1980 }), null)).required, false);
  assertEquals((await checkIdentityPick(fake.client, "politician", payload(), null)).required, true);
});

// ---- SQL：觸發器、重複人物臂條件、名冊對帳 ----
const MIG = await readMig("20261111170000_identity_auto_resolve.sql");
const fnOf = (start: string, end: string) => {
  const a = MIG.indexOf(start);
  assert(a >= 0, start);
  const b = MIG.indexOf(end, a);
  assert(b > a, end);
  return MIG.slice(a, b + end.length);
};

Deno.test("D1 補上生年：兩邊不同 → 標記清掉；相同 → 標記保留（等合併任務）", async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, birth_year integer, possible_duplicate_of uuid[])`);
  await db.exec(fnOf("CREATE OR REPLACE FUNCTION politicians_clear_possible_duplicate()", "$fn$;"));
  await db.exec(`CREATE TRIGGER politicians_clear_possible_duplicate AFTER INSERT OR UPDATE OF birth_year ON politicians FOR EACH ROW EXECUTE FUNCTION politicians_clear_possible_duplicate()`);
  const id = async (sql: string) => (await db.query<{ id: string }>(sql)).rows[0].id;
  const old1 = await id(`INSERT INTO politicians (name) VALUES ('林大同') RETURNING id`);
  const old2 = await id(`INSERT INTO politicians (name) VALUES ('林大同') RETURNING id`);
  const fresh1 = await id(`INSERT INTO politicians (name, birth_year, possible_duplicate_of) VALUES ('林大同', 1980, ARRAY['${old1}']::uuid[]) RETURNING id`);
  const fresh2 = await id(`INSERT INTO politicians (name, birth_year, possible_duplicate_of) VALUES ('林大同', 1980, ARRAY['${old2}']::uuid[]) RETURNING id`);
  const mark = async (i: string) => (await db.query<{ p: string[] | null }>(`SELECT possible_duplicate_of AS p FROM politicians WHERE id = $1`, [i])).rows[0].p;
  await db.query(`UPDATE politicians SET birth_year = 1960 WHERE id = $1`, [old1]);   // 缺生年的那位補上，不同 → 清
  assertEquals(await mark(fresh1), null);
  await db.query(`UPDATE politicians SET birth_year = 1980 WHERE id = $1`, [old2]);   // 相同 → 保留
  assertEquals(await mark(fresh2), [old2]);
  await db.close();
});

Deno.test("D2 重複人物臂：標記指到對方的同名者就配對（縣市、生年都對不上也開）；沒標記不開（還原驗證）", () => {
  assert(/OR a\.id = ANY\(COALESCE\(b\.possible_duplicate_of/.test(MIG) && /OR b\.id = ANY\(COALESCE\(a\.possible_duplicate_of/.test(MIG));
  // 臂的其他條件原樣保留（以 20261031090000 為底只多一項）：同縣市或同生年或號次缺口
  assert(/COALESCE\(a\.region, ''\) = COALESCE\(b\.region, ''\) OR \(a\.birth_year IS NOT NULL AND a\.birth_year = b\.birth_year\) OR up\.a_id IS NOT NULL/.test(MIG));
  assert(/SELECT p\.id, p\.name, p\.party, p\.region, p\.birth_year, p\.current_position, p\.possible_duplicate_of,/.test(MIG), "n CTE 要帶標記欄");
});

Deno.test("D3 驗證池：needs_identity_pick 不被「分數已達標」濾掉", () => {
  assert(/OR c\.needs_identity_pick\)/.test(MIG));
  assert(/AND \(c\.score < COALESCE\(c\.target_score, d\.verify_target, contribution_effective_agree\(c\.id\)\) OR c\.needs_identity_pick\)/.test(MIG));
});

Deno.test("E1 名冊對帳：名冊有生年、全庫同名者有生年且全不同 → 唯一可建（new）；生年相同不放寬；SET enable_nestloop = off 保留", async () => {
  assert(/SET enable_nestloop = off/.test(fnOf("CREATE OR REPLACE FUNCTION roster_reconcile_rows()", "\n$$;")));
  const { db } = await buildReconcileDb();
  const m = await readMig("20261031160000_cec_roster_2026.sql");
  const sec = (name: string) => m.slice(m.indexOf(`-- ▼▼ SECTION: ${name} ▼▼`), m.indexOf(`-- ▲▲ SECTION: ${name} ▲▲`)).replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");
  await db.exec(sec("tables"));
  await db.exec(sec("source"));
  await db.exec(`ALTER TABLE politicians ADD COLUMN birth_year integer`);
  await db.exec(fnOf("CREATE OR REPLACE FUNCTION roster_reconcile_rows()", "\n$$;"));
  const URL = "https://info.cec.gov.tw/vote2026/static/json/cand/T/63000.json";
  await db.query(`INSERT INTO cec_roster_units (url, kind, election_type, county, county_code, town, town_code, status, row_count, fetched_at) VALUES ($1, 'T', '縣市議員', '臺北市', '63000', '', '', 'ok', 3, now())`, [URL]);
  for (const [n, no, birth] of [["錢四", 1, "690101"], ["孫五", 2, "690101"], ["李六", 3, null]] as const) {
    await db.query(`INSERT INTO cec_roster_2026 (election_type, county_code, county, town_code, town, district, area_code, li_code, name, name_key, cand_no, party, birth, unit_key, unit_url)
                    VALUES ('縣市議員', '63000', '臺北市', '', '', '', '01', '', $1, roster_name_key($1), $2, '無', $3, '', $4)`, [n, no, birth, URL]);
  }
  // 錢四：站上同名者 1960 年生（不同）→ new；孫五：站上同名者 1980 年生（相同）→ 不放寬；李六：名冊沒生年 → 不放寬
  for (const [n, y] of [["錢四", 1960], ["孫五", 1980], ["李六", 1960]] as const) {
    const pid = await addPerson(db, n, { region: "台北市" });
    await db.query(`UPDATE politicians SET birth_year = $1 WHERE id = $2`, [y, pid]);
  }
  const rows = await reconcile(db);
  const by = (n: string) => rows.find((r) => r.name === n)!;
  assertEquals([by("錢四").category, by("錢四").person_action], ["missing_creatable", "new"]);
  assertEquals(by("孫五").person_action, "attach", "生年相同＝同一人，維持既有的掛上去");
  assertEquals(by("李六").person_action, "attach", "名冊沒生年不放寬，維持既有");
  await db.close();
});

// ---- 標記的其他出口（審查補：不同人結論、合併、視圖輸出） ----
async function markDb() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, birth_year integer, possible_duplicate_of uuid[], merged_into uuid);
    CREATE TABLE politician_pair_resolutions (pair_key text PRIMARY KEY, a uuid NOT NULL, b uuid NOT NULL, resolution text NOT NULL);
    CREATE FUNCTION politician_pair_key(p_a uuid, p_b uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(p_a, p_b)::text || '|' || GREATEST(p_a, p_b)::text $$;`);
  await db.exec(fnOf("CREATE OR REPLACE FUNCTION politician_pair_clear_possible_duplicate()", "$fn$;"));
  await db.exec(`CREATE TRIGGER politician_pair_clear_possible_duplicate AFTER INSERT OR UPDATE OF resolution ON politician_pair_resolutions FOR EACH ROW EXECUTE FUNCTION politician_pair_clear_possible_duplicate()`);
  await db.exec(fnOf("CREATE OR REPLACE FUNCTION politicians_merged_fix_possible_duplicate()", "$fn$;"));
  await db.exec(`CREATE TRIGGER politicians_merged_fix_possible_duplicate AFTER UPDATE OF merged_into ON politicians FOR EACH ROW EXECUTE FUNCTION politicians_merged_fix_possible_duplicate()`);
  const add = async (marks: string[] = []) => (await db.query<{ id: string }>(`INSERT INTO politicians (name, possible_duplicate_of) VALUES ('林大同', $1::uuid[]) RETURNING id`, [marks.length ? `{${marks.join(",")}}` : null])).rows[0].id;
  const marks = async (id: string) => (await db.query<{ p: string[] | null }>(`SELECT possible_duplicate_of AS p FROM politicians WHERE id = $1`, [id])).rows[0].p;
  return { db, add, marks };
}

Deno.test("F1 same_person=false（pair_resolutions=different）→ 雙方標記裡指向對方的 id 清掉；same 不動", async () => {
  const { db, add, marks } = await markDb();
  const o = await add(); const o2 = await add();
  const f = await add([o, o2]);
  await db.query(`INSERT INTO politician_pair_resolutions VALUES (politician_pair_key($1, $2), $1, $2, 'different')`, [f, o]);
  assertEquals(await marks(f), [o2], "只清掉被判不同人的那位");
  await db.query(`INSERT INTO politician_pair_resolutions VALUES (politician_pair_key($1, $2), $1, $2, 'same')`, [f, o2]);
  assertEquals(await marks(f), [o2], "same（合併）不走這條，由 merged_into 觸發器處理");
  await db.close();
});

Deno.test("F2 合併：被併入者自己的標記清掉；別人標記裡指向被併入者的 id 改指向合併後那位（就是自己則拿掉）", async () => {
  const { db, add, marks } = await markDb();
  const o = await add(); const x = await add(); const f = await add([o]); const g = await add([o]);
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [x, o]);   // o 併入 x：f、g 的標記改指 x
  assertEquals(await marks(f), [x]);
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [f, x]);   // x 又併入 f：f 的標記指向自己 → 拿掉；g 的 [x] → [f]
  assertEquals(await marks(f), null);
  assertEquals(await marks(g), [f]);
  const h = await add([x]);
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [g, h]);   // 被併入者自己的標記清掉
  assertEquals(await marks(h), null);
  await db.close();
});

Deno.test("F3 視圖輸出：排除已解決與已合併的 id，空了是 NULL", async () => {
  const { db, add } = await markDb();
  const o1 = await add(); const o2 = await add(); const o3 = await add();
  const f = await add([o1, o2, o3]);
  // 繞過觸發器直接造「髒」狀態（觸發器之外的雙保險）
  await db.exec(`ALTER TABLE politicians DISABLE TRIGGER USER`);
  await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [o3, o1]);
  await db.query(`INSERT INTO politician_pair_resolutions VALUES (politician_pair_key($1, $2), $1, $2, 'different')`, [f, o2]);
  const a = MIG.indexOf("NULLIF(ARRAY(SELECT x FROM unnest(p.possible_duplicate_of)");
  assert(a > 0);
  const expr = MIG.slice(a, MIG.indexOf("AS possible_duplicate_of", a));
  const got = (await db.query<{ v: string[] | null }>(`SELECT ${expr} AS v FROM politicians p WHERE p.id = $1`, [f])).rows[0].v;
  assertEquals(got, [o3]);
  await db.query(`DELETE FROM politician_pair_resolutions`);
  await db.query(`UPDATE politicians SET possible_duplicate_of = ARRAY[$1]::uuid[] WHERE id = $2`, [o1, f]);
  assertEquals((await db.query<{ v: string[] | null }>(`SELECT ${expr} AS v FROM politicians p WHERE p.id = $1`, [f])).rows[0].v, null);
  await db.close();
});
