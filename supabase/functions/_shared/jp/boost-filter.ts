import { isJpDate, isPrefectureCode, lgCodeValid } from "./lg-code.ts";

/**
 * 日本站插隊條件的白名單驗證（2026-10-10）。複製自 ../boost-filter.ts 的結構，詞彙換成日本站的。
 * 端點無金鑰，所以條件只能是固定詞彙、固定型別、有上限，不能有任何自由文字進 SQL。詞彙與 SQL 端 policy_jp.task_boost_matches 一致
 * （migration 20261010030000_policy_jp_boost.sql）。
 *
 * 拿掉的（台灣專用）：regions、election_id、election_types、missing_avatar、politician_ids。
 * 日本專屬的鍵：pref_codes（都道府県的團體碼）、lg_codes（團體碼）、election_before（選舉日早於這天）。
 */
export const BOOST_FILTER_KEYS = ["pref_codes", "lg_codes", "task_types", "kinds", "election_before"] as const;
export type BoostFilterKey = typeof BOOST_FILTER_KEYS[number];
export const BOOST_KINDS = ["task", "verify"] as const;
export const BOOST_LABEL_MAX = 60;
/** 同一個來源網段一小時最多幾次：插隊是一次性的，連按沒有意義，只會把別人的插隊往後推（同正見） */
export const BOOST_PER_IP_PER_HOUR = 6;

/** 任務型別只檢查格式（小寫英數與底線）：自動缺口、手動任務、驗證項目（contribution_type）的型別都可能，不限定清單 */
const TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function validateBoostLabel(raw: unknown): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, error: "label は必須：この加推の名前（例：愛知県 選挙発見）" };
  if (raw.trim().length > BOOST_LABEL_MAX) return { ok: false, error: `label は ${BOOST_LABEL_MAX} 文字まで` };
  return { ok: true, label: raw.trim() };
}

function codeList(v: unknown, name: string, max: number, prefecturesOnly: boolean): string[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return `${name} は 1～${max} 件の 6 桁団体コードの配列`;
  for (const c of v) {
    if (!lgCodeValid(c)) return `${name} の各要素は検査数字が正しい 6 桁の全国地方公共団体コード`;
    if (prefecturesOnly && !isPrefectureCode(c)) return `${name} の各要素は都道府県のコード（例：愛知県 230006）`;
  }
  return [...new Set(v as string[])];
}

export function validateBoostFilter(raw: unknown): { ok: true; filter: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "filter はオブジェクト" };
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: false, error: `filter には条件が 1 つ以上必要：${BOOST_FILTER_KEYS.join("、")}` };
  const unknown = keys.filter((k) => !(BOOST_FILTER_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, error: `未知の条件：${unknown.join("、")}；使えるのは ${BOOST_FILTER_KEYS.join("、")}` };
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    switch (k as BoostFilterKey) {
      case "pref_codes": { const r = codeList(v, "pref_codes", 47, true); if (typeof r === "string") return { ok: false, error: r }; out.pref_codes = r; break; }
      case "lg_codes": { const r = codeList(v, "lg_codes", 200, false); if (typeof r === "string") return { ok: false, error: r }; out.lg_codes = r; break; }
      case "task_types": {
        if (!Array.isArray(v) || v.length === 0 || v.length > 30) return { ok: false, error: "task_types は 1～30 件の文字列の配列" };
        if (v.some((s) => typeof s !== "string" || !TYPE_RE.test(s))) return { ok: false, error: "task_types の各要素は小文字英数字とアンダースコアの型名（例：election_discovery）" };
        out.task_types = [...new Set(v as string[])]; break;
      }
      case "kinds": {
        if (!Array.isArray(v) || v.length === 0 || v.length > 2) return { ok: false, error: "kinds は 1～2 件の配列" };
        if (v.some((x) => !(BOOST_KINDS as readonly string[]).includes(x as string))) return { ok: false, error: "kinds は task／verify のみ" };
        out.kinds = [...new Set(v as string[])]; break;
      }
      case "election_before": {
        if (!isJpDate(v)) return { ok: false, error: "election_before は YYYY-MM-DD（実在する日付、1947～2100 年）" };
        out.election_before = v; break;
      }
    }
  }
  return { ok: true, filter: out };
}
