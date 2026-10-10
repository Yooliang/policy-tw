/**
 * 日本站入口（jp-next／jp-report）の選舉鏈テスト用の假 PostgREST（有狀態）。不是測試檔。
 * jp-entry.test.ts の makeDb と同じ作り（そちらは export していないので最小限を写した）：contributions・votes・verify_dispatches を覚え、
 * rpc/same_claim_matches・rpc/contribution_queue_tasks などは呼び出し側が渡した値を返す。
 */
import { loadEntry, type LoadedEntry, type RestCall } from "./jp/entry-harness.ts";
import { ipHashOf } from "./jp/contribute-handler.ts";

export type Row = Record<string, unknown>;
export const SALT = "test-salt";
export const SERVICE_KEY = "service-role-key-0123456789";
export const env = (extra: Record<string, string | undefined> = {}) => ({
  SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, CONTRIBUTION_IP_SALT: SALT, ...extra,
});
export const at = (ip: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), "x-forwarded-for": ip } });
export const N1 = "10.1.1.5";
export const R = "10.2.2.9";
export const netHash = (ip: string) => ipHashOf(new Request("https://x/", at(ip)), SALT);

export function makeDb(o: {
  queue?: Row[];
  /** rpc/same_claim_matches の戻り（型別 → {existing, pending}）。ない型別は null（登記なし）を返す */
  sameClaims?: Record<string, { existing: Row[]; pending: Row[] }>;
  apply?: unknown;
  /** rpc/candidacy_kana_required の戻り（election_id → 告示日以降か）。ない選舉は false（告示前） */
  kanaRequired?: Record<string, boolean>;
  /** 既に庫にある貢獻（claimKey 併票・去重の相手） */
  seeded?: Row[];
} = {}) {
  const votes: Row[] = [];
  const contributions: Row[] = [...(o.seeded ?? [])];
  const eq = (u: URL) => [...u.searchParams.entries()].filter(([, v]) => v.startsWith("eq.")).map(([k, v]) => [k, v.slice(3)] as const);
  const match = (rows: Row[], u: URL) => rows.filter((r) => eq(u).every(([k, v]) => String(r[k]) === v));
  const router = (c: RestCall): unknown => {
    const t = c.target;
    if (t === "rpc/contribution_verify_pool") return [];
    if (t === "rpc/contribution_queue_tasks") return o.queue ?? [];
    if (t === "rpc/contribution_effective_agree") return 3;
    if (t === "rpc/apply_contribution") return o.apply;
    if (t === "rpc/candidacy_kana_required") return o.kanaRequired?.[(c.body as { p_election_id?: string } | null)?.p_election_id ?? ""] ?? false;
    if (t === "rpc/same_claim_matches") {
      const type = (c.body as { p_type?: string } | null)?.p_type ?? "";
      return o.sameClaims?.[type] ?? null;
    }
    if (t === "contributions") {
      if (c.method === "POST") {
        const rows = (Array.isArray(c.body) ? c.body : [c.body]) as Row[];
        const made = rows.map((r, i) => ({ ...r, id: `00000000-0000-4000-8000-${String(contributions.length + i + 1).padStart(12, "0")}`, status: "pending", agree_count: 0, disagree_count: 0, unsure_count: 0, score: 0 }));
        contributions.push(...made);
        return made;
      }
      if (c.method === "PATCH") { for (const r of match(contributions, c.url)) Object.assign(r, c.body); return []; }
      const id = c.url.searchParams.get("id");
      if (id) return match(contributions, c.url);
      return undefined;
    }
    if (t === "contribution_votes") {
      if (c.method === "POST") { const row = { ...(c.body as Row), id: `vote-${votes.length + 1}` }; votes.push(row); return [row]; }
      return match(votes, c.url);
    }
    return undefined;
  };
  return { votes, contributions, router };
}

export async function withEntries<T>(db: ReturnType<typeof makeDb>, e: Record<string, string | undefined>, fn: (x: { next: LoadedEntry; report: LoadedEntry }) => Promise<T>): Promise<T> {
  const next = await loadEntry("../../jp-next/index.ts", e, db.router);
  const report = await loadEntry("../../jp-report/index.ts", e, db.router);
  try { return await fn({ next, report }); } finally { report.restore(); next.restore(); }
}
export const getNext = async (next: LoadedEntry, ip: string, agent = "dave") => {
  const res = await next.call(new Request(`https://x/jp-next?agent_name=${agent}&agent_tool=claude-code/claude-sonnet-5`, at(ip)));
  return { status: res.status, json: await res.json() as Row };
};
export const post = async (entry: LoadedEntry, ip: string, body: Row) => {
  const res = await entry.call(new Request("https://x/jp-report", at(ip, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })));
  return { status: res.status, json: await res.json() as Row };
};
export const callsTo = (calls: RestCall[], target: string) => calls.filter((c) => c.target === target);
export const errorPaths = (json: Row) => ((json.errors ?? []) as Array<{ path: string }>).map((e) => e.path).sort();
