/**
 * contributions-feed／report 單一 RPC 守門測試（feed-bundle.test.ts、report-bundle.test.ts）用的 PGlite 環境。不是測試檔。
 *
 *  - makeReportDb：在 history-pglite 的資料表上補 report／feed 讀寫到的欄位與表，再執行真的 migration（20261127094500）。
 *  - pgrstRouter：entry-harness 的 router，把入口檔真的發出去的 PostgREST 請求（GET／POST／PATCH／rpc，含篩選、排序、limit、
 *    count=exact、嵌入）翻成真的 SQL 打進同一個 PGlite；入口檔的程式一行不改。
 *    legacy＝true 時，兩支單一 RPC 回「不存在」（空回應），入口檔就會退回原本的多次查詢——同一份程式碼、同一份資料，兩條路徑。
 *    沒登記的資料表（額度設定、閘門紀錄…）回空陣列，兩條路徑一樣。
 */
import type { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";
import type { RestCall } from "./entry-harness.ts";
import { makeHistoryDb } from "./history-pglite.ts";

export const FEED_REPORT_MIG = "20261127094500_feed_report_bundle_rpc.sql";

const EXTRA_SCHEMA = `
ALTER TABLE contributions ADD COLUMN actor_id text, ADD COLUMN bundle_id uuid, ADD COLUMN bundle_released_at timestamptz,
  ADD COLUMN last_activity_at timestamptz, ADD COLUMN last_activity text, ADD COLUMN payload_hash text;
-- 新列的 id 用序列產生（每個測試資料庫從頭開始），兩條路徑各用一個全新資料庫時，新列的 id 也相同、可以逐 byte 比對
CREATE SEQUENCE contribution_id_seq;
ALTER TABLE contributions ALTER COLUMN id SET DEFAULT ('c2000000-0000-4000-8000-' || lpad(nextval('contribution_id_seq')::text, 12, '0'))::uuid;
ALTER TABLE contributions ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE politicians ADD COLUMN merged_into uuid, ADD COLUMN birth_year int, ADD COLUMN region text, ADD COLUMN party text;
ALTER TABLE contributions ADD COLUMN contributor_url text, ADD COLUMN via text, ADD COLUMN reviewed_by text, ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN bundle_index int, ADD COLUMN apply_claimed_at timestamptz;
ALTER TABLE contribution_votes ADD COLUMN id bigserial, ADD COLUMN actor_id text, ADD COLUMN judge_backed boolean DEFAULT false,
  ADD COLUMN evidence_checked_at timestamptz, ADD COLUMN evidence_verdict text, ADD COLUMN via text, ADD COLUMN bad_items jsonb;
ALTER TABLE contribution_votes ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE contributions ALTER COLUMN created_at SET DEFAULT now();
CREATE TABLE verify_dispatches (contribution_id uuid NOT NULL, ip_hash text NOT NULL, agent_name text, dispatched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, ip_hash));
-- 統計函式的替身：只要兩條路徑呼叫同一支就夠（真本體在 20260917000012 之後的幾支 migration）
CREATE FUNCTION contribution_feed_summary() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('by_status', COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM contributions GROUP BY status) s), '{}'::jsonb)) $$;
`;

export async function makeReportDb(): Promise<PGlite> {
  const db = await makeHistoryDb();
  await db.exec(EXTRA_SCHEMA);
  await db.exec(await readMig(FEED_REPORT_MIG));
  return db;
}

// ---- PostgREST → SQL ----

const TABLES = new Set([
  "contributions", "contribution_votes", "contribution_tasks", "verify_dispatches", "politicians", "policies", "lineages", "parties",
  "politician_elections", "admin_divisions",
]);

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

const colExpr = (k: string): string => (k.includes("->>") ? `(t.${k.split("->>")[0]}->>'${k.split("->>")[1]}')` : `t.${k}`);
const unquote = (v: string): string => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function selectList(cols: string): string {
  return splitTop(cols).map((tok) => {
    const emb = /^(\w+)\((.*)\)$/.exec(tok);
    if (emb) return `(SELECT row_to_json(e) FROM (SELECT ${emb[2]} FROM ${emb[1]} e WHERE e.id = t.politician_id) e) AS ${emb[1]}`;
    if (tok === "effective_agree") return "contribution_effective_agree(t.id) AS effective_agree";
    return `t.${tok}`;
  }).join(", ");
}

function condition(col: string, op: string, val: string, bind: (v: unknown) => string): string {
  const c = colExpr(col);
  switch (op) {
    case "eq": return `${c}::text = ${bind(val)}`;
    case "neq": return `${c} <> ${bind(val)}`;
    case "gt": return `${c} > ${bind(val)}`;
    case "gte": return `${c} >= ${bind(val)}`;
    case "lt": return `${c} < ${bind(val)}`;
    case "lte": return `${c} <= ${bind(val)}`;
    case "in": return `${c}::text = ANY(${bind(splitTop(val.replace(/^\(|\)$/g, "")).map(unquote))}::text[])`;
    case "is": return val === "null" ? `${c} IS NULL` : `${c} IS ${val.toUpperCase()}`;
    default: throw new Error(`pgrstRouter 不支援運算子 ${op}`);
  }
}

function whereOf(url: URL, bind: (v: unknown) => string): string[] {
  const where: string[] = [];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (k === "or") {
      const parts = splitTop(v.replace(/^\(|\)$/g, "")).map((p) => {
        const [col, op, ...rest] = p.split(".");
        return condition(col, op, rest.join("."), bind);
      });
      where.push(`(${parts.join(" OR ")})`);
      continue;
    }
    const dot = v.indexOf(".");
    where.push(condition(k, v.slice(0, dot), v.slice(dot + 1), bind));
  }
  return where;
}

const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

async function select(db: PGlite, table: string, url: URL, headers: Record<string, string>, head: boolean): Promise<unknown> {
  const params: unknown[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = whereOf(url, bind);
  const wh = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  let total: number | null = null;
  if ((headers.prefer ?? "").includes("count=exact") || head) {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} t${wh}`, params);
    total = r.rows[0].n;
  }
  if (head) return { __count: total };
  const cols = url.searchParams.get("select") ?? "*";
  const order = url.searchParams.get("order");
  const orderSql = order ? ` ORDER BY ${order.split(",").map((o) => { const [c, d] = o.split("."); return `t.${c} ${d === "desc" ? "DESC" : "ASC"}`; }).join(", ")}` : "";
  const limit = url.searchParams.get("limit");
  const sql = `SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM (SELECT ${cols === "*" ? "t.*" : selectList(cols)} FROM ${table} t${wh}${orderSql}${limit ? ` LIMIT ${Number(limit)}` : ""}) r`;
  const res = await db.query<{ data: unknown }>(sql, params);
  const rows = parse(res.rows[0].data);
  return total !== null ? { __count: total, __rows: rows } : rows;
}

async function insert(db: PGlite, table: string, call: RestCall): Promise<unknown> {
  const cols = call.url.searchParams.get("select");
  const rowsIn = (Array.isArray(call.body) ? call.body : [call.body]) as Array<Record<string, unknown>>;
  const body = JSON.stringify(rowsIn);
  // 只寫給了的欄位（沒給的走資料庫預設值，跟 PostgREST 一樣）
  const keys = [...new Set(rowsIn.flatMap((r) => Object.keys(r)))].join(", ");
  const ins = `INSERT INTO ${table} (${keys}) SELECT ${keys} FROM json_populate_recordset(null::${table}, $1::json) RETURNING *`;
  if (!cols) { await db.query(ins, [body]); return []; }
  const res = await db.query<{ data: unknown }>(`WITH ins AS (${ins}) SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM (SELECT ${selectList(cols)} FROM ins t) r`, [body]);
  return parse(res.rows[0].data);
}

async function update(db: PGlite, table: string, call: RestCall): Promise<unknown> {
  const params: unknown[] = [JSON.stringify(call.body)];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = whereOf(call.url, bind);
  const sets = Object.keys(call.body as Record<string, unknown>).map((k) => `${k} = (json_populate_record(null::${table}, $1::json)).${k}`).join(", ");
  const cols = call.url.searchParams.get("select");
  const upd = `UPDATE ${table} t SET ${sets}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} RETURNING t.*`;
  if (!cols) { await db.query(upd, params); return []; }
  const res = await db.query<{ data: unknown }>(`WITH u AS (${upd}) SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM (SELECT ${selectList(cols)} FROM u t) r`, params);
  return parse(res.rows[0].data);
}

const RPC_CASTS: Record<string, string> = { p_urls: "::text[]", p_params: "::jsonb", p_limit: "::int" };
const RPC_SETS = new Set(["source_briefs"]);
const RPC_KNOWN = new Set(["contribution_effective_agree", "contribution_feed_summary", "source_briefs", "contributions_feed_bundle", "report_context_bundle"]);
const BUNDLE_RPCS = new Set(["contributions_feed_bundle", "report_context_bundle"]);

async function rpc(db: PGlite, name: string, body: unknown): Promise<unknown> {
  const args = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const keys = Object.keys(args);
  const vals = keys.map((k) => (RPC_CASTS[k] === "::jsonb" ? JSON.stringify(args[k]) : args[k]));
  const phc = keys.map((k, i) => `$${i + 1}${RPC_CASTS[k] ?? ""}`).join(", ");
  const sql = RPC_SETS.has(name)
    ? `SELECT COALESCE(json_agg(x), '[]'::json) AS data FROM ${name}(${phc}) x`
    : `SELECT ${name}(${phc}) AS data`;
  const res = await db.query<{ data: unknown }>(sql, vals);
  return parse(res.rows[0].data);
}

export interface PgrstOptions {
  /** true＝兩支單一 RPC 回空（等於 migration 還沒上），入口檔退回舊路徑 */
  legacy?: boolean;
  /** 兩支單一 RPC 的特別回應（形狀不對、null…），優先於 legacy */
  bundleReply?: unknown;
}

export function pgrstRouter(db: PGlite, opts: PgrstOptions = {}): (call: RestCall) => Promise<unknown> {
  return async (call: RestCall): Promise<unknown> => {
    const headers = call.headers ?? {};
    if (call.target.startsWith("rpc/")) {
      const name = call.target.slice(4);
      if (BUNDLE_RPCS.has(name)) {
        if ("bundleReply" in opts) return opts.bundleReply;
        if (opts.legacy) return undefined;
      }
      if (!RPC_KNOWN.has(name)) return undefined;
      return await rpc(db, name, call.body);
    }
    if (!TABLES.has(call.target)) return undefined;
    if (call.method === "GET") return await select(db, call.target, call.url, headers, false);
    if (call.method === "HEAD") return await select(db, call.target, call.url, headers, true);
    if (call.method === "POST") return await insert(db, call.target, call);
    if (call.method === "PATCH") return await update(db, call.target, call);
    return undefined;
  };
}

/** 一次請求打了幾次 REST：入口檔發出去的請求數（呼叫端用 entry.calls 或這個過濾資料表／rpc 名） */
export const countCalls = (calls: RestCall[], pred: (c: RestCall) => boolean = () => true): number => calls.filter(pred).length;
