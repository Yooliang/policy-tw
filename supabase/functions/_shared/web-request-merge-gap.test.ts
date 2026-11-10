/**
 * 網站請求併入既有缺口任務（migration 20261111010000_web_request_merge_gap.sql，維護者 2026-11-10）。
 *   A. 文字層：臂本體＝前一版（20261028130000）加一段標了 >>> 的條件，拿掉後一字不差；不動 seed／manual_front_pull
 *   B. PGlite：覆蓋判斷（同人物、有指定選舉要同選舉）、臂不輸出、缺口插隊一次且冪等、冷卻中不插、
 *      缺口被收回但人物沒有承諾（no_change 補完、seed 重建…）→ 請求不關；人物真的有承諾 → 對帳時關閉並記原因；
 *      window 關閉 → 請求回到可派且接回派出歷史；缺口還開著不關；兩種先後順序的入列；索引真的被覆蓋視圖用到
 *   C. 還原驗證：拿掉臂的條件／標記判斷／承諾條件／歷史接回 → B 翻面
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261111010000_web_request_merge_gap.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig("20261028130000_park_village_policy_web_requests.sql");

Deno.test("A1 臂本體：新定義＝前一版加覆蓋那一段，拿掉後一字不差", () => {
  const neu = fnText(MIG, "contribution_auto_tasks_manual");
  const open = "     -- >>> 併入既有缺口（20261111010000）：同一個人（與選舉）已有開著的缺政見缺口，這份請求由缺口處理\n";
  const close = "     -- <<< 併入既有缺口\n";
  assertEquals(neu.split(open).length - 1, 1);
  const stripped = neu.slice(0, neu.indexOf(open)) + neu.slice(neu.indexOf(close) + close.length);
  assertEquals(stripped.replace(/ 2026-11-11 起被既有缺口覆蓋的網站請求（web_request_coverage）也不出現；/, ""), fnText(PREV, "contribution_auto_tasks_manual").replace(/\n$/, "\n"));
  assert(neu.slice(neu.indexOf(open), neu.indexOf(close)).includes("web_request_coverage"));
});

Deno.test("A2 不動 seed_auto_task_queue／manual_front_pull（避免牽動日本站複本與守門清單）", () => {
  assert(!MIG.includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue"));
  assert(!MIG.includes("CREATE OR REPLACE FUNCTION manual_front_pull"));
});

const SCHEMA = `
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_type text NOT NULL, source text NOT NULL DEFAULT 'manual', status text NOT NULL DEFAULT 'open',
  title text, description text, target jsonb NOT NULL DEFAULT '{}'::jsonb, hint_sources text[], reward integer, region text, created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, answer_count integer NOT NULL DEFAULT 0, stance_up integer NOT NULL DEFAULT 0);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text, contribution_type text, status text NOT NULL DEFAULT 'pending');
CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint NOT NULL);
INSERT INTO queue_settings VALUES (1, 315360000);
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, task_type text, target jsonb, opened_at timestamptz DEFAULT now(), opened_by jsonb, boost_seconds bigint NOT NULL DEFAULT 0,
  cool_until timestamptz, queue_at timestamptz DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 0, last_dispatched_at timestamptz DEFAULT now(), dispatch_base_at timestamptz);
CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), politician_id uuid NOT NULL, election_id integer, status text, origin text, removed_at timestamptz);
CREATE FUNCTION campaign_election_id() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 2026 $f$;
CREATE FUNCTION election_id_or_null(p text) RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT NULLIF(p, '')::integer $f$;
CREATE FUNCTION is_campaign_pledge(p_status text, p_origin text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT COALESCE(p_status, '') = 'Campaign Pledge' OR COALESCE(p_origin, '') = 'pledge' $f$;
CREATE TABLE gap_events (id bigserial PRIMARY KEY, task_id text NOT NULL, event text NOT NULL, at timestamptz NOT NULL DEFAULT now(), election_id integer, reason text);
CREATE TABLE _checked (task_id text);
CREATE FUNCTION task_in_check_cooldown(p text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM _checked WHERE task_id = p) $f$;
CREATE TABLE _parked (id uuid);
CREATE FUNCTION web_request_parked(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM _parked WHERE id = p) $f$;
CREATE FUNCTION uuid_or_null(p text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN p::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $f$;
CREATE FUNCTION question_answer_cap() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 3 $f$;
CREATE FUNCTION manual_task_is_visitor(p_source TEXT, p_task_type TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$ SELECT COALESCE(p_source = 'web_request', false) OR COALESCE(p_task_type = 'question', false) $f$;
-- 缺口列被刪時記 closed 事件（與正式庫的 AFTER DELETE 觸發器同樣的效果；原因讀 gap.close_reason，沒設＝filled）
CREATE FUNCTION _gap_closed() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO gap_events (task_id, event, election_id, reason)
  VALUES (OLD.task_id, 'closed', (OLD.opened_by->>'election_id')::int, COALESCE(NULLIF(current_setting('gap.close_reason', true), ''), 'filled'));
  RETURN OLD;
END $f$;
CREATE TRIGGER _t_gap_closed AFTER DELETE ON task_dispatches FOR EACH ROW WHEN (OLD.task_id LIKE 'auto:%') EXECUTE FUNCTION _gap_closed();
CREATE FUNCTION _gap_opened() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO gap_events (task_id, event, election_id) VALUES (NEW.task_id, 'opened', (NEW.opened_by->>'election_id')::int);
  RETURN NULL;
END $f$;
CREATE TRIGGER _t_gap_opened AFTER INSERT ON task_dispatches FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:%') EXECUTE FUNCTION _gap_opened();
-- 模擬正式庫：任務關閉就收回它的派工列
CREATE FUNCTION _task_closed() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM task_dispatches WHERE task_id = OLD.id::text; RETURN NULL; END $f$;
CREATE TRIGGER _t_task_closed AFTER UPDATE OF status ON contribution_tasks FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status <> 'open') EXECUTE FUNCTION _task_closed();
`;

// 套 migration 時略過 cron 與 NOTIFY（PGlite 沒有）；最後的 SELECT web_request_gap_sync() 照跑
const stripInfra = (s: string) => s.replace(/^SELECT cron\.(un)?schedule.*$/gm, "").replace(/NOTIFY pgrst[^;]*;\n/, "");

async function env(mutate: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(stripInfra(mutate(MIG)));
  return db;
}
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

async function request(db: PGlite, pid: string, o: { election?: number; type?: string; source?: string; ago?: string } = {}): Promise<string> {
  const id = uid();
  const t = JSON.stringify({ politician_id: pid, ...(o.election ? { election_id: o.election } : {}) });
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source, target, created_at) VALUES ('${id}', '${o.type ?? "policy_missing"}', '${o.source ?? "web_request"}', '${t}', now() - interval '${o.ago ?? "1 hour"}')`);
  return id;
}
async function gap(db: PGlite, pid: string, o: { term?: number; election?: number; boost?: number } = {}): Promise<string> {
  const id = o.term ? `auto:term_policy_missing:${pid}:${o.term}` : `auto:policy_missing:${pid}`;
  const e = o.term ?? o.election ?? 2026;
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, opened_by, boost_seconds) VALUES ('${id}', '${o.term ? "term_policy_missing" : "policy_missing"}',
    '${JSON.stringify({ politician_id: pid, election_id: e })}', '${JSON.stringify({ election_id: e })}', ${o.boost ?? 0})`);
  return id;
}
const visible = async (db: PGlite): Promise<Set<string>> =>
  new Set((await db.query<{ task_id: string }>("SELECT task_id FROM contribution_auto_tasks_manual(true)")).rows.map((r) => r.task_id));
const boostOf = async (db: PGlite, id: string) => Number((await db.query<{ b: string }>(`SELECT boost_seconds AS b FROM task_dispatches WHERE task_id = '${id}'`)).rows[0]!.b);
const statusOf = async (db: PGlite, id: string) => (await db.query<{ status: string; closed_reason: string | null }>(`SELECT status, closed_reason FROM contribution_tasks WHERE id = '${id}'`)).rows[0]!;
const TEN_YEARS = 315360000;
async function pledge(db: PGlite, pid: string, o: { election?: number; status?: string; origin?: string; removed?: boolean } = {}) {
  await db.exec(`INSERT INTO policies (politician_id, election_id, status, origin, removed_at) VALUES ('${pid}', ${o.election ?? 2026}, '${o.status ?? "Campaign Pledge"}', '${o.origin ?? "pledge"}', ${o.removed ? "now()" : "NULL"})`);
}
const sync = async (db: PGlite) => (await db.query<{ s: { closed: number; dropped: number; boosted: number } }>("SELECT web_request_gap_sync() AS s")).rows[0]!.s;

Deno.test("B1 覆蓋判斷：同人物有開著的缺口才覆蓋；有指定選舉要同選舉；其他任務型別、其他來源不算", async () => {
  const db = await env();
  const p = uid(), q = uid(), r = uid();
  const same = await request(db, p);
  const sameWithElection = await request(db, p, { election: 2026 });
  const otherElection = await request(db, p, { election: 2022 });
  const noGap = await request(db, q);
  const profile = await request(db, p, { type: "profile_gap" });
  const manual = await request(db, p, { source: "manual" });
  const termReq = await request(db, r, { election: 2026 });
  await gap(db, p);                       // auto:policy_missing:p（選舉 2026）
  await gap(db, r, { term: 2026 });       // auto:term_policy_missing:r:2026
  await gap(db, uid(), { boost: 0 });     // 別人的缺口
  const covered = new Set((await db.query<{ task_id: string }>("SELECT task_id FROM web_request_coverage")).rows.map((x) => x.task_id));
  for (const id of [same, sameWithElection, termReq]) assert(covered.has(id), `${id} 應被覆蓋`);
  for (const [name, id] of [["不同選舉", otherElection], ["沒有缺口", noGap], ["缺人物資料", profile], ["維護者建的", manual]] as const) assert(!covered.has(id), `${name}不覆蓋`);
  const v = await visible(db);
  for (const id of [same, sameWithElection, termReq]) assert(!v.has(id), "覆蓋中的請求不單獨派");
  for (const id of [otherElection, noGap, profile]) assert(v.has(id), "沒覆蓋的照舊派");
  // 覆蓋中的請求仍是 open（網站上還看得到）
  assertEquals((await statusOf(db, same)).status, "open");
  await db.close();
});

Deno.test("B2 缺口插隊：一次、冪等；多份請求不疊加；派出歸零後不重加；新請求才再加", async () => {
  const db = await env();
  const p = uid();
  const g = await gap(db, p);
  assertEquals(await boostOf(db, g), 0);
  const r1 = await request(db, p);           // 新請求的觸發器：缺口插隊
  assertEquals(await boostOf(db, g), TEN_YEARS);
  const marker = (await db.query<{ ids: string[] }>(`SELECT opened_by->'web_request_boost_ids' AS ids FROM task_dispatches WHERE task_id = '${g}'`)).rows[0]!.ids;
  assertEquals(marker, [r1]);
  // 重跑對帳：不再動
  await db.exec("UPDATE task_dispatches SET boost_seconds = 5 WHERE task_id = '" + g + "'");  // 模擬派出後歸零（觸發器的效果）
  await db.exec("SELECT web_request_gap_sync()");
  assertEquals(await boostOf(db, g), 5, "同一份請求已算過，seed／對帳不重加");
  // 同一缺口又來一份新請求：再插隊一次，標記多一個
  const r2 = await request(db, p);
  assertEquals(await boostOf(db, g), TEN_YEARS);
  const marker2 = (await db.query<{ ids: string[] }>(`SELECT opened_by->'web_request_boost_ids' AS ids FROM task_dispatches WHERE task_id = '${g}'`)).rows[0]!.ids;
  assertEquals(new Set(marker2), new Set([r1, r2]));
  // 不疊加：比 10 年更大的插隊（維護者）不被縮小
  await db.exec(`UPDATE task_dispatches SET boost_seconds = ${TEN_YEARS * 2} WHERE task_id = '${g}'`);
  await request(db, p);
  assertEquals(await boostOf(db, g), TEN_YEARS * 2);
  await db.close();
});

Deno.test("B3 查核冷卻中的缺口不插隊也不記標記；冷卻過了對帳補上", async () => {
  const db = await env();
  const p = uid(), p2 = uid();
  const g = await gap(db, p), g2 = await gap(db, p2);
  await db.exec(`INSERT INTO _checked VALUES ('${g}')`);
  await db.exec(`UPDATE task_dispatches SET cool_until = now() + interval '3 days' WHERE task_id = '${g2}'`);
  await request(db, p); await request(db, p2);
  assertEquals(await boostOf(db, g), 0, "階梯冷卻中不插");
  assertEquals(await boostOf(db, g2), 0, "cool_until 未到不插");
  assertEquals((await db.query("SELECT 1 FROM task_dispatches WHERE opened_by ? 'web_request_boost_ids'")).rows.length, 0, "沒插就不標記");
  await db.exec("DELETE FROM _checked");
  await db.exec(`UPDATE task_dispatches SET cool_until = now() - interval '1 minute' WHERE task_id = '${g2}'`);
  await db.exec("SELECT web_request_gap_sync()");
  assertEquals(await boostOf(db, g), TEN_YEARS);
  assertEquals(await boostOf(db, g2), TEN_YEARS);
  await db.close();
});

Deno.test("B4 缺口被收回但人物沒有承諾（no_change 補完的 drop_applied、seed 重建、人物合併…，gap_events 一律記 filled）→ 請求不關", async () => {
  const db = await env();
  const p = uid();
  const g = await gap(db, p);
  const r = await request(db, p);
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${g}'`);  // 預設原因 filled，但沒有任何政見
  assertEquals((await db.query("SELECT 1 FROM gap_events WHERE reason = 'filled'")).rows.length, 1);
  assertEquals((await statusOf(db, r)).status, "open", "觸發器不再靠 gap_events 關請求");
  assertEquals(await sync(db), { closed: 0, dropped: 0, boosted: 0 });
  assertEquals((await statusOf(db, r)).status, "open", "對帳也不會：人物沒有承諾");
  assert((await visible(db)).has(r), "沒被覆蓋了：臂又輸出它");
  // 只有被移除的政見、別屆的政見、不是承諾的當屆政見：都不算有承諾
  await pledge(db, p, { removed: true });
  await pledge(db, p, { election: 2022 });
  await pledge(db, p, { status: "In Progress", origin: "term" });
  assertEquals((await sync(db)).closed, 0);
  assertEquals((await statusOf(db, r)).status, "open");
  await db.close();
});

Deno.test("B5 人物真的有承諾：缺口已不覆蓋 → 對帳時關閉並記原因；之後才建的請求、沒出現過缺口的請求不動", async () => {
  const db = await env();
  const p = uid(), other = uid(), p3 = uid();
  const g = await gap(db, p);
  const r = await request(db, p);
  const rOther = await request(db, other);   // 這個人有承諾，但從來沒有缺口：一般的「多查一點」請求
  await pledge(db, other);
  const rNoGap = await request(db, p3);
  await pledge(db, p);                       // 缺口被補上
  assertEquals((await statusOf(db, r)).status, "open", "缺口還開著：覆蓋中，不關");
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${g}'`);
  assertEquals((await statusOf(db, r)).status, "open", "刪缺口當下不關（只在對帳）");
  assertEquals((await sync(db)).closed, 1);
  const s = await statusOf(db, r);
  assertEquals(s.status, "closed");
  assertEquals(s.closed_reason, `gap_filled:${g}`);
  assertEquals((await statusOf(db, rOther)).status, "open", "沒有缺口事件的請求不動");
  assertEquals((await statusOf(db, rNoGap)).status, "open");
  const late = await request(db, p, { ago: "0 seconds" });
  assertEquals((await sync(db)).closed, 0);
  assertEquals((await statusOf(db, late)).status, "open", "缺口關閉之後才建的請求不動");
  assertEquals((await sync(db)).closed, 0, "冪等");
  await db.close();
});

Deno.test("B6 window 關閉（沒補上）：請求不關，回到可派，並接回原本的派出次數、進隊時間、冷卻與插隊", async () => {
  const db = await env();
  const p = uid();
  const r = await request(db, p);
  // 請求自己的派工列：派過 3 次、一個月前進隊、冷卻中、沒有插隊（派出歸零）
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target, dispatch_count, last_dispatched_at, cool_until, boost_seconds, dispatch_base_at)
    VALUES ('${r}', 'policy_missing', '{}', 3, now() - interval '30 days', now() + interval '2 days', 0, now() - interval '31 days')`);
  const g = await gap(db, p);   // 缺口出生：收回請求列、把歷史記起來
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${r}'`)).rows.length, 0);
  assertEquals((await db.query(`SELECT dispatch_count FROM web_request_dispatch_memory WHERE task_id = '${r}'`)).rows[0]!, { dispatch_count: 3 });
  assert(!(await visible(db)).has(r));
  await db.exec("SELECT set_config('gap.close_reason', 'window', false)");
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${g}'`);
  await db.exec("SELECT set_config('gap.close_reason', '', false)");
  assertEquals((await statusOf(db, r)).status, "open");
  assertEquals((await sync(db)).closed, 0);
  assert((await visible(db)).has(r), "不再被覆蓋，臂又輸出它");
  // seed 重新入列（新的一列帶「剛出生」的預設值）：歷史接回
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${r}', 'policy_missing', '{}')`);
  const row = (await db.query<{ c: number; ago: number; cool: boolean; b: string }>(
    `SELECT dispatch_count AS c, extract(epoch FROM now() - last_dispatched_at)/86400 AS ago, cool_until > now() AS cool, boost_seconds::text AS b FROM task_dispatches WHERE task_id = '${r}'`)).rows[0]!;
  assertEquals(row.c, 3);
  assert(Number(row.ago) > 29 && Number(row.ago) < 31, "進隊時間接回一個月前，不從現在重來");
  assertEquals(row.cool, true);
  assertEquals(row.b, "0", "沒有再拿一次出生插隊");
  await sync(db);
  assertEquals((await db.query("SELECT 1 FROM web_request_dispatch_memory")).rows.length, 0, "已入列的記憶被清掉");
  await db.close();
});

Deno.test("B6b 還有別的缺口覆蓋（同人物另一場選舉的缺口）就不關；有承諾的那一屆要對得上", async () => {
  const db = await env();
  const p = uid();
  const g1 = await gap(db, p, { term: 2022 });
  const g2 = await gap(db, p, { term: 2024 });
  const r22 = await request(db, p, { election: 2022 });
  const r24 = await request(db, p, { election: 2024 });
  const rAny = await request(db, p);              // 沒指定選舉：兩個缺口都覆蓋它
  await pledge(db, p, { election: 2022, status: "In Progress", origin: "term" });  // 2022 那一屆有政見（任何未移除的都算）
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${g1}'`);
  assertEquals((await sync(db)).closed, 1);
  assertEquals((await statusOf(db, r22)).status, "closed");
  assertEquals((await statusOf(db, r24)).status, "open", "別場選舉的請求不動");
  assertEquals((await statusOf(db, rAny)).status, "open", "另一個缺口（2024）還覆蓋著，不關");
  await db.exec(`DELETE FROM task_dispatches WHERE task_id = '${g2}'`);
  assertEquals((await sync(db)).closed, 1, "2024 沒有政見：r24 不關；沒指定選舉的 rAny 用缺口那一屆（2022 或 2024 的最新事件）判斷");
  await db.close();
});

Deno.test("B7 派工列入列：請求先在、缺口後到（收回請求列）；缺口先在、請求入列被擋；兩個順序都沒有殘留", async () => {
  const db = await env();
  const p = uid(), p2 = uid();
  // 缺口後到
  const r = await request(db, p);
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${r}', 'policy_missing', '{}')`);
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${r}'`)).rows.length, 1, "沒缺口時入列照舊");
  await gap(db, p);
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${r}'`)).rows.length, 0, "缺口一出生就收回請求列");
  // 缺口先在，請求入列（seed 的 INSERT ... ON CONFLICT DO NOTHING 路徑）
  await gap(db, p2);
  const r2 = await request(db, p2);
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${r2}', 'policy_missing', '{}') ON CONFLICT (task_id) DO NOTHING`);
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${r2}'`)).rows.length, 0, "已被覆蓋的請求不入列");
  // 公民提問、維護者任務的入列不受影響
  const m = uid();
  await db.exec(`INSERT INTO contribution_tasks (id, task_type, source) VALUES ('${m}', 'policy_missing', 'manual')`);
  await db.exec(`INSERT INTO task_dispatches (task_id) VALUES ('${m}')`);
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${m}'`)).rows.length, 1);
  await db.close();
});

Deno.test("B8 對帳 web_request_gap_sync：關已有承諾的、收回殘留列、補插隊；回傳數字，第二次全冪等", async () => {
  const db = await env();
  const p = uid(), p2 = uid();
  // 缺口 filled 的事件發生了、人物也有承諾、請求卻還開著（例如觸發器之外的路徑）
  const r = await request(db, p, { ago: "2 days" });
  await db.exec("ALTER TABLE gap_events DISABLE TRIGGER USER");
  await db.exec(`INSERT INTO gap_events (task_id, event, reason, at) VALUES ('auto:policy_missing:${p}', 'closed', 'filled', now() - interval '1 day')`);
  await db.exec("ALTER TABLE gap_events ENABLE TRIGGER USER");
  await pledge(db, p);
  // 殘留的請求派工列（先入列、之後才有缺口，繞過觸發器模擬）
  const g2 = await gap(db, p2);
  const r2 = await request(db, p2);
  await db.exec(`ALTER TABLE task_dispatches DISABLE TRIGGER USER`);
  await db.exec(`INSERT INTO task_dispatches (task_id) VALUES ('${r2}')`);
  await db.exec(`UPDATE task_dispatches SET boost_seconds = 0, opened_by = '{"election_id":2026}' WHERE task_id = '${g2}'`);
  await db.exec(`ALTER TABLE task_dispatches ENABLE TRIGGER USER`);
  assertEquals(await sync(db), { closed: 1, dropped: 1, boosted: 1 });
  assertEquals((await statusOf(db, r)).closed_reason, `gap_filled:auto:policy_missing:${p}`);
  assertEquals((await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = '${r2}'`)).rows.length, 0);
  assertEquals(await boostOf(db, g2), TEN_YEARS);
  assertEquals(await sync(db), { closed: 0, dropped: 0, boosted: 0 });
  await db.close();
});

Deno.test("B9 效能：覆蓋視圖與入列觸發器走缺口人物索引（不掃 task_dispatches 的 LIKE）", async () => {
  const db = await env();
  // 灌 6 千列缺口與 2 千列其他列，讓規劃器有理由選索引
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) SELECT 'auto:policy_missing:' || gen_random_uuid(), 'policy_missing',
    jsonb_build_object('politician_id', gen_random_uuid()::text, 'election_id', 2026) FROM generate_series(1, 6000)`);
  await db.exec(`INSERT INTO task_dispatches (task_id, task_type, target) SELECT 'auto:profile_gap:' || gen_random_uuid(), 'profile_gap',
    jsonb_build_object('politician_id', gen_random_uuid()::text) FROM generate_series(1, 2000)`);
  const p = uid();
  const r = await request(db, p);
  await db.exec("ANALYZE task_dispatches; ANALYZE contribution_tasks");
  const plan = (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT 1 FROM web_request_coverage c WHERE c.task_id = '${r}'`)).rows.map((x) => x["QUERY PLAN"]).join("\n");
  assert(plan.includes("idx_task_dispatches_gap_politician"), `覆蓋視圖（單一請求）要走索引：\n${plan}`);
  await db.close();
});

Deno.test("C 還原驗證：拿掉臂的條件／標記判斷／承諾條件／歷史接回，B 的劇本必須翻面", async () => {
  // C1 臂不再排除覆蓋中的請求
  const noArm = (s: string) => s.replace("AND NOT EXISTS (SELECT 1 FROM web_request_coverage wc WHERE wc.task_id = t.id)", "AND true");
  assert(noArm(MIG) !== MIG);
  const db1 = await env(noArm);
  const p = uid();
  const r = await request(db1, p);
  await gap(db1, p);
  assert((await visible(db1)).has(r), "拿掉條件：覆蓋中的請求又出現");
  await db1.close();
  // C2 拿掉冪等標記：每次對帳都重加
  const noMark = (s: string) => s.replace("WHERE NOT c.boost_counted AND", "WHERE true AND");
  assert(noMark(MIG) !== MIG);
  const db2 = await env(noMark);
  const p2 = uid();
  const g = await gap(db2, p2);
  await request(db2, p2);
  await db2.exec(`UPDATE task_dispatches SET boost_seconds = 5 WHERE task_id = '${g}'`);
  await sync(db2);
  assertEquals(await boostOf(db2, g), TEN_YEARS, "沒有標記：對帳又把派出後歸零的缺口插隊");
  await db2.close();
  // C3 拿掉「現在有承諾」條件：缺口被收回（沒有任何政見）請求就被關——這正是 BLOCKER 的情境
  const noPledge = (s: string) => s.replace("AND web_request_has_pledges(r.target->>'politician_id', COALESCE(r.target->>'election_id', ev.eid))", "AND true");
  assert(noPledge(MIG) !== MIG);
  const db3 = await env(noPledge);
  const p3 = uid();
  const g3 = await gap(db3, p3);
  const r3 = await request(db3, p3);
  await db3.exec(`DELETE FROM task_dispatches WHERE task_id = '${g3}'`);
  await sync(db3);
  assertEquals((await statusOf(db3, r3)).status, "closed", "拿掉承諾條件：沒有政見也被關（B4 會紅）");
  await db3.close();
  // C4 拿掉歷史接回：重新入列又是全新的一列
  const noRestore = (s: string) => s.replace("IF FOUND THEN\n    NEW.dispatch_count := m.dispatch_count;", "IF false THEN\n    NEW.dispatch_count := m.dispatch_count;");
  assert(noRestore(MIG) !== MIG);
  const db4 = await env(noRestore);
  const p4 = uid();
  const r4 = await request(db4, p4);
  await db4.exec(`INSERT INTO task_dispatches (task_id, task_type, target, dispatch_count) VALUES ('${r4}', 'policy_missing', '{}', 3)`);
  const g4 = await gap(db4, p4);
  await db4.exec("SELECT set_config('gap.close_reason', 'window', false)");
  await db4.exec(`DELETE FROM task_dispatches WHERE task_id = '${g4}'`);
  await db4.exec(`INSERT INTO task_dispatches (task_id, task_type, target) VALUES ('${r4}', 'policy_missing', '{}')`);
  assertEquals((await db4.query<{ c: number }>(`SELECT dispatch_count AS c FROM task_dispatches WHERE task_id = '${r4}'`)).rows[0]!.c, 0, "拿掉接回：歷史歸零（B6 會紅）");
  await db4.close();
});
