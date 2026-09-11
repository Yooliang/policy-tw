/**
 * 政治人物身份比對：面向 key 的正規化與產生（純函式，無 I/O）。
 *
 * 這裡的規則與 migration 內的 SQL 函式（identity_norm_text / identity_norm_party /
 * identity_norm_position / identity_norm_election_type / identity_build_keys）一一對應。
 * 兩邊共用同一份測試案例 `fixtures/normalization-cases.json`：
 *   - Deno test 驗 TS 版
 *   - scripts/verify-identity-norm.sql 驗 SQL 版
 * 改任何一邊的規則，另一邊與案例檔要同步。
 */

export type KeyType = "birth" | "region_type" | "position" | "party" | "alias_name" | "cec_cand_id";

export interface IdentityKey {
  key_type: KeyType;
  key_value: string;
  strength: number;
}

export const STRENGTH = {
  STRONG: 3,
  MEDIUM: 2,
  WEAK: 1,
} as const;

/** 常見到幾乎沒有辨識力的職位類別：同名同類的人太多，只算弱面向。 */
const LOW_INFO_POSITIONS: ReadonlySet<string> = new Set([
  "縣市議員",
  "鄉鎮市長",
  "鄉鎮市民代表",
  "直轄市山地原住民區民代表",
  "直轄市山地原住民區長",
  "村里長",
]);

const KNOWN_ELECTION_TYPES: ReadonlySet<string> = new Set([
  "總統副總統",
  "立法委員",
  "縣市長",
  "縣市議員",
  "鄉鎮市長",
  "直轄市山地原住民區長",
  "鄉鎮市民代表",
  "直轄市山地原住民區民代表",
  "村里長",
]);

const PARTY_ALIASES: Readonly<Record<string, string>> = {
  "國民黨": "中國國民黨",
  "中國國民黨": "中國國民黨",
  "民進黨": "民主進步黨",
  "民主進步黨": "民主進步黨",
  "民眾黨": "台灣民眾黨",
  "台灣民眾黨": "台灣民眾黨",
  "無": "無黨籍",
  "無黨籍": "無黨籍",
  "無黨": "無黨籍",
  "無黨籍及未經政黨推薦": "無黨籍",
  "無黨籍及未經政黨推薦者": "無黨籍",
  "未經政黨推薦": "無黨籍",
};

const EMPTY_MARKERS: ReadonlySet<string> = new Set(["", "無", "未知", "未定", "待定", "null", "undefined", "-"]);

/** trim → 全形轉半形（NFKC）→ 去所有空白 → 臺→台。空值回 null。 */
export function normText(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).normalize("NFKC").replace(/\s+/g, "").replace(/臺/g, "台");
  return EMPTY_MARKERS.has(s) ? null : s;
}

export function normParty(input: string | null | undefined): string | null {
  const s = normText(input);
  if (s === null) return null;
  return PARTY_ALIASES[s] ?? s;
}

/**
 * 把職位/現職字串收斂成類別。認不出類別時回傳正規化後的原字串（本身仍是可比對的面向）。
 * 規則順序有意義：先排除「副」、先看「代表」再看「區長／市長」。
 */
export function normPosition(input: string | null | undefined): string | null {
  const s = normText(input);
  if (s === null) return null;
  if (s.includes("總統")) return "總統副總統";
  if (s.includes("立法委員") || s.includes("立委") || s.includes("立法院")) return "立法委員";
  if (s.includes("副市長") || s.includes("副縣長")) return "副縣市長";
  if (s.includes("議員") || s.includes("議長")) return "縣市議員";
  if (s.includes("代表")) {
    return s.includes("山地原住民區") ? "直轄市山地原住民區民代表" : "鄉鎮市民代表";
  }
  if (s.includes("山地原住民區長")) return "直轄市山地原住民區長";
  if (s.includes("鄉鎮市長") || s.includes("鄉長") || s.includes("鎮長")) return "鄉鎮市長";
  if (s.includes("縣市長") || s.includes("縣長") || s.includes("市長")) return "縣市長";
  if (s.includes("村里長") || s.includes("村長") || s.includes("里長")) return "村里長";
  return s;
}

/** 選舉類型：已是九種之一就原樣回傳，否則用職位規則推。 */
export function normElectionType(input: string | null | undefined): string | null {
  const s = normText(input);
  if (s === null) return null;
  if (KNOWN_ELECTION_TYPES.has(s)) return s;
  const guessed = normPosition(s);
  return guessed !== null && KNOWN_ELECTION_TYPES.has(guessed) ? guessed : null;
}

export function normRegion(input: string | null | undefined): string | null {
  const s = normText(input);
  if (s === null || s === "全國") return null;
  return s;
}

export function positionStrength(category: string): number {
  return LOW_INFO_POSITIONS.has(category) ? STRENGTH.WEAK : STRENGTH.MEDIUM;
}

/** 一個人（或一筆候選資料）可貢獻面向的原始欄位。 */
export interface FacetSource {
  name: string;
  birth_year?: number | string | null;
  party?: string | null;
  region?: string | null;
  election_type?: string | null;
  position?: string | null;
  current_position?: string | null;
  /**
   * 中選會 cand_id（強 3）。cand_id 每一場選舉重新編號，不是跨屆人物識別碼，
   * 所以 key value 是 `{theme_id}#{cand_id}`，兩者都要有才產 key；只用來讓同一場選舉重複匯入冪等。
   */
  cec_cand_id?: number | string | null;
  cec_theme_id?: string | null;
}

/** 參選紀錄：region 是已解析成縣市名的字串（DB 端由 regions.region 取得）。 */
export interface ElectionFacet {
  region?: string | null;
  election_type?: string | null;
  position?: string | null;
}

function parseBirthYear(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 1850 && n <= 2100 ? n : null;
}

function dedupeKeys(keys: IdentityKey[]): IdentityKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = `${k.key_type}#${k.key_value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * 依一組姓名（本名＋別名展開）與面向欄位，產生全部 key。
 * 與 SQL 的 identity_build_keys 對齊：politicians 欄位 + 每筆 politician_elections 各產一組。
 */
export function buildKeys(
  names: readonly string[],
  base: Omit<FacetSource, "name">,
  elections: readonly ElectionFacet[] = [],
): IdentityKey[] {
  const normalizedNames = [...new Set(names.map((n) => normText(n)).filter((n): n is string => n !== null))];
  const keys: IdentityKey[] = [];

  const birth = parseBirthYear(base.birth_year);
  const party = normParty(base.party);
  const baseRegion = normRegion(base.region);
  const baseType = normElectionType(base.election_type);
  const positions = [normPosition(base.current_position), normPosition(base.position)]
    .filter((p): p is string => p !== null);

  const cecId = normText(base.cec_cand_id === null || base.cec_cand_id === undefined ? null : String(base.cec_cand_id));
  const cecTheme = normText(base.cec_theme_id);
  if (cecId !== null && cecTheme !== null && normalizedNames.length > 0) {
    keys.push({ key_type: "cec_cand_id", key_value: `${cecTheme}#${cecId}`, strength: STRENGTH.STRONG });
  }

  for (const name of normalizedNames) {
    if (birth !== null) keys.push({ key_type: "birth", key_value: `${name}|${birth}`, strength: STRENGTH.STRONG });
    if (party !== null) keys.push({ key_type: "party", key_value: `${name}|${party}`, strength: STRENGTH.WEAK });
    if (baseRegion !== null && baseType !== null) {
      keys.push({ key_type: "region_type", key_value: `${name}|${baseRegion}|${baseType}`, strength: STRENGTH.MEDIUM });
    }
    for (const pos of positions) {
      keys.push({ key_type: "position", key_value: `${name}|${pos}`, strength: positionStrength(pos) });
    }
    for (const e of elections) {
      const region = normRegion(e.region) ?? baseRegion;
      const type = normElectionType(e.election_type) ?? normElectionType(e.position);
      if (region !== null && type !== null) {
        keys.push({ key_type: "region_type", key_value: `${name}|${region}|${type}`, strength: STRENGTH.MEDIUM });
      }
      const pos = normPosition(e.position);
      if (pos !== null) keys.push({ key_type: "position", key_value: `${name}|${pos}`, strength: positionStrength(pos) });
    }
  }
  return dedupeKeys(keys);
}

/** 候選資料（AI／匯入 payload）的 key；election_type 沒給時由 position 推。 */
export function buildCandidateKeys(candidate: FacetSource, names: readonly string[] = [candidate.name]): IdentityKey[] {
  const electionType = candidate.election_type ?? normElectionType(candidate.position);
  return buildKeys(names, { ...candidate, election_type: electionType });
}

export function keyId(k: Pick<IdentityKey, "key_type" | "key_value">): string {
  return `${k.key_type}#${k.key_value}`;
}
