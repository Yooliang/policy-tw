/**
 * #345 第二階段 B：刪舊的參選狀態欄位（migration 20261007140000）的守門。
 *
 * 這支守的是「刪得乾淨、而且不多刪」：
 *   - 四個舊欄位、同步觸發器與函式都刪了；任期觸發器的欄位清單不再提到已刪的欄位
 *   - **退選旗標 withdrawn_after_filing 的維護沒有跟著 sync_candidacy_status 一起消失**（它兼管這件事，第二階段 A 的清單漏了）
 *   - 票數先備份、再刪；視圖與授權補回；結尾自檢在
 *   - politician_offices_derived／politician_offices_gap 留著（2026 投票後的任期缺口監測，結果補齊才刪）
 *   - 還原履歷（edit_history）碰到已刪欄位會整筆擋下，不會半套還原
 * 每一條都做過還原驗證（見 PR 說明）：拿掉被守的東西，對應那條要轉紅。
 * SQL 本身另外在 PGlite 實跑（見 PR 說明），這裡沒有資料庫。
 */
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { DROPPED_COLUMNS, executeRevert, planRevert, RevertBlockedError } from "./edit-history.ts";

const read = async (rel: string) => (await Deno.readTextFile(new URL(rel, import.meta.url))).replaceAll("\r\n", "\n");
const MIGRATION = await read("../../migrations/20261007140000_candidacy_drop_legacy.sql");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = code(MIGRATION);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const OLD = ["candidate_status", "election_result", "votes_received", "vote_percentage"];

Deno.test("刪欄位：四個舊欄位都在 DROP COLUMN 裡，而且是 politician_elections 的", () => {
  const m = sql.match(/ALTER TABLE politician_elections\s+([^;]*);/);
  assert(m, "找不到 ALTER TABLE politician_elections … DROP COLUMN");
  for (const c of OLD) assertMatch(m![1], new RegExp(`DROP COLUMN ${c}\\b`), `要刪 ${c}`);
  assertEquals((m![1].match(/DROP COLUMN/g) ?? []).length, 4, "只刪這四欄，不多刪（candidacy_status、withdrawn_after_filing、cand_no、party_id 都要留）");
});

Deno.test("交易包住、結尾有自檢（對不上整支退回）", () => {
  assert(/^BEGIN;$/m.test(sql) && /^COMMIT;$/m.test(sql), "要用交易包住");
  for (const msg of ["這些欄位還在", "筆數變了", "內容變了", "票數備份少了", "授權沒補回來", "security_invoker 沒補回來", "退選旗標觸發器不在", "任期觸發器的欄位清單不對"]) {
    assert(sql.includes(msg), `自檢少了「${msg}」`);
  }
  assert(sql.indexOf("DROP COLUMN candidate_status") < sql.lastIndexOf("RAISE EXCEPTION"), "自檢在刪欄位之後");
});

Deno.test("票數先備份、再刪欄位", () => {
  const archive = sql.indexOf("INSERT INTO politician_election_votes_archive (");
  const check = sql.indexOf("票數備份少了");
  const drop = sql.indexOf("DROP COLUMN votes_received");
  assert(archive > 0 && check > archive && drop > check, "順序要是：備份 → 核對備份筆數 → 刪欄位");
  assertMatch(sql, /ENABLE ROW LEVEL SECURITY/, "新表要開 RLS（所有表開 RLS、公開讀）");
});

Deno.test("同步觸發器與函式都刪了", () => {
  assertMatch(sql, /DROP TRIGGER IF EXISTS trg_sync_candidacy_status ON politician_elections;/);
  assertMatch(sql, /DROP FUNCTION IF EXISTS sync_candidacy_status\(\);/);
  assertMatch(sql, /DROP FUNCTION IF EXISTS legacy_status_from_candidacy\(TEXT, TEXT, TEXT, BOOLEAN\);/);
  assertMatch(sql, /DROP FUNCTION IF EXISTS candidacy_status_from_legacy\(TEXT, TEXT, BOOLEAN\);/);
});

Deno.test("任期觸發器的欄位清單：拿掉 election_result、留著 candidacy_status", () => {
  const m = sql.match(/CREATE TRIGGER trg_sync_politician_office\s+AFTER INSERT OR UPDATE OF ([^)]*?) ON politician_elections/);
  assert(m, "找不到任期觸發器的重建");
  const cols = m![1].split(",").map((c) => c.trim());
  assertEquals(cols.includes("election_result"), false);
  for (const c of ["candidacy_status", "election_type", "region_id", "politician_id", "election_id"]) assert(cols.includes(c), `欄位清單要有 ${c}`);
  assert(sql.indexOf("DROP TRIGGER IF EXISTS trg_sync_politician_office") < sql.indexOf("CREATE TRIGGER trg_sync_politician_office"), "先刪舊的再建");
  assert(sql.indexOf("CREATE TRIGGER trg_sync_politician_office") < sql.indexOf("DROP COLUMN candidate_status"), "欄位清單要在刪欄位之前改好（DROP COLUMN 會被觸發器的依賴擋住）");
});

Deno.test("退選旗標：從 sync_candidacy_status 原樣搬出來，觸發器先建好再刪舊的", async () => {
  // 舊函式（20261006060000 最後一次定義）的退選那一段
  const old = await read("../../migrations/20261006060000_candidacy_followups.sql");
  const oldFn = old.slice(old.indexOf("CREATE OR REPLACE FUNCTION sync_candidacy_status()"));
  const oldPart = oldFn.slice(oldFn.indexOf("IF NEW.candidacy_status = 'withdrawn' THEN"), oldFn.indexOf("RETURN NEW;"));
  const newFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION politician_elections_withdrawn_flag()"));
  const newPart = newFn.slice(newFn.indexOf("IF NEW.candidacy_status = 'withdrawn' THEN"), newFn.indexOf("RETURN NEW;"));
  assert(norm(code(oldPart)).length > 100, "舊函式的退選那一段沒抓到");
  assertEquals(norm(newPart), norm(code(oldPart)), "退選旗標的邏輯要跟舊函式一字不差（搬家，不改行為）");
  assertMatch(sql, /CREATE TRIGGER trg_politician_elections_withdrawn_flag\s+BEFORE INSERT OR UPDATE OF candidacy_status ON politician_elections/);
  assert(sql.indexOf("CREATE TRIGGER trg_politician_elections_withdrawn_flag") < sql.indexOf("DROP TRIGGER IF EXISTS trg_sync_candidacy_status"), "先建新的再刪舊的，沒有空窗");
});

Deno.test("politician_latest_election：輸出欄改成 candidacy_status、不再讀舊欄位，授權補回", () => {
  const fn = sql.slice(sql.indexOf("DROP FUNCTION IF EXISTS politician_latest_election"));
  const body = fn.slice(0, fn.indexOf("GRANT EXECUTE ON FUNCTION politician_latest_election") + 120);
  assertMatch(body, /RETURNS TABLE\(election_id INTEGER, candidacy_status TEXT,/);
  assertMatch(body, /GRANT EXECUTE ON FUNCTION politician_latest_election\(UUID\) TO anon, authenticated, service_role/);
  assertEquals(OLD.some((c) => new RegExp(`\\bpe\\.${c}\\b`).test(body)), false);
});

Deno.test("視圖：人物視圖不再帶舊的兩個鍵、elected_politicians 沒有票數欄、授權與 security_invoker 補回", () => {
  const pwe = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW politicians_with_elections"), sql.indexOf("ALTER VIEW politicians_with_elections"));
  assertEquals(/candidateStatus|electionResult|pe\.candidate_status|pe\.election_result/.test(pwe), false);
  assertMatch(pwe, /'candidacyStatus', pe\.candidacy_status, 'withdrawnAfterFiling', pe\.withdrawn_after_filing/);
  assertMatch(sql, /ALTER VIEW politicians_with_elections SET \(security_invoker = on\)/);
  assert(MIGRATION.includes("#345 第二階段：職稱改讀任期表"), "重建人物視圖要註明職稱讀任期表（politician-offices-table.test.ts 守門）");
  const ep = sql.slice(sql.indexOf("CREATE VIEW elected_politicians"), sql.indexOf("ALTER VIEW elected_politicians"));
  assertEquals(/votes_received|vote_percentage/.test(ep), false);
  assertMatch(sql, /DROP VIEW IF EXISTS elected_politicians;/);
  assertMatch(sql, /ALTER VIEW elected_politicians SET \(security_invoker = on\);\s+GRANT SELECT ON elected_politicians TO anon, authenticated, service_role;/);
});

Deno.test("politician_offices_derived 改看 candidacy_status、政策不刪它與 politician_offices_gap（2026 結果補齊前是監測工具）", () => {
  const v = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW politician_offices_derived"), sql.indexOf("ALTER VIEW politician_offices_derived"));
  assertEquals(/election_result\b(?!')/.test(v.replace(/'election_result'/g, "")), false, "舊現任視圖不能再讀 election_result 欄位（'election_result' 字串是 verified_by 的值，不算）");
  assertMatch(v, /pe\.candidacy_status = 'elected'/);
  assertEquals(/DROP VIEW[^;]*politician_offices_(derived|gap)/.test(sql), false, "這兩個視圖留著，結果補齊後另開 PR 刪");
});

Deno.test("沒有別的 migration 在這支之後又碰舊欄位（新增的 migration 不得提到 pe.candidate_status 這類讀寫）", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.name.slice(0, 14) > "20261007140000") names.push(e.name);
  for (const n of names) {
    const t = code(await read(`../../migrations/${n}`));
    assertEquals(/\bpe2?\.(candidate_status|election_result|votes_received|vote_percentage)\b/.test(t), false, `${n} 又讀已刪的欄位`);
  }
});

Deno.test("協議文件：REST 範例與欄位說明不再叫代理讀已刪的欄位（舊欄位 REST 會回錯誤）", async () => {
  const skill = await read("../../../public/skill.md");
  for (const m of skill.matchAll(/politician_elections\?select=([^&`\s]*)/g)) {
    for (const c of OLD) assertEquals(m[1].split(",").includes(c), false, `skill.md 的 REST 範例還在 select ${c}`);
  }
  assertMatch(skill, /1\.70\.0 起舊的 `candidate_status`、`election_result`、`votes_received`、`vote_percentage` 四個欄位已從資料表刪除/);
});

// ── 還原履歷：欄位已刪 ──────────────────────────────────────────

const edit = (id: number, o: Record<string, unknown>) => ({ id, table_name: "politician_elections", record_id: "7", field: "x", old_value: null, new_value: null, contribution_id: "c-1", agent_name: "t", reverted_at: null, ...o });

Deno.test("planRevert：已刪欄位的履歷標成不可還原；其他欄位照常還原", () => {
  assertEquals([...DROPPED_COLUMNS.politician_elections].sort(), [...OLD].sort());
  const steps = planRevert([
    edit(1, { field: "candidate_status", old_value: "confirmed", new_value: "registered" }),
    edit(2, { field: "election_result", old_value: null, new_value: "elected" }),
    edit(3, { field: "votes_received", old_value: 100, new_value: 200 }),
    edit(4, { field: "candidacy_status", old_value: "filed", new_value: "elected" }),
    edit(5, { field: "position", old_value: "a", new_value: "b" }),
  ]);
  const bad = steps.filter((s) => s.op === "unrevertable").map((s) => (s as { field: string }).field).sort();
  assertEquals(bad, ["candidate_status", "election_result", "votes_received"]);
  assertEquals(steps.filter((s) => s.op === "restore").map((s) => (s as { field: string }).field).sort(), ["candidacy_status", "position"]);
  // 別的表的同名欄位不受影響
  const other = planRevert([edit(1, { table_name: "policies", field: "election_result", old_value: "x" })]);
  assertEquals(other.map((s) => s.op), ["restore"]);
});

Deno.test("planRevert：整列還原（被合併刪掉的參選紀錄）——快照有 candidacy_status 就拿掉已刪欄位再放回去；只有舊欄位的快照不可還原", () => {
  const withNew = planRevert([edit(1, { field: "*", old_value: { id: 7, candidacy_status: "elected", candidate_status: "confirmed", election_result: "elected", votes_received: 5, vote_percentage: 1.5, position: "市長" }, new_value: null })]);
  assertEquals(withNew.length, 1);
  assertEquals(withNew[0].op, "reinsert");
  assertEquals((withNew[0] as { row: Record<string, unknown> }).row, { id: 7, candidacy_status: "elected", position: "市長" });
  const legacyOnly = planRevert([edit(2, { field: "*", old_value: { id: 8, candidate_status: "confirmed", election_result: null }, new_value: null })]);
  assertEquals(legacyOnly.map((s) => s.op), ["unrevertable"]);
  // 新增的列（還原＝刪掉）不受影響
  assertEquals(planRevert([edit(3, { field: "*", old_value: null, new_value: { id: 9, candidate_status: "confirmed" } })]).map((s) => s.op), ["delete"]);
});

Deno.test("executeRevert：有不可還原的變更就整筆不動（不寫任何表、不標 reverted），丟 RevertBlockedError", async () => {
  const writes: string[] = [];
  const history = [
    edit(1, { field: "candidate_status", old_value: "confirmed", new_value: "registered" }),
    edit(2, { field: "position", old_value: "a", new_value: "b" }),
  ];
  const client = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: history, error: null }) }) }),
      update: () => { writes.push(`update ${table}`); return { eq: () => Promise.resolve({ error: null }), in: () => Promise.resolve({ error: null }) }; },
      insert: () => { writes.push(`insert ${table}`); return Promise.resolve({ error: null }); },
      delete: () => { writes.push(`delete ${table}`); return { eq: () => Promise.resolve({ error: null }) }; },
    }),
  };
  const err = await assertRejects(() => executeRevert(client, "c-1", "tester"), RevertBlockedError);
  assertEquals(writes, [], "擋下之前不能寫任何東西");
  assertEquals(err.blocked.map((b) => b.field), ["candidate_status"]);
  assert(err.message.includes("politician_elections#7.candidate_status"));
});

Deno.test("apply 端點把 RevertBlockedError 轉成 409 revert_blocked，不是 500", async () => {
  const src = await read("../apply/index.ts");
  assert(src.includes("RevertBlockedError"));
  assertMatch(src, /instanceof RevertBlockedError\) return json\(\{ success: false, error: "revert_blocked"[^)]*, 409\)/);
});
