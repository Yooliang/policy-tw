import { assert, assertEquals } from "jsr:@std/assert@1";
import { attachTickets, normalizeCandidacies, withoutFutureResults } from "./cec-candidate.ts";
import { decideByCec, scanOffset } from "./cec-verify.ts";

// 2026-09-17 對中選會實抓的蔡易餘（2024 當選、2012 落選）
const RAW = [
  { theme_id: "9c96", theme_name: "第11屆立法委員選舉 - 區域", vote_date: "2024-01-13", cand_id: 203374, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "*", area_data: { current_area: { area_name: "嘉義縣嘉義縣第01選區" } } },
  { theme_id: "081e", theme_name: "第08屆立法委員選舉 - 區域", vote_date: "2012-01-14", cand_id: 6677, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "", area_data: { current_area: { area_name: "嘉義縣第01選區" } } },
  { theme_id: "f000", theme_name: "2026 縣市長選舉", vote_date: "2026-11-28", cand_id: 9, cand_name: "蔡易餘", cand_birthyear: "1981", party_name: "民主進步黨", is_victor: "", area_data: { current_area: { area_name: "嘉義縣" } } },
];
const TICKETS = { theme_data: [{ ticket_data: [
  { cand_name: "詹琬蓁", ticket_num: 54097, ticket_percent: 40.78 },
  { cand_name: "蔡易餘", ticket_num: 78551, ticket_percent: 59.22 },
] }] };
const LIST = () => withoutFutureResults(normalizeCandidacies(RAW), "2026-09-17");
const WITH_TICKETS = () => LIST().map((c) => (c.election_id === 2024 ? attachTickets(c, TICKETS) : c));

Deno.test("對得上就上線：選舉結果＋得票數＋得票率三項都符合", () => {
  const d = decideByCec({
    contribution_type: "candidacy",
    payload: { name: "蔡易餘", election_id: 2024, election_result: "elected", votes_received: 78551, vote_percentage: 59.22 },
    politician: { region: "嘉義縣" },
  }, WITH_TICKETS());
  assertEquals(d.action, "apply");
  assertEquals(d.action === "apply" ? d.matched.sort() : [], ["election_result", "vote_percentage", "votes_received"]);
});

Deno.test("對不上就退件，理由帶中選會的實際數字", () => {
  const wrong = decideByCec({
    contribution_type: "candidacy",
    payload: { name: "蔡易餘", election_id: 2024, election_result: "not_elected" },
    politician: { region: "嘉義縣" },
  }, WITH_TICKETS());
  assertEquals(wrong.action, "reject");
  assert(wrong.action === "reject" && wrong.reason.includes("當選"), wrong.action === "reject" ? wrong.reason : "");

  const badVotes = decideByCec({
    contribution_type: "candidacy",
    payload: { name: "蔡易餘", election_id: 2024, election_result: "elected", votes_received: 78000 },
    politician: { region: "嘉義縣" },
  }, WITH_TICKETS());
  assertEquals(badVotes.action, "reject");
  assert(badVotes.action === "reject" && badVotes.reason.includes("78551"));
});

Deno.test("得票率四捨五入的誤差不算錯", () => {
  const d = decideByCec({
    contribution_type: "candidacy",
    payload: { name: "蔡易餘", election_id: 2024, election_result: "elected", vote_percentage: 59.24 },
    politician: { region: "嘉義縣" },
  }, WITH_TICKETS());
  assertEquals(d.action, "apply", "差 0.02 在容許範圍");
  const far = decideByCec({
    contribution_type: "candidacy",
    payload: { name: "蔡易餘", election_id: 2024, vote_percentage: 58.5 },
    politician: { region: "嘉義縣" },
  }, WITH_TICKETS());
  assertEquals(far.action, "reject");
});

Deno.test("不敢自動決定的都留給同儕：還沒投票、查無此人、同名多筆、沒有可查欄位", () => {
  const future = decideByCec({ contribution_type: "candidacy", payload: { name: "蔡易餘", election_id: 2026, election_result: "elected" }, politician: { region: "嘉義縣" } }, LIST());
  assertEquals(future.action, "skip");
  assert(future.action === "skip" && future.reason.includes("還沒投票"), future.action === "skip" ? future.reason : "");

  const unknown = decideByCec({ contribution_type: "candidacy", payload: { name: "查無此人", election_id: 2024, election_result: "elected" }, politician: { region: "嘉義縣" } }, LIST());
  assertEquals(unknown.action, "skip");

  const twins = decideByCec({ contribution_type: "candidacy", payload: { name: "王小明", election_id: 2024, election_result: "elected" }, politician: { region: "台北市" } },
    normalizeCandidacies([
      { cand_name: "王小明", vote_date: "2024-01-13", party_name: "A黨", is_victor: "*", area_data: { current_area: { area_name: "台北市第01選區" } } },
      { cand_name: "王小明", vote_date: "2024-01-13", party_name: "B黨", is_victor: "", area_data: { current_area: { area_name: "台北市第02選區" } } },
    ]));
  assertEquals(twins.action, "skip", "同一屆同名多筆不能猜");

  const statusOnly = decideByCec({ contribution_type: "candidacy", payload: { name: "蔡易餘", election_id: 2024, candidate_status: "confirmed" }, politician: { region: "嘉義縣" } }, WITH_TICKETS());
  assertEquals(statusOnly.action, "skip", "只改參選狀態沒有中選會可查的欄位");
});

Deno.test("人物出生年也能自動查", () => {
  assertEquals(decideByCec({ contribution_type: "politician", payload: { name: "蔡易餘", birth_year: 1981 }, politician: { region: "嘉義縣" } }, LIST()).action, "apply");
  const bad = decideByCec({ contribution_type: "politician", payload: { name: "蔡易餘", birth_year: 1975 }, politician: { region: "嘉義縣" } }, LIST());
  assertEquals(bad.action, "reject");
  assert(bad.action === "reject" && bad.reason.includes("1981"));
  assertEquals(decideByCec({ contribution_type: "policy", payload: { title: "x" }, politician: { region: "嘉義縣" } }, LIST()).action, "skip", "政見不在可查範圍");
});

Deno.test("同名同姓但縣市對不上：不碰（2026-09-17 乾跑實例）", () => {
  // 中選會的「李四川」是彰化縣花壇鄉花壇村村長（無黨籍、1960）；
  // 我們的李四川是台北市副市長（國民黨、新北市）。只比姓名的話會把正確的出生年退掉。
  const cec = normalizeCandidacies([
    { cand_name: "李四川", vote_date: "2018-11-24", theme_name: "107年村里長選舉", cand_birthyear: "1960", party_name: "無黨籍及未經政黨推薦", is_victor: "*", area_data: { current_area: { area_name: "彰化縣花壇鄉花壇村" } } },
  ]);
  const d = decideByCec({ contribution_type: "politician", payload: { name: "李四川", birth_year: 1958 }, politician: { region: "新北市" } }, cec);
  assertEquals(d.action, "skip");
  assert(d.action === "skip" && d.reason.includes("同名同姓"), d.action === "skip" ? d.reason : "");

  // 縣市對得上才會判斷（彰化縣的李四川就是同一個人）
  const same = decideByCec({ contribution_type: "politician", payload: { name: "李四川", birth_year: 1958 }, politician: { region: "彰化縣" } }, cec);
  assertEquals(same.action, "reject");
});

Deno.test("我們沒記縣市就不敢判", () => {
  const d = decideByCec({ contribution_type: "politician", payload: { name: "蔡易餘", birth_year: 1981 }, politician: { region: null } }, LIST());
  assertEquals(d.action, "skip");
});

// 掛上排程才會現形的死循環：被判 skip 的還是 pending，固定取最舊的一批＝永遠掃同一批
Deno.test("掃描視窗會輪流走過整個佇列，不會卡在最舊的那一批", () => {
  const total = 462, limit = 20;
  const seen = new Set<number>();
  for (let slot = 0; slot < 24; slot++) seen.add(scanOffset(total, limit, slot));
  // 24 輪（4 小時）之內每一筆都被掃過：最大的起點加上一批要蓋到尾巴
  assertEquals(Math.max(...seen) + limit >= total, true);
  assert(seen.size > 1);
  // 繞完一圈回到開頭，佇列前面新進來的不會被冷落
  assertEquals(scanOffset(total, limit, 0), scanOffset(total, limit, Math.ceil(total / limit)));
});

Deno.test("佇列比一批還短時從頭掃，尾巴不足一批時退回最後一批", () => {
  assertEquals(scanOffset(12, 20, 7), 0);
  assertEquals(scanOffset(462, 20, 23), 442); // 第 24 批只剩 2 筆 → 退回 442 起算
  assertEquals(scanOffset(0, 20, 3), 0);
});
