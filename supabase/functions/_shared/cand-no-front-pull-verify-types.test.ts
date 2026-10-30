/**
 * 號次驗證票插隊要涵蓋所有號次相關的驗證型別（2026-10-30，migration 20261030150000）。
 * 背景：cand_no_front_pull() 把驗證列的條件寫死 candidacy＋cand_no，#784 新增的 cand_numbers 漏了，237 張整批驗證票 boost_seconds=0。
 * 守門兩半：
 *   A. 文字層：最新 contributions_contribution_type_check 清單裡名字帶 cand_no/cand_num 的型別，每一個都要出現在 cand_no_front_pull 最新定義裡（新增型別沒涵蓋就紅）
 *   B. 行為層（PGlite）：cand_numbers 驗證列的倍數＝同單位缺口任務（縣市長／議員 3 ×、當前提前職位 2.5 ×、其餘 2 ×）；單人 candidacy 驗證列不變
 * 還原驗證：把 migration 的 cand_numbers 條件拿掉，A 與 B 都必須紅（見 PR 說明）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function names(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) out.push(e.name);
  return out.sort();
}

async function latestFnText(): Promise<string> {
  let fn = "";
  for (const n of await names()) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    const at = t.lastIndexOf("CREATE OR REPLACE FUNCTION cand_no_front_pull(");
    if (at >= 0) {
      const body = t.slice(at);
      fn = body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
    }
  }
  assert(fn !== "", "找不到 cand_no_front_pull 定義");
  return fn;
}

async function latestTypeList(): Promise<string[]> {
  let list: string[] = [];
  for (const n of await names()) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    for (const m of t.matchAll(/ADD CONSTRAINT contributions_contribution_type_check\s+CHECK \(contribution_type IN \(([^)]*)\)\)/g)) {
      list = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
  }
  assert(list.length > 10, "找不到貢獻型別 CHECK 清單");
  return list;
}

Deno.test("A. 名字帶 cand_no/cand_num 的貢獻型別都被 cand_no_front_pull 涵蓋", async () => {
  const fn = await latestFnText();
  const types = (await latestTypeList()).filter((t) => /cand_n(o|um)/.test(t));
  assert(types.includes("cand_numbers"), "清單裡應有 cand_numbers");
  for (const t of types) assert(fn.includes(`'${t}'`), `cand_no_front_pull 沒涵蓋貢獻型別 ${t}：驗證列不會插隊`);
  // 單人 candidacy 帶 cand_no 的條件仍在
  assert(fn.includes("c.contribution_type = 'candidacy' AND c.payload ? 'cand_no'"));
});

const Y = 100;

async function run(rows: Array<{ id: number; type: string; payload: Record<string, unknown> }>, gaps: string[]): Promise<Record<string, number>> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, ${Y});
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, boost_seconds bigint NOT NULL DEFAULT 0, cooling boolean NOT NULL DEFAULT true);
    CREATE TABLE contributions (id integer PRIMARY KEY, status text, contribution_type text, payload jsonb);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT date '2026-10-30' $$;
    ${await latestFnText()}`);
  for (const et of gaps) {
    await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, $2::jsonb)`, [`gap-${et}`, JSON.stringify({ kind: "cand_no", election_type: et })]);
  }
  for (const r of rows) {
    await db.query(`INSERT INTO contributions VALUES ($1, 'pending', $2, $3::jsonb)`, [r.id, r.type, JSON.stringify(r.payload)]);
    await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, '{"kind":"verify"}'::jsonb)`, [`verify:${r.id}`]);
  }
  await db.exec("SELECT cand_no_front_pull()");
  const out = (await db.query<{ task_id: string; boost_seconds: number }>(`SELECT task_id, boost_seconds::int AS boost_seconds FROM task_dispatches`)).rows;
  return Object.fromEntries(out.map((x) => [x.task_id, x.boost_seconds]));
}

Deno.test("B. cand_numbers 驗證列倍數比照缺口任務；單人 candidacy 不變", async () => {
  const b = await run(
    [
      { id: 1, type: "cand_numbers", payload: { election_type: "縣市長", items: [] } },
      { id: 2, type: "cand_numbers", payload: { election_type: "縣市議員", items: [] } },
      { id: 3, type: "cand_numbers", payload: { election_type: "鄉鎮市長", items: [] } },
      { id: 4, type: "cand_numbers", payload: { election_type: "村里長", items: [] } },
      { id: 5, type: "candidacy", payload: { election_type: "鄉鎮市長", cand_no: 3 } },
      { id: 6, type: "candidacy", payload: { election_type: "縣市長", cand_no: 3 } },
      { id: 7, type: "candidacy", payload: { election_type: "縣市長" } },
      { id: 8, type: "policy", payload: { election_type: "縣市長", cand_no: 1 } },
    ],
    ["縣市長", "鄉鎮市長", "村里長"],
  );
  assertEquals(b["verify:1"], 3 * Y);
  assertEquals(b["verify:2"], 3 * Y);
  assertEquals(b["verify:3"], 2.5 * Y); // 當前提前職位＝鄉鎮市長（清單第一個有缺口列）
  assertEquals(b["verify:4"], 2 * Y);
  assertEquals(b["verify:5"], 2 * Y); // 單人 candidacy 維持原規則（不吃 2.5 ×）
  assertEquals(b["verify:6"], 3 * Y);
  assertEquals(b["verify:7"], 0); // 沒帶 cand_no 的 candidacy 不插隊
  assertEquals(b["verify:8"], 0);
  assertEquals(b["gap-鄉鎮市長"], 2.5 * Y);
});
