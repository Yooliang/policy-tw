// 票數預算的影子模式（2026-09-21）。守的是「加票的理由講得出來」與「判不出來要往嚴格的方向倒」。
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BASE_VOTES,
  computeVoteBudget,
  DIMENSION_THRESHOLD,
  dimensionQuestions,
  MAX_EXTRA_VOTES,
  TYPE_FLOOR,
  VOTE_DIMENSIONS,
} from "./vote-budget.ts";
import { CONTRIBUTION_TYPES } from "./contribution-schema.ts";
import { QUESTIONS } from "./system-one.ts";

const ans = (m: Record<string, [string, number]>) =>
  Object.fromEntries(Object.entries(m).map(([k, [choice, p]]) => [k, { choice, probabilities: { [choice]: p } }]));

Deno.test("每一種會被提交的貢獻型別都要有風險維度", () => {
  for (const t of CONTRIBUTION_TYPES) {
    const dims = VOTE_DIMENSIONS[t];
    assert(dims && dims.length > 0, `${t} 沒有定義風險維度——沒有維度就算不出票數預算`);
  }
});

Deno.test("維度之間不重複，而且命中與未命中的選項名不同", () => {
  for (const [t, dims] of Object.entries(VOTE_DIMENSIONS)) {
    const keys = new Set(dims.map((d) => d.key));
    assertEquals(keys.size, dims.length, `${t} 有重複的維度 key`);
    for (const d of dims) {
      assert(d.hit.key !== d.miss.key, `${t}.${d.key} 的兩個選項同名`);
      assert(d.hit.means !== d.miss.means, `${t}.${d.key} 的兩個選項說明一樣——那一維問不出東西`);
      assert(d.instructions.length >= 15, `${t}.${d.key} 的問題太短，Jev 判不準`);
      assert(d.hit.means.length >= 5 && d.miss.means.length >= 5, `${t}.${d.key} 的選項說明太短`);
    }
  }
});

Deno.test("組給 Jev 的 questions 形狀正確：一維一題、兩個選項", () => {
  const qs = dimensionQuestions("policy");
  assertEquals(Object.keys(qs).length, VOTE_DIMENSIONS.policy.length);
  for (const q of Object.values(qs)) {
    assertEquals(q.type, "choice");
    assertEquals(Object.keys(q.criteria).length, 2, "是非題只能有兩個選項");
  }
  assertEquals(Object.keys(dimensionQuestions("不存在的型別")).length, 0, "沒定義的型別不要硬組");
});

Deno.test("判不出來算命中——Jev 有超過一半的時候說不出來，算成沒事等於看不懂就放行", () => {
  const dims = VOTE_DIMENSIONS.policy;
  // 全部沒回答
  const none = computeVoteBudget("policy", {}, false);
  assertEquals(none.extra, Math.min(dims.length, MAX_EXTRA_VOTES), "沒回答的維度全部算命中");
  assert(none.dimensions.every((d) => d.hit));
  assert(none.dimensions.every((d) => d.reason.includes("判不出來")), "理由要寫明是判不出來，不要讓人以為 Jev 真的認為有風險");

  // 答了但信心不足
  const low = computeVoteBudget("policy", ans({ not_concrete: ["policy", DIMENSION_THRESHOLD - 0.01] }), false);
  assert(low.dimensions.find((d) => d.key === "not_concrete")!.hit, "低於閾值＝判不出來＝命中");

  // 剛好到閾值、而且答的是「沒事」那一邊
  const ok = computeVoteBudget("policy", ans({ not_concrete: ["policy", DIMENSION_THRESHOLD] }), false);
  assert(!ok.dimensions.find((d) => d.key === "not_concrete")!.hit, "達到閾值且答沒事＝不加票");
});

Deno.test("每一維命中都要講得出理由——之後要回答「當初為什麼加這幾票」", () => {
  const b = computeVoteBudget("policy", ans({
    not_this_person: ["cannot_attribute", 0.9],
    claim_not_stated: ["stated", 0.95],
  }), false);
  const hit = b.dimensions.find((d) => d.key === "not_this_person")!;
  assert(hit.hit && hit.reason.includes("證明不了"), "命中的理由要是那一維 hit 選項的說明");
  const miss = b.dimensions.find((d) => d.key === "claim_not_stated")!;
  assert(!miss.hit && miss.reason.length > 0, "沒命中也要留下理由");
});

Deno.test("門檻＝max(型別地板, 2 − 中選會折扣 + 加成)，加成封頂 5", () => {
  // 全部沒事、又有中選會 → 最低
  const clean = computeVoteBudget("policy", ans({
    not_this_person: ["attributed", 1], claim_not_stated: ["stated", 1], not_concrete: ["policy", 1],
    duplicate_risk: ["distinct", 1], weak_source: ["checkable", 1],
  }), true);
  assertEquals(clean.extra, 0);
  assertEquals(clean.threshold, Math.max(1, BASE_VOTES - 1), "中選會查得到的乾淨資料只要 1 票");

  // 全部命中 → 封頂
  const worst = computeVoteBudget("policy", {}, false);
  assertEquals(worst.extra, MAX_EXTRA_VOTES);
  assertEquals(worst.threshold, BASE_VOTES + MAX_EXTRA_VOTES, "最高 7 票");
});

Deno.test("不可逆的型別有地板，Jev 只能往上加不能往下穿", () => {
  for (const [t, floor] of Object.entries(TYPE_FLOOR)) {
    const dims = VOTE_DIMENSIONS[t] ?? [];
    // 全部答「沒事」＋中選會折扣 → 仍不得低於地板
    const cleanAnswers = Object.fromEntries(dims.map((d) => [d.key, { choice: d.miss.key, probabilities: { [d.miss.key]: 1 } }]));
    const b = computeVoteBudget(t, cleanAnswers, true);
    assertEquals(b.extra, 0, `${t} 全部沒事時不該加票`);
    assert(b.threshold >= floor, `${t} 的門檻 ${b.threshold} 穿過了地板 ${floor}——誤判沒有便宜的回頭路`);
  }
});

// 2026-09-20 的坑：型別／狀態進了 TS 卻沒進 DB 的 CHECK，線上全被擋而測試全綠
Deno.test("vote_budget 要同時在 TS 的 QUESTIONS 與 DB 的 CHECK 裡", async () => {
  assert((QUESTIONS as readonly string[]).includes("vote_budget"), "TS 的 QUESTIONS 少了 vote_budget");
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  let found: string | null = null;
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const at = sql.indexOf("CONSTRAINT jev_decisions_question_check");
    if (at >= 0) { found = sql.slice(at); break; }
  }
  assert(found, "找不到定義 jev_decisions_question_check 的 migration");
  for (const q of QUESTIONS) assert(found!.includes(`'${q}'`), `DB 的 CHECK 少了 ${q}`);
});
