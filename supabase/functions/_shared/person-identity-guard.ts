/**
 * 幽靈人物守門（2026-10-18，劉雁祿：早期匯入多建的錯人物，政見／結果／改名都往它身上掛）。
 *  - 交件端 identityNameProblems：candidacy／politician 帶 politician_id 又帶 name，兩者不是同一人 → 整批 400，不算被拒。
 *    落庫端的同一個比法在 apply-contribution.ts 的 nameMismatchMessage（given／resolved 兩條分支共用）。
 *  - renameCollision：correction 改 politicians.name，新名字已經是同屆、同選舉類型、同縣市另一位參選人的名字或別名
 *    → 交件端 400（改交 merge_politician），落庫端（等票期間可能有人先建了）再查一次，撞到 disputed。
 */

import { chunksOf } from "./in-chunks.ts";
import { normText } from "./identity-normalize.ts";
import { normalizeCorrection } from "./correction.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const NAME_MISMATCH_HINT = "名字不一樣的話，可能是同一人重複建檔，請改用 merge_politician，或用 removal 移除錯的那筆。這不算被拒。";

export interface IdentityItem { contribution_type: string; payload?: unknown }
export interface IdentityProblem { index: number; politician_id: string; name: string; politician_name: string; message: string }

const IDENTITY_TYPES = new Set(["candidacy", "politician"]);

/** 對方的 nameMismatchMessage（別名／已合併保留者的判斷）由呼叫端注入，避免交件端與落庫端各寫一份 */
export async function identityNameProblems(
  supabase: SupabaseLike,
  items: readonly IdentityItem[],
  mismatch: (target: { id: string; name: string }, keeperId: string, claimed: string, label: string) => Promise<string | null>,
  keeperOf: (id: string) => Promise<string>,
): Promise<IdentityProblem[]> {
  const wanted: Array<{ index: number; id: string; name: string }> = [];
  items.forEach((item, index) => {
    if (!IDENTITY_TYPES.has(item.contribution_type)) return;
    const p = (item.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.politician_id === "string" ? p.politician_id.trim() : "";
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (id && name) wanted.push({ index, id, name });
  });
  if (wanted.length === 0) return [];
  const names = new Map<string, string>();
  for (const chunk of chunksOf([...new Set(wanted.map((w) => w.id))])) {
    const { data, error } = await supabase.from("politicians").select("id, name").in("id", chunk).limit(chunk.length);
    if (error) throw new Error(`politicians identity lookup: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(r.id, r.name ?? "");
  }
  const problems: IdentityProblem[] = [];
  for (const w of wanted) {
    const current = names.get(w.id);
    if (!current) continue; // 不存在的 id 由落庫端處理；庫裡沒有名字的列沒東西可比
    if (normText(w.name) === normText(current)) continue;
    const message = await mismatch({ id: w.id, name: current }, await keeperOf(w.id), w.name, `payload.politician_id ${w.id}`);
    if (message) problems.push({ index: w.index, politician_id: w.id, name: w.name, politician_name: current, message });
  }
  return problems;
}

export interface RenameCollision { existing_id: string; existing_name: string; election_id: number; election_type: string | null }

/** 這筆 correction 是不是要改 politicians.name；是的話回 { target_id, new_name } */
export function renameOf(payload: unknown): { target_id: string; new_name: string } | null {
  const c = normalizeCorrection(payload);
  if (c.target_table !== "politicians" || !c.target_id) return null;
  const change = c.changes.find((x) => x.field === "name");
  const value = typeof change?.correct_value === "string" ? change.correct_value.trim() : "";
  return value ? { target_id: c.target_id, new_name: value } : null;
}

/**
 * 新名字是不是同屆、同選舉類型、同縣市另一位參選人的名字或別名。縣市看人物的 region，兩邊都有值才比（有一邊空的不擋，免得誤傷）。
 * 已合併掉的人物（merged_into 有值）不算。
 */
export async function renameCollision(supabase: SupabaseLike, targetId: string, newName: string): Promise<RenameCollision | null> {
  const { data: me, error: meErr } = await supabase.from("politicians").select("id, name, region").eq("id", targetId).maybeSingle();
  if (meErr) throw new Error(`politicians rename lookup: ${meErr.message}`);
  if (!me) return null;
  // query-bounds: ok — 一個人的參選紀錄一般個位數，limit 50 足夠
  const { data: mine, error: mineErr } = await supabase.from("politician_elections").select("election_id, election_type").eq("politician_id", targetId).limit(50);
  if (mineErr) throw new Error(`politician_elections rename lookup: ${mineErr.message}`);
  if (!mine || mine.length === 0) return null;

  const norm = normText(newName) ?? newName;
  // query-bounds: ok — 同名同姓上限 20
  const { data: sameName, error: nameErr } = await supabase.from("politicians").select("id, name, region").eq("name", newName).neq("id", targetId).is("merged_into", null).limit(20);
  if (nameErr) throw new Error(`politicians rename same-name: ${nameErr.message}`);
  // query-bounds: ok — 同一個別名上限 20
  const { data: aliasKeys, error: aliasErr } = await supabase.from("politician_keys").select("politician_id").eq("key_type", "alias_name").eq("key_value", norm).neq("politician_id", targetId).limit(20);
  if (aliasErr) throw new Error(`politician_keys rename alias: ${aliasErr.message}`);
  const candidates = new Map<string, { id: string; name: string; region: string | null }>();
  for (const r of (sameName ?? []) as Array<{ id: string; name: string; region: string | null }>) candidates.set(r.id, r);
  const aliasIds = ((aliasKeys ?? []) as Array<{ politician_id: string }>).map((k) => k.politician_id).filter((id) => !candidates.has(id));
  if (aliasIds.length > 0) {
    const { data: aliased, error: aliasedErr } = await supabase.from("politicians").select("id, name, region").in("id", aliasIds).is("merged_into", null).limit(aliasIds.length);
    if (aliasedErr) throw new Error(`politicians rename alias rows: ${aliasedErr.message}`);
    for (const r of (aliased ?? []) as Array<{ id: string; name: string; region: string | null }>) candidates.set(r.id, r);
  }
  const sameCounty = [...candidates.values()].filter((c) => !c.region || !me.region || normText(c.region) === normText(String(me.region)));
  if (sameCounty.length === 0) return null;
  // query-bounds: ok — 候選上限 40 人，每人參選紀錄個位數
  const { data: theirs, error: theirErr } = await supabase.from("politician_elections").select("politician_id, election_id, election_type").in("politician_id", sameCounty.map((c) => c.id)).limit(500);
  if (theirErr) throw new Error(`politician_elections rename candidates: ${theirErr.message}`);
  for (const t of (theirs ?? []) as Array<{ politician_id: string; election_id: number; election_type: string | null }>) {
    const hit = (mine as Array<{ election_id: number; election_type: string | null }>).find((m) => m.election_id === t.election_id && (m.election_type ?? null) === (t.election_type ?? null));
    if (!hit) continue;
    const c = candidates.get(t.politician_id)!;
    return { existing_id: c.id, existing_name: c.name, election_id: t.election_id, election_type: t.election_type };
  }
  return null;
}

export function renameCollisionMessage(oldId: string, c: RenameCollision): string {
  return `這看起來是同一人重複建檔：新名字已經是同一場選舉（${c.election_id}${c.election_type ? ` ${c.election_type}` : ""}）另一位參選人「${c.existing_name}」（${c.existing_id}）的名字或別名。請改交 merge_politician，把 ${oldId} 併進 ${c.existing_id}。`;
}
