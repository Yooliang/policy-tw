/**
 * 政治人物身份比對（確定性、不用 AI）。
 *
 * 用法（Edge Function）：
 *   const store = createSupabaseIdentityStore(supabase);
 *   const r = await resolvePolitician(store, candidate, { source: "ai-action" });
 *   if (r.decision === "matched")   → 用 r.politician_id（新面向 key 已寫回）
 *   if (r.decision === "ambiguous") → 不要 insert；已寫進 politician_identity_reviews
 *   if (r.decision === "new")       → insert politicians 後呼叫 store.addKeys(newId, r.keys, source)
 *
 * 判定規則（2026-09-11 拍板 + 兩點加嚴，見 README 段落「偏離規格」）：
 *   - 每個候選人物分數 = 命中 key 的 strength 總和
 *   - 只有一個候選：分數 ≥2 且至少一個中／強面向 → matched；否則 ambiguous
 *   - ≥2 個候選：最高分唯一且領先第二名 ≥2 → matched 最高分者；否則 ambiguous
 *   - 0 命中且無同名 → new；0 命中但有同名 → new + flag same_name_exists
 *   - 加嚴①：雙方都有出生年且不同 → 該候選直接剔除（vetoed）
 *   - 加嚴②：只靠弱面向（政黨、常見職位）湊到 2 分不算 matched
 */

import {
  buildCandidateKeys,
  type FacetSource,
  type IdentityKey,
  keyId,
  normText,
  STRENGTH,
} from "./identity-normalize.ts";

export const MATCH_MIN_SCORE = 2;
export const MATCH_MIN_GAP = 2;

export interface KeyHit {
  politician_id: string;
  key_type: IdentityKey["key_type"];
  key_value: string;
  strength: number;
}

export interface NamedPolitician {
  id: string;
  name: string;
}

export interface CandidateScore {
  politician_id: string;
  name: string | null;
  score: number;
  matched_keys: IdentityKey[];
  vetoed?: "birth_conflict";
}

export type Decision = "matched" | "new" | "ambiguous";

export interface Resolution {
  decision: Decision;
  politician_id?: string;
  matched_keys: IdentityKey[];
  candidates: CandidateScore[];
  /** 展開別名後用來比對的姓名集合 */
  names: string[];
  /** 候選資料自己產出的 key（new 時由呼叫端寫回新人物） */
  keys: IdentityKey[];
  flag?: "same_name_exists";
  reason: string;
}

export interface IdentityReview {
  candidate: unknown;
  candidates: CandidateScore[];
  reason: string;
  source: string | null;
}

/** 資料存取介面：Edge Function 用 Supabase 實作；測試與 dry-run 用記憶體實作。 */
export interface IdentityStore {
  /** alias_name key 命中 → 目前的本名 */
  findAliasOwners(names: readonly string[]): Promise<NamedPolitician[]>;
  findKeyHits(keys: readonly IdentityKey[]): Promise<KeyHit[]>;
  findBirthKeys(politicianIds: readonly string[]): Promise<KeyHit[]>;
  findByNames(names: readonly string[]): Promise<NamedPolitician[]>;
  addKeys(politicianId: string, keys: readonly IdentityKey[], source: string | null): Promise<void>;
  addReview(review: IdentityReview): Promise<void>;
}

export interface ResolveOptions {
  /** 寫進 politician_keys.source／reviews.source 的來源標記 */
  source?: string;
  /** false 時只判定、不寫回（dry-run） */
  persist?: boolean;
}

/** 純函式：給 key、命中、同名清單，算出判定。 */
export function decide(
  keys: readonly IdentityKey[],
  hits: readonly KeyHit[],
  sameName: readonly NamedPolitician[],
  names: readonly string[],
  candidateBirthKeys: readonly string[] = [],
  birthKeysOfHits: readonly KeyHit[] = [],
): Resolution {
  const nameOf = new Map(sameName.map((p) => [p.id, p.name]));
  const byPolitician = new Map<string, IdentityKey[]>();
  for (const h of hits) {
    const list = byPolitician.get(h.politician_id) ?? [];
    byPolitician.set(h.politician_id, [...list, { key_type: h.key_type, key_value: h.key_value, strength: h.strength }]);
  }

  const candidateBirth = new Set(candidateBirthKeys);
  const scored: CandidateScore[] = [...byPolitician.entries()].map(([politician_id, matched]) => {
    const uniq = [...new Map(matched.map((k) => [keyId(k), k])).values()];
    const ownBirth = birthKeysOfHits.filter((b) => b.politician_id === politician_id).map((b) => b.key_value);
    const conflict = candidateBirth.size > 0 && ownBirth.length > 0 && !ownBirth.some((b) => candidateBirth.has(b));
    return {
      politician_id,
      name: nameOf.get(politician_id) ?? null,
      score: uniq.reduce((s, k) => s + k.strength, 0),
      matched_keys: uniq,
      ...(conflict ? { vetoed: "birth_conflict" as const } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  const live = scored.filter((c) => !c.vetoed);
  const base = { candidates: scored, names: [...names], keys: [...keys] };

  if (live.length === 0) {
    if (sameName.length === 0) {
      return { ...base, decision: "new", matched_keys: [], reason: "無任何面向命中、無同名人物" };
    }
    return {
      ...base,
      decision: "new",
      matched_keys: [],
      flag: "same_name_exists",
      reason: `無面向命中，但已有 ${sameName.length} 位同名人物（可能三面向同時換了，請人工確認）`,
    };
  }

  const top = live[0];
  const hasMediumOrStrong = top.matched_keys.some((k) => k.strength >= STRENGTH.MEDIUM);

  if (live.length === 1) {
    if (top.score >= MATCH_MIN_SCORE && hasMediumOrStrong) {
      return { ...base, decision: "matched", politician_id: top.politician_id, matched_keys: top.matched_keys, reason: `唯一候選，分數 ${top.score}` };
    }
    return { ...base, decision: "ambiguous", matched_keys: top.matched_keys, reason: `唯一候選但只有弱面向命中（分數 ${top.score}）` };
  }

  const second = live[1];
  if (top.score - second.score >= MATCH_MIN_GAP && hasMediumOrStrong) {
    return { ...base, decision: "matched", politician_id: top.politician_id, matched_keys: top.matched_keys, reason: `最高分 ${top.score} 領先第二名 ${second.score}` };
  }
  return { ...base, decision: "ambiguous", matched_keys: top.matched_keys, reason: `${live.length} 位候選分數相近（${top.score} vs ${second.score}）` };
}

async function expandNames(store: IdentityStore, name: string): Promise<string[]> {
  const base = normText(name);
  if (base === null) return [];
  const owners = await store.findAliasOwners([base]);
  const names = new Set<string>([base]);
  for (const o of owners) {
    const n = normText(o.name);
    if (n !== null) names.add(n);
  }
  return [...names];
}

export async function resolvePolitician(
  store: IdentityStore,
  candidate: FacetSource,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const source = options.source ?? null;
  const persist = options.persist ?? true;

  const names = await expandNames(store, candidate.name);
  if (names.length === 0) {
    throw new Error("resolvePolitician: candidate.name 為空");
  }
  const keys = buildCandidateKeys(candidate, names);
  const [hits, sameName] = await Promise.all([
    store.findKeyHits(keys),
    store.findByNames(names),
  ]);
  const hitIds = [...new Set(hits.map((h) => h.politician_id))];
  const birthKeys = hitIds.length > 0 ? await store.findBirthKeys(hitIds) : [];
  const candidateBirth = keys.filter((k) => k.key_type === "birth").map((k) => k.key_value);

  const resolution = decide(keys, hits, sameName, names, candidateBirth, birthKeys);

  if (persist && resolution.decision === "matched" && resolution.politician_id) {
    const known = new Set(resolution.matched_keys.map(keyId));
    const fresh = keys.filter((k) => !known.has(keyId(k)));
    if (fresh.length > 0) await store.addKeys(resolution.politician_id, fresh, source);
  }
  if (persist && resolution.decision === "ambiguous") {
    await store.addReview({ candidate, candidates: resolution.candidates, reason: resolution.reason, source });
  }
  return resolution;
}

// ------------------------------------------------------------
// Supabase 實作
// ------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

function throwIf(error: { message: string } | null, where: string): void {
  if (error) throw new Error(`${where}: ${error.message}`);
}

export function createSupabaseIdentityStore(supabase: SupabaseLike): IdentityStore {
  return {
    async findAliasOwners(names) {
      if (names.length === 0) return [];
      const { data, error } = await supabase
        .from("politician_keys")
        .select("politician_id, politicians!inner(id, name)")
        .eq("key_type", "alias_name")
        .in("key_value", [...names]);
      throwIf(error, "politician_keys alias lookup");
      // deno-lint-ignore no-explicit-any
      return (data ?? []).map((r: any) => ({ id: r.politicians.id, name: r.politicians.name }));
    },

    async findKeyHits(keys) {
      if (keys.length === 0) return [];
      const wanted = new Map(keys.map((k) => [keyId(k), k]));
      const { data, error } = await supabase
        .from("politician_keys")
        .select("politician_id, key_type, key_value, strength")
        .in("key_value", keys.map((k) => k.key_value));
      throwIf(error, "politician_keys hit lookup");
      return (data ?? [])
        // deno-lint-ignore no-explicit-any
        .filter((r: any) => wanted.has(keyId(r)))
        // deno-lint-ignore no-explicit-any
        .map((r: any) => ({ ...r, strength: wanted.get(keyId(r))!.strength }));
    },

    async findBirthKeys(politicianIds) {
      if (politicianIds.length === 0) return [];
      const { data, error } = await supabase
        .from("politician_keys")
        .select("politician_id, key_type, key_value, strength")
        .eq("key_type", "birth")
        .in("politician_id", [...politicianIds]);
      throwIf(error, "politician_keys birth lookup");
      return data ?? [];
    },

    async findByNames(names) {
      if (names.length === 0) return [];
      const { data, error } = await supabase.from("politicians").select("id, name").in("name", [...names]);
      throwIf(error, "politicians name lookup");
      return data ?? [];
    },

    async addKeys(politicianId, keys, source) {
      if (keys.length === 0) return;
      const rows = keys.map((k) => ({ politician_id: politicianId, ...k, source }));
      const { error } = await supabase
        .from("politician_keys")
        .upsert(rows, { onConflict: "politician_id,key_type,key_value", ignoreDuplicates: true });
      throwIf(error, "politician_keys insert");
    },

    async addReview(review) {
      const { error } = await supabase.from("politician_identity_reviews").insert({
        candidate: review.candidate,
        candidates: review.candidates,
        reason: review.reason,
        source: review.source,
      });
      throwIf(error, "politician_identity_reviews insert");
    },
  };
}

/**
 * 只有姓名時的嚴格查找（update_politician / add_policy 這類路徑）：
 * 0 筆 → null；1 筆 → 該筆；≥2 筆 → 丟錯要求提供 politician_id（不再靜默當查無）。
 */
export async function findPoliticianByNameStrict(
  supabase: SupabaseLike,
  name: string,
): Promise<{ id: string } | null> {
  const normalized = normText(name);
  if (normalized === null) return null;
  const { data, error } = await supabase
    .from("politicians")
    .select("id, name, region, party")
    .eq("name", normalized)
    .limit(2);
  throwIf(error, "politicians lookup");
  const rows = data ?? [];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`同名政治人物不只一位（${normalized}），請改用 politician_id 指定`);
  }
  return { id: rows[0].id };
}
