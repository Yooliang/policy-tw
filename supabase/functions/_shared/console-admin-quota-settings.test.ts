import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleConsoleAdmin, QUOTA_FIELDS, type RpcClient } from "./console-admin-handler.ts";
import type { VerifyResult } from "./firebase-id-token.ts";

/**
 * console-admin 的 quota_settings_save（#769 第一批的主控台寫入口）：授權、參數驗證、成功路徑（假 client）。
 * RPC 本身（上下限 CHECK、edit_history）由 quota-settings 的 PGlite 測試負責，這裡不打資料庫。
 */
const OWNER = "owner@example.com";
const OK: VerifyResult = { ok: true, claims: { sub: "u1", aud: "p", iss: "i", exp: 9e9, iat: 0, email: OWNER, email_verified: true } };
const GOOD = { action: "quota_settings_save", site: "tw", per_ip_submit: 120, per_ip_verify: 200, per_ditrust_submit: 500, per_ditrust_verify: 1000, reason: "測試" };

function req(body: unknown, auth: string | null = "Bearer faketoken"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers["authorization"] = auth;
  return new Request("https://example.com/console-admin", { method: "POST", headers, body: JSON.stringify(body) });
}
function setup(verify: () => Promise<VerifyResult> = async () => OK, rpcError: unknown = null) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: RpcClient = async (fn, args) => {
    calls.push({ fn, args });
    return { data: rpcError ? null : { site: args.p_site, per_ip_submit: args.p_per_ip_submit }, error: rpcError };
  };
  const rpcJp: RpcClient = async () => {
    throw new Error("日本站 client 不該被叫");
  };
  return { calls, d: { rpc, rpcJp, projectId: "policy-tw", ownerEmail: OWNER, verifyToken: verify as any } };
}

Deno.test("quota_settings_save：沒帶 token 401、token 不合法 401、非擁有者 403，都不叫 RPC", async () => {
  const s = setup();
  assertEquals((await handleConsoleAdmin(req(GOOD, null), s.d)).status, 401);
  const bad = setup(async () => ({ ok: false, reason: "bad_signature" }));
  assertEquals((await handleConsoleAdmin(req(GOOD), bad.d)).status, 401);
  const other = setup(async () => ({ ok: true, claims: { ...(OK as any).claims, email: "x@example.com" } }));
  assertEquals((await handleConsoleAdmin(req(GOOD), other.d)).status, 403);
  assertEquals(s.calls.length + bad.calls.length + other.calls.length, 0);
});

Deno.test("quota_settings_save：成功路徑 tw／jp 都走台灣站 client 的 console_admin_quota_settings_save，p_set_by 是擁有者信箱", async () => {
  const s = setup();
  for (const site of ["tw", "jp"]) {
    const res = await handleConsoleAdmin(req({ ...GOOD, site }), s.d);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).success, true);
  }
  assertEquals(s.calls.map((c) => [c.fn, c.args.p_site]), [["console_admin_quota_settings_save", "tw"], ["console_admin_quota_settings_save", "jp"]]);
  assertEquals(s.calls[0].args, {
    p_site: "tw", p_per_ip_submit: 120, p_per_ip_verify: 200, p_per_ditrust_submit: 500, p_per_ditrust_verify: 1000, p_reason: "測試", p_set_by: OWNER,
  });
});

Deno.test("quota_settings_save：上下限邊界值通過，差一格被擋；非整數、字串、缺欄位被擋；都不叫 RPC", async () => {
  for (const f of QUOTA_FIELDS) {
    const ok = setup();
    for (const v of [f.min, f.max]) assertEquals((await handleConsoleAdmin(req({ ...GOOD, [f.key]: v }), ok.d)).status, 200, `${f.key}=${v}`);
    const no = setup();
    const bads: unknown[] = [f.min - 1, f.max + 1, 12.5, "100", null, NaN, undefined];
    for (const v of bads) assertEquals((await handleConsoleAdmin(req({ ...GOOD, [f.key]: v }), no.d)).status, 400, `${f.key}=${String(v)}`);
    assertEquals(no.calls.length, 0);
  }
});

Deno.test("quota_settings_save：reason 空白、site 不是 tw／jp 被擋，不叫 RPC", async () => {
  const s = setup();
  for (const reason of ["", "   ", undefined]) assertEquals((await handleConsoleAdmin(req({ ...GOOD, reason }), s.d)).status, 400);
  for (const site of ["kr", "policy_jp", "TW", 1]) assertEquals((await handleConsoleAdmin(req({ ...GOOD, site }), s.d)).status, 400);
  assertEquals(s.calls.length, 0);
});

Deno.test("quota_settings_save：RPC 失敗回 400 帶後端訊息，且不含 token 或信箱以外的憑證", async () => {
  const s = setup(async () => OK, { message: "reason 必填", code: "P0001" });
  const res = await handleConsoleAdmin(req(GOOD), s.d);
  assertEquals(res.status, 400);
  const text = await res.text();
  assert(text.includes("reason 必填"));
  assert(!text.includes("faketoken") && !text.toLowerCase().includes("bearer"));
});
