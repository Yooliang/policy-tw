/**
 * 選舉新識別（election_key）與選舉欄位的守門測試（migration 20261005003441；#344 第一階段，2026-10-05）。
 *
 * 這裡沒有資料庫。SQL 本身在 PGlite（WASM Postgres）上照線上骨架與 10-05 唯讀資料實跑驗過（見 PR 說明）；
 * 這支守住「改壞了不會報錯」或「兩份清單走鐘」的幾件事：
 *   1. 第一階段只加不刪：沒有 DROP TABLE／DROP COLUMN／RENAME／改型別；DROP … IF EXISTS 只能拿來重建同一支裡建的東西
 *   2. 職位白名單（CHECK）跟 TS 的 ELECTION_TYPES 同一份；職位排序跟 cec-sync 的 OUR_ELECTION_TYPES 同一個順序
 *   3. election_key_for 產生得出的每一種「種類」，格式 CHECK 都收；既有三筆的鍵符合格式
 *   4. 鍵建立後不改的守門還在（網址會用到）
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { ELECTION_TYPES } from "./contribution-schema.ts";
import { OUR_ELECTION_TYPES } from "./cec-sync.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const FILE = "20261005003441_election_identity.sql";
const sql = await Deno.readTextFile(new URL(FILE, MIGRATIONS));

/** 去掉 SQL 註解，免得說明文字裡的字眼被當成敘述 */
const code = sql.replace(/--[^\n]*/g, "");

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  assert(j >= 0, `找不到「${end}」`);
  return text.slice(i, j);
}

function sqlArray(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

Deno.test("只加不刪：沒有刪表、刪欄、改名、改型別", () => {
  assert(!/\bDROP\s+TABLE\b/i.test(code), "不可以 DROP TABLE");
  assert(!/\bDROP\s+COLUMN\b/i.test(code), "不可以 DROP COLUMN");
  assert(!/\bRENAME\b/i.test(code), "不可以 RENAME");
  assert(!/\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i.test(code), "不可以改欄位型別");
  assert(!/\bDROP\s+FUNCTION\b/i.test(code), "不可以 DROP FUNCTION（改簽名要分兩次上）");
});

Deno.test("DROP … IF EXISTS 只用來重建同一支 migration 裡建的東西", () => {
  const drops = [...code.matchAll(/DROP\s+(CONSTRAINT|TRIGGER)\s+IF\s+EXISTS\s+(\w+)/gi)];
  assert(drops.length > 0);
  for (const [, kind, name] of drops) {
    const created = kind.toUpperCase() === "CONSTRAINT"
      ? new RegExp(`ADD\\s+CONSTRAINT\\s+${name}\\b`, "i")
      : new RegExp(`CREATE\\s+TRIGGER\\s+${name}\\b`, "i");
    assert(created.test(code), `${kind} ${name} 被 DROP 之後沒有在同一支重建`);
  }
});

Deno.test("職位白名單跟 contribution-schema.ts 的 ELECTION_TYPES 同一份", () => {
  const check = between(code, "elections_election_types_check\n  CHECK", ";");
  assertEquals(new Set(sqlArray(check)), new Set(ELECTION_TYPES));
  assertEquals(sqlArray(check).length, ELECTION_TYPES.length);
});

Deno.test("職位排序跟 cec-sync 的 OUR_ELECTION_TYPES 同一個順序（總統 → 村里長）", () => {
  const fn = between(code, "CREATE OR REPLACE FUNCTION election_types_sorted", "$$;");
  assertEquals(sqlArray(between(fn, "ARRAY[", "]")), [...OUR_ELECTION_TYPES]);
});

Deno.test("election_key_for 產生得出的每一種種類，格式 CHECK 都收", () => {
  const fn = between(code, "CREATE OR REPLACE FUNCTION election_key_for", "$$;");
  const kinds = [...fn.matchAll(/THEN '([a-z]+)'/g), ...fn.matchAll(/ELSE '([a-z]+)'/g)].map((m) => m[1]);
  assertEquals(new Set(kinds), new Set(["by", "recall", "rerun", "national", "local"]));
  const formatSrc = between(code, "elections_election_key_format\n  CHECK (election_key ~ '", "')").split("~ '")[1];
  const format = new RegExp(formatSrc);
  for (const k of kinds) {
    assertMatch(`2027-03-06_${k}`, format, `種類 ${k} 被格式擋掉`);
    assertMatch(`2027-03-06_${k}_66000`, format, `種類 ${k} 加地區代碼被格式擋掉`);
  }
  for (const bad of ["2022", "2022年九合一", "2022-11-26", "2022-11-26_九合一", "2022-11-26_local_台中市"]) {
    assert(!format.test(bad), `格式應該擋 ${bad}`);
  }
});

Deno.test("事由清單跟 election_key_for 認得的事由同一份", () => {
  const check = between(code, "elections_election_reason_check\n  CHECK", ";");
  const reasons = sqlArray(check);
  const fn = between(code, "CREATE OR REPLACE FUNCTION election_key_for", "$$;");
  const handled = [...fn.matchAll(/WHEN '([a-z_]+)' THEN/g)].map((m) => m[1]);
  assertEquals(new Set([...handled, "regular"]), new Set(reasons));
});

Deno.test("既有三筆回填的鍵：年份網址第二階段要對得回去，三筆都要在、都符合格式", () => {
  const expected = code.match(/IS DISTINCT FROM '([^']+)'/)![1];
  assertEquals(expected, "2022=2022-11-26_local,2024=2024-01-13_national,2026=2026-11-28_local");
  const formatSrc = between(code, "elections_election_key_format\n  CHECK (election_key ~ '", "')").split("~ '")[1];
  for (const pair of expected.split(",")) {
    const [year, key] = pair.split("=");
    assertMatch(key, new RegExp(formatSrc));
    assert(key.startsWith(year), `${key} 的投票日不在 ${year} 年`);
  }
});

Deno.test("election_key 建立後不改：守門觸發器在、更新也會經過", () => {
  const fn = between(code, "CREATE OR REPLACE FUNCTION elections_key_guard", "$$;");
  assertMatch(fn, /NEW\.election_key IS DISTINCT FROM OLD\.election_key/);
  assertMatch(fn, /RAISE EXCEPTION/);
  assertMatch(code, /CREATE TRIGGER trg_elections_key_guard\s+BEFORE INSERT OR UPDATE ON elections/);
  // 舊寫入端（findOrCreateElection）不給鍵：新增時要自動補，不然 NOT NULL 會把那支擋掉
  assertMatch(fn, /NEW\.election_key := election_key_for\(/);
});
