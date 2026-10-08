/**
 * cec_registrations 的 PGlite 測試環境——給 cec-registrations.test.ts（CI）與 scripts/cec-registrations-snapshot.ts（正式庫唯讀快照）共用。
 *
 * 真的 migration（資料表、資料、roster_registration_gap）＋ 最小的人物表（politicians／regions／politician_elections，只有這支函式讀的欄位）
 * ＋ 真的 cec_name_norm／cec_name_key。不是測試檔（沒有 .test.ts），deno test 不會單獨跑它。
 */
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { latestFn, readMig } from "./arms-pglite.ts";

export const SCHEMA_MIG = "20261008130000_cec_registrations.sql";
export const DATA_MIG = "20261008130100_cec_registrations_data.sql";

export const BASE_SCHEMA_SQL = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, region text, sub_region text, merged_into uuid);
CREATE TABLE regions (id serial PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id serial PRIMARY KEY, election_id integer, election_type text, politician_id uuid, region_id integer, candidacy_status text);
`;

export async function buildRegistrationsDb(opts: { schema?: (s: string) => string; withData?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA_SQL);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec((opts.schema ?? ((s) => s))(await readMig(SCHEMA_MIG)));
  if (opts.withData !== false) await db.exec(await readMig(DATA_MIG));
  return db;
}

/** 我們 2026 的參選紀錄（正式庫唯讀快照的一列；欄位見 scripts/cec-registrations-snapshot.ts 檔頭的查詢） */
export interface OursRow {
  pid: string; name: string; p_region: string | null; p_sub: string | null; election_type: string; candidacy_status: string | null;
  r_region: string | null; r_sub: string | null; r_village: string | null;
}

/** 灌「我們的人」：一筆參選紀錄一個人物、有選區列的指到 regions（跟正式庫的形狀一樣） */
export async function loadOurs(db: PGlite, rows: readonly OursRow[]): Promise<void> {
  await db.query(`
    WITH src AS (SELECT row_number() OVER () AS n, x.* FROM jsonb_to_recordset($1::jsonb) AS x(
      name text, p_region text, p_sub text, election_type text, candidacy_status text, r_region text, r_sub text, r_village text)),
    p AS (INSERT INTO politicians (id, name, region, sub_region)
          SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, name, p_region, p_sub FROM src RETURNING id),
    r AS (INSERT INTO regions (id, region, sub_region, village) SELECT 100000 + n, r_region, r_sub, r_village FROM src WHERE r_region IS NOT NULL RETURNING id)
    INSERT INTO politician_elections (election_id, election_type, politician_id, region_id, candidacy_status)
    SELECT 2026, election_type, ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
           CASE WHEN r_region IS NOT NULL THEN 100000 + n END, candidacy_status FROM src`, [JSON.stringify(rows)]);
}
