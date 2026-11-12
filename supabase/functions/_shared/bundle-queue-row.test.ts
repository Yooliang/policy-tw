/**
 * 一人一包 PR1（migration 20261112010000_policy_bundles.sql；docs/PLAN-bundle-policies.md 第 3 節）。
 *   A. 文字層：新的 contribution_queue_row ＝ 前一版只把「插驗證票」換成「早退＋呼叫 verify_ticket_enqueue」
 *   B. PGlite：沒包的列照舊建票（回歸）；包裡 index>0 不建票；index 0 建票；釋放後 verify_ticket_enqueue 能建票；
 *      bundle_pick_carrier 把票交給還在包裡、pending、序號最小的條目
 *   C. 還原驗證：拿掉早退，「index>0 不建票」要翻紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261112010000_policy_bundles.sql";
const MIG = await readMig(MIG_NAME);

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 contribution_queue_row：前一版只換掉插票那一段，其餘一字不改", async () => {
  const prev = await latestFn("contribution_queue_row", MIG_NAME);
  const neu = fnText(MIG, "contribution_queue_row");
  const insert = `    INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
    VALUES ('verify:' || NEW.id, now(), now(), 0)
    ON CONFLICT (task_id) DO NOTHING;
`;
  assertEquals(prev.split(insert).length - 1, 1, "前一版的插票段變了：要以最新定義為底重做");
  const swapped = `    -- 一人一包：還在包裡、不是 0 號的條目沒有自己的票，票在載體（0 號）上
    IF NEW.bundle_id IS NOT NULL AND NEW.bundle_index > 0 AND NEW.bundle_released_at IS NULL THEN
      RETURN NEW;
    END IF;
    PERFORM verify_ticket_enqueue(NEW.id);
`;
  assertEquals(neu, prev.replace(insert, () => swapped));
});

Deno.test("A2 新函式只給 service_role：REVOKE 與 RLS 都在，沒有 id::text 比對", () => {
  assert(MIG.includes("REVOKE ALL ON FUNCTION verify_ticket_enqueue(UUID) FROM PUBLIC, anon, authenticated;"));
  assert(MIG.includes("REVOKE ALL ON FUNCTION bundle_pick_carrier(UUID) FROM PUBLIC, anon, authenticated;"));
  for (const t of ["policy_bundles", "bundle_votes"]) assert(MIG.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
  assert(!/\bid::text\s*=/.test(MIG));
});

// ============================================================
// B. PGlite
// ============================================================
const SCHEMA = `
CREATE TABLE task_dispatches (task_id text PRIMARY KEY, last_dispatched_at timestamptz NOT NULL DEFAULT now(), queue_at timestamptz NOT NULL DEFAULT now(), dispatch_count integer NOT NULL DEFAULT 1);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  bundle_id uuid, bundle_index smallint, bundle_released_at timestamptz);
`;
const TRIGGER = "CREATE TRIGGER trg_contribution_queue_row AFTER INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION contribution_queue_row();";

/** withNew=false：改前（前一版觸發器，沒有包欄位也不管它）；mutateFn 給還原驗證改壞 queue_row */
async function env(withNew: boolean, mutateRow: (s: string) => string = (s) => s): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (withNew) {
    await db.exec(fnText(MIG, "verify_ticket_enqueue"));
    await db.exec(mutateRow(fnText(MIG, "contribution_queue_row")));
    await db.exec(fnText(MIG, "bundle_pick_carrier"));
  } else {
    await db.exec(await latestFn("contribution_queue_row", MIG_NAME));
  }
  await db.exec(TRIGGER);
  return db;
}

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const BUNDLE = "11111111-1111-4111-8111-111111111111";

async function add(db: PGlite, o: { bundle?: boolean; index?: number; status?: string; released?: boolean; ageSec?: number } = {}): Promise<string> {
  const id = uid();
  const b = o.bundle ? `'${BUNDLE}', ${o.index ?? 0}` : "NULL, NULL";
  await db.exec(`INSERT INTO contributions (id, status, created_at, bundle_id, bundle_index, bundle_released_at)
    VALUES ('${id}', '${o.status ?? "pending"}', now() - interval '${o.ageSec ?? 0} seconds', ${b}, ${o.released ? "now()" : "NULL"})`);
  return id;
}
const hasTicket = async (db: PGlite, id: string): Promise<boolean> =>
  (await db.query(`SELECT 1 FROM task_dispatches WHERE task_id = 'verify:${id}'`)).rows.length === 1;
const tickets = async (db: PGlite): Promise<number> => (await db.query(`SELECT 1 FROM task_dispatches`)).rows.length;

Deno.test("B1 回歸：沒有包的 pending 列照舊建票，非 pending 不建；新舊觸發器結果相同", async () => {
  for (const withNew of [false, true]) {
    const db = await env(withNew);
    const a = await add(db);
    const b = await add(db, { status: "rejected" });
    assert(await hasTicket(db, a), `withNew=${withNew}：pending 要有票`);
    assert(!(await hasTicket(db, b)), `withNew=${withNew}：非 pending 不建票`);
    assertEquals(await tickets(db), 1);
    const row = (await db.query<{ c: string; d: number }>(`SELECT dispatch_count AS d, (queue_at <= now())::text AS c FROM task_dispatches`)).rows[0]!;
    assertEquals(row.d, 0);
    await db.close();
  }
});

Deno.test("B2 包裡 index>0 不建票；index 0 建票；一包只有載體一張票", async () => {
  const db = await env(true);
  const c0 = await add(db, { bundle: true, index: 0 });
  const c1 = await add(db, { bundle: true, index: 1 });
  const c2 = await add(db, { bundle: true, index: 2 });
  assert(await hasTicket(db, c0));
  assert(!(await hasTicket(db, c1)));
  assert(!(await hasTicket(db, c2)));
  assertEquals(await tickets(db), 1);
  await db.close();
});

Deno.test("B3 已釋放（bundle_released_at 有值）的 index>0 照舊建票；verify_ticket_enqueue 對包裡的條目能補票且冪等", async () => {
  const db = await env(true);
  const rel = await add(db, { bundle: true, index: 3, released: true });
  assert(await hasTicket(db, rel), "插入時就已釋放：走個別票");
  const c1 = await add(db, { bundle: true, index: 1 });
  assert(!(await hasTicket(db, c1)));
  await db.exec(`UPDATE contributions SET bundle_released_at = now() WHERE id = '${c1}'`);
  await db.exec(`SELECT verify_ticket_enqueue('${c1}')`);
  assert(await hasTicket(db, c1));
  await db.exec(`SELECT verify_ticket_enqueue('${c1}')`);
  assertEquals(await tickets(db), 2, "重複呼叫不多建");
  await db.close();
});

Deno.test("B4 bundle_pick_carrier：票交給還在包裡、pending、序號最小的；跳過已釋放與非 pending；沒有可接的回 NULL", async () => {
  const db = await env(true);
  const c0 = await add(db, { bundle: true, index: 0 });
  const c1 = await add(db, { bundle: true, index: 1, status: "rejected" });
  const c2 = await add(db, { bundle: true, index: 2, released: true });
  const c3 = await add(db, { bundle: true, index: 3 });
  const c4 = await add(db, { bundle: true, index: 4 });
  // 載體 c0 定案（被退）：票由 index 最小的「還在包裡且 pending」＝c3 接手
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id = '${c0}'`);
  const pick = (await db.query<{ p: string | null }>(`SELECT bundle_pick_carrier('${BUNDLE}') AS p`)).rows[0]!.p;
  assertEquals(pick, c3);
  assert(await hasTicket(db, c3));
  assert(!(await hasTicket(db, c4)), "只有一張新票");
  assert(!(await hasTicket(db, c1)) && await hasTicket(db, c2) === true, "c1 非 pending 無票；c2 釋放時就有自己的票");
  // 再呼叫一次：還是 c3、不多建
  const before = await tickets(db);
  assertEquals((await db.query<{ p: string }>(`SELECT bundle_pick_carrier('${BUNDLE}') AS p`)).rows[0]!.p, c3);
  assertEquals(await tickets(db), before);
  // 包裡沒有可接的
  await db.exec(`UPDATE contributions SET status = 'rejected' WHERE id IN ('${c3}', '${c4}')`);
  assertEquals((await db.query<{ p: string | null }>(`SELECT bundle_pick_carrier('${BUNDLE}') AS p`)).rows[0]!.p, null);
  assertEquals((await db.query<{ p: string | null }>(`SELECT bundle_pick_carrier('99999999-9999-4999-8999-999999999999') AS p`)).rows[0]!.p, null);
  await db.close();
});

// ============================================================
// C. 還原驗證
// ============================================================
Deno.test("C1 拿掉早退，index>0 就會建票（B2 的劇本要翻面）", async () => {
  const db = await env(true, (s) => mutate(s, "IF NEW.bundle_id IS NOT NULL AND NEW.bundle_index > 0 AND NEW.bundle_released_at IS NULL THEN", "IF false THEN"));
  await add(db, { bundle: true, index: 0 });
  const c1 = await add(db, { bundle: true, index: 1 });
  assert(await hasTicket(db, c1), "拿掉早退後 index 1 有票，代表 B2 守得住");
  await db.close();
});
