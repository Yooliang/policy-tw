/**
 * 應選名額任務提示改版（migration 20261009090000_district_seats_official_sources.sql，#344）對正式庫的「今天輸出逐件不變」比對。
 *
 * 不進 CI（要連正式庫）；只讀：SQL 第一行 SET default_transaction_read_only = on，新定義以 CTE 原樣執行（不建立任何物件；
 * 正式庫還沒有 verification_sources.election_ids 與 seats 來源，用 CTE 替身把 migration 的來源列放進去）。
 *   ① 任務：現行 contribution_auto_tasks_district_seats()（正式庫最新定義）vs migration 裡的新本體：
 *      件數相同、task_id／task_type／target／reward／region 逐件相同（雙向 0）；
 *   ② 文字：每一件的 what_we_need＝現行的 what_we_need 套同樣的兩處機械替換（腳本與 migration 各寫一遍；第一處依這一件有沒有登錄來源分兩種）；
 *      hint_sources 每件都是新的三條，第一條依有沒有來源是「current.verification_sources」或老實說「還沒登錄」；
 *   ③ 覆蓋：每一件任務在 migration 的來源列＋ TS 的 sourcesForTask（跟 /next 同一支）裡附到幾個：
 *      2026 年與 2022 年的每一件至少一個，只有已知找不到的 2022 年台中市和平區區民代表沒有；
 *      而且臂自己的 EXISTS 判斷（提示說不說「已附」）跟 TS 的答案一致。
 *
 * 用法（在有 supabase/.temp link 的目錄）：
 *   deno run --node-modules-dir=none --allow-read --allow-write --allow-run --allow-env scripts/district-seats-parity.ts [改壞的 migration 路徑]
 * 帶第二個參數＝還原驗證：對改壞的 migration 必須是紅的（結束碼 1）。
 */
import { fnText, readMig } from "../supabase/functions/_shared/arms-pglite.ts";
import { sourcesForTask, type VerificationSource } from "../supabase/functions/_shared/verification-sources.ts";

const MIG = "20261009090000_district_seats_official_sources.sql";
const FN = "contribution_auto_tasks_district_seats";
const EXPECTED_UNCOVERED = ["auto:district_seats_missing:2022:台中市:直轄市山地原住民區民代表"];
const arg = Deno.args.filter((a) => !a.startsWith("--"))[0];
const migSql = (arg ? Deno.readTextFileSync(arg) : await readMig(MIG)).replace(/\r\n/g, "\n");

const bodyOf = (s: string) => {
  const m = /AS (\$[a-z]*\$)/.exec(s)!;
  return s.slice(s.indexOf(m[0]) + m[0].length, s.lastIndexOf(m[1])).trim();
};
const once = (s: string, from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`要改的字串必須剛好出現一次（${n} 次）：${from.slice(0, 60)}`);
  return s.replace(from, () => to);
};

async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  const f = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(f, "SET default_transaction_read_only = on;\n" + sql);
  const out = await new Deno.Command(Deno.build.os === "windows" ? "npx.cmd" : "npx", { args: ["supabase", "db", "query", "--linked", "-f", f, "-o", "json"], stdout: "piped", stderr: "piped" }).output();
  await Deno.remove(f);
  const txt = new TextDecoder().decode(out.stdout);
  if (!out.success || !txt.includes("{")) {
    console.error(new TextDecoder().decode(out.stderr).slice(0, 2000) || txt.slice(0, 2000));
    Deno.exit(2);
  }
  return JSON.parse(txt.slice(txt.indexOf("{"))).rows;
}

// ── migration 的來源列 ─────────────────────────────────────────────
function parseSources(sql: string): VerificationSource[] {
  const a = sql.indexOf("INSERT INTO verification_sources");
  const b = sql.indexOf("ON CONFLICT (name) DO NOTHING", a);
  const body = sql.slice(a, b);
  const arr = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const re = /\n  \(\n    '((?:[^']|'')*)', '([a-z]+)', NULL,\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    ARRAY\[([^\]]*)\],\n    '([^']*)', NULL, '([a-z]+)',[\s\S]*?\n    '[^']*', '(?:ok|down)', (\d+)\n  \)/g;
  const out: VerificationSource[] = [];
  let id = 0;
  for (const m of body.matchAll(re)) {
    out.push({ id: ++id, name: m[1], kind: m[2], party: null, regions: arr(m[3]), election_types: arr(m[4]), election_ids: m[5].split(",").map((x) => Number(x.trim())), provides: arr(m[6]), list_url: m[7], detail_url_pattern: null, access: m[8], quality_note: null, how_to: null, last_checked: null, status: "ok", sort: Number(m[9]) });
  }
  return out;
}
const sources = parseSources(migSql);
const lit = (xs: readonly (string | number)[], type: string) => `ARRAY[${xs.map((x) => (typeof x === "number" ? String(x) : `'${x.replaceAll("'", "''")}'`)).join(", ")}]::${type}[]`;
/** 正式庫的 verification_sources 還沒有 election_ids、也沒有 seats 來源：用 CTE 替身（只放這支 migration 的來源列，臂只讀這四欄） */
const SOURCES_CTE = `verification_sources (provides, election_types, regions, election_ids) AS (VALUES ${
  sources.map((s) => `(${lit(s.provides, "text")}, ${lit(s.election_types ?? [], "text")}, ${lit(s.regions ?? [], "text")}, ${lit(s.election_ids ?? [], "int")})`).join(",\n  ")
})`;

const newBody = bodyOf(fnText(migSql, FN));
const COLS = "task_id, task_type, target, what_we_need, hint_sources, reward, region";
type Row = { task_id: string; task_type: string; target: Record<string, unknown>; what_we_need: string; hint_sources: string[]; reward: number; region: string };
const live = (await query(`SELECT ${COLS} FROM ${FN}() ORDER BY task_id COLLATE "C"`)) as unknown as Row[];
const next = (await query(`WITH ${SOURCES_CTE}, new_fn (${COLS}) AS (${newBody}) SELECT ${COLS} FROM new_fn ORDER BY task_id COLLATE "C"`)) as unknown as Row[];

let bad = 0;
const fail = (msg: string) => { bad++; console.log("  不同：" + msg); };

// ① 任務本體
console.log(`現行 ${live.length} 件、新定義 ${next.length} 件`);
if (live.length !== next.length) fail("件數不同");
const key = (r: Row) => JSON.stringify([r.task_id, r.task_type, r.target, r.reward, r.region]);
const liveKeys = new Set(live.map(key));
const nextKeys = new Set(next.map(key));
const liveOnly = live.filter((r) => !nextKeys.has(key(r)));
const nextOnly = next.filter((r) => !liveKeys.has(key(r)));
console.log(`任務本體（task_id、task_type、target、reward、region）：舊有新沒有 ${liveOnly.length}、新有舊沒有 ${nextOnly.length}`);
for (const r of [...liveOnly, ...nextOnly].slice(0, 5)) fail(r.task_id);

// ③ 覆蓋（先算：② 要用）
const attached = (r: Row) => sourcesForTask(sources, { region: r.region, electionType: r.target.election_type as string, electionId: r.target.election_id as number, need: ["seats"] }).length;

// ② 文字：現行的 what_we_need 套兩處機械替換＝新的（第一處依有沒有來源分兩種）
const R1_FROM = "請找這一屆的選舉公告（應選名額表；已投票的屆別，選舉公報每個選舉區的開頭也寫著應選名額），";
const R1_ATTACHED = "請找這一屆的選舉公告（附各選舉區應選名額表的 PDF；網址在 current.verification_sources 與 hint_sources，先看那幾個。選舉公報不一定印應選名額，鄉鎮市民代表的公報大多沒有，別在公報裡找半天），";
const R1_NOT_ATTACHED = "請找這一屆的選舉公告（應選名額表；我們還沒登錄這一屆這個縣市的公告網址，要自己找，先看 hint_sources；已投票的屆別，選舉公報有的在每個選舉區的開頭印著應選名額），";
const R2_FROM = "原住民選舉區加 kind（indigenous_plain 或 indigenous_mountain）。名額只能照公告抄，不要用候選人數或當選人數推。";
const R2_TO = R2_FROM + "公告上這個縣市有幾個選舉區就交幾個（含原住民選舉區），不要只填 target.known_districts——那只是我們目前知道的，常比公告少；交件前把你列的名額加總，對一下公告上這個縣市的名額總額。";
const nextById = new Map(next.map((r) => [r.task_id, r]));
let textDiff = 0;
let hintBad = 0;
for (const o of live) {
  const n = nextById.get(o.task_id);
  if (!n) continue;
  const covered = attached(n) > 0;
  const expected = once(once(o.what_we_need, R1_FROM, covered ? R1_ATTACHED : R1_NOT_ATTACHED), R2_FROM, R2_TO);
  if (n.what_we_need !== expected) { textDiff++; if (textDiff <= 3) fail(`${o.task_id} 的 what_we_need 不等於「現行＋機械替換」（有來源＝${covered}）`); }
  const h = n.hint_sources;
  const first = covered ? h[0]?.startsWith("current.verification_sources") : /還沒登錄/.test(h[0] ?? "");
  if (!(h.length === 3 && first && (covered ? h.every((x) => !x.includes("eebulletin.cec.gov.tw")) : true))) { hintBad++; if (hintBad <= 3) fail(`${o.task_id} 的 hint_sources 不是預期的三條（有來源＝${covered}）`); }
}
console.log(`文字：what_we_need 不等於「現行＋機械替換」的 ${textDiff} 件；hint_sources 不是預期三條的 ${hintBad} 件`);

// ③ 覆蓋
console.log(`來源列：${sources.length} 列（migration 的 INSERT）`);
if (sources.length < 35) fail("來源列解析出來太少");
const cover = new Map<string, number>();
const uncovered: string[] = [];
for (const r of next) {
  const k = `${r.target.election_id} ${r.target.election_type}`;
  const n = attached(r);
  cover.set(k, (cover.get(k) ?? 0) + n);
  if (n === 0) uncovered.push(r.task_id);
}
for (const [k, n] of [...cover].sort()) console.log(`  ${k}：這一批合計附上 ${n} 個來源`);
uncovered.sort();
console.log(`附不到來源的任務：${uncovered.length} 件 ${JSON.stringify(uncovered)}`);
if (JSON.stringify(uncovered) !== JSON.stringify(EXPECTED_UNCOVERED)) fail(`附不到來源的任務應該恰好是 ${JSON.stringify(EXPECTED_UNCOVERED)}`);

console.log(bad === 0 ? "\n全部相同（只有 what_we_need 與 hint_sources 換字，任務逐件不變，每個任務都有來源，除了已知找不到的那一件，它的提示老實說「還沒登錄」）" : `\n有 ${bad} 處不同`);
Deno.exit(bad === 0 ? 0 : 1);
