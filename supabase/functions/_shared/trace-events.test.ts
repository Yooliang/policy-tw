/**
 * /trace 重播頁的資料來源 trace_events()（migration 20261111140000_trace_events.sql，2026-11-11）守門。
 * 只要 --allow-read。
 *
 * 這支函式是 SECURITY DEFINER：匿名讀不到的表（交件、投票、驗證票派出、認領事件）靠它對外。所以守三件事：
 *   A. 不洩漏：函式 SQL 不出現來源網段雜湊、憑證、帳號識別的字樣（只回代理顯示名）
 *   B. 有界：每個 UNION 分支各自有時限與 LIMIT；p_since 有 14 天下限、p_limit 有 5000 上限；
 *            驗證票派出與認領事件的回看期 ≤ 各自的保留天數（驗證票另受清理守門的「派工綁定 7 天」限制）
 *   C. 權限與屬性：SECURITY DEFINER、固定 search_path、STABLE、只授權給 anon／authenticated／service_role
 * 每條守門都做還原驗證：把原始碼精確改壞一處（改不到就失敗），對應的檢查必須紅。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
// 目前生效的是最後一版（CREATE OR REPLACE 整支）：160000 起多 Jev 系統票與系統判定
const TRACE_MIG = "20261111200000_trace_events_dispute_strong.sql";
const LEASE_MIG = "20261111120000_lease_events.sql";
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const REAL = norm(await Deno.readTextFile(new URL(TRACE_MIG, MIGRATIONS)));
const LEASE = norm(await Deno.readTextFile(new URL(LEASE_MIG, MIGRATIONS)));

/** 拿掉 -- 註解（避免註解裡的字樣干擾；字串裡沒有 --） */
const stripComments = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const FORBIDDEN = [/ip_hash/i, /token/i, /actor_id/i, /voter_ips/i, /contributor_ip/i, /verifier_ip/i];
const MAX_DAYS = 14;
/** 驗證票派出：清理守門要求回看期 ≤ 派工綁定 7 天（保留 14 天減邊際）；這裡再釘一次 */
const VERIFY_DISPATCH_MAX_DAYS = 7;

/** 回傳問題清單（空＝全部合格） */
function problemsOf(sql: string, leaseRetentionDays: number): string[] {
  const out: string[] = [];
  const code = stripComments(sql);
  // A. 不洩漏——整支檔（含 COMMENT）都不准出現
  for (const re of FORBIDDEN) if (re.test(sql)) out.push(`含有不准出現的字樣 ${re}`);

  // 備註原文（可能含人名、連結）與審核者原文（可能是人名、信箱）不能回
  if (/\bnote\b/i.test(code)) out.push("SQL 含 note 欄：投票與查核的備註不能回");
  if (/'reviewed_by',\s*c\.reviewed_by\b/.test(code)) out.push("reviewed_by 回了原文，只能回「自動」「人工」");
  const resolve = /BEGIN([\s\S]*?)RETURN QUERY/.exec(code);
  if (!resolve) out.push("找不到對象解析區");
  else if (/v_since/.test(resolve[1].replace(/v_since\s+TIMESTAMPTZ[^;]*;/, ""))) out.push("對象解析（交件、任務集合）用了 v_since：切段查詢時早一段建立的交件在後段會漏");

  // jev_decisions：只准讀 subject_type／subject_id／question／choice／asked_at 與 state 裡的 supported_sources
  for (const m of code.matchAll(/\bj\.(\w+)(->>?'(\w+)')?/g)) {
    const col = m[1];
    if (["subject_type", "subject_id", "question", "choice", "asked_at"].includes(col)) continue;
    if (col === "state" && m[3] === "supported_sources") continue;
    out.push(`jev_decisions 的 j.${col}${m[2] ?? ""} 不能回（只准 choice、question、asked_at 與 state 的 supported_sources）`);
  }
  if (!/FROM jev_decisions j/.test(code)) out.push("少了 jev_decisions 分支");
  // strong_adjudications（別名 s）：只准讀 verdict、status、finalized_at、task_id、contribution_id（不回 reasoning、cause_note、報告回應、模型、費用）
  for (const m of code.matchAll(/\bs\.(\w+)/g)) {
    if (["verdict", "status", "finalized_at", "task_id", "contribution_id"].includes(m[1])) continue;
    out.push(`strong_adjudications 的 s.${m[1]} 不能讀（只准 verdict、status、finalized_at、task_id、contribution_id）`);
  }
  if (!/FROM strong_adjudications s/.test(code)) out.push("少了 strong_adjudications 分支");

  // B. 有界
  const m =/RETURN QUERY([\s\S]*?)\nEND;\n\$\$;/.exec(code);
  if (!m) return [...out, "找不到 RETURN QUERY 本體"];
  const body = m[1];
  const inner = /FROM \(([\s\S]*)\) e\s+WHERE e\.at IS NOT NULL/.exec(body);
  if (!inner) return [...out, "找不到包住各分支的子查詢"];
  const branches = inner[1].split(/\n\s*UNION ALL\n/).map((b) => b.trim());
  if (branches.length < 10) out.push(`UNION 分支只有 ${branches.length} 個，少了來源`);
  for (const b of branches) {
    const label = /FROM\s+([a-z_]+)/i.exec(b)?.[1] ?? b.slice(0, 40);
    const lim = /(?:created_at|\bat|asked_at|last_activity_at|finalized_at|checked_at|requested_at|closed_at|verified_at|applied_at|reviewed_at|dispatched_at)\s*>=\s*GREATEST\(v_since,\s*now\(\)\s*-\s*interval\s*'(\d+) days'\)/.exec(b);
    if (!lim) { out.push(`分支 ${label} 沒有 >= 時限`); continue; }
    const days = Number(lim[1]);
    if (days > MAX_DAYS) out.push(`分支 ${label} 回看 ${days} 天 > ${MAX_DAYS}`);
    if (/FROM\s+verify_dispatches/i.test(b) && days > VERIFY_DISPATCH_MAX_DAYS) out.push(`verify_dispatches 回看 ${days} 天 > ${VERIFY_DISPATCH_MAX_DAYS}`);
    if (/FROM\s+lease_events/i.test(b) && (days + 1) > leaseRetentionDays) out.push(`lease_events 回看 ${days} 天（加一天邊際）> 保留 ${leaseRetentionDays} 天`);
    if (!/ORDER BY[^\n]*DESC LIMIT v_lim\)/.test(b)) out.push(`分支 ${label} 沒有 ORDER BY … DESC LIMIT v_lim`);
  }
  if (!/FROM\s+lease_events/i.test(inner[1])) out.push("少了 lease_events 分支");
  if (!/FROM\s+verify_dispatches/i.test(inner[1])) out.push("少了 verify_dispatches 分支");
  if (!/ORDER BY e\.at DESC\s+LIMIT v_lim;/.test(body)) out.push("最外層沒有 ORDER BY e.at DESC LIMIT v_lim");
  if (!/v_since\s+TIMESTAMPTZ\s*:=\s*GREATEST\(coalesce\(p_since,\s*now\(\)\s*-\s*interval\s*'4 hours'\),\s*now\(\)\s*-\s*interval\s*'14 days'\)/.test(code)) out.push("p_since 沒有 14 天下限");
  if (!/v_lim\s+INT\s*:=\s*LEAST\(GREATEST\(coalesce\(p_limit,\s*5000\),\s*1\),\s*5000\)/.test(code)) out.push("p_limit 沒有 5000 上限");

  // C. 屬性與權限
  if (!/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '3s' AS/.test(code)) out.push("不是 STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '3s'");
  if (!/REVOKE ALL ON FUNCTION trace_events\([^)]*\) FROM PUBLIC;/.test(code)) out.push("沒有 REVOKE ALL FROM PUBLIC");
  const grant = /GRANT EXECUTE ON FUNCTION trace_events\([^)]*\) TO ([A-Za-z_, ]+);/.exec(code);
  if (!grant) out.push("沒有 GRANT EXECUTE");
  else if (grant[1].replace(/\s/g, "") !== "anon,authenticated,service_role") out.push(`GRANT 對象不是 anon, authenticated, service_role：${grant[1]}`);
  return out;
}

const leaseDays = Number(/lease_events_days INTEGER NOT NULL DEFAULT (\d+)/.exec(LEASE)?.[1] ?? NaN);

function mutate(sql: string, from: string | RegExp, to: string): string {
  const next = typeof from === "string" ? sql.split(from).join(to) : sql.replace(from, to);
  assert(next !== sql, `還原驗證：改不到 ${from}`);
  return next;
}

Deno.test("A/B/C trace_events 的原始 migration 沒有任何問題", () => {
  assert(Number.isFinite(leaseDays), "抽不出 lease_events_days 預設值");
  assertEquals(problemsOf(REAL, leaseDays), []);
});

Deno.test("回看期不超過保留期：lease_events 保留天數 ≥ 14", () => {
  assert(leaseDays >= MAX_DAYS, `lease_events 保留 ${leaseDays} 天，trace_events 回看 ${MAX_DAYS} 天`);
});

Deno.test("還原驗證：洩漏字樣 → 紅", () => {
  for (const bad of ["l.ip_hash", "c.actor_id", "v.verifier_ip_hash", "dispatch_token"]) {
    const sql = mutate(REAL, "SELECT e.at, e.kind,", `SELECT ${bad} AS leak, e.at, e.kind,`);
    assert(problemsOf(sql, leaseDays).some((p) => p.includes("不准出現")), `${bad} 應該被抓到`);
  }
});

Deno.test("還原驗證：分支拿掉時限、LIMIT、或回看期放大 → 紅", () => {
  const noTime = mutate(REAL, "WHERE t.created_at >= GREATEST(v_since, now() - interval '14 days') AND t.created_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))", "WHERE t.created_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))");
  assert(problemsOf(noTime, leaseDays).some((p) => p.includes("沒有 >= 時限")));
  const noLimit = mutate(REAL, "ORDER BY k.checked_at DESC LIMIT v_lim)", "ORDER BY k.checked_at DESC)");
  assert(problemsOf(noLimit, leaseDays).some((p) => p.includes("沒有 ORDER BY")));
  const big = mutate(REAL, "g.at >= GREATEST(v_since, now() - interval '14 days')", "g.at >= GREATEST(v_since, now() - interval '30 days')");
  assert(problemsOf(big, leaseDays).some((p) => p.includes("> 14")));
  const vd = mutate(REAL, "vd.dispatched_at >= GREATEST(v_since, now() - interval '7 days')", "vd.dispatched_at >= GREATEST(v_since, now() - interval '14 days')");
  assert(problemsOf(vd, leaseDays).some((p) => p.includes("verify_dispatches 回看")));
  assertEquals(problemsOf(REAL, 7).some((p) => p.includes("lease_events 回看")), true, "保留天數比回看期短要紅");
});

Deno.test("還原驗證：p_since 下限、p_limit 上限被拿掉 → 紅", () => {
  const since = mutate(REAL, "GREATEST(coalesce(p_since, now() - interval '4 hours'), now() - interval '14 days')", "coalesce(p_since, now() - interval '4 hours')");
  assert(problemsOf(since, leaseDays).some((p) => p.includes("14 天下限")));
  const lim = mutate(REAL, "LEAST(GREATEST(coalesce(p_limit, 5000), 1), 5000)", "coalesce(p_limit, 5000)");
  assert(problemsOf(lim, leaseDays).some((p) => p.includes("5000 上限")));
  const outer = mutate(REAL, "ORDER BY e.at DESC\n  LIMIT v_lim;", "ORDER BY e.at DESC;");
  assert(problemsOf(outer, leaseDays).some((p) => p.includes("最外層")));
});

Deno.test("還原驗證：不是 SECURITY DEFINER、授權給 PUBLIC 或其他角色 → 紅", () => {
  const def = mutate(REAL, "STABLE SECURITY DEFINER SET search_path = public", "STABLE SET search_path = public");
  assert(problemsOf(def, leaseDays).some((p) => p.includes("SECURITY DEFINER")));
  const rev = mutate(REAL, "REVOKE ALL ON FUNCTION", "-- REVOKE ALL ON FUNCTION");
  assert(problemsOf(rev, leaseDays).some((p) => p.includes("REVOKE")));
  const grant = mutate(REAL, "TO anon, authenticated, service_role;", "TO PUBLIC;");
  assert(problemsOf(grant, leaseDays).some((p) => p.includes("GRANT 對象")));
});

Deno.test("還原驗證：回備註、回審核者原文、對象解析用 v_since、拿掉 timeout → 紅", () => {
  const note = mutate(REAL, "jsonb_build_object('outcome', k.outcome)", "jsonb_build_object('outcome', k.outcome, 'note', left(k.note, 160))");
  assert(problemsOf(note, leaseDays).some((p) => p.includes("note")));
  const rb = mutate(REAL, "'reviewed_by', CASE WHEN c.reviewed_by IS NULL", "'reviewed_by', c.reviewed_by, 'x', CASE WHEN c.reviewed_by IS NULL");
  assert(problemsOf(rb, leaseDays).some((p) => p.includes("reviewed_by")));
  const since = mutate(REAL, "c.task_id = p_task_id AND c.created_at >= now() - interval '14 days'", "c.task_id = p_task_id AND c.created_at >= v_since");
  assert(problemsOf(since, leaseDays).some((p) => p.includes("v_since")));
  const to = mutate(REAL, " SET statement_timeout = '3s'", "");
  assert(problemsOf(to, leaseDays).some((p) => p.includes("statement_timeout")));
});

// ---- 行為層（PGlite，假表）：切段查詢不能漏、不回備註與審核者原文 ----
const STUB = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE gap_events (id bigserial, task_id text, task_type text, event text, at timestamptz default now(), reason text, detail jsonb default '{}');
CREATE TABLE task_dispatches (task_id text primary key, work_key text);
CREATE TABLE lease_events (id bigserial, task_id text, agent_name text, ip_hash text, event text, at timestamptz default now(), meta jsonb default '{}');
CREATE TABLE contribution_tasks (id uuid primary key default gen_random_uuid(), task_type text, source text, target jsonb default '{}', created_at timestamptz default now(), closed_at timestamptz, closed_reason text);
CREATE TABLE web_request_coverage (task_id uuid, politician_id text, requested_at timestamptz, gap_task_id text, gap_arm text);
CREATE TABLE contributions (id uuid primary key default gen_random_uuid(), contribution_type text, payload jsonb default '{}', task_id text, agent_name text, status text, agree_count int, disagree_count int, unsure_count int, verified_at timestamptz, reviewed_by text, reviewed_at timestamptz, applied_politician_id uuid, created_at timestamptz default now(), applied_at timestamptz, last_activity text, last_activity_at timestamptz);
CREATE TABLE strong_adjudications (id uuid default gen_random_uuid(), task_id text, contribution_id text, status text, verdict text, finalized_at timestamptz, reasoning text, cause_note text);
CREATE TABLE contribution_votes (id uuid default gen_random_uuid(), contribution_id uuid, verdict text, evidence_url text, note text, agent_name text, created_at timestamptz default now(), weight smallint);
CREATE TABLE verify_dispatches (contribution_id uuid, ip_hash text, agent_name text, dispatched_at timestamptz);
CREATE TABLE jev_decisions (id bigserial, subject_type text, subject_id text, question text, choice text, probability numeric, model text, state jsonb, asked_at timestamptz default now());
CREATE TABLE task_checks (id bigserial, task_id text, checked_at timestamptz, agent_name text, note text, contribution_id uuid, outcome text, work_key text);
`;
const CID = "11111111-1111-1111-1111-111111111111";
const PID = "22222222-2222-2222-2222-222222222222";

async function withDb(fn: (db: PGlite) => Promise<void>) {
  const db = new PGlite();
  try {
    await db.exec(STUB);
    await db.exec(REAL);
    await db.exec(`
      INSERT INTO contributions(id, contribution_type, payload, task_id, agent_name, status, created_at, applied_at, applied_politician_id, reviewed_by)
        VALUES ('${CID}', 'policy', '{"politician_id":"${PID}"}', 'auto:x:1', 'bot', 'applied', now() - interval '5 days', now() - interval '10 minutes', '${PID}', 'someone@example.com');
      INSERT INTO contribution_votes(contribution_id, verdict, agent_name, note, weight) VALUES ('${CID}', 'agree', 'v1', '私人備註', 1);
      INSERT INTO task_checks(task_id, checked_at, agent_name, note, outcome) VALUES ('auto:x:1', now() - interval '2 hours', 'bot', '私人備註2', 'not_found');`);
    await fn(db);
  } finally {
    await db.close();
  }
}

const kindsOf = async (db: PGlite, args: string) =>
  (await db.query<{ kind: string }>(`SELECT kind FROM trace_events(${args})`)).rows.map((r) => r.kind);

Deno.test("行為：交件在早一段建立、投票在後一段 → 後一段照樣回該票（任務、交件、人物三種）", async () => {
  await withDb(async (db) => {
    const lastHalfHour = "p_since => now() - interval '30 minutes', p_until => now() + interval '1 minute'";
    for (const who of ["p_task_id => 'auto:x:1'", `p_contribution_id => '${CID}'`, `p_politician_id => '${PID}'`]) {
      const k = await kindsOf(db, `${who}, ${lastHalfHour}`);
      assert(k.includes("vote"), `${who} 後段沒有投票：${k}`);
      assert(k.includes("applied"), `${who} 後段沒有落庫：${k}`);
      assert(!k.includes("submitted"), `${who} 交件是 5 天前，不該出現在後段`);
    }
    const early = await kindsOf(db, "p_task_id => 'auto:x:1', p_since => now() - interval '6 days', p_until => now() - interval '4 days'");
    assertEquals(early, ["submitted"]);
  });
});

Deno.test("行為：不回備註原文、不回審核者原文、不回來源網段", async () => {
  await withDb(async (db) => {
    await db.exec(`INSERT INTO verify_dispatches VALUES ('${CID}', 'secret-hash', 'v1', now()); INSERT INTO lease_events(task_id, agent_name, ip_hash, event) VALUES ('auto:x:1', 'bot', 'secret-hash', 'issued');`);
    const rows = (await db.query(`SELECT detail, agent_name FROM trace_events(p_task_id => 'auto:x:1')`)).rows;
    const text = JSON.stringify(rows);
    for (const bad of ["私人備註", "someone@example.com", "secret-hash"]) assert(!text.includes(bad), `回了 ${bad}`);
    assert(text.includes("人工"), "審核者應顯示「人工」");
  });
});

Deno.test("還原驗證：jev_decisions 多回 state 其他內容／模型／機率，或拿掉時限 → 紅", () => {
  const model = mutate(REAL, "jsonb_build_object('question', j.question, 'choice', j.choice,", "jsonb_build_object('question', j.question, 'choice', j.choice, 'model', j.model,");
  assert(problemsOf(model, leaseDays).some((p) => p.includes("j.model")));
  const state = mutate(REAL, "CASE WHEN jsonb_typeof(j.state->'supported_sources') = 'number' THEN j.state->'supported_sources' END", "j.state");
  assert(problemsOf(state, leaseDays).some((p) => p.includes("j.state")));
  const noBound = mutate(REAL, "AND j.asked_at >= GREATEST(v_since, now() - interval '14 days') AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))\n      ORDER BY j.asked_at DESC LIMIT v_lim)\n    UNION ALL\n    -- Jev 的其他", "AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))\n      ORDER BY j.asked_at DESC LIMIT v_lim)\n    UNION ALL\n    -- Jev 的其他");
  assert(problemsOf(noBound, leaseDays).some((p) => p.includes("沒有 >= 時限")));
});

Deno.test("行為：Jev 系統票與系統判定從 jev_decisions 來，只回選項與來源數，不回模型與機率", async () => {
  await withDb(async (db) => {
    await db.exec(`
      INSERT INTO jev_decisions(subject_type, subject_id, question, choice, probability, model, state, asked_at) VALUES
        ('contribution', '${CID}', 'source_support', 'supported', 0.93, 'secret-model', '{"supported_sources": 2, "secret_field": "不能回"}', now() - interval '20 minutes'),
        ('contribution', '${CID}', 'second_source', 'not_supported', 0.5, 'secret-model', '{}', now() - interval '10 minutes'),
        ('contribution', '${CID}', 'vote_budget', '3', 0.5, 'secret-model', '{}', now() - interval '5 minutes'),
        ('policy', '${CID}', 'source_support', 'supported', 0.5, 'secret-model', '{}', now() - interval '5 minutes');`);
    const rows = (await db.query<{ kind: string; agent_name: string | null; detail: Record<string, unknown> }>(
      `SELECT kind, agent_name, detail FROM trace_events(p_contribution_id => '${CID}', p_since => now() - interval '1 hour', p_until => now() + interval '1 minute')`)).rows;
    const sys = rows.filter((r) => r.kind === "system_vote");
    assertEquals(sys.length, 1);
    assertEquals(sys[0].agent_name, "Jev");
    assertEquals(sys[0].detail.choice, "supported");
    assertEquals(sys[0].detail.supported_sources, 2);
    const chk = rows.filter((r) => r.kind === "system_check");
    assertEquals(chk.length, 1);
    assertEquals([chk[0].detail.question, chk[0].detail.choice], ["second_source", "not_supported"]);
    const text = JSON.stringify(rows);
    for (const bad of ["secret-model", "secret_field", "不能回", "vote_budget", "0.93"]) assert(!text.includes(bad), `回了 ${bad}`);
    // 全站模式也有
    const all = await kindsOf(db, "p_since => now() - interval '1 hour', p_until => now() + interval '1 minute'");
    assert(all.includes("system_vote") && all.includes("system_check"));
    // 時限：一小時前的判定在最近 5 分鐘的段落不出現
    await db.exec(`UPDATE jev_decisions SET asked_at = now() - interval '3 hours' WHERE question = 'source_support'`);
    const late = await kindsOf(db, "p_since => now() - interval '1 hour', p_until => now() + interval '1 minute'");
    assert(!late.includes("system_vote"));
  });
});

Deno.test("行為：爭議與強模型事件（disputed／strong_claim／strong_finalized），不回理由與備註", async () => {
  await withDb(async (db) => {
    const TID = "33333333-3333-3333-3333-333333333333";
    const AID = "44444444-4444-4444-4444-444444444444";
    await db.exec(`
      INSERT INTO contribution_tasks(id, task_type, source, target, created_at) VALUES
        ('${TID}', 'adjudicate', 'auto_dispute', '{"contribution_id":"${CID}","requires_tier":"strong","reason":"投太多輪"}', now() - interval '40 minutes');
      INSERT INTO lease_events(task_id, agent_name, ip_hash, event, at) VALUES ('${TID}', '強模型甲', 'secret-hash', 'issued', now() - interval '30 minutes');
      INSERT INTO contributions(id, contribution_type, payload, agent_name, status, reviewed_by, created_at)
        VALUES ('${AID}', 'adjudication', '{"contribution_id":"${CID}","verdict":"reject","reason":"私人理由"}', 'opus', 'applied', 'strong-adjudication', now() - interval '20 minutes');
      INSERT INTO strong_adjudications(task_id, contribution_id, status, verdict, finalized_at, reasoning, cause_note)
        VALUES ('${TID}', '${CID}', 'finalized', 'reject', now() - interval '19 minutes', '私人推理', '私人原因'),
               ('${TID}', '99999999-9999-9999-9999-999999999999', 'finalized', 'uphold', now() - interval '5 minutes', '私人推理', '私人原因');`);
    const rows = (await db.query<{ kind: string; agent_name: string | null; detail: Record<string, unknown> }>(
      `SELECT kind, agent_name, detail FROM trace_events(p_since => now() - interval '1 hour', p_until => now() + interval '1 minute')`)).rows;
    const by = (k: string) => rows.filter((r) => r.kind === k);
    assertEquals(by("disputed").length, 1);
    assertEquals([by("disputed")[0].detail.overvoted, by("disputed")[0].detail.strong], [true, true]);
    assertEquals(by("strong_claim").length, 1);
    assertEquals(by("strong_claim")[0].agent_name, "強模型甲");
    // 定案：裁決交件那筆＋表裡另一件（第一筆在 30 分鐘內已有裁決交件，不重複）
    assertEquals(by("strong_finalized").map((r) => r.detail.verdict).sort(), ["reject", "uphold"]);
    const text = JSON.stringify(rows);
    for (const bad of ["私人理由", "私人推理", "私人原因", "secret-hash", "strong-adjudication"]) assert(!text.includes(bad), `回了 ${bad}`);
    const one = await kindsOf(db, `p_contribution_id => '${CID}', p_since => now() - interval '1 hour', p_until => now() + interval '1 minute'`);
    for (const k of ["disputed", "strong_claim", "strong_finalized"]) assert(one.includes(k), `交件模式缺 ${k}：${one}`);
    // 仍停在 disputed 且還沒有裁決任務的，用狀態變更時間
    await db.exec(`UPDATE contributions SET status = 'disputed', last_activity = 'status:disputed', last_activity_at = now() - interval '2 minutes' WHERE id = '${CID}'; DELETE FROM contribution_tasks;`);
    const d2 = await kindsOf(db, "p_since => now() - interval '1 hour', p_until => now() + interval '1 minute'");
    assert(d2.includes("disputed"));
  });
});

Deno.test("還原驗證：拿掉強模型分支時限 → 紅", () => {
  const noBound = mutate(REAL, "s.finalized_at >= GREATEST(v_since, now() - interval '14 days')", "s.finalized_at >= v_since");
  assert(problemsOf(noBound, leaseDays).some((p) => p.includes("沒有 >= 時限")));
  const noLease = mutate(REAL, "l.at >= GREATEST(v_since, now() - interval '13 days') AND l.at < v_until AND (v_all OR c.id", "l.at < v_until AND (v_all OR c.id");
  assert(problemsOf(noLease, leaseDays).some((p) => p.includes("沒有 >= 時限")));
});

Deno.test("還原驗證：strong_adjudications 多讀 reasoning／cause_note／model → 紅", () => {
  for (const col of ["reasoning", "cause_note", "model", "report_response"]) {
    const bad = mutate(REAL, "jsonb_build_object('verdict', s.verdict,", `jsonb_build_object('x', s.${col}, 'verdict', s.verdict,`);
    assert(problemsOf(bad, leaseDays).some((p) => p.includes(`s.${col}`)), `${col} 應該被抓到`);
  }
});
