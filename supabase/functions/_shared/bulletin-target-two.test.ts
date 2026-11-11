/**
 * 公報來源的政見（policy，source_urls 任一個是中選會選舉公報站）目標分數 3 → 2、驗證者不用找第二來源
 * （維護者 2026-11-11 裁示第 6 項；migration 20261111130000；裁決 docs/decisions/2026-11-11-公報來源政見目標2不找第二來源.md）的守門測試。
 * SQL（PGlite 真的跑 contribution_required_agree）與 TS（requiredAgree）逐案比對。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";
import { AGREE_THRESHOLDS, bulletinSourceUrl, effectiveRequiredAgree, isBulletinPolicy, rejectFloor, requiredAgree, riskLevel, scoreStatus, targetFloor } from "./consensus.ts";
import { BULLETIN_HOSTS } from "./source-archive.ts";
import { scoringHint, shapeVerifyCurrent } from "./task-context.ts";

const MIG = "20261111130000_bulletin_policy_target_2.sql";
const BULLETIN = "https://eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf";
const CENTRAL = "https://bulletin.cec.gov.tw/01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/第1選舉區/王小明.pdf";
const NEWS = "https://www.cna.com.tw/news/aipl/202611110001.aspx";
const SOCIAL = "https://www.facebook.com/someone/posts/1";
const CEC_DB = "https://db.cec.gov.tw/ElecTable/Election/ElecTickets";
const POLICY = { title: "增設長照據點", description: "每里一處", politician_id: "0b8d3a52-1111-4222-8333-444455556666" };

Deno.test("TS：公報來源的政見獨立風險等級、目標 2（不看來源等級）；任一個網址是公報站就算", () => {
  assertEquals(AGREE_THRESHOLDS.bulletin_policy, { official: 2, media: 2, social: 2, other: 2 });
  assertEquals(riskLevel("policy", POLICY, [BULLETIN]), "bulletin_policy");
  for (const urls of [[BULLETIN], [CENTRAL], [NEWS, BULLETIN], [BULLETIN, SOCIAL], ["https://bulletin.cec.gov.tw/?dir=x"], ["https://bulletin.cec.gov.tw/", BULLETIN], [` ${BULLETIN}`], ["https://EEBULLETIN.cec.gov.tw/x.pdf"], ["http://www.bulletin.cec.gov.tw/x.pdf"]]) {
    assertEquals(requiredAgree("policy", POLICY, urls), 2, JSON.stringify(urls));
  }
  assertEquals([...BULLETIN_HOSTS].sort(), ["bulletin.cec.gov.tw", "eebulletin.cec.gov.tw"], "公報主機沿用 source-archive.ts 的既有常數");
});

Deno.test("TS：只有新聞／社群／其他中選會網址的政見仍是 3；沒給網址也是 3", () => {
  for (const urls of [["https://bulletin.cec.gov.tw/"], ["https://eebulletin.cec.gov.tw"], ["https://eebulletin.cec.gov.tw/"], [NEWS], [SOCIAL], [CEC_DB], [], ["https://example.com/eebulletin.cec.gov.tw"], ["https://eebulletin.cec.gov.tw.evil.com/x.pdf"], ["不是網址"]]) {
    assertEquals(requiredAgree("policy", POLICY, urls), 3, JSON.stringify(urls));
    assert(!isBulletinPolicy("policy", urls));
  }
  assertEquals(requiredAgree("policy", POLICY), 3);
  assertEquals(riskLevel("policy", POLICY), "normal", "沒傳網址仍是一般級（舊呼叫端不受影響）");
});

Deno.test("TS：非 policy 型別帶公報網址不受影響；日本站不受影響", () => {
  assertEquals(requiredAgree("candidacy", { name: "王小明" }, [BULLETIN]), 3);
  assertEquals(requiredAgree("correction", { target_table: "policies", field: "title" }, [BULLETIN]), 3);
  assertEquals(requiredAgree("policy_progress", {}, [BULLETIN]), 3);
  assertEquals(requiredAgree("policy_elements", {}, [BULLETIN]), 3);
  assertEquals(requiredAgree("removal", {}, [BULLETIN]), 3);
  assertEquals(requiredAgree("no_change", {}, [BULLETIN]), 2);
  assertEquals(requiredAgree("candidacy", { name: "x", cand_no: 7 }, [BULLETIN]), 1, "補號次仍 1");
  assert(!isBulletinPolicy("candidacy", [BULLETIN]));
});

Deno.test("日本站不受影響：jp/consensus.ts 沒有 bulletin_policy", async () => {
  const jp = await Deno.readTextFile(new URL("./jp/consensus.ts", import.meta.url));
  assert(!jp.includes("bulletin_policy"), "日本站是否跟進由日本站決定");
});

Deno.test("計分：2 分達標；退件門檻、一張反對擋得住、系統票規則不動", () => {
  const target = requiredAgree("policy", POLICY, [BULLETIN]);
  const st = (score: number, t = target) => scoreStatus({ score, target: t, distinctIps: 1, contributionType: "policy", payload: POLICY, current: "pending" });
  assertEquals(st(1), "pending");
  assertEquals(st(2), "verified", "兩張 +1 就上線（原本要三張）");
  assertEquals(st(1 - 1), "pending", "一同意一反對 → 0，擋得住");
  assertEquals(rejectFloor("policy"), 3, "退件門檻不動");
  assertEquals(st(-3), "rejected");
  assertEquals(effectiveRequiredAgree(target, "supported"), 1);
  assertEquals(effectiveRequiredAgree(target, "not_supported"), 3);
  assertEquals(effectiveRequiredAgree(target, null), 2);
});

Deno.test("驗證項：公報來源的政見 scoring 不叫人找第二來源；其他來源照舊", () => {
  const pick = (urls: string[]) => shapeVerifyCurrent("policy", { title: "x", description: "y" }, { score: 1, target_score: requiredAgree("policy", POLICY, urls), source_urls: urls } as never) as {
    scoring: { hint: string; second_source_counts: boolean; your_vote_could_be: { max: number; how: string }; not_a_second_source?: string[] };
  };
  const b = pick([BULLETIN]).scoring;
  assertStringIncludes(b.hint, "公報來源：打開公報 PDF 逐條核對即可投票，不用找第二來源");
  assertEquals(b.second_source_counts, false);
  assertEquals(b.your_vote_could_be.max, 1);
  assertStringIncludes(b.your_vote_could_be.how, "不用找第二來源");
  assertEquals(b.not_a_second_source, undefined);
  const n = pick([NEWS]).scoring;
  assertEquals(n.second_source_counts, true);
  assertEquals(n.your_vote_could_be.max, 2);
  assert(!n.hint.includes("不用找第二來源"));
  assertEquals(scoringHint(1, 3, "policy", [NEWS]).hint, scoringHint(1, 3, "policy").hint);
});

Deno.test("verify-handler 與 /next：公報來源的政見不回 evidence_warning、派驗證票加指示（文字守門）", async () => {
  const vh = await Deno.readTextFile(new URL("./verify-handler.ts", import.meta.url));
  assertStringIncludes(vh, "!isBulletinPolicy(contribution.contribution_type, contribution.source_urls ?? [])");
  const next = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assertStringIncludes(next, "bulletinSourceUrl(pick.contribution_type, pick.source_urls ?? [])");
  assertStringIncludes(next, "BULLETIN_POLICY_VERIFY_NOTE");
});

Deno.test("協議文件：skill.md 第 8 條有例外、skill-types.md 門檻表有一列", async () => {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(skill, "公報來源的政見不找第二來源");
  const types = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  assertStringIncludes(types, "| `policy` **公報來源的政見**");
  assertStringIncludes(types, "公報來源的政見（`policy`，`source_urls` 任一個是中選會選舉公報站）2");
});

// ── SQL：真的跑 contribution_required_agree（PGlite），跟 TS 逐案比對 ──
async function sqlDb(): Promise<PGlite> {
  const d = new PGlite();
  const base = await readMig("20260912000009_zero_manual_points.sql");
  for (const f of ["contribution_host_of", "contribution_host_in"]) await d.exec(fnText(base, f) ? extractFn(base, f) : "");
  await d.exec(extractFn(await readMig("20261005000347_sources_table.sql"), "source_doc_kind"));
  await d.exec(extractFn(await readMig("20261010080000_source_kind_news.sql"), "contribution_source_kind"));
  await d.exec(extractFn(await readMig("20260920000003_rumor_correction_normal.sql"), "correction_only_from_rumor"));
  await d.exec(extractFn(await readMig(MIG), "contribution_required_agree")); // 只載入目標函式（migration 後段重算既有資料，PGlite 沒有那些表）
  return d;
}
/** 取出整個 CREATE OR REPLACE FUNCTION name(...) ... $$; 區段（含簽章） */
function extractFn(sql: string, name: string): string {
  const a = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(a >= 0, `找不到 ${name}`);
  const open = sql.indexOf("$$", a);
  return sql.slice(a, sql.indexOf("$$;", open + 2) + 3);
}

Deno.test("SQL 與 TS 逐案一致（PGlite 真的跑）：公報網址＋其他網址→2；只有新聞→3；非 policy 不受影響", async () => {
  const d = await sqlDb();
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["policy", POLICY, [BULLETIN]],
    ["policy", POLICY, [CENTRAL]],
    ["policy", POLICY, [NEWS, BULLETIN]],
    ["policy", POLICY, [BULLETIN, SOCIAL]],
    ["policy", POLICY, [` ${BULLETIN}`]],
    ["policy", POLICY, ["https://EEBULLETIN.cec.gov.tw/x.pdf"]],
    ["policy", POLICY, ["http://www.bulletin.cec.gov.tw/x.pdf"]],
    ["policy", POLICY, [NEWS]],
    ["policy", POLICY, ["https://bulletin.cec.gov.tw/"]],
    ["policy", POLICY, ["https://eebulletin.cec.gov.tw"]],
    ["policy", POLICY, ["https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1"]],
    ["policy", POLICY, ["https://bulletin.cec.gov.tw/", BULLETIN]],
    ["policy", POLICY, [SOCIAL]],
    ["policy", POLICY, [CEC_DB]],
    ["policy", POLICY, []],
    ["policy", POLICY, ["https://eebulletin.cec.gov.tw.evil.com/x.pdf"]],
    ["policy", POLICY, ["https://example.com/eebulletin.cec.gov.tw"]],
    ["candidacy", { name: "王小明" }, [BULLETIN]],
    ["candidacy", { name: "王小明", cand_no: 7 }, [BULLETIN]],
    ["correction", { field: "title" }, [BULLETIN]],
    ["correction", { field: "candidate_status", current_value: "rumored" }, [BULLETIN]],
    ["policy_progress", {}, [BULLETIN]],
    ["removal", {}, [BULLETIN]],
    ["no_change", {}, [BULLETIN]],
    ["adjudication", {}, [BULLETIN]],
    ["regional_stat", {}, [BULLETIN]],
    ["cand_numbers", {}, [BULLETIN]],
  ];
  for (const [t, p, urls] of cases) {
    const r = await d.query<{ v: number }>("SELECT contribution_required_agree($1, $2::jsonb, $3::text[]) AS v", [t, JSON.stringify(p), urls]);
    assertEquals(r.rows[0].v, requiredAgree(t, p, urls), `${t} ${JSON.stringify(urls)}`);
  }
  const nul = await d.query<{ v: number }>("SELECT contribution_required_agree('policy', '{}'::jsonb, NULL) AS v");
  assertEquals(nul.rows[0].v, 3, "source_urls NULL 不當成公報");
  await d.close();
});

Deno.test("SQL：最新 contribution_required_agree 是這支或更新；矩陣列、判斷順序（cand_no 之後、一般級之前）", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(new URL("../../migrations/", import.meta.url))) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let latest = { name: "", fn: "" };
  for (const n of names) {
    const t = await readMig(n);
    if (t.includes("CREATE OR REPLACE FUNCTION contribution_required_agree(")) latest = { name: n, fn: extractFn(t, "contribution_required_agree") };
  }
  assert(latest.name >= MIG, "之後若再改這支函式要保留 bulletin_policy 規則");
  assertStringIncludes(latest.fn, "WHEN v_risk = 'bulletin_policy' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END");
  const iNo = latest.fn.indexOf("THEN 'cand_no'\n    WHEN p_type = 'policy'");
  const iB = latest.fn.indexOf("THEN 'bulletin_policy'");
  const iHigh = latest.fn.indexOf("WHEN p_type = 'candidacy' OR");
  assert(iNo > 0 && iNo < iB && iB < iHigh, "bulletin_policy 要在 cand_no 之後、一般級之前");
  assertStringIncludes(latest.fn, "source_doc_kind(btrim(u)) = 'election_bulletin'");
});

Deno.test("migration：除了函式定義只重算既有 pending 的公報政見與對齊驗證池快照，不改別的表", async () => {
  const sql = (await readMig(MIG)).replace(/--.*$/gm, "");
  assert(!/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i.test(sql));
  const updates = [...sql.matchAll(/\bUPDATE\s+(\w+)/gi)].map((m) => m[1]);
  assertEquals(updates, ["task_dispatches"], "只對齊 task_dispatches.verify_target");
  assertStringIncludes(sql, "PERFORM contribution_apply_consensus(r.id);");
  assertStringIncludes(sql, "contribution_type = 'policy' AND status = 'pending'");
  assertStringIncludes(sql, "SET verify_target = contribution_effective_agree(c.id)");
});

Deno.test("目標下限 2：公報政見被系統票 supported（含多獨立來源）也不低於 2；其他型別照舊最少 1", () => {
  for (const urls of [[BULLETIN, NEWS], [BULLETIN]]) {
    const floor = targetFloor("policy", urls);
    assertEquals(floor, 2);
    const need = requiredAgree("policy", POLICY, urls);
    assertEquals(effectiveRequiredAgree(need, "supported", false, 1, floor), 2, "supported 仍 2");
    assertEquals(effectiveRequiredAgree(need, "supported", false, 2, floor), 2, "兩個獨立來源仍 2");
    assertEquals(effectiveRequiredAgree(need, "not_supported", false, 1, floor), 3);
    assertEquals(effectiveRequiredAgree(need, null, false, 1, floor), 2);
  }
  assertEquals(targetFloor("policy", [NEWS]), 1);
  assertEquals(targetFloor("policy", ["https://bulletin.cec.gov.tw/"]), 1);
  assertEquals(targetFloor("candidacy", [BULLETIN]), 1);
  assertEquals(effectiveRequiredAgree(3, "supported", false, 2, targetFloor("policy", [NEWS])), 1, "一般政見仍可降到 1");
  assertEquals(effectiveRequiredAgree(3, "supported", false, 1), 2, "舊呼叫端預設 floor 1，行為不變");
});

Deno.test("SQL contribution_effective_agree：有 v_floor、判斷與目標函式同一條公報規則", async () => {
  const t = await readMig(MIG);
  const fn = extractFn(t, "contribution_effective_agree");
  assertStringIncludes(fn, "GREATEST(v_floor, 1, v_need - COALESCE(contribution_system_vote_sources(p_contribution_id), 1))");
  assertStringIncludes(fn, "GREATEST(v_floor, LEAST(v_need, 1))");
  assertStringIncludes(fn, "WHEN v_sys = 'not_supported' THEN v_need + 1");
  assertStringIncludes(fn, "source_doc_kind(btrim(u)) = 'election_bulletin' AND btrim(u) !~* '^https?://[^/?#]+/?$'");
});

Deno.test("驗證提示指出哪一條是公報網址（混合來源）", () => {
  assertEquals(bulletinSourceUrl("policy", [NEWS, BULLETIN]), BULLETIN);
  assertEquals(bulletinSourceUrl("policy", ["https://bulletin.cec.gov.tw/", NEWS]), null);
  assertEquals(bulletinSourceUrl("candidacy", [BULLETIN]), null);
  assertStringIncludes(scoringHint(1, 2, "policy", [NEWS, BULLETIN]).hint, `公報網址：${BULLETIN}`);
});
