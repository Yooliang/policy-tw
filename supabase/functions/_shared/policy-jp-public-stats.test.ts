/**
 * 日本站公開統計 SQL（給站務主控台 policy-console 讀；migration 20261009200000_policy_jp_public_stats.sql）的行為與走樣守門。
 *
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。PGlite 上套 #479 的空 schema、tables migration、
 * 派工 migration（130000）、選舉發現（130100），再套這支；資料庫裡沒有任何正見（public）物件，漏了 policy_jp. 前綴的引用會直接壞掉。
 *
 *   1. 行為（anon 身分呼叫）：貢獻榜（天數版、區間版）、貢獻統計 contribution_feed_summary、提交與驗證 contribution_activity、
 *      各模型交件與投票、管線快照 pipeline_snapshots_since——對照「從種子資料在 JS 獨立重算」的結果
 *   2. excluded_agents：出廠是空的（沒有人被排除）；INSERT 一列，榜與「貢獻者」數字立刻生效
 *   3. 權限：anon／authenticated 不能讀任何內部表（含 pipeline_snapshots、excluded_agents）、不能寫；能執行的函式恰好是 tables migration 的兩支加這支的 7 支統計函式；
 *      pipeline_take_snapshot 等內部函式 anon 呼叫被擋
 *   4. 不洩漏：所有輸出的 JSON 鍵與欄位名都在白名單內（逐一登記的身份相關欄位只有 agent_name、model、raw_tools[].tool）；
 *      種子資料裡的 IP 雜湊、備註、網址、payload 的標記字串一個都不能出現在輸出裡
 *   5. 管線快照：採樣函式的計數、公開讀取的下界（90 天）與上限（1000 筆、保留最近的）、排程（有 pg_cron 就排、沒有就略過）、migration 重跑
 *   6. 走樣（#498 慣例）：每支複本函式還原回正見的「最新定義」逐字比對；扣掉登記的片段；新加函式不登記就紅；還原驗證（改一個字元就紅）
 *   7. 還原驗證：把 migration 改壞（給 anon 表權限、加 Public read、拿掉 RLS、給 anon 執行內部函式、函式提到 public.、輸出夾帶 IP 雜湊），
 *      migration 的自我檢查或這裡的洩漏偵測要抓得到
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, migrationNames, readMig } from "./arms-pglite.ts";
import { modelDisplayName } from "./model-name.ts";

const SCHEMA_SQL = await readMig("20261008195000_policy_jp_schema.sql");
const TABLES_SQL = await readMig("20261009000000_policy_jp_tables.sql");
const DISPATCH_SQL = await readMig("20261009130000_policy_jp_dispatch.sql");
const ED_SQL = await readMig("20261009130100_policy_jp_election_discovery.sql");
const MIG = "20261009200000_policy_jp_public_stats.sql";
const MIG_SQL = await readMig(MIG);

function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `還原驗證：要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
  return sql.replace(from, () => to);
}

const PRE_SQL = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
/** 套到這支之前的資料庫（不含這支） */
async function baseDb(pre = ""): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PRE_SQL);
  if (pre) await db.exec(pre);
  await db.exec(SCHEMA_SQL);
  await db.exec(TABLES_SQL);
  await db.exec(DISPATCH_SQL);
  await db.exec(ED_SQL);
  return db;
}

async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}
/** 以某角色執行，整張結果轉成 JSON（bigint 變一般數字、jsonb 欄位保持物件） */
async function jrows(db: PGlite, role: string, sql: string): Promise<Record<string, unknown>[]> {
  const rows = await asRole<{ j: Record<string, unknown> }>(db, role, `SELECT to_jsonb(q) AS j FROM (${sql}) q`);
  return rows.map((r) => r.j);
}
async function jvalue<T>(db: PGlite, role: string, sql: string): Promise<T> {
  return (await asRole<{ v: T }>(db, role, `SELECT (${sql}) AS v`))[0].v;
}
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

// ---------------------------------------------------------------------------------------------
// 種子資料：年齡一律用「幾小時前」，期望值在 JS 從同一份清單獨立重算
// ---------------------------------------------------------------------------------------------
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
type C = { id: string; agent: string; tool: string | null; type: string; status: string; ageH: number; outcome?: string };
const DAY = 24;
const CONTRIBS: C[] = [
  { id: uid(1), agent: "alice-agent", tool: "claude-opus-4-5", type: "correction", status: "applied", ageH: 2 },
  { id: uid(2), agent: "alice-agent", tool: "claude-opus-4-5", type: "correction", status: "applied", ageH: 5 },
  { id: uid(3), agent: "alice-agent", tool: "claude-opus-4-5", type: "no_change", status: "rejected", ageH: 20, outcome: "not_found" },
  { id: uid(4), agent: "bob-agent", tool: "gpt-5", type: "correction", status: "pending", ageH: 3 },
  { id: uid(5), agent: "bob-agent", tool: "gpt-5", type: "correction", status: "disputed", ageH: 100 },
  { id: uid(6), agent: "carol-agent", tool: null, type: "task_suggestion", status: "applied", ageH: 20 * DAY },
  { id: uid(7), agent: "carol-agent", tool: "claude-sonnet-5", type: "no_change", status: "verified", ageH: 40 * DAY, outcome: "confirmed" },
  { id: uid(8), agent: "dave-agent", tool: "claude-opus-4-5", type: "correction", status: "applied", ageH: 100 * DAY },
  { id: uid(9), agent: "test-agent-x", tool: "claude-opus-4-5", type: "correction", status: "applied", ageH: 4 },
  { id: uid(10), agent: "test-agent-x", tool: null, type: "correction", status: "pending", ageH: 6 },
  { id: uid(11), agent: "erin-agent", tool: "deepseek-v4-pro", type: "correction", status: "apply_failed", ageH: 8 },
];
type V = { cid: string; agent: string; tool: string | null; verdict: "agree" | "disagree" | "unsure"; via?: string; ageH: number };
const VOTES: V[] = [
  { cid: uid(4), agent: "alice-agent", tool: "claude-opus-4-5", verdict: "agree", ageH: 1 }, // 目標 pending：不進模型投票
  { cid: uid(1), agent: "bob-agent", tool: "gpt-5", verdict: "agree", ageH: 1 }, // applied，投對
  { cid: uid(3), agent: "bob-agent", tool: "gpt-5", verdict: "agree", ageH: 18 }, // rejected，投錯
  { cid: uid(3), agent: "erin-agent", tool: "deepseek-v4-pro", verdict: "disagree", ageH: 17 }, // rejected，投對
  { cid: uid(1), agent: "jev-system", tool: "jev", verdict: "agree", via: "system", ageH: 2 }, // 系統票
  { cid: uid(2), agent: "carol-agent", tool: null, verdict: "disagree", ageH: 25 }, // applied，投錯
  { cid: uid(2), agent: "dave-agent", tool: "claude-sonnet-5", verdict: "unsure", ageH: 50 * DAY },
  { cid: uid(1), agent: "test-agent-x", tool: "claude-opus-4-5", verdict: "agree", ageH: 3 },
  { cid: uid(8), agent: "alice-agent", tool: "claude-opus-4-5", verdict: "agree", ageH: 95 * DAY }, // 超過 90 天：模型統計不收，總榜收
];
const EXCLUDED = ["test-agent-x"];
const MARK_IP_C = "IPHASH-SECRET-C";
const MARK_IP_V = "IPHASH-SECRET-V";
const MARKS = ["IPHASH-SECRET", "LEAKMARK"];

const statusOf = (cid: string) => CONTRIBS.find((c) => c.id === cid)!.status;
/** age 落在 [sinceH 小時前, untilH 小時前) 之內（sinceH／untilH 空白＝不設界）；SQL 的 created_at >= since AND created_at < until */
const within = (ageH: number, sinceH: number | null, untilH: number | null) => (sinceH === null || ageH <= sinceH) && (untilH === null || ageH > untilH);

async function seed(db: PGlite) {
  // 關掉使用者觸發器與外鍵：種子資料要原樣進去（共識觸發器會改狀態）
  await db.exec(`SET session_replication_role = replica`);
  for (const [i, c] of CONTRIBS.entries()) {
    await db.query(
      `INSERT INTO policy_jp.contributions (id, contribution_type, payload, source_urls, note, agent_name, agent_tool, contributor_url, contributor_ip_hash, payload_hash, status, created_at)
       VALUES ($1, $2, $3::jsonb, ARRAY['https://leakmark.example.jp/src'], 'LEAKMARK-NOTE', $4, $5, 'https://leakmark.example.jp/me', $6, $7, $8, now() - make_interval(hours => $9::int))`,
      [c.id, c.type, JSON.stringify({ outcome: c.outcome ?? null, memo: "LEAKMARK-PAYLOAD" }), c.agent, c.tool, `${MARK_IP_C}-${i}`, `hash-${i}`, c.status, c.ageH],
    );
  }
  for (const [i, v] of VOTES.entries()) {
    await db.query(
      `INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, note, agent_name, agent_tool, verifier_ip_hash, via, created_at)
       VALUES ($1, $2, 'LEAKMARK-NOTE', $3, $4, $5, $6, now() - make_interval(hours => $7::int))`,
      [v.cid, v.verdict, v.agent, v.tool, `${MARK_IP_V}-${i}`, v.via ?? null, v.ageH],
    );
  }
  // 派工佇列：兩種自動缺口（3 件）、手動任務 2 件 open（一件是裁決）＋1 件 closed
  for (const [id, type] of [["auto:policy_missing:a", "policy_missing"], ["auto:policy_missing:b", "policy_missing"], ["auto:profile_gap:c", "profile_gap"]]) {
    await db.query(`INSERT INTO policy_jp.task_dispatches (task_id, task_type, target, what_we_need) VALUES ($1, $2, '{}'::jsonb, 'x')`, [id, type]);
  }
  await db.exec(`INSERT INTO policy_jp.contribution_tasks (title, task_type, status) VALUES ('a', 'adjudicate', 'open'), ('b', 'policy_missing', 'open'), ('c', 'policy_missing', 'closed')`);
  // 日本站的資料量：政策與人物各一筆 published、一筆 pending（只數 published）
  await db.exec(`INSERT INTO policy_jp.politicians (id, name, kana, review_status) VALUES ('p1', '山田', 'やまだ', 'published'), ('p2', '佐藤', 'さとう', 'pending')`);
  await db.exec(`INSERT INTO policy_jp.policies (id, title, description, category, origin, status, review_status) VALUES
    ('pol1', 't', 'd', 'c', 'policy_address', 'in_progress', 'published'), ('pol2', 't', 'd', 'c', 'policy_address', 'in_progress', 'pending')`);
  await db.exec(`RESET session_replication_role`);
}

// ---------------------------------------------------------------------------------------------
// 期望值（JS 獨立重算）
// ---------------------------------------------------------------------------------------------
type Board = { agent_name: string; submitted: number; applied: number; verified_votes: number; score: number };
/** 榜的排序鍵（分數、上線、提交）完全相同的人，SQL 沒有規定先後；比對前一律用代號補成確定的順序 */
const canon = (b: Board[]) => [...b].sort((x, y) => y.score - x.score || y.applied - x.applied || y.submitted - x.submitted || x.agent_name.localeCompare(y.agent_name));
function expectedBoard(excluded: string[], sinceH: number | null, untilH: number | null): Board[] {
  const m = new Map<string, Board>();
  const row = (a: string) => m.get(a) ?? (m.set(a, { agent_name: a, submitted: 0, applied: 0, verified_votes: 0, score: 0 }), m.get(a)!);
  for (const c of CONTRIBS) if (within(c.ageH, sinceH, untilH)) { row(c.agent).submitted++; if (c.status === "applied") row(c.agent).applied++; }
  for (const v of VOTES) if (within(v.ageH, sinceH, untilH)) row(v.agent).verified_votes++;
  return canon([...m.values()]
    .filter((r) => !excluded.includes(r.agent_name))
    .map((r) => ({ ...r, score: r.submitted + r.applied + r.verified_votes }))
    .filter((r) => r.score > 0)).slice(0, 30);
}
const countBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

const NINETY = 90 * DAY;
type ModelRow = Record<string, unknown>;
function expectedModelContribs(sinceH: number | null, untilH: number | null): ModelRow[] {
  const cs = CONTRIBS.filter((c) => c.ageH <= (sinceH === null ? NINETY : Math.min(sinceH, NINETY)) && within(c.ageH, null, untilH));
  const sum = (xs: C[], model: string | null, type: string | null): ModelRow => {
    const f = (p: (c: C) => boolean) => xs.filter(p).length;
    const DATA = ["policy", "politician", "candidacy", "correction"];
    return {
      model, contribution_type: type, submitted: xs.length,
      applied: f((c) => c.status === "applied"), rejected: f((c) => c.status === "rejected"), pending: f((c) => c.status === "pending"),
      verified: f((c) => c.status === "verified"), disputed: f((c) => c.status === "disputed"), superseded: f((c) => c.status === "superseded"),
      withdrawn: f((c) => c.status === "withdrawn"),
      other_status: f((c) => !["applied", "rejected", "pending", "verified", "disputed", "superseded", "withdrawn"].includes(c.status)),
      no_change: f((c) => c.type === "no_change"),
      no_change_missing: f((c) => c.type === "no_change" && ["not_found", "unreachable"].includes(c.outcome ?? "")),
      data_decided: f((c) => DATA.includes(c.type) && ["applied", "rejected"].includes(c.status)),
      data_rejected: f((c) => DATA.includes(c.type) && c.status === "rejected"),
    };
  };
  const out: ModelRow[] = [];
  const models = [...new Set(cs.map((c) => modelDisplayName(c.tool)))].sort();
  for (const m of models) {
    const mine = cs.filter((c) => modelDisplayName(c.tool) === m);
    out.push(sum(mine, m, null));
    for (const t of [...new Set(mine.map((c) => c.type))].sort()) out.push(sum(mine.filter((c) => c.type === t), m, t));
  }
  return out;
}
const SYSTEM_MODEL = "系統票（Jev）";
/** 排序鍵相同（票數相同）或排序規則（collation）不同的列，SQL 與 JS 的先後可能不一樣；比對前兩邊都用同一個確定的順序 */
const normVotes = (rs: Record<string, unknown>[]) => [...rs].sort((a, b) => Number(b.votes) - Number(a.votes) || (String(a.model) < String(b.model) ? -1 : 1));
const normModels = (rs: Record<string, unknown>[]) =>
  [...rs].sort((a, b) => (String(a.model) < String(b.model) ? -1 : String(a.model) > String(b.model) ? 1 : a.contribution_type === null ? -1 : b.contribution_type === null ? 1 : String(a.contribution_type) < String(b.contribution_type) ? -1 : 1));
function expectedModelVotes(sinceH: number | null, untilH: number | null) {
  const vs = VOTES.filter((v) =>
    v.ageH <= (sinceH === null ? NINETY : Math.min(sinceH, NINETY)) && within(v.ageH, null, untilH) && ["applied", "rejected"].includes(statusOf(v.cid)));
  const modelOf = (v: V) => (v.agent.startsWith("jev") || /system/i.test(v.via ?? "") || modelDisplayName(v.tool) === "Jev（系統）" ? SYSTEM_MODEL : modelDisplayName(v.tool));
  const models = [...new Set(vs.map(modelOf))];
  return models.map((model) => {
    const mine = vs.filter((v) => modelOf(v) === model);
    const tools = countBy(mine, (v) => v.tool ?? "");
    const toolName = (t: string) => (t === "" ? null : t); // 代理沒填 agent_tool＝SQL 的 NULL
    return {
      model, votes: mine.length,
      agree: mine.filter((v) => v.verdict === "agree").length, disagree: mine.filter((v) => v.verdict === "disagree").length, unsure: mine.filter((v) => v.verdict === "unsure").length,
      wrong: mine.filter((v) => (v.verdict === "agree" && statusOf(v.cid) === "rejected") || (v.verdict === "disagree" && statusOf(v.cid) === "applied")).length,
      raw_tools: Object.entries(tools).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tool, n]) => ({ tool: toolName(tool), n })),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// 共用資料庫（主）：套完整支、灌種子，後面的測試只讀（會改的測試用完還原）
// ---------------------------------------------------------------------------------------------
const main = await baseDb();
await main.exec(MIG_SQL);
await seed(main);

const ANON_STATS = [
  "contribution_activity(p_hours integer)",
  "contribution_feed_summary()",
  "contribution_leaderboard(p_days integer)",
  "contribution_leaderboard(p_since timestamp with time zone, p_until timestamp with time zone)",
  "model_contribution_stats(p_since timestamp with time zone, p_until timestamp with time zone)",
  "model_vote_stats(p_since timestamp with time zone, p_until timestamp with time zone)",
  "pipeline_snapshots_since(p_since timestamp with time zone)",
];
const FROM_TABLES_MIG = ["election_level(p_election_type text)", "lg_code_valid(p_code text)"];
const SERVICE_ONLY = ["contribution_auto_task_counts(p_region text)", "model_display_name(p_agent_tool text)", "pipeline_take_snapshot()"];

Deno.test("套用：public 一個物件都沒有、新表開 RLS 且沒有 policy、套兩次都成功", async () => {
  const pubT = await one<{ n: number }>(main, `SELECT count(*)::INT AS n FROM pg_tables WHERE schemaname = 'public'`);
  assertEquals(pubT.n, 0, "public 不該有任何表");
  const pubF = await one<{ n: number }>(main, `SELECT count(*)::INT AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
  assertEquals(pubF.n, 0, "public 不該有任何函式");
  const rls = await main.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy_jp' AND c.relname IN ('excluded_agents', 'pipeline_snapshots')`);
  assertEquals(rls.rows.length, 2);
  for (const r of rls.rows) assert(r.relrowsecurity, `${r.relname} 沒開 RLS`);
  // 內部表慣例：不開 Public read、也沒有 Service role write（service_role 靠 BYPASSRLS）
  assertEquals((await one<{ n: number }>(main, `SELECT count(*)::INT AS n FROM pg_policies WHERE schemaname = 'policy_jp' AND tablename IN ('excluded_agents', 'pipeline_snapshots')`)).n, 0);
  assertEquals((await one<{ n: number }>(main, `SELECT count(*)::INT AS n FROM policy_jp.excluded_agents`)).n, 0, "出廠是空表（日本站沒有種子）");
});

Deno.test("excluded_agents：出廠是空的＝沒有人被排除；INSERT 一列，榜與貢獻者數字立刻生效（之後的測試都在排除 test-agent-x 的狀態）", async () => {
  const names = (b: Board[]) => b.map((x) => x.agent_name);
  const before = canon(await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`));
  assertEquals(before, expectedBoard([], null, null));
  assert(names(before).includes("test-agent-x"), "空的排除表：測試代號照常上榜");
  const feed0 = await jvalue<Record<string, unknown>>(main, "anon", `policy_jp.contribution_feed_summary()`);
  assertEquals(feed0.contributors_total, new Set(CONTRIBS.map((c) => c.agent)).size);

  await main.exec(`INSERT INTO policy_jp.excluded_agents (agent_name, reason) VALUES ('test-agent-x', '測試')`);
  const after = canon(await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`));
  assertEquals(after, expectedBoard(EXCLUDED, null, null));
  assert(!names(after).includes("test-agent-x"));
  const feed1 = await jvalue<Record<string, unknown>>(main, "anon", `policy_jp.contribution_feed_summary()`);
  assertEquals(feed1.contributors_total, new Set(CONTRIBS.filter((c) => !EXCLUDED.includes(c.agent)).map((c) => c.agent)).size);
  // CHECK：前後有空白、空字串的代號進不去
  await assertRejects(() => main.exec(`INSERT INTO policy_jp.excluded_agents (agent_name, reason) VALUES (' x ', 'r')`), Error);
  await assertRejects(() => main.exec(`INSERT INTO policy_jp.excluded_agents (agent_name, reason) VALUES ('', 'r')`), Error);
});

Deno.test("貢獻榜：天數版與區間版（anon 呼叫）＝從種子獨立重算；總榜 = 提交 + 上線 + 驗證票，同分先看上線再看提交", async () => {
  assertEquals(canon(await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`)), expectedBoard(EXCLUDED, null, null));
  assertEquals(canon(await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(30)`)), expectedBoard(EXCLUDED, 30 * DAY, null));
  assertEquals(canon(await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(7)`)), expectedBoard(EXCLUDED, 7 * DAY, null));
  // 區間版：兩個參數都必填，NULL＝不設界
  const q = (s: string, u: string) => `policy_jp.contribution_leaderboard(${s}, ${u})`;
  assertEquals(canon(await jvalue<Board[]>(main, "anon", q(`now() - interval '36 hours'`, "NULL"))), expectedBoard(EXCLUDED, 36, null));
  assertEquals(canon(await jvalue<Board[]>(main, "anon", q(`now() - interval '24 hours'`, `now() - interval '90 minutes'`))), expectedBoard(EXCLUDED, 24, 1.5));
  assertEquals(canon(await jvalue<Board[]>(main, "anon", q("NULL", "NULL"))), expectedBoard(EXCLUDED, null, null));
  assertEquals(canon(await jvalue<Board[]>(main, "anon", q("NULL", `now() - interval '10 days'`))), expectedBoard(EXCLUDED, null, 10 * DAY));
  // 排序規則自己也驗一次：carol（4 分、上線 1）排在 bob（4 分、上線 0）前面
  const all = await jvalue<Board[]>(main, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`);
  const order = all.map((b) => b.agent_name);
  assert(order.indexOf("carol-agent") < order.indexOf("bob-agent"));
  // 一個參數的 NULL 不會在兩個多載之間分不出來（天數版要明確寫型別、區間版兩個都要給）
  await assertRejects(() => asRole(main, "anon", `SELECT policy_jp.contribution_leaderboard(NULL::timestamptz)`), Error);
});

Deno.test("貢獻統計 contribution_feed_summary：總數、各狀態、需要處理、貢獻者、近 7 日、三個榜", async () => {
  const s = await jvalue<Record<string, any>>(main, "anon", `policy_jp.contribution_feed_summary()`);
  assertEquals(s.total, CONTRIBS.length);
  assertEquals(s.by_status, countBy(CONTRIBS, (c) => c.status));
  assertEquals(s.needs_attention, { total: 1, disputed: 1, retrying: 1 });
  assertEquals(s.adjudicating, 1, "open 的 adjudicate 任務數");
  const real = CONTRIBS.filter((c) => !EXCLUDED.includes(c.agent));
  assertEquals(s.contributors_total, new Set(real.map((c) => c.agent)).size);
  assertEquals(s.contributors_30d, new Set(real.filter((c) => c.ageH <= 30 * DAY).map((c) => c.agent)).size);
  assertEquals(canon(s.leaderboard), expectedBoard(EXCLUDED, null, null));
  assertEquals(canon(s.leaderboard_30d), expectedBoard(EXCLUDED, 30 * DAY, null));
  assertEquals(canon(s.leaderboard_7d), expectedBoard(EXCLUDED, 7 * DAY, null));
  // 近 7 日（台北日曆日）：7 筆、日期升冪、加總＝近 7 天內的筆數（種子不是在 96 小時內就是 20 天前）
  assertEquals(s.daily_last_7.length, 7);
  const dates = s.daily_last_7.map((d: { date: string }) => d.date);
  assertEquals(dates, [...dates].sort());
  assertEquals(s.daily_last_7.reduce((a: number, d: { count: number }) => a + d.count, 0), CONTRIBS.filter((c) => c.ageH <= 100).length);
  assertEquals(s.daily_last_7.reduce((a: number, d: { verifications: number }) => a + d.verifications, 0), VOTES.filter((v) => v.ageH <= 100).length);
});

Deno.test("提交與驗證 contribution_activity：48 小時內按小時、以上按天；加總＝種子", async () => {
  const hours = await jrows(main, "anon", `SELECT * FROM policy_jp.contribution_activity(48)`);
  assertEquals(hours.length, 48);
  assert(hours.every((r) => /^\d\d:00$/.test(String(r.bucket))), "小時桶：HH:00");
  assertEquals(hours.reduce((a, r) => a + Number(r.submissions), 0), CONTRIBS.filter((c) => c.ageH <= 40).length);
  assertEquals(hours.reduce((a, r) => a + Number(r.verifications), 0), VOTES.filter((v) => v.ageH <= 40).length);
  const days = await jrows(main, "anon", `SELECT * FROM policy_jp.contribution_activity(168)`);
  assert(days.length === 7 || days.length === 8, `日桶 7 或 8 筆（${days.length}）`);
  assert(days.every((r) => /^\d\d-\d\d$/.test(String(r.bucket))), "日桶：MM-DD");
  assertEquals(days.reduce((a, r) => a + Number(r.submissions), 0), CONTRIBS.filter((c) => c.ageH <= 160).length);
  assertEquals(days.reduce((a, r) => a + Number(r.verifications), 0), VOTES.filter((v) => v.ageH <= 160).length);
  // 上限 90 天：給再大的值也只回 90 天的桶
  assert((await jrows(main, "anon", `SELECT * FROM policy_jp.contribution_activity(100000)`)).length <= 91);
});

Deno.test("各模型交件與投票：anon 呼叫＝從種子獨立重算（模型名用 TS 的 modelDisplayName）；下界不早於 90 天", async () => {
  const sortRows = normModels;
  const got = await jrows(main, "anon", `SELECT model, contribution_type, submitted, applied, rejected, pending, verified, disputed, superseded, withdrawn, other_status, no_change, no_change_missing, data_decided, data_rejected FROM policy_jp.model_contribution_stats(NULL, NULL)`);
  assertEquals(sortRows(got), sortRows(expectedModelContribs(null, null)));
  assert(!got.some((r) => r.model === "Claude Opus 4.5" && r.contribution_type === null && Number(r.submitted) === 5), "100 天前那筆不進模型統計");
  // 區間：最近 36 小時、不含最近 1.5 小時
  const ranged = await jrows(main, "anon", `SELECT model, contribution_type, submitted, applied, rejected, pending, verified, disputed, superseded, withdrawn, other_status, no_change, no_change_missing, data_decided, data_rejected FROM policy_jp.model_contribution_stats(now() - interval '36 hours', now() - interval '90 minutes')`);
  assertEquals(sortRows(ranged), sortRows(expectedModelContribs(36, 1.5)));
  // raw_tools 只在模型列、是代理自填的原字串與筆數
  const raws = await jrows(main, "anon", `SELECT model, contribution_type, raw_tools FROM policy_jp.model_contribution_stats(NULL, NULL) WHERE contribution_type IS NULL AND model = 'Claude Opus 4.5'`);
  assertEquals(raws[0].raw_tools, [{ tool: "claude-opus-4-5", n: 4 }]);
  assertEquals((await jrows(main, "anon", `SELECT raw_tools FROM policy_jp.model_contribution_stats(NULL, NULL) WHERE contribution_type IS NOT NULL`)).every((r) => r.raw_tools === null), true);

  const votes = await jrows(main, "anon", `SELECT model, votes, agree, disagree, unsure, wrong, raw_tools FROM policy_jp.model_vote_stats(NULL, NULL)`);
  assertEquals(normVotes(votes), normVotes(expectedModelVotes(null, null)));
  assert(votes.some((v) => v.model === SYSTEM_MODEL), "系統票單獨一列");
  const ranged2 = await jrows(main, "anon", `SELECT model, votes, agree, disagree, unsure, wrong, raw_tools FROM policy_jp.model_vote_stats(now() - interval '30 hours', now() - interval '90 minutes')`);
  assertEquals(normVotes(ranged2), normVotes(expectedModelVotes(30, 1.5)));
});

Deno.test("model_display_name：SQL 規則表對 TS 的 modelDisplayName 逐一對得上（service_role 呼叫）", async () => {
  const samples = ["claude-opus-4-5", "gpt-5", "claude-sonnet-5", "deepseek-v4-pro", "jev", "Claude Code/claude-haiku-4.5", "qwen-3-max", "gemini-2.5-pro", "", "  ", "unknown-model-zzz"];
  for (const s of samples) {
    const r = await one<{ n: string }>(main, `SELECT policy_jp.model_display_name(NULLIF($1, '')) AS n`, [s]);
    assertEquals(r.n, modelDisplayName(s === "" ? null : s), `agent_tool「${s}」`);
  }
});

Deno.test("管線快照：採樣函式的計數（service_role）、公開讀取只回五個欄位、下界 90 天、p_since 空白＝近 31 天", async () => {
  const id = (await one<{ id: string }>(main, `SELECT policy_jp.pipeline_take_snapshot() AS id`)).id;
  const row = await one<Record<string, unknown>>(main, `SELECT * FROM policy_jp.pipeline_snapshots WHERE id = $1`, [id]);
  assertEquals(row.pending, CONTRIBS.filter((c) => c.status === "pending").length);
  assertEquals(row.applied, CONTRIBS.filter((c) => c.status === "applied").length);
  assertEquals(row.disputed, 1);
  assertEquals(row.rejected, 1);
  assertEquals(row.votes_total, VOTES.length);
  assertEquals(row.voters, new Set(VOTES.map((v) => v.agent)).size);
  assertEquals(row.policies, 1, "只數 published");
  assertEquals(row.politicians, 1, "只數 published");
  assertEquals(row.tasks_by_type, { policy_missing: 2, profile_gap: 1, manual_open: 2 });
  assertEquals(row.tasks_open, 5);
  assert(!("questions" in row), "日本站沒有 questions 欄");

  // 舊的兩筆：100 天前（超過下界）、40 天前
  await main.exec(`INSERT INTO policy_jp.pipeline_snapshots (taken_at, pending, applied, votes_total, tasks_by_type) VALUES
    (now() - interval '100 days', 1, 1, 1, '{"old":1}'), (now() - interval '40 days', 2, 2, 2, '{"mid":1}')`);
  const recent = await jrows(main, "anon", `SELECT * FROM policy_jp.pipeline_snapshots_since(now() - interval '1 day')`);
  assert(recent.length >= 1);
  assertEquals(Object.keys(recent[0]).sort(), ["applied", "pending", "taken_at", "tasks_by_type", "votes_total"]);
  const wide = await jrows(main, "anon", `SELECT * FROM policy_jp.pipeline_snapshots_since(now() - interval '200 days')`);
  assert(wide.some((r) => (r.tasks_by_type as Record<string, number>).mid === 1), "40 天前的收");
  assert(!wide.some((r) => (r.tasks_by_type as Record<string, number>).old === 1), "100 天前的不收（下界 90 天）");
  const dflt = await jrows(main, "anon", `SELECT * FROM policy_jp.pipeline_snapshots_since(NULL)`);
  assert(!dflt.some((r) => (r.tasks_by_type as Record<string, number>).mid === 1), "p_since 空白＝近 31 天，40 天前的不收");
  const times = wide.map((r) => String(r.taken_at));
  assertEquals(times, [...times].sort(), "由舊到新");
  await main.exec(`DELETE FROM policy_jp.pipeline_snapshots WHERE tasks_by_type ? 'old' OR tasks_by_type ? 'mid'`);
});

Deno.test("權限：anon／authenticated 不能讀任何內部表、不能寫；能執行的函式恰好是 tables migration 的兩支＋7 支統計函式", async () => {
  const INTERNAL = [
    "task_priority_tiers", "contributions", "contribution_votes", "edit_history", "contribution_tasks", "contribution_task_leases", "contribution_task_skips",
    "verify_dispatches", "task_checks", "jev_decisions", "task_dispatches", "gap_events", "election_milestones", "activity_rules", "activity_overrides",
    "dispatch_records_settings", "excluded_agents", "pipeline_snapshots",
  ];
  for (const role of ["anon", "authenticated"]) {
    for (const t of INTERNAL) {
      await assertRejects(() => asRole(main, role, `SELECT count(*) FROM policy_jp.${t}`), Error, "permission denied", `${role} 不該讀得到 ${t}`);
    }
    await assertRejects(() => asRole(main, role, `INSERT INTO policy_jp.pipeline_snapshots (pending) VALUES (1)`), Error, "permission denied");
    await assertRejects(() => asRole(main, role, `INSERT INTO policy_jp.excluded_agents (agent_name, reason) VALUES ('zz', 'r')`), Error, "permission denied");
    await assertRejects(() => asRole(main, role, `DELETE FROM policy_jp.excluded_agents`), Error, "permission denied");
    // 內部函式 anon 呼叫被擋
    await assertRejects(() => asRole(main, role, `SELECT policy_jp.pipeline_take_snapshot()`), Error, "permission denied");
    await assertRejects(() => asRole(main, role, `SELECT * FROM policy_jp.contribution_auto_task_counts(NULL)`), Error, "permission denied");
    await assertRejects(() => asRole(main, role, `SELECT policy_jp.model_display_name('gpt-5')`), Error, "permission denied");
  }
  const execFns = async (role: string) =>
    (await main.query<{ f: string }>(
      `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'policy_jp' AND has_function_privilege('${role}', p.oid, 'EXECUTE') ORDER BY 1`)).rows.map((r) => r.f);
  const expected = [...FROM_TABLES_MIG, ...ANON_STATS].sort();
  assertEquals(await execFns("anon"), expected);
  assertEquals(await execFns("authenticated"), expected);
  // service_role 全部能執行（含只給它的三支）
  const svc = await execFns("service_role");
  for (const f of [...ANON_STATS, ...SERVICE_ONLY]) assert(svc.includes(f), `service_role 要能執行 ${f}`);
  // 統計函式一律 SECURITY DEFINER 且釘死 search_path；只給 service_role 的內部函式沒有開 PUBLIC
  const defs = await main.query<{ f: string; secdef: boolean; cfg: string[] | null }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f, p.prosecdef AS secdef, p.proconfig AS cfg
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'policy_jp'`);
  for (const f of ANON_STATS) {
    const d = defs.rows.find((x) => x.f === f)!;
    assert(d.secdef, `${f} 要 SECURITY DEFINER`);
    assertEquals(d.cfg, ["search_path=policy_jp, pg_temp"], `${f} 要釘 search_path`);
  }
});

// ---------------------------------------------------------------------------------------------
// 不洩漏：輸出鍵白名單＋標記字串掃描
// ---------------------------------------------------------------------------------------------
const BOARD_KEYS = ["agent_name", "applied", "score", "submitted", "verified_votes"];
const FEED_KEYS = ["adjudicating", "by_status", "contributors_30d", "contributors_total", "daily_last_7", "leaderboard", "leaderboard_30d", "leaderboard_7d", "needs_attention", "total"];
const MODEL_C_KEYS = ["applied", "contribution_type", "data_decided", "data_rejected", "disputed", "model", "no_change", "no_change_missing", "other_status", "pending", "raw_tools", "rejected", "submitted", "superseded", "verified", "withdrawn"];
const MODEL_V_KEYS = ["agree", "disagree", "model", "raw_tools", "unsure", "votes", "wrong"];

/** 偵測洩漏：回傳發現的問題清單（空＝乾淨）。還原驗證會拿壞掉的 migration 來測它抓不抓得到 */
async function leakFindings(db: PGlite): Promise<string[]> {
  const bad: string[] = [];
  const keys = (o: unknown): string[] => (Array.isArray(o) ? o.flatMap(keys) : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
  const outs: Record<string, unknown> = {
    leaderboard: await jvalue(db, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`),
    leaderboardRange: await jvalue(db, "anon", `policy_jp.contribution_leaderboard(NULL, NULL)`),
    feed: await jvalue(db, "anon", `policy_jp.contribution_feed_summary()`),
    activity: await jrows(db, "anon", `SELECT * FROM policy_jp.contribution_activity(168)`),
    modelC: await jrows(db, "anon", `SELECT * FROM policy_jp.model_contribution_stats(NULL, NULL)`),
    modelV: await jrows(db, "anon", `SELECT * FROM policy_jp.model_vote_stats(NULL, NULL)`),
    snaps: await jrows(db, "anon", `SELECT * FROM policy_jp.pipeline_snapshots_since(NULL)`),
  };
  const text = JSON.stringify(outs);
  for (const m of MARKS) if (text.includes(m)) bad.push(`輸出含標記字串 ${m}`);
  if (/ip_?hash/i.test(text)) bad.push("輸出含 ip_hash 字樣");
  const allowed = (name: string, got: string[], ok: string[]) => {
    const extra = [...new Set(got)].filter((k) => !ok.includes(k));
    if (extra.length) bad.push(`${name} 多出欄位：${extra.join(", ")}`);
  };
  allowed("leaderboard", keys(outs.leaderboard), BOARD_KEYS);
  allowed("leaderboardRange", keys(outs.leaderboardRange), BOARD_KEYS);
  allowed("feed", keys(outs.feed).filter((k) => !/^(pending|applied|rejected|verified|disputed|apply_failed|superseded|withdrawn|reverted)$/.test(k)),
    [...FEED_KEYS, ...BOARD_KEYS, "date", "count", "verifications", "disputed", "retrying", "total"]);
  allowed("activity", keys(outs.activity), ["bucket", "submissions", "verifications"]);
  allowed("modelC", keys(outs.modelC), [...MODEL_C_KEYS, "tool", "n"]);
  allowed("modelV", keys(outs.modelV), [...MODEL_V_KEYS, "tool", "n"]);
  allowed("snaps", keys(outs.snaps).filter((k) => !["policy_missing", "profile_gap", "manual_open"].includes(k)), ["applied", "pending", "taken_at", "tasks_by_type", "votes_total"]);
  // 函式回傳型別：名稱裡不能有 ip／hash／url／payload／note
  const sigs = await main.query<{ r: string }>(
    `SELECT pg_get_function_result(p.oid) AS r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'policy_jp' AND p.proname = ANY($1)`, [["model_contribution_stats", "model_vote_stats", "contribution_activity", "pipeline_snapshots_since"]]);
  for (const s of sigs.rows) if (/ip|hash|url|payload|note|actor/i.test(s.r.replace(/pipeline|snapshots|tool|applied|disputed/gi, ""))) bad.push(`回傳欄位名可疑：${s.r}`);
  return bad;
}

Deno.test("不洩漏：輸出鍵都在白名單內；種子裡的 IP 雜湊、備註、網址、payload 標記一個都沒出現", async () => {
  assertEquals(await leakFindings(main), []);
  // 種子真的有那些標記（不是空轉）：內部表讀得到，輸出裡卻沒有
  const seeded = await one<{ n: number }>(main, `SELECT count(*)::INT AS n FROM policy_jp.contributions WHERE contributor_ip_hash LIKE 'IPHASH-SECRET%' AND note = 'LEAKMARK-NOTE'`);
  assertEquals(seeded.n, CONTRIBS.length);
});

Deno.test("pipeline_snapshots_since：最多 1000 筆、保留最近的、由舊到新", async () => {
  await main.exec(`INSERT INTO policy_jp.pipeline_snapshots (taken_at, tasks_by_type, pending)
    SELECT now() - make_interval(mins => g), '{"bulk":1}', g FROM generate_series(1, 1100) g`);
  const rows = await jrows(main, "anon", `SELECT * FROM policy_jp.pipeline_snapshots_since(now() - interval '5 days')`);
  assertEquals(rows.length, 1000);
  const times = rows.map((r) => String(r.taken_at));
  assertEquals(times, [...times].sort(), "由舊到新");
  // 最舊的 100 筆（pending 1001..1100）被砍，最新的（pending 1）還在
  assert(rows.some((r) => r.pending === 1));
  assert(!rows.some((r) => r.pending === 1100));
  await main.exec(`DELETE FROM policy_jp.pipeline_snapshots WHERE tasks_by_type ? 'bulk'`);
});

// ---------------------------------------------------------------------------------------------
// 排程與重跑（另開一個有 pg_cron 替身的資料庫）
// ---------------------------------------------------------------------------------------------
Deno.test("排程與重跑：有 pg_cron 就排一條每小時（重跑只留一條）、沒有就略過；每次套用補一筆快照", async () => {
  const cron = `CREATE SCHEMA cron; CREATE TABLE cron.job (jobname TEXT, schedule TEXT, command TEXT);
    CREATE FUNCTION cron.schedule(a TEXT, b TEXT, c TEXT) RETURNS BIGINT LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (a, b, c) RETURNING 1::BIGINT $$;
    CREATE FUNCTION cron.unschedule(a TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = a RETURNING true $$;`;
  const db = await baseDb(cron);
  try {
    await db.exec(MIG_SQL);
    await db.exec(MIG_SQL); // 第二次
    const job = await db.query<{ jobname: string; schedule: string; command: string }>(`SELECT * FROM cron.job WHERE jobname LIKE 'policy-jp-pipeline%'`);
    assertEquals(job.rows, [{ jobname: "policy-jp-pipeline-snapshot-hourly", schedule: "0 * * * *", command: "SELECT policy_jp.pipeline_take_snapshot();" }]);
    assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.pipeline_snapshots`)).n, 2, "每次套用補一筆，圖表不是空的");
    // 空資料庫上的快照：全 0、tasks_by_type 只有 manual_open
    const s = await one<Record<string, unknown>>(db, `SELECT * FROM policy_jp.pipeline_snapshots ORDER BY id LIMIT 1`);
    assertEquals([s.pending, s.applied, s.votes_total, s.policies, s.politicians, s.tasks_open], [0, 0, 0, 0, 0, 0]);
    assertEquals(s.tasks_by_type, { manual_open: 0 });
    // 空資料庫上的公開函式也不壞
    assertEquals(await jvalue(db, "anon", `policy_jp.contribution_leaderboard(NULL::integer)`), []);
    const feed = await jvalue<Record<string, unknown>>(db, "anon", `policy_jp.contribution_feed_summary()`);
    assertEquals([feed.total, feed.by_status, feed.contributors_total, feed.leaderboard], [0, {}, 0, []]);
    assertEquals((await jrows(db, "anon", `SELECT * FROM policy_jp.model_contribution_stats(NULL, NULL)`)).length, 0);
    assertEquals((await jrows(db, "anon", `SELECT * FROM policy_jp.model_vote_stats(NULL, NULL)`)).length, 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------------------------
// 走樣守門（#498 慣例）
// ---------------------------------------------------------------------------------------------
type Edit = [string, string];
type Mode = "public" | "none"; // 正見的 SECURITY DEFINER 是 SET search_path = public，或根本沒釘（INVOKER，或 pipeline_take_snapshot 的疏漏）
type Pair = { name: string; sig: RegExp; mode: Mode; definer: boolean; edits?: Edit[]; note?: string };

const PAIRS: Pair[] = [
  { name: "model_display_name", sig: /./, mode: "none", definer: false },
  { name: "contribution_leaderboard", sig: /^\(p_days/, mode: "public", definer: true },
  { name: "contribution_leaderboard", sig: /^\(p_since/, mode: "public", definer: true },
  { name: "contribution_feed_summary", sig: /./, mode: "public", definer: true },
  { name: "contribution_activity", sig: /./, mode: "public", definer: true },
  { name: "model_contribution_stats", sig: /^\(p_since/, mode: "public", definer: true },
  { name: "model_vote_stats", sig: /^\(p_since/, mode: "public", definer: true },
  { name: "contribution_auto_task_counts", sig: /./, mode: "none", definer: false },
  {
    name: "pipeline_take_snapshot", sig: /./, mode: "none", definer: true,
    note: "正見沒釘 search_path（日本站補上，R2）；拿掉 questions（日本站沒有公民提問）；政策與人物只數 published（日本站沒有 removed_at，未發布的不是站上看得到的資料）",
    edits: [
      ["votes_total, voters, policies, politicians, questions\n", "votes_total, voters, policies, politicians\n"],
      ["FROM policies WHERE removed_at IS NULL),", "FROM policies WHERE review_status = 'published'),"],
      ["    (SELECT COUNT(*) FROM politicians),\n    (SELECT COUNT(*) FROM citizen_questions WHERE status <> 'hidden')\n", "    (SELECT COUNT(*) FROM politicians WHERE review_status = 'published')\n"],
    ],
  },
];
/** 不是複本、不比對的函式（原因）：pipeline_snapshots_since——正見把 pipeline_snapshots 開成 Public read 表，日本站不對 anon 開表，改由這支 SECURITY DEFINER 函式代讀 */
const NONCOPY = ["pipeline_snapshots_since"];

function applyEdits(src: string, edits: Edit[] = []): string {
  let s = src;
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 70)}`);
    s = s.replace(from, () => to);
  }
  return s;
}
/** 還原：R1 拿掉 policy_jp. 前綴；R2 search_path（正見是 public 或沒有） */
function reverse(jp: string, mode: Mode): string {
  let s = jp;
  s = mode === "public" ? s.replaceAll("SET search_path = policy_jp, pg_temp", "SET search_path = public") : s.replaceAll(" SET search_path = policy_jp, pg_temp", "");
  return s.replaceAll("policy_jp.", "");
}
/** 一個檔案裡 name 的所有定義（多載都撈出來） */
function allFnTexts(sql: string, name: string): string[] {
  const head = `CREATE OR REPLACE FUNCTION ${name}(`;
  const out: string[] = [];
  let from = 0;
  while (true) {
    const a = sql.indexOf(head, from);
    if (a < 0) break;
    const t = fnText(sql.slice(a), name);
    out.push(t);
    from = a + t.length;
  }
  return out;
}
const argsOf = (t: string) => t.slice(t.indexOf("("), t.indexOf(")") + 1);
/** migrations 裡 name（簽名符合 sig）最後一次的定義（照檔名排序，後蓋前；只看正見的、沒有 policy_jp. 前綴的） */
async function latestPublic(name: string, sig: RegExp): Promise<string> {
  let def: string | null = null;
  for (const n of await migrationNames()) for (const t of allFnTexts(await readMig(n), name)) if (sig.test(argsOf(t))) def = t;
  assert(def, `找不到正見的 ${name} ${sig}`);
  return def;
}
function jpBody(name: string, sig: RegExp): string {
  const found = allFnTexts(MIG_SQL, `policy_jp.${name}`).filter((t) => sig.test(argsOf(t)));
  assertEquals(found.length, 1, `${name} ${sig}：日本版應該剛好一份定義`);
  return found[0];
}
const label = (p: Pair) => `${p.name}${p.sig.source === "." ? "" : p.sig.source.replace("^\\(", "(")}`;

for (const p of PAIRS) {
  Deno.test(`走樣 ${label(p)}：還原後＝正見的現行定義${p.edits?.length ? "（扣掉登記的片段）" : ""}`, async () => {
    const expected = applyEdits(await latestPublic(p.name, p.sig), p.edits);
    const jp = jpBody(p.name, p.sig);
    assertEquals(reverse(jp, p.mode), expected);
    if (p.edits?.length) assert(p.note, `${p.name} 有拿掉片段，必須寫 note 說明為什麼`);
    // SECURITY DEFINER 要跟正見一樣（只有 pipeline_take_snapshot 補上 search_path）
    assertEquals(/SECURITY DEFINER/.test(jp), p.definer, `${p.name}：SECURITY DEFINER`);
    assertEquals(/SECURITY DEFINER/.test(await latestPublic(p.name, p.sig)), p.definer, `${p.name}：正見的 SECURITY DEFINER 變了，要決定日本版跟不跟`);
    // DEFINER 的一律釘 search_path；INVOKER 的熱路徑函式不加 SET（每個引用都帶前綴）
    if (p.definer) assert(jp.includes("SET search_path = policy_jp, pg_temp"), `${p.name} 沒釘 search_path`);
    else assert(!/SET search_path/.test(jp), `${p.name}：INVOKER 函式不加 SET`);
  });
}

/** 建表敘述（CREATE TABLE … ( … );） */
const tableDdl = (sql: string, name: string): string => {
  const a = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  assert(a >= 0, `找不到 ${name} 的建表`);
  return sql.slice(a, sql.indexOf("\n);", a) + 3);
};

Deno.test("走樣：表 excluded_agents、pipeline_snapshots 的欄位、預設值、CHECK 還原後＝正見建表（pipeline_snapshots 扣掉 questions）", async () => {
  const exPub = tableDdl(await readMig("20261008000010_excluded_agents.sql"), "excluded_agents");
  assertEquals(reverse(tableDdl(MIG_SQL, "policy_jp.excluded_agents"), "none"), exPub);
  const snapPub = applyEdits(tableDdl(await readMig("20260912000018_pipeline_snapshots.sql"), "pipeline_snapshots"),
    [["  politicians   INTEGER NOT NULL DEFAULT 0,\n  questions     INTEGER NOT NULL DEFAULT 0\n);", "  politicians   INTEGER NOT NULL DEFAULT 0\n);"]]);
  assertEquals(reverse(tableDdl(MIG_SQL, "policy_jp.pipeline_snapshots"), "none"), snapPub);
  // 之後正見若 ALTER 了這兩張表，這裡要紅，提醒日本站跟著改
  const alters: string[] = [];
  for (const n of await migrationNames()) {
    if (n === MIG) continue;
    const sql = await readMig(n);
    if (/ALTER TABLE (IF EXISTS )?(ONLY )?(public\.)?(pipeline_snapshots|excluded_agents)\s+(ADD|DROP|ALTER|RENAME)\b/.test(sql)) alters.push(n);
  }
  assertEquals(alters, [], "正見改了 pipeline_snapshots／excluded_agents 的欄位，日本版要決定跟不跟");
});

Deno.test("走樣：migration 裡的 policy_jp 函式＝登記的複本＋登記的非複本（新加函式不登記就紅）", () => {
  const defined = [...MIG_SQL.matchAll(/CREATE OR REPLACE FUNCTION policy_jp\.(\w+)\(/g)].map((m) => m[1]).sort();
  assertEquals(defined, [...PAIRS.map((p) => p.name), ...NONCOPY].sort());
  for (const n of NONCOPY) assert(!PAIRS.some((p) => p.name === n), `${n} 是非複本，不能同時登記成複本`);
});

Deno.test("獨立：這支 migration 沒有 public. 引用、沒有 search_path = public，函式與建表都沒有不帶前綴的表引用", () => {
  const body = MIG_SQL.slice(0, MIG_SQL.indexOf("-- 自我檢查：做錯就讓這支 migration 失敗")); // 自我檢查那段會「提到」public. 這個字樣
  const stripped = body.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(stripped), "migration 不能引用 public.");
  assert(!/search_path\s*=\s*public/i.test(stripped), "不能有 search_path = public");
  const tables = ["contributions", "contribution_votes", "contribution_tasks", "excluded_agents", "pipeline_snapshots", "policies", "politicians"];
  const re = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(?:${tables.join("|")})\\b`, "i");
  const m = re.exec(stripped);
  assertEquals(m, null, `有不帶 policy_jp. 前綴的表引用 ${m?.[0]}`);
  // 沒有任何一處把表開給 anon／authenticated／PUBLIC
  assert(!/GRANT\s+(SELECT|ALL|INSERT|UPDATE|DELETE)[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(stripped), "不能把表權限給 anon／authenticated／PUBLIC");
  assert(!/CREATE POLICY/i.test(stripped), "不開 Public read");
});

Deno.test("還原驗證（走樣）：每支複本改一個字元，比對就會紅；白名單以外的替換也抓得到", async () => {
  let n = 0;
  for (const p of PAIRS) {
    const expected = applyEdits(await latestPublic(p.name, p.sig), p.edits);
    const jp = jpBody(p.name, p.sig);
    const bent = jp.replace("AS $$", "AS $$ "); // 一個字元
    assertNotEquals(bent, jp, `${p.name}：還原驗證沒改到東西`);
    assertNotEquals(reverse(bent, p.mode), expected, `${p.name}：改了一個字元卻沒被抓到`);
    n++;
  }
  assertEquals(n, PAIRS.length);
  // 語意上的改動
  const lb = jpBody("contribution_leaderboard", /^\(p_days/);
  const exp = await latestPublic("contribution_leaderboard", /^\(p_days/);
  assertNotEquals(reverse(lb.replace("LIMIT 30", "LIMIT 31"), "public"), exp);
  assertNotEquals(reverse(lb.replace("policy_jp.excluded_agents", "policy_jp.contributions"), "public"), exp);
  // search_path 寫成別的（不是 policy_jp, pg_temp）也抓得到
  assertNotEquals(reverse(lb.replace("SET search_path = policy_jp, pg_temp", "SET search_path = policy_jp"), "public"), exp);
  // edits 本身有守門：找不到或找到兩處都丟錯
  let threw = 0;
  for (const bad of [[["不存在的字串", ""]] as Edit[], [["SELECT", ""]] as Edit[]]) {
    try { applyEdits("SELECT 1 SELECT 2", bad); } catch { threw++; }
  }
  assertEquals(threw, 2);
});

// ---------------------------------------------------------------------------------------------
// 還原驗證（行為／自我檢查）：把 migration 改壞，要被抓到
// ---------------------------------------------------------------------------------------------
Deno.test("還原驗證：給 anon 表權限／加 Public read／拿掉 RLS／給 anon 執行內部函式／函式提到 public.／拿掉 SECURITY DEFINER，migration 的自我檢查會讓它失敗（失敗時整支回滾）", async () => {
  const pre = await baseDb();
  try {
    const mustFail = async (name: string, sql: string, msg: string) => {
      await assertRejects(() => pre.exec(sql), Error, msg, name);
      // 整支回滾：失敗後這兩張表不該存在（沒有半套）
      assertEquals((await one<{ r: string | null }>(pre, `SELECT to_regclass('policy_jp.pipeline_snapshots')::text AS r`)).r, null, `${name}：失敗後表還在（沒有回滾）`);
    };
    await mustFail("給 anon 讀快照表", mutate(MIG_SQL, "GRANT ALL ON policy_jp.excluded_agents, policy_jp.pipeline_snapshots TO service_role;",
      "GRANT ALL ON policy_jp.excluded_agents, policy_jp.pipeline_snapshots TO service_role;\nGRANT SELECT ON policy_jp.pipeline_snapshots TO anon;"), "不該有任何表權限");
    await mustFail("加 Public read", mutate(MIG_SQL, "GRANT ALL ON ALL SEQUENCES IN SCHEMA policy_jp TO service_role;",
      "GRANT ALL ON ALL SEQUENCES IN SCHEMA policy_jp TO service_role;\nCREATE POLICY \"Public read\" ON policy_jp.pipeline_snapshots FOR SELECT USING (true);"), "不該有 policy");
    await mustFail("拿掉 RLS", mutate(MIG_SQL, "ALTER TABLE policy_jp.pipeline_snapshots ENABLE ROW LEVEL SECURITY;\n", ""), "沒開 RLS");
    await mustFail("給 anon 執行 pipeline_take_snapshot", mutate(MIG_SQL, "  policy_jp.pipeline_snapshots_since(TIMESTAMPTZ)\nTO anon, authenticated;",
      "  policy_jp.pipeline_snapshots_since(TIMESTAMPTZ),\n  policy_jp.pipeline_take_snapshot()\nTO anon, authenticated;"), "不該能執行");
    await mustFail("貢獻統計拿掉 SECURITY DEFINER",
      mutate(MIG_SQL, " STABLE SECURITY DEFINER\n SET search_path = policy_jp, pg_temp\nAS $$\nWITH excluded AS (\n  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）\n  SELECT agent_name FROM policy_jp.excluded_agents\n),\nc AS (",
        " STABLE\n SET search_path = policy_jp, pg_temp\nAS $$\nWITH excluded AS (\n  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）\n  SELECT agent_name FROM policy_jp.excluded_agents\n),\nc AS ("),
      "不是 SECURITY DEFINER");
    await mustFail("函式提到 public.", mutate(MIG_SQL, "'adjudicating', (SELECT n FROM adjudicating),", "'adjudicating', (SELECT n FROM adjudicating), 'see', 'public.contribution_tasks',"), "提到 public.");
  } finally {
    await pre.close();
  }
});

Deno.test("還原驗證（洩漏偵測）：輸出夾帶 IP 雜湊、多回一個欄位，leakFindings 抓得到；還原後再乾淨", async () => {
  // 夾帶 IP 雜湊進貢獻統計
  const leaky = mutate(MIG_SQL, "'leaderboard_7d', policy_jp.contribution_leaderboard(7)",
    "'leaderboard_7d', policy_jp.contribution_leaderboard(7),\n  'leak', (SELECT min(contributor_ip_hash) FROM policy_jp.contributions)");
  await main.exec(leaky);
  assert((await leakFindings(main)).some((f) => f.includes("IPHASH-SECRET")), "IP 雜湊夾帶進輸出沒被抓到");
  // 多回一個欄位（備註）進貢獻榜
  const leaky2 = mutate(MIG_SQL, "    'verified_votes', verified_votes,\n    'score', submitted + applied + verified_votes\n  ) AS x\n  FROM merged\n  WHERE agent_name NOT IN (SELECT agent_name FROM excluded)\n    AND submitted + applied + verified_votes > 0\n  ORDER BY submitted + applied + verified_votes DESC, applied DESC, submitted DESC\n  LIMIT 30\n) t;\n$$;\n\n-- 抄自 20261008000010_excluded_agents.sql\nCREATE OR REPLACE FUNCTION policy_jp.contribution_leaderboard(p_since",
    "    'verified_votes', verified_votes,\n    'score', submitted + applied + verified_votes,\n    'who', 'x'\n  ) AS x\n  FROM merged\n  WHERE agent_name NOT IN (SELECT agent_name FROM excluded)\n    AND submitted + applied + verified_votes > 0\n  ORDER BY submitted + applied + verified_votes DESC, applied DESC, submitted DESC\n  LIMIT 30\n) t;\n$$;\n\n-- 抄自 20261008000010_excluded_agents.sql\nCREATE OR REPLACE FUNCTION policy_jp.contribution_leaderboard(p_since");
  await main.exec(leaky2);
  assert((await leakFindings(main)).some((f) => f.includes("多出欄位")), "多回的欄位沒被抓到");
  // 還原
  await main.exec(MIG_SQL);
  assertEquals(await leakFindings(main), []);
});

Deno.test("收尾：關閉共用資料庫", async () => {
  await main.close();
});
