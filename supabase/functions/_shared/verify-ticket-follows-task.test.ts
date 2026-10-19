/**
 * 驗證票的排序跟著它所屬的任務、任務有交件在途就停放（migration 20261017010000_verify_ticket_follows_task.sql；
 * policy-ops docs/work/2026-10-17-派工隊頭堵塞.md「第二步」第 1～5 項）。
 *
 * 一條規則：驗證票的排序時間＝它所屬任務的排序時間 − 14 天（queue_settings.verify_priority_seconds）；被領走一次就回隊尾（照舊，verify_follows_task 變 false）。
 *   A. 文字層：新定義＝前一版加登記的機械式替換（seed、task_boost、contribution_queue_tasks）；1970／1980 年段整套刪除；
 *      「新增」型清單只有一處，每個貢獻型別都被分類（新增貢獻型別沒決定就紅）
 *   B. PGlite（真的觸發器、真的 contribution_queue_tasks、真的 drop_applied 觸發器）：
 *      B1 一般任務的交件：驗證票＝母任務現在的排序鍵 − 14 天（含優先秒數、插隊／網站請求的秒數；母任務換鍵後沒派出過的跟著換）
 *      B2 「新增」型：建立時間 − 14 天，不接手母任務的位置（母任務被插隊也不影響）
 *      B3 沒有 1970／1980 年段：網站請求的補政見交件不再排 1970；/boost 驗證票＝每次減 boost_seconds，派出就歸零
 *      B4 派出後：照舊（派出時間 − 優先秒數 − 14 天），拿「改前」的環境同一個劇本對照；網站請求那一類不再留在 1970 段（第 3 項）
 *      B6 既有的驗證票在 migration 裡照新規則重算一次（領走過的、1970 段、1980 的 /boost 都是），下一次被領走才回隊尾
 *      B5 停放：交件在途（task_id 欄或 payload.task_id）不可派；通過→任務結束；全部被退→原位置再派（鍵不變、列沒被刪）；三型不停放
 *   C. 還原驗證：拿掉停放那一段、新增清單恆為假、驗證鍵不看母任務、拿掉 refresh 呼叫，各自對應的劇本要翻面
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";
import { fnText, latestFn, migrationNames, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261017010000_verify_ticket_follows_task.sql";
const MIG = await readMig(MIG_NAME);
const DAY = 86400;
const VS = 14 * DAY;

// ============================================================
// A. 文字層
// ============================================================
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
/** 去掉標了 >>> 的區塊（含兩條標記註解） */
const stripMarked = (s: string, marker: string) => {
  const open = `-- >>> ${marker}`;
  const a = s.indexOf(open);
  assert(a >= 0, `找不到標記 ${marker}`);
  const lineStart = s.lastIndexOf("\n", a) + 1;
  const close = `-- <<< ${marker.split("（")[0]!.split("：")[0]}`;
  const b = s.indexOf(close, a);
  assert(b > a, `找不到收尾標記 ${marker}`);
  const lineEnd = s.indexOf("\n", b) + 1;
  return s.slice(0, lineStart) + s.slice(lineEnd);
};

Deno.test("A1 seed：新定義＝20261011350000 的現行定義加兩處登記的替換，倒回去一字不差", async () => {
  const prevName = "20261011350000_queue_priority_cleanup.sql";
  const prev = fnText(await readMig(prevName), "seed_auto_task_queue");
  const neu = fnText(MIG, "seed_auto_task_queue");
  // 前一版是不是還是 seed 的最新定義（中間有人插一版，這裡的底就過期）
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  // 這支之後只允許換號沿用排隊位置（20261019040000，守門在 rekey-keeps-queue-position.test.ts：以這支為底加 rekey-position-edits.ts 的替換）
  assertEquals(defining.slice(-3), [prevName, MIG_NAME, "20261019040000_rekey_keeps_queue_position.sql"], "seed 的前一版變了：要以最新的為底重做替換");
  // 替換 1：補驗證列不再呼叫 contribution_queue_at（原本給 1970），位置由觸發器算
  const ins = "  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）\n" +
    "  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)\n  SELECT 'verify:' || c.id, now(), now(), 0\n  -- <<< 驗證票跟著任務\n";
  assertEquals(neu.split(ins).length - 1, 1);
  const orig = "  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)\n  SELECT 'verify:' || c.id, now(), contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0\n";
  assertEquals(prev.split(orig).length - 1, 1);
  // 倒回去：補驗證列那段換回原樣、最後那個標記區塊（替換 2：refresh_verify_ticket_keys）拿掉，必須逐字等於前一版
  assertEquals(stripMarked(neu.replace(ins, orig), "驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換"), prev);
  assert(neu.includes("PERFORM refresh_verify_ticket_keys();"));
});

Deno.test("A2 contribution_queue_tasks：新定義＝20261017000301 的現行定義加一段「合格：任務停放」（其餘一字不動）", async () => {
  const prev = fnText(await readMig("20261017000301_queue_tasks_eligibility_before_limit.sql"), "contribution_queue_tasks");
  const neu = fnText(MIG, "contribution_queue_tasks");
  const open = "    -- >>> 合格：任務停放\n";
  const close = "    -- <<< 合格：任務停放\n";
  assertEquals(neu.split(open).length - 1, 1);
  const stripped = neu.slice(0, neu.indexOf(open)) + neu.slice(neu.indexOf(close) + close.length);
  assertEquals(stripped, prev);
  const body = neu.slice(neu.indexOf(open) + open.length, neu.indexOf(close));
  assert(body.includes("'question', 'adjudicate', 'roster_check'"), "三型不停放");
  assert(body.includes("f.task_id IS NULL AND f.payload->>'task_id' = d.task_id"), "task_id 欄是空的看 payload.task_id");
  assert(body.includes("('pending', 'verified', 'disputed')"), "在途＝pending／verified／disputed");
});

Deno.test("A3 task_boost／task_boost_remaining：只換驗證那一段（拿掉標記區塊與登記的替換後＝前一版）", async () => {
  const prevMig = await readMig("20261011320000_queue_priority_seconds.sql");
  const prevBoost = fnText(prevMig, "task_boost");
  const neuBoost = fnText(MIG, "task_boost");
  const noBlock = stripMarked(neuBoost, "驗證票跟著任務（20261017010000）：任務列與驗證票一樣加插隊秒數");
  // 前一版的 >>> 優先秒數 區塊（驗證 1980、任務加秒數）被這支的區塊整段取代；v_at 的算法換成「命中列現在最前面的鍵」
  const prevNoBlock = stripMarked(prevBoost, "優先秒數（20261011320000）：驗證列照舊排到 1980 年段");
  const a = noBlock.split("\n").filter((l) => !prevNoBlock.split("\n").includes(l));
  assertEquals(a, [
    "  -- 回傳值的 queue_at：這次插隊命中的列現在最前面的排序鍵（原本是 1980 年段的位置；沒有命中的列就是 NULL）",
    "  SELECT min(d.queue_at) INTO v_at FROM task_dispatches d JOIN _boost_hits h ON h.task_id = d.task_id;",
  ]);
  const b = prevNoBlock.split("\n").filter((l) => !noBlock.split("\n").includes(l));
  assertEquals(b, [
    "  -- 最新的插隊最前：第 n 次 → 1980-01-01 減 n 分鐘",
    "  v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');",
  ]);
  // task_boost_remaining：只有 verifies 那一行
  const prevRem = fnText(prevMig, "task_boost_remaining").split("\n");
  const neuRem = fnText(MIG, "task_boost_remaining").split("\n");
  assertEquals(neuRem.filter((l) => !prevRem.includes(l)).length, 1);
  assert(neuRem.some((l) => l.includes("m.kind = 'verify' AND d.boost_seconds > 0")));
});

Deno.test("A4 1970／1980 年段整套刪除：觸發器與四支函式都 DROP；驗證票的位置程式碼裡沒有任何年份", () => {
  for (const d of [
    "DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front ON task_dispatches;",
    "DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front_insert ON task_dispatches;",
    "DROP FUNCTION IF EXISTS verify_front_keep();",
    "DROP FUNCTION IF EXISTS verify_front_insert();",
    "DROP FUNCTION IF EXISTS verify_row_is_front(TEXT);",
    "DROP FUNCTION IF EXISTS verify_front_tail();",
  ]) assert(MIG.includes(d), `少了：${d}`);
  for (const n of ["verify_queue_key", "task_dispatches_queue_key", "contribution_queue_row", "verify_ticket_parent", "verify_ticket_priority_seconds", "refresh_verify_ticket_keys", "task_boost", "seed_auto_task_queue"]) {
    const c = code(fnText(MIG, n));
    assert(!/19[78]0|2000-01-01|contribution_queue_at\(/.test(c), `${n} 還在用 1970／1980 年段或 contribution_queue_at`);
  }
  assert(!/verify_front_keep\(\)|verify_row_is_front|verify_front_tail/.test(code(fnText(MIG, "task_dispatches_queue_key"))));
});

Deno.test("A5 「新增」型清單只有一處（verify_ticket_is_new）；每個貢獻型別都被分類，新增型別沒決定就紅", () => {
  const NEW_ALWAYS = ["policy", "question_answer", "task_suggestion"];
  const NEW_WHEN_ROSTER_CHECK = ["candidacy", "politician"];
  const NOT_NEW = ["policy_progress", "correction", "no_change", "adjudication", "removal", "roster_check", "merge_politician", "district_seats", "policy_elements", "lineage",
    "lineage_participants", "lineage_handover", "lineage_link", "party_info", "election_results", "reassign_candidacy", "regional_stat"];
  const UNSURE = ["policy_progress", "district_seats", "policy_elements", "lineage", "lineage_participants", "lineage_handover", "lineage_link", "party_info", "regional_stat"];
  assertEquals([...NEW_ALWAYS, ...NEW_WHEN_ROSTER_CHECK, ...NOT_NEW].sort(), [...CONTRIBUTION_TYPES].sort(), "每個貢獻型別都要在這三組之一：新增貢獻型別時請決定它是不是「新增」型");
  for (const u of UNSURE) assert(NOT_NEW.includes(u), `${u} 不確定的暫列一般任務`);
  const fn = code(fnText(MIG, "verify_ticket_is_new"));
  const lists = [...fn.matchAll(/p_contribution_type IN \(([^)]*)\)/g)].map((m) => m[1]!.split(",").map((x) => x.trim().replaceAll("'", "")).sort());
  assertEquals(lists, [[...NEW_ALWAYS].sort(), [...NEW_WHEN_ROSTER_CHECK].sort()], "清單只有這兩組：一律新增的、母任務是 roster_check 才新增的");
  assertEquals([...fn.matchAll(/p_task_type = '(\w+)'/g)].map((m) => m[1]), ["roster_check"]);
  // 別處不另寫一份清單：其他函式不出現這幾個型別的字面值判斷
  for (const n of ["verify_queue_key", "verify_ticket_parent", "verify_ticket_priority_seconds", "task_dispatches_queue_key"]) {
    const c = code(fnText(MIG, n));
    assert(!/'(policy|question_answer|task_suggestion)'/.test(c), `${n} 不另寫新增清單`);
  }
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE queue_settings (id smallint PRIMARY KEY, boost_seconds bigint NOT NULL DEFAULT 157680000, visitor_front_seconds bigint NOT NULL DEFAULT 315360000,
  manual_front_seconds bigint NOT NULL DEFAULT 157680000, verify_priority_seconds integer NOT NULL DEFAULT 1209600, dispatch_horizon_seconds integer NOT NULL DEFAULT 86400,
  verify_inherit_negative boolean NOT NULL DEFAULT false);
INSERT INTO queue_settings (id) VALUES (1);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1, refreshed_at timestamptz,
  queue_at timestamptz NOT NULL DEFAULT now(), task_type text, target jsonb NOT NULL DEFAULT '{}'::jsonb, what_we_need text, hint_sources text[], reward integer, region text,
  blocked boolean NOT NULL DEFAULT false, cooling boolean NOT NULL DEFAULT false, verify_target integer, priority_seconds integer NOT NULL DEFAULT 0,
  boost_seconds bigint NOT NULL DEFAULT 0, cool_until timestamptz, opened_at timestamptz NOT NULL DEFAULT now(), verify_follows_task boolean NOT NULL DEFAULT true);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, contributor_ip_hash text, agent_name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open', last_dispatched_at timestamptz);
CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0);
CREATE TABLE question_answers (question_id uuid, agent_name text);
CREATE TABLE contribution_votes (contribution_id uuid, verifier_ip_hash text);
CREATE TABLE task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT, matched_tasks INTEGER, matched_verifies INTEGER, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE _boost_src (task_id TEXT, kind TEXT);
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql STABLE AS $f$ SELECT task_id, kind FROM _boost_src $f$;
CREATE FUNCTION seed_auto_task_queue() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$;
`;

/** 改前的函式（正式庫現況）：派出、排序鍵、1970 年段的觸發器；contribution_queue_at 用 queue_slot('verify') 當一般交件的入列位置 */
async function oldFns(): Promise<string> {
  const parts: string[] = [];
  for (const n of ["uuid_or_null", "task_target_key", "question_answer_cap", "queue_slot", "contribution_queue_at", "task_dispatched", "task_queue_key",
    "verify_inherited_priority_seconds", "task_dispatches_queue_key", "contribution_queue_row", "manual_task_closes_on_applied", "task_dispatches_drop_applied"]) {
    parts.push(await latestFn(n, MIG_NAME));
  }
  const keep = await readMig("20261011160000_verify_pool_voted_agent_front_no_change.sql");
  for (const n of ["verify_row_is_front", "verify_front_tail", "verify_front_keep", "verify_front_insert"]) parts.push(fnText(keep, n));
  return parts.join("\n");
}
const TRIGGERS = `
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();
CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();
CREATE TRIGGER contributions_drop_dispatch AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NOT (NEW.task_id LIKE 'auto:roster_check:%' AND NEW.contribution_type NOT IN ('roster_check', 'no_change')))
  EXECUTE FUNCTION task_dispatches_drop_applied();
`;
const OLD_VERIFY_FRONT_TRIGGERS = `
CREATE TRIGGER trg_task_dispatches_verify_front BEFORE UPDATE OF queue_at ON task_dispatches FOR EACH ROW
  WHEN (NEW.task_id LIKE 'verify:%' AND NEW.queue_at >= TIMESTAMPTZ '2000-01-01' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count) EXECUTE FUNCTION verify_front_keep();
CREATE TRIGGER trg_task_dispatches_verify_front_insert BEFORE INSERT ON task_dispatches FOR EACH ROW
  WHEN (NEW.task_id LIKE 'verify:%' AND NEW.queue_at >= TIMESTAMPTZ '2000-01-01') EXECUTE FUNCTION verify_front_insert();
`;

/** 改前（沒套這支 migration）的資料庫；with=true 時套上這支（mutate：還原驗證用，改壞 migration 文字） */
async function env(withMig: boolean, mutateMig: (sql: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA.replace(/CREATE FUNCTION seed_auto_task_queue[^\n]*\n/, ""));
  await db.exec(await oldFns());
  await db.exec(TRIGGERS + OLD_VERIFY_FRONT_TRIGGERS);
  if (withMig) {
    await db.exec(mutateMig(MIG));
    // task_boost 呼叫的 seed 是整支缺口總表，這裡不跑（A1 守它的文字）；留一支空的
    await db.exec("CREATE OR REPLACE FUNCTION seed_auto_task_queue() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$");
  } else {
    await db.exec("CREATE OR REPLACE FUNCTION seed_auto_task_queue() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$");
  }
  return db;
}

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const q = (s: string) => s.replaceAll("'", "''");
const secs = async (db: PGlite, taskId: string): Promise<number> =>
  Number((await db.query<{ s: string }>(`SELECT extract(epoch FROM now() - queue_at) AS s FROM task_dispatches WHERE task_id = '${q(taskId)}'`)).rows[0]!.s);
const near = (got: number, want: number, msg: string) => assert(Math.abs(got - want) < 5, `${msg}：得到 ${got.toFixed(1)}，應為 ${want}`);

/** 一個母任務（已派出過一次，進隊時間＝派出當下 − ago）；回傳 task_id */
async function parent(db: PGlite, o: { id?: string; type?: string; prio?: number; boost?: number; agoDays?: number } = {}): Promise<string> {
  const id = o.id ?? `auto:${o.type ?? "profile_gap"}:${++n}`;
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, last_dispatched_at, dispatch_count, priority_seconds, boost_seconds)
    VALUES ('${q(id)}', '${o.type ?? "profile_gap"}', now() - interval '${o.agoDays ?? 0} days', 1, ${o.prio ?? 0}, ${o.boost ?? 0})`);
  return id;
}
/** 交件：寫進 contributions（觸發器入列驗證票）；回傳驗證票的 task_id */
async function submit(db: PGlite, o: { type: string; task?: string | null; payloadTask?: string; status?: string; ageDays?: number }): Promise<{ id: string; vid: string }> {
  const id = uid();
  const payload = o.payloadTask ? JSON.stringify({ task_id: o.payloadTask }) : "{}";
  await db.exec(`INSERT INTO contributions (id, task_id, contribution_type, status, payload, created_at)
    VALUES ('${id}', ${o.task === undefined || o.task === null ? "NULL" : `'${q(o.task)}'`}, '${o.type}', '${o.status ?? "pending"}', '${q(payload)}', now() - interval '${o.ageDays ?? 0} days')`);
  return { id, vid: `verify:${id}` };
}
const dispatch = (db: PGlite, taskId: string) => db.exec(`SELECT task_dispatched('${q(taskId)}')`);

Deno.test("B1 一般任務的交件：驗證票＝母任務現在的排序鍵 − 14 天（含優先秒數；欄空的看 payload.task_id）；母任務換鍵後沒派出過的跟著換", async () => {
  const db = await env(true);
  const p = await parent(db, { prio: 3 * DAY, agoDays: 2 });
  near(await secs(db, p), 5 * DAY, "母任務的鍵＝進隊時間 − 3 天");
  const fix = await submit(db, { type: "correction", task: p });
  const nochange = await submit(db, { type: "no_change", task: null, payloadTask: p });
  near(await secs(db, fix.vid), 5 * DAY + VS, "correction：母任務的鍵 − 14 天");
  near(await secs(db, nochange.vid), 5 * DAY + VS, "no_change（task_id 只在 payload）：同一個母任務");
  // 改前（對照）：進隊時間 − 優先秒數 − 14 天 ＝ 現在 − 3 天 − 14 天，跟母任務的進隊時間無關
  const old = await env(false);
  const op = await parent(old, { prio: 3 * DAY, agoDays: 2 });
  const ofix = await submit(old, { type: "correction", task: op });
  near(await secs(old, ofix.vid), 3 * DAY + VS, "改前：看交件時間，不看母任務的位置");
  // 母任務被插隊（5 年）：沒派出過的驗證票跟著換（refresh），已經派出過的不動
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 157680000 WHERE task_id = '${q(p)}'`);
  near(await secs(db, p), 5 * DAY + 157680000, "母任務插隊 5 年");
  near(await secs(db, fix.vid), 5 * DAY + VS, "還沒 refresh：驗證票先不動");
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, fix.vid), 5 * DAY + VS + 157680000, "refresh 之後跟著母任務（含插隊秒數）");
  await dispatch(db, fix.vid);
  const afterDispatch = await secs(db, fix.vid);
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, fix.vid), afterDispatch, "派出過的不再跟著母任務");
  await db.close(); await old.close();
});

Deno.test("B1b 母任務的派工列已經不在（任務結束）：退回 進隊時間 − 入列時記下的優先秒數 − 14 天（照舊）", async () => {
  const db = await env(true);
  const p = await parent(db, { prio: 2 * DAY });
  const s = await submit(db, { type: "correction", task: p });
  near(await secs(db, s.vid), 2 * DAY + VS, "有母任務");
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${q(p)}'`);
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, s.vid), 2 * DAY + VS, "母任務不在：用入列時記下的優先秒數，位置沒有跳掉");
  await db.close();
});

Deno.test("B2 「新增」型：驗證票＝交件建立時間 − 14 天，不接手母任務的位置（母任務被插隊 5 年也不影響）", async () => {
  const db = await env(true);
  const p = await parent(db, { prio: 3 * DAY, boost: 157680000, agoDays: 1, type: "policy_missing" });
  const pol = await submit(db, { type: "policy", task: p, ageDays: 3 });
  near(await secs(db, pol.vid), 3 * DAY + VS, "policy：建立時間（3 天前）− 14 天，不是母任務的鍵");
  const ans = await submit(db, { type: "question_answer", task: p });
  near(await secs(db, ans.vid), VS, "question_answer 也是新增型");
  const sug = await submit(db, { type: "task_suggestion", task: null });
  near(await secs(db, sug.vid), VS, "task_suggestion");
  // 母任務是 roster_check：candidacy／politician 是新增；其他母任務照一般任務
  const rc = await parent(db, { type: "roster_check", prio: DAY, boost: 1000 });
  const cand = await submit(db, { type: "candidacy", task: rc });
  const pers = await submit(db, { type: "politician", task: rc });
  const rep = await submit(db, { type: "roster_check", task: rc });
  near(await secs(db, cand.vid), VS, "roster_check 的 candidacy：新增");
  near(await secs(db, pers.vid), VS, "roster_check 的 politician：新增");
  near(await secs(db, rep.vid), DAY + 1000 + VS, "roster_check 的清查回報本身：一般任務，母任務的鍵 − 14 天");
  const pg = await parent(db, { type: "profile_gap", prio: DAY });
  const cand2 = await submit(db, { type: "candidacy", task: pg });
  near(await secs(db, cand2.vid), DAY + VS, "補欄位任務的 candidacy：一般任務");
  // refresh 不會把新增型接到母任務身上
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 999999 WHERE task_id = '${q(p)}'`);
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, pol.vid), 3 * DAY + VS, "母任務再被插隊：新增型的驗證票不動");
  // 新增型入列時記的優先秒數是 0（不沿用母任務的），一般任務沿用
  const prio = async (id: string) => Number((await db.query<{ p: number }>(`SELECT priority_seconds AS p FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.p);
  assertEquals([await prio(pol.vid), await prio(cand2.vid)], [0, DAY]);
  await db.close();
});

Deno.test("B3 沒有 1970／1980 年段：網站請求的補政見交件不再排 1970；/boost 驗證票＝每次減 boost_seconds、派出歸零、task_boost_remaining 數得到", async () => {
  const db = await env(true);
  const web = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${web}', 'policy_missing', 'web_request')`);
  await parent(db, { id: web, type: "policy_missing", prio: 3 * DAY, boost: 315360000 });
  const pol = await submit(db, { type: "policy", task: web });
  near(await secs(db, pol.vid), VS, "網站請求的補政見交件：建立時間 − 14 天（原本 1970）");
  const qa = await submit(db, { type: "question_answer", task: "q-1" });
  near(await secs(db, qa.vid), VS, "公民提問的回答也不再 1970");
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id LIKE 'verify:%' AND queue_at < TIMESTAMPTZ '2000-01-01'`)).rows[0]!.n, 0);
  // /boost 驗證票
  const plain = await submit(db, { type: "correction", task: null });
  const before = await secs(db, plain.vid);
  await db.exec(`INSERT INTO _boost_src VALUES ('${plain.vid}', 'verify')`);
  await db.exec(`SELECT task_boost('a', '{}'::jsonb)`);
  near(await secs(db, plain.vid), before + 157680000, "插一次：減 5 年");
  await db.exec(`SELECT task_boost('b', '{}'::jsonb)`);
  near(await secs(db, plain.vid), before + 2 * 157680000, "插兩次：減兩份");
  const rem = (await db.query<{ r: { tasks: number; verifies: number } }>(`SELECT task_boost_remaining(1) AS r`)).rows[0]!.r;
  assertEquals(rem.verifies, 1);
  const ret = (await db.query<{ r: { queue_at: string | null; matched_verifies: number } }>(`SELECT task_boost('c', '{}'::jsonb) AS r`)).rows[0]!.r;
  assertEquals(ret.matched_verifies, 1);
  assert(ret.queue_at !== null && new Date(ret.queue_at).getUTCFullYear() < 2020, "回傳的 queue_at 是命中列現在的排序鍵（插了三次）");
  await dispatch(db, plain.vid);
  const boost = (await db.query<{ b: string }>(`SELECT boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${plain.vid}'`)).rows[0]!.b;
  assertEquals(boost, "0");
  near(await secs(db, plain.vid), VS, "派出：插隊歸零、回隊尾（派出時間 − 優先秒數 0 − 14 天）");
  assertEquals((await db.query<{ n: number }>(`SELECT task_boost_remaining(1) -> 'verifies' AS n`)).rows[0]!.n, 0);
  await db.close();
});

Deno.test("B4 派出後的位置：一般任務的驗證票照舊（改前改後同一個劇本，位置一樣）；網站請求那一類不再留在 1970 段（第 3 項）", async () => {
  const run = async (withMig: boolean) => {
    const db = await env(withMig);
    const web = uid();
    await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${web}', 'policy_missing', 'web_request')`);
    await parent(db, { id: web, type: "policy_missing", prio: 3 * DAY });
    const p = await parent(db, { prio: 3 * DAY, agoDays: 2 });
    const ordinary = await submit(db, { type: "correction", task: p });
    const front = await submit(db, { type: "policy", task: web });
    await dispatch(db, ordinary.vid);
    await dispatch(db, front.vid);
    const out = { ordinary: await secs(db, ordinary.vid), front: await secs(db, front.vid), frontYear: (await db.query<{ y: number }>(`SELECT extract(year FROM queue_at)::int AS y FROM task_dispatches WHERE task_id = '${front.vid}'`)).rows[0]!.y };
    await db.close();
    return out;
  };
  const before = await run(false), after = await run(true);
  near(before.ordinary, 3 * DAY + VS, "改前：派出時間 − 3 天 − 14 天");
  near(after.ordinary, 3 * DAY + VS, "改後：一樣");
  assert(Math.abs(before.ordinary - after.ordinary) < 5, "一般任務的驗證票派出後，改前改後位置相同");
  assertEquals(before.frontYear, 1970, "改前：網站請求的交件派出後留在 1970 段");
  near(after.front, VS, "改後：新增型派出後＝派出時間 − 0 − 14 天");
  assert(after.frontYear >= 2026);
});

// ----- B5 停放 -----
type Sc = { name: string; type?: string; setup: (taskId: string) => string; parked: boolean };
const SC: Sc[] = [
  { name: "pending 交件（task_id 欄）", parked: true, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'policy', 'pending')` },
  { name: "verified 交件", parked: true, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'correction', 'verified')` },
  { name: "disputed 交件", parked: true, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'correction', 'disputed')` },
  { name: "任務編號只在 payload.task_id 的交件（欄是空的）", parked: true, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES (NULL, 'no_change', 'pending', '{"task_id":"${t}"}')` },
  { name: "別台機器交的也停放（不分誰來領）", parked: true, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status, contributor_ip_hash, agent_name) VALUES ('${t}', 'policy', 'pending', 'ip-x', 'other')` },
  { name: "全部被退（rejected）→ 可派", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'policy', 'rejected'), ('${t}', 'correction', 'rejected')` },
  { name: "superseded／apply_failed 不算在途 → 可派", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'policy', 'superseded'), ('${t}', 'policy', 'apply_failed')` },
  { name: "欄有值時不看 payload（task_id 指別的任務）→ 可派", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status, payload) VALUES ('auto:other', 'correction', 'pending', '{"task_id":"${t}"}')` },
  { name: "question：一題多份答案，不停放", type: "question", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'question_answer', 'pending')` },
  { name: "adjudicate：不停放（另有已有裁決在等）", type: "adjudicate", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'adjudication', 'rejected'), ('${t}', 'correction', 'pending')` },
  { name: "roster_check：一單位交很多筆，不停放", type: "roster_check", parked: false, setup: (t) => `INSERT INTO contributions (task_id, contribution_type, status) VALUES ('${t}', 'candidacy', 'pending')` },
];
async function runParking(db: PGlite, only?: (s: Sc) => boolean): Promise<Array<{ s: Sc; present: boolean }>> {
  const out: Array<{ s: Sc; present: boolean }> = [];
  for (const s of SC) {
    if (only && !only(s)) continue;
    const id = s.type === "question" || s.type === "adjudicate" ? uid() : `auto:${s.type ?? "profile_gap"}:${++n}`;
    await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${id}', '${s.type ?? "profile_gap"}', '{}'::jsonb)`);
    await db.exec(s.setup(id));
    const r = await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 1000, '', NULL, NULL)`);
    out.push({ s, present: r.rows.some((x) => x.task_id === id) });
  }
  return out;
}

Deno.test("B5a 停放：有交件在途（pending／verified／disputed、欄或 payload）的任務不可派，不分誰來領；全被退、三型不停放", async () => {
  const db = await env(true);
  const res = await runParking(db);
  assertEquals(res.filter((r) => r.present === r.s.parked).map((r) => `${r.s.name}（${r.s.parked ? "該停放卻出現" : "該可派卻被排除"}）`), []);
  await db.close();
});

Deno.test("B5b 全部被退→任務回到原位置再派：派工列沒被刪、queue_at 一個字不動（停放期間 seed 式的內容更新也不動它）", async () => {
  const db = await env(true);
  const p = await parent(db, { prio: 2 * DAY, agoDays: 1, type: "policy_missing" });
  const key = async () => (await db.query<{ k: string }>(`SELECT queue_at::text AS k FROM task_dispatches WHERE task_id = '${q(p)}'`)).rows[0]!.k;
  const ready = async () => (await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_queue_tasks(NULL, NULL, 100, '')`)).rows.some((r) => r.task_id === p);
  const k0 = await key();
  assertEquals(await ready(), true);
  const a = await submit(db, { type: "policy", task: p });
  const b = await submit(db, { type: "policy", task: p });
  assertEquals(await ready(), false, "有兩份在途：停放");
  assertEquals(await key(), k0, "停放中鍵不動");
  await db.exec(`UPDATE task_dispatches SET what_we_need = 'x', refreshed_at = now() WHERE task_id = '${q(p)}'`);
  assertEquals(await key(), k0, "seed 式的內容更新不動位置");
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${a.id}'`);
  assertEquals(await ready(), false, "還有一份在途：仍停放");
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${b.id}'`);
  assertEquals(await ready(), true, "全部被退：回到可派");
  assertEquals(await key(), k0, "原位置、原鍵");
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = '${q(p)}'`)).rows[0]!.n, 1, "列還在");
  await db.close();
});

Deno.test("B5c 任一份通過→任務結束：auto: 缺口的派工列立刻收回（task_id 欄對得上）；手動任務照 shouldCloseOnApplied；一題多份與名單清查不收", async () => {
  const db = await env(true);
  const exists = async (id: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = '${q(id)}'`)).rows[0]!.n === 1;
  const gap = await parent(db, { type: "policy_missing" });
  const s1 = await submit(db, { type: "policy", task: gap });
  const s2 = await submit(db, { type: "policy", task: gap });
  assertEquals(await exists(gap), true, "在途：列還在（停放）");
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${s1.id}'`);
  assertEquals(await exists(gap), false, "有一份通過：缺口列立刻收回，不等 seed");
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${s2.id}'`);
  const manual = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${manual}', 'policy_missing', 'manual')`);
  await parent(db, { id: manual, type: "policy_missing" });
  const m1 = await submit(db, { type: "policy", task: manual });
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${m1.id}'`);
  assertEquals(await exists(manual), false, "手動的補政見任務：通過就收回（同 TS 的 shouldCloseOnApplied）");
  const qt = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${qt}', 'question', 'manual')`);
  await parent(db, { id: qt, type: "question" });
  const qa = await submit(db, { type: "question_answer", task: qt });
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${qa.id}'`);
  assertEquals(await exists(qt), true, "公民提問一題多份：不收");
  const rc = await parent(db, { id: "auto:roster_check:台北市", type: "roster_check" });
  const rcs = await submit(db, { type: "candidacy", task: rc });
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${rcs.id}'`);
  assertEquals(await exists(rc), true, "名單清查：單筆參選紀錄落庫不收");
  await db.close();
});

// ----- C. 還原驗證 -----
Deno.test("C1 還原驗證：拿掉停放那一段，B5a 該停放的劇本全部翻面（出現）", async () => {
  const open = "    -- >>> 合格：任務停放\n";
  const close = "    -- <<< 合格：任務停放\n";
  const db = await env(true, (s) => s.slice(0, s.indexOf(open)) + s.slice(s.indexOf(close) + close.length));
  const res = await runParking(db, (s) => s.parked);
  const stillParked = res.filter((r) => !r.present).map((r) => r.s.name);
  // 「任務編號只在 payload.task_id 的 no_change」另有查無回報那一段擋著，不算這一段的功勞
  assertEquals(stillParked, ["任務編號只在 payload.task_id 的交件（欄是空的）"]);
  await db.close();
});

Deno.test("C2 還原驗證：新增清單恆為假 → B2 的新增型劇本翻面（變成接手母任務的位置）", async () => {
  const db = await env(true, (s) => mutate(s, "SELECT p_contribution_type IN ('policy', 'question_answer', 'task_suggestion')\n      OR (p_contribution_type IN ('candidacy', 'politician') AND p_task_type = 'roster_check')", "SELECT false"));
  const p = await parent(db, { prio: 3 * DAY, boost: 157680000, type: "policy_missing" });
  const pol = await submit(db, { type: "policy", task: p, ageDays: 3 });
  const got = await secs(db, pol.vid);
  assert(Math.abs(got - (3 * DAY + VS)) > DAY, `新增清單壞了，驗證票就會接手母任務的位置（得到 ${got.toFixed(0)}）`);
  assert(got > 157680000, "接手了母任務的 5 年插隊");
  await db.close();
});

Deno.test("C3 還原驗證：驗證鍵不看母任務（退回進隊時間 − 優先秒數 − 14 天）→ B1 翻面；不呼叫 refresh → 母任務換鍵後不跟", async () => {
  const noParent = await env(true, (s) => mutate(s, "FROM task_dispatches p WHERE p.task_id = t.parent_id) - make_interval(secs => s.vs),", "FROM task_dispatches p WHERE false) - make_interval(secs => s.vs),"));
  const p = await parent(noParent, { prio: 3 * DAY, agoDays: 2 });
  const s = await submit(noParent, { type: "correction", task: p });
  assert(Math.abs((await secs(noParent, s.vid)) - (5 * DAY + VS)) > DAY, "不看母任務：驗證票不在母任務的位置上");
  await noParent.close();
  const noRefresh = await env(true, (s) => mutate(s, "   WHERE d.task_id LIKE 'verify:%' AND d.verify_follows_task\n     AND d.queue_at IS DISTINCT FROM", "   WHERE false AND d.queue_at IS DISTINCT FROM"));
  const p2 = await parent(noRefresh, { prio: 0 });
  const s2 = await submit(noRefresh, { type: "correction", task: p2 });
  await noRefresh.exec(`UPDATE task_dispatches SET boost_seconds = 157680000 WHERE task_id = '${q(p2)}'`);
  await noRefresh.exec("SELECT refresh_verify_ticket_keys()");
  assert(Math.abs((await secs(noRefresh, s2.vid)) - (VS + 157680000)) > DAY, "refresh 壞了：母任務插隊後驗證票沒有跟著走");
  await noRefresh.close();
});

Deno.test("B6 既有的驗證票在 migration 裡照新規則重算一次（領走過的、1970 段、1980 的 /boost 都是）；下一次被領走才回隊尾、不再跟母任務", async () => {
  const db = await env(false);
  const photo = await parent(db, { type: "avatar_choice", boost: 157680000, prio: 3 * DAY });
  const web = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${web}', 'policy_missing', 'web_request')`);
  await parent(db, { id: web, type: "policy_missing", prio: 3 * DAY, boost: 315360000 });
  const t1 = await submit(db, { type: "no_change", task: null, payloadTask: photo });
  await dispatch(db, t1.vid); // 改前：領走一次回隊尾
  const t2 = await submit(db, { type: "policy", task: web });
  const t3 = await submit(db, { type: "correction", task: null });
  await db.exec(`UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01' - INTERVAL '5 minutes' WHERE task_id = '${t3.vid}'`);
  const year = async (id: string) => Number((await db.query<{ y: number }>(`SELECT extract(year FROM queue_at)::int AS y FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.y);
  near(await secs(db, t1.vid), 3 * DAY + VS, "改前：領走過的在隊尾（派出時間 − 3 天 − 14 天）");
  assertEquals([await year(t2.vid), await year(t3.vid)], [1970, 1979]);
  await db.exec(MIG);
  await db.exec("CREATE OR REPLACE FUNCTION seed_auto_task_queue() RETURNS integer LANGUAGE sql AS $f$ SELECT 0 $f$");
  near(await secs(db, t1.vid), 3 * DAY + 157680000 + VS, "領走過的也照新規則重算：母任務（照片，插隊 5 年、前段 3 天）的鍵 − 14 天");
  near(await secs(db, t2.vid), VS, "網站請求的補政見交件：離開 1970，＝建立時間 − 14 天");
  near(await secs(db, t3.vid), 157680000 + 300 + VS, "/boost 過的驗證票：1980 年段換成插隊秒數（5 年＋保留先後的 300 秒）");
  const state = async (id: string) => (await db.query<{ f: boolean; b: string }>(`SELECT verify_follows_task AS f, boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!;
  assertEquals([(await state(t1.vid)).f, (await state(t3.vid)).b], [true, String(157680000 + 300)]);
  // 下一次被領走：回隊尾（今天的行為），不再跟母任務
  await dispatch(db, t1.vid);
  near(await secs(db, t1.vid), 3 * DAY + VS, "被領走：派出時間 − 入列時記下的優先秒數 − 14 天");
  assertEquals((await state(t1.vid)).f, false);
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id = '${q(photo)}'`);
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, t1.vid), 3 * DAY + VS, "領走過的不再跟母任務");
  await db.close();
});

Deno.test("C4 還原驗證：拿掉 contributions_drop_dispatch 觸發器，通過的交件就不會收回缺口列（B5c 的第一條翻面）；停放也不會自己把列刪掉", async () => {
  const db = await env(true);
  await db.exec("DROP TRIGGER contributions_drop_dispatch ON contributions");
  const gap = await parent(db, { type: "policy_missing" });
  const s1 = await submit(db, { type: "policy", task: gap });
  await db.exec(`UPDATE contributions SET status = 'applied' WHERE id = '${s1.id}'`);
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM task_dispatches WHERE task_id = '${q(gap)}'`)).rows[0]!.n, 1, "沒有觸發器：通過了列還在（所以 B5c 的「立刻收回」是那個觸發器的功勞）");
  await db.close();
});

Deno.test("A6 contribution_auto_tasks（/tasks、/request-task）：新定義＝20261002000006 的現行定義加一段「合格：任務停放」，其餘一字不動", async () => {
  const prev = fnText(await readMig("20261002000006_queue_pop_head.sql"), "contribution_auto_tasks");
  const neu = fnText(MIG, "contribution_auto_tasks");
  const open = "    -- >>> 合格：任務停放\n";
  const close = "    -- <<< 合格：任務停放\n";
  assertEquals(neu.split(open).length - 1, 1);
  assertEquals(neu.slice(0, neu.indexOf(open)) + neu.slice(neu.indexOf(close) + close.length), prev);
  // 兩支讀者用同一段條件
  const body = (s: string) => s.slice(s.indexOf(open) + open.length, s.indexOf(close)).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assertEquals(body(neu), body(fnText(MIG, "contribution_queue_tasks")));
});

Deno.test("B7 驗證票的母任務優先秒數是負的（後段）：verify_inherit_negative＝false（預設）當 0、true 才照算（10-13 常設裁決「已經交的件不要等一個多月」）", async () => {
  const db = await env(true);
  const p = await parent(db, { prio: -30 * DAY });
  near(await secs(db, p), -30 * DAY, "母任務在 30 天後才輪到");
  const t = await submit(db, { type: "correction", task: p });
  near(await secs(db, t.vid), VS, "預設：負的當 0 → 現在 − 14 天，不會落在未來");
  await db.exec("UPDATE queue_settings SET verify_inherit_negative = true");
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, t.vid), VS - 30 * DAY, "打開設定：照母任務的鍵（未來）");
  await db.exec("UPDATE queue_settings SET verify_inherit_negative = false");
  await db.exec("SELECT refresh_verify_ticket_keys()");
  near(await secs(db, t.vid), VS, "關回去又當 0");
  // 正的優先秒數與插隊不受影響
  const q2 = await parent(db, { prio: 3 * DAY, boost: 1000 });
  const t2 = await submit(db, { type: "correction", task: q2 });
  near(await secs(db, t2.vid), 3 * DAY + 1000 + VS, "正的照舊");
  await db.close();
});

Deno.test("C5 還原驗證：拿掉負值的處理，B7 的預設情況翻面（驗證票落到未來）", async () => {
  const db = await env(true, (s) => mutate(s, "CASE WHEN s.inherit_negative THEN p.priority_seconds ELSE GREATEST(p.priority_seconds, 0) END", "p.priority_seconds"));
  const p = await parent(db, { prio: -30 * DAY });
  const t = await submit(db, { type: "correction", task: p });
  assert((await secs(db, t.vid)) < 0, "沒有處理負值：驗證票落在未來");
  await db.close();
});

Deno.test("B8 /tasks、/request-task（contribution_auto_tasks）：停放的缺口不列；全被退又出現；三型例外；還原驗證", async () => {
  const build = (mut?: (s: string) => string) => env(true, mut);
  const listed = async (db: PGlite, id: string) => (await db.query<{ task_id: string }>(`SELECT task_id FROM contribution_auto_tasks(NULL, NULL, 1000, '')`)).rows.some((r) => r.task_id === id);
  const db = await build();
  const g = await parent(db, { type: "policy_missing" });
  assertEquals(await listed(db, g), true);
  const s1 = await submit(db, { type: "policy", task: g });
  assertEquals(await listed(db, g), false, "有交件在途：不列");
  const g2 = await parent(db, { type: "profile_gap" });
  await submit(db, { type: "no_change", task: null, payloadTask: g2 });
  assertEquals(await listed(db, g2), false, "任務編號只在 payload 的在途交件也停放");
  const rc = await parent(db, { id: "auto:roster_check:台北市", type: "roster_check" });
  await submit(db, { type: "candidacy", task: rc });
  assertEquals(await listed(db, rc), true, "名單清查不停放");
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${s1.id}'`);
  assertEquals(await listed(db, g), true, "全部被退：又出現");
  await db.close();
  const open = "    -- >>> 合格：任務停放\n    -- 同 contribution_queue_tasks";
  const bad = await build((s) => {
    const a = s.indexOf("-- >>> 合格：任務停放", s.indexOf("CREATE OR REPLACE FUNCTION contribution_auto_tasks("));
    const b = s.indexOf("-- <<< 合格：任務停放", a);
    return s.slice(0, a) + s.slice(b);
  });
  const g3 = await parent(bad, { type: "policy_missing" });
  await submit(bad, { type: "policy", task: g3 });
  assertEquals(await listed(bad, g3), true, "拿掉停放條件：在途的缺口又被列出來");
  assert(open.length > 0);
  await bad.close();
});
