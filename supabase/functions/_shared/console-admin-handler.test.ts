import { assert, assertEquals } from "jsr:@std/assert@1";
import { blank, errorMessage, handleConsoleAdmin, type RpcClient } from "./console-admin-handler.ts";
import type { VerifyResult } from "./firebase-id-token.ts";

/**
 * console-admin 的業務邏輯單元測試（2026-10-09 agy 審查第 8 點：原本 index.ts 完全沒有自動化測試，
 * 問題 2〔PostgrestError 被轉成 "[object Object]"〕、問題 3〔表單空字串沒正規化成 null〕、
 * 問題 5〔token 簽名解碼例外沒攔會變 500〕都是因此在測試階段漏掉的；這支不打真的網路或資料庫，全部注入假的 deps）。
 */

const OWNER = "owner@example.com";
const OK_VERIFY: VerifyResult = { ok: true, claims: { sub: "u1", aud: "p", iss: "i", exp: 9e9, iat: 0, email: OWNER, email_verified: true } };

function req(body: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null) headers["authorization"] = opts.auth ?? "Bearer faketoken";
  return new Request("https://example.com/console-admin", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deps(rpc: RpcClient, verifyToken = async () => OK_VERIFY) {
  return { rpc, projectId: "policy-tw", ownerEmail: OWNER, verifyToken: verifyToken as any };
}

Deno.test("errorMessage：PostgrestError 這種 { message } 物件能正確取出訊息，不是 [object Object]（agy 審查第 2 點）", () => {
  const postgrestLike = { message: "reason 必填", details: null, hint: null, code: "P0001" };
  assertEquals(errorMessage(postgrestLike), "reason 必填");
  assertEquals(errorMessage(new Error("boom")), "boom");
  assertEquals(errorMessage("plain string"), "plain string");
  assertEquals(errorMessage({ no_message_field: 1 }), "[object Object]"); // 真的什麼都沒有時才退到這個保底
});

Deno.test("blank：空字串（trim 後長度 0）變 null，非空字串與非字串原樣放行（agy 審查第 3 點）", () => {
  assertEquals(blank(""), null);
  assertEquals(blank("   "), null);
  assertEquals(blank("2026-10-09"), "2026-10-09");
  assertEquals(blank(null), null);
  assertEquals(blank(undefined), undefined);
  assertEquals(blank(5), 5);
});

Deno.test("handleConsoleAdmin：沒帶 Authorization 回 401，不往下呼叫 RPC", async () => {
  let called = false;
  const res = await handleConsoleAdmin(req({ action: "override_create" }, { auth: null }), deps(async () => {
    called = true;
    return { data: null, error: null };
  }));
  assertEquals(res.status, 401);
  assertEquals(called, false);
});

Deno.test("handleConsoleAdmin：token 驗證失敗回對應狀態碼（401／503），不往下呼叫 RPC", async () => {
  let called = false;
  const rpc: RpcClient = async () => {
    called = true;
    return { data: null, error: null };
  };
  const res1 = await handleConsoleAdmin(req({ reason: "x" }), deps(rpc, async () => ({ ok: false, reason: "bad_signature" })));
  assertEquals(res1.status, 401);
  const res2 = await handleConsoleAdmin(req({ reason: "x" }), deps(rpc, async () => ({ ok: false, reason: "jwks_unavailable" })));
  assertEquals(res2.status, 503);
  assertEquals(called, false);
});

Deno.test("handleConsoleAdmin：驗證通過但不是擁有者回 403", async () => {
  const res = await handleConsoleAdmin(req({ reason: "x" }), deps(
    async () => ({ data: null, error: null }),
    async () => ({ ok: true, claims: { sub: "u", aud: "p", iss: "i", exp: 9e9, iat: 0, email: "someone-else@example.com", email_verified: true } }),
  ));
  assertEquals(res.status, 403);
});

Deno.test("handleConsoleAdmin：reason 空（或只有空白）回 400，不往下呼叫 RPC", async () => {
  let called = false;
  const res = await handleConsoleAdmin(req({ action: "override_create", reason: "   " }), deps(async () => {
    called = true;
    return { data: null, error: null };
  }));
  assertEquals(res.status, 400);
  assertEquals(called, false);
});

Deno.test("handleConsoleAdmin：RPC 丟 PostgrestError 樣式的物件，回應的 error 是真正的訊息，不是 [object Object]（agy 審查第 2 點）", async () => {
  const res = await handleConsoleAdmin(
    req({ action: "override_create", activity: "raw:policy_missing", force: "closed", reason: "測試" }),
    deps(async () => ({ data: null, error: { message: "覆寫 1 不存在，或已經撤銷／過期", code: "P0001" } })),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "覆寫 1 不存在，或已經撤銷／過期");
  assert(!body.error.includes("[object Object]"));
});

Deno.test("handleConsoleAdmin：override_create 把表單空字串（election_type／open_from／open_until／expires_at）正規化成 null 才送進 RPC（agy 審查第 3 點）", async () => {
  let seenArgs: Record<string, unknown> | null = null;
  const res = await handleConsoleAdmin(
    req({
      action: "override_create", activity: "raw:policy_missing", force: "window",
      election_type: "", open_from: "2026-10-01", open_until: "", expires_at: "", reason: "測試",
    }),
    deps(async (_fn, args) => {
      seenArgs = args;
      return { data: { id: 1 }, error: null };
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(seenArgs!.p_election_type, null);
  assertEquals(seenArgs!.p_open_from, "2026-10-01");
  assertEquals(seenArgs!.p_open_until, null);
  assertEquals(seenArgs!.p_expires_at, null);
});

Deno.test("handleConsoleAdmin：milestone_set 把空字串 election_type 正規化成 null", async () => {
  let seenArgs: Record<string, unknown> | null = null;
  const res = await handleConsoleAdmin(
    req({ action: "milestone_set", election_id: 2026, kind: "draw", election_type: "", on_date: "2026-10-20", status: "announced", reason: "測試" }),
    deps(async (_fn, args) => {
      seenArgs = args;
      return { data: { id: 1 }, error: null };
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(seenArgs!.p_election_type, null);
});

Deno.test("handleConsoleAdmin：override_revoke 正常呼叫，id 不是數字回 400", async () => {
  const bad = await handleConsoleAdmin(req({ action: "override_revoke", id: "1", reason: "x" }), deps(async () => ({ data: null, error: null })));
  assertEquals(bad.status, 400);
  let seenArgs: Record<string, unknown> | null = null;
  const ok = await handleConsoleAdmin(req({ action: "override_revoke", id: 1, reason: "x" }), deps(async (_fn, args) => {
    seenArgs = args;
    return { data: { id: 1 }, error: null };
  }));
  assertEquals(ok.status, 200);
  assertEquals(seenArgs!.p_id, 1);
  assertEquals(seenArgs!.p_revoked_by, OWNER);
});

Deno.test("handleConsoleAdmin：不認得的 action 回 400", async () => {
  const res = await handleConsoleAdmin(req({ action: "delete_everything", reason: "x" }), deps(async () => ({ data: null, error: null })));
  assertEquals(res.status, 400);
});

Deno.test("handleConsoleAdmin：OPTIONS 回 CORS 預檢，不驗證、不呼叫 RPC；非 POST 回 405", async () => {
  let called = false;
  const d = deps(async () => {
    called = true;
    return { data: null, error: null };
  });
  const opt = await handleConsoleAdmin(new Request("https://example.com/console-admin", { method: "OPTIONS" }), d);
  assertEquals(opt.status, 200);
  const get = await handleConsoleAdmin(new Request("https://example.com/console-admin", { method: "GET" }), d);
  assertEquals(get.status, 405);
  assertEquals(called, false);
});

Deno.test("handleConsoleAdmin：body 不是合法 JSON 回 400", async () => {
  const bad = new Request("https://example.com/console-admin", { method: "POST", headers: { authorization: "Bearer t" }, body: "{not json" });
  const res = await handleConsoleAdmin(bad, deps(async () => ({ data: null, error: null })));
  assertEquals(res.status, 400);
});
