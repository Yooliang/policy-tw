import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkDispatchToken, dispatchTokenSecretFrom, issueDispatchToken } from "../dispatch-token.ts";
import { jpDispatchTokenSecretFrom, JP_TOKEN_SALT } from "./dispatch-secret.ts";

const KEY = "service-role-key-0123456789";
const get = (e: Record<string, string>) => (k: string) => e[k];

Deno.test("日本站鑰匙＝基底鑰匙＋鹽；專用鑰匙優先；太短當沒設", () => {
  assertEquals(jpDispatchTokenSecretFrom(get({ SUPABASE_SERVICE_ROLE_KEY: KEY })), KEY + JP_TOKEN_SALT);
  assertEquals(jpDispatchTokenSecretFrom(get({ SUPABASE_SERVICE_ROLE_KEY: KEY, DISPATCH_TOKEN_SECRET_JP: "jp-dedicated-secret-123" })), "jp-dedicated-secret-123");
  assertEquals(jpDispatchTokenSecretFrom(get({ SUPABASE_SERVICE_ROLE_KEY: KEY, DISPATCH_TOKEN_SECRET_JP: "short" })), KEY + JP_TOKEN_SALT);
  assertEquals(jpDispatchTokenSecretFrom(get({})), undefined);
});

Deno.test("正見簽的憑證日本站驗不過，反過來也一樣", async () => {
  const env = get({ SUPABASE_SERVICE_ROLE_KEY: KEY });
  const tw = dispatchTokenSecretFrom(env);
  const jp = jpDispatchTokenSecretFrom(env);
  const twTok = await issueDispatchToken(tw, { taskId: "auto:x:1", agentName: "a", ipHash: "h" });
  const jpTok = await issueDispatchToken(jp, { taskId: "auto:x:1", agentName: "a", ipHash: "h" });
  const a = await checkDispatchToken(jp, twTok!.token, null);
  assert(!a.ok && a.reason === "bad_signature");
  const b = await checkDispatchToken(tw, jpTok!.token, null);
  assert(!b.ok && b.reason === "bad_signature");
  assert((await checkDispatchToken(jp, jpTok!.token, "auto:x:1")).ok);
});
