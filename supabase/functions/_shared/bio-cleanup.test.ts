/**
 * 人物簡介切掉「查證過程」句子（20261120190000，#975）。
 *
 * 代理把查證過程寫進了 politicians.bio（「我用 pdftotext 核過…」「查詢結果回 0 筆，故留空」），人物頁直接顯示。
 * migration 逐句判斷、整句刪（括號裡的查證標記只拿掉那一段括號），每筆寫 edit_history，可整批還原。守六件事：
 *   1. #975 那段真實壞例子只剩描述句；
 *   2. 好簡介一個字不改；
 *   3. 全是查證句 → NULL（不是空字串）；
 *   4. edit_history 一筆一列；
 *   5. bio_cleanup_revert() 還原、第二次不動、之後被別人改過的不動；
 *   6. 可重跑（第二次 0 筆）；
 * 另外：scripts/bio-cleanup-preview.sql（唯讀預覽，邏輯 inline）跟 migration 的函式結果必須一致。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { mutate, readMig } from "./arms-pglite.ts";

const MIG = "20261120190000_bio_cleanup_process_sentences.sql";
const AGENT = "maintainer:bio-cleanup";
const PREVIEW = (await Deno.readTextFile(new URL("../../../scripts/bio-cleanup-preview.sql", import.meta.url))).replace(/\r\n/g, "\n");
const stripGrants = (sql: string) => sql.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");
const MIG_SQL = stripGrants(await readMig(MIG));

// #975 那筆（何國義）正式庫裡的簡介全文
const REAL_BAD =
  "新北市新店區香坡里村里長候選人，無黨籍（未經政黨推薦）。2026 年地方公職人員選舉於 115/09/03 完成候選人登記（中選會《115年村里長選舉候選人登記彙總表》第 81 頁列「新北市新店區／115/09/03／何國義／無」，我用 pdftotext -bbox-layout 核過該列的里名是「香坡里」）。中選會候選人查詢 API 查其姓名回 0 筆（2026 尚未投票、API 只收已投票的選舉），亦無往屆村里長當選紀錄；115 年選舉公報尚未發布，公開來源未載其出生年、學歷與照片，故這三項留空不填。";
const REAL_BAD_WANT = "新北市新店區香坡里村里長候選人，無黨籍（未經政黨推薦）。2026 年地方公職人員選舉於 115/09/03 完成候選人登記。";

// 好簡介：一個字不能改（含括號裡的句號、來源／出處但沒有查核附、中選會公告）
const GOOD = [
  "曾任民雄鄉第19屆鄉長、嘉義縣第16至19屆議員；曾任民雄婦女會理事長。學歷：南華大學幼保系畢業。",
  "高雄市鳳山區和興里里長候選人，無黨籍（選舉公報載：現任里長。連任二屆。）。依中選會公告，115年9月3日完成候選人登記。資料來源為內政部村里長名冊。",
  "男性，1969年生。主張：減稅、擴大托育補助！你知道嗎？這是他的第三次參選\n第二段：長期投入社區服務",
];
const ALL_PROCESS = "我用 pdftotext 核過彙總表。查詢結果回 0 筆，故留空。尚未發布，不填。";
const PARTIAL = "桃園市桃園區中德里里長候選人，無黨籍。中選會候選人查詢 API 查「某某」回 0 筆。";
const PARTIAL_WANT = "桃園市桃園區中德里里長候選人，無黨籍。";

const SCHEMA = `
CREATE TABLE politicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, bio text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
`;

async function build(migSql: string | null = null) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const add = async (name: string, bio: string | null) =>
    (await db.query<{ id: string }>(`INSERT INTO politicians (name, bio) VALUES ($1, $2) RETURNING id::text`, [name, bio])).rows[0].id;
  const ids = {
    bad: await add("何國義", REAL_BAD),
    good1: await add("好一", GOOD[0]),
    good2: await add("好二", GOOD[1]),
    good3: await add("好三", GOOD[2]),
    allProc: await add("全查證", ALL_PROCESS),
    partial: await add("部分", PARTIAL),
    nobio: await add("無簡介", null),
  };
  if (migSql) await db.exec(migSql);
  const bio = async (id: string) => (await db.query<{ bio: string | null }>(`SELECT bio FROM politicians WHERE id = $1`, [id])).rows[0].bio;
  return { db, ids, bio };
}

Deno.test("B1 #975 真實壞例子：只剩描述句（括號裡的查證標記只拿掉那段括號、句子留著）", async () => {
  const { db, ids, bio } = await build(MIG_SQL);
  assertEquals(await bio(ids.bad), REAL_BAD_WANT);
  assertEquals(await bio(ids.partial), PARTIAL_WANT);
  await db.close();
});

Deno.test("B2 好簡介一個字不改；沒有簡介的不動", async () => {
  const { db, ids, bio } = await build(MIG_SQL);
  assertEquals(await bio(ids.good1), GOOD[0]);
  assertEquals(await bio(ids.good2), GOOD[1]);
  assertEquals(await bio(ids.good3), GOOD[2]);
  assertEquals(await bio(ids.nobio), null);
  await db.close();
});

Deno.test("B3 全是查證句 → NULL（不是空字串）", async () => {
  const { db, ids, bio } = await build(MIG_SQL);
  assertEquals(await bio(ids.allProc), null);
  await db.close();
});

Deno.test("B4 edit_history 一筆一列：改了幾位就幾列，沒改的沒有；NULL 記成 JSON null", async () => {
  const { db, ids } = await build(MIG_SQL);
  const { rows } = await db.query<{ record_id: string; field: string; table_name: string; agent_name: string; contribution_id: string | null; old_value: string; new_value: string | null; nv_json: string }>(
    `SELECT record_id, field, table_name, agent_name, contribution_id::text, old_value #>> '{}' AS old_value, new_value #>> '{}' AS new_value, new_value::text AS nv_json
       FROM edit_history ORDER BY record_id`);
  assertEquals(rows.length, 3, "bad／allProc／partial 三位");
  assertEquals(new Set(rows.map((r) => r.record_id)), new Set([ids.bad, ids.allProc, ids.partial]));
  for (const r of rows) {
    assertEquals([r.table_name, r.field, r.agent_name, r.contribution_id], ["politicians", "bio", AGENT, null]);
  }
  const bad = rows.find((r) => r.record_id === ids.bad)!;
  assertEquals(bad.old_value, REAL_BAD);
  assertEquals(bad.new_value, REAL_BAD_WANT);
  const nul = rows.find((r) => r.record_id === ids.allProc)!;
  assertEquals(nul.old_value, ALL_PROCESS);
  assertEquals(nul.nv_json, "null");
  await db.close();
});

Deno.test("B5 還原：回到原文、第二次不動；之後被別人改過的不還原", async () => {
  const { db, ids, bio } = await build(MIG_SQL);
  await db.query(`UPDATE politicians SET bio = '別人後來改的' WHERE id = $1`, [ids.partial]);
  const first = (await db.query<{ n: number }>(`SELECT bio_cleanup_revert() AS n`)).rows[0].n;
  assertEquals(first, 2, "bad 與 allProc 還原；partial 現值已不等於 new_value，不動");
  assertEquals(await bio(ids.bad), REAL_BAD);
  assertEquals(await bio(ids.allProc), ALL_PROCESS);
  assertEquals(await bio(ids.partial), "別人後來改的");
  const second = (await db.query<{ n: number }>(`SELECT bio_cleanup_revert() AS n`)).rows[0].n;
  assertEquals(second, 0);
  const { rows } = await db.query<{ record_id: string; reverted_by: string | null }>(`SELECT record_id, reverted_by FROM edit_history WHERE reverted_at IS NOT NULL ORDER BY record_id`);
  assertEquals(new Set(rows.map((r) => r.record_id)), new Set([ids.bad, ids.allProc]));
  assert(rows.every((r) => r.reverted_by === "bio_cleanup_revert"));
  await db.close();
});

Deno.test("B6 可重跑：第二次 0 筆（edit_history 不再多）", async () => {
  const { db } = await build(MIG_SQL);
  const n = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM edit_history`)).rows[0].n;
  assertEquals(await n(), 3);
  await db.exec(MIG_SQL);
  assertEquals(await n(), 3);
  await db.close();
});

Deno.test("B7 切句：括號裡的標點不切；半形括號同；沒命中的原樣", async () => {
  const db = new PGlite();
  await db.exec(MIG_SQL.replace(/INSERT INTO edit_history[\s\S]*$/, "").replace(/^WITH cand AS[\s\S]*$/m, ""));
  const f = async (s: string | null) => (await db.query<{ v: string | null }>(`SELECT bio_strip_process_sentences($1) AS v`, [s])).rows[0].v;
  assertEquals(await f("甲（乙。丙）。我用 curl 查。"), "甲（乙。丙）。");
  assertEquals(await f("甲(乙。丙)。我用 curl 查。"), "甲(乙。丙)。");
  assertEquals(await f("甲（我用 curl 查。核過）。乙。"), "甲。乙。", "括號內有查證句號：整段括號拿掉、不切");
  assertEquals(await f("甲。\n我用 curl 查\n乙。"), "甲。\n乙。", "換行切句");
  assertEquals(await f("甲；本任務完成；乙！"), "甲；乙！");
  assertEquals(await f("甲。留空；"), "甲。", "結尾不留；");
  assertEquals(await f("沒有任何標記。  前後有空白  "), "沒有任何標記。  前後有空白  ", "沒命中不動（連空白都不動）");
  assertEquals(await f("依來源核對。"), null, "來源＋核 → 查證句");
  assertEquals(await f("資料來源為內政部名冊。"), "資料來源為內政部名冊。", "只有來源、沒有查核附 → 描述句");
  assertEquals(await f(""), "");
  assertEquals(await f(null), null);
  await db.close();
});

Deno.test("B8 預覽腳本（唯讀、inline）跟 migration 的函式結果逐位一致；第一行是唯讀", async () => {
  assertEquals(PREVIEW.split("\n")[0], "SET default_transaction_read_only = on;");
  const { db, ids } = await build(); // 不套 migration
  // 預覽：去掉第一行與最後的輸出段，換成逐位輸出 old/new
  const body = PREVIEW.split("\n").slice(1).join("\n");
  const head = body.slice(0, body.indexOf("-- ▼▼ 輸出"));
  const { rows: pv } = await db.query<{ id: string; new_bio: string | null }>(`${head} SELECT id::text, new_bio FROM c`);
  await db.exec(MIG_SQL);
  const { rows: mg } = await db.query<{ id: string; new_bio: string | null }>(
    `SELECT h.record_id AS id, h.new_value #>> '{}' AS new_bio FROM edit_history h`);
  const norm = (r: { id: string; new_bio: string | null }[]) => r.map((x) => `${x.id}|${x.new_bio}`).sort();
  assertEquals(norm(pv), norm(mg));
  assertEquals(pv.length, 3);
  assert(pv.some((r) => r.id === ids.bad && r.new_bio === REAL_BAD_WANT));
  await db.close();
});

Deno.test("B9 還原驗證：拿掉「只剩空字串→NULL」那行，B3 必須轉紅（全查證簡介變成空字串）", async () => {
  const MUT = mutate(MIG_SQL, "  IF v_kept ~ '^[。；！？，、]*$' THEN RETURN NULL; END IF;\n", "");
  const { db, ids, bio } = await build(MUT);
  assert((await bio(ids.allProc)) !== null, "NULL 規則拿掉後，全查證簡介應變成空字串而不是 NULL");
  await db.close();
});

Deno.test("B10 還原驗證：括號規則拿掉，B1 必須轉紅（括號裡的查證標記會害整句被刪）", async () => {
  const MUT = mutate(MIG_SQL, "SELECT regexp_replace(s, '", "SELECT s /* 停用括號規則 */ || regexp_replace('', '");
  const { db, ids, bio } = await build(MUT);
  assert((await bio(ids.bad)) !== REAL_BAD_WANT);
  await db.close();
});

Deno.test("B11 AI／代理／系統字眼：提到就整句刪；職稱「代理○長」與一般詞彙不誤砍", async () => {
  const db = new PGlite();
  await db.exec(MIG_SQL.replace(/^WITH cand AS[\s\S]*$/m, ""));
  const f = async (s: string) => (await db.query<{ v: string | null }>(`SELECT bio_strip_process_sentences($1) AS v`, [s])).rows[0].v;
  // 該刪
  assertEquals(await f("甲候選人。由 AI 代理整理。"), "甲候選人。");
  assertEquals(await f("甲候選人。本站資料由 agent 彙整。"), "甲候選人。");
  assertEquals(await f("甲候選人。內容由語言模型自動整理。"), "甲候選人。");
  assertEquals(await f("甲候選人。Claude 與 Gemini 皆查無。"), "甲候選人。");
  assertEquals(await f("甲候選人。資料經 Jev 判定。"), "甲候選人。");
  assertEquals(await f("甲候選人。本系統自動產生。"), "甲候選人。");
  assertEquals(await f("甲候選人。由代理處理。"), "甲候選人。");
  // 該留
  for (
    const keep of [
      "曾任代理鄉長。", "曾任代理市長、代理縣長與代理區長。", "委託代理人出席。",
      "資訊系統工程師，推動自動化產線。", "曾任模型工廠廠長。",
      "任職於NAPIER公司。", "擔任FAIR組織理事。",
      "曾任大林國小代理教師、民眾黨市黨部代理主委。", "曾在馬祖酒代理等家族產業歷練。", "長期投入兒童程式與AI教育推廣。", "任職於 AI 科技公司擔任業務。", "2023年1月起代理富里鄉長。",
    ]
  ) assertEquals(await f(keep), keep, keep);
  // 英文要整字：獨立的 API／AI 要刪
  assertEquals(await f("甲。查詢API查無紀錄。"), "甲。");
  assertEquals(await f("甲。使用 AI 協助。"), "甲。");
  await db.close();
});

Deno.test("B12 負向案例：任務小組／核心主張＋來源不砍；第 N 頁只拿掉子句；API 當來源只拿掉詞，帶失敗結果詞才整句刪", async () => {
  const db = new PGlite();
  await db.exec(MIG_SQL.replace(/^WITH cand AS[\s\S]*$/m, ""));
  const f = async (s: string) => (await db.query<{ v: string | null }>(`SELECT bio_strip_process_sentences($1) AS v`, [s])).rows[0].v;
  for (
    const keep of [
      "曾任特定公園任務小組召集人。", "曾任任務型國民大會代表。",
      "參選核心主張：擴大托育，財政收入來源單一化需改善。", "核心政見包含社福預算，資金來源多元。",
    ]
  ) assertEquals(await f(keep), keep, keep);
  assertEquals(await f("甲。本任務由代理領取。"), "甲。");
  assertEquals(await f("甲。這是任務單內容。"), "甲。");
  assertEquals(await f("甲。出處待查證。"), "甲。");
  // 第 N 頁：只去掉子句，保留後面的描述
  assertEquals(await f("2026年村里長登記冊第273頁，115年8月31日再次以中國國民黨登記參選同里。"), "115年8月31日再次以中國國民黨登記參選同里。");
  assertEquals(await f("依彙總表第83頁載明，他於115/09/03登記參選。"), "他於115/09/03登記參選。");
  assertEquals(await f("甲候選人，見第3頁。"), "甲候選人。");
  // API／JSON／PDF 當來源引用：沒有失敗結果詞就只去掉那個詞
  assertEquals(await f("中選會候選人查詢 API 載其2022年當選。"), "中選會候選人載其2022年當選。");
  assertEquals(await f("依 JSON 資料，他出生於1970年。"), "依 資料，他出生於1970年。");
  assertEquals(await f("甲。中選會候選人查詢 API 查無其紀錄。"), "甲。");
  assertEquals(await f("甲。中選會 API 回傳空白。"), "甲。");
  await db.close();
});
