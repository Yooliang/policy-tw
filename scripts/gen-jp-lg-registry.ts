/**
 * 總務省「全国地方公共団体コード」（R6.1.1）＋「中核市一覧」（R5.4.1）→ policy_jp.lg_code_registry 的資料 migration。
 *
 *   deno run -A scripts/gen-jp-lg-registry.ts [--out supabase/migrations/20261009210300_policy_jp_lg_registry_data.sql]
 *
 * 這張表只拿來「機器核對」代理交的 local_government（照正見 cec-verify：對得上直接落庫），不顯示在網站上；
 * 網站的自治體名單（local_governments）仍然只從通過的交件來（維護者 10-09 裁定）。
 *
 * 解析規則（跟 policy-jp scripts/fetch/lg-codes.mjs 同一套）：
 *   - 第 1 張表「現在の団体」：都道府県（第 3〜5 碼 000）＋市町村＋東京 23 区；名稱＝市区町村名，沒有就是都道府県名
 *   - 第 2 張表「政令指定都市」：名稱以「市」結尾＝政令市（第 1 張表也有），其餘＝行政区（只在這張表）
 *   - kind：prefecture／designated_city／admin_ward／special_ward（131xxx）／village（村）／town（町）／core_city（中核市一覧）／city
 *   - 讀音：半角カナ → ひらがな（_shared/jp/kana.ts）
 * 中核市一覧是 PDF（令和5年4月1日現在，之後總務省沒更新）：下面 CORE_CITY_ROWS 是那份 PDF 的「都道府県名・都市名」兩欄照順序抄的
 * （含後來改成政令市或合併掉的），程式會確認每個市名都在 PDF 的文字裡、對得到第 1 張表的團體，扣掉現在的政令市後剛好 62 市（PDF 的累計）。
 * 之後新指定的中核市不在這份一覧：機器核對遇到「市／中核市」不一致時不判，留給同儕（lg_registry_decide）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as XLSX from "npm:xlsx@0.18.5";
import { hiraganaOf } from "../supabase/functions/_shared/jp/kana.ts";
import { lgCodeValid, lgPrefCode } from "../supabase/functions/_shared/jp/lg-code.ts";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i], Deno.args[i + 1]);
const OUT = args.get("--out") ?? "supabase/migrations/20261009210300_policy_jp_lg_registry_data.sql";

const CODE_PAGE = "https://www.soumu.go.jp/denshijiti/code.html";
const CODE_XLSX = "https://www.soumu.go.jp/main_content/000925835.xlsx";
const CODE_AS_OF = "2024-01-01"; // 「都道府県コード及び市区町村コード」（令和6年1月1日更新）
const CORE_PDF = "https://www.soumu.go.jp/main_content/000885088.pdf";
const CORE_AS_OF = "2023-04-01"; // 中核市一覧（令和５年４月１日現在）
const UA = "Mozilla/5.0 (compatible; PolicyTracker/1.0; +https://policy-jp.web.app)";

/** 中核市一覧 PDF 的兩欄（都道府県名、都市名），照 PDF 的順序；同名兩次（富山、静岡：合併後再指定）照抄 */
const CORE_CITY_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["栃木", "宇都宮"], ["新潟", "新潟"], ["富山", "富山"], ["石川", "金沢"], ["岐阜", "岐阜"], ["静岡", "静岡"], ["静岡", "浜松"],
  ["大阪", "堺"], ["兵庫", "姫路"], ["岡山", "岡山"], ["熊本", "熊本"], ["鹿児島", "鹿児島"], ["秋田", "秋田"], ["福島", "郡山"],
  ["和歌山", "和歌山"], ["長崎", "長崎"], ["大分", "大分"], ["愛知", "豊田"], ["広島", "福山"], ["高知", "高知"], ["宮崎", "宮崎"],
  ["福島", "いわき"], ["長野", "長野"], ["愛知", "豊橋"], ["香川", "高松"], ["北海道", "旭川"], ["愛媛", "松山"], ["神奈川", "横須賀"],
  ["奈良", "奈良"], ["岡山", "倉敷"], ["埼玉", "川越"], ["千葉", "船橋"], ["神奈川", "相模原"], ["静岡", "静岡"], ["愛知", "岡崎"],
  ["大阪", "高槻"], ["大阪", "東大阪"], ["富山", "富山"], ["北海道", "函館"], ["山口", "下関"], ["青森", "青森"],
  ["岩手", "盛岡"], ["千葉", "柏"], ["兵庫", "西宮"], ["福岡", "久留米"], ["群馬", "前橋"], ["滋賀", "大津"], ["兵庫", "尼崎"],
  ["群馬", "高崎"], ["大阪", "豊中"], ["沖縄", "那覇"], ["大阪", "枚方"], ["東京", "八王子"], ["埼玉", "越谷"], ["広島", "呉"],
  ["長崎", "佐世保"], ["青森", "八戸"], ["福島", "福島"], ["埼玉", "川口"], ["大阪", "八尾"], ["兵庫", "明石"], ["鳥取", "鳥取"],
  ["島根", "松江"], ["山形", "山形"], ["福井", "福井"], ["山梨", "甲府"], ["大阪", "寝屋川"], ["茨城", "水戸"], ["大阪", "吹田"],
  ["長野", "松本"], ["愛知", "一宮"],
];
const CORE_TOTAL = 62; // PDF 右下的累計（令和5年4月1日現在）

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function sha256(buf: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 代碼表 ───────────────────────────────────────────────────────────────
// 頁面上第一個 Excel 連結就是「都道府県コード及び市区町村コード」：確認沒換檔（換了就要改 CODE_XLSX、CODE_AS_OF 重產）
const page = new TextDecoder("shift_jis").decode(await fetchBytes(CODE_PAGE));
const firstXlsx = page.match(/href="(\/main_content\/\d+\.xlsx)"/)?.[1];
assertEquals(`https://www.soumu.go.jp${firstXlsx}`, CODE_XLSX, "代碼表的 Excel 換檔了：更新 CODE_XLSX／CODE_AS_OF 後重產");

const xlsxBuf = await fetchBytes(CODE_XLSX);
const wb = XLSX.read(xlsxBuf, { type: "array" });
assertEquals(wb.SheetNames.length >= 2, true, `代碼表少於 2 張工作表：${wb.SheetNames.join(", ")}`);
assert(wb.SheetNames[0].startsWith("R6.1.1") && wb.SheetNames[1].startsWith("R6.1.1"), `工作表名稱不是 R6.1.1：${wb.SheetNames.join(", ")}`);
const sheetRows = (i: number): string[][] =>
  (XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: false, defval: "" }) as unknown[][])
    .map((r) => r.map((c) => String(c ?? "").trim()));
const code6 = (s: string) => (/^\d{5,6}$/.test(s) ? s.padStart(6, "0") : "");

type Row = { lg_code: string; pref_code: string; pref_name: string; name: string; kana: string; kana_raw: string; kind: string; core: boolean };

// 第 2 張表：政令市與行政区
const designated = new Set<string>();
const wards: Array<{ code: string; pref: string; name: string; prefKana: string; kanaRaw: string }> = [];
for (const r of sheetRows(1).slice(1)) {
  const code = code6(r[0]);
  if (!code) continue;
  if (/市$/.test(r[2])) designated.add(code);
  else wards.push({ code, pref: r[1], name: r[2], prefKana: r[3], kanaRaw: r[4] });
}

const rows: Row[] = [];
for (const r of sheetRows(0).slice(1)) {
  const code = code6(r[0]);
  if (!code) continue;
  const isPref = code.slice(2, 5) === "000";
  const name = isPref ? r[1] : r[2];
  const kanaRaw = isPref ? r[3] : r[4];
  assert(name && kanaRaw, `${code}：名稱或讀音空白`);
  const kind = isPref ? "prefecture"
    : designated.has(code) ? "designated_city"
    : code.startsWith("131") ? "special_ward"
    : /村$/.test(name) ? "village"
    : /町$/.test(name) ? "town"
    : "city";
  rows.push({ lg_code: code, pref_code: lgPrefCode(code)!, pref_name: r[1], name, kana: hiraganaOf(kanaRaw), kana_raw: kanaRaw, kind, core: false });
}
for (const w of wards) {
  rows.push({ lg_code: w.code, pref_code: lgPrefCode(w.code)!, pref_name: w.pref, name: w.name, kana: hiraganaOf(w.kanaRaw), kana_raw: w.kanaRaw, kind: "admin_ward", core: false });
}

// ── 中核市一覧 ───────────────────────────────────────────────────────────
const pdfBuf = await fetchBytes(CORE_PDF);
const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1?no-dts") as unknown as {
  extractText: (doc: unknown, o: { mergePages: boolean }) => Promise<{ text: string }>;
  getDocumentProxy: (buf: Uint8Array) => Promise<unknown>;
};
const pdfText = (await extractText(await getDocumentProxy(pdfBuf.slice()), { mergePages: true })).text.replace(/[\s　]/g, "");
assert(pdfText.includes("令和５年４月１日現在") || pdfText.includes("令和5年4月1日現在"), "中核市一覧的基準日不是令和5年4月1日");
const byCode = new Map(rows.map((r) => [r.lg_code, r]));
const coreCodes = new Set<string>();
for (const [pref, city] of CORE_CITY_ROWS) {
  assert(pdfText.includes(city), `中核市一覧 PDF 裡找不到「${city}」`);
  const hits = rows.filter((r) => r.pref_name.startsWith(pref) && r.name === `${city}市` && r.kind !== "admin_ward");
  assertEquals(hits.length, 1, `「${pref} ${city}市」對到 ${hits.length} 個團體`);
  if (hits[0].kind === "designated_city") continue; // 後來改成政令市（新潟・静岡・浜松・堺・岡山・熊本・相模原）
  coreCodes.add(hits[0].lg_code);
}
assertEquals(coreCodes.size, CORE_TOTAL, `中核市 ${coreCodes.size} 市，PDF 的累計是 ${CORE_TOTAL}`);
for (const c of coreCodes) {
  const r = byCode.get(c)!;
  assertEquals(r.kind, "city", `${c} ${r.name} 不是一般市（${r.kind}）`);
  r.kind = "core_city";
  r.core = true;
}

// ── 檢查 ─────────────────────────────────────────────────────────────────
for (const r of rows) {
  assert(lgCodeValid(r.lg_code), `${r.lg_code} 檢查碼不對`);
  assert(/^[ぁ-ゖー]+$/.test(r.kana), `${r.lg_code} ${r.name} 讀音轉不成ひらがな：${r.kana_raw} → ${r.kana}`);
  assert(!r.name.includes("'") && !r.kana_raw.includes("'"), `${r.lg_code} 名稱有單引號`);
}
assertEquals(new Set(rows.map((r) => r.lg_code)).size, rows.length, "團體碼重複");
const tally: Record<string, number> = {};
for (const r of rows) tally[r.kind] = (tally[r.kind] ?? 0) + 1;
assertEquals(tally.prefecture, 47);
assertEquals(tally.designated_city, 20);
assertEquals(tally.special_ward, 23);
assertEquals(tally.core_city, CORE_TOTAL);
rows.sort((a, b) => (a.lg_code < b.lg_code ? -1 : 1));

// ── 輸出 ─────────────────────────────────────────────────────────────────
const q = (s: string) => `'${s}'`;
const values = rows.map((r) => `    (${q(r.lg_code)}, ${q(r.pref_code)}, ${q(r.pref_name)}, ${q(r.name)}, ${q(r.kana)}, ${q(r.kana_raw)}, ${q(r.kind)})`).join(",\n");
const kinds = Object.entries(tally).sort().map(([k, n]) => `${k} ${n}`).join("、");
const sql = `-- 總務省「全国地方公共団体コード」（R6.1.1）＋「中核市一覧」（R5.4.1）→ policy_jp.lg_code_registry（機器核對 local_government 用，不顯示）
-- ============================================================
-- 由 scripts/gen-jp-lg-registry.ts 產生，不要手改；代碼表換檔時改腳本的 CODE_XLSX／CODE_AS_OF 重產一支新的 migration。
-- 前提：20261009210200_policy_jp_lg_registry.sql（lg_code_registry 表）。
--
-- 出處：${CODE_XLSX}（頁面 ${CODE_PAGE}；SHA-256 ${await sha256(xlsxBuf)}）
--       ${CORE_PDF}（中核市一覧，令和5年4月1日現在；SHA-256 ${await sha256(pdfBuf)}）
-- 共 ${rows.length} 列：${kinds}。
-- 中核市：PDF 的 ${CORE_CITY_ROWS.length} 列扣掉同名重複與後來改成政令市的，剩 ${CORE_TOTAL} 市（＝PDF 的累計）。

INSERT INTO policy_jp.sources (url, title, publisher, source_kind, origin)
VALUES (${q(CODE_XLSX)}, '都道府県コード及び市区町村コード（令和6年1月1日更新）', '総務省', 'official', 'import:soumu_lg_code'),
       (${q(CORE_PDF)}, '中核市一覧（令和５年４月１日現在）', '総務省', 'official', 'import:soumu_chukaku')
ON CONFLICT (url) DO NOTHING;

INSERT INTO policy_jp.lg_code_registry (lg_code, pref_code, pref_name, name, kana, kana_raw, kind, as_of, source_id, kind_as_of, kind_source_id)
SELECT v.lg_code, v.pref_code, v.pref_name, v.name, v.kana, v.kana_raw, v.kind, DATE ${q(CODE_AS_OF)}, s.id,
       CASE WHEN v.kind = 'core_city' THEN DATE ${q(CORE_AS_OF)} END, CASE WHEN v.kind = 'core_city' THEN c.id END
  FROM (VALUES
${values}
  ) AS v(lg_code, pref_code, pref_name, name, kana, kana_raw, kind)
  JOIN policy_jp.sources s ON s.url = ${q(CODE_XLSX)}
  JOIN policy_jp.sources c ON c.url = ${q(CORE_PDF)}
ON CONFLICT (lg_code) DO NOTHING;

-- 自我檢查：筆數與種類分布跟產生時一樣（少灌、多灌都讓這支 migration 失敗）
DO $$
DECLARE got TEXT;
BEGIN
  SELECT string_agg(kind || ' ' || n, '、' ORDER BY kind) INTO got
    FROM (SELECT kind, count(*) AS n FROM policy_jp.lg_code_registry WHERE as_of = DATE ${q(CODE_AS_OF)} GROUP BY kind) t;
  IF got IS DISTINCT FROM ${q(kinds)} THEN
    RAISE EXCEPTION 'lg_code_registry 的分布不對：%（預期 ${kinds}）', got;
  END IF;
END
$$;
`;
await Deno.writeTextFile(OUT, sql);
console.error(`寫入 ${OUT}：${rows.length} 列（${kinds}）`);
