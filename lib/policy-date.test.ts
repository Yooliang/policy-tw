/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { policyElectionYear, policySortDate, policyYear } from "./policy-date.ts";

const election2024 = { id: 2024, name: "2024 大選", shortName: "2024 大選", startDate: "2023-01-01", endDate: "2024-01-13", electionDate: "2024-01-13", types: [] };
const election2026 = { id: 2026, name: "2026 九合一選舉", shortName: "2026 九合一", startDate: "2025-01-01", endDate: "2026-11-28", electionDate: "2026-11-28", types: [] };

Deno.test("policySortDate：優先用提出日期，其次最後更新時間，都沒有回 0", () => {
  assertEquals(
    policySortDate({ proposedDate: "2024-05-01", lastUpdated: "2026-01-01" }),
    new Date("2024-05-01").getTime(),
  );
  assertEquals(
    policySortDate({ proposedDate: null, lastUpdated: "2026-01-01" }),
    new Date("2026-01-01").getTime(),
  );
  assertEquals(policySortDate({ proposedDate: null, lastUpdated: "" as unknown as string }), 0);
});

Deno.test("policyYear：有提出日期就取其年份", () => {
  assertEquals(
    policyYear({ proposedDate: "2024-05-01", electionId: 2026, lastUpdated: "2026-01-01" }),
    "2024",
  );
});

Deno.test("policyYear：沒有提出日期時退回所屬選舉的投票年份（看 elections.election_date，不把 electionId 當年份）", () => {
  assertEquals(
    policyYear({ proposedDate: null, electionId: 2024, lastUpdated: "2026-01-01" }, [election2024, election2026]),
    "2024",
  );
  // 沒給選舉清單就不能猜年份：退回最後更新時間（以前會把 electionId 原樣當年份印）
  assertEquals(policyYear({ proposedDate: null, electionId: 2024, lastUpdated: "2026-01-01" }), "2026");
});

Deno.test("policyYear：新增的選舉（id 不是年份，#344 第二階段 A）：2022-12-18 嘉義市長重行選舉 id 4 → 2022，不是「4」", () => {
  const rerun = { id: 4, electionDate: "2022-12-18" };
  assertEquals(policyYear({ proposedDate: null, electionId: 4, lastUpdated: "2026-01-01" }, [rerun, election2024]), "2022");
  assertEquals(policyElectionYear({ electionId: 4 }, [rerun]), "2022");
  assertEquals(policyElectionYear({ electionId: 4 }, undefined), null);
  assertEquals(policyElectionYear({ electionId: undefined }, [rerun]), null);
  assertEquals(policyElectionYear({ electionId: 99 }, [rerun]), null);
});

Deno.test("policyYear：傳入 elections 清單時，electionId 對不上任何屆別就不採信，退回最後更新時間", () => {
  assertEquals(
    policyYear({ proposedDate: null, electionId: 9999, lastUpdated: "2026-03-01" }, [election2024, election2026]),
    "2026",
  );
  assertEquals(
    policyYear({ proposedDate: null, electionId: 2024, lastUpdated: "2026-03-01" }, [election2024, election2026]),
    "2024",
  );
});

Deno.test("policyYear：提出日期與所屬屆別都沒有時退回最後更新時間的年份", () => {
  assertEquals(
    policyYear({ proposedDate: null, electionId: undefined, lastUpdated: "2025-12-01" }),
    "2025",
  );
});

Deno.test("policyYear：什麼都沒有回 null", () => {
  assertEquals(
    policyYear({ proposedDate: null, electionId: undefined, lastUpdated: "" as unknown as string }),
    null,
  );
});
