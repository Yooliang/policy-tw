/**
 * 執行：cd supabase/functions && deno test --allow-read _shared/
 */
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { buildCandidateKeys, normElectionType, normParty, normPosition, normText, positionStrength } from "./identity-normalize.ts";
import { resolvePolitician } from "./politician-identity.ts";
import { createMemoryIdentityStore, storeFromSnapshot } from "./identity-memory-store.ts";
import cases from "./fixtures/normalization-cases.json" with { type: "json" };
import fixture from "./fixtures/chensuyue.json" with { type: "json" };

const CHANGHUA_ID = "bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9"; // 2024 彰化立委（真）
const YILAN_ID = "f032179f-bf3a-4ebf-aed8-a423a0e101bd"; // 2022 宜蘭村里長（同名不同人）

/** 只放兩位真人的 store（沒有 AI 空殼），模擬清理後的 DB。 */
function realPeopleStore() {
  const real = fixture.politicians.filter((p) => p.id === CHANGHUA_ID || p.id === YILAN_ID);
  const pe = fixture.politician_elections.filter((e) => real.some((p) => p.id === e.politician_id));
  return storeFromSnapshot(real, pe);
}

/** ai-action import_candidate 實際送進來的形狀 */
const aiShellPayload = {
  name: "陳素月",
  party: "民進黨",
  position: "縣市長",
  region: "彰化縣",
  current_position: "立法委員",
};

Deno.test("正規化案例（與 SQL 共用）", () => {
  for (const c of cases.text) assertEquals(normText(c.in), c.out, `normText(${JSON.stringify(c.in)})`);
  for (const c of cases.party) assertEquals(normParty(c.in), c.out, `normParty(${c.in})`);
  for (const c of cases.position) assertEquals(normPosition(c.in), c.out, `normPosition(${c.in})`);
  for (const c of cases.election_type) assertEquals(normElectionType(c.in), c.out, `normElectionType(${c.in})`);
  for (const c of cases.position_strength) assertEquals(positionStrength(c.in), c.out, `positionStrength(${c.in})`);
});

Deno.test("快照回填：真陳素月的 key 集合", () => {
  const store = realPeopleStore();
  const values = store.keys.filter((k) => k.politician_id === CHANGHUA_ID).map((k) => `${k.key_type}:${k.key_value}`).sort();
  assertEquals(values, [
    "birth:陳素月|1966",
    "party:陳素月|民主進步黨",
    "position:陳素月|立法委員",
    "position:陳素月|縣市長",
    "region_type:陳素月|彰化縣|立法委員",
    "region_type:陳素月|彰化縣|縣市長",
  ]);
});

Deno.test("同名不同人：彰化立委 vs 宜蘭村里長判開", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, aiShellPayload, { persist: false });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, CHANGHUA_ID);
  const yilan = r.candidates.find((c) => c.politician_id === YILAN_ID);
  assertEquals(yilan, undefined, "宜蘭那位不該有任何面向命中");
});

Deno.test("換黨：只靠選區＋類型對上", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, {
    name: "陳素月",
    party: "台灣民眾黨",
    region: "彰化縣",
    election_type: "立法委員",
  }, { persist: false });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, CHANGHUA_ID);
  assertEquals(r.matched_keys.map((k) => k.key_type), ["region_type"]);
});

Deno.test("換選區：靠現職對上", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, {
    name: "陳素月",
    party: "民進黨",
    region: "台中市",
    election_type: "立法委員",
    current_position: "立法委員",
  }, { persist: false });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, CHANGHUA_ID);
  assertEquals(r.matched_keys.map((k) => k.key_type).sort(), ["party", "position"]);
});

Deno.test("只有政黨命中 → ambiguous 並寫入待審", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, {
    name: "陳素月",
    party: "民進黨",
    region: "台中市",
    election_type: "縣市長",
  }, { source: "test" });
  assertEquals(r.decision, "ambiguous");
  assertEquals(r.politician_id, undefined);
  assertEquals(store.reviews.length, 1);
  assertEquals(store.reviews[0].source, "test");
  assertEquals(store.reviews[0].candidates[0].politician_id, CHANGHUA_ID);
});

Deno.test("弱＋弱（政黨＋常見職位）湊到 2 分不算 matched", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "A", name: "張志豪", party: "民主進步黨", region: "新北市", election_type: "縣市議員", position: "縣市議員候選人" });
  const r = await resolvePolitician(store, {
    name: "張志豪",
    party: "民進黨",
    region: "台北市",
    election_type: "縣市議員",
    current_position: "台北市議員",
  }, { persist: false });
  assertEquals(r.candidates[0].score, 2);
  assertEquals(r.decision, "ambiguous");
});

Deno.test("兩人各中一個中面向 → ambiguous", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "A", name: "王小明", party: "無黨籍", region: "台北市", election_type: "立法委員" });
  store.addPolitician({ id: "B", name: "王小明", party: "時代力量", region: "高雄市", election_type: "縣市長", current_position: "縣市長" });
  const r = await resolvePolitician(store, {
    name: "王小明",
    party: "中國國民黨",
    region: "台北市",
    election_type: "立法委員",
    current_position: "高雄市長",
  }, { source: "test" });
  assertEquals(r.decision, "ambiguous");
  assertEquals(r.candidates.map((c) => c.score), [2, 2]);
  assertEquals(store.reviews.length, 1);
});

Deno.test("領先第二名 ≥2 才 matched", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "A", name: "王小明", party: "中國國民黨", region: "台北市", election_type: "立法委員", current_position: "立法委員" });
  store.addPolitician({ id: "B", name: "王小明", party: "中國國民黨", region: "高雄市", election_type: "縣市長" });
  const r = await resolvePolitician(store, {
    name: "王小明",
    party: "國民黨",
    region: "台北市",
    election_type: "立法委員",
    current_position: "立法委員",
  }, { persist: false });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, "A");
  assertEquals(r.candidates.map((c) => c.score), [5, 1]);
});

Deno.test("別名展開：用舊名送進來也能對上改名後的人", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "P", name: "陳筱諭", party: "民主進步黨", region: "台南市", election_type: "縣市議員", birth_year: 1985 });
  store.addAlias("P", "陳怡潔");
  const r = await resolvePolitician(store, {
    name: "陳怡潔",
    party: "民進黨",
    region: "台南市",
    election_type: "縣市議員",
    birth_year: 1985,
  }, { persist: false });
  assertEquals(r.names.sort(), ["陳怡潔", "陳筱諭"]);
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, "P");
  assert(r.matched_keys.some((k) => k.key_type === "birth" && k.key_value === "陳筱諭|1985"));
});

// 2026-09-23（agy 審查）：原本判 new + flag——同一個人換了黨、換了縣市就會被建成第二個同名人物，而且不觸發指認。
// 現在交給驗證者指認；只有出生年能排除全部同名者時才是 new（下面「出生年衝突」那支）。
Deno.test("三面向全換、沒有出生年可排除 → ambiguous（要指認）", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, {
    name: "陳素月",
    party: "台灣民眾黨",
    region: "台中市",
    election_type: "縣市長",
    current_position: "台中市副市長",
  }, { persist: false });
  assertEquals(r.decision, "ambiguous");
  assertEquals(r.flag, undefined);
  assertEquals(r.candidates, []);
});

Deno.test("完全沒同名 → new、無 flag", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, { name: "柯文哲", party: "台灣民眾黨", region: "台北市", election_type: "縣市長" }, { persist: false });
  assertEquals(r.decision, "new");
  assertEquals(r.flag, undefined);
  assertEquals(r.keys.map((k) => k.key_type).sort(), ["party", "region_type"]);
});

Deno.test("matched 後把新面向 key 累積寫回", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: CHANGHUA_ID, name: "陳素月", party: "民主進步黨", region: "彰化縣", election_type: "立法委員", birth_year: 1966 }, [
    { region: "彰化縣", election_type: "立法委員", position: "立委候選人" },
  ]);
  const before = store.keys.filter((k) => k.politician_id === CHANGHUA_ID).length;
  const r = await resolvePolitician(store, aiShellPayload, { source: "ai-action" });
  assertEquals(r.decision, "matched");
  const after = store.keys.filter((k) => k.politician_id === CHANGHUA_ID);
  assertEquals(after.length, before + 2, "應多出 region_type 彰化縣|縣市長 與 position 縣市長");
  const added = after.filter((k) => k.source === "ai-action").map((k) => k.key_value).sort();
  assertEquals(added, ["陳素月|彰化縣|縣市長", "陳素月|縣市長"]);
});

Deno.test("出生年衝突：其他面向再像也剔除", async () => {
  const store = realPeopleStore();
  const r = await resolvePolitician(store, { ...aiShellPayload, birth_year: 1968 }, { persist: false });
  const changhua = r.candidates.find((c) => c.politician_id === CHANGHUA_ID);
  assertExists(changhua);
  assertEquals(changhua.vetoed, "birth_conflict");
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, YILAN_ID, "1968 是宜蘭那位的出生年");
});

Deno.test("prod 快照：8 筆 AI 空殼逐一都會被判回真陳素月", async () => {
  const shells = fixture.politicians.filter((p) => p.id !== CHANGHUA_ID && p.id !== YILAN_ID);
  assertEquals(shells.length, 8);
  const store = storeFromSnapshot(fixture.politicians, fixture.politician_elections).without(shells.map((s) => s.id));
  for (const shell of shells) {
    const r = await resolvePolitician(store, shell, { persist: false });
    assertEquals(r.decision, "matched", `${shell.id.slice(0, 8)} ${r.reason}`);
    assertEquals(r.politician_id, CHANGHUA_ID, shell.id.slice(0, 8));
  }
});

const THEME_2022 = "63615098f5afa8ec53159c4a86fc01d3"; // 111年縣市長選舉
const THEME_2018 = "f75e94cad2958f8764f9d090e72b5567"; // 107年縣市長選舉

Deno.test("cec_cand_id：value 帶選舉場次 {theme}#{cand_id}，同場重複匯入單靠它就 matched", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "P", name: "王惠美", party: "中國國民黨", region: "彰化縣", election_type: "縣市長", birth_year: 1968, cec_cand_id: 144837, cec_theme_id: THEME_2022 });
  const stored = store.keys.find((k) => k.key_type === "cec_cand_id");
  assertEquals(stored?.key_value, `${THEME_2022}#144837`);
  assertEquals(stored?.strength, 3);

  // 同場再匯入一次：黨名寫法不同、沒帶出生年，只靠 theme+cand_id 對上
  const r = await resolvePolitician(store, { name: "王惠美", party: "國民黨", region: "彰化縣", election_type: "縣市長", cec_cand_id: "144837", cec_theme_id: THEME_2022 }, { persist: false });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, "P");
  assert(r.matched_keys.some((k) => k.key_type === "cec_cand_id"));

  // 只有 cand_id 沒有 theme → 不產 key（避免跨屆撞號）
  const noTheme = buildCandidateKeys({ name: "王惠美", cec_cand_id: 144837 });
  assertEquals(noTheme.filter((k) => k.key_type === "cec_cand_id"), []);
});

Deno.test("同一人兩屆 cand_id 不同：cec_cand_id 不會命中，靠 birth 對上", async () => {
  const store = createMemoryIdentityStore();
  // 2018 匯入：林姿妙 cand_id=242
  store.addPolitician({ id: "LIN", name: "林姿妙", party: "中國國民黨", region: "宜蘭縣", election_type: "縣市長", birth_year: 1952, cec_cand_id: 242, cec_theme_id: THEME_2018 });
  // 2022 匯入：同一人 cand_id=144821
  const r = await resolvePolitician(store, { name: "林姿妙", party: "中國國民黨", region: "宜蘭縣", election_type: "縣市長", birth_year: 1952, cec_cand_id: 144821, cec_theme_id: THEME_2022 }, { source: "cec-2022" });
  assertEquals(r.decision, "matched");
  assertEquals(r.politician_id, "LIN");
  assert(r.matched_keys.some((k) => k.key_type === "birth" && k.key_value === "林姿妙|1952"));
  assertEquals(r.matched_keys.filter((k) => k.key_type === "cec_cand_id"), []);
  // 2022 的 cand_id 累積寫回，之後同場重匯入可直接命中
  assert(store.keys.some((k) => k.politician_id === "LIN" && k.key_value === `${THEME_2022}#144821`));
});

Deno.test("不同人同名同屆不同 cand_id：出生年不同硬否決，判開成新人物", async () => {
  const store = createMemoryIdentityStore();
  store.addPolitician({ id: "A", name: "陳素月", party: "無黨籍及未經政黨推薦", region: "宜蘭縣", election_type: "村里長", birth_year: 1968, cec_cand_id: 165000, cec_theme_id: THEME_2022 });
  const r = await resolvePolitician(store, { name: "陳素月", party: "無黨籍", region: "宜蘭縣", election_type: "村里長", birth_year: 1966, cec_cand_id: 165001, cec_theme_id: THEME_2022 }, { persist: false });
  const a = r.candidates.find((c) => c.politician_id === "A");
  assertEquals(a?.vetoed, "birth_conflict");
  assertEquals(r.decision, "new");
  assertEquals(r.flag, "same_name_exists");
});

Deno.test("候選 key 產生：election_type 沒給時由 position 推", () => {
  const keys = buildCandidateKeys({ name: "陳素月", party: "民進黨", position: "彰化縣長候選人", region: "彰化縣" });
  assertEquals(keys.map((k) => `${k.key_type}:${k.key_value}`).sort(), [
    "party:陳素月|民主進步黨",
    "position:陳素月|縣市長",
    "region_type:陳素月|彰化縣|縣市長",
  ]);
});
