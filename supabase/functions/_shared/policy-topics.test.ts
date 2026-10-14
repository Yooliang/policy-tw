/**
 * 政見主題標註走流程（第二期，2026-10-07；docs/PLAN-markdown-views.md 第 3.4 節）的守門測試。
 *
 * 這件事的核心跟政見三要素（#364）一樣只有一個分別：**沒有列＝未調查；有列而 topic_key 是 NULL＝查過、不屬於任何主題**。
 * 兩者一混，網站就會把「我們還沒標」講成「這條政見沒有主題」。所以這裡守的是：
 *   1. 詞彙：_shared/topics.ts 是 lib/topics.ts 一字不差的複本（Edge Function 不能 import 目錄外的檔）；
 *      DB 的 topic_key CHECK、TS 的 key 清單、字數與主題數上限三處一致
 *   2. 四處清點：DB CHECK contributions_contribution_type_check、TS 清單（CONTRIBUTION_TYPES／TASK_TYPES／SUGGESTED_TYPE）、
 *      skill.md、標籤——漏 DB CHECK 的話交件全被擋而測試全綠（09-20 踩過），所以 CHECK 這裡直接解析 SQL 比對
 *   3. 交件 schema：topics 空陣列合法（查過、沒有主題）、沒給 topics 不合法（不能把「忘了」當成「沒有」）、每個主題要有依據句
 *   4. 落庫：整組換（SQL policy_topics_apply 一個交易）、查核履歷、略過已移除／不是他的政見、全部一樣 superseded
 *   5. 派工臂：範圍、等票中的不派、接進 arms 而且沒有掉臂；migration 不寫任何一筆主題（資料走流程）
 *   6. 任務現況帶候選（系統算、只是候選）與詞彙表；驗證項講得出「不是提到字就算主題」
 * SQL 本身另外在 PGlite（WASM Postgres）上實跑過，見 PR 說明；這裡沒有資料庫，改 SQL 的人要重跑那一份。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CONTRIBUTION_TYPES, TASK_TYPES, validateContributionRequest } from "./contribution-schema.ts";
import { applyContribution } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { buildReportTemplate, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { POLICY_TOPIC_VERIFY_HINT, shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";
import { riskLevel } from "./consensus.ts";
import { SINGLE_ANSWER_TASK_TYPES } from "./single-answer-guard.ts";
import { summarizeContribution } from "./contribution-summary.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { TOPICS } from "./topics.ts";
import {
  NO_TOPIC_LABEL,
  parseApplyResult,
  POLICY_TOPIC_BATCH_MAX,
  POLICY_TOPIC_EVIDENCE_MAX,
  POLICY_TOPIC_KEYS,
  POLICY_TOPIC_MAX,
  policyTopicArrays,
  policyTopicCandidates,
  policyTopicItems,
  topicsPhrase,
  topicVocabulary,
} from "./policy-topics.ts";

type Obj = Record<string, unknown>;

const POL = "00000000-0000-4000-8000-000000000002";
const P1 = "00000000-0000-4000-8000-000000000011";
const P2 = "00000000-0000-4000-8000-000000000012";
const P3 = "00000000-0000-4000-8000-000000000013";
const SRC = "https://bulletin.cec.gov.tw/2026/some-district.pdf";

function submit(items: unknown, extra: Obj = {}, sourceUrls: string[] = [SRC]) {
  return validateContributionRequest({
    agent_name: "tester",
    contribution_type: "policy_topic",
    payload: { politician_id: POL, items, ...extra },
    source_urls: sourceUrls,
  });
}
const errorPaths = (r: ReturnType<typeof validateContributionRequest>) => r.errors.map((e) => e.path);
const topic = (key: string, evidence = "擴大公共托育服務量能") => ({ topic: key, evidence });

// ── 1. 詞彙 ──────────────────────────────────────────────────────────────────

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
async function migrationNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  return names.sort();
}
async function readMigration(name: string): Promise<string> {
  return (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
}
/** 檔名字典序＝時間序：最後一支含 needle 的 migration */
async function latestMigrationWith(needle: string): Promise<{ name: string; sql: string }> {
  for (const name of (await migrationNames()).reverse()) {
    const sql = await readMigration(name);
    if (sql.includes(needle)) return { name, sql };
  }
  throw new Error(`沒有 migration 含 ${needle}`);
}
function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert(i >= 0, `找不到「${start}」`);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}
const quotedList = (s: string): string[] => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

Deno.test("詞彙：_shared/topics.ts 是 lib/topics.ts 一字不差的複本（Edge Function 不能 import 目錄外的檔，所以抄一份、由這裡盯）", async () => {
  const lib = (await Deno.readTextFile(new URL("../../../lib/topics.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const shared = (await Deno.readTextFile(new URL("./topics.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assertEquals(shared, lib, "lib/topics.ts 改了就要把整個檔複製到 supabase/functions/_shared/topics.ts（兩份真相＝那條永遠驗不出來，所以只准一字不差）");
});

Deno.test("詞彙：16 個 ASCII key，TS 清單、DB 的 topic_key CHECK 三處是同一組", async () => {
  assertEquals(TOPICS.length, 16);
  assertEquals([...POLICY_TOPIC_KEYS], TOPICS.map((t) => t.key));
  for (const k of POLICY_TOPIC_KEYS) assert(/^[a-z]+$/.test(k), `${k} 要是小寫 ASCII（資料庫存的就是它，不改名）`);
  const { name, sql } = await latestMigrationWith("policy_topics_topic_key_check");
  const check = between(sql, "CONSTRAINT policy_topics_topic_key_check CHECK", "))");
  assertEquals(quotedList(check), [...POLICY_TOPIC_KEYS], `${name} 的 topic_key CHECK 要跟 lib/topics.ts 的 TOPICS 同一組、同順序（加主題要連 CHECK 一起改）`);
});

Deno.test("上限：依據句字數、一條政見的主題數、一件任務的政見數，SQL 跟 TS 同一個數字", async () => {
  const { sql } = await latestMigrationWith("CREATE TABLE IF NOT EXISTS policy_topics");
  assertEquals(Number(sql.match(/char_length\(evidence\) <= (\d+)/)![1]), POLICY_TOPIC_EVIDENCE_MAX);
  const fn = between(sql, "CREATE OR REPLACE FUNCTION policy_topics_apply", "COMMENT ON FUNCTION policy_topics_apply");
  assertEquals(Number(fn.match(/IF v_n > (\d+) THEN RAISE EXCEPTION/)![1]), POLICY_TOPIC_MAX);
  const arm = between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_topics", "COMMENT ON FUNCTION contribution_auto_tasks_policy_topics");
  assertEquals(Number(arm.match(/policy_ids\[1:(\d+)\]/)![1]), POLICY_TOPIC_BATCH_MAX);
  assertStringIncludes(arm, `最多給 ${POLICY_TOPIC_BATCH_MAX}`.replace("最多給 ", "先給前 "), "任務敘述裡的上限字樣要跟數字一致");
});

Deno.test("候選：用同一份詞彙的同義詞算、依相關度排序、只靠分類不算；沒有命中就是空陣列", () => {
  assertEquals(policyTopicCandidates({ title: "擴大公共托育", description: "每區設置托嬰中心", category: "社會福利" })[0], "childcare");
  assertEquals(policyTopicCandidates({ title: "設立人事評議委員會", description: "公開透明", category: "社會福利" }), [], "只靠分類不算候選");
  assertEquals(policyTopicCandidates({}), []);
  // 候選只是候選：說明裡順口提到的字也會撈到（所以任務與驗證說明都要講「不是答案」）
  const stray = policyTopicCandidates({ title: "北移高科技產業園區", description: "完善周邊托育與交通", category: "經濟發展與產業" });
  assert(stray.includes("industry") && stray.includes("childcare"), "關鍵字會撈到不相干的，這正是需要代理判斷的理由");
});

// ── 2. 交件 schema ───────────────────────────────────────────────────────────

Deno.test("交件：有主題（附依據句）與查過沒有主題（空陣列）混著交，都收", () => {
  const r = submit([
    { policy_id: P1, topics: [topic("childcare"), topic("welfare", "弱勢家庭加碼津貼")] },
    { policy_id: P2, topics: [] },
  ]);
  assertEquals(r.errors, []);
  assert(r.ok);
});

Deno.test("交件：沒給 topics 不能當成「沒有主題」——忘了填跟查過沒有是兩件事", () => {
  const r = submit([{ policy_id: P1 }]);
  assert(errorPaths(r).includes("payload.items[0].topics"), "沒給 topics 要擋");
  const nul = submit([{ policy_id: P1, topics: null }]);
  assert(errorPaths(nul).includes("payload.items[0].topics"));
  assert(!errorPaths(submit([{ policy_id: P1, topics: [] }])).includes("payload.items[0].topics"), "空陣列合法");
  const notArray = submit([{ policy_id: P1, topics: "childcare" }]);
  assert(errorPaths(notArray).includes("payload.items[0].topics"));
});

Deno.test("交件：主題要是詞彙表的 key、同一條不重複、至多 2 個、每個都要有依據句", () => {
  assert(errorPaths(submit([{ policy_id: P1, topics: [topic("少子化與育兒")] }])).includes("payload.items[0].topics[0].topic"), "要用 key 不是中文名");
  assert(errorPaths(submit([{ policy_id: P1, topics: [topic("kids")] }])).includes("payload.items[0].topics[0].topic"), "不在詞彙表");
  assert(errorPaths(submit([{ policy_id: P1, topics: [topic("childcare"), topic("childcare")] }])).includes("payload.items[0].topics[1].topic"), "同一個主題只標一次");
  const three = submit([{ policy_id: P1, topics: [topic("childcare"), topic("elderly"), topic("welfare")] }]);
  assert(errorPaths(three).includes("payload.items[0].topics"), "最多 2 個");
  const noEvidence = submit([{ policy_id: P1, topics: [{ topic: "childcare" }] }]);
  assert(errorPaths(noEvidence).includes("payload.items[0].topics[0].evidence"), "標了主題卻說不出依據就不要標");
  assert(errorPaths(submit([{ policy_id: P1, topics: [topic("childcare", "托育")] }])).includes("payload.items[0].topics[0].evidence"), "依據句至少 4 字");
  const exact = "托".repeat(POLICY_TOPIC_EVIDENCE_MAX);
  assert(submit([{ policy_id: P1, topics: [topic("childcare", exact)] }]).ok, "剛好上限要收");
  assert(errorPaths(submit([{ policy_id: P1, topics: [topic("childcare", `${exact}托`)] }])).includes("payload.items[0].topics[0].evidence"));
  // 罕用字在 UTF-16 是兩個單位：150 個字元的 .length 是 300，但 SQL char_length 是 150
  assert(submit([{ policy_id: P1, topics: [topic("childcare", "𦰡".repeat(POLICY_TOPIC_EVIDENCE_MAX))] }]).ok, "照字元算，跟 SQL 一致");
});

Deno.test("交件：items 一筆 1～30 條、政見 id 要是 uuid 且不重複、politician_id 必填、來源必填", () => {
  assert(errorPaths(submit([])).includes("payload.items"));
  const many = Array.from({ length: POLICY_TOPIC_BATCH_MAX + 1 }, (_, i) => ({ policy_id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, topics: [] }));
  assert(errorPaths(submit(many)).includes("payload.items"));
  assert(submit(many.slice(0, POLICY_TOPIC_BATCH_MAX)).ok, "剛好 30 條要收");
  assert(errorPaths(submit([{ policy_id: "abc", topics: [] }])).includes("payload.items[0].policy_id"));
  assert(errorPaths(submit([{ topics: [] }])).includes("payload.items[0].policy_id"));
  assert(errorPaths(submit([{ policy_id: P1, topics: [] }, { policy_id: P1.toUpperCase(), topics: [] }])).includes("payload.items[1].policy_id"), "同一條只交一次（不分大小寫）");
  const noPerson = validateContributionRequest({ agent_name: "tester", contribution_type: "policy_topic", payload: { items: [{ policy_id: P1, topics: [] }] }, source_urls: [SRC] });
  assert(errorPaths(noPerson).includes("payload.politician_id"));
  const noSource = validateContributionRequest({ agent_name: "tester", contribution_type: "policy_topic", payload: { politician_id: POL, items: [{ policy_id: P1, topics: [] }] }, source_urls: [] });
  assert(errorPaths(noSource).includes("source_urls"));
});

// ── 3. 落庫 ──────────────────────────────────────────────────────────────────

function row(payload: Obj, sourceUrls: string[] = [SRC]) {
  return { id: "11111111-1111-4111-8111-111111111111", contribution_type: "policy_topic" as const, payload, source_urls: sourceUrls, note: null, agent_name: "tester", contributor_url: null };
}

/**
 * policy_topics_apply 的記憶體版（SQL 在 PGlite 上實跑過，見 PR 說明）：已有的保留、不在新清單的刪、新的加；空陣列＝一列 NULL。
 * 這裡只為了測 apply-contribution.ts 拿到回傳之後怎麼寫查核履歷、怎麼分 applied／superseded。
 */
function topicsFake(seed: Record<string, Obj[]>) {
  const fake = createFakeSupabase(seed, {
    policy_topics_apply: (args) => {
      const rows = fake.db.policy_topics;
      const pid = String(args.p_policy_id);
      const keys = (args.p_keys as string[]) ?? [];
      const evidence = (args.p_evidence as string[]) ?? [];
      const out = { inserted: [] as Obj[], deleted: [] as Obj[], updated: [] as Obj[] };
      for (const r of rows.filter((x) => x.policy_id === pid)) {
        const keep = keys.length === 0 ? r.topic_key === null : keys.includes(String(r.topic_key));
        if (keep) continue;
        out.deleted.push({ ...r });
        rows.splice(rows.indexOf(r), 1);
      }
      if (keys.length === 0) {
        if (!rows.some((x) => x.policy_id === pid && x.topic_key === null)) {
          const n = { id: `t${rows.length + 1}-${out.inserted.length}`, policy_id: pid, topic_key: null, evidence: null, contribution_id: args.p_contribution_id };
          rows.push(n); out.inserted.push({ ...n });
        }
      } else {
        keys.forEach((k, i) => {
          const cur = rows.find((x) => x.policy_id === pid && x.topic_key === k);
          if (!cur) {
            const n = { id: `t${rows.length + 1}-${k}`, policy_id: pid, topic_key: k, evidence: evidence[i], contribution_id: args.p_contribution_id };
            rows.push(n); out.inserted.push({ ...n });
          } else if (cur.evidence !== evidence[i]) {
            out.updated.push({ id: cur.id, topic_key: k, old_evidence: cur.evidence, new_evidence: evidence[i] });
            cur.evidence = evidence[i];
          }
        });
      }
      return out;
    },
  });
  return fake;
}
const livePolicies = () => [
  { id: P1, title: "擴大公共托育", politician_id: POL, removed_at: null },
  { id: P2, title: "人事評議委員會", politician_id: POL, removed_at: null },
];

Deno.test("落庫：有主題的新增一列、查過沒有主題的新增一列 NULL；每列寫查核履歷；回 politician_id", async () => {
  const fake = topicsFake({ policies: livePolicies(), policy_topics: [], edit_history: [] });
  const out = await applyContribution(fake.client, row({
    politician_id: POL,
    items: [{ policy_id: P1, topics: [topic("childcare"), topic("welfare", "弱勢家庭加碼津貼")] }, { policy_id: P2, topics: [] }],
  }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(out.politician_id, POL);
  const rows = fake.db.policy_topics;
  assertEquals(rows.length, 3);
  const none = rows.find((r) => r.policy_id === P2)!;
  assertEquals([none.topic_key, none.evidence], [null, null], "查過沒有主題＝一列 NULL，不是沒有列");
  assertEquals(rows.filter((r) => r.policy_id === P1).map((r) => r.topic_key).sort(), ["childcare", "welfare"]);
  assertEquals(fake.db.edit_history.filter((e) => e.field === "*" && e.table_name === "policy_topics").length, 3);
  assertStringIncludes(out.message, NO_TOPIC_LABEL);
  assertStringIncludes(out.message, "少子化與育兒");
});

Deno.test("落庫：重交就是更正——整組換成這次的，刪掉的整列記下（還原放得回去）、依據句改了記欄位；全部一樣 superseded", async () => {
  const fake = topicsFake({
    policies: livePolicies(),
    policy_topics: [
      { id: "a", policy_id: P1, topic_key: "welfare", evidence: "舊的依據句", contribution_id: null },
      { id: "b", policy_id: P1, topic_key: "childcare", evidence: "擴大公共托育服務量能", contribution_id: null },
      { id: "c", policy_id: P2, topic_key: "admin", evidence: "公開透明的人事", contribution_id: null },
    ],
    edit_history: [],
  });
  const out = await applyContribution(fake.client, row({
    politician_id: POL,
    items: [{ policy_id: P1, topics: [topic("childcare", "新的依據句，擴大公共托育")] }, { policy_id: P2, topics: [] }],
  }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policy_topics.filter((r) => r.policy_id === P1).map((r) => r.topic_key), ["childcare"], "welfare 被換掉");
  assertEquals(fake.db.policy_topics.filter((r) => r.policy_id === P2).map((r) => r.topic_key), [null], "有主題改成查過沒有主題：主題列刪掉、換成 NULL 那一列");
  const hist = fake.db.edit_history;
  const removed = hist.filter((e) => e.field === "*" && e.new_value === null);
  assertEquals(removed.length, 2, "兩個被刪的整列都記下");
  assertEquals((removed.find((e) => e.record_id === "a")!.old_value as Obj).evidence, "舊的依據句", "整列快照留著，還原＝放回去");
  assertEquals(hist.filter((e) => e.field === "evidence").length, 1);
  const again = await applyContribution(fake.client, row({
    politician_id: POL,
    items: [{ policy_id: P1, topics: [topic("childcare", "新的依據句，擴大公共托育")] }, { policy_id: P2, topics: [] }],
  }));
  assertEquals(again.status, "superseded", "跟現有一樣不重複寫，也不寫假的履歷");
  assertEquals(fake.db.edit_history.length, hist.length);
});

Deno.test("落庫：已移除、找不到、不是這位人物的政見略過，其餘照寫；全都落不了才 failed、什麼都不寫", async () => {
  const fake = topicsFake({
    policies: [...livePolicies(), { id: P3, title: "別人的政見", politician_id: "00000000-0000-4000-8000-0000000000ff", removed_at: null }, { id: "00000000-0000-4000-8000-000000000014", title: "已移除", politician_id: POL, removed_at: "2026-10-01" }],
    policy_topics: [], edit_history: [],
  });
  const gone = "00000000-0000-4000-8000-000000000014";
  const out = await applyContribution(fake.client, row({
    politician_id: POL,
    items: [{ policy_id: P1, topics: [topic("childcare")] }, { policy_id: P3, topics: [topic("childcare")] }, { policy_id: gone, topics: [] }, { policy_id: "00000000-0000-4000-8000-000000000099", topics: [] }],
  }));
  assertEquals(out.status, "applied", out.message);
  assertEquals(fake.db.policy_topics.map((r) => r.policy_id), [P1], "只有他自己、還在的那一條被寫");
  for (const w of ["不是這位人物的政見", "已被移除", "找不到"]) assertStringIncludes(out.message, w);

  const none = topicsFake({ policies: [{ id: P3, title: "別人的", politician_id: "00000000-0000-4000-8000-0000000000ff", removed_at: null }], policy_topics: [], edit_history: [] });
  const bad = await applyContribution(none.client, row({ politician_id: POL, items: [{ policy_id: P3, topics: [] }] }));
  assertEquals(bad.status, "failed");
  assertEquals(none.db.policy_topics.length, 0);
});

Deno.test("交件前置檢查：政見不存在 → target_not_found；已移除、不是這位人物的 → apply_would_fail", async () => {
  const items = [{ contribution_type: "policy_topic", payload: { politician_id: POL, items: [{ policy_id: P1, topics: [] }] } }];
  const none = await precheckApplyTargets(createFakeSupabase({ policies: [], politicians: [{ id: POL, merged_into: null }] }).client, items, new Set());
  assertEquals(none.map((p) => p.code), ["target_not_found"]);
  const gone = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: P1, removed_at: "2026-10-01", politician_id: POL }], politicians: [{ id: POL, merged_into: null }] }).client, items, new Set());
  assertEquals(gone.map((p) => p.code), ["apply_would_fail"]);
  const other = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: P1, removed_at: null, politician_id: "00000000-0000-4000-8000-0000000000ff" }], politicians: [{ id: POL, merged_into: null }] }).client, items, new Set());
  assertEquals(other.map((p) => p.code), ["apply_would_fail"]);
  assertStringIncludes(other[0].message, "不是這位人物的");
  const live = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: P1, removed_at: null, politician_id: POL }], politicians: [{ id: POL, merged_into: null }] }).client, items, new Set());
  assertEquals(live, []);
  const merged = await precheckApplyTargets(createFakeSupabase({ policies: [{ id: P1, removed_at: null, politician_id: POL }], politicians: [{ id: POL, merged_into: "x" }] }).client, items, new Set());
  assertEquals(merged.map((p) => p.code), ["apply_would_fail"], "人物已被合併要擋");
});

Deno.test("落庫函式回傳的整理：缺的鍵補空陣列、payload 取出來全轉小寫", () => {
  assertEquals(parseApplyResult(null), { inserted: [], deleted: [], updated: [] });
  assertEquals(parseApplyResult({ inserted: [{ id: 1 }] }).inserted.length, 1);
  const items = policyTopicItems({ items: [{ policy_id: ` ${P1.toUpperCase()} `, topics: [{ topic: " childcare ", evidence: " 擴大托育 " }] }, "bad"] });
  assertEquals(items, [{ policy_id: P1, topics: [{ topic: "childcare", evidence: "擴大托育" }] }]);
  assertEquals(policyTopicArrays(items[0]), { keys: ["childcare"], evidence: ["擴大托育"] });
  assertEquals(topicsPhrase([]), NO_TOPIC_LABEL);
  assertEquals(topicsPhrase([{ topic: "childcare" }, { topic: "elderly" }]), "少子化與育兒、長照與高齡");
});

// ── 4. 型別清點 ──────────────────────────────────────────────────────────────

Deno.test("四處清點（TS）：貢獻型別、任務型別、建議回報型別、一次一份的任務、標籤都登記了", async () => {
  assert((CONTRIBUTION_TYPES as readonly string[]).includes("policy_topic"));
  assert((TASK_TYPES as readonly string[]).includes("policy_topic_missing"));
  assertEquals(SUGGESTED_TYPE.policy_topic_missing, "policy_topic");
  assert(SINGLE_ANSWER_TASK_TYPES.has("policy_topic_missing"), "一個來源 IP 一次一份");
  const labels = await Deno.readTextFile(new URL("../../../lib/task-labels.ts", import.meta.url));
  assertStringIncludes(labels, "policy_topic_missing:");
  const quality = await Deno.readTextFile(new URL("../../../lib/model-quality.ts", import.meta.url));
  assertStringIncludes(quality, "policy_topic:");
});

Deno.test("四處清點（DB）：contributions_contribution_type_check 最新一版含 policy_topic，而且跟 TS 清單逐一相同——漏了交件會全被擋、測試卻全綠（09-20 踩過）", async () => {
  const { name, sql } = await latestMigrationWith("ADD CONSTRAINT contributions_contribution_type_check");
  const body = between(sql.slice(sql.lastIndexOf("ADD CONSTRAINT contributions_contribution_type_check")), "CHECK (", "));");
  assertEquals(quotedList(body).sort(), [...CONTRIBUTION_TYPES].sort(), `${name} 的 CHECK 跟 CONTRIBUTION_TYPES 不一致`);
  assert(quotedList(body).includes("policy_topic"));
});

Deno.test("四處清點（協議）：skill.md 版本跟端點一致、有 policy_topic 段落與 policy_topics 表說明", async () => {
  assertEquals(PROTOCOL_VERSION, "1.71.0");
  const md = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  assertStringIncludes(md, `**版本**：${PROTOCOL_VERSION}`);
  const at = md.indexOf("**`policy_topic`**");
  assert(at > 0, "skill.md 要有 policy_topic 段落");
  const section = md.slice(at, md.indexOf("**政策脈絡（1.52.0）**", at));
  for (const w of ["topics: []", "候選", "至多 2 個", "未調查", "查過、不屬於任何主題", "evidence", "disagree", "current.topics"]) assertStringIncludes(section, w);
  assert(/沒有交的政見[^。]*未調查/.test(section), "要講沒有交的政見維持「未調查」");
  assertStringIncludes(md, "policy_topic_missing");
  assertStringIncludes(md, "`policy_topics`**（1.71.0");
  for (const k of POLICY_TOPIC_KEYS) assertStringIncludes(md, `\`${k}\``, `skill.md 的 policy_topics 說明要列出主題 key ${k}`);
});

Deno.test("門檻照一般資料（不動計分）：policy_topic 是 normal，跟 policy／policy_elements 同一級", () => {
  assertEquals(riskLevel("policy_topic", {}), "normal");
  assertEquals(riskLevel("policy_topic", {}), riskLevel("policy_elements", {}));
});

// ── 5. SQL（migration）────────────────────────────────────────────────────────

const { name: MIG, sql: SQL } = await latestMigrationWith("CREATE TABLE IF NOT EXISTS policy_topics");
const TABLE = between(SQL, "CREATE TABLE IF NOT EXISTS policy_topics", "\n);");

Deno.test("資料表：有主題才有依據句、一條政見同一主題一列、「查過沒有主題」至多一列，擋在資料庫", () => {
  assert(/policy_id\s+UUID NOT NULL REFERENCES policies\(id\) ON DELETE CASCADE/.test(TABLE));
  assert(/topic_key\s+TEXT,/.test(TABLE), "topic_key 可以是 NULL（＝查過、不屬於任何主題）");
  assert(/\(topic_key IS NOT NULL AND evidence IS NOT NULL AND btrim\(evidence\) <> ''[^)]*\)\s+OR \(topic_key IS NULL AND evidence IS NULL\)/.test(TABLE), "有主題才有依據句、沒主題就不能有——不可以塞「無」冒充");
  assertStringIncludes(TABLE, "UNIQUE (policy_id, topic_key)");
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS policy_topics_one_none ON policy_topics \(policy_id\) WHERE topic_key IS NULL/.test(SQL), "UNIQUE 對 NULL 不起作用，要另用部分索引擋第二列 NULL");
  assertStringIncludes(SQL, 'CREATE POLICY "Public read" ON policy_topics FOR SELECT USING (true)');
  assertStringIncludes(SQL, "ALTER TABLE policy_topics ENABLE ROW LEVEL SECURITY");
});

Deno.test("落庫函式：整組換、不留半套；規則在一個函式裡（空陣列＝NULL 那一列、先刪不在新清單的、已有的保留）", () => {
  const fn = between(SQL, "CREATE OR REPLACE FUNCTION policy_topics_apply", "COMMENT ON FUNCTION policy_topics_apply");
  assertStringIncludes(fn, "RETURNS JSONB");
  assert(/v_n = 0 AND r\.topic_key IS NULL\) OR \(r\.topic_key IS NOT NULL AND r\.topic_key = ANY \(p_keys\)\) THEN CONTINUE/.test(fn), "空清單要保留 NULL 那一列、刪掉所有主題列；有清單要保留還在清單裡的");
  assert(/INSERT INTO policy_topics \(policy_id, topic_key, evidence, contribution_id\) VALUES \(p_policy_id, NULL, NULL, p_contribution_id\)/.test(fn), "查過沒有主題＝一列 topic_key NULL、依據句 NULL");
  assertStringIncludes(fn, "IS DISTINCT FROM p_evidence[i]");
  assert(!/EXCEPTION WHEN OTHERS/.test(fn), "出錯要讓整個交易回滾，不能吞掉");
});

Deno.test("資料走流程：這支 migration 不寫任何一筆主題（只有落庫函式自己的 INSERT）", () => {
  const withoutFn = SQL.replace(between(SQL, "CREATE OR REPLACE FUNCTION policy_topics_apply", "COMMENT ON FUNCTION policy_topics_apply"), "");
  assert(!/INSERT INTO policy_topics/i.test(withoutFn), `${MIG} 不可以直接寫主題——要派任務、驗證後上線`);
  assert(!/(UPDATE|DELETE FROM) policy_topics/i.test(withoutFn));
});

Deno.test("視圖：違反「0～2 個主題、無主題不與主題並存」的政見看 policy_topics_drift，security_invoker", () => {
  const view = between(SQL, "CREATE OR REPLACE VIEW policy_topics_drift", "COMMENT ON VIEW policy_topics_drift");
  assert(/> 2/.test(view) && /none_rows|topic_key IS NULL/.test(view));
  assertStringIncludes(view, "SET (security_invoker = on)");
});

const ARMS_DEFS = await (async () => {
  const out: Array<{ name: string; body: string }> = [];
  for (const name of await migrationNames()) {
    const sql = await readMigration(name);
    if (!sql.includes("CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms")) continue;
    out.push({ name, body: between(sql, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms", "COMMENT ON FUNCTION contribution_auto_tasks_arms") });
  }
  return out;
})();
const calledArms = (body: string) => new Set([...body.matchAll(/FROM\s+(contribution_auto_tasks_[a-z_]+)\(\)/g)].map((m) => m[1]));

Deno.test("派工臂：新臂接進 contribution_auto_tasks_arms 的最新一版，原有的臂一支不少", () => {
  const latest = ARMS_DEFS[ARMS_DEFS.length - 1];
  const prev = ARMS_DEFS[ARMS_DEFS.length - 2];
  assert(calledArms(latest.body).has("contribution_auto_tasks_policy_topics"), `${latest.name} 是 arms 的最新定義，要含 policy_topics 這一支`);
  for (const a of calledArms(prev.body)) assert(calledArms(latest.body).has(a), `${latest.name} 比 ${prev.name} 少了 ${a}`);
  assertStringIncludes(latest.body, "roster_scope_covers", "名單清查的縣市範圍過濾要原樣保留");
  assert(/r\.task_type = 'progress_stale' AND EXISTS \(SELECT 1 FROM due d/.test(latest.body), "期限到了就不派 progress_stale 的規則要原樣保留");
});

Deno.test("派工臂範圍：在選者（有尚未投票那一屆的參選紀錄、非退選）名下還沒標主題的政見；等票中的不派；沒有列才算還沒標", () => {
  const arm = between(SQL, "CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_topics", "COMMENT ON FUNCTION contribution_auto_tasks_policy_topics");
  assertStringIncludes(arm, "'auto:policy_topic_missing:'");
  assertStringIncludes(arm, "e.election_date >= CURRENT_DATE");
  assertStringIncludes(arm, "q.candidacy_status IS DISTINCT FROM 'withdrawn'");
  assertStringIncludes(arm, "p.merged_into IS NULL");
  assertStringIncludes(arm, "pl.removed_at IS NULL");
  assert(/NOT EXISTS \(SELECT 1 FROM policy_topics t WHERE t\.policy_id = pl\.id\)/.test(arm), "有任何一列（包含 NULL 那一列＝查過沒有主題）就不再派；沒有列才是還沒標");
  assert(/c\.contribution_type = 'policy_topic' AND c\.status IN \('pending', 'verified', 'apply_failed'\)/.test(arm), "等票中的不派");
  assertStringIncludes(arm, "c.payload->>'politician_id'");
  assertStringIncludes(arm, "GROUP BY ppl.politician_id");
  assert(/^\s*1, t\.region/m.test(arm), "跟其他缺口一樣 reward 1、region 照人物（派工按縣市分流）");
  // 候選與政見原文不放進 target（佇列每 10 分鐘重寫 target，政見文字很長）：只放 id 清單與總數
  assertStringIncludes(arm, "'policy_ids', to_jsonb(t.policy_ids[1:30]), 'policies_total'");
  assert(!/candidates/.test(arm.replace(/current\.policies\[\]\.candidates/g, "")), "候選在 task-context 派工當下才算，不寫進 SQL");
});

Deno.test("票數預算影子模式的候選清單最新一版含 policy_topic（跟 vote-budget.ts 的維度同步）", async () => {
  const { sql } = await latestMigrationWith("FUNCTION system_one_vote_budget_candidates");
  const body = sql.slice(sql.lastIndexOf("FUNCTION system_one_vote_budget_candidates"));
  assertStringIncludes(between(body, "contribution_type IN (", "AND NOT EXISTS"), "'policy_topic'");
});

// ── 6. 送給代理的說明 ────────────────────────────────────────────────────────

Deno.test("任務說明：候選只是起點、不是提到字就算、依據句要原句、空陣列是答案、不確定就不要交；骨架不預填系統候選", () => {
  const g = TASK_GUIDANCE.policy_topic_missing;
  for (const w of ["candidates", "不是**提到了哪個字", "依據句", "原句", "[]", "不要交那一條", "跟「還沒標」分開", "最多 2 個"]) assertStringIncludes(g, w);
  assertStringIncludes(PAYLOAD_SHAPE.policy_topic, "politician_id");
  const tpl = buildReportTemplate("policy_topic_missing", "policy_topic", { politician_id: POL, policy_ids: [P1, P2] }, `auto:policy_topic_missing:${POL}`);
  const p = tpl!.payload as { politician_id: string; items: Array<{ policy_id: string; topics: Obj[] }> };
  assertEquals(p.politician_id, POL);
  assertEquals(p.items.map((i) => i.policy_id), [P1, P2]);
  assertEquals(tpl!.contribution_type, "policy_topic");
  assert(!JSON.stringify(p).includes("childcare"), "骨架不預填主題——照抄候選等於沒判斷");
});

Deno.test("任務現況：每條政見帶系統算的候選（用完整說明算、說明截斷不影響候選）、詞彙表只給 key／名稱／分類", () => {
  const longDescription = `${"一".repeat(600)}。另外推動公共托育，每區設置托嬰中心。`;
  const cur = shapeTaskCurrent("policy_topic_missing", {
    politician: { id: POL, name: "王小明" },
    policies: [{ id: P1, title: "完善地方建設", description: longDescription, category: "社會福利" }, { id: P2, title: "人事評議委員會", description: "公開透明", category: "社會福利" }],
    policies_total: 2,
  });
  const policies = cur.policies as Array<Obj>;
  assertEquals(policies[0].policy_id, P1);
  assertEquals(policies[0].truncated, true, "長說明照規矩截斷");
  assertEquals((policies[0].candidates as string[])[0], "childcare", "候選看的是完整說明，不是截斷後的");
  assertEquals(policies[1].candidates, []);
  assertEquals(cur.hint, TASK_GUIDANCE.policy_topic_missing);
  const vocab = cur.topics as Array<Obj>;
  assertEquals(vocab.length, 16);
  assertEquals(Object.keys(vocab[0]).sort(), ["categories", "key", "label"], "同義詞不給——候選已經用同義詞算過，給了反而引導照關鍵字貼標");
  assertEquals(vocab, topicVocabulary());
});

Deno.test("驗證項：逐條核對、講得出「只因順口提到一個字就貼上要投反對」、空陣列也要核、agree／disagree／unsure", () => {
  const cur = shapeVerifyCurrent("policy_topic", { politician_id: POL, items: [] }, {
    politicians: [{ id: POL, name: "王小明" }],
    policies: [{ id: P1, title: "擴大公共托育", description: "每區設置托嬰中心", category: "社會福利" }],
  });
  assertEquals(cur.hint, POLICY_TOPIC_VERIFY_HINT);
  for (const w of ["agree", "disagree", "unsure", "順口提到", "evidence", "空陣列", "最多 2 個", "policy_id"]) assertStringIncludes(String(cur.hint), w);
  assert(!/uphold|reject/.test(String(cur.hint)));
  assertEquals(((cur.policies as Array<Obj>)[0].candidates as string[])[0], "childcare");
  assertEquals((cur.topics as unknown[]).length, 16);
});

Deno.test("貢獻看板的摘要：講得出標了幾條政見、各主題各幾條、沒有主題的也講", () => {
  const { summary } = summarizeContribution({
    contribution_type: "policy_topic",
    payload: { name: "王小明", politician_id: POL, items: [
      { policy_id: P1, topics: [topic("childcare")] }, { policy_id: P2, topics: [] }, { policy_id: P3, topics: [topic("childcare"), topic("elderly")] },
    ] },
  });
  assertStringIncludes(summary, "3 條政見");
  assertStringIncludes(summary, "少子化與育兒 2 條");
  assertStringIncludes(summary, "長照與高齡 1 條");
  assertStringIncludes(summary, `${NO_TOPIC_LABEL} 1 條`);
});
