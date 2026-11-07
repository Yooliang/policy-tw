/**
 * 同一人合併的硬守門（2026-11-07）：兩位人物在「同一屆」都有參選紀錄、而且紀錄對不起來，就不可能是同一人。
 *
 * 起因：張榮華（宜蘭縣三星鄉第02選舉區 鄉鎮市民代表 號次2）被併進張榮華（羅東鎮第03選舉區 號次5）、
 * 徐進忠（屏東縣春日鄉第02選舉區）被併進徐進忠（宜蘭縣三星鄉第01選舉區 號次2）——都是同名不同人，
 * 合併時 SQL merge_politician 對「同一屆已有」的處理是刪掉 remove 那列，等於把一個真的參選人刪掉。
 *
 * 衝突的定義（同一個 election_id 上，兩邊都有值才比）：
 *   - election_type 不同
 *   - cand_no 不同
 *   - 地區對不起來：縣市不同、鄉鎮不同、選舉區（「第NN選舉區」）不同、里不同。
 *     一邊只記到鄉鎮、另一邊記到該鄉鎮的選舉區，視為可能是同一人（補選舉區前的舊資料），不算衝突。
 * 交件前置檢查（apply-precheck.ts）與落庫（apply-contribution.ts 的 applyMergePolitician）共用。
 * 「判為不同人」（same_person=false）不經過這裡，照常放行。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const MERGE_CANDIDACY_CONFLICT_MESSAGE = "兩位在同一屆有不同的號次／選區，不是同一人；若確定是重複建檔請先 correction 修正參選紀錄";

export interface MergePeRow { election_id: number; election_type: string | null; cand_no: number | null; region_id: number | null }
export interface MergeRegionRow { region: string | null; sub_region: string | null; village: string | null }

const norm = (s: string | null | undefined): string | null => (s ? s.replace(/臺/g, "台").trim() || null : null);

/** 「三星鄉第02選舉區」→ { town: "三星鄉", district: "第2選舉區" }；沒有選舉區後綴 → district 為 null */
function splitSubRegion(sub: string | null | undefined): { town: string | null; district: string | null } {
  const s = norm(sub);
  if (!s) return { town: null, district: null };
  const m = s.match(/^(.*?)(第\d+選舉區)$/);
  if (!m) return { town: s, district: null };
  return { town: m[1] || null, district: m[2].replace(/第0*(\d+)選舉區/, "第$1選舉區") };
}

function differs<T>(a: T | null, b: T | null): boolean { return a !== null && b !== null && a !== b; }

export function regionsConflict(a: MergeRegionRow | undefined, b: MergeRegionRow | undefined): boolean {
  if (!a || !b) return false;
  if (differs(norm(a.region), norm(b.region))) return true;
  const sa = splitSubRegion(a.sub_region), sb = splitSubRegion(b.sub_region);
  // 縣市議員的選舉區可能不帶鄉鎮（sub_region 就是「第NN選舉區」）：town 空的那邊不比鄉鎮
  if (differs(sa.town, sb.town)) return true;
  if (differs(sa.district, sb.district)) return true;
  if (differs(norm(a.village), norm(b.village))) return true;
  return false;
}

/** 純函式：回 remove 那邊與 keep 在同一屆衝突的參選紀錄 */
export function mergeCandidacyConflicts(keepRows: readonly MergePeRow[], removeRows: readonly MergePeRow[], regions: ReadonlyMap<number, MergeRegionRow>): MergePeRow[] {
  const bad: MergePeRow[] = [];
  for (const r of removeRows) {
    const k = keepRows.find((x) => x.election_id === r.election_id);
    if (!k) continue;
    const conflict = differs(k.cand_no, r.cand_no)
      || differs(norm(k.election_type), norm(r.election_type))
      || (k.region_id != null && r.region_id != null && k.region_id !== r.region_id
        && regionsConflict(regions.get(k.region_id), regions.get(r.region_id)));
    if (conflict) bad.push(r);
  }
  return bad;
}

/** 查庫版：有衝突回訊息，沒有回 null。查詢出錯會 throw（交件前置檢查自己接住並放行，落庫讓它變 failed 重試）。 */
export async function findMergeCandidacyConflict(supabase: SupabaseLike, keepId: string, removeId: string): Promise<string | null> {
  // query-bounds: ok — 單一人物的參選紀錄（每人至多數十列），兩人各一查
  const load = async (id: string): Promise<MergePeRow[]> => {
    const { data, error } = await supabase.from("politician_elections")
      .select("election_id, election_type, cand_no, region_id").eq("politician_id", id);
    if (error) throw new Error(`merge conflict lookup: ${error.message}`);
    return (data ?? []) as MergePeRow[];
  };
  const [keepRows, removeRows] = await Promise.all([load(keepId), load(removeId)]);
  const sameElection = removeRows.filter((r) => keepRows.some((k) => k.election_id === r.election_id));
  if (sameElection.length === 0) return null;
  const regionIds = [...new Set([...keepRows, ...sameElection].map((r) => r.region_id).filter((x): x is number => typeof x === "number"))];
  const regions = new Map<number, MergeRegionRow>();
  if (regionIds.length > 0) {
    // query-bounds: ok — region_id 來自兩位人物自己的參選紀錄，變數 in() 有界
    const { data, error } = await supabase.from("regions").select("id, region, sub_region, village").in("id", regionIds);
    if (error) throw new Error(`merge conflict regions lookup: ${error.message}`);
    for (const r of (data ?? []) as Array<MergeRegionRow & { id: number }>) regions.set(r.id, r);
  }
  return mergeCandidacyConflicts(keepRows, removeRows, regions).length > 0 ? MERGE_CANDIDACY_CONFLICT_MESSAGE : null;
}
