/**
 * DiTrust 顯示名不外洩、匿名冒用擋下（2026-10-29，docs/decisions/2026-10-29-DiTrust顯示名不外洩與匿名冒用擋下.md）
 * 起因：代理把 /next 回應裡的顯示名（涼糕）當 agent_name 送回來 → 被當匿名，票算進網段額度而不是 DiTrust 帳號額度。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { anonReservedBlock, loadReservedHandles, nextIdentityFields, resetReservedHandlesCache, resolveActor } from "./actor.ts";
import { resolveIdentity } from "./contribute-handler.ts";
import { resolveIdentity as resolveIdentityJp } from "./jp/contribute-handler.ts";

const HASH = "abcdef0123456789abcdef";
const SECRET = "d".repeat(64);
const dittoActor = { level: "ditrust" as const, actor_id: "ditrust:11111111-2222-3333-4444-555555555555", handle: "涼糕" };

function fakeDb(rows: Array<{ display_name: string | null }> | "throw" | "error", counter = { n: 0 }) {
  return {
    from: (_t: string) => ({
      select: (_c: string) => ({
        limit: (_n: number) => {
          counter.n++;
          if (rows === "throw") throw new Error("boom");
          return Promise.resolve(rows === "error" ? { data: null, error: { message: "x" } } : { data: rows, error: null });
        },
      }),
    }),
  };
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try { return { out: await fn(), logs }; } finally { console.warn = orig; }
}

Deno.test("匿名用 DiTrust 顯示名 → 400 ditrust_name_reserved（不分大小寫與前後空白）", async () => {
  resetReservedHandlesCache();
  for (const name of ["涼糕", "QiLiang", "qiliang", "啟良", "小雯", " 涼糕 "]) {
    const r = await anonReservedBlock(null, resolveActor(name, HASH), "tw/next", HASH);
    assertEquals(r?.status, 400, name);
    assertEquals(r?.code, "ditrust_name_reserved", name);
    assert(r!.message.includes("ditrust:<你的序號>"), "訊息要白話講怎麼登入");
  }
});

Deno.test("DiTrust 登入的涼糕、匿名用其他名字都不擋", async () => {
  resetReservedHandlesCache();
  assertEquals(await anonReservedBlock(null, dittoActor, "tw/next", HASH), null);
  assertEquals(await anonReservedBlock(null, resolveActor("death0312", HASH), "tw/next", HASH), null);
  assertEquals(await anonReservedBlock(null, resolveActor("涼糕2", HASH), "tw/next", HASH), null);
});

Deno.test("名單來源：vm_ditrust_groups.display_name 併進保留名單；快取 60 秒；讀失敗退回常數且不擋合法請求", async () => {
  resetReservedHandlesCache();
  const c = { n: 0 };
  const db = fakeDb([{ display_name: "新帳號名" }, { display_name: null }], c);
  const t0 = 1_000_000;
  const a = await loadReservedHandles(db, t0);
  assert(a.has("新帳號名") && a.has("涼糕"));
  await loadReservedHandles(db, t0 + 59_000);
  assertEquals(c.n, 1, "60 秒內不重讀");
  await loadReservedHandles(db, t0 + 61_000);
  assertEquals(c.n, 2, "過期重讀");

  for (const bad of ["throw", "error"] as const) {
    resetReservedHandlesCache();
    const names = await loadReservedHandles(fakeDb(bad), t0);
    assert(names.has("涼糕") && names.has("小雯") && !names.has("新帳號名"), "退回常數清單");
  }
  resetReservedHandlesCache();
  assertEquals(await anonReservedBlock(fakeDb("throw"), resolveActor("normal-agent", HASH), "tw/next", HASH), null, "讀失敗不擋其他名字");
});

Deno.test("擋下時輸出 anon_uses_ditrust_handle，只含 route／agent_name／網段前 8 碼／時間，不含序號", async () => {
  resetReservedHandlesCache();
  const { logs } = await captureWarn(() => anonReservedBlock(null, resolveActor("涼糕", HASH), "tw/report", HASH));
  assertEquals(logs.length, 1);
  const ev = JSON.parse(logs[0]);
  assertEquals(ev.event, "anon_uses_ditrust_handle");
  assertEquals(ev.route, "tw/report");
  assertEquals(ev.agent_name, "涼糕");
  assertEquals(ev.net, HASH.slice(0, 8));
  assertEquals(Object.keys(ev).sort(), ["agent_name", "at", "event", "net", "route"]);
  assert(!logs[0].includes(HASH), "不記完整雜湊");
});

Deno.test("resolveIdentity（交件／驗證／撤回共用）：匿名涼糕 → code ditrust_name_reserved；一般名字通過", async () => {
  resetReservedHandlesCache();
  for (const fn of [resolveIdentity, resolveIdentityJp]) {
    const bad = await fn({ agent_name: "涼糕" }, HASH, fakeDb([]), "tw/report");
    assert(!bad.ok);
    assertEquals(bad.status, 400);
    assertEquals((bad as { code?: string }).code, "ditrust_name_reserved");
    const ok = await fn({ agent_name: "someone" }, HASH, fakeDb([]), "tw/report");
    assert(ok.ok);
  }
});

Deno.test("回應不外洩：DiTrust 登入的 /next 回應頂層沒有 agent_name、序號與顯示名只在 agent 物件；匿名維持原樣", () => {
  const f = nextIdentityFields(dittoActor, "涼糕");
  assert(!("agent_name" in f), "頂層不放顯示名");
  const agent = f.agent as { handle: string; display_name: string; level: string };
  assertEquals(agent.display_name, "涼糕");
  assertEquals(agent.level, "ditrust");
  assert(String(f.agent_name_rule).includes("ditrust:"));
  const text = JSON.stringify(f);
  assert(!text.includes(SECRET) && !text.includes("11111111-2222"), "回應沒有序號也沒有 agent_id");
  assertEquals(text.split("涼糕").length - 1, 2, "顯示名只出現在 agent 物件（handle、display_name）");

  const anon = nextIdentityFields(resolveActor("death0312", HASH), "death0312");
  assertEquals(anon.agent_name, "death0312");
  assertEquals("agent_name_rule" in anon, false);
});

Deno.test("守門：/next 與 jp-next 的回應身份欄位走 nextIdentityFields，且都呼叫 anonReservedBlock", async () => {
  for (const p of ["../next/index.ts", "../jp-next/index.ts"]) {
    const src = await Deno.readTextFile(new URL(p, import.meta.url));
    assert(src.includes("...nextIdentityFields(actor, agentName)"), `${p} 回應要用 nextIdentityFields`);
    assert(src.includes("anonReservedBlock("), `${p} 要擋匿名冒用`);
    assert(!/const base = \{ success: true, agent_name: agentName/.test(src), `${p} base 不可再直接放 agent_name: agentName`);
  }
});
