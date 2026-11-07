import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyContribution } from "./apply-contribution.ts";
import { handleContribute } from "./contribute-handler.ts";
import { MERGE_CANDIDACY_CONFLICT_MESSAGE, mergeCandidacyConflicts, type MergePeRow, type MergeRegionRow } from "./merge-candidacy-conflict.ts";

/**
 * 同一人合併的硬守門（2026-11-07）：張榮華（三星鄉第02選舉區 號次2）被併進張榮華（羅東鎮第03選舉區 號次5）、
 * 徐進忠（春日鄉第02選舉區）被併進徐進忠（三星鄉第01選舉區 號次2）——同一屆參選紀錄對不起來，不是同一人。
 */
const KEEP = "11111111-1111-4111-8111-111111111111";
const REMOVE = "22222222-2222-4222-8222-222222222222";

const REGIONS = new Map<number, MergeRegionRow>([
  [1, { region: "宜蘭縣", sub_region: "羅東鎮第03選舉區", village: null }],
  [2, { region: "宜蘭縣", sub_region: "三星鄉第02選舉區", village: null }],
  [3, { region: "宜蘭縣", sub_region: "三星鄉", village: null }],
  [4, { region: "屏東縣", sub_region: "春日鄉第02選舉區", village: null }],
  [5, { region: "宜蘭縣", sub_region: "三星鄉第01選舉區", village: null }],
]);
const pe = (o: Partial<MergePeRow>): MergePeRow => ({ election_id: 2026, election_type: "鄉鎮市民代表", cand_no: null, region_id: null, ...o });

Deno.test("純函式：號次不同／選區不同／選舉別不同＝衝突", () => {
  assertEquals(mergeCandidacyConflicts([pe({ cand_no: 5, region_id: 1 })], [pe({ cand_no: 2, region_id: 2 })], REGIONS).length, 1);
  assertEquals(mergeCandidacyConflicts([pe({ region_id: 5 })], [pe({ region_id: 4 })], REGIONS).length, 1, "縣市／鄉鎮不同");
  assertEquals(mergeCandidacyConflicts([pe({ region_id: 5 })], [pe({ region_id: 2 })], REGIONS).length, 1, "同鄉鎮不同選舉區");
  assertEquals(mergeCandidacyConflicts([pe({ election_type: "鄉鎮市長" })], [pe({})], REGIONS).length, 1);
});

Deno.test("純函式：沒有共同屆別、或資料只是缺欄／只差一層，不算衝突", () => {
  assertEquals(mergeCandidacyConflicts([pe({ election_id: 2022, cand_no: 5 })], [pe({ cand_no: 2 })], REGIONS).length, 0);
  assertEquals(mergeCandidacyConflicts([pe({ cand_no: null })], [pe({ cand_no: 2 })], REGIONS).length, 0);
  assertEquals(mergeCandidacyConflicts([pe({ cand_no: 2, region_id: 2 })], [pe({ cand_no: 2, region_id: 2 })], REGIONS).length, 0);
  assertEquals(mergeCandidacyConflicts([pe({ region_id: 3 })], [pe({ region_id: 2 })], REGIONS).length, 0, "鄉鎮層級 vs 同鄉鎮選舉區");
});

/** 假庫：politician_elections 依 politician_id 回資料；regions 回 REGIONS；rpc 記錄有沒有被呼叫 */
function fakeDb(rows: Record<string, MergePeRow[]>) {
  let rpcCalled = 0;
  const db = {
    rpc: (_n: string, _a: unknown) => { rpcCalled++; return Promise.resolve({ data: { moved_policies: 0, moved_elections: 0 }, error: null }); },
    from(table: string) {
      if (table === "politician_pair_resolutions") {
        return {
          upsert: (r: Record<string, unknown>) => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "r-1", ...r }, error: null }) }) }),
          insert: () => ({ error: null }),
        };
      }
      let pid = "";
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (_c: string, v: string) => { pid = v; return chain; },
        in: () => chain,
        is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: Array<{ payload_hash?: string }>) => ({ error: null, select: () => ({ data: rows.map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }),
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: unknown) => unknown) => {
          if (table === "politician_elections") return res({ data: rows[pid] ?? [], error: null });
          if (table === "regions") return res({ data: [...REGIONS].map(([id, r]) => ({ id, ...r })), error: null });
          if (table === "politicians") return res({ data: [{ id: KEEP, merged_into: null }, { id: REMOVE, merged_into: null }], error: null });
          return res({ data: [], error: null, count: 0 });
        },
      };
      return chain;
    },
  };
  return { db, rpcCalls: () => rpcCalled };
}

const CONFLICT_ROWS = { [KEEP]: [pe({ cand_no: 5, region_id: 1 })], [REMOVE]: [pe({ cand_no: 2, region_id: 2 })] };
const row = (same_person: boolean) => ({
  id: "c-1", contribution_type: "merge_politician" as const, source_urls: ["https://db.cec.gov.tw/x"], note: null, agent_name: "tester", contributor_url: null,
  payload: { keep_id: KEEP, remove_id: REMOVE, same_person, reason: "兩位名字相同，我判斷是同一人所以合併，理由至少二十字。" },
});

Deno.test("落庫：同一屆衝突的 same_person=true → disputed，不呼叫 SQL 合併", async () => {
  const { db, rpcCalls } = fakeDb(CONFLICT_ROWS);
  const out = await applyContribution(db, row(true));
  assertEquals(out.status, "disputed");
  assertEquals(out.message, MERGE_CANDIDACY_CONFLICT_MESSAGE);
  assertEquals(rpcCalls(), 0);
});

Deno.test("落庫：沒有衝突的 same_person=true 照常合併", async () => {
  const { db, rpcCalls } = fakeDb({ [KEEP]: [pe({ cand_no: 2, region_id: 2 })], [REMOVE]: [pe({ cand_no: 2, region_id: 2 })] });
  const out = await applyContribution(db, row(true));
  assertEquals(out.status, "applied");
  assertEquals(rpcCalls(), 1);
});

Deno.test("落庫：判為不同人（same_person=false）即使有衝突也照常放行", async () => {
  const { db, rpcCalls } = fakeDb(CONFLICT_ROWS);
  const out = await applyContribution(db, row(false));
  assertEquals(out.status, "applied");
  assertEquals(rpcCalls(), 0);
});

function body(same: boolean) {
  return { agent_name: "tester", contribution_type: "merge_politician", payload: row(same).payload, source_urls: ["https://db.cec.gov.tw/test"] };
}
const noVote = () => Promise.resolve({ status: 403, body: { error: "self_vote" } });

Deno.test("交件前置檢查：衝突 → 400 apply_would_fail 帶原因；不同人放行", async () => {
  const res = await handleContribute(fakeDb(CONFLICT_ROWS).db, "https://x", body(true), "ip-1", noVote);
  assertEquals(res.status, 400);
  const b = res.body as Record<string, unknown>;
  assertEquals(b.error, "apply_would_fail");
  assert(JSON.stringify(b).includes("不是同一人"));
  const ok = await handleContribute(fakeDb(CONFLICT_ROWS).db, "https://x", body(false), "ip-1", noVote);
  assertEquals(ok.status, 201);
});
