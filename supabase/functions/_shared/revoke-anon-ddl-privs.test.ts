/**
 * 收緊預設權限（migration 20261120000000_revoke_anon_ddl_privs.sql）：
 *   A. 文字層：兩句都在、只收回不授權、service_role／postgres 不動
 *   B. PGlite：跑完後 anon／authenticated 對表沒有 TRUNCATE／TRIGGER／REFERENCES，讀寫權限保留；之後新建的表也一樣；可重跑
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIG = (await Deno.readTextFile(new URL("../../migrations/20261120000000_revoke_anon_ddl_privs.sql", import.meta.url))).replace(/\r\n/g, "\n");
const code = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

Deno.test("A 文字層：兩句收回都在；沒有 GRANT；不碰 service_role／postgres", () => {
  assert(code.includes("REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;"));
  assert(code.includes("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;"));
  assert(!/\bGRANT\b/i.test(code), "只收回、不授權");
  assert(!/service_role/.test(code), "service_role 不動");
});

async function has(db: PGlite, role: string, tbl: string, priv: string): Promise<boolean> {
  const r = await db.query<{ x: boolean }>(`SELECT has_table_privilege('${role}', '${tbl}', '${priv}') AS x`);
  return r.rows[0].x;
}

Deno.test("B PGlite：收回三種權限、保留 CRUD；新表同樣；重跑不報錯", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    CREATE TABLE t_old (id int);
    GRANT ALL ON t_old TO anon, authenticated, service_role;
  `);
  const who = (await db.query<{ u: string }>(`SELECT current_user AS u`)).rows[0].u;
  const mig = code.replace("FOR ROLE postgres", `FOR ROLE ${who}`);
  await db.exec(mig);
  await db.exec(`CREATE TABLE t_new (id int);`);
  for (const t of ["t_old", "t_new"]) {
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["TRUNCATE", "TRIGGER", "REFERENCES"]) assertEquals(await has(db, role, t, p), false, `${role} ${t} ${p}`);
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assertEquals(await has(db, role, t, p), true, `${role} ${t} ${p}`);
    }
    assertEquals(await has(db, "service_role", t, "TRUNCATE"), true, `service_role ${t} 不動`);
  }
  await db.exec(mig); // 冪等
  await db.close();
});
