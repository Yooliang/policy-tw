/**
 * 假 supabase client：給名冊大批次的整合測試（roster-batch-handler.test.ts）用——真的跑 handleContribute 150 筆。
 * 不是測試檔（沒有 .test.ts）。
 *
 * 會模擬正式環境的兩件事，沒接住就看得出來：
 *  - `.in()` 一次帶超過 IN_CHUNK 個值，等於網址過長（414）：記進 oversize，而且該次查詢回 error（跟 PostgREST 一樣不是回空）
 *  - cec_registrations 的列：記下回給呼叫端的列數（rowsServed）與有沒有整表掃（沒有 region 條件的非 head 查詢）
 */
import { IN_CHUNK } from "./in-chunks.ts";

type Row = Record<string, unknown>;
export interface FakeTables {
  cec_registration_sources?: Row[];
  cec_registrations?: Row[];
  politicians?: Row[];
  [t: string]: Row[] | undefined;
}
export interface FakeOpts {
  /** 讓 cec_registrations 的 count 查詢回 error（模擬資料表壞掉） */
  failRegistrationCount?: boolean;
}

export function fakeRosterSupabase(tables: FakeTables, opts: FakeOpts = {}) {
  const log = {
    inSizes: [] as Array<{ table: string; col: string; n: number }>,
    oversize: [] as Array<{ table: string; col: string; n: number }>,
    inserted: [] as Array<{ table: string; row: Row }>,
    registrationQueries: [] as Array<{ filters: Record<string, unknown>; head: boolean; served: number }>,
    rowsServed: 0,
    fullScans: 0,
  };
  const client = {
    from(table: string) {
      const filters: Array<{ k: string; op: string; v: unknown }> = [];
      let range: [number, number] | null = null;
      let head = false;
      let wantCount = false;
      let op: "select" | "insert" | "delete" = "select";
      let insertRows: Row[] = [];
      const add = (k: string, o: string, v: unknown) => { filters.push({ k, op: o, v }); return chain; };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_cols?: string, o?: { count?: string; head?: boolean }) { head = !!o?.head; wantCount = !!o?.count; return chain; },
        eq: (k: string, v: unknown) => add(k, "eq", v),
        in(k: string, v: unknown[]) {
          log.inSizes.push({ table, col: k, n: v.length });
          if (v.length > IN_CHUNK) log.oversize.push({ table, col: k, n: v.length });
          return add(k, "in", v);
        },
        is: (k: string, v: unknown) => add(k, "is", v),
        gte: (k: string, v: unknown) => add(k, "gte", v),
        neq: (k: string, v: unknown) => add(k, "neq", v),
        not: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        range(a: number, b: number) { range = [a, b]; return chain; },
        insert(rows: Row | Row[]) {
          op = "insert";
          insertRows = Array.isArray(rows) ? rows : [rows];
          for (const r of insertRows) log.inserted.push({ table, row: r });
          return chain;
        },
        delete() { op = "delete"; return chain; },
        maybeSingle() { return Promise.resolve({ ...resolve(), data: (resolve().data as Row[])[0] ?? null }); },
        single() { return chain.maybeSingle(); },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(resolve()).then(res, rej); },
      };
      function resolve(): { data: Row[] | null; error: { message: string } | null; count?: number } {
        const over = filters.find((f) => f.op === "in" && (f.v as unknown[]).length > IN_CHUNK);
        if (over) return { data: null, error: { message: `414 Request-URI Too Large（${table}.${over.k} in() 帶了 ${(over.v as unknown[]).length} 個）` } };
        if (op === "insert") {
          return { data: insertRows.map((r, i) => ({ id: `new-${log.inserted.length}-${i}`, payload_hash: r.payload_hash })), error: null };
        }
        if (op === "delete") return { data: [], error: null };
        const source = tables[table] ?? [];
        const rows = source.filter((r) => filters.every((f) => {
          const cell = r[f.k];
          if (f.op === "eq") return cell === f.v;
          if (f.op === "in") return (f.v as unknown[]).includes(cell);
          if (f.op === "neq") return cell !== f.v;
          return true; // is／gte 等：測試資料不在乎
        }));
        if (table === "cec_registrations") {
          if (head && opts.failRegistrationCount) return { data: null, error: { message: "count failed" } };
          const filterObj = Object.fromEntries(filters.map((f) => [f.k, f.v]));
          if (head) {
            log.registrationQueries.push({ filters: filterObj, head: true, served: 0 });
            return { data: null, error: null, count: rows.length };
          }
          const sorted = [...rows].sort((a, b) => Number(a.row_no) - Number(b.row_no));
          const [a, b] = range ?? [0, sorted.length - 1];
          const page = sorted.slice(a, b + 1);
          log.rowsServed += page.length;
          if (!filters.some((f) => f.k === "region")) log.fullScans++;
          log.registrationQueries.push({ filters: filterObj, head: false, served: page.length });
          return { data: page, error: null };
        }
        if (head || wantCount) return { data: null, error: null, count: rows.length };
        return { data: rows, error: null, count: rows.length };
      }
      return chain;
    },
  };
  return { client, log };
}
