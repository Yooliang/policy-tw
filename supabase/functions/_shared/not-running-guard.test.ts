/**
 * 「他沒有登記」是否定的斷言，要有出處才寫得進去。
 *
 * 2026-09-21 實測線上 2026 這一屆：
 *   registered   281 筆帶網址、3 筆沒有
 *   not_running  102 筆，**全部沒有網址**；其中 76 筆的 source_note 還寫著
 *                「可能再次挑戰」「可能被徵召」這種推測語氣——推測被寫成了結論
 *   這 102 筆 verified 全 false（沒有一筆被驗證過），影響 26 人、94 筆政見
 *
 * 代價不對稱是這條規則的根據：標成 not_running 會讓人不進選舉頁、不算已收錄人員、
 * 全站搜尋不算正在參選，四種任務也不再派；標錯 registered 只是多列一個人，名單清查會抓到。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardWithdrawn, upsertParticipation } from "./candidate-import.ts";

// #345：不收傳聞。以前沒有出處網址的 not_running 降成 rumored；現在傳聞沒有對應值，改成「不動狀態」：
// 既有的紀錄維持原狀態、只在註記寫明，新增的不建（回 skipped）。

Deno.test("沒有出處網址的 withdrawn 不動狀態，並寫明為什麼", () => {
  const out = guardWithdrawn("withdrawn", "AI搜尋匯入: 曾任立法委員，可能再次挑戰");
  assertEquals(out.candidacy_status, null, "「可能再次挑戰」是推測，不是「他沒登記」這個結論；也不降成傳聞（不收）");
  assertEquals(out.downgraded, true);
  assert(String(out.source_note).includes("未附出處網址"), "沒改要留下理由，否則後面的人看不出發生過什麼");
  assert(String(out.source_note).includes("AI搜尋匯入"), "原本的註記要保留");
});

Deno.test("完全沒有註記的 withdrawn 一樣不動", () => {
  const out = guardWithdrawn("withdrawn", null);
  assertEquals(out.candidacy_status, null);
  assert(String(out.source_note).includes("未附出處網址"));
});

Deno.test("帶了出處網址的 withdrawn 照寫（代理查過名單的那條路）", () => {
  // 代理交 candidacy 時 schema 強制要 source_urls，落庫時 source_note 會帶上網址
  const note = "貢獻者：a-zhen（https://www.cec.gov.tw/candidate/list）";
  const out = guardWithdrawn("withdrawn", note);
  assertEquals(out.candidacy_status, "withdrawn");
  assertEquals(out.downgraded, false);
  assertEquals(out.source_note, note, "沒擋就不要動註記");
});

Deno.test("其他狀態一律不碰", () => {
  for (const status of ["filed", "declared", "considering", "elected", "not_elected", null, undefined] as const) {
    const out = guardWithdrawn(status, "沒有網址的註記");
    assertEquals(out.candidacy_status, status, `${status} 不該被這道守門改動`);
    assertEquals(out.downgraded, false);
    assertEquals(out.source_note, "沒有網址的註記");
  }
});

Deno.test("這道守門要真的接在唯一的寫入點上", async () => {
  // 規則寫成純函式沒有用，要接在 upsertParticipation 上——所有參選紀錄都從那裡寫進去
  // （匯入、AI 管線、代理的 candidacy 貢獻都是）。
  const src = await Deno.readTextFile(new URL("./candidate-import.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function upsertParticipation"));
  const guardAt = fn.indexOf("guardWithdrawn(");
  const insertAt = fn.indexOf(".insert(");
  const updateAt = fn.indexOf(".update(");
  assert(guardAt > 0, "upsertParticipation 沒有呼叫 guardWithdrawn");
  assert(guardAt < insertAt && guardAt < updateAt, "守門要在寫入之前跑");
});

// ── 不收傳聞：匯入端點不再寫 rumored ──────────────────────────────────
function fakeDb(existing: Record<string, unknown> | null) {
  const writes: Array<{ op: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (_t: string) => ({
      select: (_c: string) => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }) }) }),
      update: (patch: Record<string, unknown>) => { writes.push({ op: "update", row: patch }); return { eq: async () => ({ error: null }) }; },
      insert: (row: Record<string, unknown>) => { writes.push({ op: "insert", row }); return { select: () => ({ maybeSingle: async () => ({ data: { id: 1 }, error: null }) }) }; },
    }),
  };
  return { db, writes };
}
const BASE = { politician_id: "p", election_id: 2026, election_type: "縣市長", position: "縣市長候選人", source_note: "AI(x)" };

Deno.test("新增時沒有狀態可寫（傳聞、沒寫、沒出處的不參選）→ 不建這筆，回 skipped 並講理由", async () => {
  for (const candidacy_status of [undefined, null, "withdrawn"] as const) {
    const { db, writes } = fakeDb(null);
    const r = await upsertParticipation(db as never, { ...BASE, candidacy_status });
    assertEquals(r.outcome, "skipped", String(candidacy_status));
    assertEquals(r.id, null);
    assertEquals(writes.length, 0, "一筆都不能寫");
    assert(String(r.reason).length > 0);
  }
});

Deno.test("新增時有狀態才建，而且只寫 candidacy_status、不寫舊欄位、也不再預設 rumored", async () => {
  const { db, writes } = fakeDb(null);
  const r = await upsertParticipation(db as never, { ...BASE, candidacy_status: "considering" });
  assertEquals(r.outcome, "created");
  assertEquals(writes[0].row.candidacy_status, "considering");
  assert(!("candidate_status" in writes[0].row) && !("election_result" in writes[0].row), "舊兩欄由觸發器同步，寫入端不碰");
});

Deno.test("既有紀錄遇到沒有狀態可寫：只更新註記、狀態不動", async () => {
  const { db, writes } = fakeDb({ id: 7, candidacy_status: "filed", election_type: "縣市長" });
  const r = await upsertParticipation(db as never, { ...BASE, candidacy_status: null });
  assertEquals(r.outcome, "updated");
  assert(!("candidacy_status" in writes[0].row), "狀態不動");
});

Deno.test("結果比登記階段大：已經有結果的紀錄，匯入端給登記階段的狀態不覆蓋", async () => {
  const { db, writes } = fakeDb({ id: 7, candidacy_status: "elected", election_type: "縣市長" });
  await upsertParticipation(db as never, { ...BASE, candidacy_status: "filed" });
  assert(!("candidacy_status" in writes[0].row), "當選不能被「已登記」蓋回去（舊兩欄也是：只改 candidate_status 不動 election_result）");
  const second = fakeDb({ id: 8, candidacy_status: "filed", election_type: "縣市長" });
  await upsertParticipation(second.db as never, { ...BASE, candidacy_status: "elected" });
  assertEquals(second.writes[0].row.candidacy_status, "elected", "給的是結果就照寫");
});
