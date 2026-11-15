/**
 * contribution_queue_tasks 必須帶 SET enable_seqscan = off（migration 20261115070000_queue_tasks_enable_seqscan_off.sql）。
 *
 * 為什麼要守：PostgreSQL 的 CREATE OR REPLACE FUNCTION 會把函式的設定（proconfig）換成新語句寫的，沒寫 SET 就被清空。
 * 所以之後有人重建這支函式，GUC 會無聲掉掉，/next 又會在非常數參數下翻成 Seq Scan、逾時（2026-11-15 事故）。
 *
 * 規則：最後一次 CREATE OR REPLACE 之後（同檔就在它後面，或函式定義本身）必須有對應的 SET enable_seqscan = off，
 *   且 ALTER 的簽名要與 CREATE 的參數型別順序一致。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const MIG_DIR = new URL("../../migrations/", import.meta.url);
const FN = "contribution_queue_tasks";
const SEQSCAN_MIG = "20261115070000_queue_tasks_enable_seqscan_off.sql";

type Mig = { name: string; text: string };

async function loadMigs(): Promise<Mig[]> {
  const out: Mig[] = [];
  for await (const e of Deno.readDir(MIG_DIR)) {
    if (e.isFile && e.name.endsWith(".sql")) {
      out.push({ name: e.name, text: await Deno.readTextFile(new URL(e.name, MIG_DIR)) });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** 去掉 -- 行註解，避免註解裡的字樣被當成語句 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** 參數型別（依序、小寫、INTEGER 與 int 視為同一種） */
function normTypes(list: string): string[] {
  return list.split(",").map((s) => s.trim()).filter(Boolean).map((s) =>
    s.toLowerCase().replace(/\s+default\s+[\s\S]*$/, "").split(/\s+/).slice(-1)[0].replace(/^int$|^int4$/, "integer")
  );
}

const CREATE_RE = new RegExp(
  `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${FN}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS[\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
  "gi",
);
const ALTER_RE = new RegExp(
  `ALTER\\s+FUNCTION\\s+(?:public\\.)?${FN}\\s*\\(([^)]*)\\)\\s+SET\\s+enable_seqscan\\s*(?:=|TO)\\s*'?off'?\\s*;`,
  "gi",
);

type Hit = { mig: string; pos: number; types: string[]; inlineSet: boolean };

function creates(migs: Mig[]): Hit[] {
  const hits: Hit[] = [];
  for (const m of migs) {
    const sql = stripComments(m.text);
    for (const x of sql.matchAll(CREATE_RE)) {
      // SET 子句夾在 RETURNS 與 $$ 之間或 $$ 之後（LANGUAGE ... SET ... AS $$ 的順序都可）
      const head = x[0].slice(0, x[0].indexOf("$$"));
      hits.push({ mig: m.name, pos: x.index ?? 0, types: normTypes(x[1]), inlineSet: /\bSET\s+enable_seqscan\s*(=|TO)\s*'?off'?/i.test(head) });
    }
  }
  return hits;
}

function alters(migs: Mig[]): Hit[] {
  const hits: Hit[] = [];
  for (const m of migs) {
    const sql = stripComments(m.text);
    for (const x of sql.matchAll(ALTER_RE)) {
      hits.push({ mig: m.name, pos: x.index ?? 0, types: normTypes(x[1]), inlineSet: false });
    }
  }
  return hits;
}

const before = (a: Hit, b: Hit) => a.mig < b.mig || (a.mig === b.mig && a.pos < b.pos);

Deno.test("止血 migration 存在，內容是對正確簽名的 ALTER FUNCTION ... SET enable_seqscan = off", async () => {
  const migs = await loadMigs();
  const mig = migs.find((m) => m.name === SEQSCAN_MIG);
  assert(mig, `${SEQSCAN_MIG} 不存在`);
  const sql = stripComments(mig.text);
  assert(/SET\s+enable_seqscan\s*=\s*off/i.test(sql), "要有 SET enable_seqscan = off");
  assert(!/RESET\s+enable_seqscan/i.test(sql), "回滾語句只能寫在註解裡");
  const a = alters([mig]);
  assertEquals(a.length, 1);
  assertEquals(a[0].types, ["text", "text", "integer", "text", "text", "text"]);
});

Deno.test("最後一次 CREATE OR REPLACE contribution_queue_tasks 之後，必須有對應的 SET enable_seqscan = off", async () => {
  const migs = await loadMigs();
  const cs = creates(migs);
  assert(cs.length > 0, "抓不到任何 CREATE OR REPLACE contribution_queue_tasks，正則要跟著改");
  const last = cs[cs.length - 1];
  const covered = last.inlineSet ||
    alters(migs).some((a) => before(last, a) && a.types.join(",") === last.types.join(","));
  assert(
    covered,
    `${last.mig} 重建了 ${FN}，但沒有保留 SET enable_seqscan = off（CREATE OR REPLACE 會清掉函式設定）。` +
      `請在函式定義加 SET enable_seqscan = off，或在其後新增 ALTER FUNCTION ${FN}(...) SET enable_seqscan = off。`,
  );
});

Deno.test("最後一版 CREATE 的簽名與止血 ALTER 的簽名一致（參數型別順序）", async () => {
  const migs = await loadMigs();
  const cs = creates(migs);
  const last = cs[cs.length - 1];
  const a = alters(migs.filter((m) => m.name === SEQSCAN_MIG))[0];
  assertEquals(a.types, last.types);
});
