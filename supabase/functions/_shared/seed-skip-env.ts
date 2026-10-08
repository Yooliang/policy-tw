/**
 * seed_auto_task_queue／rebalance_queue「內容沒變不重寫」（#465，migration 20261009040000_seed_skip_unchanged.sql）的 PGlite 環境——
 * 給 seed-skip-unchanged.test.ts（CI）與 scripts/seed-skip-parity.ts（正式庫快照）共用。
 *
 * 做法（沿用 page-traffic-boost.test.ts 的環境）：真的 P0／P1／優先層 #443／P2×3／手動任務臂 #453／頁面流量提層／這支；
 * 28 個分支換成回放 _b_<名字> 的 stub；真的 queue_slot／rebalance_queue／contribution_queue_tasks／task_dispatched／seed。
 * 「改前」的兩支函式以 seed_auto_task_queue_old()／rebalance_queue_old() 留在同一個資料庫裡（本體取自上一版 migration，
 * seed_old 呼叫的是 rebalance_queue_old），所以同一個交易裡可以從同一個狀態各跑一次、比結果（now() 一樣，queue_at 才比得起來）。
 *
 * 不是測試檔（沒有 .test.ts），deno test 不會單獨跑它。
 */
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import {
  applyP2, buildArmsDb, type Election, fnText, type GapRow, latestFn, P2_ER_MIG, P2_PG_MIG, P2_PR_MIG, readMig, type Scope,
} from "./arms-pglite.ts";

export const MIG = "20261009040000_seed_skip_unchanged.sql";
/** 改前的 seed（含流量提層區塊）：頁面流量提層那支 */
export const SEED_BASE_MIG = "20261008190000_page_traffic_boost.sql";
/** 改前的 rebalance_queue：手動任務變一支臂那支 */
export const REBALANCE_BASE_MIG = "20261008165000_manual_tasks_as_arm.sql";
const QP_MIG = "20261008090000_queue_priority_tiers.sql";
const MAN_MIG = REBALANCE_BASE_MIG;
export const RESTUB = ["raw", "election_results", "party_gap", "party_roster", "ballot_numbers"] as const;

export type SeedEnvOptions = {
  branches?: Record<string, GapRow[] | string>;
  elections?: Election[];
  scope?: Scope[];
  /** 改壞這支 migration 的文字（還原驗證用） */
  mutateMig?: (sql: string) => string;
  /** 不套這支（只留改前的函式；給「改前」的基準線用） */
  skipMig?: boolean;
};

export async function buildSeedEnv(o: SeedEnvOptions = {}): Promise<PGlite> {
  const QP_SQL = await readMig(QP_MIG);
  const pre = `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, merged_into uuid);
    CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL);
    CREATE TABLE policies (id uuid PRIMARY KEY, politician_id uuid NOT NULL);
    ${await latestFn("politician_name_is_placeholder")}
    ALTER TABLE elections ADD COLUMN bulletin_published_on date, ADD COLUMN bulletin_dir text;
    ALTER TABLE politicians ADD COLUMN region text, ADD COLUMN avatar_url text;
    ALTER TABLE politician_elections ADD COLUMN election_id integer, ADD COLUMN election_type text;
    ${await latestFn("roster_scope_milestone_date")}
    CREATE VIEW ballot_number_anomalies AS SELECT NULL::integer AS election_id, NULL::text AS election_type, NULL::text AS kind WHERE false;
    CREATE FUNCTION contribution_subject_politician(p jsonb) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::uuid $$;
    ${await latestFn("uuid_or_null")}
    UPDATE elections SET bulletin_published_on = DATE '2026-11-18' WHERE id = 2026;
    ALTER TABLE contributions ADD COLUMN contributor_ip_hash text, ADD COLUMN agent_name text, ADD COLUMN payload jsonb;
    CREATE TABLE contribution_task_leases (task_id text, target_key text, leased_until timestamptz, agent_name text);
    ${await latestFn("task_target_key")}
    DROP FUNCTION queue_slot(text);
    ${await latestFn("queue_slot")}
    ${await latestFn("contribution_auto_tasks")}
    ${await latestFn("contribution_auto_task_counts")}
    ${await latestFn("task_dispatched")}
    CREATE TABLE contribution_tasks (
      id uuid PRIMARY KEY, title text NOT NULL, description text, task_type text NOT NULL, target jsonb NOT NULL DEFAULT '{}'::jsonb, region text,
      priority integer NOT NULL DEFAULT 1, reward integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open', source text NOT NULL DEFAULT 'manual',
      suggested_by text, hint_sources text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE citizen_questions (id uuid PRIMARY KEY, stance_up integer NOT NULL DEFAULT 0, answer_count integer NOT NULL DEFAULT 0);
    CREATE OR REPLACE FUNCTION contribution_queue_at(t text, k text, c timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT queue_slot('verify') $$;
    ${QP_SQL}`;
  const db = await buildArmsDb({
    branches: o.branches ?? {},
    elections: o.elections,
    scope: o.scope,
    extraBranches: ["ballot_numbers"],
    afterP1Sql: pre,
    p2: { migs: [{ name: P2_ER_MIG }, { name: P2_PG_MIG }, { name: P2_PR_MIG }, { name: MAN_MIG }, { name: SEED_BASE_MIG }], restub: RESTUB },
  });
  // 改前的兩支留成 _old（此刻資料庫裡的 seed／rebalance 就是改前的版本）
  const oldReb = fnText(await readMig(REBALANCE_BASE_MIG), "rebalance_queue").replace("CREATE OR REPLACE FUNCTION rebalance_queue()", "CREATE OR REPLACE FUNCTION rebalance_queue_old()");
  const oldSeed = fnText(await readMig(SEED_BASE_MIG), "seed_auto_task_queue")
    .replace("CREATE OR REPLACE FUNCTION seed_auto_task_queue()", "CREATE OR REPLACE FUNCTION seed_auto_task_queue_old()")
    .replace("PERFORM rebalance_queue();", "PERFORM rebalance_queue_old();");
  if (!oldSeed.includes("rebalance_queue_old()") || !oldReb.includes("rebalance_queue_old()")) throw new Error("改前的函式複本沒換名");
  await db.exec(oldReb);
  await db.exec(oldSeed);
  if (!o.skipMig) await applyP2(db, (o.mutateMig ?? ((s) => s))(await readMig(MIG)), RESTUB);
  await db.exec("SET app.activity_today = '2026-10-08'");
  return db;
}
