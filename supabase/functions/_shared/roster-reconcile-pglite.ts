/**
 * 名冊比對表（20261019120000_roster_reconcile.sql）的 PGlite 測試環境——給 roster-reconcile.test.ts、roster-reconcile-arms.test.ts 共用。
 *
 * 真的 migration 段落（tables／rows／units／run）＋真的 cec_name_norm／cec_name_key＋真的 cec_registrations 表結構（不灌 19,695 列資料，測試自己灌小資料）
 * ＋最小的人物表（politicians／regions／politician_elections／policies／source_refs／edit_history，只有這些函式讀寫的欄位）。
 * 排程、Vault 密鑰那段（auth）與派工臂那段（arms）需要 pg_cron／vault／整套派工表，不在這裡載入（arms 有自己的測試）。
 * 不是測試檔（沒有 .test.ts），deno test 不會單獨跑它。
 */
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, readMig } from "./arms-pglite.ts";

export const MIG_NAME = "20261019120000_roster_reconcile.sql";
export const REG_SCHEMA_MIG = "20261008130000_cec_registrations.sql";

const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  if (i < 0 || j < 0 || j < i) throw new Error(`找不到段落 ${a}`);
  return s.slice(i + a.length, j);
};
export const section = (sql: string, name: string) => between(sql, `-- ▼▼ SECTION: ${name} ▼▼`, `-- ▲▲ SECTION: ${name} ▲▲`);

/** 去掉 REVOKE／GRANT 陳述（PGlite 沒有 service_role 以外的權限情境；角色另外建） */
const stripGrants = (sql: string) => sql.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

export const BASE_SCHEMA_SQL = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, party text, position text, region text, sub_region text, merged_into uuid);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer NOT NULL, election_type text, politician_id uuid NOT NULL REFERENCES politicians(id),
  region_id integer, candidacy_status text, withdrawn_after_filing boolean NOT NULL DEFAULT false, source_note text,
  UNIQUE (politician_id, election_id));
CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), politician_id uuid REFERENCES politicians(id));
CREATE TABLE source_refs (id bigserial PRIMARY KEY, target_table text, target_id text, source_url text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
`;

export async function buildReconcileDb(edit: (migrationText: string) => string = (s) => s): Promise<{ db: PGlite; mig: string }> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA_SQL);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec(await latestFn("activity_audit"));
  const regMig = await readMig(REG_SCHEMA_MIG);
  await db.exec(regMig);
  const mig = edit(await readMig(MIG_NAME));   // edit：測試的還原驗證用（把 migration 改壞，指定的情境必須轉紅）
  for (const s of ["tables", "rows", "units", "run"]) await db.exec(stripGrants(section(mig, s)));
  return { db, mig };
}

export interface RegSeed {
  type: string; region: string; sub?: string | null; village?: string | null; district?: string | null; name: string; party?: string; source?: string;
}
export interface OurSeed {
  name: string; type: string; status: string; region: string; sub?: string | null; filedOut?: boolean; election?: number; birth?: never;
}

/** 灌名冊：每個 source 一份（row_count 自動算）；列序依來源內出現順序 */
export async function loadRegs(db: PGlite, rows: readonly RegSeed[], election = 2026): Promise<void> {
  const bySource = new Map<string, RegSeed[]>();
  for (const r of rows) {
    const s = r.source ?? `https://example.test/${r.type}.pdf`;
    bySource.set(s, [...(bySource.get(s) ?? []), r]);
  }
  for (const [url, list] of bySource) {
    await db.query(`INSERT INTO cec_registration_sources (source_url, election_id, election_type, label, row_count, parsed_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [url, election, list[0].type, `測試名冊 ${list[0].type}`, list.length]);
    let n = 0;
    for (const r of list) {
      n++;
      await db.query(
        `INSERT INTO cec_registrations (election_id, election_type, region, place, sub_region, village, district, name, party, row_no, source_url, flags, parsed_at)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
        [election, r.type, r.region, r.sub ?? null, r.village ?? null, r.district ?? null, r.name, r.party ?? "無", n, url, r.name === "" ? ["name_empty"] : []],
      );
    }
  }
}

/** 灌「我們的人」：一筆參選紀錄一個人物（同名可以有好幾位）；有 region 的指到一列 regions（縣市層級 sub 為空）。回傳 [politician_id, pe_id] */
export async function addOurs(db: PGlite, o: OurSeed): Promise<{ pid: string; peId: number }> {
  const { rows: [p] } = await db.query<{ id: string }>(
    `INSERT INTO politicians (name, party, region, sub_region) VALUES ($1, '無黨籍', $2, $3) RETURNING id`, [o.name, o.region, o.sub ?? null]);
  const { rows: [rg] } = await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region) VALUES ($1, $2) RETURNING id`, [o.region, o.sub ?? null]);
  const { rows: [pe] } = await db.query<{ id: number }>(
    `INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status, withdrawn_after_filing)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [o.election ?? 2026, o.type, p.id, rg.id, o.status, o.filedOut ?? false]);
  return { pid: p.id, peId: pe.id };
}

/** 只有人物（沒有 2026 參選紀錄）：給「全庫同名」的情境；past＝補一筆舊屆參選紀錄（讓他在某縣市出現過） */
export async function addPerson(db: PGlite, name: string, opts: { region?: string; party?: string; past?: { election: number; type: string; region: string; sub?: string | null; village?: string | null } | null; merged?: boolean } = {}): Promise<string> {
  const { rows: [p] } = await db.query<{ id: string }>(`INSERT INTO politicians (name, party, region) VALUES ($1, $3, $2) RETURNING id`, [name, opts.region ?? null, opts.party ?? '無黨籍']);
  if (opts.merged) {
    const { rows: [k] } = await db.query<{ id: string }>(`INSERT INTO politicians (name, party, region) VALUES ($1, '無黨籍', $2) RETURNING id`, [name + "(保留)", opts.region ?? null]);
    await db.query(`UPDATE politicians SET merged_into = $1 WHERE id = $2`, [k.id, p.id]);
  }
  if (opts.past) {
    const { rows: [rg] } = await db.query<{ id: number }>(`INSERT INTO regions (region, sub_region, village) VALUES ($1, $2, $3) RETURNING id`, [opts.past.region, opts.past.sub ?? null, opts.past.village ?? null]);
    await db.query(`INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status) VALUES ($1, $2, $3, $4, 'elected')`,
      [opts.past.election, opts.past.type, p.id, rg.id]);
  }
  return p.id;
}

export interface ReconRow {
  reg_id: string | null; name: string; election_type: string; county: string; town: string; category: string; reason: string | null;
  person_action: string | null; pe_id: number | null; politician_id: string | null; our_status: string | null; system_applied: boolean;
}
export async function reconcile(db: PGlite): Promise<ReconRow[]> {
  const { rows } = await db.query<ReconRow>(
    `SELECT reg_id::text, name, election_type, county, town, category, reason, person_action, pe_id, politician_id, our_status, system_applied FROM roster_reconcile ORDER BY election_type, name, reg_id`);
  return rows;
}
export const byName = (rows: readonly ReconRow[], name: string) => rows.filter((r) => r.name === name);
