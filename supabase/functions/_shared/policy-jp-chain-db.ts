/**
 * 日本站選舉鏈第 2～4 步的 PGlite 測試環境（不是測試檔，deno test 不會單獨跑它）。
 *
 * 做法：套「所有」檔名帶 _policy_jp_ 的 migration（照檔名排序，不寫死清單——之後新增的 migration 自動進來），
 * 時鐘用 `SET app.activity_today`，整條流程走 seed_auto_task_queue()＋task_dispatches／gap_events。
 * 資料庫裡沒有任何正見（public）物件。團體用 lg_code_registry（總務省團體碼表）裡真的有的碼。
 *
 * 一個資料庫建立要幾秒（團體碼表・統計表的資料 migration 很大）：唯讀檢查共用一個庫（sharedDb），
 * 會寫資料的情境各自 freshDb()（用 dumpDataDir 複製，比重跑 migration 快）。
 */
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
export const readMig = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
export async function jpMigrationNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name.includes("_policy_jp_")) names.push(e.name);
  return names.sort();
}

export const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;

/** 所有 _policy_jp_ migration 套完的資料庫。upTo：只套到這個檔名（含）之前的，給「緊接在前一版」的比對用 */
export async function migratedDb(o: { before?: string; only?: (name: string) => boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const n of await jpMigrationNames()) {
    if (o.before && n >= o.before) break;
    if (o.only && !o.only(n)) continue;
    await db.exec(await readMig(n));
  }
  return db;
}

let template: Promise<Blob> | null = null;
/** 套完所有 migration 的資料庫（每次呼叫都是獨立的一份：第一次建、之後從快照還原） */
export async function freshDb(): Promise<PGlite> {
  if (!template) {
    template = (async () => {
      const base = await migratedDb();
      const dump = await base.dumpDataDir("none");
      await base.close();
      return dump as Blob;
    })();
  }
  return new PGlite({ loadDataDir: await template });
}

export const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
export const rows = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
export const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM (${sql}) q`, params)).n;
export const clock = (db: PGlite, day: string) => db.exec(`SET app.activity_today = '${day}'`);
export const seed = (db: PGlite) => db.query(`SELECT policy_jp.seed_auto_task_queue()`);

export function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}

/** 在交易裡執行、最後一定回滾：成功＝這句被接受（不留痕跡）、丟例外＝被擋 */
class Rollback extends Error {}
export async function tryIn(db: PGlite, sql: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
export async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

// ---------------------------------------------------------------------------------------------
// 固定的團體與選舉：團體碼表（lg_code_registry）裡真的有的
// ---------------------------------------------------------------------------------------------
export type Reg = { lg_code: string; pref_code: string; pref_name: string; name: string; kana: string; kind: string };
export const ICHI = "232033", AICHI = "230006", CHIKUSA = "231011";
export const ICHI_ELECTION = "2027-04-25_mayor_232033";
export const SOUMU = "https://www.soumu.go.jp/denshijiti/code.html";
export const ELECTION_URL = "https://www.city.ichinomiya.aichi.jp/senkyo/";
export const ESTAT = "https://www.e-stat.go.jp/regional-statistics/ssdsview/municipality";

export async function regOf(db: PGlite, code: string): Promise<Reg> {
  return (await one<Reg>(db, `SELECT lg_code, pref_code, pref_name, name, kana, kind FROM policy_jp.lg_code_registry WHERE lg_code = $1`, [code]))!;
}

let seq = 0;
/** 交件（created_at／verified_at 照交件順序遞增，掃描照這個排） */
export async function submit(
  db: PGlite, type: string, payload: Record<string, unknown>,
  o: { status?: string; task?: string | null; urls?: string[]; agent?: string; ip?: string } = {},
): Promise<string> {
  const n = ++seq;
  const status = o.status ?? "pending";
  return (await one<{ id: string }>(db,
    `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash, status, verified_at, created_at)
     VALUES ($1, $2::JSONB, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'verified' THEN TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $9) END,
             TIMESTAMPTZ '2026-10-09 00:00:00+00' + make_interval(secs => $9)) RETURNING id`,
    [type, JSON.stringify(payload), o.urls ?? [SOUMU], o.task ?? null, o.agent ?? `author-${n}`, o.ip ?? `author-ip-${n}`, `h-${n}`, status, n])).id;
}
export const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 通過驗證的交件都落庫（掃地機一輪只落「現在不被擋」的，被擋的等下一輪；到沒東西可落為止） */
export async function applyAll(db: PGlite): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const r = (await one<{ r: { scanned: number } }>(db, `SELECT policy_jp.apply_verified_pending(100, 0) AS r`)).r;
    if (r.scanned === 0) return;
  }
}
/** 團體直接進庫（都道府県先） */
export async function insertLg(db: PGlite, code: string): Promise<void> {
  const r = await regOf(db, code);
  if (r.pref_code !== code) await insertLg(db, r.pref_code);
  await db.query(`INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug) VALUES ($1, $2, $3, $4, $5, $1) ON CONFLICT DO NOTHING`,
    [r.lg_code, r.kind, r.pref_code, r.name, r.kana]);
}
/** 已上線的選舉直接進庫（團體要先在庫裡）；回 id。notice：告示日（預設投票日前 17 天） */
export async function insertElection(db: PGlite, lg: string, date: string, o: { type?: string; status?: string; notice?: string | null } = {}): Promise<string> {
  const type = o.type ?? "mayor";
  const id = `${date}_${type}_${lg}`;
  await insertLg(db, lg);
  const notice = o.notice === undefined ? addDays(date, -17) : o.notice;
  await db.query(
    `INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, lg_code, review_status)
     VALUES ($1, $2, $3, $4, $5, 'regular', policy_jp.election_level($5), $6, $7)`,
    [id, `${(await regOf(db, lg)).name}${type}選挙`, date, notice, type, lg, o.status ?? "published"]);
  return id;
}
export async function sourceId(db: PGlite, url = ESTAT): Promise<number> {
  return (await one<{ id: number }>(db, `INSERT INTO policy_jp.sources (url, origin, source_kind) VALUES ($1, 'test', 'statistics')
    ON CONFLICT (url) DO UPDATE SET origin = EXCLUDED.origin RETURNING id::INT AS id`, [url])).id;
}
const STAT_ROWS: Array<[string, number, number]> = [["population", 2025, 386678], ["area_km2", 2025, 113.82], ["aging_rate", 2025, 28.6], ["budget_expenditure", 2023, 99999]];
/** 統計直接進庫（第 1 步完成的條件之一） */
export async function fillStats(db: PGlite, lg: string): Promise<void> {
  const sid = await sourceId(db);
  for (const [k, y, v] of STAT_ROWS) {
    await db.query(`INSERT INTO policy_jp.regional_stats (lg_code, stat_key, year, value, unit, source_id, review_status) VALUES ($1, $2, $3, $4, policy_jp.regional_stat_unit($2), $5, 'published')`,
      [lg, k, y, v, sid]);
  }
}
/** 第 1 步（地區資料）整個完成：團體・選舉進庫、統計補齊。回選舉 id */
export async function openElectionWithRegion(db: PGlite, lg: string, date: string, o: { type?: string; notice?: string | null } = {}): Promise<string> {
  const id = await insertElection(db, lg, date, o);
  await fillStats(db, lg);
  return id;
}

/** 回報任務的查核結果（no_change 落庫＝task_checks 一列） */
export const check = (db: PGlite, taskId: string, outcome: "confirmed" | "not_found" | "unreachable") =>
  db.query(`INSERT INTO policy_jp.task_checks (task_id, outcome, agent_name) VALUES ($1, $2, 'checker')`, [taskId, outcome]);
export const expireCooling = (db: PGlite) =>
  db.exec(`UPDATE policy_jp.task_checks SET checked_at = now() - ((policy_jp.task_check_cooldown_days() + 1) || ' days')::INTERVAL`);

export type Dispatch = { task_id: string; task_type: string; target: Record<string, unknown>; opened_by: Record<string, unknown> | null; what_we_need: string; priority: number; region: string };
export const dispatches = (db: PGlite, types: string[]) => rows<Dispatch>(db,
  `SELECT task_id, task_type, target, opened_by, what_we_need, priority, region FROM policy_jp.task_dispatches WHERE task_type = ANY ($1) ORDER BY task_id`, [types]);
export const dispatchIds = async (db: PGlite, types: string[]) => (await dispatches(db, types)).map((d) => d.task_id);
export type Ev = { event: string; reason: string | null; detail: { chain_gate?: { after_step: string; via: string } } & Record<string, unknown> };
export const events = (db: PGlite, taskId: string) => rows<Ev>(db, `SELECT event, reason, detail FROM policy_jp.gap_events WHERE task_id = $1 ORDER BY id`, [taskId]);
export type Prog = { election_id: string; lg_code: string; step: string; done: boolean; done_at: string | null };
export const progress = (db: PGlite, electionId?: string) => rows<Prog>(db,
  `SELECT election_id, lg_code, step, done, done_at FROM policy_jp.election_chain_progress ${electionId ? `WHERE election_id = '${electionId}'` : ""} ORDER BY election_id, step`);
export const stepsDone = async (db: PGlite, electionId: string) => Object.fromEntries((await progress(db, electionId)).map((p) => [p.step, p.done]));

/** 同意票（または反対票）を 1 票入れる。net＝投票者の接続元（網段）、judge＝反証つきの重い票。票を入れると共識の觸發器が走る */
let voteSeq = 0;
export async function vote(db: PGlite, contributionId: string, net: string, o: { judge?: boolean; verdict?: "agree" | "disagree" | "unsure" } = {}): Promise<string> {
  const n = ++voteSeq;
  await db.query(
    `INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash, via, note, judge_backed)
     VALUES ($1, $2, $3, $4, 'test', 'テストの票', $5)`, [contributionId, o.verdict ?? "agree", `voter-${n}-agent`, net, o.judge ?? false]);
  return await statusOf(db, contributionId);
}
export const statusOf = async (db: PGlite, id: string) => (await one<{ status: string }>(db, `SELECT status FROM policy_jp.contributions WHERE id = $1`, [id])).status;

/** 貢獻をその場で落庫する（verified の交件に対して）。戻りは apply_contribution の JSON */
export async function applyOne(db: PGlite, id: string): Promise<{ status: string; outcome?: string; message?: string; table_name?: string; record_id?: string }> {
  return (await one<{ r: { status: string } }>(db, `SELECT policy_jp.apply_contribution($1::UUID) AS r`, [id])).r;
}
