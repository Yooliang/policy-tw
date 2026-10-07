/**
 * #345 第二階段 A：讀取端與寫入端只認新欄位的守門。
 *
 * 舊的 candidate_status／election_result 兩欄這一階段還在（觸發器兩邊同步，第二階段 B 才刪），
 * 所以「誰還在讀、誰還在寫」只能靠掃原始碼擋：任何一處回頭讀舊欄位，B 刪欄時就會炸，而測試全綠。
 * 每一條都做過還原驗證（見 PR 說明）：拿掉被守的東西，對應那條要轉紅。
 *
 * 不算讀舊欄位的：交件協議的欄位名（payload 的 candidate_status／election_result、任務類型 candidate_status_stale、
 * election_result_missing 這些名字）——那是交件的介面，不是資料庫欄位；這裡只擋「資料庫欄位」的讀寫。
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const FUNCTIONS = new URL("../", import.meta.url);
const REPO = new URL("../../../", import.meta.url);
const MIGRATION = (await Deno.readTextFile(new URL("../../migrations/20261006220000_candidacy_read_side.sql", import.meta.url))).replaceAll("\r\n", "\n");
/** 去掉 SQL 註解 */
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const sql = code(MIGRATION);

async function* walk(dir: URL, prefix: string, skip: (rel: string, isDir: boolean) => boolean): AsyncGenerator<{ rel: string; url: URL }> {
  for await (const e of Deno.readDir(dir)) {
    const rel = prefix + e.name;
    if (skip(rel, e.isDirectory)) continue;
    if (e.isDirectory) yield* walk(new URL(e.name + "/", dir), rel + "/", skip);
    else yield { rel, url: new URL(e.name, dir) };
  }
}

// ── Edge Function：不讀、不寫舊兩欄 ────────────────────────────────

Deno.test("Edge Function 的查詢不再選／篩舊欄位 candidate_status、election_result（讀取端只認 candidacy_status）", async () => {
  const hits: string[] = [];
  let scanned = 0;
  for await (const f of walk(FUNCTIONS, "", (rel, dir) => dir ? rel === "node_modules" || rel.startsWith(".") : !rel.endsWith(".ts") || rel.endsWith(".test.ts"))) {
    scanned++;
    const text = await Deno.readTextFile(f.url);
    // .select("…candidate_status…")（含多行的 template 字串）、.eq/.neq/.in/.is/.or 的欄位條件
    for (const m of text.matchAll(/\.select\(\s*[`"']([^`"']*)[`"']/g)) {
      if (/\b(candidate_status|election_result)\b/.test(m[1])) hits.push(`${f.rel}: select(${m[1].replace(/\s+/g, " ").slice(0, 80)})`);
    }
    for (const m of text.matchAll(/\.(eq|neq|in|is|or|not|order)\(\s*[`"']([^`"']*)[`"']/g)) {
      if (/\b(candidate_status|election_result)\b/.test(m[2])) hits.push(`${f.rel}: ${m[1]}(${m[2].slice(0, 80)})`);
    }
  }
  assert(scanned > 100, `只掃到 ${scanned} 支檔案，路徑可能錯了`);
  assertEquals(hits, [], "這些查詢還在讀舊欄位（#345 第二階段 B 刪欄會炸）");
});

Deno.test("寫入端只寫 candidacy_status：upsertParticipation／落庫不再帶 candidate_status、election_result 當欄位", async () => {
  const files = ["candidate-import.ts", "apply-contribution.ts", "election-results.ts"];
  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, import.meta.url));
    // 寫進 politician_elections 的 update／insert 物件裡不能有舊欄位 key
    for (const m of text.matchAll(/\.(update|insert)\(\s*\{([^}]*)\}/g)) {
      assertEquals(/\b(candidate_status|election_result)\s*:/.test(m[2]), false, `${name} 的 ${m[1]}({…}) 還在寫舊欄位：${m[2].slice(0, 100)}`);
    }
  }
  const imp = await Deno.readTextFile(new URL("candidate-import.ts", import.meta.url));
  assertEquals(imp.includes('"rumored"'), false, "匯入端不再預設寫傳聞（rumored）");
});

// ── migration：函式與視圖不再讀舊兩欄；任期觸發器聽新欄位；職稱改讀任期表 ─────────

Deno.test("migration 重定義的函式與視圖不再讀 politician_elections 的舊欄位", () => {
  // x.candidate_status／x.election_result 是派工臂與比對函式 CTE 裡的別名（協議的詞、由新欄位換算的結果），不是資料庫欄位
  const hits = [...sql.matchAll(/\b(pe2?|q|o|k|r|NEW|OLD)\.(candidate_status|election_result)\b/g)].map((m) => m[0]);
  // 唯一的例外：人物視圖 elections[] 還帶舊的 candidateStatus／electionResult 兩鍵給還沒更新的舊前端（第二階段 B 拿掉）
  assertEquals(hits, ["pe.candidate_status", "pe.election_result"], "除了人物視圖那兩個舊鍵，還有地方讀舊欄位");
  assertMatch(sql, /'candidateStatus', pe\.candidate_status, 'electionResult', pe\.election_result/);
  assertEquals(/\b(votes_received|vote_percentage)\b/.test(sql.replace(/pe\.votes_received|pe\.vote_percentage/g, "")), false, "票數欄位待刪，不再碰（elected_politicians 視圖輸出欄位除外）");
});

Deno.test("派工臂的 candidate_status 別名一律由 candidacy_protocol_status 換算，不是舊欄位", () => {
  const calls = [...sql.matchAll(/candidacy_protocol_status\(pe\.candidacy_status, candidacy_list_published\(pe\.election_id, pe\.election_type, CURRENT_DATE\)\)/g)];
  assert(calls.length >= 7, `只找到 ${calls.length} 處換算（party_gap／party_roster／raw／region_gap／township_gap／withdrawn_filing／latest_election 至少 7 處）`);
});

Deno.test("任期觸發器：聽 candidacy_status（新寫入端只寫它）也聽 election_result（過渡期還有舊寫入端）；函式看 candidacy_status", () => {
  const trg = sql.slice(sql.indexOf("CREATE TRIGGER trg_sync_politician_office"));
  const cols = trg.slice(0, trg.indexOf("ON politician_elections"));
  // PostgreSQL 的 AFTER UPDATE OF 欄位清單只看 UPDATE 語句自己寫了哪些欄位，不看 BEFORE 觸發器順手改的（PGlite 實測）：
  // 新寫入端只寫 candidacy_status，清單裡沒有它，標當選就建不出任期
  assertMatch(cols, /UPDATE OF candidacy_status,/);
  assertMatch(cols, /election_result/);
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION sync_politician_office_from_election"), sql.indexOf("DROP TRIGGER IF EXISTS trg_sync_politician_office"));
  assertMatch(fn, /IF NEW\.candidacy_status = 'elected' THEN/);
  assertMatch(fn, /NEW\.candidacy_status = 'not_elected' OR o\.basis = 'election_result'/);
});

Deno.test("人物視圖的職稱（offices）讀任期表：現任＝已就任而且卸任日為空；明寫 #345 第二階段：職稱改讀任期表", () => {
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW politicians_with_elections"), sql.indexOf("ALTER VIEW politicians_with_elections"));
  assertMatch(view, /FROM \(politician_offices o\s+LEFT JOIN regions orr ON \(\(orr\.id = o\.region_id\)\)\)/);
  assertMatch(view, /o\.end_date IS NULL\) AND \(o\.start_date <= CURRENT_DATE/);
  assertEquals(view.includes("politician_offices_derived"), false, "職稱不再讀舊視圖");
  assert(MIGRATION.includes("#345 第二階段：職稱改讀任期表"), "守門測試（politician-offices-table.test.ts）要求重建人物視圖時明寫這一句");
  // elections[] 照舊帶舊的兩個鍵給舊前端，另帶新鍵（第二階段 B 才拿掉）
  assertMatch(view, /'candidacyStatus', pe\.candidacy_status, 'withdrawnAfterFiling', pe\.withdrawn_after_filing/);
  assertMatch(sql, /ALTER VIEW politicians_with_elections SET \(security_invoker = on\)/);
});

Deno.test("核對：任期表現任的職稱跟舊視圖逐人一致，對不上整支退回", () => {
  assertMatch(MIGRATION, /FROM politician_offices_derived d\s+WHERE d\.election_id = \(SELECT max\(d2\.election_id\)/);
  assertMatch(MIGRATION, /IF v_missing > 0 OR v_extra > 0 THEN\s+RAISE EXCEPTION/);
});

Deno.test("merge_politician：結果補空欄、登記階段不互相覆蓋、補空欄不再用 $1.欄位（匿名 RECORD 讀不到欄位）", () => {
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION merge_politician"), sql.indexOf("CREATE OR REPLACE FUNCTION politician_latest_election"));
  assertMatch(fn, /IF r\.candidacy_status IN \('elected', 'not_elected'\)\s+AND COALESCE\(k\.candidacy_status, ''\) NOT IN \('elected', 'not_elected'\) THEN/);
  assertEquals(/ARRAY\['position', 'slogan', 'election_type', 'region_id', 'source_note'\]/.test(fn), true, "補空欄清單不含舊的 election_result 與票數");
  assertEquals(fn.includes("USING r, k.id"), false);
});

// ── 前端：不讀舊欄位 ───────────────────────────────────────────

Deno.test("前端不讀舊欄位：型別、欄位名、查詢都只用 candidacyStatus／candidacy_status", async () => {
  const ALLOW = new Set([
    "lib/task-labels.ts", "lib/model-quality.ts", "pages/Queue.vue", "pages/Contributions.vue", // 任務類型與貢獻類型的名字（election_result_missing 等）
    "components/history/HistoryEntryDetail.vue", // 舊查核履歷的欄位名要留著能顯示
  ]);
  const hits: string[] = [];
  let scanned = 0;
  for (const dir of ["lib", "pages", "components", "composables", "router", "cloudflare"]) {
    for await (const f of walk(new URL(dir + "/", REPO), dir + "/", (rel, isDir) => isDir ? rel.endsWith("node_modules") : !/\.(ts|vue)$/.test(rel) || rel.endsWith(".test.ts"))) {
      scanned++;
      if (ALLOW.has(f.rel)) continue;
      const lines = (await Deno.readTextFile(f.url)).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\*)/.test(line)) return; // 區塊註解
        const c = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (/\b(candidateStatus|electionResult|candidate_status|election_result)\b/.test(c)) hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert(scanned > 80, `只掃到 ${scanned} 支檔案`);
  assertEquals(hits, [], "前端還在讀舊欄位／舊鍵（#345 第二階段 A：畫面只認 candidacy_status）");
  const types = await Deno.readTextFile(new URL("types.ts", REPO));
  assertEquals(/CandidateStatus\b/.test(types), false, "types.ts 不再有八值的 CandidateStatus");
});
