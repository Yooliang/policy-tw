// 票數預算的影子模式（2026-09-21）。守的是「加票的理由講得出來」與「判不出來要往嚴格的方向倒」。
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BASE_VOTES,
  computeVoteBudget,
  DIMENSION_THRESHOLD,
  dimensionQuestions,
  MAX_EXTRA_VOTES,
  MIN_DISTINCT_VOTERS,
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

// 2026-09-21 修正：第一版寫成「判不出來算命中」，審查算了期望值——Jev 的 source_support
// 有 56% 回 cannot_tell，5 維下期望加成 +2.8，policy 目標落在 5，比現行矩陣還高，
// 跟「解開積壓」的目的正好相反。改成只有 Jev 有信心說命中時才加票；保底是基本的 2 票。
Deno.test("判不出來不加票，但也不會放行——保底的 2 票還在", () => {
  const none = computeVoteBudget("policy", {}, false);
  assertEquals(none.extra, 0, "沒回答的維度不加票");
  assertEquals(none.threshold, BASE_VOTES, "落回基本 2 票，跟現行一般資料同級");
  assert(none.dimensions.every((d) => !d.hit));
  assert(none.dimensions.every((d) => d.reason.includes("判不出來")), "理由要講明是判不出來");

  const low = computeVoteBudget("policy", ans({ not_concrete: ["not_policy", DIMENSION_THRESHOLD - 0.01] }), false);
  assert(!low.dimensions.find((d) => d.key === "not_concrete")!.hit, "信心不足＝判不出來＝不加票");

  const sure = computeVoteBudget("policy", ans({ not_concrete: ["not_policy", DIMENSION_THRESHOLD] }), false);
  assert(sure.dimensions.find((d) => d.key === "not_concrete")!.hit, "有信心說命中才加票");

  const ok = computeVoteBudget("policy", ans({ not_concrete: ["policy", 1] }), false);
  assert(!ok.dimensions.find((d) => d.key === "not_concrete")!.hit, "明確說沒事，不加票");
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

Deno.test("門檻＝max(1, 2 − 中選會折扣 + 加成)，加成封頂 5", () => {
  const clean = computeVoteBudget("policy", ans({
    not_this_person: ["attributed", 1], claim_not_stated: ["stated", 1], not_concrete: ["policy", 1],
    duplicate_risk: ["distinct", 1], weak_source: ["checkable", 1],
  }), true);
  assertEquals(clean.extra, 0);
  assertEquals(clean.threshold, BASE_VOTES - 1, "中選會查得到的乾淨資料只要 1 分");

  const worst = computeVoteBudget("policy", ans({
    not_this_person: ["cannot_attribute", 1], claim_not_stated: ["not_stated", 1], not_concrete: ["not_policy", 1],
    duplicate_risk: ["duplicate", 1], weak_source: ["weak", 1],
  }), false);
  assertEquals(worst.extra, MAX_EXTRA_VOTES);
  assertEquals(worst.threshold, BASE_VOTES + MAX_EXTRA_VOTES, "最高 7 分");
});

// 把地板設在分數上會讓中選會折扣失效（candidacy 地板 3，扣不扣都是 3），
// 跟「中選會查得到就該快」自相矛盾。分數與人數是兩件事，拆開。
Deno.test("不可逆的型別要求人數，不是要求分數——折扣才不會被地板吃掉", () => {
  const dims = VOTE_DIMENSIONS.candidacy;
  const cleanAnswers = Object.fromEntries(dims.map((d) => [d.key, { choice: d.miss.key, probabilities: { [d.miss.key]: 1 } }]));
  const b = computeVoteBudget("candidacy", cleanAnswers, true);
  assertEquals(b.extra, 0);
  assertEquals(b.threshold, BASE_VOTES - 1, "中選會查得到就該只要 1 分——地板不該吃掉這個折扣");
  assertEquals(b.min_distinct_voters, 2, "但仍要求兩個不同的人看過");
  assertEquals(computeVoteBudget("policy", {}, false).min_distinct_voters, 1, "一般型別不另外要求人數");
});

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
