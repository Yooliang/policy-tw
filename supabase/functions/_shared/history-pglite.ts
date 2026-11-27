/**
 * history 單一 RPC 守門測試（history-bundle.test.ts）用的 PGlite 環境。不是測試檔。
 *
 *  - 建 history 讀到的那幾張表（只放用得到的欄位）、Supabase 的三個角色，再執行真的 migration 與真的
 *    source_brief_list／source_briefs／web_request_parked 函式本體。
 *  - sqlBackedClient：像 supabase-js 的假 client，鏈式查詢翻成真的 SQL 打進同一個 PGlite（回 json_agg，跟 PostgREST 一樣），
 *    rpc 也打進去；每個請求記一筆，給「一次請求打幾次 REST」的計數守門用。
 */
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

export const BUNDLE_MIG = "20261127073000_history_bundle_rpc.sql";

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
-- Supabase 預設：新函式的 EXECUTE 開給三個角色（再加上 PostgreSQL 預設的 PUBLIC）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE policies (id uuid PRIMARY KEY, title text, ai_extracted boolean DEFAULT false, proposed_date date, politician_id uuid);
CREATE TABLE lineages (id uuid PRIMARY KEY, title text);
CREATE TABLE parties (id bigint PRIMARY KEY, name text);
CREATE TABLE elections (id int PRIMARY KEY, election_date date, bulletin_published_on date);
CREATE TABLE politician_elections (id int PRIMARY KEY, politician_id uuid, election_id int, election_type text, source_note text);
CREATE TABLE tracking_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid, event text);
CREATE TABLE admin_divisions (code text PRIMARY KEY, county text, town text, village text);
CREATE TABLE sources (id serial PRIMARY KEY, url text, source_kind text, self_evidence text, doc_kind text, archive_url text, title text, publisher text, published_date date);
CREATE TABLE source_refs (source_id int, target_table text, target_id text, role text, created_at timestamptz DEFAULT now());
CREATE TABLE contributions (
  id uuid PRIMARY KEY, contribution_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', source_urls text[], note text,
  agent_name text, agent_tool text, status text NOT NULL, review_notes text, applied_at timestamptz,
  applied_politician_id uuid, applied_policy_id uuid, created_at timestamptz NOT NULL, agree_count int DEFAULT 0,
  disagree_count int DEFAULT 0, unsure_count int DEFAULT 0, task_id text, score int, contributor_ip_hash text);
CREATE TABLE contribution_votes (
  contribution_id uuid, verdict text, note text, evidence_url text, agent_name text, agent_tool text,
  resolved_politician_id uuid, created_at timestamptz, verifier_ip_hash text);
CREATE TABLE edit_history (
  id bigserial PRIMARY KEY, contribution_id uuid, table_name text, record_id text, field text, old_value jsonb, new_value jsonb,
  applied_at timestamptz, reverted_at timestamptz, reverted_by text);
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, task_type text, status text, target jsonb DEFAULT '{}', created_at timestamptz, closed_at timestamptz, source text);
CREATE TABLE citizen_questions (id uuid PRIMARY KEY, question text, status text, answer_count int, created_at timestamptz);

-- 計算欄位 effective_agree 的替身：依列決定（不是常數，看得出兩條路徑真的都帶了）
CREATE FUNCTION contribution_effective_agree(p_id uuid) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT 3 + COALESCE((SELECT agree_count FROM contributions WHERE id = p_id), 0) $$;
CREATE FUNCTION uuid_or_null(t text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid END $$;
`;

export async function makeHistoryDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const stage2a = await readMig("20261006210000_sources_stage2a.sql");
  await db.exec(fnText(stage2a, "source_brief_list"));
  await db.exec(fnText(stage2a, "source_briefs"));
  await db.exec(fnText(await readMig("20261028150000_park_uses_bulletin_date.sql"), "web_request_parked"));
  await db.exec(await readMig(BUNDLE_MIG));
  return db;
}

// ---- 假 supabase client（翻成真的 SQL） ----

type Row = Record<string, unknown>;
export interface SqlClient {
  // deno-lint-ignore no-explicit-any
  client: any;
  /** 每個 REST 請求一筆：`rest:<表>` 或 `rpc:<函式>` */
  calls: string[];
}

const RPC_ARGS: Record<string, { args: string[]; kind: "set" | "scalar" }> = {
  history_bundle: { args: ["p_target", "p_id", "p_limit"], kind: "scalar" },
  source_briefs: { args: ["p_urls"], kind: "set" },
  source_brief_list: { args: ["p_table", "p_id"], kind: "scalar" },
  web_request_parked: { args: ["p_task_id"], kind: "scalar" },
};

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

const colExpr = (k: string): string => (k.includes("->>") ? `t.${k.split("->>")[0]}->>'${k.split("->>")[1]}'` : `t.${k}`);

function selectList(cols: string): string {
  return splitTop(cols).map((tok) => {
    const emb = /^(\w+)\((.*)\)$/.exec(tok);
    if (emb) {
      // 嵌入：politicians(name) → 以 politician_id 對到那一列（多對一，沒有就 null）
      return `(SELECT row_to_json(e) FROM (SELECT ${emb[2]} FROM ${emb[1]} e WHERE e.id = t.politician_id) e) AS ${emb[1]}`;
    }
    if (tok === "effective_agree") return "contribution_effective_agree(t.id) AS effective_agree";
    return `t.${tok}`;
  }).join(", ");
}

const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

export function sqlBackedClient(db: PGlite, opts: { failRpc?: Record<string, { error?: unknown; throws?: boolean; data?: unknown }> } = {}): SqlClient {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      let cols = "*";
      const where: string[] = [];
      const params: unknown[] = [];
      let order = "";
      let lim: number | null = null;
      let single = false;
      const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select(c?: string) { if (c) cols = c; return q; },
        eq(k: string, v: unknown) { where.push(`(${colExpr(k)})::text = ${bind(String(v))}`); return q; },
        in(k: string, arr: unknown[]) { where.push(`(${colExpr(k)})::text = ANY(${bind(arr.map(String))}::text[])`); return q; },
        is(k: string, v: unknown) { where.push(`${colExpr(k)} IS ${v === null ? "NULL" : String(v).toUpperCase()}`); return q; },
        order(k: string, o?: { ascending?: boolean }) { order = ` ORDER BY ${colExpr(k)} ${o?.ascending === false ? "DESC" : "ASC"}`; return q; },
        limit(n: number) { lim = n; return q; },
        maybeSingle() { single = true; return q; },
        // deno-lint-ignore no-explicit-any
        then(resolve: any, reject: any) {
          calls.push(`rest:${table}`);
          const sql = `SELECT COALESCE(json_agg(r), '[]'::json) AS data FROM (SELECT ${cols === "*" ? "t.*" : selectList(cols)} FROM ${table} t` +
            `${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order}${lim !== null ? ` LIMIT ${lim}` : ""}) r`;
          return db.query<{ data: unknown }>(sql, params).then((res) => {
            const rows = parse(res.rows[0].data) as Row[];
            return { data: single ? (rows[0] ?? null) : rows, error: null, count: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name: string, args: Row) {
      calls.push(`rpc:${name}`);
      const fail = opts.failRpc?.[name];
      if (fail?.throws) throw new Error(`rpc ${name} 連線失敗`);
      if (fail) return { data: fail.data ?? null, error: fail.error ?? null };
      const def = RPC_ARGS[name];
      if (!def) return { data: null, error: { message: `unknown rpc ${name}`, code: "PGRST202" } };
      const vals = def.args.map((a) => args[a]);
      const casts: Record<string, string> = { p_urls: "::text[]", p_limit: "::int", p_task_id: "::uuid" };
      const phc = def.args.map((a, i) => `$${i + 1}${casts[a] ?? ""}`).join(", ");
      const sql = def.kind === "set"
        ? `SELECT COALESCE(json_agg(x), '[]'::json) AS data FROM ${name}(${phc}) x`
        : `SELECT ${name}(${phc}) AS data`;
      try {
        const res = await db.query<{ data: unknown }>(sql, vals);
        return { data: parse(res.rows[0].data), error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
  return { client, calls };
}
