/// <reference lib="deno.ns" />
/**
 * 選舉的網址識別與先後（#344 第二階段 A）。守三件事：
 *   1. 網址保持：舊三屆照舊 /election/2022；舊三屆的 key 寫法也認得、換成年份寫法；新增的選舉用 election_key
 *   2. 先後與年份看投票日，不看 id（id 4 的重行選舉日期比 id 2022 的九合一晚）
 *   3. Worker（cloudflare/region-path.js）與前端（這裡）的舊三屆清單是同一份
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  electionSegment,
  electionYearOfDate,
  findElectionBySegment,
  LEGACY_ELECTION_KEYS,
  legacyKeySegmentTarget,
  newerFirst,
  segmentOfId,
} from "./election-route.ts";
import { LEGACY_ELECTION_KEYS as WORKER_LEGACY_KEYS } from "../cloudflare/region-path.js";

const E2022 = { id: 2022, electionKey: "2022-11-26_local", electionDate: "2022-11-26" };
const E2024 = { id: 2024, electionKey: "2024-01-13_national", electionDate: "2024-01-13" };
const E2026 = { id: 2026, electionKey: "2026-11-28_local", electionDate: "2026-11-28" };
const RERUN = { id: 4, electionKey: "2022-12-18_rerun_10020", electionDate: "2022-12-18" };
const ALL = [RERUN, E2022, E2024, E2026]; // 依投票日排序載入：id 4 排在 2022 前面，這正是不能再「取第一筆」「取 id 最大」的原因

Deno.test("網址那一段：舊三屆用 id（網址不變），新增的選舉用 election_key", () => {
  assertEquals(ALL.map(electionSegment), ["2022-12-18_rerun_10020", "2022", "2024", "2026"]);
  // 就算新增的選舉 id 碰巧像年份，也不悄悄換一種網址：舊三屆是固定清單，不是「id 等於年份」
  assertEquals(electionSegment({ id: 2030, electionKey: "2030-11-30_local", electionDate: "2030-11-30" }), "2030-11-30_local");
  // 舊快取、測試假資料沒有 key：退回 id
  assertEquals(electionSegment({ id: 2022, electionDate: "2022-11-26" }), "2022");
});

Deno.test("網址上的一段 → 選舉：數字找 id、其餘找 key；舊三屆的 key 寫法也找得到", () => {
  assertEquals(findElectionBySegment(ALL, "2022")?.id, 2022);
  assertEquals(findElectionBySegment(ALL, "4")?.id, 4);
  assertEquals(findElectionBySegment(ALL, "2022-12-18_rerun_10020")?.id, 4);
  assertEquals(findElectionBySegment(ALL, "2022-11-26_local")?.id, 2022);
  assertEquals(findElectionBySegment(ALL, ["2026"])?.id, 2026, "vue-router 的參數有時是陣列");
  assertEquals(findElectionBySegment(ALL, "9999"), undefined);
  assertEquals(findElectionBySegment(ALL, "nope"), undefined);
  assertEquals(findElectionBySegment(ALL, ""), undefined);
  assertEquals(findElectionBySegment(ALL, undefined), undefined);
  assertEquals(findElectionBySegment([], "2022"), undefined, "清單還沒載入");
});

Deno.test("舊三屆的 key 寫法換成年份寫法；新增的選舉的 key 就是正式網址，不換", () => {
  assertEquals(legacyKeySegmentTarget("2022-11-26_local"), "2022");
  assertEquals(legacyKeySegmentTarget("2024-01-13_national"), "2024");
  assertEquals(legacyKeySegmentTarget(["2026-11-28_local"]), "2026");
  assertEquals(legacyKeySegmentTarget("2022-12-18_rerun_10020"), undefined);
  assertEquals(legacyKeySegmentTarget("2022"), undefined);
  assertEquals(legacyKeySegmentTarget(undefined), undefined);
});

Deno.test("前端與 Worker 的舊三屆清單一致（Worker 是純 JS、不能 import 前端，兩邊各一份，這裡盯住）", () => {
  assertEquals(
    Object.fromEntries(Object.entries(LEGACY_ELECTION_KEYS).map(([k, v]) => [k, String(v)])),
    WORKER_LEGACY_KEYS,
  );
});

Deno.test("id → 網址那一段；清單還沒載入退回 id", () => {
  assertEquals(segmentOfId(ALL, 4), "2022-12-18_rerun_10020");
  assertEquals(segmentOfId(ALL, 2024), "2024");
  assertEquals(segmentOfId([], 2024), "2024");
  assertEquals(segmentOfId(ALL, null), "");
});

Deno.test("投票年份看投票日；沒有日期不猜", () => {
  assertEquals(electionYearOfDate("2022-12-18"), 2022);
  assertEquals(electionYearOfDate(undefined), undefined);
  assertEquals(electionYearOfDate(""), undefined);
});

Deno.test("新到舊：有投票日就比投票日（id 4 的重行選舉比 id 2022 的九合一新），沒有才退回 id", () => {
  const recs = [
    { electionId: 2022, electionDate: "2022-11-26" },
    { electionId: 4, electionDate: "2022-12-18" },
    { electionId: 2026, electionDate: "2026-11-28" },
  ];
  assertEquals([...recs].sort(newerFirst).map((r) => r.electionId), [2026, 4, 2022]);
  // 舊視圖、舊快取沒有 electionDate：舊三屆的 id 順序照舊
  assertEquals([{ electionId: 2022 }, { electionId: 2026 }, { electionId: 2024 }].sort(newerFirst).map((r) => r.electionId), [2026, 2024, 2022]);
  // 只有一邊有日期：不能拿日期去比沒日期的，退回 id
  assertEquals(newerFirst({ electionId: 4, electionDate: "2022-12-18" }, { electionId: 2022 }), 2022 - 4);
});
