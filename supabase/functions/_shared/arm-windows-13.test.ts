/**
 * 當屆類 13 支臂補上起訖（migration 20261011010000；工作單 Yooliang/policy-ops#81）——提案版，維護者點頭才合。
 *   - 9 支改成照里程碑開關（rule_id 不變、原地 UPDATE）；4 支（交接缺漏、政見傳承三支）維持永遠開並寫明理由
 *   - 名單清查兩支起點是登記截止（照登記彙總表核對），不是名單公告日
 *   - 中選會名單對不上、當選人缺紀錄不設迄日（在派的是 2022／2024 還沒補齊的人）
 *   - 自我檢查：漏改一支整支停下
 *   還原驗證：把名單清查的起點換成名單公告日、或少一支 UPDATE，就紅
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261011010000_arm_windows_13.sql");

const SEED: Array<[number, string]> = [
  [3, "raw:policy_missing"], [31, "mayor_policies"], [14, "raw:roster_check"], [1, "roster_villages"], [28, "district_seats"],
  [19, "raw:candidacy_source_missing"], [27, "withdrawn_filing"], [21, "roster_cec_gap"], [30, "elected_missing"],
  [22, "handover_missing"], [6, "lineage_candidates"], [25, "lineage_links"], [26, "lineage_roles"],
  [5, "raw:progress_stale"], [24, "deadline_due"],
];

async function db(sql = SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`CREATE TABLE activity_rules (id bigint PRIMARY KEY, activity text, window_kind text, from_kind text, from_offset int DEFAULT 0,
    until_kind text, until_offset int DEFAULT 0, note text);`);
  for (const [id, act] of SEED) {
    await d.query(`INSERT INTO activity_rules (id, activity, window_kind, note) VALUES ($1, $2, 'always', 'P1 種子：永遠開')`, [id, act]);
  }
  await d.exec(sql);
  return d;
}

type Row = { activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; until_offset: number };
async function rules(d: PGlite): Promise<Record<string, string>> {
  const { rows } = await d.query<Row>(`SELECT activity, window_kind, from_kind, from_offset, until_kind, until_offset FROM activity_rules`);
  return Object.fromEntries(rows.map((r) => [r.activity,
    r.window_kind === "always" ? "always" : `${r.from_kind ?? "-"}+${r.from_offset}..${r.until_kind ?? "-"}+${r.until_offset}`]));
}

Deno.test("11 支照里程碑開關、4 支維持永遠開（村里長有流量才開的兩條不在這支，照舊）", async () => {
  const d = await db();
  assertEquals(await rules(d), {
    "raw:policy_missing": "-+0..polling+0",
    "mayor_policies": "-+0..polling+0",
    "raw:roster_check": "registration_close+0..polling+0",
    "roster_villages": "registration_close+0..polling+0",
    "district_seats": "-+0..polling+0",
    "raw:candidacy_source_missing": "-+0..polling+0",
    "withdrawn_filing": "registration_close+0..list_published+0",
    "roster_cec_gap": "polling+1..-+0",
    "elected_missing": "polling+1..-+0",
    "handover_missing": "always",
    "lineage_candidates": "always",
    "lineage_links": "always",
    "lineage_roles": "always",
    "raw:progress_stale": "term_start+0..term_end+0",
    "deadline_due": "term_start+0..term_end+0",
  });
  await d.close();
});

Deno.test("還原驗證：名單清查起點換成名單公告日，結果就不同", async () => {
  const broken = SQL.replace(
    "from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,\n       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表",
    "from_kind = 'list_published', from_offset = 0, until_kind = 'polling', until_offset = 0,\n       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表",
  );
  assert(broken !== SQL);
  const d = await db(broken);
  assertEquals((await rules(d))["raw:roster_check"], "list_published+0..polling+0");
  await d.close();
});

Deno.test("自我檢查：少改一支整支停下", async () => {
  const broken = SQL.replace(/UPDATE activity_rules SET window_kind = 'event'[^;]*WHERE id = 30 AND activity = 'elected_missing';/, "");
  assert(broken !== SQL);
  await assertRejects(() => db(broken));
});

Deno.test("只動這 13 支規則：不建表、不改函式、不刪資料", () => {
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert(!/CREATE|DROP|DELETE|INSERT|ALTER/.test(code.replace(/RAISE EXCEPTION[^;]*;/g, "")));
  const ids = [...code.matchAll(/WHERE id (?:= (\d+)|IN \(([\d, ]+)\))/g)].flatMap((m) => (m[1] ?? m[2]).split(",").map((s) => Number(s.trim())));
  assertEquals([...new Set(ids)].sort((a, b) => a - b), SEED.map(([id]) => id).sort((a, b) => a - b));
});
