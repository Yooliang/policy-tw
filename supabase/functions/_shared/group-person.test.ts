/**
 * 多人任務的 person_key（2026-11-09，小良核准）：
 *   * 收件檢查 groupPersonProblems：沒帶、不在名單上、no_change 少帶 politician_election_id 都擋；
 *   * 同一宣稱的鍵把 person_key 算進去：同一張任務不同人的 no_change 不互相收編，同一位才算同一宣稱；
 *   * 落庫：多人任務的 no_change confirmed（掛錯人）寫 task_checks auto:candidacy_owner_mismatch:<pe_id>；其他做法與非 confirmed 不寫；
 *   * 文件（skill-types／hint／migration）講了 person_key。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyContribution, type ContributionRow } from "./apply-contribution.ts";
import { claimKey, findSuperseded } from "./duplicate-claim.ts";
import { groupPersonProblems, personCheckTaskId, personConfirmCheckTaskId, resolveGroupPerson } from "./group-person.ts";
import { MULTI_PERSON_HINT } from "./task-guidance.ts";
import { validateContributionRequest } from "./contribution-schema.ts";

const TASK = "d9042ce1-f031-4804-ac98-d41e219ea38a";
const TARGET = {
  multi_person: true, origin: "roster_group",
  people: [
    { key: "掛錯人:57044", action: "wrong_owner", politician_election_id: 57044, name: "陳玉蘭" },
    { key: "掛錯人:51400", action: "wrong_owner", politician_election_id: 51400, name: "葉春蘭" },
    { key: "party:2026|某縣|某人", action: "party", politician_election_id: 777, name: "某人" },
    { key: "missing:abc", action: "missing", politician_election_id: null, name: "缺人" },
  ],
};
const nc = (extra: Record<string, unknown>) => ({ contribution_type: "no_change", task_id: TASK, payload: { task_id: TASK, outcome: "confirmed", finding: "比對過，是同一人", ...extra } });

Deno.test("G1 收件檢查：沒帶 person_key／不在名單／no_change 沒帶 politician_election_id 都擋；對的放行；非多人任務不管", () => {
  const targets = new Map<string, unknown>([[TASK, TARGET]]);
  assertEquals(groupPersonProblems([nc({})], targets)[0].code, "person_key_required");
  assertEquals(groupPersonProblems([nc({ person_key: 5 })], targets)[0].code, "person_key_required", "不是字串視同沒帶");
  assertEquals(groupPersonProblems([nc({ person_key: "掛錯人:99999" })], targets)[0].code, "person_key_unknown");
  assertEquals(groupPersonProblems([nc({ person_key: "掛錯人:57044" })], targets)[0].code, "person_key_mismatch");
  assertEquals(groupPersonProblems([nc({ person_key: "掛錯人:57044", politician_election_id: 51400 })], targets)[0].code, "person_key_mismatch");
  assertEquals(groupPersonProblems([nc({ person_key: "掛錯人:57044", politician_election_id: 57044 })], targets), []);
  assertEquals(groupPersonProblems([nc({ person_key: "掛錯人:57044", politician_election_id: "57044" })], targets), [], "字串數字也算");
  // 缺人那種沒有 pe_id：只要 person_key 對
  assertEquals(groupPersonProblems([nc({ person_key: "missing:abc" })], targets), []);
  // 其他型別（candidacy 等）只檢查 person_key
  assertEquals(groupPersonProblems([{ contribution_type: "candidacy", task_id: TASK, payload: { person_key: "party:2026|某縣|某人" } }], targets), []);
  assertEquals(groupPersonProblems([{ contribution_type: "candidacy", task_id: TASK, payload: {} }], targets)[0].code, "person_key_required");
  // 不是多人任務（不在 targets 裡）不管
  assertEquals(groupPersonProblems([{ contribution_type: "no_change", task_id: "auto:x:1", payload: {} }], targets), []);
  // 逐筆回報 index
  const mixed = groupPersonProblems([nc({ person_key: "掛錯人:57044", politician_election_id: 57044 }), nc({})], targets);
  assertEquals(mixed.map((p) => p.index), [1]);
});

Deno.test("G2 同一宣稱的鍵：同一張任務不同人 → 不同鍵、不互相收編；同一位 → 同鍵；沒有 person_key 的單人任務鍵不變", () => {
  const a = nc({ person_key: "掛錯人:57044" }), b = nc({ person_key: "掛錯人:51400" }), a2 = nc({ person_key: "掛錯人:57044", finding: "另一種說法的同一個結論" });
  assert(claimKey("no_change", a.payload) !== claimKey("no_change", b.payload));
  assertEquals(claimKey("no_change", a.payload), claimKey("no_change", a2.payload));
  assertEquals(claimKey("no_change", { task_id: "auto:x:1", outcome: "confirmed" }), "no_change|task_id:auto:x:1");
  assertEquals(claimKey("no_change", { task_id: TASK }), `no_change|task_id:${TASK}`);
  // 收編：上線的是 57044，同任務等票中的 51400 不被收編，另一筆 57044 才會
  const pending = [
    { id: "p-51400", contribution_type: "no_change", payload: b.payload, status: "pending" },
    { id: "p-57044", contribution_type: "no_change", payload: a2.payload, status: "pending" },
  ];
  assertEquals(findSuperseded({ id: "applied", contribution_type: "no_change", payload: a.payload }, pending), ["p-57044"]);
});

Deno.test("G3 resolveGroupPerson／personConfirmCheckTaskId：照 person_key 找人；舊資料用 politician_election_id；只有掛錯人有逐人排除", () => {
  assertEquals(resolveGroupPerson(TARGET, { person_key: "掛錯人:51400" })?.name, "葉春蘭");
  assertEquals(resolveGroupPerson(TARGET, { person_key: "不存在" }), null);
  assertEquals(resolveGroupPerson(TARGET, { politician_election_id: 57044 })?.key, "掛錯人:57044", "舊交件沒有 person_key，退回結構化的 politician_election_id");
  assertEquals(resolveGroupPerson(TARGET, {}), null);
  assertEquals(resolveGroupPerson({ people: TARGET.people }, { person_key: "掛錯人:57044" }), null, "不是多人任務");
  assertEquals(personConfirmCheckTaskId(resolveGroupPerson(TARGET, { person_key: "掛錯人:57044" })), "auto:candidacy_owner_mismatch:57044");
  assertEquals(personConfirmCheckTaskId(resolveGroupPerson(TARGET, { person_key: "party:2026|某縣|某人" })), null);
  assertEquals(personConfirmCheckTaskId(resolveGroupPerson(TARGET, { person_key: "missing:abc" })), null);
  assertEquals(personConfirmCheckTaskId(null), null);
  assertEquals(personCheckTaskId(resolveGroupPerson(TARGET, { person_key: "party:2026|某縣|某人" })), "auto:roster_group_person:party:2026|某縣|某人");
  assertEquals(personCheckTaskId(resolveGroupPerson(TARGET, { person_key: "掛錯人:57044" })), "auto:candidacy_owner_mismatch:57044");
  assertEquals(personCheckTaskId(null), null);
});

function fakeDb(target: unknown) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: table === "contribution_tasks" ? { id, task_type: "candidacy_owner_mismatch", target } : null, error: null }) }) }),
      insert: (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; },
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }),
  };
  return { db, inserts };
}
const rowOf = (payload: Record<string, unknown>): ContributionRow => ({
  id: "c-1", contribution_type: "no_change", payload: { task_id: TASK, finding: "比對過，是同一人", ...payload }, source_urls: ["https://example.org"],
  note: null, agent_name: "mei_cc01", contributor_url: null, task_id: TASK,
} as ContributionRow);

Deno.test("H1 落庫：多人任務掛錯人 no_change confirmed → 寫 task_checks auto:candidacy_owner_mismatch:<pe_id>（confirmed、帶 contribution_id）", async () => {
  const { db, inserts } = fakeDb(TARGET);
  const out = await applyContribution(db as never, rowOf({ outcome: "confirmed", person_key: "掛錯人:57044", politician_election_id: 57044 }));
  assertEquals(out.status, "applied");
  const checks = inserts.filter((i) => i.table === "task_checks");
  assertEquals(checks.length, 1);
  assertEquals(checks[0].row.task_id, "auto:candidacy_owner_mismatch:57044");
  assertEquals(checks[0].row.outcome, "confirmed");
  assertEquals(checks[0].row.contribution_id, "c-1");
  assert(String(out.message).includes("從清單移除"));
});

Deno.test("H2 落庫：舊交件（沒有 person_key，只有 politician_election_id）也能對到人；不同人各自寫自己的 pe_id", async () => {
  const { db, inserts } = fakeDb(TARGET);
  await applyContribution(db as never, rowOf({ outcome: "confirmed", politician_election_id: 51400 }));
  assertEquals(inserts.filter((i) => i.table === "task_checks").map((i) => i.row.task_id), ["auto:candidacy_owner_mismatch:51400"]);
});

Deno.test("H3 落庫（2026-11-09 逐人階梯）：not_found／confirmed／unreachable 都寫那一位自己的 task_checks；對不到人才不寫", async () => {
  const cases: Array<[Record<string, unknown>, string | null, string]> = [
    [{ outcome: "not_found", person_key: "掛錯人:57044", politician_election_id: 57044 }, "auto:candidacy_owner_mismatch:57044", "not_found"],
    [{ outcome: "unreachable", person_key: "掛錯人:57044", politician_election_id: 57044 }, "auto:candidacy_owner_mismatch:57044", "unreachable"],
    [{ outcome: "confirmed", person_key: "party:2026|某縣|某人" }, "auto:roster_group_person:party:2026|某縣|某人", "confirmed"],
    [{ outcome: "not_found", person_key: "missing:abc" }, "auto:roster_group_person:missing:abc", "not_found"],
    [{ outcome: "confirmed" }, null, "confirmed"],
    [{ outcome: "confirmed", person_key: "不存在" }, null, "confirmed"],
  ];
  for (const [payload, taskId, outcome] of cases) {
    const { db, inserts } = fakeDb(TARGET);
    const out = await applyContribution(db as never, rowOf(payload));
    assertEquals(out.status, "applied", JSON.stringify(payload));
    const checks = inserts.filter((i) => i.table === "task_checks");
    if (taskId === null) { assertEquals(checks.length, 0, JSON.stringify(payload)); continue; }
    assertEquals(checks.length, 1, JSON.stringify(payload));
    assertEquals(checks[0].row.task_id, taskId);
    assertEquals(checks[0].row.outcome, outcome);
    assertEquals(checks[0].row.contribution_id, "c-1");
  }
});

Deno.test("H4 not_found 的回應講真正的階梯天數（5／10／20、第 4 次起結案），不是舊的「2 天內不會再派」", async () => {
  const { db } = fakeDb(TARGET);
  const out = await applyContribution(db as never, rowOf({ outcome: "not_found", person_key: "掛錯人:57044", politician_election_id: 57044 }));
  const m = String(out.message);
  assert(m.includes("5 天") && m.includes("10 天") && m.includes("20 天") && m.includes("第 4 次起結案"), m);
  assert(!m.includes("2 天內"), m);
  const c = String((await applyContribution(fakeDb(TARGET).db as never, rowOf({ outcome: "confirmed", person_key: "party:2026|某縣|某人" }))).message);
  assert(c.includes("5 天") && c.includes("10 天") && c.includes("第 3 次起結案"), c);
});

Deno.test("S1 schema：頂層 person_key 灌進 payload", () => {
  const ok = validateContributionRequest({
    agent_name: "tester",
    contributions: [{
      contribution_type: "no_change", task_id: TASK, person_key: "掛錯人:57044",
      payload: { task_id: TASK, outcome: "confirmed", finding: "比對過中選會名冊與歷屆資料，是同一人", checked_urls: ["https://db.cec.gov.tw/x"] },
      source_urls: ["https://db.cec.gov.tw/x"],
    }],
  });
  assertEquals(ok.errors, []);
  assertEquals(ok.items[0].payload.person_key, "掛錯人:57044");
});

Deno.test("D1 文件：hint、skill-types、migration 都講 person_key", async () => {
  assert(MULTI_PERSON_HINT.includes("person_key"));
  const md = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assert(md.includes("person_key_required") && md.includes("掛錯人:57044"));
  const mig = await Deno.readTextFile(new URL("../../migrations/20261109120000_roster_group_person_key.sql", import.meta.url));
  assert(mig.includes("payload.person_key") && mig.includes("politician_election_id") && mig.includes("roster_group_description"));
});
