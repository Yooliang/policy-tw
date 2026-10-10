import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Gce, handleConsoleVm, type Instance, type MetadataItem, parseSpec, summarize } from "./console-vm-handler.ts";
import type { VerifyResult } from "./firebase-id-token.ts";

/**
 * console-vm 的業務邏輯單元測試（工作單 Yooliang/policy-ops#65）：不打真的 GCP，Compute 介面整個注入假的。
 */

const OWNER = "owner@example.com";
const OK_VERIFY: VerifyResult = { ok: true, claims: { sub: "u1", aud: "p", iss: "i", exp: 9e9, iat: 0, email: OWNER, email_verified: true } };
const OTHER: VerifyResult = { ok: true, claims: { sub: "u2", aud: "p", iss: "i", exp: 9e9, iat: 0, email: "x@example.com", email_verified: true } };

function req(body: unknown, auth: string | null = "Bearer t"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers["authorization"] = auth;
  return new Request("https://example.com/console-vm", { method: "POST", headers, body: JSON.stringify(body) });
}

type Call = [string, ...unknown[]];
function fakeGce(status: Record<string, string>, base: MetadataItem[] = [{ key: "startup-script", value: "#!/bin/bash" }, { key: "secret-project", value: "policy-tw" }]) {
  const calls: Call[] = [];
  const meta: Record<string, MetadataItem[]> = {};
  const gce: Gce = {
    get: async (name) => ({ status: status[name], lastStartTimestamp: "2026-10-10T11:00:00.000Z", metadata: { fingerprint: "fp-" + name, items: meta[name] ?? base } } as Instance),
    setMetadata: async (name, zone, fp, items) => { calls.push(["setMetadata", name, zone, fp]); meta[name] = items; },
    start: async (name, zone) => { calls.push(["start", name, zone]); },
    stop: async (name, zone) => { calls.push(["stop", name, zone]); },
    serial: async () => "x\n=== AGENT-START name=a ===\nsecret-ish output\n=== AGENT-START name=b ===\n",
  };
  return { gce, calls, meta };
}
const deps = (gce: Gce | null, verify: VerifyResult = OK_VERIFY, random = () => 0.1) =>
  ({ gce, projectId: "policy-tw", ownerEmail: OWNER, verifyToken: (async () => verify) as any, random });

const ALL_OFF = { "policy-verifier": "TERMINATED", "policy-verifier-tw": "TERMINATED", "policy-verifier-jp": "TERMINATED" };

Deno.test("沒帶 token 401、非擁有者 403，而且都沒碰到 GCP", async () => {
  const f = fakeGce(ALL_OFF);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "us" }, null), deps(f.gce))).status, 401);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "us" }), deps(f.gce, OTHER))).status, 403);
  assertEquals(f.calls.length, 0);
});

Deno.test("parseSpec：只收 g／c，y（yooliang 留給開發）與格式錯誤、超過上限都擋", () => {
  assert(!("error" in parseSpec("g4")));
  assert(!("error" in parseSpec("g2c2")));
  assert("error" in parseSpec("y2"));
  assert("error" in parseSpec("g2y2"));
  assert("error" in parseSpec("a2"));
  assert("error" in parseSpec("g0"));
  assert("error" in parseSpec("g9"));
  assert("error" in parseSpec(""));
  assert("error" in parseSpec(4));
});

Deno.test("start 指定 vm：保留原本 metadata（startup-script 等），只覆寫四個鍵；先寫設定再開機", async () => {
  const f = fakeGce(ALL_OFF);
  const res = await handleConsoleVm(req({ action: "start", site: "jp", spec: "g2c1", hours: 2, vm: "tw" }), deps(f.gce));
  const j = await res.json();
  assertEquals(res.status, 200, JSON.stringify(j));
  assertEquals(j.vm.key, "tw");
  assertEquals(f.calls.map((c) => c[0]), ["setMetadata", "start"]);
  assertEquals(f.calls[0][3], "fp-policy-verifier-tw", "setMetadata 要帶原本的 fingerprint");
  const items = Object.fromEntries(f.meta["policy-verifier-tw"].map((i) => [i.key, i.value]));
  assertEquals(items["startup-script"], "#!/bin/bash", "不能把 startup-script 洗掉");
  assertEquals(items["secret-project"], "policy-tw");
  assertEquals(items["site"], "jp");
  assertEquals(items["run-hours"], "2");
  assertEquals(items["verify-only"], "0");
  const specs = items["agents"].split("|");
  assertEquals(specs.length, 3);
  assertEquals(specs.filter((s) => s.startsWith("claude:claude-sonnet-5=")).length, 2);
  assertEquals(specs.filter((s) => s.startsWith("claude3:claude-sonnet-5=")).length, 1);
  assert(specs.every((s) => s.endsWith("#fresh")));
  assertEquals(new Set(specs.map((s) => s.split("=")[1])).size, 3, "同一輪代號不重複");
});

Deno.test("start 不指定 vm：跳過在跑的，挑關著的；三台都在跑就 409 且不動作", async () => {
  const f = fakeGce({ "policy-verifier": "RUNNING", "policy-verifier-tw": "TERMINATED", "policy-verifier-jp": "RUNNING" });
  const j = await (await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4" }), deps(f.gce))).json();
  assertEquals(j.vm.key, "tw");
  assertEquals(f.calls.at(-1), ["start", "policy-verifier-tw", "asia-east1-b"]);

  const busy = fakeGce({ "policy-verifier": "RUNNING", "policy-verifier-tw": "RUNNING", "policy-verifier-jp": "STAGING" });
  assertEquals((await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4" }), deps(busy.gce))).status, 409);
  assertEquals(busy.calls.length, 0);
});

Deno.test("start 指定的那台還在跑：409，不寫設定也不開機", async () => {
  const f = fakeGce({ ...ALL_OFF, "policy-verifier-jp": "RUNNING" });
  assertEquals((await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4", vm: "jp" }), deps(f.gce))).status, 409);
  assertEquals(f.calls.length, 0);
});

Deno.test("start 參數檢查：site、hours、vm、spec 不合法都 400 且不動 GCP", async () => {
  const f = fakeGce(ALL_OFF);
  for (const b of [
    { action: "start", site: "us", spec: "g4" },
    { action: "start", site: "tw", spec: "g4", hours: 0 },
    { action: "start", site: "tw", spec: "g4", hours: 7 },
    { action: "start", site: "tw", spec: "g4", hours: 1.5 },
    { action: "start", site: "tw", spec: "g4", vm: "us2" },
    { action: "start", site: "tw", spec: "y4" },
  ]) assertEquals((await handleConsoleVm(req(b), deps(f.gce))).status, 400, JSON.stringify(b));
  assertEquals(f.calls.length, 0);
});

Deno.test("stop：只收 us／tw／jp", async () => {
  const f = fakeGce(ALL_OFF);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "jp" }), deps(f.gce))).status, 200);
  assertEquals(f.calls, [["stop", "policy-verifier-jp", "asia-northeast1-a"]]);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "policy-verifier" }), deps(f.gce))).status, 400);
});

Deno.test("status：三台都回，只數 AGENT-START、不回傳序列埠原文", async () => {
  const f = fakeGce({ ...ALL_OFF, "policy-verifier": "RUNNING" });
  const j = await (await handleConsoleVm(req({ action: "status" }), deps(f.gce))).json();
  assertEquals(j.vms.map((v: { key: string }) => v.key), ["us", "tw", "jp"]);
  assertEquals(j.vms[0].agents_started, 2);
  assertEquals(j.vms[1].agents_started, 0);
  assert(!JSON.stringify(j).includes("secret-ish"), "序列埠原文不能回到前端");
});

Deno.test("summarize：推算預計關機時間、帳號名對照（claude2＝yooliang、claude3＝cwen）", () => {
  const s = summarize("us", {
    status: "RUNNING",
    lastStartTimestamp: "2026-10-10T11:00:00.000Z",
    metadata: { items: [{ key: "run-hours", value: "2" }, { key: "site", value: "tw" }, { key: "agents", value: "claude:claude-sonnet-5=a#fresh|claude2:claude-sonnet-5=b#fresh|claude3:claude-sonnet-5=c#fresh" }] },
  }, "");
  assertEquals(s.ends_at, "2026-10-10T13:00:00.000Z");
  assertEquals(s.agents.map((a) => a.account), ["gsit", "yooliang", "cwen"]);
  assertEquals(s.site, "tw");
});

Deno.test("金鑰沒設：500，訊息講清楚", async () => {
  const res = await handleConsoleVm(req({ action: "status" }), deps(null));
  assertEquals(res.status, 500);
  assert((await res.json()).error.includes("CONSOLE_VM_SA_KEY"));
});
