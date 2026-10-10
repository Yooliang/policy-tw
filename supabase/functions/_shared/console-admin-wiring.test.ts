import { assert } from "jsr:@std/assert@1";

/**
 * console-admin 的接線（2026-10-09 agy 審查第一點，退回修正）：Supabase 閘道預設 verify_jwt=true，會拿 Supabase 自己的 JWT
 * 密鑰去驗 Authorization 的 Bearer；console-admin 收的是 Firebase ID Token（不同簽發者），閘道驗簽一定失敗、函式本體根本跑不到，
 * 一律 401。config.toml 要有 [functions.console-admin]、verify_jwt = false，函式自己才驗得到 Firebase token。
 *
 * 這裡只守 console-admin 這一條（不是掃全部函式目錄——ask／fetch-cec-data／question-stance 現在就沒有 config.toml 段落，
 * 是既有缺口，不在這張 PR 的範圍內；已另外回報，不在這裡一起擋，否則這支測試會紅在跟 #518 無關的地方）。
 */
const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test("console-admin：config.toml 有登記，verify_jwt 關（閘道不驗 Supabase JWT，函式自己驗 Firebase ID Token），entrypoint 指對", async () => {
  const cfg = await read("../../config.toml");
  const m = /\[functions\.console-admin\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
  assert(m, "config.toml 要有 [functions.console-admin]");
  assert(/verify_jwt = false/.test(m[1]), "verify_jwt 要是 false（Firebase ID Token 不是 Supabase 自己發的 JWT）");
  assert(m[1].includes('entrypoint = "./functions/console-admin/index.ts"'));
});

Deno.test("console-admin：業務邏輯在 handleConsoleAdmin 裡驗 Firebase ID Token，驗不過才往下呼叫 RPC（index.ts 只是薄包裝）", async () => {
  const idx = await read("../console-admin/index.ts");
  assert(idx.includes("handleConsoleAdmin("), "index.ts 要把 request 轉給 handleConsoleAdmin（業務邏輯抽到 _shared，才能單元測試）");

  const handler = await read("./console-admin-handler.ts");
  const verify = handler.indexOf("await verify(token");
  assert(verify > 0, "handleConsoleAdmin 要呼叫 verifyFirebaseIdToken（透過可注入的 deps.verifyToken）");
  const reject = handler.indexOf("!verified.ok");
  assert(reject > verify, "驗證沒過要直接回應、不能往下做（拿掉這一行等於不驗證）");
  const firstRpc = handler.indexOf("deps.rpc"); // deps.rpc／deps.rpcJp 都算（2026-10-10 起依 site 選 RPC）
  assert(firstRpc > reject, "呼叫任何 RPC 都要在驗證通過之後");
});

Deno.test("console-admin：日本站走 _shared/jp/client.ts 的 jpClient（schema 寫死 policy_jp），index.ts 不從請求取 schema", async () => {
  const idx = await read("../console-admin/index.ts");
  assert(idx.includes('from "../_shared/jp/client.ts"') && idx.includes("jpClient("), "index.ts 要用 jpClient 組日本站 RPC");
  assert(idx.includes("rpcJp"), "index.ts 要把 rpcJp 交給 handler");
  assert(!/\.schema\(|db:\s*\{\s*schema/.test(idx), "index.ts 不自己組 schema（只經 jpClient）");
  const handler = await read("./console-admin-handler.ts");
  assert(/site !== "tw" && site !== "jp"/.test(handler), "handler 要有 site 白名單（只收 tw／jp）");
  assert(!/schema/i.test(handler.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/policy_jp/g, "")), "handler 不處理 schema 名稱");
});

Deno.test("console-vm：config.toml 有登記，verify_jwt 關，entrypoint 指對；handler 先驗 Firebase token 才碰 GCP", async () => {
  const cfg = await read("../../config.toml");
  const m = /\[functions\.console-vm\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
  assert(m, "config.toml 要有 [functions.console-vm]");
  assert(/verify_jwt = false/.test(m[1]), "verify_jwt 要是 false（Firebase ID Token 不是 Supabase 自己發的 JWT）");
  assert(m[1].includes('entrypoint = "./functions/console-vm/index.ts"'));

  const idx = await read("../console-vm/index.ts");
  assert(idx.includes("handleConsoleVm("), "index.ts 要把 request 轉給 handleConsoleVm");
  const handler = await read("./console-vm-handler.ts");
  const reject = handler.indexOf("!verified.ok");
  const owner = handler.indexOf("isConsoleOwner(verified.claims");
  const firstGce = handler.indexOf("gce.");
  assert(reject > 0 && owner > reject, "要先驗 token 再驗擁有者");
  assert(firstGce > owner, "碰 GCP 一定在驗證之後");
});
