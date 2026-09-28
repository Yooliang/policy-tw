// 查證來源自動附上（2026-09-28）：fetchTaskContext 依任務對象的政黨／縣市／選舉別，
// 從 verification_sources 撈出最多 6 筆附進 data.verification_sources；
// shapeTaskCurrent 再把它放進 current.verification_sources（沒有就不附，不能讓派工失敗）。
import { assertEquals } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { fetchTaskContext, shapeTaskCurrent } from "./task-context.ts";
import { resetVerificationSourcesCache } from "./verification-sources.ts";

const SOURCES = [
  {
    id: 1, name: "台灣民眾黨候選人頁", kind: "party", party: "台灣民眾黨", regions: null,
    election_types: ["縣市議員"], provides: ["photo", "education", "experience", "district"],
    list_url: "https://tpp.example/list", detail_url_pattern: "https://tpp.example/detail?cid=<id>",
    access: "html", quality_note: null, how_to: "打開個人頁", last_checked: "2026-09-28", status: "ok", sort: 10,
  },
  {
    id: 2, name: "中選會候選人資料庫 API", kind: "cec", party: null, regions: null, election_types: null,
    provides: ["birth_year", "candidacy"], list_url: null,
    detail_url_pattern: "https://db.cec.gov.tw/query?cand_name=<姓名>",
    access: "json", quality_note: null, how_to: "用姓名查", last_checked: "2026-09-28", status: "ok", sort: 50,
  },
];

function seed() {
  return {
    politicians: [
      { id: "p1", name: "王小明", party: "台灣民眾黨", region: "台北市", election_type: "縣市議員" },
      { id: "p2", name: "陳小華", party: "無黨籍", region: "屏東縣", election_type: "村里長" },
    ],
    verification_sources: SOURCES,
  };
}

Deno.test("profile_gap：依政治人物的政黨/選舉別附上對得到的來源（政黨限定的＋不分政黨的中選會 API），依 sort 排序", async () => {
  resetVerificationSourcesCache();
  const { client } = createFakeSupabase(seed());
  const data = await fetchTaskContext(client, "profile_gap", { politician_id: "p1" });
  const hints = data.verification_sources ?? [];
  // 台灣民眾黨候選人頁（政黨／選舉別都對得上）＋中選會 API（不分政黨、profile_gap 要的 birth_year 對得上）
  assertEquals(hints.length, 2);
  assertEquals(hints[0].name, "台灣民眾黨候選人頁");
  assertEquals(hints[0].url, "https://tpp.example/detail?cid=<id>");
  assertEquals(hints[1].name, "中選會候選人資料庫 API");

  const current = shapeTaskCurrent("profile_gap", data);
  assertEquals((current.verification_sources as unknown[]).length, 2);
});

Deno.test("profile_gap：政黨／選舉別對不上的來源被篩掉，不分政黨的來源還是會附", async () => {
  resetVerificationSourcesCache();
  const { client } = createFakeSupabase(seed());
  const data = await fetchTaskContext(client, "profile_gap", { politician_id: "p2" });
  const hints = data.verification_sources ?? [];
  assertEquals(hints.length, 1);
  assertEquals(hints[0].name, "中選會候選人資料庫 API");
  assertEquals(hints.some((h) => h.name === "台灣民眾黨候選人頁"), false);
});

Deno.test("roster_check：沒有 politician_id，改用 target 的縣市／選舉別（中選會來源不分縣市，一樣附上）", async () => {
  resetVerificationSourcesCache();
  const { client } = createFakeSupabase(seed());
  // 不帶 election_id：roster_check 本身撈名單那段（fetchAllRows／range）不會被觸發，
  // 這裡只測查證來源這一段是否正確讀到 target 的 region／election_type
  const data = await fetchTaskContext(client, "roster_check", { region: "屏東縣", election_type: "縣市議員" });
  const hints = data.verification_sources ?? [];
  assertEquals(hints.some((h) => h.name === "中選會候選人資料庫 API"), true);
});

Deno.test("不在清單裡、target 也沒帶 politician_id 的任務型別：不附這個欄位", async () => {
  resetVerificationSourcesCache();
  const { client } = createFakeSupabase(seed());
  const data = await fetchTaskContext(client, "adjudicate", { contribution_id: "does-not-exist" });
  assertEquals(data.verification_sources, undefined);
});

Deno.test("手動任務 target 帶 politician_id：即使 task_type 不在自動缺口清單裡也附上", async () => {
  resetVerificationSourcesCache();
  const { client } = createFakeSupabase(seed());
  const data = await fetchTaskContext(client, "某種手動任務", { politician_id: "p1" });
  const hints = data.verification_sources ?? [];
  assertEquals(hints.length > 0, true);
});
