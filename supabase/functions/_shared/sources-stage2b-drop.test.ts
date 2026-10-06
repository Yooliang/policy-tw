/**
 * #347 第二階段 B-2：刪舊的出處欄位、舊表、同步觸發器（migration 20261007120000）的守門。
 *
 * 守的是「刪得乾淨、順序對、不多刪、前置條件硬擋」：
 *   - policies.source_url、tracking_logs.source_url、policy_sources 與四支 sources_sync_* 觸發器／函式都刪了
 *   - 刪欄位之前：核對視圖要空、policy_sources 要空、B-1 的接手物件要在（硬擋，不是警告）
 *   - 順序：policies_with_logs 要先 DROP（它的 p.* 展開了 source_url，會擋住 DROP COLUMN）、欄位刪掉之後才重建
 *   - trg_policies_updated_at 的欄位清單拿掉 source_url 才刪得掉欄位
 *   - 不多刪：source_refs／sources 與別張表自己的 source_url 同步（policy_elements、lineage_*）不動
 * 每一條都做過還原驗證（見 PR 說明）：拿掉被守的東西，對應那條要轉紅。SQL 另在 PGlite 實跑（見 PR 說明）。
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replaceAll("\r\n", "\n");
const MIGRATION = await read("../../migrations/20261007120000_sources_stage2b_drop_legacy.sql");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = code(MIGRATION);
const at = (needle: string) => {
  const i = sql.indexOf(needle);
  assert(i >= 0, `migration 裡找不到「${needle}」`);
  return i;
};

Deno.test("刪的東西：兩個欄位、舊表、四支同步觸發器與函式；只刪這些", () => {
  assertMatch(sql, /ALTER TABLE policies DROP COLUMN source_url;/);
  assertMatch(sql, /ALTER TABLE tracking_logs DROP COLUMN source_url;/);
  assertMatch(sql, /DROP TABLE policy_sources;/);
  for (const [t, table] of [["trg_sources_sync_policy", "policies"], ["trg_sources_sync_tracking_log", "tracking_logs"], ["trg_sources_sync_policy_source", "policy_sources"], ["trg_sources_sync_contribution", "contributions"]]) {
    assertMatch(sql, new RegExp(`DROP TRIGGER IF EXISTS ${t} ON ${table};`));
  }
  for (const f of ["sources_sync_policy", "sources_sync_tracking_log", "sources_sync_policy_source", "sources_sync_contribution"]) assertMatch(sql, new RegExp(`DROP FUNCTION IF EXISTS ${f}\\(\\);`));
  // 不多刪
  assertEquals((sql.match(/\bDROP COLUMN\b/g) ?? []).length, 2, "只刪兩個欄位");
  assertEquals(/DROP\s+(TABLE|COLUMN)\s+(?:IF EXISTS\s+)?(sources|source_refs|policy_elements|lineage_participants|handovers|lineage_links)\b/.test(sql), false, "出處表與別張表自己的 source_url 不動");
  assertEquals(/DROP TRIGGER[^;]*(policy_elements_sync_source|lineage_participants_sync_source|handovers_sync_source|lineage_links_sync_source)/.test(sql), false);
  assertEquals(/DROP\s+TABLE\s+(IF EXISTS\s+)?policy_sources\s+CASCADE/i.test(sql) || /CASCADE/i.test(sql), false, "不用 CASCADE：有沒預期到的依賴要讓它報錯，不是默默一起刪掉");
});

Deno.test("前置條件硬擋：核對視圖要空、policy_sources 要空、B-1 的接手物件要在——不是警告，是 RAISE EXCEPTION", () => {
  const checks = sql.slice(0, at("DROP TRIGGER IF EXISTS trg_sources_sync_policy ON policies;"));
  assertMatch(checks, /SELECT count\(\*\) INTO v_drift FROM source_refs_drift;\s+IF v_drift > 0 THEN\s+RAISE EXCEPTION/);
  assertMatch(checks, /SELECT count\(\*\) INTO v_ps FROM policy_sources;\s+IF v_ps > 0 THEN\s+RAISE EXCEPTION/);
  assertMatch(checks, /tgname = 'trg_sources_register_contribution'\)\s+THEN\s+RAISE EXCEPTION/);
  assertMatch(checks, /to_regprocedure\('source_set_primary\(text,text,text,text\)'\) IS NULL OR to_regprocedure\('policy_primary_url\(uuid\)'\) IS NULL/);
  assertEquals(/RAISE WARNING/.test(sql), false, "刪欄位不可復原，不用警告");
});

Deno.test("順序：視圖與觸發器的依賴先放掉、欄位才刪、視圖欄位刪掉之後才重建（p.* 展開在建立當下）", () => {
  const dropView = at("DROP VIEW IF EXISTS policies_with_logs;");
  const dropTable = at("DROP TABLE policy_sources;");
  const dropCol1 = at("ALTER TABLE policies DROP COLUMN source_url;");
  const dropCol2 = at("ALTER TABLE tracking_logs DROP COLUMN source_url;");
  const createView = at("CREATE VIEW policies_with_logs AS");
  const driftReplace = at("CREATE OR REPLACE VIEW source_refs_drift AS");
  const touch = at("CREATE TRIGGER trg_policies_updated_at");
  assert(dropView < dropCol1, "policies_with_logs 先 DROP（不然 DROP COLUMN 被它的依賴擋住）");
  assert(driftReplace < dropTable && driftReplace < dropCol1, "核對視圖先換成不依賴舊欄位的版本");
  assert(touch < dropCol1, "更新時間觸發器的欄位清單先拿掉 source_url");
  assert(createView > dropCol1 && createView > dropCol2, "視圖在欄位刪掉之後才重建（先建的話 p.* 會把 source_url 展開進去，DROP COLUMN 又被擋）");
  assert(at("DROP TRIGGER IF EXISTS trg_sources_sync_policy_source ON policy_sources;") < dropTable, "先刪 policy_sources 上的觸發器再刪表");
  const trg = sql.slice(touch, sql.indexOf(";", touch));
  assertEquals(/source_url/.test(trg), false, "觸發器欄位清單不能再提到 source_url");
  assertMatch(trg, /BEFORE UPDATE OF title, description, category, status, proposed_date, last_updated, progress, tags, election_id, politician_id, removed_at ON policies/);
});

Deno.test("視圖：policies_with_logs 的 logs[] 不再帶舊鍵 source_url、最後一欄仍是 sources、授權與 security_invoker 補回；核對視圖改成不依賴舊欄位", () => {
  const view = sql.slice(at("CREATE VIEW policies_with_logs AS"), at("ALTER VIEW policies_with_logs SET (security_invoker = on);"));
  assertEquals(/tl\.source_url/.test(view), false);
  assertMatch(view, /'sources', source_brief_list\('tracking_logs', tl\.id::text\)/);
  assertMatch(view, /source_brief_list\('policies', p\.id::text\) AS sources\s+FROM policies p;/, "最後一欄仍是 sources");
  // 政見三要素自己的 source_url 是 policy_elements 的欄位，不動
  assertMatch(view, /'source_locator', e\.source_locator, 'source_url', e\.source_url/);
  assertMatch(sql, /GRANT SELECT ON policies_with_logs TO anon, authenticated;/);
  const drift = sql.slice(at("CREATE OR REPLACE VIEW source_refs_drift AS"), at("ALTER VIEW source_refs_drift SET (security_invoker = on);"));
  assertEquals(/source_url|policy_sources/.test(drift), false, "核對視圖不再依賴舊欄位與舊表");
  for (const problem of ["policy_multi_primary", "log_multi_primary", "dangling_ref"]) assert(drift.includes(`'${problem}'`), `核對視圖要留 ${problem}`);
});

Deno.test("交易包住、結尾自檢涵蓋：欄位與表不在、觸發器不在、列數與出處筆數不變、派工臂還能跑、授權在", () => {
  assert(/^BEGIN;$/m.test(sql) && /^COMMIT;$/m.test(sql));
  for (const msg of ["這些欄位還在", "policy_sources 還在", "舊的同步觸發器還在", "舊的同步函式還在", "trg_policies_updated_at 不在或還提到 source_url",
    "policies_with_logs 筆數變了", "政見的主要出處引用變了", "進度的主要出處引用變了", "sources／source_refs 的筆數變了", "policies_with_logs.logs 還帶舊鍵 source_url",
    "視圖授權沒補回來", "視圖的 security_invoker 沒補回來"]) assert(sql.includes(msg), `自檢少了「${msg}」`);
  for (const arm of ["raw", "legacy", "mismatch", "policy_elements"]) assert(sql.includes(`FROM contribution_auto_tasks_${arm}()`), `自檢要跑一次派工臂 ${arm}`);
  assert(sql.lastIndexOf("RAISE EXCEPTION") > at("ALTER TABLE tracking_logs DROP COLUMN source_url;"), "自檢在刪欄位之後");
});

Deno.test("B-2 接在 B-1 後面：migration 時間戳大於 B-1，B-1 的接手物件沒被這支碰", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) names.push(e.name);
  const b1 = names.find((n) => n.includes("sources_stage2b_read_side"));
  const b2 = names.find((n) => n.includes("sources_stage2b_drop_legacy"));
  assert(b1 && b2 && b1.slice(0, 14) < b2.slice(0, 14), "B-2 要排在 B-1 後面");
  assertEquals(/\b(CREATE|DROP|ALTER)\b[^;]*(sources_register_contribution|policy_primary_url|source_set_primary)/.test(sql), false, "B-2 只檢查它們在不在，不建也不刪");
});

Deno.test("B-2 之後沒有任何程式或 migration 再提 policies.source_url／tracking_logs.source_url／policy_sources（程式碼；註解可以提）", async () => {
  const hits: string[] = [];
  async function* walk(dir: URL, prefix: string): AsyncGenerator<{ rel: string; url: URL }> {
    for await (const e of Deno.readDir(dir)) {
      const rel = prefix + e.name;
      if (e.isDirectory) { if (e.name !== "node_modules" && !e.name.startsWith(".")) yield* walk(new URL(e.name + "/", dir), rel + "/"); }
      else if (rel.endsWith(".ts") && !rel.endsWith(".test.ts")) yield { rel, url: new URL(e.name, dir) };
    }
  }
  for await (const f of walk(new URL("../", import.meta.url), "")) {
    const text = (await Deno.readTextFile(f.url)).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    if (/from\(\s*["']policy_sources["']\s*\)/.test(text)) hits.push(`${f.rel}: policy_sources`);
  }
  // 比 B-2 新的 migration 不能再碰舊欄位與舊表
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (e.name.slice(0, 14) <= "20261007120000") continue;
    const t = code(await read(`../../migrations/${e.name}`));
    if (/\b(pl|p|policies|tracking_logs|tl)\.source_url\b|policy_sources/.test(t)) hits.push(`${e.name}: 又提到舊欄位或舊表`);
  }
  assertEquals(hits, []);
});
