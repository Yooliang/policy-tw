/**
 * 多人任務（target.multi_person，名冊分組任務）的「這一筆答的是哪一位」（2026-11-09，小良核准）。
 *
 * 一張任務包著好幾位，每筆交件必須帶 payload.person_key（照抄 target.people[].key，例：「掛錯人:57044」）：
 *   * 伺服器收件時擋掉沒帶或不在這張任務名單上的（400 person_key_required／person_key_unknown），不從自由文字猜；
 *   * 該位有 politician_election_id 的，no_change 還要帶同一個 politician_election_id（400 person_key_mismatch）；
 *   * 同一宣稱的鍵把 person_key 算進去（duplicate-claim.ts），不同人的答案不再互相收編；
 *   * no_change confirmed 落庫時，依該位的做法寫逐人的 task_checks（見 PERSON_CONFIRM_CHECK）。
 */
import { isMultiPersonTarget } from "./task-fulfilment.ts";

type Obj = Record<string, unknown>;

export interface GroupPerson { key: string; action?: string; politician_election_id?: number | string | null; name?: string }

/** target.people 取出可用的人 */
export function groupPeople(target: unknown): GroupPerson[] {
  if (!isMultiPersonTarget(target)) return [];
  const raw = (target as Obj).people;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Obj => !!x && typeof x === "object" && typeof (x as Obj).key === "string")
    .map((x) => ({ key: String(x.key), action: typeof x.action === "string" ? x.action : undefined, politician_election_id: x.politician_election_id as GroupPerson["politician_election_id"], name: typeof x.name === "string" ? x.name : undefined }));
}

export function personKeyOf(payload: unknown): string | null {
  const v = payload && typeof payload === "object" ? (payload as Obj).person_key : null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 這一筆答的是哪一位：先看 person_key；舊資料（沒有 person_key）才退回用 payload.politician_election_id（結構化欄位）對名單 */
export function resolveGroupPerson(target: unknown, payload: unknown): GroupPerson | null {
  const people = groupPeople(target);
  const key = personKeyOf(payload);
  if (key) return people.find((p) => p.key === key) ?? null;
  const pe = payload && typeof payload === "object" ? (payload as Obj).politician_election_id : null;
  if (pe === null || pe === undefined || pe === "") return null;
  const hits = people.filter((p) => p.politician_election_id !== null && p.politician_election_id !== undefined && String(p.politician_election_id) === String(pe));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 這位「確認沒問題」之後，要寫哪一個 task_checks.task_id 才會讓派工臂不再把他算成缺口。
 * 目前只有「掛錯人」臂有逐人的 confirmed 排除（contribution_auto_tasks_owner_mismatch／roster_diff_findings 讀
 * task_checks.task_id＝'auto:candidacy_owner_mismatch:<pe_id>' 且 outcome＝confirmed）；
 * 其他做法（缺人、查無此人、政黨、縣市、鄉鎮、號次、重複）的臂沒有這種排除，no_change 只記錄、人留在清單直到差異真的消失。
 */
export function personConfirmCheckTaskId(person: GroupPerson | null): string | null {
  if (!person || person.action !== "wrong_owner") return null;
  const pe = person.politician_election_id;
  if (pe === null || pe === undefined || !/^[1-9]\d{0,9}$/.test(String(pe))) return null;
  return `auto:candidacy_owner_mismatch:${pe}`;
}

export interface GroupPersonProblem { index: number; path: string; code: string; message: string }

/** 收件檢查：items 裡屬於多人任務的每一筆都要帶合法的 person_key */
export function groupPersonProblems(
  items: ReadonlyArray<{ contribution_type: string; payload: unknown; task_id?: string | null }>,
  targetsByTaskId: ReadonlyMap<string, unknown>,
): GroupPersonProblem[] {
  const out: GroupPersonProblem[] = [];
  items.forEach((it, index) => {
    const payload = (it.payload && typeof it.payload === "object" ? it.payload : {}) as Obj;
    const taskId = (typeof it.task_id === "string" && it.task_id) || (typeof payload.task_id === "string" ? payload.task_id : "");
    if (!taskId || !targetsByTaskId.has(taskId)) return;
    const target = targetsByTaskId.get(taskId);
    const people = groupPeople(target);
    const key = personKeyOf(payload);
    if (!key) {
      out.push({ index, path: "payload.person_key", code: "person_key_required", message: `這是多人任務：每一筆交件都要帶 payload.person_key，照抄任務名單裡你答的那一位的 key（例：${people[0]?.key ?? "掛錯人:12345"}）；不要把多位塞進同一筆` });
      return;
    }
    const person = people.find((p) => p.key === key);
    if (!person) {
      out.push({ index, path: "payload.person_key", code: "person_key_unknown", message: `person_key「${key}」不在這張任務的名單上（可能已處理完被移除，或抄錯）；名單：${people.map((p) => p.key).join("、") || "（空）"}` });
      return;
    }
    const pe = person.politician_election_id;
    if (it.contribution_type === "no_change" && pe !== null && pe !== undefined && String(payload.politician_election_id ?? "") !== String(pe)) {
      out.push({ index, path: "payload.politician_election_id", code: "person_key_mismatch", message: `no_change 要同時帶 politician_election_id＝${pe}（「${key}」那一位的），收到「${payload.politician_election_id ?? ""}」` });
    }
  });
  return out;
}
