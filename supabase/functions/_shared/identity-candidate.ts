/**
 * 身分比對的輸入（candidate）只有這一份組法（2026-11-11）。
 *
 * 落庫端（applyPolitician／applyCandidacy）餵給 ensurePolitician 的 candidate、派工的 dry-run（task-context）、
 * 投票閘（identity-pick-gate）都從這裡取；以前閘「照落庫端重建一份」，兩邊可能漂開——同一筆在不同時間點比出不同結論，
 * 驗證者照規則投的票就白投（見 candidate-import.ts identityInputOf 的 2026-09-23 馮印才實例）。
 */
import { identityInputOf, newPoliticianDefaults } from "./candidate-import.ts";
import { normElectionType } from "./identity-normalize.ts";
import { politicianIdFromTask } from "./task-politician.ts";

type Obj = Record<string, unknown>;
export type IdentityCandidate = Parameters<typeof identityInputOf>[0];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** politician／candidacy 交件 → 身分比對的候選資料（不看有沒有帶 politician_id；其他型別回 null） */
export function identityFieldsOf(contributionType: string, payload: Obj): IdentityCandidate | null {
  if (contributionType === "politician") {
    const defaults = newPoliticianDefaults({
      position: str(payload.position), region: str(payload.region), election_type: str(payload.election_type),
      current_position: str(payload.current_position), bio: str(payload.bio),
    });
    return {
      name: String(payload.name ?? ""), party: str(payload.party), region: defaults.region, election_type: str(payload.election_type),
      position: defaults.position, current_position: str(payload.current_position), birth_year: int(payload.birth_year),
    };
  }
  if (contributionType === "candidacy") {
    const electionType = normElectionType(str(payload.election_type)) ?? "縣市長";
    return {
      name: String(payload.name ?? ""), party: str(payload.party), region: str(payload.region), election_type: electionType,
      position: str(payload.position) ?? `${electionType}候選人`, current_position: str(payload.current_position),
      birth_year: int(payload.birth_year), cec_cand_id: str(payload.cec_cand_id) ?? int(payload.cec_cand_id), cec_theme_id: str(payload.cec_theme_id),
    };
  }
  return null;
}

/** 這一件有沒有「同名問題」要比對：沒姓名、或已指明是誰（payload.politician_id／任務編號）的回 null */
export function identityCandidateOf(contributionType: string, payload: Obj, taskId: unknown): IdentityCandidate | null {
  if (contributionType !== "politician" && contributionType !== "candidacy") return null;
  if (!str(payload.name)) return null;
  if (str(payload.politician_id) ?? politicianIdFromTask(taskId)) return null;
  return identityFieldsOf(contributionType, payload);
}
