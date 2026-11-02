/**
 * /boost 逾時根因＋單一項目插隊（migration 20261102180000_boost_verify_fast_task_ids.sql，2026-11-02）。
 * 根因：contribution_subject_politician 的 politician_elections 分支寫 `pe.id::TEXT = payload->>'target_id'`，對欄位轉型 → 用不上索引，
 *   task_boost_matches 對 3,794 筆待驗證貢獻各掃一次整張表（正式庫 9.6 秒，PostgREST 逾時 8 秒）。
 *   A. 文字層：新版不再對 pe.id 轉型，且 target_id 先用正則擋非數字
 *   B. PGlite：correction（target_table＝politician_elections）解得出人；非數字 target_id 不炸；查詢計畫走 pe.id 索引（還原成舊寫法就是 Seq Scan，紅）
 *   C. task_ids：只插指定項目（驗證票、缺口），可單獨使用，與 kinds 並用；其他不受影響
 *   D. 白名單：task_ids 1～50 個、格式、去重
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";
import { validateBoostFilter } from "./boost-filter.ts";

const MIG = "20261102180000_boost_verify_fast_task_ids.sql";
const SQL = await readMig(MIG);
const SUBJ = fnText(SQL, "contribution_subject_politician");
const MATCH = fnText(SQL, "task_boost_matches");
const OLD_CAST = "pe.id::TEXT = p_payload->>'target_id'";
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("A 文字層：不對 pe.id 轉型；之前的定義是轉型寫法（確認我們修的是它）", async () => {
  assert(!code(SUBJ).includes("pe.id::TEXT"), "politician_elections 分支又對 id 轉型了（用不上索引，正式庫每次掃整張表）");
  assert(code(SUBJ).includes("~ '^[0-9]{1,9}$'"));
  assert((await latestFn("contribution_subject_politician", MIG)).includes(OLD_CAST), "前一版是轉型寫法");
  assertEquals(code(MATCH).includes("task_ids"), true);
});

const U1 = "4f5ef190-21bb-4bf6-8c1c-234239982ed3";
const C1 = "1a3ef5f0-349e-413c-8c53-61eb75bb4fdd";
const C2 = "9ea93ea8-1109-4692-8826-8b822fe2e4af";
const C3 = "ad9be702-950f-4572-a666-709197f2fcfc";

async function setup(subjDef: string) {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE politicians (id uuid PRIMARY KEY, region text, avatar_url text);
    CREATE TABLE politician_elections (id int UNIQUE, politician_id uuid, election_id int, election_type text);
    INSERT INTO politician_elections SELECT g, gen_random_uuid(), 2022, '縣市長' FROM generate_series(1, 20000) g;
    INSERT INTO politician_elections VALUES (35070, '${U1}', 2026, '縣市長');
    ANALYZE politician_elections;
    CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid);
    CREATE TABLE contributions (id uuid PRIMARY KEY, contribution_type text, status text, payload jsonb);
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, region text);
    CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid END $$;
    CREATE FUNCTION election_id_or_null(t text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN t ~ '^[0-9]+$' THEN t::int END $$;
    INSERT INTO contributions VALUES
      ('${C1}', 'correction', 'pending', '{"target_table":"politician_elections","target_id":"35070"}'),
      ('${C2}', 'correction', 'pending', '{"target_table":"politician_elections","target_id":"35070"}'),
      ('${C3}', 'roster_check', 'pending', '{"region":"雲林縣"}'),
      ('b0000000-0000-4000-8000-000000000001', 'correction', 'pending', '{"target_table":"politician_elections","target_id":"abc; drop"}');
    INSERT INTO task_dispatches VALUES ('auto:policy_missing:${U1}', 'policy_missing', '{"politician_id":"${U1}"}', NULL),
                                       ('auto:other:1', 'other', '{}', NULL);
  `);
  await d.exec(subjDef);
  await d.exec(MATCH);
  return d;
}
const m = async (d: PGlite, f: unknown) =>
  (await d.query<{ task_id: string }>(`SELECT task_id FROM task_boost_matches($1) ORDER BY 1`, [JSON.stringify(f)])).rows.map((r) => r.task_id);

const OLD_DEF = SUBJ.replace(/pe\.id = CASE WHEN p_payload->>'target_id' ~ '\^\[0-9\]\{1,9\}\$' THEN \(p_payload->>'target_id'\)::INT END/, OLD_CAST);
/** 函式裡 politician_elections 那段子查詢（原樣取出，p_payload 換成 c.payload）的查詢計畫 */
async function planOf(def: string): Promise<string> {
  const sub = /\(SELECT pe\.politician_id[\s\S]*?\)\s*ELSE NULL/.exec(def);
  assert(sub, "找不到 politician_elections 分支的子查詢");
  const subq = sub[0].replace(/\s*ELSE NULL$/, "").replaceAll("p_payload", "c.payload");
  const d = await setup(def);
  try {
    await d.exec("SET enable_seqscan = off");
    return (await d.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT ${subq} FROM contributions c`)).rows.map((r) => r["QUERY PLAN"]).join(" ");
  } finally { await d.close(); }
}

Deno.test("B correction 解得出人（politician_ids 對得到驗證票）；非數字 target_id 不炸", async () => {
  const d = await setup(SUBJ);
  try {
    assertEquals(await m(d, { politician_ids: [U1], kinds: ["verify"] }), [`verify:${C1}`, `verify:${C2}`]);
  } finally { await d.close(); }
});

Deno.test("B2 politician_elections 分支走 id 索引；還原驗證：舊的轉型寫法用不上索引（這條就會紅）", async () => {
  assert(OLD_DEF.includes(OLD_CAST), "還原替換沒生效");
  const now = await planOf(SUBJ);
  assert(/Index Scan using \w*id\w* on politician_elections/.test(now) || /Index.*politician_elections/.test(now), "新寫法要走索引：" + now);
  const old = await planOf(OLD_DEF);
  assert(!/Index.*politician_elections/.test(old), "舊寫法（對 id 轉型）不該走得到索引：" + old);
});

Deno.test("C task_ids：只插指定項目，可單獨用，與 kinds 並用；沒指定的不動", async () => {
  const d = await setup(SUBJ);
  try {
    assertEquals(await m(d, { task_ids: [`verify:${C1}`, `verify:${C3}`] }), [`verify:${C1}`, `verify:${C3}`]);
    assertEquals(await m(d, { task_ids: [`auto:policy_missing:${U1}`, "auto:other:1"], kinds: ["task"] }), ["auto:other:1", `auto:policy_missing:${U1}`]);
    assertEquals(await m(d, { task_ids: [`verify:${C1}`], kinds: ["task"] }), []);
    assertEquals(await m(d, { task_ids: ["verify:不存在"] }), []);
    assertEquals(await m(d, { task_ids: [`verify:${C1}`], politician_ids: [U1] }), [`verify:${C1}`], "與其他條件 AND");
    assert((await m(d, { kinds: ["verify"] })).includes(`verify:${C2}`), "沒給 task_ids 時照舊");
  } finally { await d.close(); }
});

Deno.test("D 白名單：task_ids 1～50 個、格式、去重、可單獨用", () => {
  const ok = validateBoostFilter({ task_ids: [`verify:${C1}`, `verify:${C1}`, "auto:policy_missing:x"] });
  assertEquals(ok.ok && ok.filter, { task_ids: [`verify:${C1}`, "auto:policy_missing:x"] });
  assertEquals(validateBoostFilter({ task_ids: [] }).ok, false);
  assertEquals(validateBoostFilter({ task_ids: Array.from({ length: 51 }, (_, i) => `auto:a:${i}`) }).ok, false);
  assertEquals(validateBoostFilter({ task_ids: Array.from({ length: 50 }, (_, i) => `auto:a:${i}`) }).ok, true);
  assertEquals(validateBoostFilter({ task_ids: ["a b"] }).ok, false);
  assertEquals(validateBoostFilter({ task_ids: ["x'; drop table t;--"] }).ok, false);
  assertEquals(validateBoostFilter({ task_ids: [1] }).ok, false);
  assertEquals(validateBoostFilter({ task_ids: "verify:x" }).ok, false);
});
