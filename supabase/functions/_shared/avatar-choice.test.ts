/**
 * 照片二選一（avatar_choice，維護者 2026-10-11，policy-ops#89）的守門測試。
 *   1. 落庫：已經有照片、交的是另一張 → 不覆蓋、開一件任務、回覆寫明；同一張不重開；沒照片照舊補上；同一張不開
 *   2. 派工現況：兩張照片都給、現有的讀人物表現值、骨架兩條路（correction／no_change）
 *   3. 挑選標準：維護者點名的缺點都寫進做法與協議
 *   4. 補開的 migration 只新增任務、不改正式資料，條件跟落庫程式同一套
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { readSkillWithTypes } from "./skill-text.ts";
import { applyContribution } from "./apply-contribution.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { AVATAR_CHOICE_CRITERIA, AVATAR_CHOICE_TASK_TYPE } from "./avatar-choice.ts";
import { shapeTaskCurrent } from "./task-context.ts";
import { TASK_BRANCHES, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { TASK_TYPES } from "./contribution-schema.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const PID = "c37f07b3-00b4-4b94-8442-c9018886a9ac";
const OLD = "https://pgw.udn.com.tw/gw/photo.php?u=bulletin.jpg";
const NEW = "https://p.udn.com.tw/upf/news/2026/candidatephoto/b65.jpg";

function row(avatar: string, id = "35b90b27-9f0e-48fb-abe5-f7069684665b") {
  return {
    id, contribution_type: "politician", status: "verified", agent_name: "a-zhen", contributor_ip_hash: "ip",
    contributor_url: null, note: null, retry_count: 0, source_urls: ["https://udn.com/vote2026/local_chiefs?city=tainan"],
    task_id: `auto:profile_gap:${PID}`,
    payload: { name: "蕭燐洪", politician_id: PID, avatar_url: avatar },
  };
}

/** 照片形狀守門會去抓圖；測試裡讓網路「出錯」＝不擋（avatar-check.ts：網路錯誤不記在代理頭上） */
async function withoutNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const seed = (avatar: string | null) => ({
  politicians: [{ id: PID, name: "蕭燐洪", party: "台灣SoR無法黨", region: "台南市", position: "縣市長候選人", avatar_url: avatar, birth_year: 1943 }],
  politician_keys: [],
  contribution_tasks: [] as Record<string, unknown>[],
});

// ── 1. 落庫 ──────────────────────────────────────────────────────────────────

Deno.test("已經有照片、交的是另一張：不覆蓋、開一件二選一任務、回覆寫明（不再只回「無空欄位可補」）", async () => {
  const fake = createFakeSupabase(seed(OLD));
  // deno-lint-ignore no-explicit-any
  const out = await withoutNetwork(() => applyContribution(fake.client, row(NEW) as any));
  assertEquals(out.status, "applied", JSON.stringify(out));
  assertStringIncludes(out.message ?? "", "照片二選一");
  assertEquals(fake.db.politicians[0].avatar_url, OLD, "照片不能被直接覆蓋");
  const tasks = fake.db.contribution_tasks.filter((t) => t.task_type === AVATAR_CHOICE_TASK_TYPE);
  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].target, { politician_id: PID, name: "蕭燐洪", current_avatar_url: OLD, new_avatar_url: NEW, contribution_id: "35b90b27-9f0e-48fb-abe5-f7069684665b" });
  assertEquals(tasks[0].status, "open");
  assertEquals(tasks[0].region, "台南市");
  assertStringIncludes(String(tasks[0].description), "黑白照");
});

Deno.test("同一位、同一張新照片只開一次（任務關了也不重開）", async () => {
  const s = seed(OLD);
  s.contribution_tasks.push({ id: "t1", task_type: AVATAR_CHOICE_TASK_TYPE, status: "closed", target: { politician_id: PID, new_avatar_url: NEW } });
  const fake = createFakeSupabase(s);
  // deno-lint-ignore no-explicit-any
  const out = await withoutNetwork(() => applyContribution(fake.client, row(NEW, "11111111-1111-4111-8111-111111111111") as any));
  assertEquals(out.status, "applied");
  assertStringIncludes(out.message ?? "", "已經開過");
  assertEquals(fake.db.contribution_tasks.length, 1);
});

Deno.test("沒有照片照舊補上、不開任務；交的跟現有同一張也不開", async () => {
  const empty = createFakeSupabase(seed(null));
  // deno-lint-ignore no-explicit-any
  const a = await withoutNetwork(() => applyContribution(empty.client, row(NEW) as any));
  assertStringIncludes(a.message ?? "", "avatar_url");
  assertEquals(empty.db.politicians[0].avatar_url, NEW);
  assertEquals(empty.db.contribution_tasks.length, 0);

  const same = createFakeSupabase(seed(NEW));
  // deno-lint-ignore no-explicit-any
  const b = await withoutNetwork(() => applyContribution(same.client, row(NEW) as any));
  assert(!(b.message ?? "").includes("二選一"), b.message);
  assertEquals(same.db.contribution_tasks.length, 0);
});

Deno.test("新照片是佔位圖不開任務（存進去也會被觸發器清成空值）", async () => {
  const fake = createFakeSupabase(seed(OLD), { is_placeholder_avatar: () => true });
  // deno-lint-ignore no-explicit-any
  const out = await withoutNetwork(() => applyContribution(fake.client, row(NEW) as any));
  assertStringIncludes(out.message ?? "", "佔位圖");
  assertEquals(fake.db.contribution_tasks.length, 0);
});

// ── 2. 派工現況 ──────────────────────────────────────────────────────────────

Deno.test("派工現況：兩張照片都給、現有的讀人物表現值；骨架 correction 的 current_value 也用現值", () => {
  const target = { politician_id: PID, name: "蕭燐洪", current_avatar_url: OLD, new_avatar_url: NEW, contribution_id: "c1" };
  const swapped = "https://example.gov.tw/later.jpg";
  const cur = shapeTaskCurrent(AVATAR_CHOICE_TASK_TYPE, { politician: { id: PID, name: "蕭燐洪", avatar_url: swapped } }, { task_id: "t1", target }) as Record<string, unknown>;
  const cands = cur.candidates as Array<Record<string, unknown>>;
  assertEquals(cands.map((c) => [c.which, c.url]), [["current", swapped], ["new", NEW]]);
  assertStringIncludes(String(cur.candidates_note), "換過");
  assertStringIncludes(String(cur.hint), "側臉");
  const tpl = cur.report_template as Record<string, Record<string, unknown>>;
  assertEquals(tpl.payload.target_table, "politicians");
  assertEquals(tpl.payload.target_id, PID);
  assertEquals(tpl.payload.changes, [{ field: "avatar_url", current_value: swapped, correct_value: NEW }]);
  const branches = cur.report_templates_by_type as Record<string, unknown>;
  assert("correction" in branches && "no_change" in branches);
  // 已經換成新的那張：叫代理回 no_change
  const done = shapeTaskCurrent(AVATAR_CHOICE_TASK_TYPE, { politician: { id: PID, avatar_url: NEW } }, { task_id: "t1", target }) as Record<string, unknown>;
  assertStringIncludes(String(done.candidates_note), "no_change");
});

Deno.test("型別登記：任務型別清單、建議貢獻型別、分支都有", () => {
  assert((TASK_TYPES as readonly string[]).includes(AVATAR_CHOICE_TASK_TYPE));
  assertEquals(SUGGESTED_TYPE[AVATAR_CHOICE_TASK_TYPE], "correction");
  assertEquals(TASK_BRANCHES[AVATAR_CHOICE_TASK_TYPE], ["correction", "no_change"]);
});

// ── 3. 挑選標準 ──────────────────────────────────────────────────────────────

Deno.test("挑選標準：維護者點名的缺點寫進做法與協議（1.91.0 起）", async () => {
  for (const s of ["背影", "側臉", "黑白照", "截圖裡裁出來", "多個人物", "夾著文字", "模糊", "缺點少的"]) {
    assertStringIncludes(AVATAR_CHOICE_CRITERIA, s);
  }
  assertStringIncludes(TASK_GUIDANCE[AVATAR_CHOICE_TASK_TYPE], AVATAR_CHOICE_CRITERIA);
  const [major, minor] = PROTOCOL_VERSION.split(".").map(Number);
  assert(major > 1 || (major === 1 && minor >= 91), `協議版號 ${PROTOCOL_VERSION} 比 1.91.0 舊`);
  const md = (await readSkillWithTypes()).replace(/\r/g, "");
  for (const s of ["`avatar_choice`", "黑白照", "側臉", "**照片例外**"]) assertStringIncludes(md, s);
});

// ── 4. 補開的 migration ──────────────────────────────────────────────────────

Deno.test("補開的 migration 只新增任務、不改正式資料；條件跟落庫程式同一套", async () => {
  const sql = (await Deno.readTextFile(new URL("../../migrations/20261011050000_avatar_choice_backfill.sql", import.meta.url))).replace(/\r/g, "");
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assert(/INSERT\s+INTO\s+contribution_tasks/i.test(code));
  for (const bad of [/UPDATE\s/i, /DELETE\s/i, /DROP\s/i, /ALTER\s/i]) assert(!bad.test(code), `migration 有 ${bad}`);
  for (const s of ["'avatar_choice'", "is_placeholder_avatar", "照片沒套用", "new_avatar_url", "current_avatar_url", "contribution_id", "NOT EXISTS"]) {
    assertStringIncludes(code, s);
  }
  // 任務說明的挑選標準跟程式是同一句（SQL 裡是字串串接，去掉串接再比）
  const flat = code.replace(/'\s*\|\|\s*'/g, "");
  assertStringIncludes(flat, AVATAR_CHOICE_CRITERIA);
});
