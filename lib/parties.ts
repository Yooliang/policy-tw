/**
 * 政黨（#346 第一階段，2026-10-06）。
 *
 * 資料庫有 parties（內政部政黨名冊一個政黨一列，id＝政黨編號；名冊查無此名稱的從 10001 起）與
 * party_aliases（資料裡的寫法 → 政黨）。人物的 party 欄還是自由文字，第一階段畫面照文字對照到政黨：
 * 跟 politicians.party_id 的觸發器是同一條規則（party_alias_key），測試盯兩邊一致。
 *
 * 無黨籍不是政黨（日本站同一個決定）：「無黨籍」「無黨籍及未經政黨推薦」「無」等寫法對照到 independent，沒有政黨頁。
 */

export interface PartyRow {
  id: number
  name: string
  short_name: string | null
  moi_no: number | null
  moi_name: string | null
  moi_status: string | null
  valid_from: string | null
  valid_to: string | null
  predecessor_id: number | null
  note: string | null
  evidence_url?: string | null
}

export interface PartyAliasRow {
  alias_key: string
  alias: string
  party_id: number | null
  kind: 'name' | 'short' | 'variant' | 'independent'
  note: string | null
}

export interface PartyRegistry {
  parties: PartyRow[]
  aliases: PartyAliasRow[]
}

/** 跟 SQL party_alias_key() 同一套：全形轉半形（NFKC）→ 去掉所有空白 → 「臺」當「台」；空的回 null */
export function partyAliasKey(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const key = text.normalize('NFKC').replace(/\s/g, '').replace(/臺/g, '台')
  return key === '' ? null : key
}

export type PartyMatch =
  | { kind: 'party'; partyId: number }
  | { kind: 'independent' }
  | { kind: 'unknown' }

export interface PartyIndex {
  byKey: Map<string, PartyAliasRow>
  byId: Map<number, PartyRow>
}

export function buildPartyIndex(registry: PartyRegistry): PartyIndex {
  return {
    byKey: new Map(registry.aliases.map((a) => [a.alias_key, a])),
    byId: new Map(registry.parties.map((p) => [p.id, p])),
  }
}

/** 政黨文字 → 哪個政黨（或無黨籍、或對照表沒有這種寫法） */
export function matchParty(text: string | null | undefined, index: PartyIndex): PartyMatch {
  const key = partyAliasKey(text)
  if (!key) return { kind: 'unknown' }
  const alias = index.byKey.get(key)
  if (!alias) return { kind: 'unknown' }
  if (alias.kind === 'independent' || alias.party_id === null) return { kind: 'independent' }
  return { kind: 'party', partyId: alias.party_id }
}

/** 這個政黨在資料裡會被寫成哪些字（正式名稱、簡稱、異寫；客戶端撈某黨的人用） */
export function partySpellings(partyId: number, registry: PartyRegistry): string[] {
  const out = new Set<string>()
  for (const a of registry.aliases) {
    if (a.party_id !== partyId) continue
    out.add(a.alias)
    // 「臺／台」兩種寫法都要查（PostgREST 的 in 比的是原字）
    out.add(a.alias.replace(/台/g, '臺'))
    out.add(a.alias.replace(/臺/g, '台'))
  }
  return [...out]
}

/** 畫面上的政黨狀態：只有不是「一般」的才講（名冊外的講查無） */
export function partyStatusText(p: Pick<PartyRow, 'moi_no' | 'moi_status'>): string | null {
  if (p.moi_no === null) return '內政部政黨名冊查無此名稱'
  if (!p.moi_status || p.moi_status === '一般') return null
  return `內政部登記狀態：${p.moi_status}`
}
