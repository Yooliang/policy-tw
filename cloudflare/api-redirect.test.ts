/**
 * 正見.tw Worker 的協議端點轉址（cloudflare/ssr-worker.js 的 apiRedirect；#466 雜項「Worker 轉址 /functions/v1/sources」）。
 *
 * skill.md 寫的查證來源清單端點是 GET <端點根網址>/sources，但 /sources 同時是網站頁面，不在 API_ONLY；
 * 2026-10-07 盤點時 `/functions/v1/sources` 打到網站網域會拿到網頁（其他端點都會 307 轉到 Supabase）。
 * 修法：sources 進 API_ALSO_PAGE（網站頁面維持原樣，只有「帶 /functions/v1/ 前綴、非 GET、或帶代理才會用的參數」才轉）。
 *
 * apiRedirect 不是匯出的（Worker 的 default export 要整套環境），這裡從原始碼抽出那一段在純 JS 裡跑。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const src = (await Deno.readTextFile(new URL("./ssr-worker.js", import.meta.url))).replace(/\r\n/g, "\n");
const a = src.indexOf("const API_BASE =");
const b = src.indexOf("const DROP_REQUEST_HEADERS");
assert(a > 0 && b > a, "找不到 apiRedirect 那一段");
const apiRedirect = new Function(`${src.slice(a, b)}\nreturn apiRedirect`)() as (r: Request) => Response | null;

const SITE = "https://xn--2lw665d.tw";
const API = "https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1";
const call = (path: string, method = "GET") => apiRedirect(new Request(SITE + path, { method }));

Deno.test("AR-1 /functions/v1/sources 一定轉到 Supabase（保留查詢字串），回應講清楚正確網址", async () => {
  const r = call("/functions/v1/sources?party=民進黨&format=md&need=photo,policy");
  assert(r, "應該轉址");
  assertEquals(r!.status, 307);
  const loc = new URL(r!.headers.get("Location")!);
  assertEquals(loc.origin + loc.pathname, `${API}/sources`);
  assertEquals(loc.searchParams.get("party"), "民進黨");
  assertEquals(loc.searchParams.get("format"), "md");
  assertEquals(loc.searchParams.get("need"), "photo,policy");
  const j = await r!.json();
  assertEquals(j.error, "wrong_host");
  assert(String(j.message).includes(`${API}/sources`));
});

Deno.test("AR-2 網站頁面 /sources 照舊（一般瀏覽、爬蟲不被轉走）", () => {
  assertEquals(call("/sources"), null);
  assertEquals(call("/sources/"), null);
  assertEquals(call("/sources?utm_source=x"), null);
  assertEquals(call("/sources", "HEAD"), null);
});

Deno.test("AR-3 /sources 帶代理才用的參數（format、need）或非 GET 也轉", () => {
  assertEquals(call("/sources?format=md")?.status, 307);
  assertEquals(call("/sources?need=photo")?.status, 307);
  assertEquals(call("/sources", "POST")?.status, 307);
});

Deno.test("AR-4 既有行為沒壞：next 一律轉、tasks／verify 只有代理樣子才轉、其他網站頁不轉", () => {
  assertEquals(call("/next")?.status, 307);
  assertEquals(call("/functions/v1/next")?.status, 307);
  assertEquals(call("/tasks"), null);
  assertEquals(call("/tasks?agent_name=x")?.status, 307);
  assertEquals(call("/functions/v1/tasks")?.status, 307);
  assertEquals(call("/verify"), null);
  assertEquals(call("/elections"), null);
  assertEquals(call("/functions/v1/not-an-endpoint"), null);
});
