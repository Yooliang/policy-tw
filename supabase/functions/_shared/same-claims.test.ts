/**
 * 同一件事只能有一筆（#521）：登記表、resolved_claim 的寫法、decideSameClaim 的判斷，與登記表守門。
 *
 * 守門（裁決：沒登記的型別測試轉紅）：
 *   - 日本站會落庫的型別（policy_jp.apply_types() 最新一版）每一種都要有「找同一件事」的做法：登記在 SAME_CLAIM_REGISTRY（jp），
 *     或是 claimKey 併票的結構化型別（duplicate-claim.ts 的 DUPLICATE_ELIGIBLE_TYPES）。
 *   - 一個型別只能在其中一邊（兩邊都在＝交件端會做兩次）。
 *   - SQL policy_jp.same_claim_matches 認得的型別清單＝登記表（jp）。
 *   - jp-next 的任務探查（same-claim-probe.ts）涵蓋每一種「資料型」任務，對到的型別都在登記表裡。
 * 每條守門都有還原驗證（拿掉被守的東西確認會紅）。
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { decideSameClaim, parseResolvedClaim, SAME_CLAIM_REGISTRY, sameClaimTypes, type SameClaimMatches } from "./same-claims.ts";
import { DUPLICATE_ELIGIBLE_TYPES } from "./duplicate-claim.ts";
import { jpSameClaimProbe } from "./jp/same-claim-probe.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const migFiles = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).filter((n) => n.includes("_policy_jp_") && n.endsWith(".sql")).sort();
const readMig = (n: string) => Deno.readTextFileSync(new URL(n, MIGRATIONS)).replace(/\r\n/g, "\n");

/** 最新一版 policy_jp.apply_types() 的清單 */
function latestApplyTypes(files: string[]): string[] {
  let found: string[] | null = null;
  for (const f of files) {
    const m = /FUNCTION policy_jp\.apply_types\(\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(readMig(f));
    if (m) found = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  if (!found) throw new Error("找不到 policy_jp.apply_types()");
  return found;
}
/** 最新一版 same_claim_matches 認得的型別（檔頭的 p_type NOT IN (…)） */
function sqlSameClaimTypes(sql: string): string[] {
  const body = /FUNCTION policy_jp\.same_claim_matches\([\s\S]*?\$\$([\s\S]*?)\$\$/.exec(sql);
  if (!body) throw new Error("找不到 policy_jp.same_claim_matches");
  const m = /IF p_type NOT IN \(([^)]*)\) THEN/.exec(body[1]);
  if (!m) throw new Error("same_claim_matches 沒有型別清單");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
/** 最新一支定義 same_claim_matches 的 migration */
const SAME_CLAIM_MIG = migFiles.filter((f) => /FUNCTION policy_jp\.same_claim_matches\(/.test(readMig(f))).at(-1)!;
/** 最新一支定義上線後收編觸發器的 migration，與它的型別清單 */
const SUPERSEDE_MIG = migFiles.filter((f) => /CREATE TRIGGER contributions_same_claim_supersede/.test(readMig(f))).at(-1)!;
function triggerTypes(sql: string): string[] {
  const m = /CREATE TRIGGER contributions_same_claim_supersede[\s\S]*?NEW\.contribution_type IN \(([^)]*)\)/.exec(sql);
  if (!m) throw new Error("收編觸發器沒有型別清單");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

Deno.test("守門：上線後收編的觸發器型別＝登記表（jp）", () => {
  const sql = readMig(SUPERSEDE_MIG);
  assertEquals(triggerTypes(sql).sort(), sameClaimTypes("jp").sort());
  const broken = sql.replace("NEW.contribution_type IN ('election', 'regional_stat', 'local_government')", "NEW.contribution_type IN ('election')");
  assert(broken !== sql, "還原驗證的替換沒有命中");
  assert(triggerTypes(broken).length === 1);
});

function guardApplyTypes(applyTypes: string[], registry: string[], dupTypes: readonly string[]): string[] {
  const problems: string[] = [];
  for (const t of applyTypes) if (!registry.includes(t) && !dupTypes.includes(t)) problems.push(`${t} 會落庫，卻沒有登記「找同一件事」`);
  for (const t of registry) if (dupTypes.includes(t)) problems.push(`${t} 同時在登記表與 claimKey 併票`);
  return problems;
}

Deno.test("守門：日本站會落庫的型別都有「找同一件事」的做法，而且只在一邊", () => {
  const applyTypes = latestApplyTypes(migFiles);
  assert(applyTypes.includes("election") && applyTypes.includes("no_change"), `apply_types 讀錯了：${applyTypes}`);
  assertEquals(guardApplyTypes(applyTypes, sameClaimTypes("jp"), DUPLICATE_ELIGIBLE_TYPES), []);
  // 還原驗證：從登記表拿掉 election、或 apply_types 多一種沒登記的、或兩邊都登記，都要紅
  assertEquals(guardApplyTypes(applyTypes, sameClaimTypes("jp").filter((t) => t !== "election"), DUPLICATE_ELIGIBLE_TYPES).length, 1);
  assertEquals(guardApplyTypes([...applyTypes, "lineage"], sameClaimTypes("jp"), DUPLICATE_ELIGIBLE_TYPES).length, 1);
  assertEquals(guardApplyTypes(applyTypes, [...sameClaimTypes("jp"), "no_change"], DUPLICATE_ELIGIBLE_TYPES).length, 1);
});

Deno.test("守門：SQL same_claim_matches 認得的型別＝登記表（jp）", () => {
  const sql = readMig(SAME_CLAIM_MIG);
  assertEquals(sqlSameClaimTypes(sql).sort(), sameClaimTypes("jp").sort());
  // 還原驗證：SQL 少一種就對不上
  const broken = sql.replace("IF p_type NOT IN ('election', 'regional_stat', 'local_government') THEN", "IF p_type NOT IN ('election', 'regional_stat') THEN");
  assert(broken !== sql, "還原驗證的替換沒有命中");
  assert(sqlSameClaimTypes(broken).sort().join() !== sameClaimTypes("jp").sort().join());
});

Deno.test("守門：任務探查涵蓋每一種資料型任務，型別都在登記表", () => {
  const cases: Array<[string, string]> = [
    ["auto:election_discovery:2027-04-30:131130:head", "election"],
    ["auto:election_discovery:2027-04-30:131130:assembly", "election"],
    ["auto:local_government_missing:131130", "local_government"],
    ["auto:regional_stats_missing:131130", "regional_stat"],
  ];
  for (const [id, type] of cases) {
    const p = jpSameClaimProbe(id);
    assertEquals(p?.type, type, id);
    assert(sameClaimTypes("jp").includes(type));
  }
  assertEquals(jpSameClaimProbe("auto:election_discovery:2027-04-30:131130:head")?.payload, { term_end: "2027-04-30", lg_code: "131130", office_kind: "head" });
  assertEquals(jpSameClaimProbe("11111111-2222-4333-8444-555555555555"), null, "手動任務沒有探查");
  assertEquals(jpSameClaimProbe("auto:election_discovery:2027-04-30:131130:other"), null);
});

Deno.test("登記表：型別不重複、每項有表名與鍵", () => {
  const types = SAME_CLAIM_REGISTRY.map((e) => e.type);
  assertEquals(new Set(types).size, types.length);
  for (const e of SAME_CLAIM_REGISTRY) assert(e.table && e.key.length > 0 && e.sites.length > 0, e.type);
  assertEquals(sameClaimTypes("tw"), [], "正見選前不接（九合一之後才接）");
});

Deno.test("parseResolvedClaim：四種寫法，其他一律 null", () => {
  assertEquals(parseResolvedClaim("new"), { kind: "new" });
  assertEquals(parseResolvedClaim(" new "), { kind: "new" });
  assertEquals(parseResolvedClaim("2026-12-27_town_mayor_123498"), { kind: "ref", id: "2026-12-27_town_mayor_123498" });
  assertEquals(parseResolvedClaim("49a4c898-0000-4000-8000-000000000001"), { kind: "ref", id: "49a4c898-0000-4000-8000-000000000001" });
  assertEquals(parseResolvedClaim("differs:49a4c898-0000-4000-8000-000000000001"), { kind: "differs", id: "49a4c898-0000-4000-8000-000000000001" });
  for (const bad of [undefined, null, "", "   ", "differs:", "two words", 42, {}, "x".repeat(201)]) assertEquals(parseResolvedClaim(bad), null, String(bad));
});

const E1 = "2026-12-27_town_mayor_123498";
const C1 = "c1111111-0000-4000-8000-000000000001";
const C2 = "c2222222-0000-4000-8000-000000000002";
const M = (o: Partial<SameClaimMatches> = {}): SameClaimMatches => ({ type: "election", existing: [], pending: [], ...o });

Deno.test("decideSameClaim：new", () => {
  assertEquals(decideSameClaim({ kind: "new" }, M()), { action: "insert" });
  const d = decideSameClaim({ kind: "new" }, M({ existing: [{ id: E1 }], pending: [{ contribution_id: C1 }] }));
  assertEquals(d.action, "block");
  if (d.action === "block") {
    assertEquals(d.error, "duplicate_claim");
    assertEquals(d.existing_ids, [E1]);
    assertEquals(d.pending_ids, [C1]);
    assert(d.message.includes(E1) && d.message.includes(C1), "訊息要寫出是哪幾筆");
  }
  assertEquals(decideSameClaim({ kind: "new" }, M({ pending: [{ contribution_id: C1 }] })).action, "block", "只撞到審議中的也擋");
});

Deno.test("decideSameClaim：指向審議中那一筆＝投同意票；這個網段交過或投過＝already_voted", () => {
  assertEquals(decideSameClaim({ kind: "ref", id: C1 }, M({ pending: [{ contribution_id: C1, your_network_voted: false }] })), { action: "vote", contribution_id: C1 });
  for (const p of [{ your_network_voted: true }, { yours: true }]) {
    const d = decideSameClaim({ kind: "ref", id: C1 }, M({ pending: [{ contribution_id: C1, ...p }] }));
    assertEquals(d.action === "block" ? d.error : d.action, "already_voted");
  }
});

Deno.test("decideSameClaim：指向在庫列＝existing；指的 id 不在比對結果＝claim_mismatch", () => {
  assertEquals(decideSameClaim({ kind: "ref", id: E1 }, M({ existing: [{ id: E1 }] })), { action: "existing", id: E1 });
  const d = decideSameClaim({ kind: "ref", id: C2 }, M({ existing: [{ id: E1 }], pending: [{ contribution_id: C1 }] }));
  assertEquals(d.action === "block" ? d.error : d.action, "claim_mismatch");
  const none = decideSameClaim({ kind: "ref", id: E1 }, M());
  assertEquals(none.action === "block" ? none.error : none.action, "claim_mismatch", "什麼都沒比對到卻指了一個 id");
});

Deno.test("decideSameClaim：differs＝照常收（主線裁定 1：兩筆並存進投票）；指的 id 要在比對結果裡", () => {
  assertEquals(decideSameClaim({ kind: "differs", id: E1 }, M({ existing: [{ id: E1 }] })), { action: "insert" });
  assertEquals(decideSameClaim({ kind: "differs", id: C1 }, M({ pending: [{ contribution_id: C1, your_network_voted: true }] })), { action: "insert" },
    "內容不同就不是同一張票，投過也照收");
  const d = decideSameClaim({ kind: "differs", id: C2 }, M({ pending: [{ contribution_id: C1 }] }));
  assertEquals(d.action === "block" ? d.error : d.action, "claim_mismatch");
});

Deno.test("sqlSameClaimTypes 讀不到時要丟錯，不是回空陣列", () => {
  assertThrows(() => sqlSameClaimTypes("SELECT 1"));
});
