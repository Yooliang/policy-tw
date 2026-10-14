import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { claimVerifyCandidate, VERIFY_CLAIM_TRIES } from "./verify-claim.ts";

/**
 * 驗證派工的原子認領（2026-10-14，同網段並行撞單）：
 *   A. claimVerifyCandidate：認領不到換下一筆、最多 VERIFY_CLAIM_TRIES 筆、rpc 錯誤或回傳不是布林值時退回舊的 upsert
 *   B. SQL verify_dispatch_claim（正見與 policy_jp 兩支）：沒列＝成功、15 分鐘內同網段＝失敗不動列、超過 15 分鐘＝成功蓋新時間、別的網段不受影響
 *   C. next／jp-next 都改走認領，不再直接 upsert verify_dispatches
 */

type Call = { fn: string; args: Record<string, unknown> };
function fakeClient(answers: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Call[] = [];
  const upserts: Record<string, unknown>[] = [];
  return {
    calls, upserts,
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(answers[String(args.p_contribution_id)] ?? { data: true, error: null });
    },
    from: (_t: string) => ({ upsert: (row: Record<string, unknown>) => { upserts.push(row); return Promise.resolve({ error: null }); } }),
  };
}
const who = { ipHash: "net-1", agentName: "xiaohui" };
const cands = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));

Deno.test("A1 第一筆認領得到就派第一筆，不多打 rpc", async () => {
  const db = fakeClient({});
  const r = await claimVerifyCandidate(db, cands, who);
  assertEquals(r.pick?.id, "a");
  assertEquals(r.taken, []);
  assertEquals(db.calls.length, 1);
  assertEquals(db.calls[0], { fn: "verify_dispatch_claim", args: { p_contribution_id: "a", p_ip_hash: "net-1", p_agent_name: "xiaohui" } });
  assertEquals(db.upserts.length, 0);
});

Deno.test("A2 前兩筆已被同網段認領走 → 派第三筆", async () => {
  const db = fakeClient({ a: { data: false, error: null }, b: { data: false, error: null } });
  const r = await claimVerifyCandidate(db, cands, who);
  assertEquals(r.pick?.id, "c");
  assertEquals(r.taken, ["a", "b"]);
});

Deno.test("A3 前 VERIFY_CLAIM_TRIES 筆全被認領走 → 不派（null），第 6 筆以後不試", async () => {
  const all = Object.fromEntries(cands.map((c) => [c.id, { data: false, error: null }]));
  const db = fakeClient(all);
  const r = await claimVerifyCandidate(db, cands, who);
  assertEquals(r.pick, null);
  assertEquals(db.calls.length, VERIFY_CLAIM_TRIES);
});

Deno.test("A4 函式還沒上線（rpc 錯誤）→ 照舊 upsert、派第一筆", async () => {
  const db = fakeClient({ a: { data: null, error: { message: "PGRST202" } } });
  const r = await claimVerifyCandidate(db, cands, who);
  assertEquals(r.pick?.id, "a");
  assertEquals(db.upserts.length, 1);
  assertEquals(db.upserts[0].contribution_id, "a");
  assertEquals(db.upserts[0].ip_hash, "net-1");
});

Deno.test("A5 回傳不是布林值（測試替身回 []）→ 照舊 upsert、派第一筆", async () => {
  const db = fakeClient({ a: { data: [], error: null } });
  const r = await claimVerifyCandidate(db, cands, who);
  assertEquals(r.pick?.id, "a");
  assertEquals(db.upserts.length, 1);
});

Deno.test("A6 沒有候選 → null、不打 rpc", async () => {
  const db = fakeClient({});
  assertEquals((await claimVerifyCandidate(db, [], who)).pick, null);
  assertEquals(db.calls.length, 0);
});

// ── B. SQL ───────────────────────────────────────────────────────────────────

const mig = (name: string) => Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url));
const stripGrants = (sql: string) => sql.split("\n").filter((l) => !/^\s*(REVOKE|GRANT)\b/.test(l)).join("\n");

for (const schema of ["public", "policy_jp"] as const) {
  Deno.test(`B ${schema}.verify_dispatch_claim：沒列成功、15 分鐘內同網段失敗、過期成功、別的網段不受影響`, async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA IF NOT EXISTS policy_jp;
        CREATE TABLE ${schema}.verify_dispatches (contribution_id UUID NOT NULL, ip_hash TEXT NOT NULL, agent_name TEXT, dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (contribution_id, ip_hash));`);
      const file = schema === "public" ? "20261011370000_verify_dispatch_claim.sql" : "20261011370100_policy_jp_verify_dispatch_claim.sql";
      await db.exec(stripGrants(await mig(file)));
      const fn = schema === "public" ? "verify_dispatch_claim" : "policy_jp.verify_dispatch_claim";
      const C1 = "11111111-1111-4111-8111-111111111111";
      const claim = async (ip: string, agent: string) =>
        (await db.query<{ ok: boolean }>(`SELECT ${fn}($1, $2, $3) AS ok`, [C1, ip, agent])).rows[0].ok;
      const row = async (ip: string) =>
        (await db.query<{ agent_name: string; age: number }>(`SELECT agent_name, extract(epoch FROM now() - dispatched_at)::int AS age FROM ${schema}.verify_dispatches WHERE contribution_id = $1 AND ip_hash = $2`, [C1, ip])).rows[0];

      assertEquals(await claim("net-1", "win-a"), true, "沒有列 → 認領成功");
      assertEquals(await claim("net-1", "win-b"), false, "同網段 15 分鐘內 → 認領失敗");
      assertEquals((await row("net-1")).agent_name, "win-a", "失敗的認領不動原本那一列");
      assertEquals(await claim("net-2", "other"), true, "別的網段照樣認領得到（一個網段一票）");

      await db.query(`UPDATE ${schema}.verify_dispatches SET dispatched_at = now() - interval '16 minutes' WHERE ip_hash = 'net-1'`);
      assertEquals(await claim("net-1", "win-b"), true, "超過 15 分鐘 → 可以重派");
      const r = await row("net-1");
      assertEquals(r.agent_name, "win-b");
      assert(r.age < 5, "重派要蓋新的派出時間（派工綁定看它）");
    } finally {
      await db.close();
    }
  });
}

Deno.test("B 兩支 migration 的窗口跟驗證池同一個數字（15 分鐘）", async () => {
  for (const f of ["20261011370000_verify_dispatch_claim.sql", "20261011370100_policy_jp_verify_dispatch_claim.sql"]) {
    assert((await mig(f)).includes("dispatched_at <= now() - interval '15 minutes'"), f);
  }
  assert((await mig("20261011160000_verify_pool_voted_agent_front_no_change.sql")).includes("vd.dispatched_at > now() - interval '15 minutes'"));
});

Deno.test("B 日本版本體＝正見版只換 schema 與 search_path（正見改了這支要決定日本跟不跟）", async () => {
  const body = (sql: string, name: string) => {
    const a = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    assert(a >= 0, name);
    return sql.slice(a, sql.indexOf("$$;", a) + 3);
  };
  const tw = body(await mig("20261011370000_verify_dispatch_claim.sql"), "verify_dispatch_claim");
  const jp = body(await mig("20261011370100_policy_jp_verify_dispatch_claim.sql"), "policy_jp.verify_dispatch_claim");
  const jpAsTw = jp
    .replace("FUNCTION policy_jp.verify_dispatch_claim(", "FUNCTION verify_dispatch_claim(")
    .replace("LANGUAGE sql VOLATILE SET search_path = policy_jp, pg_temp AS", () => "LANGUAGE sql VOLATILE AS")
    .replace("INSERT INTO policy_jp.verify_dispatches AS vd", "INSERT INTO verify_dispatches AS vd");
  assertEquals(jpAsTw, tw);
});

// ── C. 入口 ──────────────────────────────────────────────────────────────────

for (const entry of ["next", "jp-next"]) {
  Deno.test(`C ${entry} 派驗證走 claimVerifyCandidate，不再自己 upsert verify_dispatches`, async () => {
    const src = await Deno.readTextFile(new URL(`../${entry}/index.ts`, import.meta.url));
    assert(src.includes("claimVerifyCandidate(supabase, candidates, { ipHash, agentName })"));
    assert(!src.includes('from("verify_dispatches")'), "verify_dispatches 只經 _shared/verify-claim.ts 寫");
  });
}
