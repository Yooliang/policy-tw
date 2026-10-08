/**
 * 日本站版入口載入器：複製自 ../entry-harness.ts，唯一的差別是 RestCall 多了 headers（Request 標頭），
 *
 * 入口檔（next／report／…）一載入就 `Deno.serve(handler)`。這裡暫時換掉 `Deno.serve`、`Deno.env` 與 `fetch`，
 * 動態載入入口、接住它註冊的 handler，之後就能用真的 Request 打進去；handler 裡的 supabase-js 走假的 PostgREST（`fetch` 被換掉）。
 * 測試結束一定要 `restore()`（try/finally），否則會污染同一個行程裡的其他測試。
 */

export interface RestCall {
  method: string;
  /** 表名，或 `rpc/<函式名>` */
  target: string;
  url: URL;
  /** 寫入（POST／PATCH）的 JSON body */
  body: unknown;
  /** 請求標頭（小寫鍵）：測試用來確認每個請求都帶 accept-profile／content-profile: policy_jp */
  headers: Record<string, string>;
}

/** 回 undefined＝預設（空陣列）。maybeSingle 的呼叫會自動取第一列。 */
export type RestRouter = (call: RestCall) => unknown | undefined;

export interface LoadedEntry {
  call(req: Request): Promise<Response>;
  calls: RestCall[];
  restore(): void;
}

let loads = 0;

export async function loadEntry(path: string, env: Record<string, string | undefined>, router: RestRouter): Promise<LoadedEntry> {
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  const origServe = D.serve;
  const origFetch = globalThis.fetch;
  const envDesc = Object.getOwnPropertyDescriptor(Deno, "env");
  const calls: RestCall[] = [];
  let handler: ((r: Request) => Promise<Response> | Response) | null = null;

  const restore = () => {
    D.serve = origServe;
    if (envDesc) Object.defineProperty(Deno, "env", envDesc);
    globalThis.fetch = origFetch;
  };

  D.serve = (h: (r: Request) => Promise<Response> | Response) => { handler = h; return { finished: Promise.resolve() }; };
  Object.defineProperty(Deno, "env", { value: { get: (k: string) => env[k] }, configurable: true });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return (async () => {
      const url = new URL(req.url);
      const m = url.pathname.match(/\/rest\/v1\/(.+)$/);
      const target = m ? m[1] : url.pathname;
      const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      const call: RestCall = { method: req.method, target, url, body, headers: Object.fromEntries(req.headers.entries()) };
      calls.push(call);
      const routed = router(call);
      const headers = { "content-type": "application/json", "content-range": "*/0" };
      if (req.method === "HEAD") return new Response(null, { headers });
      let data: unknown = routed === undefined ? ((req.method === "POST" && !target.startsWith("rpc/")) ? [] : []) : routed;
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("pgrst.object")) {
        const arr = Array.isArray(data) ? data : [data];
        if (arr.length !== 1) return new Response(JSON.stringify({ code: "PGRST116", message: "no rows", details: "", hint: null }), { status: 406, headers });
        data = arr[0];
      }
      return new Response(JSON.stringify(data ?? null), { status: req.method === "POST" && !target.startsWith("rpc/") ? 201 : 200, headers });
    })();
  }) as typeof fetch;

  try {
    // 每次載入加不同的查詢字串＝新的模組實例（模組層級的狀態，例如只警告一次的旗標，不會跨測試殘留）
    await import(`${new URL(path, import.meta.url).href}?jpharness=${++loads}`);
  } catch (e) {
    restore();
    throw e;
  }
  if (!handler) { restore(); throw new Error(`${path} 沒有呼叫 Deno.serve`); }
  const h = handler as (r: Request) => Promise<Response> | Response;
  return { call: async (req) => await h(req), calls, restore };
}
