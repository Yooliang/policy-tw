/**
 * 縣市議員選區名冊查詢（2026-09-28，交件時自動統一選區寫法，第二步）。
 *
 * 交件時（contribute-handler.ts）用這支確認 candidacy 的 electoral_district（已經被
 * electoral-district.ts 的 normalizeCandidacyDistrictField 統一寫法）在該屆、該縣市是不是
 * 真的存在的選區。資料來源是 electoral_district_areas（見 docs/DISTRICT-REGISTRY-2026.md），
 * 那張表只收一般地理選區；原住民保留議席另外查 electoral-district.ts 的
 * COUNCIL_ABORIGINAL_DISTRICTS 常數（不對應鄉鎮，這張表本來就不收）。
 *
 * 名冊裡沒有該縣市（例如新竹縣 2026，官方還沒公告逐里名單，migration 沒寫這個縣市）、
 * 或查詢本身出錯，都不擋——這是「統一寫法」的輔助檢查，不是資料驗證的守門，查不到名冊
 * 不代表選區不存在，錯誤的代價應該是「放行」而不是「擋住整批交件」。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

import { COUNCIL_ABORIGINAL_DISTRICTS, isCouncilAboriginalDistrict } from "./electoral-district.ts";

export type DistrictRegistryStatus = "ok" | "unknown" | "no_registry";

export interface DistrictRegistryResult {
  status: DistrictRegistryStatus;
  /** status==="unknown" 時，該縣市名冊裡實際有的選區（含原住民保留議席），列給代理對照 */
  validDistricts?: string[];
}

/** 記憶體快取幾分鐘：同一個 electionId 短時間內會被大量交件重複查，不用每筆都打資料庫 */
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  expiresAt: number;
  byRegion: Map<string, Set<string>>;
}
const cacheByElection = new Map<number, CacheEntry>();

/** 測試專用：清掉快取，避免前一個測試塞的資料影響下一個 */
export function resetDistrictRegistryCache(): void {
  cacheByElection.clear();
}

async function loadRegistry(supabase: SupabaseLike, electionId: number): Promise<Map<string, Set<string>>> {
  const cached = cacheByElection.get(electionId);
  if (cached && cached.expiresAt > Date.now()) return cached.byRegion;
  // query-bounds: ok — 全國 21 個縣市 distinct (region, electoral_district)，實際頂多兩三百筆，遠低於 1000
  const { data, error } = await supabase
    .from("electoral_district_areas")
    .select("region, electoral_district")
    .eq("election_id", electionId)
    .limit(1000);
  if (error) throw new Error(`electoral_district_areas lookup: ${error.message}`);
  const byRegion = new Map<string, Set<string>>();
  for (const row of (data ?? []) as Array<{ region: string; electoral_district: string }>) {
    const set = byRegion.get(row.region) ?? new Set<string>();
    set.add(row.electoral_district);
    byRegion.set(row.region, set);
  }
  cacheByElection.set(electionId, { expiresAt: Date.now() + CACHE_TTL_MS, byRegion });
  return byRegion;
}

/**
 * 檢查 election_id／region／district（已正規化成「第NN選舉區」）在名冊裡站不站得住腳。
 * - 查詢出錯，或名冊裡根本沒有這個縣市（那個縣市在這屆 electoral_district_areas 一筆都沒有）→ "no_registry"（不擋）
 * - 名冊裡有這個縣市，選區號碼也在裡面，或是該縣市的原住民保留議席 → "ok"
 * - 名冊裡有這個縣市，但選區號碼兩邊都對不上 → "unknown"
 */
export async function checkElectoralDistrict(
  supabase: SupabaseLike,
  electionId: number,
  region: string,
  district: string,
): Promise<DistrictRegistryResult> {
  let byRegion: Map<string, Set<string>>;
  try {
    byRegion = await loadRegistry(supabase, electionId);
  } catch {
    return { status: "no_registry" };
  }
  const set = byRegion.get(region);
  if (!set || set.size === 0) return { status: "no_registry" };
  if (set.has(district) || isCouncilAboriginalDistrict(region, district)) return { status: "ok" };
  const aboriginal = COUNCIL_ABORIGINAL_DISTRICTS[region] ?? [];
  return { status: "unknown", validDistricts: [...new Set([...set, ...aboriginal])].sort() };
}
