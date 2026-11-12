/**
 * 派工優先級加「選舉年」項（migration 20261112005000_election_year_priority.sql，維護者 11-12 裁決 #448／#450）。
 *
 *   queue_at ＝ GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds（task_queue_key，不動）；
 *   priority_seconds 多一項 election_year_priority_seconds ＝ (選舉年後兩碼 × 100) 天：2022→2200、2024→2400、2026→2600、2028→2800。
 *   沒有選舉年的件一律當 2026。
 *
 *   A. 文字層：seed／手動任務進隊／驗證票基準各只差標記的那幾行；不碰排序鍵與入列觸發器；2022 設定只關 2022；日本站不動
 *   B. PGlite：選舉年函式（含重行選舉 id 4、2028、查無）、同條件 2026 排在 2022 前面（正好 400 天）、無選舉年＝2026、
 *      手動插隊 5 年在同屆內仍最前、驗證票 −14 天仍疊加（母任務位置與新增型）、cool_until 行為不變、一次性重算區塊
 *   C. 還原驗證：拿掉選舉年那一項，B 的對應情境要翻面
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261112005000_election_year_priority.sql";
const MIG = await readMig(MIG_NAME);
const VT_MIG = "20261104120000_verify_ticket_key.sql";
const DAY = 86400;
const BOOST = 157680000; // 5 年
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 seed：新定義 ＝ 上一版逐字 ＋ 一段標記區塊（>>> 選舉年優先），拿掉區塊後與上一版完全相同", async () => {
  const prev = await latestFn("seed_auto_task_queue", MIG_NAME);
  const neu = fnText(MIG, "seed_auto_task_queue");
  const stripped = neu.replace(/  -- >>> 選舉年優先[^\n]*\n[\s\S]*?  -- <<< 選舉年優先\n/, "");
  assertNotEquals(stripped, neu, "有標記區塊");
  // 區塊前後各留一個空行的形狀：拿掉後剩下的空行要補回上一版的樣子
  assertEquals(stripped, prev.replace("  -- <<< 優先秒數\n\n  -- >>> 換號沿用排隊位置", "  -- <<< 優先秒數\n\n  -- >>> 換號沿用排隊位置"));
  assert(neu.includes("election_year_priority_seconds(election_id_or_null(g.target->>'election_id'))"));
  // 疊在流量提層之後、換號沿用之前（順序不能反：提層是取最大、選舉年是加）
  assert(neu.indexOf("流量提層的缺口（opened_by.traffic_boost）至少給") < neu.indexOf(">>> 選舉年優先"));
  assert(neu.indexOf("<<< 選舉年優先") < neu.indexOf(">>> 換號沿用排隊位置"));
});

Deno.test("A2 手動任務進隊：只差選舉年那一行（規則秒數後面 + election_year_priority_seconds）", async () => {
  const prev = await latestFn("contribution_tasks_insert_dispatch", MIG_NAME);
  const neu = fnText(MIG, "contribution_tasks_insert_dispatch");
  const prevL = new Set(lines(prev));
  const added = lines(neu).filter((l) => !prevL.has(l));
  // 規則秒數那一行少了行尾逗號、多一行 + election_year…
  assertEquals(added.length, 2, added.join("\n"));
  assert(added.some((l) => l.startsWith("+ election_year_priority_seconds(election_id_or_null(m.target->>'election_id')),")));
  const neuL = new Set(lines(neu));
  const gone = lines(prev).filter((l) => !neuL.has(l));
  assertEquals(gone.length, 1);
  assert(gone[0]!.startsWith("COALESCE((SELECT x.seconds FROM activity_priority_seconds(") && gone[0]!.endsWith("LIMIT 1), 0),"));
  // 插隊秒數（manual_front_seconds）那一行不動
  assert(neu.includes("COALESCE(manual_front_seconds(m.task_id), 0)"));
});

Deno.test("A3 驗證票基準：只有「新增型」與「沒有基準」兩個退路多減選舉年秒數；母任務基準分支一字不動", async () => {
  const prev = await latestFn("verify_ticket_base", MIG_NAME);
  const neu = fnText(MIG, "verify_ticket_base");
  const stripMark = neu.split("\n").map((l) => l.replace("  -- >>> 選舉年優先", "")).join("\n")
    .split(" - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id))").join("");
  assertEquals(stripMark, prev);
  assertEquals((neu.match(/>>> 選舉年優先/g) ?? []).length, 2);
  assert(neu.includes("SELECT p.dispatch_base_at FROM task_dispatches p"), "母任務基準照舊（母任務列的 priority_seconds 已含選舉年）");
});

Deno.test("A4 這支只動該動的：不碰排序鍵、入列觸發器、日本站；2022 設定只關 2022；不升協議、不刪東西", () => {
  const c = code(MIG);
  assert(!/CREATE OR REPLACE FUNCTION (task_queue_key|task_dispatches_queue_key|contribution_queue_row|refresh_dispatch_blocked|contribution_auto_tasks_arms|verify_ticket_key)\(/.test(c));
  assert(!/policy_jp\./.test(c), "日本站不跟");
  assert(!/DROP\s+(FUNCTION|COLUMN)\b/i.test(c) && !/DROP TABLE(?! IF EXISTS _)/i.test(c));
  assert(!/id::text\s*=/i.test(c), "禁 id::text =");
  const upd = c.match(/UPDATE election_task_config[\s\S]*?;/g) ?? [];
  assertEquals(upd.length, 1);
  assert(upd[0]!.includes("enabled = false") && upd[0]!.includes("WHERE election_id = 2022 AND enabled"));
  assert(!/election_id\s*(=|IN)\s*\(?\s*(2024|2026)/.test(upd[0]!), "2024／2026 不動");
});

Deno.test("A5 日本站 drift 守門：contribution_tasks_insert_dispatch 登記讀這支之前的版本", async () => {
  const t = await Deno.readTextFile(new URL("./policy-jp-dispatch-drift.test.ts", import.meta.url));
  assert(/name: "contribution_tasks_insert_dispatch", before: "20261112005000_election_year_priority\.sql"/.test(t));
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE elections (id integer PRIMARY KEY, election_date date NOT NULL);
INSERT INTO elections VALUES (2022, '2022-11-26'), (4, '2022-12-18'), (2024, '2024-01-13'), (2026, '2026-11-28');
CREATE TABLE election_task_config (election_id integer PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, note text, updated_at timestamptz DEFAULT now());
INSERT INTO election_task_config (election_id) VALUES (2022), (2024), (2026);
CREATE TABLE queue_settings (id smallint PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT ${BOOST}, visitor_front_seconds bigint NOT NULL DEFAULT 315360000,
  manual_front_seconds bigint NOT NULL DEFAULT 157680000, verify_priority_seconds integer NOT NULL DEFAULT 1209600, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400,
  verify_inherit_negative boolean NOT NULL DEFAULT false, no_change_verify_defer_seconds integer NOT NULL DEFAULT 86400, no_change_verify_redispatch_defer_seconds integer NOT NULL DEFAULT 172800);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1, refreshed_at timestamptz,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer, priority_seconds integer NOT NULL DEFAULT 0,
  boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, opened_at timestamptz NOT NULL DEFAULT now(), verify_follows_task boolean NOT NULL DEFAULT true,
  defer_seconds integer NOT NULL DEFAULT 0);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open', last_dispatched_at timestamptz);
CREATE TABLE task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT, matched_tasks INTEGER, matched_verifies INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE _boost_src (task_id TEXT, kind TEXT);
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql STABLE AS $f$ SELECT task_id, kind FROM _boost_src $f$;
`;
const FN_NAMES = ["uuid_or_null", "uuid_if_canonical", "question_answer_cap", "queue_slot", "task_dispatched", "task_queue_key", "verify_inherited_priority_seconds",
  "verify_ticket_is_new", "verify_ticket_parent", "verify_ticket_priority_seconds", "verify_ticket_defer_seconds", "verify_queue_key", "task_dispatches_queue_key",
  "refresh_verify_ticket_keys", "contribution_queue_row", "task_boost", "election_id_or_null"];
const TRIGGERS = `
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();
`;
/** 套用「選舉年」那三支函式（verify_ticket_base 用 mutate 可換成拿掉選舉年的版本） */
async function env(opts: { noElection?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of FN_NAMES) await db.exec(await latestFn(n, VT_MIG));
  await db.exec(await readMig(VT_MIG)); // 驗證票排序（dispatch_base_at、verify_ticket_*、新觸發器）
  await db.exec(TRIGGERS);
  const yearFn = opts.noElection
    ? `CREATE OR REPLACE FUNCTION election_year_priority_seconds(p_election_id INTEGER) RETURNS BIGINT LANGUAGE sql STABLE AS $f$ SELECT 0::BIGINT $f$;`
    : fnText(MIG, "election_year_priority_seconds");
  await db.exec(yearFn);
  await db.exec(fnText(MIG, "verify_ticket_election_seconds"));
  await db.exec(fnText(MIG, "verify_ticket_base"));
  return db;
}

let n = 0;
const q = (s: string) => s.replaceAll("'", "''");
const iso = (d: string, addDays = 0) => new Date(Date.parse(`${d}T00:00:00Z`) + addDays * DAY * 1000).toISOString().slice(0, 19);
const at = async (db: PGlite, taskId: string, col = "queue_at"): Promise<string> =>
  (await db.query<{ t: string }>(`SELECT to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS t FROM task_dispatches WHERE task_id = '${q(taskId)}'`)).rows[0]!.t;

/** 任務列：進隊時間用絕對日期；priority 是「規則秒數」，election 是 target.election_id（null＝沒有）；寫入時照 seed 的做法疊加選舉年優先 */
async function task(db: PGlite, o: { entered: string; prio?: number; election?: number | null; boost?: number; cool?: string; type?: string; raw?: boolean }): Promise<string> {
  const id = `auto:${o.type ?? "profile_gap"}:${++n}`;
  const target = o.election == null ? "{}" : JSON.stringify({ election_id: o.election });
  const prio = o.raw
    ? `${o.prio ?? 0}`
    : `${o.prio ?? 0} + election_year_priority_seconds(election_id_or_null('${q(target)}'::jsonb->>'election_id'))`;
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, last_dispatched_at, dispatch_count, priority_seconds, boost_seconds, cool_until)
    VALUES ('${q(id)}', '${o.type ?? "profile_gap"}', '${q(target)}', '${o.entered}T00:00:00Z', 0, (${prio}), ${o.boost ?? 0}, ${o.cool ? `'${o.cool}'` : "NULL"})`);
  return id;
}
const days = (a: string, b: string) => (Date.parse(a + "Z") - Date.parse(b + "Z")) / (DAY * 1000);

Deno.test("B1 election_year_priority_seconds：2022→2200 天、2024→2400、2026→2600、2028→2800；重行選舉（id 4）看投票日；空／查無＝2026", async () => {
  const db = await env();
  await db.exec(`INSERT INTO elections VALUES (2028, '2028-11-25')`);
  const f = async (id: string) => Number((await db.query<{ s: string }>(`SELECT election_year_priority_seconds(${id}) AS s`)).rows[0]!.s) / DAY;
  assertEquals(await f("2022"), 2200);
  assertEquals(await f("2024"), 2400);
  assertEquals(await f("2026"), 2600);
  assertEquals(await f("2028"), 2800, "2028 自動 2800，不用改任何東西");
  assertEquals(await f("4"), 2200, "嘉義市長重行選舉 2022-12-18 → 2022 年");
  assertEquals(await f("NULL"), 2600, "沒有選舉 id → 2026");
  assertEquals(await f("999"), 2600, "查無這個選舉 → 2026");
  await db.close();
});

Deno.test("B2 同進隊時間、同職位：2026 件排在 2022 件前面，差 400 天；2024 件居中", async () => {
  const db = await env();
  const t22 = await task(db, { entered: "2026-10-05", election: 2022 });
  const t24 = await task(db, { entered: "2026-10-05", election: 2024 });
  const t26 = await task(db, { entered: "2026-10-05", election: 2026 });
  const q22 = await at(db, t22), q24 = await at(db, t24), q26 = await at(db, t26);
  assert(q26 < q24 && q24 < q22, `${q26} < ${q24} < ${q22}`);
  assertEquals(days(q22, q26), 400);
  assertEquals(days(q22, q24), 200);
  assertEquals(q26, iso("2026-10-05", -2600));
  assertEquals(q22, iso("2026-10-05", -2200));
  // 重行選舉（id 4）與 2022 同級
  const t4 = await task(db, { entered: "2026-10-05", election: 4 });
  assertEquals(await at(db, t4), q22);
  await db.close();
});

Deno.test("B3 沒有選舉年的件（網站請求、名冊、基本資料、合併…）與 2026 件同級", async () => {
  const db = await env();
  const none = await task(db, { entered: "2026-10-05", election: null });
  const t26 = await task(db, { entered: "2026-10-05", election: 2026 });
  assertEquals(await at(db, none), await at(db, t26));
  // 5 年插隊（1826 天）的沒選舉年件，勝過沒插隊的 2026 件；若不補 2600 天（沒補的 raw 對照）則輸給它
  const boostedNone = await task(db, { entered: "2026-10-05", election: null, boost: BOOST });
  assert(await at(db, boostedNone) < await at(db, t26));
  const unbonused = await task(db, { entered: "2026-10-05", election: null, boost: BOOST, raw: true });
  assert(await at(db, unbonused) > await at(db, t26), "對照：沒補 2600 天的插隊件輸給 2026 件（維護者說的問題）");
  await db.close();
});

Deno.test("B4 同一屆內：職位優先（前段 +3 天／後段 −30 天）與手動插隊 5 年照舊疊加、仍最前", async () => {
  const db = await env();
  const plain = await task(db, { entered: "2026-10-05", election: 2022 });
  const front = await task(db, { entered: "2026-10-05", election: 2022, prio: 3 * DAY });
  const rear = await task(db, { entered: "2026-10-05", election: 2022, prio: -30 * DAY });
  const boosted = await task(db, { entered: "2026-10-05", election: 2022, boost: BOOST });
  const qs = { plain: await at(db, plain), front: await at(db, front), rear: await at(db, rear), boosted: await at(db, boosted) };
  assertEquals(days(qs.plain, qs.front), 3);
  assertEquals(days(qs.rear, qs.plain), 30);
  assertEquals(days(qs.plain, qs.boosted), BOOST / DAY);
  assert(qs.boosted < qs.front && qs.front < qs.plain && qs.plain < qs.rear, JSON.stringify(qs));
  // 跨屆：2022 的後段件仍在 2026 的後段件後面；2026 後段（−30 天）比 2022 前段（+3 天）還前（400 天差距大於職位差距 33 天）
  const r26 = await task(db, { entered: "2026-10-05", election: 2026, prio: -30 * DAY });
  assert(await at(db, r26) < await at(db, front));
  await db.close();
});

Deno.test("B5 驗證票：母任務位置 − 14 天照舊疊加（母任務是 2022 → 比 2026 的票晚 400 天）；新增型看交件 payload.election_id，沒有＝2026", async () => {
  const db = await env();
  const p22 = await task(db, { entered: "2026-10-05", election: 2022 });
  const p26 = await task(db, { entered: "2026-10-05", election: 2026 });
  await db.exec(`SELECT task_dispatched('${p22}'); SELECT task_dispatched('${p26}');`);
  const submit = async (type: string, task_id: string | null, payload: Record<string, unknown>, createdAt?: string): Promise<string> => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, payload, created_at)
      VALUES ('${id}', ${task_id ? `'${task_id}'` : "NULL"}, '${type}', '${q(JSON.stringify(payload))}', ${createdAt ? `'${createdAt}T00:00:00Z'` : "now()"})`);
    return `verify:${id}`;
  };
  const v22 = await submit("correction", p22, {});
  const v26 = await submit("correction", p26, {});
  assertEquals(await at(db, v26), iso("2026-10-05", -2600 - 14), "母任務位置（10/05 − 2600 天）− 14 天");
  assertEquals(await at(db, v22), iso("2026-10-05", -2200 - 14), "母任務位置（10/05 − 2200 天）− 14 天");
  // 新增型（policy）：基準＝交件建立時間 − 選舉年秒數，再 − 14 天
  const n22 = await submit("policy", null, { election_id: 2022 }, "2026-10-20");
  const n26 = await submit("policy", null, { election_id: 2026 }, "2026-10-20");
  const nNone = await submit("policy", null, {}, "2026-10-20");
  assertEquals(await at(db, n22), iso("2026-10-20", -2200 - 14));
  assertEquals(await at(db, n26), iso("2026-10-20", -2600 - 14));
  assertEquals(await at(db, nNone), iso("2026-10-20", -2600 - 14), "沒有選舉 id＝2026");
  // 領走一次 ＋ 7 天（步長照舊）
  await db.exec(`SELECT task_dispatched('${v22}')`);
  assertEquals(await at(db, v22), iso("2026-10-05", -2200 - 14 + 7));
  await db.close();
});

Deno.test("B6 cool_until 行為不變：冷卻結束時間仍是下限（選舉年不能讓冷卻中的件提早出來）", async () => {
  const db = await env();
  const cooling = await task(db, { entered: "2026-10-05", election: 2026, cool: "2026-11-20T00:00:00Z" });
  assertEquals(await at(db, cooling), "2026-11-20T00:00:00", "2600 天的優先也不低於冷卻結束時間");
  // 冷卻結束時間早於「進隊 − 優先秒數」時不起作用（公式的 GREATEST 照舊）
  const expired = await task(db, { entered: "2026-10-05", election: 2022, cool: "2020-01-01T00:00:00Z" });
  assertEquals(await at(db, expired), iso("2026-10-05", -2200));
  // 冷卻中、插隊：key = cool_until − boost
  const boostedCool = await task(db, { entered: "2026-10-05", election: 2022, cool: "2026-11-20T00:00:00Z", boost: BOOST });
  assertEquals(await at(db, boostedCool), iso("2026-11-20", -BOOST / DAY));
  await db.close();
});

Deno.test("B7 一次性重算區塊：priority_seconds 加選舉年、queue_at 由觸發器跟著重算、結束時自我檢查通過", async () => {
  const db = await env();
  // 舊狀態：priority_seconds 還沒有選舉年（raw）
  const a22 = await task(db, { entered: "2026-10-05", election: 2022, raw: true });
  const a26 = await task(db, { entered: "2026-10-05", election: 2026, raw: true });
  const aNone = await task(db, { entered: "2026-10-05", election: null, raw: true, prio: 3 * DAY });
  const bst = await task(db, { entered: "2026-10-05", election: 2022, raw: true, boost: BOOST });
  assert(await at(db, a22) === await at(db, a26), "重算前 2022 與 2026 同位置");
  const m = /DO \$\$\nDECLARE r RECORD; v_n INTEGER;[\s\S]*?\n\$\$;/.exec(MIG);
  assert(m, "找得到一次性重算的 DO 區塊");
  await db.exec(m[0]);
  const prio = async (id: string) => Number((await db.query<{ p: string }>(`SELECT priority_seconds::text AS p FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.p);
  assertEquals(await prio(a22), 2200 * DAY);
  assertEquals(await prio(a26), 2600 * DAY);
  assertEquals(await prio(aNone), 2600 * DAY + 3 * DAY, "沒有選舉 id＝2026，原本的 +3 天保留");
  assertEquals(days(await at(db, a22), await at(db, a26)), 400, "2022 排到 2026 後面 400 天");
  assertEquals(await at(db, bst), iso("2026-10-05", -2200 - BOOST / DAY), "插隊秒數照舊");
  await db.close();
});

Deno.test("B8 既有 verify 票（沒有選舉年的舊基準）重算後：2022 排在 2026 後面，−14 天、領走次數、插隊照舊保留；領走過的票也套", async () => {
  // 舊狀態：選舉年函式還回 0，票的基準沒有選舉年
  const db = await env({ noElection: true });
  const sub = async (payload: Record<string, unknown>, extra = ""): Promise<string> => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    await db.exec(`INSERT INTO contributions (id, contribution_type, payload, created_at) VALUES ('${id}', 'policy', '${q(JSON.stringify(payload))}', '2026-10-20T00:00:00Z')`);
    if (extra) await db.exec(extra.replaceAll("$ID", `verify:${id}`));
    return `verify:${id}`;
  };
  const v22 = await sub({ election_id: 2022 });
  const v26 = await sub({ election_id: 2026 });
  const vNone = await sub({});
  const v22taken = await sub({ election_id: 2022 }, `SELECT task_dispatched('$ID')`); // 領走過一次（＋7 天）
  const v22boost = await sub({ election_id: 2022 }, `UPDATE task_dispatches SET boost_seconds = ${BOOST} WHERE task_id = '$ID'`);
  const before = { v22: await at(db, v22), v26: await at(db, v26), taken: await at(db, v22taken), boost: await at(db, v22boost) };
  assertEquals(before.v22, before.v26, "重算前 2022 與 2026 的票同位置（隊頭被 2022 佔住的原因）");
  // 套上真的選舉年函式，跑一次性重算區塊
  await db.exec(fnText(MIG, "election_year_priority_seconds"));
  const m = /DO \$\$\nDECLARE r RECORD; v_n INTEGER;[\s\S]*?\n\$\$;/.exec(MIG);
  assert(m);
  await db.exec(m[0]);
  const after = { v22: await at(db, v22), v26: await at(db, v26), none: await at(db, vNone), taken: await at(db, v22taken), boost: await at(db, v22boost) };
  assertEquals(days(after.v22, after.v26), 400, "重算後 2022 的票排在 2026 的票後面 400 天");
  assertEquals(after.none, after.v26, "沒有選舉 id＝2026");
  assertEquals(days(after.v26, before.v26), -2600, "2026 的票整體前移 2600 天（−14 天基準保留）");
  assertEquals(days(after.taken, before.taken), -2200, "領走過的票也套，領走次數的 ＋7 天保留");
  assertEquals(days(after.boost, before.boost), -2200, "插隊的票保留插隊秒數，只加選舉年");
  assertEquals(await at(db, v22, "dispatch_base_at"), iso("2026-10-20", -2200), "基準 = 交件建立時間 − 選舉年");
  assert(after.v22 > after.v26 && after.taken > after.v26);
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
Deno.test("C1 還原驗證：選舉年函式回 0 → 2022 與 2026 同位置、驗證票新增型沒有差距（B2／B5 會翻面）", async () => {
  const db = await env({ noElection: true });
  const t22 = await task(db, { entered: "2026-10-05", election: 2022 });
  const t26 = await task(db, { entered: "2026-10-05", election: 2026 });
  assertEquals(await at(db, t22), await at(db, t26), "沒有選舉年這一項，兩屆同位置（這正是要修的）");
  await db.exec(`INSERT INTO contributions (id, contribution_type, payload, created_at) VALUES ('00000000-0000-4000-8000-0000000000aa', 'policy', '{"election_id":2022}', '2026-10-20T00:00:00Z')`);
  assertEquals(await at(db, "verify:00000000-0000-4000-8000-0000000000aa"), iso("2026-10-20", -14));
  await db.close();
});

Deno.test("C2 還原驗證：沒補 2600 天的插隊件輸給 2026 件（B3 的對照），補了就贏——公式要有那一項才成立", () => {
  // 1826 天 < 2600 天：純算術，鎖住「為什麼沒有選舉年的件要當 2026」
  assert(BOOST / DAY < 2600);
  assert(BOOST / DAY + 2600 > 2600);
});
