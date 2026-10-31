/**
 * 中選會選舉專區名冊鏡像（2026-10-31，migration 20261031160000）：把 info.cec.gov.tw/vote2026/static/json/cand/ 的候選人 JSON
 * 轉成 cec_roster_2026 的列，逐檔（同網域間隔 0.5 秒、一般 UA、只 GET、失敗重試）抓、整檔原子替換。
 * 解析與抓取分開，解析是純函式（測試用）。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const CEC_ROSTER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const FETCH_GAP_MS = 500;

export interface RosterRow {
  name: string;
  cand_no: number | null;
  party: string | null;
  birth: string | null;
  home: string | null;
  district: string;
  area_code: string;
  dept_code: string;
  li_code: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const candRow = (c: Obj, extra: Partial<RosterRow>): RosterRow => ({
  name: str(c.name).trim(),
  cand_no: Number.isInteger(c.candNo) ? Number(c.candNo) : null,
  party: str(c.party) || null,
  birth: str(c.birth) || null,
  home: str(c.home) || null,
  district: "",
  area_code: "",
  dept_code: str(c.deptCode),
  li_code: str(c.liCode),
  ...extra,
});

/** 一個 JSON 檔 → 列。C1／D1／D2／V1 是平的陣列；T 依選區分組（areaCode、areaName、cands）；R／R3 先依鄉鎮（deptCode）再依選區。 */
export function parseRosterJson(kind: string, json: unknown): RosterRow[] {
  const root = (json ?? {}) as Obj;
  const list = root[kind];
  if (!Array.isArray(list)) throw new Error(`JSON 沒有 ${kind} 陣列`);
  const out: RosterRow[] = [];
  if (kind === "C1" || kind === "D1" || kind === "D2" || kind === "V1") {
    for (const c of list as Obj[]) out.push(candRow(c, {}));
  } else if (kind === "T") {
    for (const a of list as Obj[]) {
      for (const c of (Array.isArray(a.cands) ? a.cands : []) as Obj[]) {
        out.push(candRow(c, { district: str(a.areaName), area_code: str(a.areaCode) }));
      }
    }
  } else if (kind === "R" || kind === "R3") {
    for (const t of list as Obj[]) {
      for (const a of (Array.isArray(t.areas) ? t.areas : []) as Obj[]) {
        for (const c of (Array.isArray(a.cands) ? a.cands : []) as Obj[]) {
          out.push(candRow(c, { dept_code: str(t.deptCode), district: str(a.areaName), area_code: str(a.areaCode) }));
        }
      }
    }
  } else throw new Error(`不認得的種類 ${kind}`);
  return out.filter((r) => r.name !== "");
}

export interface UnitRef { url: string; kind: string }

export interface MirrorOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  now?: () => number;
  limit?: number;
}

/** 一輪：取待抓單位、逐檔抓、換檔；預算用完就停（下一輪續）。回傳統計。 */
export async function runRosterMirror(supabase: SupabaseLike, opts: MirrorOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? 100_000;
  const started = now();
  const stats = { picked: 0, ok: 0, absent: 0, error: 0, rows: 0, reconciled: null as unknown };

  const seeded = await supabase.rpc("cec_roster_seed_units");
  if (seeded.error) throw new Error(`cec_roster_seed_units: ${seeded.error.message}`);
  const next = await supabase.rpc("cec_roster_next_units", { p_limit: opts.limit ?? 40 });
  if (next.error) throw new Error(`cec_roster_next_units: ${next.error.message}`);

  for (const u of (next.data ?? []) as UnitRef[]) {
    if (now() - started > budget) break;
    stats.picked++;
    let http = 0;
    let rows: RosterRow[] | null = null;
    let err: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(u.url, { method: "GET", headers: { "User-Agent": CEC_ROSTER_UA, "Accept": "application/json, */*", "Accept-Language": "zh-TW,zh;q=0.9" } });
        http = res.status;
        const text = await res.text();
        if (http === 404) { err = null; break; }
        if (http !== 200) {
          err = `HTTP ${http}`;
        } else {
          try {
            rows = parseRosterJson(u.kind, JSON.parse(text));
            err = null;
            break;
          } catch (e) {
            err = `解析失敗：${e instanceof Error ? e.message : String(e)}`;
            rows = null;
          }
        }
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      await sleep(1000 * (attempt + 1));
    }
    const r = await supabase.rpc("cec_roster_replace_unit", { p_url: u.url, p_http: http || null, p_rows: rows, p_error: err });
    if (r.error) throw new Error(`cec_roster_replace_unit: ${r.error.message}`);
    if (r.data === "ok") {
      stats.ok++;
      stats.rows += rows?.length ?? 0;
    } else if (r.data === "absent") stats.absent++;
    else stats.error++;
    await sleep(FETCH_GAP_MS);
  }
  const rec = await supabase.rpc("cec_roster_reconcile_if_due");
  if (rec.error) throw new Error(`cec_roster_reconcile_if_due: ${rec.error.message}`);
  stats.reconciled = rec.data;
  return stats;
}
