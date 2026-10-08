/**
 * 名冊逐位吻合的 candidacy 大批次（2026-10-08，維護者裁示 B 案：一次交件上限 20 → 150，只放寬這一種）。
 *
 * 超過 MAX_BATCH（20）筆的批次，結構上已經由 contribution-schema 限定成「整批都是 candidacy、source_urls 引用中選會登記名冊 PDF」；
 * 這裡再查名冊資料表（cec_registrations，_shared/cec-registrations.ts）：每一筆都要跟名冊那一列的姓名、縣市、鄉鎮市區、村里、政黨、選舉區對得上
 * （同一個 checkBatch，roster_batch 的系統票用的就是它）才收。有一筆對不上、或引用的名冊沒有解析成資料表，整批未收（不算被拒），
 * 訊息逐筆寫原因——請對不上的那幾筆拆出去用 20 筆以內的批次交，讓驗證者逐筆看。
 *
 * #455 審查補的四件事：
 *  1. 只撈這一批需要的範圍（縣市＋這批出現的鄉鎮市區），不把村里長 14,100 列整份拉回來（loadRegistrationRowsScoped）。
 *  2. 同一批裡同一位候選人重複（姓名＋縣市＋鄉鎮＋村里＋選舉區＋政黨都相同）→ 整批 400：checkBatch 只問「名冊上有沒有這個人」，
 *     不會消耗名冊那一列，150 筆複製貼上會整批通過。名冊上本來就有同名同地同黨的兩位時，容許重複到那個人數。
 *  3. 沒有中選會名冊網址的項目不能靜默略過，記成錯誤（獨立呼叫這支守門時也守得住）。
 *  4. 查詢本身出錯（資料表壞掉、網路）不放行：整批當作「名冊無法核對」。
 */
import { ALL_REGIONS } from "./cec-city-codes.ts";
import { CEC_ROSTER_URL_RE, checkBatch, placeMatches, rosterNorm, type BatchItem, type RosterRow } from "./cec-roster.ts";
import { loadRegistrationRowsScoped, type RosterScope } from "./cec-registrations.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export interface RosterBatchItem { contribution_type: string; payload: unknown; source_urls: readonly string[] }
export type RosterBatchVerdict =
  | { ok: true }
  | { ok: false; error: "roster_batch_unavailable" | "roster_batch_mismatch" | "roster_batch_duplicate"; message: string; errors: Array<{ index: number; path: string; message: string }> };
type Problem = { index: number; path: string; message: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const countyOf = (region: string | null) => {
  const r = rosterNorm(region);
  return ALL_REGIONS.find((c) => r.startsWith(c)) ?? r;
};
const townOf = (item: BatchItem) => rosterNorm(item.sub_region) || (item.region ? rosterNorm(item.region).slice(countyOf(item.region).length) : "");

/** 這批在每個縣市要撈哪些鄉鎮市區（有一筆沒給鄉鎮，那個縣市就整個撈） */
export function scopesOf(items: readonly BatchItem[]): RosterScope[] {
  const byCounty = new Map<string, Set<string> | null>();
  for (const it of items) {
    const county = countyOf(it.region);
    const town = townOf(it);
    if (!byCounty.has(county)) byCounty.set(county, new Set());
    const cur = byCounty.get(county);
    if (cur === null) continue;
    if (!town) byCounty.set(county, null); else cur!.add(town);
  }
  return [...byCounty].map(([region, towns]) => ({ region, towns: towns ? [...towns] : null }));
}

/** 名冊上跟這一筆同姓名、同縣市、地名與選舉區對得上的有幾位（容許重複的上限） */
function multiplicity(rows: readonly RosterRow[], item: BatchItem): number {
  const county = countyOf(item.region);
  const town = townOf(item);
  const village = rosterNorm(item.village);
  return rows.filter((r) =>
    rosterNorm(r.name) === rosterNorm(item.name) &&
    (!item.region || !r.region || r.region === county) &&
    (!(town || village) || !r.place || placeMatches(rosterNorm(r.place), town, village)) &&
    (!item.district || !r.district || r.district === item.district)
  ).length;
}

export async function rosterBatchProblems(supabase: Client, items: readonly RosterBatchItem[]): Promise<RosterBatchVerdict> {
  const groups = new Map<string, Array<{ index: number; item: BatchItem }>>();
  const errors: Problem[] = [];
  items.forEach((it, index) => {
    const p = (it.payload ?? {}) as Record<string, unknown>;
    const url = it.source_urls.find((u) => CEC_ROSTER_URL_RE.test(u));
    if (!url) {
      errors.push({ index, path: "source_urls", message: "缺少中選會登記名冊網址（web.cec.gov.tw/api/file/….pdf）；超過 20 筆的批次每一筆都要引用名冊" });
      return;
    }
    const list = groups.get(url) ?? [];
    list.push({
      index,
      item: {
        id: String(index), name: str(p.name) ?? "", party: str(p.party), region: str(p.region),
        district: str(p.electoral_district), sub_region: str(p.sub_region), village: str(p.village),
      },
    });
    groups.set(url, list);
  });
  let unavailable = false;
  let duplicate = false;
  for (const [url, list] of groups) {
    let rows: RosterRow[] | null = null;
    try {
      rows = await loadRegistrationRowsScoped(supabase, url, scopesOf(list.map((g) => g.item)));
    } catch (e) {
      console.error("roster batch gate: 查名冊資料表失敗：", e instanceof Error ? e.message : String(e));
    }
    if (!rows) {
      unavailable = true;
      for (const g of list) errors.push({ index: g.index, path: "source_urls", message: `這份名冊（${url}）系統沒有解析成資料表或暫時查不到，無法逐位核對；超過 20 筆請拆成 20 筆以內的批次` });
      continue;
    }
    const check = checkBatch(rows, list.map((g) => g.item));
    const failed = new Set(check.failed.map((f) => Number(f.id)));
    for (const f of check.failed) errors.push({ index: Number(f.id), path: "payload", message: `${f.name}：${f.reason}` });
    // 同一批裡重複：同一個（姓名、縣市、鄉鎮、村里、選舉區、政黨）出現的次數超過名冊上對得上的人數
    const seen = new Map<string, number[]>();
    for (const g of list) {
      if (failed.has(g.index)) continue;
      const i = g.item;
      const k = [rosterNorm(i.name), countyOf(i.region), townOf(i), rosterNorm(i.village), i.district ?? "", rosterNorm(i.party)].join("|");
      seen.set(k, [...(seen.get(k) ?? []), g.index]);
    }
    for (const indexes of seen.values()) {
      if (indexes.length < 2) continue;
      const item = list.find((g) => g.index === indexes[0])!.item;
      const allowed = Math.max(1, multiplicity(rows, item));
      for (const index of indexes.slice(allowed)) {
        duplicate = true;
        errors.push({ index, path: "payload", message: `${item.name}：同一批裡重複（跟第 ${indexes[0]} 筆是同一位；名冊上對得上的只有 ${allowed} 位）` });
      }
    }
  }
  if (errors.length === 0) return { ok: true };
  errors.sort((a, b) => a.index - b.index);
  if (unavailable) {
    return { ok: false, error: "roster_batch_unavailable", message: "超過 20 筆的批次，每一筆都要能跟中選會登記名冊逐位核對；有引用的名冊系統沒有解析成資料表（或暫時查不到）。整批未收（不算被拒）", errors };
  }
  if (duplicate && errors.every((e) => e.message.includes("同一批裡重複"))) {
    return { ok: false, error: "roster_batch_duplicate", message: `這批有 ${errors.length} 筆跟同一批裡的另一筆是同一位候選人（姓名、縣市、鄉鎮、村里、選舉區、政黨都相同）。整批未收（不算被拒）——每位候選人只交一筆`, errors };
  }
  return { ok: false, error: "roster_batch_mismatch", message: `超過 20 筆的批次，每一筆都要跟名冊的姓名、縣市、鄉鎮市區、村里、政黨、選舉區逐位吻合，而且同一批不能重複；這 ${errors.length} 筆有問題。整批未收（不算被拒）——請把對不上的拆出去用 20 筆以內的批次交，或改成名冊上的寫法`, errors };
}
