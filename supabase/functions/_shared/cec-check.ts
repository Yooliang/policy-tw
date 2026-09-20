/**
 * 參選紀錄的系統票改問中選會的結構化資料（使用者 2026-09-20：系統不該提供 PDF／Excel 解析）。
 * db.cec.gov.tw 的候選人查詢 API 回姓名／選舉名稱／投票日／選區／政黨／出生年／當選與否——Jev 拿到的是欄位，
 * 不是攤平的表格，沒有「相鄰列的縣市被讀成主角的」那種誤判。2026 登記期中選會還沒有資料，查不到就退回提交者附的網頁。
 */
import { CEC_QUERY_URL, normalizeCandidacies, withoutFutureResults, type CecCandidacy } from "./cec-candidate.ts";

const UA = "Mozilla/5.0 (compatible; policy-tw-system-one/1.0)";

/** 純函式：把中選會的紀錄排成 Jev 讀的文字（一筆一行，欄位名寫清楚） */
export function cecRecordsText(list: readonly CecCandidacy[]): string {
  return list.map((c) => [
    `姓名：${c.name}`,
    c.election_name ? `選舉：${c.election_name}` : null,
    c.vote_date ? `投票日：${c.vote_date}（屆別 ${c.election_id ?? "?"}）` : null,
    c.area ? `選區：${c.area}` : null,
    c.party ? `政黨：${c.party}` : null,
    c.birth_year ? `出生年：${c.birth_year}` : null,
    c.election_result ? `結果：${c.election_result === "elected" ? "當選" : "未當選"}` : null,
    "來源：中選會候選人資料庫",
  ].filter(Boolean).join("；")).join("\n");
}

/**
 * 查中選會：同名的全部回（同名不同人由 Jev 依選區、政黨、出生年判），只留指定屆別。
 * 查不到、API 掛了都回 null，呼叫端退回網頁來源。
 */
export async function cecCandidacyPage(name: string, electionId: number, fetchImpl: typeof fetch = fetch): Promise<{ url: string; text: string; count: number } | null> {
  const n = name.trim();
  if (n.length < 2) return null;
  const url = `${CEC_QUERY_URL}?${new URLSearchParams({ cand_name: n })}`;
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Referer: "https://db.cec.gov.tw/" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const raw = await res.json();
    const all = withoutFutureResults(normalizeCandidacies(raw?.cand_data_list ?? []));
    const picked = all.filter((c) => c.election_id === electionId);
    if (picked.length === 0) return null;
    return { url, text: cecRecordsText(picked), count: picked.length };
  } catch {
    return null;
  }
}
