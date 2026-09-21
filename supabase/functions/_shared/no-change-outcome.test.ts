/**
 * no_change 的 outcome：只有 confirmed 才可以宣稱「核對過」。
 *
 * 為什麼這件事值得一支專門的測試：蓋章是不可逆的。
 * legacy_audit 的派工條件是「沒有 audit 履歷」，policy_dupe_reviews 是「這份清單查過了」——
 * 兩者一旦寫下去，那筆政見／那份清單就永遠不再被派給任何人。
 * 2026-09-21 之前 apply 不看 finding 內容一律蓋章，於是「我打開來源、發現報導根本沒提這筆政見」
 * 跟「我核對過、完全正確」寫進資料庫的結果一模一樣（現場實例：黃秀芳綠能稅那筆）。
 *
 * 舊資料沒有 outcome 欄位，一律當成「不是 confirmed」：不蓋章只是少一次結案，誤蓋是永久的。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyContribution, TASK_UNREACHABLE_COOLDOWN_DAYS } from "./apply-contribution.ts";

const POLICY = "a96cc098-3a4a-455b-ac87-40bc471467f6";
const PID = "98b8b1ff-d085-4597-8384-a02461f773f6";
const URL_A = "https://www.cna.com.tw/news/aipl/example.aspx";

/** 假 supabase：只記下寫了什麼，不做任何事 */
function fakeDb() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const upserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => { inserted.push({ table, row }); return { error: null }; },
      upsert: (row: Record<string, unknown>) => { upserted.push({ table, row }); return { error: null }; },
      select: (_c: string) => ({ eq: (_k: string, id: string) => ({ maybeSingle: async () => ({ data: { id, source_url: URL_A }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: string) => ({ select: () => ({ maybeSingle: async () => ({ data: { id, ...patch }, error: null }) }) }) }),
    }),
  };
  return { db, inserted, upserted };
}

function row(taskId: string, outcome?: string) {
  return {
    id: "c-1", contribution_type: "no_change" as const, source_urls: [URL_A], note: null, agent_name: "tester", contributor_url: null,
    payload: { task_id: taskId, ...(outcome ? { outcome } : {}), checked_urls: [URL_A], finding: "打開來源核對，報導與這筆政見的對應關係已確認。" },
  };
}

Deno.test("legacy_audit：confirmed 才蓋「已核對來源」的章", async () => {
  const { db, inserted } = fakeDb();
  const out = await applyContribution(db, row(`auto:legacy_audit:${POLICY}`, "confirmed"));
  assertEquals(out.status, "applied");
  const stamps = inserted.filter((i) => i.table === "edit_history" && i.row.field === "audit");
  assertEquals(stamps.length, 1, "confirmed 要蓋章，否則這條線等於沒作用");
  assert(String(stamps[0].row.new_value).includes("已核對來源"));
});

Deno.test("legacy_audit：unreachable／not_found 不蓋章，但照樣記冷卻", async () => {
  for (const outcome of ["unreachable", "not_found"]) {
    const { db, inserted } = fakeDb();
    const out = await applyContribution(db, row(`auto:legacy_audit:${POLICY}`, outcome));
    assertEquals(out.status, "applied", `${outcome} 仍然是成功落庫（它是一種成果，不是失敗）`);
    assertEquals(
      inserted.filter((i) => i.table === "edit_history" && i.row.field === "audit").length,
      0,
      `${outcome} 不可以把政見標成已核對——那是「我沒能確認」被寫成「我確認了」`,
    );
    const checks = inserted.filter((i) => i.table === "task_checks");
    assertEquals(checks.length, 1, "防重派的功能要保留");
    assertEquals(checks[0].row.outcome, outcome, "task_checks 要記下是哪一種，冷卻長短靠它分");
  }
});

Deno.test("legacy_audit：舊資料沒有 outcome 一律不蓋章", async () => {
  const { db, inserted } = fakeDb();
  const out = await applyContribution(db, row(`auto:legacy_audit:${POLICY}`));
  assertEquals(out.status, "applied");
  assertEquals(
    inserted.filter((i) => i.table === "edit_history" && i.row.field === "audit").length,
    0,
    "2026-09-21 之前的 194 筆沒有 outcome，不蓋章比誤蓋安全",
  );
  assertEquals(inserted.find((i) => i.table === "task_checks")?.row.outcome, null);
});

Deno.test("legacy_audit：沒確認的回報不可以回 policy_id（那是第二條永久排除）", async () => {
  // 子代理 2026-09-21 掃出來的：呼叫端會把 outcome.policy_id 寫進 contributions.applied_policy_id
  // （apply/index.ts、auto-apply.ts），而 legacy_audit 的第二條排除就是看那個欄位。
  // 所以「不蓋章」還不夠——只要回了 policy_id，那筆政見照樣從任務池永久消失。
  for (const outcome of ["unreachable", "not_found", undefined]) {
    const { db } = fakeDb();
    const out = await applyContribution(db, row(`auto:legacy_audit:${POLICY}`, outcome));
    assertEquals(out.policy_id, undefined, `outcome=${outcome} 回了 policy_id，會被寫進 applied_policy_id 而永久排除這筆政見`);
  }
  // confirmed 本來就要讓它消失（已經蓋章了），帶不帶 policy_id 都不影響結論
  const ok = fakeDb();
  const done = await applyContribution(ok.db, row(`auto:legacy_audit:${POLICY}`, "confirmed"));
  assertEquals(done.policy_id, POLICY);
});

Deno.test("SQL：applied_policy_id 的排除只認新增政見那一種貢獻", async () => {
  // 掃目錄挑最新一支定義這個函式的 migration，不寫死檔名——寫死的話，之後有人再改一次
  // 這支函式，這裡會繼續守著舊檔（而且 2026-09-21 這支才剛因為跟別人撞號而改過編號）。
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let sql = "";
  for (const name of names.reverse()) {
    const text = await Deno.readTextFile(new URL(name, dir));
    if (text.includes("FUNCTION contribution_auto_tasks_legacy(")) { sql = text; break; }
  }
  assert(sql, "沒有任何 migration 定義 contribution_auto_tasks_legacy");
  const fn = sql.slice(sql.lastIndexOf("FUNCTION contribution_auto_tasks_legacy("));
  assert(
    /applied_policy_id = pl\.id AND c\.contribution_type = 'policy'/.test(fn),
    "那條排除的本意是「這筆政見是貢獻建出來的」；不看型別的話，任何 correction／policy_progress 都會讓它永久沉底（線上已有 133 筆落庫的 correction）",
  );
});

Deno.test("duplicate_policy：confirmed 才鎖住那份清單的指紋", async () => {
  const taskId = `auto:duplicate_policy:${PID}:0a1b2c3d`;
  const { db, upserted } = fakeDb();
  const ok = await applyContribution(db, row(taskId, "confirmed"));
  assertEquals(ok.status, "applied");
  assertEquals(upserted.filter((u) => u.table === "policy_dupe_reviews").length, 1);
  assertEquals(upserted[0].row.fingerprint, "0a1b2c3d");

  for (const outcome of ["unreachable", "not_found", undefined]) {
    const f = fakeDb();
    const out = await applyContribution(f.db, row(taskId, outcome));
    assertEquals(out.status, "applied");
    assertEquals(
      f.upserted.filter((u) => u.table === "policy_dupe_reviews").length,
      0,
      `outcome=${outcome} 不可以把清單標成已比對——沒真的逐組看完就鎖住，跟 legacy_audit 的蓋章是同一個病`,
    );
  }
});

Deno.test("not_running_recheck：confirmed 才把那筆參選紀錄標成已核對", async () => {
  // 這個章的代價是三者最大的：標成不參選之後，這個人的政見、基本資料、參選來源、
  // 選舉結果四種缺口同時不再被派。實查 2026 有 102 筆 not_running，而 candidate_status
  // 的修改紀錄只有 4 筆——絕大多數是匯入就那樣、從來沒人對過名單。
  const PE = "44444444-4444-4444-8444-444444444444";
  const taskId = `auto:not_running_recheck:${PE}`;

  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const mk = () => {
    const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
    return {
      inserted,
      db: {
        from: (table: string) => ({
          insert: (row: Record<string, unknown>) => { inserted.push({ table, row }); return { error: null }; },
          update: (patch: Record<string, unknown>) => ({ eq: () => { updates.push({ table, patch }); return { error: null }; } }),
          select: () => ({ eq: (_k: string, id: string) => ({ maybeSingle: async () => ({ data: { id }, error: null }) }) }),
        }),
      },
    };
  };

  const ok = mk();
  const done = await applyContribution(ok.db, row(taskId, "confirmed"));
  assertEquals(done.status, "applied");
  assertEquals(updates.filter((u) => u.table === "politician_elections" && u.patch.verified === true).length, 1);
  // 要留履歷才還原得回來
  const stamps = ok.inserted.filter((i) => i.table === "edit_history" && i.row.field === "verified");
  assertEquals(stamps.length, 1, "沒有履歷就不可還原——這個章關掉的是四種缺口");

  for (const outcome of ["unreachable", "not_found", undefined]) {
    updates.length = 0;
    const f = mk();
    const out = await applyContribution(f.db, row(taskId, outcome));
    assertEquals(out.status, "applied");
    assertEquals(
      updates.filter((u) => u.table === "politician_elections").length,
      0,
      `outcome=${outcome} 不可以把這筆標成已核對——找不到名單不等於他真的沒登記`,
    );
  }
});

Deno.test("unreachable 的回覆要講清楚它會換人再試，不是結案", async () => {
  const { db } = fakeDb();
  const out = await applyContribution(db, row("auto:profile_gap:" + PID, "unreachable"));
  assert(out.message.includes(String(TASK_UNREACHABLE_COOLDOWN_DAYS)), "要告訴代理幾天後會再派");
  assert(!out.message.includes("無異動"), "「拿不到來源」不是「查過、沒有異動」");
});
