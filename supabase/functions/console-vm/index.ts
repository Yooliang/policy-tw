import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type Gce, handleConsoleVm, type Instance } from "../_shared/console-vm-handler.ts";
import { accessToken, parseServiceAccountKey, type ServiceAccountKey } from "../_shared/gcp-sa-token.ts";

/**
 * console-vm — 主控台（policy-console）的驗證 VM 開關、狀態、進度（工作單 Yooliang/policy-ops#65，2026-10-10）。
 *
 * POST body：
 *   { action: "status" }
 *   { action: "start", site: "tw"|"jp", spec: "g4"|"g2c2"…, hours?: 1～6, vm?: "us"|"tw"|"jp" }   （vm 不給＝從關著的隨機挑）
 *   { action: "stop", vm: "us"|"tw"|"jp" }
 * 驗證同 console-admin（Firebase ID Token＋擁有者信箱），業務邏輯在 _shared/console-vm-handler.ts。
 *
 * GCP：Supabase secret CONSOLE_VM_SA_KEY＝服務帳號 console-vm@greenshepherdcomtw 的 JSON 金鑰。
 *   它只有自訂角色 consoleVmOperator（綁在三台 instance 上）：instances.get／start／stop／setMetadata／setScheduling／getSerialPortOutput，
 *   另一個 consoleVmOpsRead（專案層，只有 zoneOperations.get，用來等 operation 跑完）。
 *   不能建立、刪除 VM，也碰不到 Secret Manager 裡代理用的金鑰。
 * ⚠️ config.toml 要有 [functions.console-vm] verify_jwt = false（理由同 console-admin：帶的是 Firebase token，不是 Supabase JWT）。
 */

const DEFAULT_OWNER_EMAIL = "cwen0708@gmail.com";
const DEFAULT_FIREBASE_PROJECT_ID = "policy-tw";
const GCP_PROJECT = "greenshepherdcomtw";
const BASE = `https://compute.googleapis.com/compute/v1/projects/${GCP_PROJECT}/zones`;

function restGce(key: ServiceAccountKey): Gce {
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(key)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Compute API ${res.status}：${j?.error?.message ?? "未知錯誤"}`);
    return j;
  }
  // 等一個 zone operation 跑完（setMetadata 要先生效才開機，否則開機時可能讀到舊的 agents）
  async function wait(zone: string, op: { name?: string; status?: string }) {
    for (let i = 0; i < 30 && op?.name && op.status !== "DONE"; i++) {
      op = await call("POST", `${BASE}/${zone}/operations/${op.name}/wait`);
    }
    if (op?.status !== "DONE") throw new Error("Compute 操作逾時，請稍後看狀態");
    if ((op as { error?: { errors?: { message?: string }[] } }).error) {
      throw new Error(`Compute 操作失敗：${(op as any).error.errors?.[0]?.message ?? "未知"}`);
    }
  }
  return {
    get: (name, zone) => call("GET", `${BASE}/${zone}/instances/${name}`) as Promise<Instance>,
    setMetadata: async (name, zone, fingerprint, items) => {
      await wait(zone, await call("POST", `${BASE}/${zone}/instances/${name}/setMetadata`, { fingerprint, items }));
    },
    // maxRunDuration：開機後滿這麼多秒 GCP 自己 STOP（不是刪除）；VM 要在關機狀態才能改
    setMaxRun: async (name, zone, seconds) => {
      const inst = await call("GET", `${BASE}/${zone}/instances/${name}`);
      const scheduling = { ...(inst.scheduling ?? {}), maxRunDuration: { seconds: String(seconds) }, instanceTerminationAction: "STOP" };
      await wait(zone, await call("POST", `${BASE}/${zone}/instances/${name}/setScheduling`, scheduling));
    },
    start: async (name, zone) => {
      await wait(zone, await call("POST", `${BASE}/${zone}/instances/${name}/start`));
    },
    stop: async (name, zone) => {
      await call("POST", `${BASE}/${zone}/instances/${name}/stop`);
    },
    serial: async (name, zone) => (await call("GET", `${BASE}/${zone}/instances/${name}/serialPort?port=1`)).contents ?? "",
  };
}

Deno.serve(async (req) => {
  const key = parseServiceAccountKey(Deno.env.get("CONSOLE_VM_SA_KEY"));
  return handleConsoleVm(req, {
    gce: key ? restGce(key) : null,
    projectId: Deno.env.get("CONSOLE_FIREBASE_PROJECT_ID") || DEFAULT_FIREBASE_PROJECT_ID,
    ownerEmail: Deno.env.get("CONSOLE_OWNER_EMAIL") || DEFAULT_OWNER_EMAIL,
  });
});
