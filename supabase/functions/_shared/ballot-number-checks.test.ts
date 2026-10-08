/**
 * 號次重複檢查（2026-10-08，migration 20261008151000_cand_no_dup_check.sql；補號次 R8 的第二部分）。
 *
 * 維護者：「同一場選舉的號次有沒有重複很好被找出來」。交件的 cand_no 跟同一個「號次單位」裡已上線或等票中的另一位相同，
 * 或同一批交件內自己重複，系統票就判 source_support／not_supported（目標 +1），原因寫明「號次 N 與某某重複」。
 * 號次單位＝每個從 1 編起的單位（縣市長＝縣市、縣市議員＝選舉區、鄉鎮市長與區長＝鄉鎮市區、村里長＝村里；代表的選舉區我們沒記＝不檢查）。
 * 這是內部一致性檢查，不核對來源，不牴觸 09-24 的名冊例外範圍。只要 --allow-read。
 *
 * 真的 SQL 灌進 PGlite：一個資料庫灌一整組情境（跨批、同批、已上線、不同選舉區同號、村里長按村里、同一人重交、單位算不出來…），
 * 跑 cand_no_dup_check_pending 看哪些被標；每條守門做還原驗證。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BALLOT_MIG, fnText, mutate, readMig } from "./arms-pglite.ts";
import { CAND_NO_DUP_MODEL_PREFIX, candNoCheckForVerify } from "./cand-no-check.ts";

const DUP_MIG = "20261008151000_cand_no_dup_check.sql";
const B = await readMig(BALLOT_MIG);
const count = (x: string, sub: string) => x.split(sub).length - 1;
const DUP = await readMig(DUP_MIG);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C = (n: number) => `00000000-0000-4000-8000-1${String(n).padStart(11, "0")}`;

type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;

async function build(mutateDup?: (s: string) => string): Promise<Db> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text, region text, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, election_id integer, politician_id uuid, election_type text, region_id integer, candidacy_status text, cand_no integer);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, status text, payload jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE jev_decisions (id bigserial PRIMARY KEY, subject_type text, subject_id text, question text, choice text, probability numeric, confidence numeric, probabilities jsonb, model text, state jsonb, cost_usd numeric, asked_at timestamptz DEFAULT now());
    CREATE TABLE _consensus_calls (contribution_id uuid);
    CREATE FUNCTION contribution_apply_consensus(p_id uuid) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO _consensus_calls VALUES (p_id); RETURN 'pending'; END $$;
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobname text);
    CREATE TABLE _scheduled (jobname text, schedule text, command text);
    CREATE FUNCTION cron.unschedule(p text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION cron.schedule(p text, s text, c text) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN INSERT INTO _scheduled VALUES (p, s, c); RETURN 1; END $$;
    ${fnText(B, "ballot_number_unit")}`);
  await db.exec((mutateDup ?? ((s) => s))(DUP));
  return db;
}

const REGIONS: Array<[number, string, string | null, string | null]> = [
  [1, "台北市", "第01選舉區", null], [2, "台北市", "第02選舉區", null], [3, "台北市", "中山區", "新生里"], [4, "台北市", "中山區", "長安里"], [5, "連江縣", "東引鄉", null],
  [6, "台北市", "第05選舉區", null], [7, "雲林縣", "臺西鄉", "臺西村"],
];
type P = Record<string, unknown>;
const pay = (o: P): P => ({ election_id: 2026, ...o });
async function load(db: Db) {
  for (const r of REGIONS) await db.query(`INSERT INTO regions VALUES ($1, $2, $3, $4)`, r);
  // 已上線的參選紀錄：乙（議員第01選舉區，5 號）、丙（新生里村里長，2 號）
  for (const [id, name, region] of [[1, "乙", "台北市"], [2, "丙", "台北市"], [3, "戌", "台北市"], [4, "亥", "雲林縣"]] as const) await db.query(`INSERT INTO politicians VALUES ($1, $2, $3, NULL)`, [U(id), name, region]);
  await db.exec(`INSERT INTO politician_elections VALUES (1, 2026, '${U(1)}', '縣市議員', 1, 'filed', 5), (2, 2026, '${U(2)}', '村里長', 3, 'filed', 2), (3, 2026, '${U(3)}', '縣市議員', 6, 'filed', 4), (4, 2026, '${U(4)}', '村里長', 7, 'filed', 1)`);
  const council = (d: string) => ({ election_type: "縣市議員", region: "台北市", electoral_district: d });
  const village = (v: string) => ({ election_type: "村里長", region: "台北市", sub_region: "中山區", village: v });
  const mayor = { election_type: "縣市長", region: "台北市" };
  const list: Array<[number, string, P, string?]> = [
    [1, "pending", pay({ ...council("第01選舉區"), cand_no: 5, politician_id: U(11), name: "甲" })],        // 與已上線的乙同號 → 標
    [2, "pending", pay({ ...council("第02選舉區"), cand_no: 5, politician_id: U(12), name: "丁" })],        // 別的選舉區同號 → 不標
    [3, "pending", pay({ ...village("長安里"), cand_no: 3, politician_id: U(13), name: "戊" }), "2026-10-24 01:00:00+00"], // 跨批：先到
    [4, "pending", pay({ ...village("長安里"), cand_no: 3, politician_id: U(14), name: "己" }), "2026-10-24 05:00:00+00"], // 跨批：後到 → 兩邊都標
    [5, "pending", pay({ ...mayor, cand_no: 2, politician_id: U(15), name: "庚" }), "2026-10-24 06:00:00+00"],       // 同批（同一時刻）
    [6, "pending", pay({ ...mayor, cand_no: 2, politician_id: U(16), name: "辛" }), "2026-10-24 06:00:00+00"],       // 同批 → 兩邊都標
    [7, "pending", pay({ ...council("第05選舉區"), cand_no: 4, politician_id: U(3), name: "戌" })],          // 戌自己重交同號（第05選舉區沒有別人）→ 不標
    [8, "pending", pay({ ...council("第05選舉區"), cand_no: 4, name: "戌" })],                                // 沒給 politician_id、同名 → 不標
    [9, "pending", pay({ ...village("新生里"), cand_no: 2, politician_id: U(17), name: "壬" })],             // 與已上線的丙同號 → 標
    [10, "pending", pay({ ...village("長安里"), cand_no: 2, politician_id: U(18), name: "癸" })],            // 別的村里同號 → 不標
    [11, "pending", pay({ election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "東引鄉", cand_no: 1, politician_id: U(19), name: "子" })], // 代表：單位算不出來 → 不標
    [12, "pending", pay({ election_type: "鄉鎮市民代表", region: "連江縣", sub_region: "東引鄉", cand_no: 1, politician_id: U(20), name: "丑" })],
    [13, "pending", pay({ ...mayor, cand_no: "abc", politician_id: U(21), name: "寅" })],                      // 號次不是數字 → 不撿
    [14, "verified", pay({ ...mayor, cand_no: 7, politician_id: U(22), name: "卯" })],                        // 已驗證、等落庫：算「等票中的另一筆」，自己不是 pending 不撿
    [15, "pending", pay({ ...mayor, cand_no: 7, politician_id: U(23), name: "辰" })],                         // 與 14 同號 → 標
    [16, "applied", pay({ ...mayor, cand_no: 2, politician_id: U(24), name: "巳" })],                         // 已落庫的貢獻不撿，也不算（落庫後看參選紀錄）
    [17, "pending", pay({ election_type: "縣市長", region: "新北市", cand_no: 2, politician_id: U(25), name: "午" })], // 別的縣市同號 → 不標
    [18, "rejected", pay({ ...mayor, cand_no: 9, politician_id: U(26), name: "未" })],                        // 被退件的不算數
    [19, "pending", pay({ ...mayor, cand_no: 9, politician_id: U(27), name: "申" })],                         // 只跟退件的同號 → 不標
    [20, "pending", pay({ election_type: "村里長", region: "雲林縣", sub_region: "台西鄉", village: "台西村", cand_no: 1, politician_id: U(28), name: "酉" })], // 臺西村（參選紀錄）vs 台西村（交件）：同一個村里 → 標
  ];
  for (const [n, status, payload, at] of list) {
    await db.query(`INSERT INTO contributions (id, contribution_type, status, payload, created_at) VALUES ($1, 'candidacy', $2, $3::jsonb, COALESCE($4::timestamptz, now() - ($5 || ' minutes')::interval))`, [C(n), status, JSON.stringify(payload), at ?? null, String(100 - n)]);
  }
}
const FLAGGED = [1, 3, 4, 5, 6, 9, 15, 20];

type Verdicts = Record<string, boolean>;
async function suite(db: Db): Promise<Verdicts> {
  const v: Verdicts = {};
  const first = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending() AS r`))[0].r;
  const flagged = async () => (await rows<{ subject_id: string }>(db, `SELECT subject_id FROM jev_decisions WHERE model LIKE 'policy-tw/cand-no-dup%' AND choice = 'not_supported' ORDER BY subject_id`)).map((r) => r.subject_id);
  const want = FLAGGED.map(C).sort();
  v.n_flagged_set = JSON.stringify(await flagged()) === JSON.stringify(want) && first.flagged === FLAGGED.length;
  v.n_record_dup = (await flagged()).includes(C(1)) && (await flagged()).includes(C(9));
  v.n_cross_batch_both_sides = (await flagged()).includes(C(3)) && (await flagged()).includes(C(4));
  v.n_same_batch_both_sides = (await flagged()).includes(C(5)) && (await flagged()).includes(C(6));
  v.n_verified_counts_as_other = (await flagged()).includes(C(15));
  v.n_other_district_same_no_ok = !(await flagged()).includes(C(2));
  v.n_village_is_the_unit = !(await flagged()).includes(C(10)) && (await flagged()).includes(C(9));
  v.n_same_person_not_dup = !(await flagged()).includes(C(7)) && !(await flagged()).includes(C(8));
  v.n_tai_variants_same_unit = (await flagged()).includes(C(20));
  v.n_unit_unknown_unchecked = !(await flagged()).includes(C(11)) && !(await flagged()).includes(C(12));
  v.n_other_county_ok = !(await flagged()).includes(C(17));
  v.n_rejected_not_counted = !(await flagged()).includes(C(19));
  v.n_only_pending_with_numeric_picked = first.checked === 16; // 19 筆裡：非 pending 的 14（verified）、16（applied）、18（rejected）與 cand_no 不是數字的 13 不撿，剩 15 筆
  const reason = (await rows<{ state: { reason: string; unit: string; cand_no: number }; probability: number; question: string; subject_type: string; model: string }>(db,
    `SELECT state, probability::float AS probability, question, subject_type, model FROM jev_decisions WHERE subject_id = $1`, [C(1)]))[0];
  v.n_reason_names_number_and_person = !!reason && reason.state.reason.startsWith("號次 5 與 乙 重複") && reason.state.cand_no === 5 && reason.probability === 1 && reason.question === "source_support" &&
    reason.subject_type === "contribution" && reason.model.startsWith(CAND_NO_DUP_MODEL_PREFIX);
  const r3 = (await rows<{ state: { reason: string } }>(db, `SELECT state FROM jev_decisions WHERE subject_id = $1`, [C(3)]))[0];
  v.n_reason_names_pending_other = !!r3 && r3.state.reason.startsWith("號次 3 與 己 重複");
  const callsBefore = (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM _consensus_calls`))[0].n;
  const second = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending() AS r`))[0].r;
  await db.exec(`SELECT cand_no_dup_system_check('${C(1)}')`); // 直接再檢查一次已經標過的：不再寫第二張
  const total = (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM jev_decisions`))[0].n;
  const callsAfter = (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM _consensus_calls`))[0].n;
  v.n_idempotent_no_double_vote = total === FLAGGED.length && callsBefore === FLAGGED.length && callsAfter === callsBefore && second.flagged === 0;
  v.n_consensus_recomputed_once_each = callsBefore === FLAGGED.length;
  return v;
}
const ALL_N = ["n_tai_variants_same_unit", "n_flagged_set", "n_record_dup", "n_cross_batch_both_sides", "n_same_batch_both_sides", "n_verified_counts_as_other", "n_other_district_same_no_ok", "n_village_is_the_unit",
  "n_same_person_not_dup", "n_unit_unknown_unchecked", "n_other_county_ok", "n_rejected_not_counted", "n_only_pending_with_numeric_picked", "n_reason_names_number_and_person",
  "n_reason_names_pending_other", "n_idempotent_no_double_vote", "n_consensus_recomputed_once_each"];

Deno.test("N1 號次重複：已上線、跨批、同批都標 not_supported（兩邊都標）；不同選舉區／別的村里／別的縣市同號不算；同一人重交不算；代表單位不明不檢查；退件的不算數；原因寫明號次與誰重複；冪等", async () => {
  const db = await build();
  await load(db);
  const v = await suite(db);
  const red = ALL_N.filter((g) => v[g] !== true);
  assertEquals(red, [], `這些守門是紅的：${red.join("、")}`);
  assertEquals(Object.keys(v).sort(), [...ALL_N].sort());
  await db.close();
});

Deno.test("N2 排程與權限：cand-no-check-10min 打 system-one?action=cand_no_check；寫票的兩支只給 service_role；model 前綴 SQL 與 TS 一致；migration 沒有金鑰", async () => {
  const db = await build();
  const sched = await rows<{ jobname: string; schedule: string; command: string }>(db, `SELECT * FROM _scheduled`);
  assertEquals(sched.length, 1);
  assertEquals(sched[0].jobname, "cand-no-check-10min");
  assertEquals(sched[0].schedule, "4,14,24,34,44,54 * * * *");
  assert(sched[0].command.includes("system-one?action=cand_no_check") && !/apikey|service_role|Bearer|eyJ/i.test(sched[0].command));
  const code = DUP.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const f of ["cand_no_dup_conflicts(UUID)", "cand_no_dup_flag(UUID, JSONB)", "cand_no_dup_system_check(UUID)", "cand_no_dup_check_pending(INTEGER)"]) {
    assert(code.includes(`REVOKE EXECUTE ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`) && code.includes(`GRANT EXECUTE ON FUNCTION ${f} TO service_role;`), `${f} 只給 service_role`);
  }
  // 讀 contributions 的函式不能留公開執行權限（RLS 之下公開呼叫只會無聲回 NULL）；寫票的與寫戳記的是 SECURITY DEFINER＋search_path
  assertEquals(count(DUP, "SECURITY DEFINER SET search_path = public"), 3, "flag／system_check／check_pending 三支是 SECURITY DEFINER");
  assert(code.includes("ALTER TABLE cand_no_dup_checks ENABLE ROW LEVEL SECURITY;") && code.includes("CREATE POLICY cand_no_dup_checks_read ON cand_no_dup_checks FOR SELECT USING (true);"), "戳記表開 RLS、公開讀");
  assert(!/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*cand_no_dup_checks/i.test(code), "戳記表沒有任何寫入授權");
  assert(code.includes("'policy-tw/cand-no-dup-20261008'") && "policy-tw/cand-no-dup-20261008".startsWith(CAND_NO_DUP_MODEL_PREFIX));
  assert(!/eyJ[A-Za-z0-9_-]{20,}|sb_secret|service_role_key/i.test(DUP), "migration 裡沒有金鑰");
  // 不改既有的共識函式：candidacy 本來就在系統票的型別裡
  assert(!/FUNCTION (contribution_system_vote|contribution_apply_consensus|system_vote_eligible|contribution_required_agree)/.test(code));
  const next = (await Deno.readTextFile(new URL("../next/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(next.includes("CAND_NO_DUP_MODEL_PREFIX") && next.includes("candNoCheckForVerify(") && next.includes(".cand_no_check ="));
  await db.close();
});

// ---- 輪替：積壓超過上限也每一筆都檢查得到；無衝突不投任何系統票；後來才出現的衝突找得到 ----
async function starvation(mutateDup?: (s: string) => string) {
  const db = await build(mutateDup);
  for (const r of REGIONS) await db.query(`INSERT INTO regions VALUES ($1, $2, $3, $4)`, r);
  // 250 筆待驗的縣市長號次，彼此不同號、沒有衝突
  await db.exec(`INSERT INTO contributions (id, contribution_type, status, payload, created_at)
    SELECT ('00000000-0000-4000-8000-2' || lpad(g::text, 11, '0'))::uuid, 'candidacy', 'pending',
           jsonb_build_object('election_id', 2026, 'election_type', '縣市長', 'region', '台北市', 'cand_no', g, 'name', '人' || g, 'politician_id', '00000000-0000-4000-8000-3' || lpad(g::text, 11, '0')),
           now() - (300 - g) * interval '1 minute' FROM generate_series(1, 250) g`);
  const stamped = async () => (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM cand_no_dup_checks`))[0].n;
  const r1 = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending(200) AS r`))[0].r;
  const s1 = await stamped();
  const r2 = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending(200) AS r`))[0].r;
  const s2 = await stamped();
  // 全部都有戳記之後再來一輪：輪到的是戳記最舊的 200 筆（不是永遠同樣那 200 筆）
  const before = await rows<{ contribution_id: string }>(db, `SELECT contribution_id FROM cand_no_dup_checks ORDER BY checked_at, contribution_id LIMIT 50`);
  const r3 = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending(200) AS r`))[0].r;
  // 後來才出現的衝突：第 251 筆跟第 5 筆同號 → 沒戳記的最先檢查，兩邊都標（第 5 筆雖然已有戳記）
  await db.exec(`INSERT INTO contributions (id, contribution_type, status, payload, created_at) VALUES
    ('00000000-0000-4000-8000-299999999999', 'candidacy', 'pending', '{"election_id":2026,"election_type":"縣市長","region":"台北市","cand_no":5,"name":"新進","politician_id":"00000000-0000-4000-8000-399999999999"}'::jsonb, now())`);
  const r4 = (await rows<{ r: { checked: number; flagged: number } }>(db, `SELECT cand_no_dup_check_pending(1) AS r`))[0].r;
  const flagged = (await rows<{ subject_id: string }>(db, `SELECT subject_id FROM jev_decisions WHERE choice = 'not_supported' ORDER BY subject_id`)).map((x) => x.subject_id);
  const votes = await rows<{ choice: string }>(db, `SELECT DISTINCT choice FROM jev_decisions`);
  const refreshed = (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM cand_no_dup_checks WHERE contribution_id = ANY ($1::uuid[]) AND checked_at >= (SELECT max(checked_at) FROM cand_no_dup_checks) - interval '1 minute'`, [before.map((b) => b.contribution_id)]))[0].n;
  await db.close();
  return { r1, s1, r2, s2, r3, flagged, votes: votes.map((v) => v.choice), r4, refreshed };
}
Deno.test("N5 輪替：250 筆無衝突的待驗，上限 200 也每一筆都檢查得到；無衝突不投任何系統票；已有戳記的會輪替再檢查；後到的衝突找得到而且兩邊都標", async () => {
  const x = await starvation();
  assertEquals([x.r1.checked, x.s1], [200, 200]);
  assertEquals([x.r2.checked, x.s2], [200, 250], "第二輪：沒戳記的 50 筆先，上限內剩下的名額輪到戳記最舊的");
  assertEquals(x.r3.checked, 200, "全部有戳記後仍然一輪 200 筆，從戳記最舊的開始");
  assert(x.refreshed >= 50, "戳記最舊的那 50 筆這一輪被重新檢查（戳記更新）");
  assertEquals([x.r1.flagged, x.r2.flagged, x.r3.flagged], [0, 0, 0]);
  assertEquals(x.r4.checked, 1, "上限 1：只檢查沒戳記的新進那一筆");
  assertEquals(x.r4.flagged, 1, "新進的第 251 筆跟第 5 筆同號：標它自己，並連帶標另一邊（已有戳記、本輪輪不到的第 5 筆）");
  assertEquals(x.flagged, ["00000000-0000-4000-8000-200000000005", "00000000-0000-4000-8000-299999999999"]);
  assertEquals(x.votes, ["not_supported"], "只有 not_supported；沒有 supported（那會讓目標 −1、等於不核來源就放行），也沒有任何無衝突的紀錄");
});
Deno.test("N6 還原驗證：無衝突不記戳記（舊版）→ 前 200 筆永遠佔住上限，第 250 筆從沒被檢查；N5 必須紅", async () => {
  const x = await starvation((s) => mutate(s, "  INSERT INTO cand_no_dup_checks (contribution_id, checked_at, conflicts) VALUES (p_contribution_id, now(), v_n)\n  ON CONFLICT (contribution_id) DO UPDATE SET checked_at = excluded.checked_at, conflicts = excluded.conflicts;\n", ""));
  assert(x.s2 < 250, "沒有戳記就無從輪替，一直撿同樣的 200 筆");
});
Deno.test("N7 還原驗證：不照戳記排序（永遠 created_at 由舊到新）→ 戳記沒有用，N5 的輪替必須紅", async () => {
  const x = await starvation((s) => mutate(s, "     ORDER BY k.checked_at NULLS FIRST, c.created_at\n", "     ORDER BY c.created_at\n"));
  assert(x.s2 < 250);
});

Deno.test("N3 驗證項：系統發現的重複攤給驗證者看（理由、衝突的是誰、問『哪一個才對』），不給系統退件權", () => {
  const b = candNoCheckForVerify({ reason: "號次 5 與 乙 重複（同一個號次單位：台北市 第01選舉區）", unit: "台北市|第01選舉區", conflicts: [{ name: "乙" }] }, 5);
  assert(String(b.conflict).includes("號次 5 與 乙 重複"));
  assertEquals((b.conflicts as unknown[]).length, 1);
  assert(String(b.question).includes("投 agree") && String(b.question).includes("投 disagree") && String(b.question).includes("不是系統反對"));
  const none = candNoCheckForVerify(null, 3);
  assert(String(none.conflict).includes("號次 3"));
});

// ---- 還原驗證：改壞 migration 一處，對應的守門必須紅 ----
const MUTATIONS: { name: string; breaks: string[]; edit: (s: string) => string }[] = [
  { name: "已上線那一邊不比號次單位（只比選舉與號次）", breaks: ["n_flagged_set", "n_other_district_same_no_ok", "n_village_is_the_unit"],
    edit: (s) => mutate(s, "       AND ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) = me.unit\n", "") },
  { name: "等票那一邊不比號次單位", breaks: ["n_flagged_set", "n_village_is_the_unit", "n_other_county_ok"],
    edit: (s) => mutate(s, "       AND ballot_number_unit(c2.payload->>'election_type', c2.payload->>'region', c2.payload->>'electoral_district', c2.payload->>'sub_region', c2.payload->>'village') = me.unit\n", "") },
  { name: "已上線那一邊不排除同一個人", breaks: ["n_flagged_set", "n_same_person_not_dup"],
    edit: (s) => mutate(s, "       AND NOT (CASE WHEN me.pid IS NOT NULL THEN p.id::TEXT = me.pid ELSE p.name = me.pname END)\n", "") },
  { name: "等票那一邊把退件的也算", breaks: ["n_flagged_set", "n_rejected_not_counted"],
    edit: (s) => mutate(s, "c2.status IN ('pending', 'verified')", "c2.status IN ('pending', 'verified', 'rejected')") },
  { name: "等票那一邊不算已驗證等落庫的", breaks: ["n_flagged_set", "n_verified_counts_as_other"],
    edit: (s) => mutate(s, "c2.status IN ('pending', 'verified')", "c2.status IN ('pending')") },
  { name: "已經標過的還會再寫一張", breaks: ["n_idempotent_no_double_vote"],
    edit: (s) => mutate(s, "                AND j.model LIKE 'policy-tw/cand-no-dup%' AND j.choice = 'not_supported') THEN\n    RETURN false;", "                AND j.model LIKE 'policy-tw/cand-no-dup%' AND j.choice = 'not_supported' AND false) THEN\n    RETURN false;") },
  { name: "標了不重算共識", breaks: ["n_consensus_recomputed_once_each", "n_idempotent_no_double_vote"],
    edit: (s) => mutate(s, "  PERFORM contribution_apply_consensus(p_contribution_id);\n  RETURN true;\nEND;", "  RETURN true;\nEND;") },
  { name: "投成 supported（-1）而不是 not_supported", breaks: ["n_flagged_set", "n_record_dup"],
    edit: (s) => mutate(s, "VALUES ('contribution', p_contribution_id::TEXT, 'source_support', 'not_supported', 1,", "VALUES ('contribution', p_contribution_id::TEXT, 'source_support', 'supported', 1,") },
  { name: "原因沒寫號次與誰重複", breaks: ["n_reason_names_number_and_person", "n_reason_names_pending_other"],
    edit: (s) => mutate(s, "jsonb_build_object('reason', '號次 ' || (p_res->>'cand_no') || ' 與 ' || v_names || ' 重複", "jsonb_build_object('reason', '號次重複' || ' 與 ' || v_names || ' 重複") },
  { name: "連非 pending 的也檢查（verified 的也被撿）", breaks: ["n_only_pending_with_numeric_picked"],
    edit: (s) => mutate(s, "     WHERE c.contribution_type = 'candidacy' AND c.status = 'pending'\n       AND (c.payload->>'cand_no') ~ '^[0-9]{1,6}$'", "     WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')\n       AND (c.payload->>'cand_no') ~ '^[0-9]{1,6}$'") },
];
for (const m of MUTATIONS) {
  Deno.test(`N4 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const db = await build(m.edit);
    await load(db);
    const v = await suite(db);
    const red = ALL_N.filter((g) => v[g] !== true);
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await db.close();
  });
}
