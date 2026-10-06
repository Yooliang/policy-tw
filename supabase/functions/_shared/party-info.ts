/**
 * 政黨資訊交件 party_info（#346 第二階段，協議 1.56.0）：代理附出處補政黨的
 *   - 改名：新名稱那一筆的 predecessor_id（前身）＋ valid_from（新名稱開始用的日子），舊名稱那一筆的 valid_to
 *   - 解散、廢止日：valid_to（內政部名冊只有狀態、沒有日期，parties.valid_to 原本一律空著）
 *   - 名冊外政黨的對應：名冊查無此名稱的那幾列（id 10001 起）是不是名冊上某個政黨改名前的名字（predecessor_id）
 * 一筆交件 payload.parties 每個政黨一項（最多 MAX_PARTY_INFO_ITEMS 項；改名要新舊兩筆一起交，一次驗證）。
 *
 * 這裡只放純函式：交件格式（contribution-schema.ts 用）、落庫計畫（apply-contribution.ts、apply-precheck.ts 用）。
 * 寫入與履歷在 apply-contribution.ts；出處由資料庫觸發器掛到 source_refs（migration 20261006100100）。
 */

export const MAX_PARTY_INFO_ITEMS = 5;
export const PARTY_INFO_FIELDS = ["valid_from", "valid_to", "predecessor_id"] as const;
export type PartyInfoField = (typeof PARTY_INFO_FIELDS)[number];

export interface PartyInfoItem { party_id: number; valid_from?: string; valid_to?: string; predecessor_id?: number }
/** parties 一列（落庫要看的欄位） */
export interface PartyRow { id: number; name: string; valid_from: string | null; valid_to: string | null; predecessor_id: number | null }

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** 交件格式的問題（path, message）；空陣列＝格式沒問題 */
export function partyInfoProblems(payload: Record<string, unknown>): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const list = payload.parties;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PARTY_INFO_ITEMS) {
    out.push({ path: "payload.parties", message: `parties 必填：每個政黨一項 {party_id, valid_from?, valid_to?, predecessor_id?}（1～${MAX_PARTY_INFO_ITEMS} 項；改名要新舊兩筆一起交）` });
  } else {
    const seen = new Set<number>();
    list.forEach((raw, i) => {
      const at = `payload.parties[${i}]`;
      const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      if (!isId(it.party_id)) out.push({ path: `${at}.party_id`, message: "party_id 要是政黨表的整數 id（內政部政黨編號；名冊查無此名稱的是 10001 起）" });
      else if (seen.has(it.party_id)) out.push({ path: `${at}.party_id`, message: `政黨 ${it.party_id} 重複了，同一個政黨的欄位寫在同一項` });
      else seen.add(it.party_id);
      const given = PARTY_INFO_FIELDS.filter((f) => it[f] !== undefined);
      if (given.length === 0) out.push({ path: at, message: "至少要給 valid_from、valid_to、predecessor_id 其中一個" });
      for (const f of ["valid_from", "valid_to"] as const) {
        if (it[f] !== undefined && !isDate(it[f])) out.push({ path: `${at}.${f}`, message: `${f} 要是 YYYY-MM-DD（查不到確切日子就不要交這一欄，不要填月初、年初湊）` });
      }
      if (isDate(it.valid_from) && isDate(it.valid_to) && it.valid_to < it.valid_from) out.push({ path: `${at}.valid_to`, message: "valid_to（名稱停用日）不能早於 valid_from（開始用的日子）" });
      if (it.predecessor_id !== undefined) {
        if (!isId(it.predecessor_id)) out.push({ path: `${at}.predecessor_id`, message: "predecessor_id 要是政黨表的整數 id（改名前那一筆）" });
        else if (it.predecessor_id === it.party_id) out.push({ path: `${at}.predecessor_id`, message: "前身不能是自己" });
      }
      const extra = Object.keys(it).filter((k) => k !== "party_id" && !(PARTY_INFO_FIELDS as readonly string[]).includes(k));
      if (extra.length > 0) out.push({ path: at, message: `不認得的欄位：${extra.join("、")}（名稱、名冊狀態照內政部名冊，不收交件）` });
    });
  }
  if (typeof payload.note !== "string" || payload.note.trim().length < 10) {
    out.push({ path: "payload.note", message: "note 必填（至少 10 字）：依據哪一份公告、名冊頁或報導，上面怎麼寫" });
  }
  return out;
}

/** payload → 一項一個政黨（格式不對的項目略過；呼叫端應該先過 partyInfoProblems） */
export function partyInfoItems(payload: Record<string, unknown>): PartyInfoItem[] {
  const list = Array.isArray(payload.parties) ? payload.parties : [];
  return list.flatMap((raw) => {
    const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (!isId(it.party_id)) return [];
    return [{
      party_id: it.party_id,
      ...(isDate(it.valid_from) ? { valid_from: it.valid_from } : {}),
      ...(isDate(it.valid_to) ? { valid_to: it.valid_to } : {}),
      ...(isId(it.predecessor_id) ? { predecessor_id: it.predecessor_id } : {}),
    }];
  });
}

/** 這一筆要讀哪些政黨：交件提到的每一個（含前身） */
export function partyInfoIds(items: readonly PartyInfoItem[]): number[] {
  return [...new Set(items.flatMap((it) => [it.party_id, ...(it.predecessor_id ? [it.predecessor_id] : [])]))];
}

export interface PartyInfoPlan {
  /** 真的會改的：一個政黨一列 patch（同一列一次 UPDATE：parties 的 CHECK 要求 valid_to ≥ valid_from） */
  updates: Array<{ id: number; name: string; patch: Partial<Record<PartyInfoField, string | number>>; old: Partial<Record<PartyInfoField, string | number | null>> }>;
  /** 值跟現在一樣的：「政黨 95 的 valid_from」 */
  unchanged: string[];
  /** 落不了庫的：找不到政黨、前身繞回自己、改完起訖顛倒 */
  problems: string[];
}

/**
 * 落庫計畫（純函式）。rows：交件提到的政黨，加上前身往上追的那幾代（呼叫端照 predecessor_id 一路讀上去，好看出有沒有繞圈）。
 * 交件給的值蓋過現值；沒給的欄位維持原樣。
 */
export function planPartyInfo(rows: ReadonlyMap<number, PartyRow>, items: readonly PartyInfoItem[]): PartyInfoPlan {
  const plan: PartyInfoPlan = { updates: [], unchanged: [], problems: [] };
  // 改完之後每個政黨的前身（交件的蓋過現值），用來看有沒有繞圈
  const predAfter = new Map<number, number | null>([...rows.values()].map((r) => [r.id, r.predecessor_id]));
  for (const it of items) if (it.predecessor_id) predAfter.set(it.party_id, it.predecessor_id);

  for (const it of items) {
    const row = rows.get(it.party_id);
    if (!row) { plan.problems.push(`找不到政黨 ${it.party_id}（政黨表的 id＝內政部政黨編號；名冊查無此名稱的從 10001 起）`); continue; }
    if (it.predecessor_id !== undefined) {
      if (!rows.has(it.predecessor_id)) { plan.problems.push(`找不到前身政黨 ${it.predecessor_id}`); continue; }
      // 往上追前身，追回自己＝繞圈（A 的前身是 B、B 的前身又是 A）
      const seen = new Set<number>([it.party_id]);
      let cur: number | null | undefined = it.predecessor_id;
      let loop = false;
      for (let depth = 0; cur && depth < 50; depth++) {
        if (seen.has(cur)) { loop = true; break; }
        seen.add(cur);
        cur = predAfter.get(cur);
      }
      if (loop) { plan.problems.push(`政黨 ${it.party_id}（${row.name}）的前身往上追會繞回自己，改名鏈不能是一個圈`); continue; }
    }
    const from = it.valid_from ?? row.valid_from;
    const to = it.valid_to ?? row.valid_to;
    if (from && to && to < from) { plan.problems.push(`政黨 ${it.party_id}（${row.name}）改完之後停用日 ${to} 早於開始日 ${from}`); continue; }
    const patch: PartyInfoPlan["updates"][number]["patch"] = {};
    const old: PartyInfoPlan["updates"][number]["old"] = {};
    for (const f of PARTY_INFO_FIELDS) {
      const v = it[f];
      if (v === undefined) continue;
      if (String(row[f] ?? "") === String(v)) { plan.unchanged.push(`政黨 ${it.party_id} 的 ${f}`); continue; }
      patch[f] = v;
      old[f] = row[f];
    }
    if (Object.keys(patch).length > 0) plan.updates.push({ id: it.party_id, name: row.name, patch, old });
  }
  return plan;
}

/** 前身往上追的時候，下一代要讀哪些 id（rows 裡已經有的不再讀） */
export function missingAncestors(rows: ReadonlyMap<number, PartyRow>): number[] {
  return [...new Set([...rows.values()].map((r) => r.predecessor_id).filter((id): id is number => !!id && !rows.has(id)))];
}
