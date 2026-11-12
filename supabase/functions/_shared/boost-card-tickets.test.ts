/**
 * 工作卡②：插隊帶動同卡驗證票（migration 20261112060000_boost_card_tickets.sql，2026-11-12）。
 *   A. 文字層：新 task_boost＝前一版（20261019050000）只多「>>> 同卡驗證票」區塊、回傳多 card_tickets、queue_at 排除帶動的票；不碰 seed／priority_seconds
 *   B. PGlite：插隊任務後同卡驗證票的 queue_at 一起前移、差值＝boost；不同卡的票不動；沒有 work_key 的票不動
 *   C. card_tickets=false 只插任務；matched_verifies 維持 filter 命中數；已被 filter 命中的票不重複加
 *   D. 還原驗證：拿掉帶票區塊 B 翻面；拿掉 NOT EXISTS 去重 C 翻面
 *   E. filter 白名單：card_tickets 只收布林、false 才寫進條件、單獨一個 card_tickets 不算生效條件
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { validateBoostFilter } from "./boost-filter.ts";

const MIG_NAME = "20261112060000_boost_card_tickets.sql";
const MIG = await readMig(MIG_NAME);
const NEW = fnText(MIG, "task_boost");
const PREV = await latestFn("task_boost", MIG_NAME);
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => code(s).split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");

const BLOCK_RE = /  -- >>> 同卡驗證票[\s\S]*?-- <<< 同卡驗證票\n/;

Deno.test("A1 task_boost：拿掉帶票區塊與三處回傳調整後，等於前一版（去註解）", () => {
  assert(BLOCK_RE.test(NEW), "新定義要有 >>> 同卡驗證票 區塊");
  let back = NEW.replace(BLOCK_RE, "");
  back = back.replace(" v_cards INTEGER := 0;", "");
  back = back.replace(" AND h.kind <> 'card_verify'", "");
  back = back.replace(", 'card_tickets', v_cards", "");
  assertEquals(norm(back), norm(PREV));
});

Deno.test("A2 task_boost 最新定義：沒有 seed、不碰 priority_seconds", async () => {
  const latest = code(await latestFn("task_boost"));
  assert(!/seed_auto_task_queue/.test(latest));
  assert(!/priority_seconds/.test(latest));
});

const SCHEMA = `
CREATE TABLE task_boosts (id BIGSERIAL PRIMARY KEY, label TEXT, filter JSONB, agent_name TEXT, ip_hash TEXT, matched_tasks INTEGER, matched_verifies INTEGER);
CREATE TABLE contribution_tasks (id uuid PRIMARY KEY, last_dispatched_at timestamptz);
CREATE TABLE queue_settings (id INT PRIMARY KEY, boost_seconds BIGINT);
INSERT INTO queue_settings VALUES (1, 1000);
CREATE TABLE task_dispatches (task_id TEXT PRIMARY KEY, work_key TEXT, boost_seconds BIGINT NOT NULL DEFAULT 0, cooling BOOLEAN NOT NULL DEFAULT false, queue_at TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01');
-- 排序鍵觸發器（簡化版：queue_at＝基準 − boost 秒；真正的 verify_ticket_key 由 verify-ticket-key.test.ts 守）
CREATE FUNCTION _qk() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.queue_at := '2026-01-01'::timestamptz - make_interval(secs => NEW.boost_seconds); RETURN NEW; END $f$;
CREATE TRIGGER _qk BEFORE INSERT OR UPDATE ON task_dispatches FOR EACH ROW EXECUTE FUNCTION _qk();
-- filter 命中：任務 auto:a；filter.also_verify 時另命中 verify:v1（同卡的票，檢查去重）
CREATE FUNCTION task_boost_matches(p_filter JSONB) RETURNS TABLE(task_id TEXT, kind TEXT) LANGUAGE sql AS $f$
  SELECT 'auto:a', 'task' UNION ALL SELECT 'verify:v1', 'verify' WHERE p_filter ? 'also_verify' $f$;
CREATE FUNCTION refresh_verify_ticket_keys() RETURNS INTEGER LANGUAGE sql AS $f$ SELECT 0 $f$;
INSERT INTO task_dispatches (task_id, work_key) VALUES
  ('auto:a', 'politician:p1:policies:2026'), ('verify:v1', 'politician:p1:policies:2026'), ('verify:v2', 'politician:p1:policies:2026'),
  ('auto:b', 'politician:p2:policies:2026'), ('verify:v3', 'politician:p2:policies:2026'), ('verify:v4', NULL);
`;
type R = { id: number; matched_tasks: number; matched_verifies: number; card_tickets: number; queue_at: string };
async function run(def: string, filter: Record<string, unknown>) {
  const db = new PGlite();
  try {
    await db.exec(SCHEMA);
    await db.exec(def);
    const before = (await db.query<{ task_id: string; q: number }>(`SELECT task_id, extract(epoch FROM queue_at)::float8 AS q FROM task_dispatches`)).rows;
    const r = (await db.query<{ r: R }>(`SELECT task_boost('t', $1::jsonb, 'x', 'ip') AS r`, [JSON.stringify(filter)])).rows[0]!.r;
    const rows = (await db.query<{ task_id: string; boost_seconds: string; q: number }>(`SELECT task_id, boost_seconds::text, extract(epoch FROM queue_at)::float8 AS q FROM task_dispatches ORDER BY 1`)).rows;
    const shift = Object.fromEntries(rows.map((x) => [x.task_id, before.find((b) => b.task_id === x.task_id)!.q - x.q]));
    const boosts = Object.fromEntries(rows.map((x) => [x.task_id, x.boost_seconds]));
    const rec = (await db.query<{ matched_verifies: number }>(`SELECT matched_verifies FROM task_boosts`)).rows[0]!;
    return { r, shift, boosts, rec };
  } finally {
    await db.close();
  }
}

Deno.test("B 插隊任務：同卡驗證票一起前移且差值＝boost；不同卡、沒有 work_key 的不動", async () => {
  const { r, shift, boosts } = await run(NEW, { task_ids: ["auto:a"] });
  assertEquals([r.matched_tasks, r.matched_verifies, r.card_tickets], [1, 0, 2]);
  assertEquals(shift["auto:a"], 1000);
  assertEquals(shift["verify:v1"], 1000);
  assertEquals(shift["verify:v2"], 1000);
  assertEquals([shift["auto:b"], shift["verify:v3"], shift["verify:v4"]], [0, 0, 0]);
  assertEquals([boosts["verify:v3"], boosts["verify:v4"]], ["0", "0"]);
  assertEquals(new Date(r.queue_at).getTime(), Date.parse("2026-01-01T00:00:00Z") - 1000 * 1000, "queue_at 是 filter 命中列的鍵（任務），票不影響");
});

Deno.test("C1 card_tickets=false 只插任務", async () => {
  const { r, shift } = await run(NEW, { task_ids: ["auto:a"], card_tickets: false });
  assertEquals(r.card_tickets, 0);
  assertEquals([shift["auto:a"], shift["verify:v1"], shift["verify:v2"]], [1000, 0, 0]);
});

Deno.test("C2 已被 filter 命中的票不重複加（一份）；matched_verifies 維持 filter 命中數", async () => {
  const { r, shift, rec } = await run(NEW, { also_verify: true });
  assertEquals([r.matched_tasks, r.matched_verifies, r.card_tickets], [1, 1, 1]);
  assertEquals([shift["verify:v1"], shift["verify:v2"]], [1000, 1000]);
  assertEquals(rec.matched_verifies, 1);
});

Deno.test("D 還原驗證：拿掉帶票區塊 B 翻面；拿掉去重 C2 的張數翻面", async () => {
  const noBlock = NEW.replace(BLOCK_RE, "");
  const a = await run(noBlock, { task_ids: ["auto:a"] });
  assertEquals(a.shift["verify:v2"], 0, "沒有帶票區塊票就不動（B 會紅）");
  const noDedup = mutate(NEW, "         AND NOT EXISTS (SELECT 1 FROM _boost_hits x WHERE x.task_id = v.task_id);", ";");
  const b = await run(noDedup, { also_verify: true });
  assertEquals(b.r.card_tickets, 2, "沒有去重 v1 被多算一張（C2 的 card_tickets=1 會紅；UPDATE FROM 對同一列只套一次，所以秒數不會雙倍）");
});

Deno.test("E filter 白名單：card_tickets 只收布林；false 才進條件；單獨一個不算生效條件", () => {
  assertEquals(validateBoostFilter({ task_ids: ["auto:a"], card_tickets: false }), { ok: true, filter: { task_ids: ["auto:a"], card_tickets: false } });
  assertEquals(validateBoostFilter({ task_ids: ["auto:a"], card_tickets: true }), { ok: true, filter: { task_ids: ["auto:a"] } });
  assertEquals(validateBoostFilter({ task_ids: ["auto:a"], card_tickets: "no" }).ok, false);
  assertEquals(validateBoostFilter({ card_tickets: false }).ok, false);
  assertEquals(validateBoostFilter({ card_tickets: true }).ok, false);
});
