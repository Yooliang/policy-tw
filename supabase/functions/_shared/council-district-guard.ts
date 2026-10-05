/**
 * 縣市議員的參選紀錄要帶選舉區才收（2026-10-05，協議 1.48.0）。
 *
 * 根因：2026 縣市議員已登記的參選紀錄有 105 筆沒有選區（只到縣市或連縣市都沒有），其中 103 筆是名單清查
 * （auto:roster_check:2026:<縣市>:縣市議員）照中選會登記彙總表交進來的——名冊每一列都印著「臺中市第5選舉區」，
 * 代理只抄了姓名、政黨、縣市；交件端只在「有給選區」時才核對名冊，沒給就照收；落庫只到縣市層級。
 * 之後網站的選區分組沒有選區可用，就借了人物自己的地區（里長那一筆的「大雅區 上雅里」、立委那一筆的
 * 「臺中市第03選區」），在縣市頁冒出假選區；「補選區」任務再一筆一筆派回去問。
 *
 * 在交件那一刻代理手上就是那份名冊，補一欄最便宜（1.39.0 以來「交件就擋、不算被拒」的同一種做法）。
 * 只擋縣市議員、只擋有在選的狀態：表態不參選（not_running）與退選（withdrawn）沒有選區要問，跟補選區任務一致。
 * 選區先經過 normalizeCandidacyDistrictField（沒給會從 position 的「第N選舉區」抽），所以這裡看的是統一寫法之後的值。
 */
import { normalizeDistrict } from "./electoral-district.ts";

/** 不問選區的狀態（跟 contribution_auto_tasks_region_gap 的「表態不參選不問選區」同一套） */
const NO_DISTRICT_STATUSES = new Set(["not_running", "withdrawn"]);

export interface CouncilDistrictProblem {
  index: number;
  name: string | null;
  region: string | null;
  message: string;
}

export function councilDistrictProblems(
  items: ReadonlyArray<{ contribution_type: string; payload: unknown }>,
): CouncilDistrictProblem[] {
  const out: CouncilDistrictProblem[] = [];
  items.forEach((item, index) => {
    if (item.contribution_type !== "candidacy") return;
    const p = (item.payload ?? {}) as Record<string, unknown>;
    if (p.election_type !== "縣市議員") return;
    if (NO_DISTRICT_STATUSES.has(String(p.candidate_status))) return;
    const district = typeof p.electoral_district === "string" ? p.electoral_district.trim() : "";
    if (district && normalizeDistrict(district)) return;
    const name = typeof p.name === "string" ? p.name : null;
    const region = typeof p.region === "string" ? p.region : null;
    out.push({
      index,
      name,
      region,
      message: district
        ? `electoral_district「${district}」看不出是第幾選舉區，請填「第NN選舉區」（例：第05選舉區）`
        : `縣市議員要填 electoral_district（例：第05選舉區）：中選會登記彙總表每一列都印著選舉區，照抄那一格；沒有選區網站就只能把他記到縣市，選區分組找不到他`,
    });
  });
  return out;
}
