/**
 * 插隊條件的白名單驗證（2026-09-22）。端點無金鑰，所以條件只能是固定詞彙、固定型別、有上限，
 * 不能有任何自由文字進 SQL。詞彙與 SQL 端 task_boost_matches 一致。
 */
export const BOOST_FILTER_KEYS = ["regions", "election_id", "election_types", "task_types", "missing_avatar", "politician_ids", "kinds"] as const;
export type BoostFilterKey = typeof BOOST_FILTER_KEYS[number];
export const BOOST_KINDS = ["task", "verify"] as const;
export const BOOST_LABEL_MAX = 60;
/** 同一個來源 IP 一小時最多幾次：插隊是一次性的，連按沒有意義，只會把別人的插隊往後推 */
export const BOOST_PER_IP_PER_HOUR = 6;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringList(v: unknown, name: string, max: number, maxLen: number): string[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return `${name} 要是 1～${max} 個字串的陣列`;
  for (const s of v) {
    if (typeof s !== "string" || s.trim().length === 0 || s.length > maxLen) return `${name} 每一項要是 1～${maxLen} 字的字串`;
  }
  return v.map((s) => (s as string).trim());
}

export function validateBoostLabel(raw: unknown): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, error: "label 必填：這次插隊叫什麼（例：六都 2026 縣市長）" };
  if (raw.trim().length > BOOST_LABEL_MAX) return { ok: false, error: `label 最多 ${BOOST_LABEL_MAX} 字` };
  return { ok: true, label: raw.trim() };
}

export function validateBoostFilter(raw: unknown): { ok: true; filter: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "filter 要是物件" };
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: false, error: `filter 至少要有一個條件：${BOOST_FILTER_KEYS.join("、")}` };
  const unknown = keys.filter((k) => !(BOOST_FILTER_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, error: `不認得的條件：${unknown.join("、")}；只收 ${BOOST_FILTER_KEYS.join("、")}` };
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    switch (k as BoostFilterKey) {
      case "regions": { const r = stringList(v, "regions", 30, 10); if (typeof r === "string") return { ok: false, error: r }; out.regions = r; break; }
      case "election_types": { const r = stringList(v, "election_types", 9, 20); if (typeof r === "string") return { ok: false, error: r }; out.election_types = r; break; }
      case "task_types": { const r = stringList(v, "task_types", 30, 40); if (typeof r === "string") return { ok: false, error: r }; out.task_types = r; break; }
      case "kinds": {
        const r = stringList(v, "kinds", 2, 10); if (typeof r === "string") return { ok: false, error: r };
        if (r.some((x) => !(BOOST_KINDS as readonly string[]).includes(x))) return { ok: false, error: "kinds 只收 task／verify" };
        out.kinds = r; break;
      }
      case "election_id": {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 2000 || v > 2100) return { ok: false, error: "election_id 要是選舉年份（例：2026）" };
        out.election_id = v; break;
      }
      case "missing_avatar": {
        if (typeof v !== "boolean") return { ok: false, error: "missing_avatar 要是 true／false" };
        if (v) out.missing_avatar = true; break;
      }
      case "politician_ids": {
        if (!Array.isArray(v) || v.length === 0 || v.length > 200) return { ok: false, error: "politician_ids 要是 1～200 個 uuid 的陣列" };
        if (v.some((x) => typeof x !== "string" || !UUID_RE.test(x))) return { ok: false, error: "politician_ids 每一項要是 uuid" };
        out.politician_ids = v; break;
      }
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "filter 至少要有一個生效的條件（missing_avatar:false 不算）" };
  return { ok: true, filter: out };
}
