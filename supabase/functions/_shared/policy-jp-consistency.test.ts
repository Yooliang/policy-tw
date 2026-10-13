/**
 * 日本站派工臂對齊正見 D 期「資料一致性と清理」（migration 20261011240000_policy_jp_consistency.sql、工作単 Yooliang/policy-ops#95 step 5）
 *   臂 placeholder_politicians（task_type placeholder_politician）／policy_validity／mismatch（task_type policy_election_mismatch）、
 *   removal の target_table=politicians（落庫 apply_politician_removal）。新しい交件型別はない。
 *   搬さない：owner_mismatch（改掛の型別と名簿がない）、raw:policy_election_missing（policies に election_id 列がなく、公約は参選が必須）。
 *
 * 只要 --allow-read。PGlite 上套「所有」_policy_jp_ migration（policy-jp-chain-db.ts）、時鐘用 `SET app.activity_today`。
 *
 *   a. 結構：臂名・総表・規則（常時窓・after_step なし・cap）・優先層・順位・主控台・型別清單は動かない・前の版に足しただけ・権限・測試名の判定
 *   b. placeholder_politicians：派す／派さない・target・前段・removal で軟移除（人物＋参選）・付いている内容があれば断る・confirmed は永久・審議中は派さない・窓の收回
 *   c. policy_validity：出典なしの公約だけ・policy（differs）で出典を足すと收回・removal・審議中・confirmed
 *   d. mismatch：日付が投票日より後だけ・correction／removal が審議中なら派さない・removal で收回・confirmed は永久
 *   e. TS：型別と任務の比對（removal の対象、policy の参選、correction）・同一件事の探査・協議版號（0.24.0 以上）
 *   f. 還原驗證・冪等
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fnText } from "./arms-pglite.ts";
import {
  addDays, applyOne, asRole, check, clock, count, dispatches, dispatchIds, events, expireCooling, freshDb, ICHI, migratedDb, mutate, one,
  openElectionWithRegion, readMig, rows, seed, submit,
} from "./policy-jp-chain-db.ts";
import { JP_TASK_ALSO, JP_TASK_ARMS, validateContributionRequest } from "./jp/contribution-schema.ts";
import { JP_APPLY_TYPES } from "./jp/apply-contribution.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";
import { JP_PROTOCOL_VERSION } from "./jp/protocol.ts";

const MIG_FILE = "20261011240000_policy_jp_consistency.sql";
const MIG_SQL = await readMig(MIG_FILE);
const PREV_PARTIES = await readMig("20261011230000_policy_jp_parties.sql");
const PREV_DUP = await readMig("20261011180000_policy_jp_duplicate_policy.sql");
const POLLING = "2027-04-25";
const E1 = `${POLLING}_mayor_${ICHI}`;
const TOTAL = "policy_jp.contribution_auto_tasks_arms";
const KOUHOU = "https://www.city.ichinomiya.aichi.jp/senkyo/kouhou.pdf";
const TODAY = addDays(POLLING, -10);
const ARMS = ["placeholder_politicians", "policy_validity", "mismatch"] as const;
const PH = ["placeholder_politician"], VAL = ["policy_validity"], MIS = ["policy_election_mismatch"];

const shared = await freshDb();
await shared.waitReady;
type Db = Awaited<ReturnType<typeof freshDb>>;

async function addCand(db: Db, name: string, kana: string): Promise<{ pid: string; peid: string }> {
  const payload = { election_id: E1, name, kana, candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" };
  const id = await submit(db, "candidacy", payload, { status: "verified", urls: [KOUHOU] });
  const out = await applyOne(db, id);
  assertEquals(out.status, "applied", JSON.stringify(out));
  const pid = (await one<{ applied_politician_id: string }>(db, `SELECT applied_politician_id FROM policy_jp.contributions WHERE id = $1`, [id])).applied_politician_id;
  return { pid, peid: out.record_id! };
}
const POL_DESC = "認可保育所の定員を 3 年で 300 人増やし、待機児童を 0 にするとしている。";
async function addPolicy(db: Db, peid: string, title = "保育所の待機児童をなくす", description = POL_DESC): Promise<string> {
  const out = await applyOne(db, await submit(db, "policy", {
    politician_election_id: peid, title, description, category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: "new",
  }, { status: "verified", urls: [KOUHOU] }));
  assertEquals(out.outcome, "applied", JSON.stringify(out));
  return out.record_id!;
}
const submitRm = (db: Db, payload: Record<string, unknown>, o: Parameters<typeof submit>[3] = {}) => submit(db, "removal", payload, { status: "verified", urls: [KOUHOU], ...o });
const rmPerson = (pid: string, reason = "選挙管理委員会の候補者一覧と公報を調べたが、この名前の人は見つからない") => ({ target_table: "politicians", target_id: pid, reason });
const rmPolicy = (id: string, reason = "選挙の掛け声であって、何をするかが読み取れないので公約ではない") => ({ target_table: "policies", target_id: id, reason });
const status = async (db: Db, table: string, id: string) => (await one<{ s: string }>(db, `SELECT review_status AS s FROM policy_jp.${table} WHERE id = $1`, [id])).s;
const closedReason = async (db: Db, taskId: string): Promise<string | null> => {
  const ev = await events(db, taskId);
  return ev.at(-1)?.event === "closed" ? ev.at(-1)!.reason : null;
};
/** 舞台：選挙・テスト名の人物 T（参選あり）・実名の人物 A（公約 1 件） */
async function stage(db: Db) {
  await openElectionWithRegion(db, ICHI, POLLING);
  const t = await addCand(db, "テスト太郎", "てすとたろう");
  const a = await addCand(db, "山田太郎", "やまだたろう");
  const pol = await addPolicy(db, a.peid);
  await clock(db, TODAY);
  return { t, a, pol };
}

// =============================================================================================
// a. 結構
// =============================================================================================
Deno.test("結構：臂名・総表・規則（常時窓・cap）・優先層・順位・主控台・型別清單は動かない・前の版に足しただけ・権限・測試名の判定", async () => {
  const names = (await one<{ a: string[] }>(shared, `SELECT policy_jp.activity_arm_names() AS a`)).a;
  for (const a of ARMS) assert(names.includes(a), a);
  const total = fnText(MIG_SQL, TOTAL);
  for (const a of ARMS) assert(total.includes(`SELECT '${a}' AS arm, t.* FROM policy_jp.contribution_auto_tasks_${a}() t`), `総表に ${a}`);
  const rule = (a: string) => one<Record<string, unknown>>(shared, `SELECT window_kind, from_kind, until_kind, after_step, enabled, params FROM policy_jp.activity_rules WHERE activity = $1 AND priority IS NULL`, [a]);
  assertEquals(await rule("placeholder_politicians"), { window_kind: "always", from_kind: null, until_kind: null, after_step: null, enabled: true, params: { cap: 20 } });
  assertEquals(await rule("policy_validity"), { window_kind: "always", from_kind: null, until_kind: null, after_step: null, enabled: true, params: { cap: 50 } });
  assertEquals(await rule("mismatch"), { window_kind: "always", from_kind: null, until_kind: null, after_step: null, enabled: true, params: { cap: 50 } });
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:placeholder_politicians' AND priority = 1 AND window_kind = 'always'`), 1);
  for (const a of ["policy_validity", "mismatch"]) assertEquals(await count(shared, `SELECT 1 FROM policy_jp.activity_rules WHERE activity = 'priority:${a}'`), 0, `${a} は既定の層`);
  const rank = (id: string, t: string) => one<{ r: number }>(shared, `SELECT policy_jp.chain_step_rank($1, $2) AS r`, [id, t]).then((x) => x.r);
  assertEquals(await rank("auto:placeholder_politician:x", "placeholder_politician"), 1);
  assertEquals(await rank("auto:policy_validity:a:b", "policy_validity"), 8);
  assertEquals(await rank("auto:policy_election_mismatch:x", "policy_election_mismatch"), 8);
  assertEquals(await rank("auto:duplicate_policy:x:y", "duplicate_policy"), 8, "既存の順位は動かない");
  assertEquals(await rank("auto:party_missing:x", "party_missing"), 4, "既存の順位は動かない");
  assertEquals(await count(shared, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE arm IN ('placeholder_politicians', 'policy_validity', 'mismatch') AND stage = 1`), 3);
  // 交件型別は増えていない（DB CHECK・apply_types・TS の清單がそのまま）
  assertEquals((await one<{ t: string[] }>(shared, `SELECT policy_jp.apply_types() AS t`)).t, [...JP_APPLY_TYPES]);
  assert(!/CREATE OR REPLACE FUNCTION policy_jp\.apply_contribution\(/.test(MIG_SQL), "apply_contribution はこの支で再定義しない");
  assert(!/policy_jp_contributions_type_check/.test(MIG_SQL) || !/ADD CONSTRAINT policy_jp_contributions_type_check/.test(MIG_SQL), "型別の CHECK は動かさない");
  assertEquals((await one<{ a: boolean; b: number }>(shared, `SELECT policy_jp.contribution_needs_two_ips('removal', '{}') AS a, policy_jp.contribution_required_agree('removal', '{}', ARRAY[]::TEXT[]) AS b`)), { a: true, b: 3 });
  // 前の版に足しただけ
  const cur = (f: string, mig = MIG_SQL) => fnText(mig, f);
  assertEquals(cur("policy_jp.activity_arm_names").replace(",\n    'placeholder_politicians',\n    'policy_validity',\n    'mismatch'", ""), cur("policy_jp.activity_arm_names", PREV_PARTIES));
  assertEquals(
    cur(TOTAL).replace(/  UNION ALL SELECT '(placeholder_politicians|policy_validity|mismatch)' AS arm, t\.\* FROM policy_jp\.contribution_auto_tasks_\w+\(\) t\n/g, ""),
    cur(TOTAL, PREV_PARTIES));
  assertEquals(
    cur("policy_jp.chain_step_rank").replace(/                  WHEN '(placeholder_politician|policy_validity|policy_election_mismatch)' THEN \d\n/g, ""),
    cur("policy_jp.chain_step_rank", PREV_PARTIES));
  assertEquals(
    cur("policy_jp.apply_removal").replace("  IF v_table = 'politicians' THEN\n    RETURN policy_jp.apply_politician_removal(c);\n  END IF;\n", "").replace("policies（政見）か politicians（人物）だけ", "policies（政見）だけ"),
    cur("policy_jp.apply_removal", PREV_DUP));
  // 権限
  for (const f of ["contribution_auto_tasks_placeholder_politicians()", "contribution_auto_tasks_policy_validity()", "contribution_auto_tasks_mismatch()", "apply_politician_removal(policy_jp.contributions)", "apply_removal(policy_jp.contributions)", "politician_attached(text)"]) {
    assertEquals((await one<{ x: boolean }>(shared, `SELECT has_function_privilege('anon', 'policy_jp.${f}', 'EXECUTE') AS x`)).x, false, f);
  }
  // 測試名の判定
  const ph = async (n: string, k: string | null = null) => (await one<{ x: boolean }>(shared, `SELECT policy_jp.politician_name_is_placeholder($1, $2) AS x`, [n, k])).x;
  for (const n of ["テスト太郎", "ﾃｽﾄ花子", "ダミー候補", "サンプル 次郎", "架空の人", "Test Taro", "dummy", "Sample-san"]) assert(await ph(n), n);
  assert(await ph("山田", "てすと"));
  for (const n of ["山田太郎", "鈴木花子", "Testa Rossa", "Samplerton"]) assertEquals(await ph(n), false, n);
  assertEquals(await ph("山田太郎", "やまだたろう"), false);
});

// =============================================================================================
// b. placeholder_politicians
// =============================================================================================
Deno.test("placeholder_politicians：テスト名の公開済みの人物だけ・target・前段・窓なし（常時）・removal で人物と参選を軟移除（履歴・出典）・收回", async () => {
  const db = await freshDb();
  const { t, a } = await stage(db);
  await seed(db);
  const task = `auto:placeholder_politician:${t.pid}`;
  assertEquals(await dispatchIds(db, PH), [task], "テスト名だけ。山田太郎は派さない");
  const d = (await dispatches(db, PH))[0];
  assertEquals(d.priority, 1, "前段");
  assertEquals(d.opened_by?.arm, "placeholder_politicians");
  assertEquals(d.region, null);
  assertEquals(d.target.politician_id, t.pid);
  assertEquals(d.target.name, "テスト太郎");
  assertEquals(d.target.attached, { policies: 0, offices: 0, careers: 0, lineage_participants: 0 });
  assertEquals((d.target.elections as Array<Record<string, unknown>>).map((e) => e.politician_election_id), [t.peid]);
  assert(d.what_we_need.includes("target_table（politicians）") && d.what_we_need.includes(t.pid) && d.what_we_need.includes(task));
  // 未公開の人物は派さない
  await db.query(`UPDATE policy_jp.politicians SET review_status = 'pending' WHERE id = $1`, [t.pid]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_placeholder_politicians()`), 0);
  await db.query(`UPDATE policy_jp.politicians SET review_status = 'published' WHERE id = $1`, [t.pid]);
  // removal を落庫
  const rm = await submitRm(db, rmPerson(t.pid), { task });
  const out = await applyOne(db, rm);
  assertEquals([out.status, out.outcome, out.table_name, out.record_id], ["applied", "applied", "politicians", t.pid], JSON.stringify(out));
  assertEquals(await status(db, "politicians", t.pid), "rejected");
  assertEquals(await status(db, "politician_elections", t.peid), "rejected");
  assertEquals(await status(db, "politicians", a.pid), "published", "ほかの人は動かない");
  assertEquals(await status(db, "politician_elections", a.peid), "published");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE contribution_id = $1 AND field = '*' AND table_name IN ('politicians', 'politician_elections')`, [rm]), 2, "人物 1 行＋参選 1 行");
  const hist = await one<{ o: { review_status: string }; n: { review_status: string } }>(db, `SELECT old_value AS o, new_value AS n FROM policy_jp.edit_history WHERE table_name = 'politicians' AND record_id = $1 AND contribution_id = $2`, [t.pid, rm]);
  assertEquals([hist.o.review_status, hist.n.review_status], ["published", "rejected"]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'politicians' AND target_id = $1`, [t.pid]), 1);
  assertEquals((await one<{ x: string }>(db, `SELECT applied_politician_id AS x FROM policy_jp.contributions WHERE id = $1`, [rm])).x, t.pid);
  await seed(db);
  assertEquals(await dispatchIds(db, PH), []);
  assertEquals(await closedReason(db, task), "filled");
  // もう一度（すでに rejected）→ unchanged
  const again = await applyOne(db, await submitRm(db, rmPerson(t.pid), { task }));
  assertEquals(again.outcome, "unchanged");
});

Deno.test("placeholder_politicians：付いている内容（政見・任期・学歴職歴・継承の役割）があると removal は断られる；reason 20 字未満・keep_id・存在しない人は invalid", async () => {
  const db = await freshDb();
  await openElectionWithRegion(db, ICHI, POLLING);
  const t = await addCand(db, "ダミー次郎", "だみーじろう");
  await clock(db, TODAY);
  await addPolicy(db, t.peid, "公共交通を守る", "バス路線を維持する。コミュニティバスの便数を維持するとしている。");
  await seed(db);
  const d = (await dispatches(db, PH))[0];
  assertEquals(d.target.attached, { policies: 1, offices: 0, careers: 0, lineage_participants: 0 });
  const r1 = await applyOne(db, await submitRm(db, rmPerson(t.pid)));
  assertEquals([r1.status, r1.outcome], ["rejected", "invalid"]);
  assert(r1.message!.includes("policies×1"), r1.message);
  assertEquals(await status(db, "politicians", t.pid), "published", "何も書かれていない");
  assertEquals(await status(db, "politician_elections", t.peid), "published");
  // 学歴職歴だけでも断る
  const db2 = await freshDb();
  await openElectionWithRegion(db2, ICHI, POLLING);
  const u = await addCand(db2, "架空 三郎", "かくうさぶろう");
  await db2.query(`INSERT INTO policy_jp.politician_careers (politician_id, kind, text, review_status) VALUES ($1, 'career', '会社員', 'published')`, [u.pid]);
  const r2 = await applyOne(db2, await submitRm(db2, rmPerson(u.pid)));
  assertEquals(r2.outcome, "invalid");
  assert(r2.message!.includes("careers×1"));
  await db2.query(`UPDATE policy_jp.politician_careers SET review_status = 'rejected' WHERE politician_id = $1`, [u.pid]);
  assertEquals((await applyOne(db2, await submitRm(db2, rmPerson(u.pid)))).outcome, "applied", "付いていたものが取り除かれれば通る");
  // 形
  const db3 = await freshDb();
  await openElectionWithRegion(db3, ICHI, POLLING);
  const v = await addCand(db3, "サンプル四郎", "さんぷるしろう");
  const bad = async (payload: Record<string, unknown>) => (await applyOne(db3, await submitRm(db3, payload))).outcome;
  assertEquals(await bad(rmPerson(v.pid, "短い理由")), "invalid");
  assertEquals(await bad({ ...rmPerson(v.pid), keep_id: "x" }), "invalid");
  assertEquals(await bad(rmPerson("nobody")), "invalid");
  assertEquals(await bad({ target_table: "elections", target_id: E1, reason: "選挙は取り除けない（政見と人物だけ）という確認用の理由" }), "invalid");
  assertEquals(await status(db3, "politicians", v.pid), "published");
});

Deno.test("placeholder_politicians：審議中の removal・実在すると確認済み（confirmed）は派さない（confirmed は永久）；not_found は冷却で戻る", async () => {
  const db = await freshDb();
  const { t } = await stage(db);
  const task = `auto:placeholder_politician:${t.pid}`;
  const rm = await submitRm(db, rmPerson(t.pid), { status: "pending", task });
  await seed(db);
  assertEquals(await dispatchIds(db, PH), [], "審議中の removal がある間は派さない");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [rm]);
  await seed(db);
  assertEquals(await dispatchIds(db, PH), [task], "退件されれば戻る");
  await check(db, task, "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, PH), [], "not_found は冷却");
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, PH), [task], "冷却が明ければ戻る");
  await check(db, task, "confirmed");
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, PH), [], "confirmed は冷却が明けても戻らない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_placeholder_politicians()`), 0);
});

Deno.test("placeholder_politicians：規則を止めれば派さない・cap で絞る", async () => {
  const db = await freshDb();
  await stage(db);
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = false WHERE activity = 'placeholder_politicians' AND priority IS NULL`);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_placeholder_politicians()`), 0, "規則が止まっていれば臂は何も返さない");
  await db.exec(`UPDATE policy_jp.activity_rules SET enabled = true, params = '{"cap":1}' WHERE activity = 'placeholder_politicians' AND priority IS NULL`);
  const u = await addCand(db, "ダミー次郎", "だみーじろう");
  assertNotEquals(u.pid, "");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_placeholder_politicians()`), 1, "cap=1");
});

// =============================================================================================
// c. policy_validity
// =============================================================================================
Deno.test("policy_validity：出典のない公開済みの公約だけ・target・policy（differs）で出典を足すと收回・removal・ほかの政見は動かない", async () => {
  const db = await freshDb();
  const { a, pol } = await stage(db);
  const pol2 = await addPolicy(db, a.peid, "公共交通を守る", "バス路線を維持する。コミュニティバスの便数を維持するとしている。");
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), [], "出典のある公約は派さない（通常は空）");
  // 出典の primary を失わせる（旧データ・手作業の事故の想定）
  await db.query(`DELETE FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = $1`, [pol]);
  await seed(db);
  const task = `auto:policy_validity:${a.peid}:${pol}`;
  assertEquals(await dispatchIds(db, VAL), [task]);
  const d = (await dispatches(db, VAL))[0];
  assertEquals(d.priority, 2, "既定の層（中段）");
  assertEquals(d.opened_by?.arm, "policy_validity");
  assertEquals(d.target.policy_id, pol);
  assertEquals(d.target.politician_election_id, a.peid);
  assertEquals(d.target.policy_title, "保育所の待機児童をなくす");
  assert(d.what_we_need.includes(`differs:${pol}`) && d.what_we_need.includes("removal") && d.what_we_need.includes(a.peid));
  assertEquals(d.region, "愛知県");
  // 出典を足す：同じ題名・同じ要約の policy（resolved_claim=differs の経路で落庫まで届く）
  const fix = await submit(db, "policy", {
    politician_election_id: a.peid, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "選挙公報 2 頁「子育て」", resolved_claim: `differs:${pol}`,
  }, { status: "verified", urls: [KOUHOU], task });
  const out = await applyOne(db, fix);
  assertEquals([out.status, out.outcome, out.record_id], ["applied", "unchanged", pol], JSON.stringify(out));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.policies WHERE politician_election_id = $1`, [a.peid]), 2, "政見は増えない");
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = $1 AND role = 'primary'`, [pol]), 1);
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), []);
  assertEquals(await closedReason(db, task), "filled");
  // 政策ではない → removal
  await db.query(`DELETE FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = $1`, [pol2]);
  await seed(db);
  const task2 = `auto:policy_validity:${a.peid}:${pol2}`;
  assertEquals(await dispatchIds(db, VAL), [task2]);
  const rm = await submitRm(db, rmPolicy(pol2), { status: "pending", task: task2 });
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), [], "審議中の removal がある間は派さない");
  await db.query(`UPDATE policy_jp.contributions SET status = 'verified' WHERE id = $1`, [rm]);
  assertEquals((await applyOne(db, rm)).outcome, "applied");
  assertEquals(await status(db, "policies", pol2), "rejected");
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), []);
  assertEquals(await closedReason(db, task2), "filled");
});

Deno.test("policy_validity：公開前・取り除かれた政見／未公開の参選は派さない；confirmed は永久・not_found は冷却", async () => {
  const db = await freshDb();
  const { a, pol } = await stage(db);
  await db.query(`DELETE FROM policy_jp.source_refs WHERE target_table = 'policies' AND target_id = $1`, [pol]);
  const task = `auto:policy_validity:${a.peid}:${pol}`;
  for (const s of ["pending", "rejected"]) {
    await db.query(`UPDATE policy_jp.policies SET review_status = $2 WHERE id = $1`, [pol, s]);
    assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_validity()`), 0, s);
  }
  await db.query(`UPDATE policy_jp.policies SET review_status = 'published' WHERE id = $1`, [pol]);
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'pending' WHERE id = $1`, [a.peid]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_validity()`), 0, "参選が未公開");
  await db.query(`UPDATE policy_jp.politician_elections SET review_status = 'published' WHERE id = $1`, [a.peid]);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.contribution_auto_tasks_policy_validity()`), 1);
  await seed(db);
  await check(db, task, "not_found");
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), []);
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), [task]);
  await check(db, task, "confirmed");
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, VAL), []);
});

// =============================================================================================
// d. mismatch
// =============================================================================================
Deno.test("mismatch：提出日が投票日より後の公約だけ・target・correction／removal が審議中なら派さない・removal で收回・confirmed は永久", async () => {
  const db = await freshDb();
  const { a, pol } = await stage(db);
  const pol2 = await addPolicy(db, a.peid, "公共交通を守る", "バス路線を維持する。コミュニティバスの便数を維持するとしている。");
  await db.query(`UPDATE policy_jp.policies SET proposed_date = $2 WHERE id = $1`, [pol2, POLLING]);
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), [], "提出日が投票日と同じ・NULL は派さない");
  await db.query(`UPDATE policy_jp.policies SET proposed_date = $2 WHERE id = $1`, [pol, addDays(POLLING, 5)]);
  await seed(db);
  const task = `auto:policy_election_mismatch:${pol}`;
  assertEquals(await dispatchIds(db, MIS), [task]);
  const d = (await dispatches(db, MIS))[0];
  assertEquals(d.opened_by?.arm, "mismatch");
  assertEquals(d.priority, 2);
  assertEquals(d.target.policy_id, pol);
  assertEquals(d.target.proposed_date, addDays(POLLING, 5));
  assertEquals(d.target.election_date, POLLING);
  assertEquals(d.target.election_id, E1);
  assertEquals(d.target.source_url, KOUHOU);
  assertEquals(d.region, "愛知県");
  assert(d.what_we_need.includes("proposed_date") && d.what_we_need.includes("election_date") && d.what_we_need.includes(pol));
  // correction が審議中（落庫されず verified で止まる）→ 派さない
  const corr = await submit(db, "correction", {
    target_table: "policies", target_id: pol, changes: [{ field: "proposed_date", current_value: addDays(POLLING, 5), correct_value: addDays(POLLING, -30) }], reason: "選挙公報の発行日が 3 月下旬であることを確認した",
  }, { status: "verified", urls: [KOUHOU], task });
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), [], "correction が verified で止まっている間は派さない");
  await db.query(`UPDATE policy_jp.contributions SET status = 'rejected' WHERE id = $1`, [corr]);
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), [task]);
  // 日付が直れば（手で適用した想定）收回
  await db.query(`UPDATE policy_jp.policies SET proposed_date = $2 WHERE id = $1`, [pol, addDays(POLLING, -30)]);
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), []);
  assertEquals(await closedReason(db, task), "filled");
  // 公約ではない → removal
  await db.query(`UPDATE policy_jp.policies SET proposed_date = $2 WHERE id = $1`, [pol, addDays(POLLING, 5)]);
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), [task]);
  const rm = await submitRm(db, rmPolicy(pol, "選挙後の施政方針の発言であって、公約として示されたものではない"), { task });
  assertEquals((await applyOne(db, rm)).outcome, "applied");
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), []);
  assertEquals(await status(db, "policies", pol), "rejected");
  // confirmed は永久
  await db.query(`UPDATE policy_jp.policies SET proposed_date = $2 WHERE id = $1`, [pol2, addDays(POLLING, 9)]);
  const task2 = `auto:policy_election_mismatch:${pol2}`;
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), [task2]);
  await check(db, task2, "confirmed");
  await expireCooling(db);
  await seed(db);
  assertEquals(await dispatchIds(db, MIS), []);
});

// =============================================================================================
// e. TS
// =============================================================================================
const base = { agent_name: "jp-agent", agent_tool: "cli/test-agent", source_urls: [KOUHOU] };
const PEID = `abc:${E1}:at_large`;
const errs = (r: { errors: Array<{ path: string }> }) => r.errors.map((e) => e.path);
const req = (type: string, task_id: string | null, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  validateContributionRequest({ ...base, contribution_type: type, payload, ...(task_id ? { task_id } : {}), ...extra });

Deno.test("TS：removal の target_table（policies／politicians）と placeholder_politician の任務の比對", () => {
  assertEquals(JP_TASK_ARMS.placeholder_politician, "removal");
  const RM = rmPerson("p-1");
  assertEquals(req("removal", null, RM).errors, []);
  assert(req("removal", null, rmPolicy("pol-1")).ok);
  assert(errs(req("removal", null, { ...RM, target_table: "elections" })).includes("payload.target_table"));
  assert(errs(req("removal", null, { ...RM, keep_id: "p-2" })).includes("payload.keep_id"), "人物に keep_id は使えない");
  assert(req("removal", null, { ...rmPolicy("pol-1"), keep_id: "pol-2" }).ok, "政見の keep_id は従来どおり");
  assert(errs(req("removal", null, { ...RM, target_id: "a b" })).includes("payload.target_id"));
  const task = "auto:placeholder_politician:p-1";
  assertEquals(req("removal", task, RM).errors, []);
  assert(errs(req("removal", task, rmPerson("p-2"))).includes("payload.target_id"), "別の人物は受けない");
  assert(errs(req("removal", task, rmPolicy("p-1"))).includes("payload.target_table"), "政見の removal では答えられない");
  assert(errs(req("candidacy", task, { election_id: E1, politician_id: "p-1", candidacy_status: "declared", status_date: "2027-03-01", district_kind: "at_large" })).includes("task_id"), "removal 以外では答えられない");
  assert(req("no_change", task, { task_id: task, outcome: "confirmed", checked_urls: [KOUHOU], finding: "選挙公報にこの名前の候補者がいることを確認した" }).ok, "no_change は task_id の形が通る");
});

Deno.test("TS：policy_validity は policy（その参選）か removal（その政見）、policy_election_mismatch は correction か removal（その政見）", () => {
  assertEquals(JP_TASK_ARMS.policy_validity, "policy");
  assertEquals(JP_TASK_ARMS.policy_election_mismatch, "correction");
  assertEquals(JP_TASK_ALSO.policy_validity, ["removal"]);
  assertEquals(JP_TASK_ALSO.policy_election_mismatch, ["removal"]);
  const vt = `auto:policy_validity:${PEID}:pol-1`;
  const pol = (patch: Record<string, unknown> = {}, extra: Record<string, unknown> = { note: "庫の政見には出典がない。この提出は原文の出典を付ける" }) =>
    req("policy", vt, { politician_election_id: PEID, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "選挙公報 2 頁", resolved_claim: "differs:pol-1", ...patch }, extra);
  assertEquals(pol().errors, []);
  assert(errs(pol({ politician_election_id: `zzz:${E1}:at_large` })).includes("payload.politician_election_id"), "別の参選は受けない");
  assert(errs(pol({}, {})).includes("note"), "differs には note が要る");
  assertEquals(req("removal", vt, rmPolicy("pol-1")).errors, []);
  assert(errs(req("removal", vt, rmPolicy("pol-9"))).includes("payload.target_id"));
  assert(errs(req("removal", vt, rmPerson("pol-1"))).includes("payload.target_table"));
  assert(errs(req("policy", "auto:policy_validity:bad", { politician_election_id: PEID, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "x", resolved_claim: "new" })).includes("task_id"));
  assert(errs(req("politician", vt, { name: "山田太郎", kana: "やまだたろう", birth_year: 1970 })).includes("task_id"), "政見以外の型別では答えられない");
  // mismatch
  const mt = "auto:policy_election_mismatch:pol-1";
  const corr = { target_table: "policies", target_id: "pol-1", changes: [{ field: "proposed_date", current_value: "2027-05-01", correct_value: "2027-03-20" }], reason: "選挙公報の発行日を確認した" };
  assertEquals(req("correction", mt, corr).errors, []);
  assertEquals(req("removal", mt, rmPolicy("pol-1")).errors, []);
  assert(errs(req("removal", mt, rmPolicy("pol-2"))).includes("payload.target_id"));
  assert(errs(req("removal", mt, rmPerson("pol-1"))).includes("payload.target_table"));
  const wrong = req("policy", mt, { politician_election_id: PEID, title: "保育所の待機児童をなくす", description: POL_DESC, category: "子育て", source_locator: "x", resolved_claim: "new" });
  const wt = wrong.errors.find((e) => e.path === "task_id");
  assert(wt && wt.message.includes("correction"), JSON.stringify(wrong.errors));
});

Deno.test("TS：同一件事の探査（policy_validity は『この参選の公約』を見せる）・協議版號 0.24.0 以上", () => {
  assertEquals(jpSameClaimProbe(`auto:policy_validity:${PEID}:pol-1`), { type: "policy", payload: { politician_election_id: PEID } });
  assertEquals(jpSameClaimProbe("auto:policy_validity:bad"), null);
  assertEquals(jpSameClaimProbe("auto:policy_validityx:abc:def"), null);
  const n = (v: string) => v.split(".").map(Number).reduce((x, y) => x * 1000 + y, 0);
  assert(n(JP_PROTOCOL_VERSION) >= n("0.24.0"), JP_PROTOCOL_VERSION);
});

// =============================================================================================
// f. 還原驗證・冪等
// =============================================================================================
Deno.test("還原驗證：apply_removal の分岐を外す／臂の除外条件を外す／総表の分支を消す／規則を欠く と探査が赤くなる；二度流しても失敗しない", async () => {
  // 1. apply_removal の politicians 分岐を外すと、migration の自我検査が失敗する
  const noBranch = mutate(MIG_SQL, "  IF v_table = 'politicians' THEN\n    RETURN policy_jp.apply_politician_removal(c);\n  END IF;\n", "");
  assert(!fnText(noBranch, "policy_jp.apply_removal").includes("apply_politician_removal(c)"));
  await (await freshDb()).exec(noBranch).then(() => assert(false, "分岐を外した migration は自我検査で失敗するはず"), (e) => assert(String(e).includes("apply_removal")));
  // 2. 『付いている内容があれば断る』を外した apply_politician_removal は政見付きの人物を取り除いてしまう
  const noGuard = mutate(MIG_SQL, "  IF v_block IS NOT NULL THEN\n    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物「%s」には", "  IF false THEN\n    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物「%s」には");
  const dbY = await freshDb();
  await dbY.exec(noGuard);
  await openElectionWithRegion(dbY, ICHI, POLLING);
  const u = await addCand(dbY, "ダミー次郎", "だみーじろう");
  await clock(dbY, TODAY);
  await addPolicy(dbY, u.peid);
  assertEquals((await applyOne(dbY, await submitRm(dbY, rmPerson(u.pid)))).outcome, "applied", "ガードを外すと取り除けてしまう＝ガードの本体は検査されている");
  // 3. confirmed の除外を外した placeholder 臂は confirmed 済みでも返してしまう
  const noConfirmed = mutate(MIG_SQL, "       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = c.task_id AND tc.outcome = 'confirmed')\n       AND NOT policy_jp.task_unavailable(c.task_id)\n     ORDER BY c.id", "       AND NOT policy_jp.task_unavailable(c.task_id)\n     ORDER BY c.id");
  const dbZ = await freshDb();
  await dbZ.exec(noConfirmed);
  await openElectionWithRegion(dbZ, ICHI, POLLING);
  const w = await addCand(dbZ, "テスト太郎", "てすとたろう");
  await check(dbZ, `auto:placeholder_politician:${w.pid}`, "confirmed");
  await expireCooling(dbZ);
  assertEquals(await count(dbZ, `SELECT 1 FROM policy_jp.contribution_auto_tasks_placeholder_politicians()`), 1, "除外を外すと冷却が明けた confirmed が戻る＝除外が効いている");
  // 4. 総表の分支が消えたら自我検査が弾く／規則が欠けても弾く
  const noUnion = mutate(MIG_SQL, "  UNION ALL SELECT 'mismatch' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mismatch() t\n", "");
  await (await freshDb()).exec(noUnion).then(() => assert(false, "分支を消した migration は自我検査で失敗するはず"), (e) => assert(String(e).includes("総表")));
  const noRule = mutate(MIG_SQL, "SELECT 'policy_validity', 'always', 'announced', '{\"cap\":50}'::JSONB,", "SELECT 'policy_validity', 'always', 'announced', '{}'::JSONB,");
  await (await migratedDb({ before: MIG_FILE })).exec(noRule).then(() => assert(false, "cap のない規則は自我検査で失敗するはず"), (e) => assert(String(e).includes("policy_validity")));
  // 5. 冪等：もう一度流し込んでも失敗しない・規則や段が増えない
  const db = await freshDb();
  await db.exec(MIG_SQL);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.activity_rules WHERE activity IN ('placeholder_politicians', 'policy_validity', 'mismatch', 'priority:placeholder_politicians')`), 4);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.console_arm_stage_map WHERE arm IN ('placeholder_politicians', 'policy_validity', 'mismatch')`), 3);
  // 6. anon は読めない・書けない（内部関数）
  for (const f of ["policy_jp.politician_attached('x')", "policy_jp.contribution_auto_tasks_mismatch()"]) {
    const denied = await asRole(shared, "anon", `SELECT * FROM ${f}`).then(() => false, () => true);
    assert(denied, f);
  }
  assertEquals((await rows(shared, `SELECT 1 FROM policy_jp.task_dispatches LIMIT 0`)).length, 0);
});
