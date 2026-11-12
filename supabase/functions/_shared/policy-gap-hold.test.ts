/**
 * 2026 缺政見任務公報上架前停派（縣市長除外）——migration 20261113100000、task-context 的 bulletin_published（協議 1.136.0）。
 *
 * 守的事：
 *   A. SQL 行為（PGlite）：helper election_bulletin_published／policy_gap_held 只認里程碑 done，預估日、announced 不算；縣市長類不擋；已投票、沒有公報里程碑、職位或選舉不明不擋；
 *      里程碑翻 done（bulletin_watch_mark_published 的做法）後立刻不擋。
 *   B. 總表：新定義＝前一版（20261105200000）＋兩處標記區塊，倒回去必須一字不差；之後任何 migration 重新定義總表都不能丟掉 policy_gap_held。
 *   C. 不碰 web_request_parked、不碰臂本體。
 *   D. TS：fetchTaskContext 把 bulletin_published 帶進 current（有 target.election_id 就用它、沒有用最新一屆參選紀錄；沒有里程碑的舊屆＝true；查失敗不給欄位）。
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";
import { bulletinPublishedFrom, fetchTaskContext, shapeTaskCurrent } from "./task-context.ts";

const MIG = "20261113100000_policy_gap_hold_until_bulletin.sql";
const PREV_ARMS_MIG = "20261105200000_lineage_status.sql";

// ---------------------------------------------------------------- A. SQL 行為
async function buildDb(mayorTypes?: string[]): Promise<PGlite> {
  const sql = await readMig(MIG);
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE election_milestones (id serial PRIMARY KEY, election_id integer, kind text, election_type text, on_date date, basis text, status text);
    CREATE TABLE activity_rules (id serial PRIMARY KEY, activity text, priority integer, enabled boolean DEFAULT true, params jsonb DEFAULT '{}'::jsonb);
    CREATE FUNCTION activity_today(p_tz text DEFAULT 'Asia/Taipei') RETURNS date LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('app.activity_today', true), ''), '2026-11-13')::date $$;
    INSERT INTO elections VALUES (2026, '2026-11-28'), (2022, '2022-11-26'), (2028, '2028-11-25');
    -- 2026：預估日（10-08 回填的樣子）；2028：有公報里程碑 done；2022：只有「有職位」的里程碑列，沒有整場的
    INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES
      (2026, 'bulletin_published', NULL, '2026-11-18', 'statutory', 'expected'),
      (2028, 'bulletin_published', NULL, '2028-11-15', 'official', 'done'),
      (2022, 'bulletin_published', '縣市長', '2022-11-16', 'official', 'done');
  `);
  if (mayorTypes) {
    await db.exec(`INSERT INTO activity_rules (activity, priority, enabled, params) VALUES ('mayor_policies', NULL, true, '{"election_types": ${JSON.stringify(mayorTypes)}}')`);
  }
  await db.exec(fnText(sql, "election_bulletin_published"));
  await db.exec(fnText(sql, "policy_gap_held"));
  return db;
}
const held = async (db: PGlite, eid: number | null, type: string | null) =>
  (await db.query<{ h: boolean }>("SELECT policy_gap_held($1::integer, $2::text) AS h", [eid, type])).rows[0].h;
const published = async (db: PGlite, eid: number) =>
  (await db.query<{ p: boolean }>("SELECT election_bulletin_published($1::integer) AS p", [eid])).rows[0].p;

const HELD_TYPES = ["縣市議員", "直轄市議員", "鄉鎮市長", "鄉鎮市民代表", "村里長", "直轄市山地原住民區長", "直轄市山地原住民區民代表"];

Deno.test("A1 公報預估日（expected）不算上架：2026 非縣市長職位全部擋，縣市長與直轄市長不擋", async () => {
  const db = await buildDb();
  assertFalse(await published(db, 2026), "預估日不是上架");
  for (const t of HELD_TYPES) assert(await held(db, 2026, t), `${t} 該擋`);
  assertFalse(await held(db, 2026, "縣市長"));
  assertFalse(await held(db, 2026, "直轄市長"));
  await db.close();
});

Deno.test("A2 里程碑翻 done（bulletin_watch_mark_published 的寫法：改成偵測當天、status=done、basis=official）→ 立刻不擋", async () => {
  const db = await buildDb();
  await db.exec("UPDATE election_milestones SET on_date = '2026-11-12', basis = 'official', status = 'done' WHERE election_id = 2026 AND election_type IS NULL");
  assert(await published(db, 2026));
  for (const t of HELD_TYPES) assertFalse(await held(db, 2026, t), `${t} 公報上架後不該擋`);
  await db.close();
});

Deno.test("A3 announced 也不算上架；預估日已經過了、status 還是 expected 一樣擋（不看日期）", async () => {
  const db = await buildDb();
  await db.exec("UPDATE election_milestones SET status = 'announced' WHERE election_id = 2026 AND election_type IS NULL");
  assert(await held(db, 2026, "縣市議員"));
  await db.exec("UPDATE election_milestones SET status = 'expected', on_date = '2026-11-01' WHERE election_id = 2026 AND election_type IS NULL");
  await db.exec("SET app.activity_today = '2026-11-20'");
  assert(await held(db, 2026, "村里長"), "預估日過了但沒偵測到，仍然擋");
  await db.close();
});

Deno.test("A4 不擋的情況：選舉或職位不明、沒有整場公報里程碑（舊屆）、已經投票、有職位的里程碑列不算", async () => {
  const db = await buildDb();
  assertFalse(await held(db, null, "縣市議員"));
  assertFalse(await held(db, 2026, null));
  assertFalse(await held(db, 9999, "縣市議員"), "查無選舉");
  assertFalse(await held(db, 2022, "縣市議員"), "2022 已投票、也只有職位的里程碑列");
  assertFalse(await published(db, 2022), "有職位的里程碑列不是整場的公報");
  assertFalse(await held(db, 2028, "縣市議員"), "2028 公報已 done");
  await db.exec("DELETE FROM election_milestones WHERE election_id = 2026");
  assertFalse(await held(db, 2026, "縣市議員"), "沒有公報里程碑的選舉不擋（衍生欄位的語意：沒有這個里程碑＝已上架）");
  await db.exec("INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'bulletin_published', NULL, '2026-11-18', 'statutory', 'expected')");
  assert(await held(db, 2026, "縣市議員"));
  await db.exec("SET app.activity_today = '2026-11-29'");
  assertFalse(await held(db, 2026, "縣市議員"), "投票日之後不擋");
  await db.close();
});

Deno.test("A5 縣市長類讀規則 mayor_policies 的 election_types（主控台改了就跟著改）", async () => {
  const db = await buildDb(["縣市長"]);
  assertFalse(await held(db, 2026, "縣市長"));
  assert(await held(db, 2026, "直轄市長"), "規則只列縣市長時，直轄市長不在例外");
  await db.close();
});

// ---------------------------------------------------------------- B. 總表
const MARK_RE = /[ ]*-- >>> 公報上架前停派[\s\S]*?-- <<< 公報上架前停派\n/g;

Deno.test("B1 總表：新定義＝前一版加兩處標記區塊（倒回去一字不差）", async () => {
  const sql = await readMig(MIG);
  const cur = fnText(sql, "contribution_auto_tasks_arms");
  const prev = fnText(await readMig(PREV_ARMS_MIG), "contribution_auto_tasks_arms");
  assertEquals((cur.match(MARK_RE) ?? []).length, 2, "兩處標記區塊（held CTE、w.ok 條件）");
  const back = cur.replace(MARK_RE, "").replace("')))\n           AS ok) w", "'))) AS ok) w");
  assertEquals(back, prev);
  // 條件內容：只擋缺政見兩種型別、用 held CTE
  assert(cur.includes("policy_gap_held(x.eid, x.etype)"));
  assert(cur.includes("g.task_type IN ('policy_missing', 'term_policy_missing')"));
});

Deno.test("B2 之後任何 migration 重新定義總表，都不能丟掉公報上架前停派", async () => {
  const latest = await latestFn("contribution_auto_tasks_arms");
  assert(latest.includes("policy_gap_held("), "總表最新定義沒有 policy_gap_held——有人重貼了舊版？");
  assert(latest.includes("<<< 公報上架前停派"));
});

// ---------------------------------------------------------------- C. 範圍
Deno.test("C1 這支 migration 不重新定義 web_request_parked、raw／mayor_policies／term_policies 臂與 seed，也不動規則表", async () => {
  const sql = (await readMig(MIG)).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  for (const f of ["web_request_parked", "contribution_auto_tasks_raw", "contribution_auto_tasks_mayor_policies", "contribution_auto_tasks_term_policies", "seed_auto_task_queue"]) {
    assertFalse(sql.includes(`FUNCTION ${f}(`), `不該重新定義 ${f}`);
  }
  assertFalse(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+activity_rules\b/.test(sql), "不動規則表");
});

Deno.test("C2 helper 只認里程碑 done，不讀 elections.bulletin_published_on", async () => {
  const sql = await readMig(MIG);
  const body = fnText(sql, "election_bulletin_published") + fnText(sql, "policy_gap_held");
  assert(body.includes("m.status = 'done'"));
  assertFalse(body.includes("bulletin_published_on"));
});

// ---------------------------------------------------------------- D. TS
type Row = Record<string, unknown>;
/** 假 supabase：politician_elections、election_milestones 可設；milestoneFail＝里程碑表查詢出錯 */
function fake(o: { elections?: Row[]; milestones?: Row[]; milestoneFail?: boolean }) {
  const milestoneQueries: Array<{ election_id: unknown }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const api: any = {
      select: () => api,
      in: () => api,
      is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return api; },
      eq: (c: string, v: unknown) => { filters[c] = v; return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: (v: unknown) => unknown) => {
        if (table === "election_milestones") {
          milestoneQueries.push({ election_id: filters.election_id });
          if (o.milestoneFail) return res({ data: null, error: { message: "boom" } });
          const rows = (o.milestones ?? []).filter((m) => m.election_id === filters.election_id && m.kind === filters.kind && m.election_type === null);
          return res({ data: rows.map((m) => ({ status: m.status })), error: null });
        }
        if (table === "politician_elections") return res({ data: o.elections ?? [], error: null });
        return res({ data: [], count: 0, error: null });
      },
    };
    return api;
  };
  return { client: { from, rpc: () => Promise.resolve({ data: null, error: null }) }, milestoneQueries };
}
const MS = (eid: number, status: string): Row => ({ election_id: eid, kind: "bulletin_published", election_type: null, status });
const PID = "00000000-0000-4000-8000-000000000001";

Deno.test("D1 bulletinPublishedFrom：done 才是 true；沒有里程碑（舊屆）true；查不到 undefined", () => {
  assertEquals(bulletinPublishedFrom([{ status: "done" }]), true);
  assertEquals(bulletinPublishedFrom([{ status: "expected" }]), false);
  assertEquals(bulletinPublishedFrom([{ status: "announced" }]), false);
  assertEquals(bulletinPublishedFrom([]), true);
  assertEquals(bulletinPublishedFrom(null), undefined);
});

Deno.test("D2 /next 的 current.bulletin_published：target.election_id 的里程碑是 expected → false，翻 done → true，沒有里程碑 → true", async () => {
  for (const type of ["policy_missing", "term_policy_missing"]) {
    const off = fake({ milestones: [MS(2026, "expected")] });
    const cur = shapeTaskCurrent(type, await fetchTaskContext(off.client, type, { politician_id: PID, election_id: 2026 })) as Row;
    assertEquals(cur.bulletin_published, false);
    assertEquals(off.milestoneQueries, [{ election_id: 2026 }]);

    const on = fake({ milestones: [MS(2026, "done")] });
    assertEquals((shapeTaskCurrent(type, await fetchTaskContext(on.client, type, { politician_id: PID, election_id: 2026 })) as Row).bulletin_published, true);

    const old = fake({ milestones: [MS(2026, "expected")] });
    assertEquals((shapeTaskCurrent(type, await fetchTaskContext(old.client, type, { politician_id: PID, election_id: 2022 })) as Row).bulletin_published, true);
  }
});

Deno.test("D3 target 沒有 election_id：用這個人最新一屆的參選紀錄（election_id 最大的那列）", async () => {
  const f = fake({ elections: [{ election_id: 2026, election_type: "縣市議員", candidacy_status: "filed" }, { election_id: 2022, election_type: "縣市議員", candidacy_status: "elected" }], milestones: [MS(2026, "expected")] });
  const cur = shapeTaskCurrent("policy_missing", await fetchTaskContext(f.client, "policy_missing", { politician_id: PID })) as Row;
  assertEquals(cur.bulletin_published, false);
  assertEquals(f.milestoneQueries, [{ election_id: 2026 }]);
  // 沒有參選紀錄也沒有 election_id：不查、不給欄位
  const none = fake({});
  const cur2 = shapeTaskCurrent("policy_missing", await fetchTaskContext(none.client, "policy_missing", { politician_id: PID })) as Row;
  assertFalse("bulletin_published" in cur2);
  assertEquals(none.milestoneQueries.length, 0);
});

Deno.test("D4 里程碑表查詢出錯：不給欄位、不擋派工；其他任務型別不帶這個欄位", async () => {
  const f = fake({ milestoneFail: true });
  const cur = shapeTaskCurrent("policy_missing", await fetchTaskContext(f.client, "policy_missing", { politician_id: PID, election_id: 2026 })) as Row;
  assertFalse("bulletin_published" in cur);
  const other = shapeTaskCurrent("profile_gap", { politician: { id: PID }, bulletin_published: false }) as Row;
  assertFalse("bulletin_published" in other);
});
