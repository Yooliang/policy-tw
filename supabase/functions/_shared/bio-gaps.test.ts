// 簡介提到、學歷／經歷欄沒列的（2026-10-04）
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { bioGapTask, buildBioGapAsk, worthScanning } from "./bio-gaps.ts";
import { QUESTIONS, SUBJECT_TYPES } from "./system-one.ts";

const P = { id: "p1", name: "林某", bio: "國立臺灣大學政治學系畢業，曾任台北市議員助理、民進黨中執委。", education: [], experience: ["市議員"] };

Deno.test("worthScanning：簡介太短不問", () => {
  assert(worthScanning(P));
  assert(!worthScanning({ ...P, bio: "短" }));
  assert(!worthScanning({ ...P, bio: null }));
});

Deno.test("buildBioGapAsk：簡介與已列欄位放 state，兩題各三個選項", () => {
  const { state, questions } = buildBioGapAsk(P);
  assertEquals(state.education_listed, []);
  assertEquals(state.experience_listed, ["市議員"]);
  assertEquals(Object.keys(questions), ["bio_education", "bio_experience"]);
  assertEquals(Object.keys(questions.bio_education.criteria ?? {}), ["missing", "covered", "absent"]);
});

Deno.test("紀錄用的 subject_type／question 已在白名單（DB CHECK 在 migration 20261004000001）", () => {
  assert((SUBJECT_TYPES as readonly string[]).includes("politician"));
  assert((QUESTIONS as readonly string[]).includes("bio_education"));
  assert((QUESTIONS as readonly string[]).includes("bio_experience"));
});

Deno.test("bioGapTask：標題只列缺的那一項、附簡介原文、叫代理去官方來源核對", () => {
  const t = bioGapTask(P, { education: true, experience: false });
  assertEquals(t.title, "從簡介補學歷：林某");
  assertStringIncludes(t.description ?? "", "國立臺灣大學");
  assertStringIncludes(t.description ?? "", "官方來源");
  assertEquals(t.target_politician_id, "p1");
});
