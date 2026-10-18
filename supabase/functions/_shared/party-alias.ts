/**
 * 政黨寫法 → 政黨（#346）。資料庫的 party_aliases 是唯一的對照表；這裡只放比對用的鍵與「兩個寫法是不是同一個政黨」。
 *
 * 比對規則跟 SQL party_alias_key()、前端 lib/parties.ts 的 partyAliasKey、腳本 scripts/fetch-moi-parties.py 同一套：
 * 全形轉半形（NFKC）→ 去掉所有空白 → 「臺」當「台」（party-followups.test.ts 盯 TS 兩邊與 SQL 一致）。
 * Edge Function 不能 import 前端的 lib/，所以這裡另放一份。
 */

export function partyAliasKey(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const key = text.normalize("NFKC").replace(/\s/g, "").replace(/臺/g, "台");
  return key === "" ? null : key;
}

/** party_aliases 一列（只取比對用得到的欄位） */
export interface PartyAliasRow { alias_key: string; party_id: number | null; kind: string }

/** 一個寫法對到什麼：某個政黨、無黨籍那一族、或對照表裡沒有（不猜） */
export type PartyResolution = { kind: "party"; partyId: number } | { kind: "independent" } | { kind: "unknown" };

export type PartyResolver = (text: string | null | undefined) => PartyResolution;

export function partyResolver(rows: readonly PartyAliasRow[]): PartyResolver {
  const byKey = new Map(rows.map((r) => [r.alias_key, r]));
  return (text) => {
    const key = partyAliasKey(text);
    const row = key ? byKey.get(key) : undefined;
    if (!row) return { kind: "unknown" };
    if (row.kind === "independent" || row.party_id === null) return { kind: "independent" };
    return { kind: "party", partyId: Number(row.party_id) };
  };
}

/** 兩個寫法是不是同一個政黨（無黨籍算同一族）；任一邊對照表裡沒有就回 null（判斷不了） */
export function sameParty(a: PartyResolution, b: PartyResolution): boolean | null {
  if (a.kind === "unknown" || b.kind === "unknown") return null;
  if (a.kind === "independent" || b.kind === "independent") return a.kind === b.kind;
  return a.partyId === b.partyId;
}

/**
 * party_aliases 裡 kind＝independent 的寫法（無黨籍那一族）的比對鍵。純函式顯示用（貢獻摘要、履歷），不碰資料庫；
 * 跟 20261006073461_parties.sql 的種子逐一相同（party-alias-parity.test.ts 盯）。新增無黨籍寫法時兩邊一起加。
 */
export const INDEPENDENT_ALIAS_KEYS: ReadonlySet<string> = new Set([
  "未經政黨推薦", "無", "無黨", "無黨籍", "無黨籍及未經政黨推薦", "無黨籍及未經政黨推薦者",
]);

/** 交件的 party 寫法 → 給人看的政黨名：無黨籍那一族統一顯示「無黨籍」，其他照原字（不猜）；空的回空字串 */
export function partyDisplayName(text: string | null | undefined): string {
  const key = partyAliasKey(text);
  if (!key) return "";
  return INDEPENDENT_ALIAS_KEYS.has(key) ? "無黨籍" : (text ?? "").trim();
}
