/**
 * 記憶體版 IdentityStore：單元測試與 dry-run 腳本用，沒有 I/O。
 * 可從 politicians + politician_elections 快照直接建出與 DB 回填相同的 key 集合。
 */

import { buildKeys, type ElectionFacet, type FacetSource, type IdentityKey, keyId, normText } from "./identity-normalize.ts";
import type { IdentityReview, IdentityStore, KeyHit, NamedPolitician } from "./politician-identity.ts";

export interface StoredKey extends KeyHit {
  source: string | null;
}

export interface PoliticianSnapshot extends FacetSource {
  id: string;
}

export interface ElectionSnapshot extends ElectionFacet {
  politician_id: string;
}

export interface MemoryIdentityStore extends IdentityStore {
  readonly keys: readonly StoredKey[];
  readonly politicians: readonly NamedPolitician[];
  readonly reviews: readonly IdentityReview[];
  /** 加入一位人物並回填其 key（等同 DB 的 identity_sync_keys） */
  addPolitician(p: PoliticianSnapshot, elections?: readonly ElectionFacet[]): void;
  addAlias(politicianId: string, oldName: string): void;
  /** 回傳一份排除指定人物（含其 key）的新 store，dry-run 用 */
  without(politicianIds: readonly string[]): MemoryIdentityStore;
}

export function createMemoryIdentityStore(
  initialPoliticians: readonly NamedPolitician[] = [],
  initialKeys: readonly StoredKey[] = [],
): MemoryIdentityStore {
  let keys: StoredKey[] = [...initialKeys];
  let politicians: NamedPolitician[] = [...initialPoliticians];
  let reviews: IdentityReview[] = [];

  const store: MemoryIdentityStore = {
    get keys() { return keys; },
    get politicians() { return politicians; },
    get reviews() { return reviews; },

    findAliasOwners(names) {
      const wanted = new Set(names);
      const ids = new Set(keys.filter((k) => k.key_type === "alias_name" && wanted.has(k.key_value)).map((k) => k.politician_id));
      return Promise.resolve(politicians.filter((p) => ids.has(p.id)));
    },
    findKeyHits(wantedKeys) {
      const wanted = new Map(wantedKeys.map((k) => [keyId(k), k]));
      return Promise.resolve(
        keys.filter((k) => wanted.has(keyId(k))).map((k) => ({ ...k, strength: wanted.get(keyId(k))!.strength })),
      );
    },
    findBirthKeys(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(keys.filter((k) => k.key_type === "birth" && wanted.has(k.politician_id)));
    },
    findByNames(names) {
      const wanted = new Set(names);
      return Promise.resolve(politicians.filter((p) => wanted.has(normText(p.name) ?? p.name)));
    },
    addKeys(politicianId, newKeys, source) {
      const existing = new Set(keys.filter((k) => k.politician_id === politicianId).map(keyId));
      const fresh = newKeys.filter((k) => !existing.has(keyId(k))).map((k) => ({ ...k, politician_id: politicianId, source }));
      keys = [...keys, ...fresh];
      return Promise.resolve();
    },
    addReview(review) {
      reviews = [...reviews, review];
      return Promise.resolve();
    },

    addPolitician(p, elections = []) {
      politicians = [...politicians, { id: p.id, name: p.name }];
      const derived: IdentityKey[] = buildKeys([p.name], p, elections);
      keys = [...keys, ...derived.map((k) => ({ ...k, politician_id: p.id, source: "derived" }))];
    },
    addAlias(politicianId, oldName) {
      const value = normText(oldName);
      if (value === null) return;
      keys = [...keys, { politician_id: politicianId, key_type: "alias_name", key_value: value, strength: 3, source: "manual" }];
    },
    without(ids) {
      const drop = new Set(ids);
      return createMemoryIdentityStore(
        politicians.filter((p) => !drop.has(p.id)),
        keys.filter((k) => !drop.has(k.politician_id)),
      );
    },
  };
  return store;
}

/** 從快照批次建 store（等同 migration 回填）。 */
export function storeFromSnapshot(
  politicians: readonly PoliticianSnapshot[],
  elections: readonly ElectionSnapshot[],
): MemoryIdentityStore {
  const byPolitician = new Map<string, ElectionFacet[]>();
  for (const e of elections) {
    byPolitician.set(e.politician_id, [...(byPolitician.get(e.politician_id) ?? []), e]);
  }
  const store = createMemoryIdentityStore();
  for (const p of politicians) store.addPolitician(p, byPolitician.get(p.id) ?? []);
  return store;
}
