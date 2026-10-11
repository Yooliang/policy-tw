import { assert, assertEquals } from "jsr:@std/assert@1";
import { GRACE_SECONDS, type Gce, handleConsoleVm, type Instance, type MetadataItem, parseCounts, parseSpec, splitSites, summarize } from "./console-vm-handler.ts";
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
    get: async (name) => (calls.push(["get", name]), { status: status[name], lastStartTimestamp: "2026-10-10T11:00:00.000Z", metadata: { fingerprint: "fp-" + name, items: meta[name] ?? base } } as Instance),
    setMetadata: async (name, zone, fp, items) => { calls.push(["setMetadata", name, zone, fp]); meta[name] = items; },
    setMaxRun: async (name, zone, sec) => { calls.push(["setMaxRun", name, zone, sec]); },
    start: async (name, zone) => { calls.push(["start", name, zone]); },
    stop: async (name, zone) => { calls.push(["stop", name, zone]); },
    serial: async (name) => (calls.push(["serial", name]), "x\n=== AGENT-START name=a ===\nsecret-ish output\n=== AGENT-START name=b ===\n"),
  };
  return { gce, calls, meta };
}
const deps = (gce: Gce | null, verify: VerifyResult = OK_VERIFY, random = () => 0.1) =>
  ({ gce, projectId: "policy-tw", ownerEmail: OWNER, verifyToken: (async () => verify) as any, random });

const writes = (calls: Call[]) => calls.filter((c) => c[0] !== "get" && c[0] !== "serial");
const ALL_OFF = { "policy-verifier": "TERMINATED", "policy-verifier-tw": "TERMINATED", "policy-verifier-jp": "TERMINATED" };

const BAD_TOKEN: VerifyResult = { ok: false, reason: "bad_signature" } as VerifyResult;

Deno.test("status／start／stop：沒帶 token 401、token 驗不過 401、非擁有者 403，而且連 get／serial 都沒碰到 GCP", async () => {
  for (const body of [{ action: "status" }, { action: "start", site: "tw", spec: "g4" }, { action: "stop", vm: "us" }]) {
    const f = fakeGce(ALL_OFF);
    assertEquals((await handleConsoleVm(req(body, null), deps(f.gce))).status, 401, JSON.stringify(body));
    assertEquals((await handleConsoleVm(req(body), deps(f.gce, BAD_TOKEN))).status, 401, JSON.stringify(body));
    assertEquals((await handleConsoleVm(req(body), deps(f.gce, OTHER))).status, 403, JSON.stringify(body));
    assertEquals(f.calls, [], JSON.stringify(body));
  }
});

Deno.test("body 是 null／陣列／數字：400，不是 502，也不碰 GCP（審查第 3 點）", async () => {
  for (const body of [null, [], 3, "status"]) {
    const f = fakeGce(ALL_OFF);
    const res = await handleConsoleVm(req(body), deps(f.gce));
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(f.calls, []);
  }
});

Deno.test("parseSpec：收 g／y／c（10-11 起 yooliang 也可選），格式錯誤、超過上限都擋", () => {
  assert(!("error" in parseSpec("g4")));
  assert(!("error" in parseSpec("g2c2")));
  assert(!("error" in parseSpec("g2y2")));
  assert("error" in parseSpec("a2"));
  assert("error" in parseSpec("g0"));
  assert("error" in parseSpec("g13"));
  assert("error" in parseSpec(""));
  assert("error" in parseSpec(4));
});

Deno.test("start 指定 vm：保留原本 metadata（startup-script 等），只覆寫四個鍵；先寫設定再開機", async () => {
  const f = fakeGce(ALL_OFF);
  const res = await handleConsoleVm(req({ action: "start", site: "jp", spec: "g2c1", hours: 2, vm: "tw" }), deps(f.gce));
  const j = await res.json();
  assertEquals(res.status, 200, JSON.stringify(j));
  assertEquals(j.vm.key, "tw");
  assertEquals(writes(f.calls).map((c) => c[0]), ["setMetadata", "setMaxRun", "start"], "先寫設定、再設硬上限、最後開機");
  assertEquals(writes(f.calls)[0][3], "fp-policy-verifier-tw", "setMetadata 要帶原本的 fingerprint");
  assertEquals(writes(f.calls)[1][3], 2 * 3600 + GRACE_SECONDS, "硬上限＝hours＋寬限（審查第 1 點）");
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

Deno.test("start：setMaxRun 失敗就不開機（硬上限沒設好不能開）", async () => {
  const f = fakeGce(ALL_OFF);
  f.gce.setMaxRun = async () => { throw new Error("permission denied"); };
  const res = await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4", vm: "us" }), deps(f.gce));
  assertEquals(res.status, 502);
  assert(!f.calls.some((c) => c[0] === "start"));
});

Deno.test("start 不指定 vm：跳過在跑的，挑關著的；三台都在跑就 409 且不動作", async () => {
  const f = fakeGce({ "policy-verifier": "RUNNING", "policy-verifier-tw": "TERMINATED", "policy-verifier-jp": "RUNNING" });
  const j = await (await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4" }), deps(f.gce))).json();
  assertEquals(j.vm.key, "tw");
  assertEquals(f.calls.at(-1), ["start", "policy-verifier-tw", "asia-east1-b"]);

  const busy = fakeGce({ "policy-verifier": "RUNNING", "policy-verifier-tw": "RUNNING", "policy-verifier-jp": "STAGING" });
  assertEquals((await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4" }), deps(busy.gce))).status, 409);
  assertEquals(writes(busy.calls), []);
});

Deno.test("start 指定的那台還在跑：409，不寫設定也不開機", async () => {
  const f = fakeGce({ ...ALL_OFF, "policy-verifier-jp": "RUNNING" });
  assertEquals((await handleConsoleVm(req({ action: "start", site: "tw", spec: "g4", vm: "jp" }), deps(f.gce))).status, 409);
  assertEquals(writes(f.calls), []);
});

Deno.test("start 參數檢查：site、hours、vm、spec 不合法都 400 且不動 GCP", async () => {
  const f = fakeGce(ALL_OFF);
  for (const b of [
    { action: "start", site: "us", spec: "g4" },
    { action: "start", site: "tw", spec: "g4", hours: 0 },
    { action: "start", site: "tw", spec: "g4", hours: 7 },
    { action: "start", site: "tw", spec: "g4", hours: 1.5 },
    { action: "start", site: "tw", spec: "g4", vm: "us2" },
    { action: "start", site: "tw", spec: "a4" },
    { action: "start", site: "tw", counts: { g: 5 }, vm: "us" },
    { action: "start", site: "tw", counts: { g: 0, y: 0, c: 0 }, vm: "us" },
    { action: "start", site: "tw", counts: { g: 1.5 }, vm: "us" },
    { action: "start", site: "tw", counts: { x: 1 }, vm: "us" },
    { action: "start", site: "tw", counts: [1, 2], vm: "us" },
    { action: "start", site: "us", counts: { g: 1 }, vm: "us" },
  ]) assertEquals((await handleConsoleVm(req(b), deps(f.gce))).status, 400, JSON.stringify(b));
  assertEquals(f.calls, [], "參數錯連 get 都不該打");
});

Deno.test("stop：只收 us／tw／jp", async () => {
  const f = fakeGce(ALL_OFF);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "jp" }), deps(f.gce))).status, 200);
  assertEquals(writes(f.calls), [["stop", "policy-verifier-jp", "asia-northeast1-a"]]);
  assertEquals((await handleConsoleVm(req({ action: "stop", vm: "policy-verifier" }), deps(f.gce))).status, 400);
});

Deno.test("status：三台都回，只數 AGENT-START、不回傳序列埠原文", async () => {
  const f = fakeGce({ ...ALL_OFF, "policy-verifier": "RUNNING" });
  const j = await (await handleConsoleVm(req({ action: "status" }), deps(f.gce))).json();
  assertEquals(j.vms.map((v: { key: string }) => v.key), ["us", "tw", "jp"]);
  assertEquals(j.vms[0].agents_started, 2);
  assertEquals(j.vms[1].agents_started, 0);
  assert(!JSON.stringify(j).includes("secret-ish"), "序列埠原文不能回到前端");
  assertEquals(f.calls.filter((c) => c[0] === "serial").map((c) => c[1]), ["policy-verifier"], "只讀在跑的那台的序列埠");
  assertEquals(writes(f.calls), [], "status 不寫任何東西");
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

Deno.test("splitSites：both 平均分、單數台灣多一隻；單站全部同一站", () => {
  assertEquals(splitSites(4, "both"), ["tw", "tw", "jp", "jp"]);
  assertEquals(splitSites(5, "both"), ["tw", "tw", "tw", "jp", "jp"]);
  assertEquals(splitSites(1, "both"), ["tw"]);
  assertEquals(splitSites(3, "jp"), ["jp", "jp", "jp"]);
});

Deno.test("parseCounts：g／y／c 各 0～4、合計至少 1", () => {
  assertEquals(parseCounts({ g: 2, y: 2 }), { parts: [{ letter: "g", count: 2 }, { letter: "y", count: 2 }] });
  assert("error" in parseCounts({ g: 0 }));
  assert("error" in parseCounts({ c: 5 }));
  assert("error" in parseCounts(null));
});

Deno.test("start 矩陣＋兩站都開：gsit 2＋yooliang 1＝3 隻 → 前 2 隻台灣、後 1 隻日本，VM site 記 tw", async () => {
  const f = fakeGce(ALL_OFF);
  const res = await handleConsoleVm(req({ action: "start", vm: "jp", counts: { g: 2, y: 1, c: 0 }, hours: 3, site: "both" }), deps(f.gce));
  const j = await res.json();
  assertEquals(res.status, 200, JSON.stringify(j));
  const items = Object.fromEntries(f.meta["policy-verifier-jp"].map((i) => [i.key, i.value]));
  assertEquals(items["site"], "tw");
  assertEquals(items["run-hours"], "3");
  const specs = items["agents"].split("|");
  assertEquals(specs.map((x) => x.split(":")[0]), ["claude", "claude", "claude2"]);
  assertEquals(specs.map((x) => x.slice(x.lastIndexOf("@") + 1)), ["tw", "tw", "jp"]);
  assert(specs.every((x) => /#fresh@(tw|jp)$/.test(x)));
  assertEquals(j.agents.map((a: { site: string }) => a.site), ["tw", "tw", "jp"]);
  assertEquals(j.agents.map((a: { account: string }) => a.account), ["gsit", "gsit", "yooliang"]);
});

Deno.test("start 矩陣單站：agents 不加 @ 後綴（舊開機腳本也看得懂）", async () => {
  const f = fakeGce(ALL_OFF);
  const res = await handleConsoleVm(req({ action: "start", vm: "us", counts: { g: 1, c: 1 }, hours: 1, site: "jp" }), deps(f.gce));
  assertEquals(res.status, 200);
  const items = Object.fromEntries(f.meta["policy-verifier"].map((i) => [i.key, i.value]));
  assertEquals(items["site"], "jp");
  assert(!items["agents"].includes("@"));
});

Deno.test("summarize：代理各自站別；兩站混跑回 both", () => {
  const s = summarize("tw", {
    status: "RUNNING", lastStartTimestamp: "2026-10-10T11:00:00.000Z",
    metadata: { items: [{ key: "run-hours", value: "1" }, { key: "site", value: "tw" }, { key: "agents", value: "claude:claude-sonnet-5=a#fresh@tw|claude2:claude-sonnet-5=b#fresh@jp" }] },
  }, "");
  assertEquals(s.site, "both");
  assertEquals(s.agents.map((a) => [a.name, a.site]), [["a", "tw"], ["b", "jp"]]);
  const one = summarize("us", { status: "TERMINATED", metadata: { items: [{ key: "site", value: "jp" }, { key: "agents", value: "claude:claude-sonnet-5=x#fresh" }] } }, "");
  assertEquals(one.site, "jp");
  assertEquals(one.agents[0].site, "jp");
});
