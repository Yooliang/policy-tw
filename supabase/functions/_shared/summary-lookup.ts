/**
 * 貢獻摘要的「id → 名稱」對照表（2026-10-18「把 id 都換成名稱」）。
 *
 * summarizeContribution 是純函式，不碰資料庫；這裡負責把一批貢獻 payload 裡出現的 id
 * 先掃出來（collectSummaryIds，純函式、可測）、每張表只查一次（loadSummaryLookup，`in` 批次），
 * 組成 SummaryLookup 傳進去。查不到的 id 不放進表，摘要會退成「某位政治人物」這類中性說法。
 */
import { summarizeContribution, type SummaryLookup } from "./contribution-summary.ts";

type Obj = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM_RE = /^[0-9]+$/;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const num = (v: unknown): string | null => (typeof v === "number" && Number.isInteger(v) ? String(v) : typeof v === "string" && NUM_RE.test(v) ? v : null);

export interface SummaryIds {
  politicians: string[];
  policies: string[];
  lineages: string[];
  parties: string[];
  elections: string[];
  regions: string[];
  contributions: string[];
}

export interface SummarySource {
  contribution_type?: string;
  payload: unknown;
  applied_politician_id?: string | null;
  applied_policy_id?: string | null;
}

/** 純函式：掃出一批貢獻的摘要會用到的所有 id（已去重、已濾掉格式不對的） */
export function collectSummaryIds(rows: readonly SummarySource[]): SummaryIds {
  const sets = {
    politicians: new Set<string>(), policies: new Set<string>(), lineages: new Set<string>(), parties: new Set<string>(),
    elections: new Set<string>(), regions: new Set<string>(), contributions: new Set<string>(),
  };
  const add = (set: Set<string>, v: string | null) => { if (v) set.add(v); };
  for (const r of rows) {
    const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Obj;
    add(sets.politicians, uuid(r.applied_politician_id));
    add(sets.policies, uuid(r.applied_policy_id));
    for (const k of ["politician_id", "to_politician_id", "from_politician_id", "keep_id", "remove_id"]) add(sets.politicians, uuid(p[k]));
    add(sets.policies, uuid(p.policy_id));
    const table = p.target_table;
    if (table === "policies") add(sets.policies, uuid(p.target_id));
    if (table === "politicians") add(sets.politicians, uuid(p.target_id));
    if (table === "politician_elections") add(sets.elections, num(p.target_id));
    add(sets.elections, num(p.politician_election_id));
    for (const k of ["lineage_id", "upper_lineage_id", "lower_lineage_id"]) add(sets.lineages, uuid(p[k]));
    if (Array.isArray(p.parties)) {
      for (const it of p.parties) {
        if (!it || typeof it !== "object") continue;
        add(sets.parties, num((it as Obj).party_id));
        add(sets.parties, num((it as Obj).predecessor_id));
      }
    }
    if (typeof p.admin_code === "string" && NUM_RE.test(p.admin_code)) sets.regions.add(p.admin_code);
    if (r.contribution_type === "adjudication") add(sets.contributions, uuid(p.contribution_id));
  }
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v]])) as unknown as SummaryIds;
}

/** 行政區代碼 → 「縣市＋鄉鎮市區＋村里」 */
export function regionLabel(row: { county?: string | null; town?: string | null; village?: string | null }): string {
  return `${row.county ?? ""}${row.town ?? ""}${row.village ?? ""}`;
}

async function pick<T>(supabase: SupabaseLike, table: string, columns: string, ids: string[], what: string): Promise<T[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(table).select(columns).in("id", ids);
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? []) as T[];
}

/**
 * 批次查出名稱。一般貢獻每張表一次查詢；裁決貢獻要先撈原貢獻（再多一輪），
 * 並用同一份對照表替原貢獻寫它自己的一句話摘要。
 */
export async function loadSummaryLookup(supabase: SupabaseLike, rows: readonly SummarySource[]): Promise<SummaryLookup> {
  // 第一輪：裁決指向的原貢獻
  const first = collectSummaryIds(rows);
  const originals = await pick<{ id: string; contribution_type: string; payload: unknown; applied_politician_id: string | null; applied_policy_id: string | null }>(
    supabase, "contributions", "id, contribution_type, payload, applied_politician_id, applied_policy_id", first.contributions, "adjudicated contributions",
  );
  // 第二輪：其餘 id（含原貢獻自己 payload 裡的）
  const ids = collectSummaryIds([...rows, ...originals]);
  const [pols, policies, lineages, parties, elections, regionRows] = await Promise.all([
    pick<{ id: string; name: string }>(supabase, "politicians", "id, name", ids.politicians, "politician names"),
    pick<{ id: string; title: string }>(supabase, "policies", "id, title", ids.policies, "policy titles"),
    pick<{ id: string; title: string }>(supabase, "lineages", "id, title", ids.lineages, "lineage titles"),
    pick<{ id: string; name: string }>(supabase, "parties", "id, name", ids.parties, "party names"),
    pick<{ id: number; election_id: unknown; election_type: string | null; politicians: { name?: string } | null }>(
      supabase, "politician_elections", "id, election_id, election_type, politicians(name)", ids.elections, "politician_elections",
    ),
    ids.regions.length === 0 ? Promise.resolve([]) : supabase.from("admin_divisions").select("code, county, town, village").in("code", ids.regions)
      .then((r: { data: unknown; error: { message: string } | null }) => {
        if (r.error) throw new Error(`admin_divisions: ${r.error.message}`);
        return (r.data ?? []) as Array<{ code: string; county: string | null; town: string | null; village: string | null }>;
      }),
  ]);
  const lookup: SummaryLookup = {
    politicians: Object.fromEntries(pols.map((x) => [x.id, x.name])),
    policies: Object.fromEntries(policies.map((x) => [x.id, x.title])),
    lineages: Object.fromEntries(lineages.map((x) => [x.id, x.title])),
    parties: Object.fromEntries(parties.map((x) => [String(x.id), x.name])),
    elections: Object.fromEntries(elections.map((x) => [
      String(x.id), `${x.politicians?.name ?? "某位政治人物"} ${x.election_id ?? ""} ${x.election_type ?? ""}`.trim(),
    ])),
    regions: Object.fromEntries(regionRows.map((x: { code: string; county: string | null; town: string | null; village: string | null }) => [x.code, regionLabel(x)])),
    contributions: {},
  };
  // 原貢獻的一句話摘要（不再帶 contributions 對照，避免裁決指向裁決時無限遞迴）
  for (const o of originals) {
    lookup.contributions![o.id] = summarizeContribution({
      contribution_type: o.contribution_type, payload: o.payload,
      applied_politician_id: o.applied_politician_id, applied_policy_id: o.applied_policy_id, lookup: { ...lookup, contributions: {} },
    }).summary;
  }
  return lookup;
}
