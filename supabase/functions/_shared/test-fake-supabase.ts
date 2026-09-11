/**
 * 測試用的記憶體版 supabase-js：支援本專案用到的鏈式呼叫
 *   from(t).select(cols, {count, head}).eq/neq/in/gte/lte/lt/gt/is().order().limit().maybeSingle()
 *   from(t).insert(row|rows).select().maybeSingle()   from(t).update(patch).eq()…select().maybeSingle()
 *   from(t).delete().eq()…   from(t).upsert(row)   rpc(name) → rpcHandlers[name] 或 { data: [] }
 * 篩選鍵支援 JSON 路徑 `col->>key`。每個 query 是 thenable，await 得 { data, error, count }。
 */

type Row = Record<string, unknown>;
export type FakeDb = Record<string, Row[]>;
export interface FakeLogEntry { table: string; op: string; payload: unknown; matched: number }
type Result = { data: unknown; error: null; count: number | null };

function valueAt(row: Row, key: string): unknown {
  if (key.includes("->>")) {
    const [col, sub] = key.split("->>");
    const v = row[col];
    return v && typeof v === "object" ? (v as Row)[sub] : undefined;
  }
  return row[key];
}

class FakeQuery implements PromiseLike<Result> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: unknown = null;
  private single = false;
  private lim: number | null = null;
  private head = false;
  private wantCount = false;

  constructor(private db: FakeDb, private table: string, private log: FakeLogEntry[]) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.wantCount = !!opts?.count; this.head = !!opts?.head; }
    return this;
  }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = rows; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  upsert(row: Row) { this.op = "upsert"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => valueAt(r, k) === v); return this; }
  neq(k: string, v: unknown) { this.filters.push((r) => valueAt(r, k) !== v); return this; }
  in(k: string, arr: readonly unknown[]) { this.filters.push((r) => arr.includes(valueAt(r, k))); return this; }
  is(k: string, v: unknown) { this.filters.push((r) => (valueAt(r, k) ?? null) === v); return this; }
  gte(k: string, v: string | number) { this.filters.push((r) => (valueAt(r, k) as string | number) >= v); return this; }
  lte(k: string, v: string | number) { this.filters.push((r) => (valueAt(r, k) as string | number) <= v); return this; }
  gt(k: string, v: string | number) { this.filters.push((r) => (valueAt(r, k) as string | number) > v); return this; }
  lt(k: string, v: string | number) { this.filters.push((r) => (valueAt(r, k) as string | number) < v); return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }

  private rows(): Row[] {
    if (!this.db[this.table]) this.db[this.table] = [];
    return this.db[this.table];
  }
  private matches(r: Row): boolean { return this.filters.every((f) => f(r)); }
  private done(list: Row[]): Result {
    return { data: this.single ? (list[0] ?? null) : (this.head ? null : list), error: null, count: this.wantCount ? list.length : null };
  }
  private run(): Result {
    const rows = this.rows();
    if (this.op === "insert" || this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted = list.map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
      this.db[this.table] = [...rows, ...inserted];
      this.log.push({ table: this.table, op: this.op, payload: this.payload, matched: inserted.length });
      return this.done(inserted);
    }
    if (this.op === "update") {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      this.db[this.table] = rows.map((r) => { if (!this.matches(r)) return r; const next = { ...r, ...patch }; updated.push(next); return next; });
      this.log.push({ table: this.table, op: "update", payload: patch, matched: updated.length });
      return this.done(updated);
    }
    if (this.op === "delete") {
      const removed = rows.filter((r) => this.matches(r));
      this.db[this.table] = rows.filter((r) => !this.matches(r));
      this.log.push({ table: this.table, op: "delete", payload: null, matched: removed.length });
      return this.done(removed);
    }
    let matched = rows.filter((r) => this.matches(r));
    if (this.lim !== null) matched = matched.slice(0, this.lim);
    return this.done(matched);
  }
  then<T1 = Result, T2 = never>(onfulfilled?: ((v: Result) => T1 | PromiseLike<T1>) | null, onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

export interface FakeSupabase {
  // deno-lint-ignore no-explicit-any
  client: any;
  db: FakeDb;
  log: FakeLogEntry[];
}

export function createFakeSupabase(seed: FakeDb = {}, rpcHandlers: Record<string, (args: Row) => unknown> = {}): FakeSupabase {
  const db: FakeDb = structuredClone(seed);
  const log: FakeLogEntry[] = [];
  const client = {
    from: (table: string) => new FakeQuery(db, table, log),
    rpc: async (name: string, args: Row = {}) => ({ data: rpcHandlers[name] ? rpcHandlers[name](args) : [], error: null }),
  };
  return { client, db, log };
}
