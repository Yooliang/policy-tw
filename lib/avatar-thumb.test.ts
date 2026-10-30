/**
 * 頭像縮圖（lib/avatar-thumb.ts、composables/useAvatarThumb.ts、migration 20261031100000）。
 * 重點三件事：①沒縮圖／查詢失敗一律退回原圖 ②批次合併、不重複問 ③兩處頭像元件真的接了縮圖、migration 的 RLS 只放行 ok 的列。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildThumb, createThumbLoader, isThumbCandidate, type ThumbRow } from "./avatar-thumb.ts";

const BASE = "https://x.supabase.co";
const row = (o: Partial<ThumbRow> = {}): ThumbRow => ({ src_url: "https://ws.moi.gov.tw/a.jpg", w160: "ab/160.webp", w330: "ab/330.webp", w660: "ab/660.webp", ...o });

Deno.test("buildThumb：srcset 帶寬度描述、src 優先 330", () => {
  const t = buildThumb(row(), BASE)!;
  assertEquals(t.src, `${BASE}/storage/v1/object/public/avatar-thumbs/ab/330.webp`);
  assertEquals(t.srcset, [160, 330, 660].map((w) => `${BASE}/storage/v1/object/public/avatar-thumbs/ab/${w}.webp ${w}w`).join(", "));
});

Deno.test("buildThumb：原圖太小沒做的尺寸略過；全沒有或沒有列＝null（用原圖）", () => {
  const t = buildThumb(row({ w330: null, w660: null }), BASE)!;
  assertEquals(t.src, `${BASE}/storage/v1/object/public/avatar-thumbs/ab/160.webp`);
  assertEquals(t.srcset.includes("330w"), false);
  assertEquals(buildThumb(row({ w160: null, w330: null, w660: null }), BASE), null);
  assertEquals(buildThumb(null, BASE), null);
  assertEquals(buildThumb(row(), ""), null);
});

Deno.test("isThumbCandidate：只查外部 http(s) 圖，儲存桶自己的與預設圖不查", () => {
  assert(isThumbCandidate("https://ws.moi.gov.tw/a.jpg", BASE));
  assert(!isThumbCandidate(null, BASE));
  assert(!isThumbCandidate("/local.png", BASE));
  assert(!isThumbCandidate(`${BASE}/storage/v1/object/public/avatar-thumbs/x/160.webp`, BASE));
  assert(!isThumbCandidate("https://api.dicebear.com/9.x/shapes/svg?seed=a", BASE));
});

function harness(fetchRows: (u: string[]) => Promise<ThumbRow[]>) {
  const timers: Array<() => void> = [];
  const resolved: Array<Map<string, ThumbRow | null>> = [];
  const loader = createThumbLoader({ fetchRows, onResolved: (m) => resolved.push(m), schedule: (fn) => { timers.push(fn); }, chunkSize: 3 });
  const tick = async () => { const t = timers.splice(0); t.forEach((f) => f()); await new Promise((r) => setTimeout(r, 0)); };
  return { loader, resolved, tick, timers };
}

Deno.test("載入器：同一輪的 request 合併成一批、重複的網址不再問、沒回的網址標成 null", async () => {
  const calls: string[][] = [];
  const h = harness((urls) => { calls.push(urls); return Promise.resolve(urls.filter((u) => u === "a").map((u) => row({ src_url: u }))); });
  h.loader.request("a"); h.loader.request("b"); h.loader.request("a");
  assertEquals(h.timers.length, 1, "只排一次計時器");
  await h.tick();
  assertEquals(calls, [["a", "b"]]);
  assertEquals(h.resolved[0].get("a")?.w330, "ab/330.webp");
  assertEquals(h.resolved[0].get("b"), null, "查過但沒縮圖＝null，之後不再問");
  h.loader.request("b");
  assertEquals(h.timers.length, 0);
});

Deno.test("載入器：超過 chunkSize 分多批；查詢失敗不丟錯、之後可重問", async () => {
  const calls: string[][] = [];
  let fail = true;
  const h = harness((urls) => { calls.push(urls); return fail ? Promise.reject(new Error("net")) : Promise.resolve([]); });
  for (const u of ["1", "2", "3", "4"]) h.loader.request(u);
  await h.tick();
  assertEquals(calls.length, 2, "4 個網址、每批 3 個＝2 批");
  assertEquals(h.resolved.length, 0, "失敗沒有通知，使用處維持原圖");
  fail = false;
  h.loader.request("1");
  assertEquals(h.timers.length, 1, "失敗過的網址可以再問");
});

Deno.test("守門：Avatar.vue 與選舉頁卡片都接了縮圖，且有退回原圖的路徑", () => {
  const avatar = Deno.readTextFileSync(new URL("../components/Avatar.vue", import.meta.url));
  const grid = Deno.readTextFileSync(new URL("../pages/election/PoliticianGrid.vue", import.meta.url));
  for (const [name, src] of [["Avatar.vue", avatar], ["PoliticianGrid.vue", grid]] as const) {
    assertStringIncludes(src, "thumbFor(", `${name} 要呼叫 thumbFor`);
    assertStringIncludes(src, ":srcset=", `${name} 要輸出 srcset`);
    assertStringIncludes(src, "@error=", `${name} 縮圖壞掉要有 error 處理`);
  }
  assertStringIncludes(avatar, 'loading="lazy"');
  assertStringIncludes(avatar, 'decoding="async"');
  assertStringIncludes(avatar, ":width=");
});

Deno.test("守門：migration 匿名只讀 status=ok、不開寫入、桶公開、待辦清單只給 service_role", () => {
  const sql = Deno.readTextFileSync(new URL("../supabase/migrations/20261031100000_avatar_thumbs.sql", import.meta.url));
  assertStringIncludes(sql, "ALTER TABLE avatar_thumbs ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "FOR SELECT TO anon, authenticated USING (status = 'ok')");
  assertEquals(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/i.test(sql), false, "不能建任何寫入 policy");
  assertStringIncludes(sql, "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON avatar_thumbs FROM anon, authenticated");
  assertStringIncludes(sql, "'avatar-thumbs', 'avatar-thumbs', true");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION avatar_thumbs_pending(INTEGER) TO service_role");
  assertEquals(/GRANT EXECUTE ON FUNCTION avatar_thumbs_pending[^;]*(anon|authenticated|PUBLIC)/i.test(sql.replace(/REVOKE[^;]*;/g, "")), false);
});
