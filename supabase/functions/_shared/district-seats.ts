/**
 * 應選名額（#344，2026-10-06）：議員、代表各選舉區選幾席，由代理照選舉公告補進 election_districts.seats。
 *
 * 為什麼走任務不走同步：中選會選舉資料庫（db.cec.gov.tw）的投票概況只有「當選人數」（elected_num），
 * 沒有應選名額——同額不足、無人登記的選舉區，當選人數比名額少，拿它推會把分母算小
 * （election_districts 的表說明與 10-05 裁決都寫了不准推）。名額只在選委會的選舉公告（應選名額表）
 * 與選舉公報上，要人去讀，所以派任務：一個縣市、一種選舉一件（district_seats_missing），
 * 代理交 district_seats，同儕驗證通過才寫進去（seats_basis = cec_notice、seats_source = 公告網址）。
 *
 * 這裡只放純函式（選舉區寫法正規化、這筆交件會改哪幾列），落庫在 apply-contribution.ts。
 */
import { normalizeDistrict } from "./electoral-district.ts";

/** 要補名額的三種選舉：名額不是法律定死的（首長一人、立委席次寫在憲法），一區選幾席看公告 */
export const DISTRICT_SEAT_TYPES = ["縣市議員", "鄉鎮市民代表", "直轄市山地原住民區民代表"] as const;
export type DistrictSeatType = typeof DISTRICT_SEAT_TYPES[number];

/** 交件可以標的選舉區種類（election_districts.district_kind 的子集；不分區只有立委，這三種沒有） */
export const DISTRICT_SEAT_KINDS = ["district", "indigenous_plain", "indigenous_mountain"] as const;
export type DistrictSeatKind = typeof DISTRICT_SEAT_KINDS[number];

/** 一區最多幾席（名額 CHECK 只要 > 0；這個上限只是擋手誤，目前最多的是議員一區十幾席） */
export const MAX_SEATS_PER_DISTRICT = 60;
/** 一筆最多幾個選舉區（代表一個縣上百區：彰化縣 26 個鄉鎮、各分好幾區） */
export const MAX_DISTRICTS_PER_SUBMISSION = 200;

/**
 * 選舉區文字 → election_districts.sub_region 的寫法（跟 cec_candidates 同一套）：
 *   - 縣市議員：「第01選舉區」（normalizeDistrict：第4選區、第四選舉區、臺北市第4選舉區都收）
 *   - 鄉鎮市民代表、原住民區民代表：「<鄉鎮市區>第01選舉區」；一個鄉鎮只有一區的寫「<鄉鎮市區>選舉區」
 *     （中選會的寫法，例：蘭嶼鄉選舉區）。鄉鎮名的「臺」寫成「台」（跟中選會鄉鎮市長、代表名單同寫法）。
 * 認不出來回 null。
 */
export function normalizeSeatDistrict(electionType: string, text: unknown): string | null {
  if (typeof text !== "string") return null;
  const raw = text.replace(/[\s　]/g, "");
  if (!raw) return null;
  if (electionType === "縣市議員") return normalizeDistrict(raw)?.district ?? null;
  if (electionType !== "鄉鎮市民代表" && electionType !== "直轄市山地原住民區民代表") return null;
  const m = raw.match(/^(.+?(?:鄉|鎮|市|區))(第.+?選舉?區|選舉?區)$/);
  if (!m) return null;
  const town = m[1].replace(/臺/g, "台");
  if (m[2] === "選舉區" || m[2] === "選區") return `${town}選舉區`;
  const num = normalizeDistrict(m[2])?.district;
  return num ? `${town}${num}` : null;
}

/** 代表的選舉區屬於哪個鄉鎮市區（「麥寮鄉第04選舉區」→「麥寮鄉」）；議員回 null */
export function seatDistrictTown(sub: string): string | null {
  const m = sub.match(/^(.+?(?:鄉|鎮|市|區))(?:第[0-9]{2})?選舉區$/);
  return m && !/^第/.test(sub) ? m[1] : null;
}

export interface SeatInput {
  district: string;
  seats: number;
  kind?: DistrictSeatKind;
}

export interface ExistingDistrict {
  id: number | string;
  sub_region: string | null;
  village?: string | null;
  district_kind: string;
  seats: number | null;
  seats_basis: string | null;
  seats_source: string | null;
}

export interface SeatPlan {
  /** 既有的列要改名額 */
  updates: Array<{ id: number | string; district: string; old: Pick<ExistingDistrict, "seats" | "seats_basis" | "seats_source">; seats: number }>;
  /** 公告上有、我們沒有的選舉區 */
  inserts: Array<{ district: string; seats: number; kind: DistrictSeatKind }>;
  /** 名額已經一樣的 */
  unchanged: string[];
  /** 法律定死的名額（seats_basis=law）不讓交件覆蓋 */
  locked: string[];
  /** 交件標的種類跟既有的列不同（不改種類，只回報） */
  kind_mismatch: string[];
  /** 這個縣市這種選舉，交件之後仍然沒有名額的選舉區 */
  still_missing: string[];
}

/**
 * 這一筆交件會改哪幾列（純函式，可測）。districts 已經正規化過（normalizeSeatDistrict）。
 * 名額相同但出處不同的不改——第一個有出處的名額留著，別讓同一個數字的重交洗掉出處。
 */
export function planDistrictSeats(existing: readonly ExistingDistrict[], districts: readonly SeatInput[]): SeatPlan {
  const plan: SeatPlan = { updates: [], inserts: [], unchanged: [], locked: [], kind_mismatch: [], still_missing: [] };
  const bySub = new Map(existing.filter((e) => e.sub_region && !e.village).map((e) => [e.sub_region as string, e]));
  const given = new Set<string>();
  for (const d of districts) {
    given.add(d.district);
    const cur = bySub.get(d.district);
    if (!cur) {
      plan.inserts.push({ district: d.district, seats: d.seats, kind: d.kind ?? "district" });
      continue;
    }
    if (d.kind && d.kind !== cur.district_kind) plan.kind_mismatch.push(d.district);
    if (cur.seats_basis === "law") {
      if (cur.seats !== d.seats) plan.locked.push(d.district);
      else plan.unchanged.push(d.district);
      continue;
    }
    if (cur.seats === d.seats) {
      plan.unchanged.push(d.district);
      continue;
    }
    plan.updates.push({ id: cur.id, district: d.district, old: { seats: cur.seats, seats_basis: cur.seats_basis, seats_source: cur.seats_source }, seats: d.seats });
  }
  for (const [sub, e] of bySub) if (e.seats === null && !given.has(sub)) plan.still_missing.push(sub);
  plan.still_missing.sort();
  return plan;
}
