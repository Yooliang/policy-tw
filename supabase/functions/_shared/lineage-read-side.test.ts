/**
 * #349 第二階段 A（讀取端改讀政策脈絡，related_policies 互指退場）的守門測試。
 *   1. migration 只加不刪：不 DROP 表、不 DROP 欄位、不改視圖 policies_with_logs（拿不掉欄位的 CREATE OR REPLACE 也不碰）
 *   2. 寫入端守門：related_policies 的新增與修改被觸發器擋下（DELETE 不擋，policies 刪除要能連帶清掉）
 *   3. related_policies_uncovered 只列「兩條政見不在同一條脈絡」的互指（刪表前的前置檢查，正常是空的）
 *   4. 資料走流程：migration 不寫任何一條脈絡、不搬互指進脈絡
 *   5. 沒有任何寫入端（Edge Function、共用邏輯）寫 related_policies
 * SQL 本身另外在 PGlite（WASM Postgres）上實跑過，見 PR 說明；這裡沒有資料庫。
 */
import { assert, assertFalse } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261006234000_lineage_read_side.sql";

/** 去掉 -- 註解再比對，說明文字裡提到 DROP／INSERT 不算 */
function code(sql: string): string {
  return sql.replace(/\r/g, "").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

Deno.test("migration 只加不刪：沒有 DROP TABLE／DROP COLUMN／DROP VIEW，視圖 policies_with_logs 原封不動", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  assertFalse(/DROP\s+TABLE/i.test(sql), "刪表是第二階段 B");
  assertFalse(/DROP\s+COLUMN/i.test(sql), "刪欄位是第二階段 B");
  assertFalse(/DROP\s+VIEW/i.test(sql), "不重建視圖：policies_with_logs 的 related_policy_ids 留到第二階段 B 跟著刪表一起拿掉");
  assertFalse(/policies_with_logs/i.test(sql), "這一支不碰 policies_with_logs");
  // 唯一允許的 DROP：重建自己的觸發器（讓這支 migration 可以重跑）
  const drops = sql.match(/DROP\s+\w+(\s+IF\s+EXISTS)?\s+\w+/gi) ?? [];
  assert(drops.every((d) => /TRIGGER/i.test(d)), `只能 DROP 自己的觸發器：${drops.join("；")}`);
});

Deno.test("寫入端守門：related_policies 新增與修改被觸發器擋下，刪除不擋", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  assert(/CREATE TRIGGER related_policies_no_write\s+BEFORE INSERT OR UPDATE ON related_policies\s+FOR EACH ROW EXECUTE FUNCTION related_policies_retired\(\)/i.test(sql));
  assertFalse(/BEFORE[^;]*\bDELETE\b/i.test(sql), "DELETE 不能擋：policies 刪除要連帶清 related_policies");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION related_policies_retired"));
  assert(/RAISE EXCEPTION[\s\S]*lineage/i.test(fn.slice(0, fn.indexOf("$$;") + 3)), "擋下時要講改走哪裡（交 lineage）");
});

Deno.test("related_policies_uncovered：互指的兩條政見不在同一條脈絡才列，security_invoker、只給讀", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW related_policies_uncovered"));
  assert(/a\.lineage_id IS NULL OR b\.lineage_id IS NULL OR a\.lineage_id <> b\.lineage_id/.test(view), "只有『不在同一條脈絡』才算沒被涵蓋");
  assert(/ALTER VIEW related_policies_uncovered SET \(security_invoker = on\)/.test(view));
  assert(/GRANT SELECT ON related_policies_uncovered TO anon, authenticated/.test(view));
  assertFalse(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i.test(sql));
});

Deno.test("資料走流程：migration 不寫脈絡、不把互指搬進脈絡", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  for (const t of ["lineages", "lineage_participants", "handovers", "lineage_links"]) {
    assertFalse(new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${t}\\b`, "i").test(sql), `不可以直接寫 ${t}`);
  }
  assertFalse(/UPDATE\s+policies\b/i.test(sql), "不可以直接改政見的 lineage_id");
  assertFalse(/INSERT\s+INTO\s+related_policies/i.test(sql));
});

Deno.test("沒有任何寫入端寫 related_policies：Edge Function 與共用邏輯不碰這張表", async () => {
  const root = new URL("../", import.meta.url);
  const hits: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) { if (e.name !== "node_modules") await walk(u); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      if (/related_policies|related_policy_ids/.test(await Deno.readTextFile(u))) hits.push(u.pathname);
    }
  };
  await walk(root);
  assertFalse(hits.length > 0, `這些檔案提到 related_policies：${hits.join("、")}。互指由政策脈絡取代，不要再寫它`);
});
