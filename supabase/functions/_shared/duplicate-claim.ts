/**
 * 重複提交＝同意票：兩個代理各自查證後得到同一個結論，那比「看別人交的東西投一票」更強。
 *
 * 2026-09-17 量到的：972 筆待驗證裡 147 筆是同一對象、不同代理、內容幾乎一樣的重複提交，
 * 卻是各躺各的、兩筆都 0 票。李四川那 21 筆堆積就是這麼來的。
 * 2026-09-18 實測（線上 1,207 筆 pending）：結構鍵相同、不同代理的配對 110 對、涉及 152 筆。
 *
 * 判準刻意分成兩類：
 *
 *   ✅ 結構化型別（candidacy／correction／removal／policy_progress／no_change）
 *      宣稱本身就是幾個欄位的組合（「把 X 的 Y 改成 Z」「某人這一屆狀態是已登記」），
 *      鍵相同＝講的是同一件事。實測 110 對零誤判——最不像的 5 對全是 removal，
 *      只有 reason 措辭不同、要求完全相同（都是「移除這筆標語」）。
 *
 *   ❌ 自由文字型別（policy／politician）不納入
 *      politician 的摘要只列欄位名（「政黨、縣市、出生年」），值可能完全不同：
 *      實測有一對 current_position 是「南投縣縣長」vs「南投縣長」、照片來源也不同，
 *      用欄位名當鍵就會讓 B 替 A 的值背書。改用「值完全相同」當鍵則是 0 對，
 *      policy 標題完全相同也是 0 組——納入零收益卻有實證的誤判風險，所以不納入。
 *      政見重複要靠別的路（派任務時列出 queued_policies，已上線）。
 *
 * 誤判的代價不對稱：漏抓只是維持現狀（兩筆各自等票），錯抓會讓一筆真正不同的宣稱
 * 永遠沒有自己的紀錄。所以寧可漏，不可錯。
 */

type Obj = Record<string, unknown>;

/** 只有這些型別會被判為「同一個宣稱」；其餘一律各自成案 */
export const DUPLICATE_ELIGIBLE_TYPES = ["candidacy", "correction", "removal", "policy_progress", "no_change", "merge_politician"] as const;

/** 宣稱指向的對象：查資料庫時用這個欄位過濾（payload->>field） */
const TARGET_FIELD: Record<string, string> = {
  candidacy: "politician_id",
  correction: "target_id",
  removal: "target_id",
  policy_progress: "policy_id",
  no_change: "task_id",
  merge_politician: "keep_id",
};

/** 臺／台、全形空白、大小寫不算不同；值用同一套正規化再比 */
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.replace(/臺/g, "台").replace(/\s+/g, "").trim().toLowerCase();
}

/** 這筆宣稱指向誰（查詢用）；拿不到對象就不做重複判定 */
export function claimTarget(contributionType: string, payload: unknown): { field: string; value: string } | null {
  const field = TARGET_FIELD[contributionType];
  if (!field) return null;
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  const raw = p[field];
  if (typeof raw === "string" && raw.trim()) return { field, value: raw.trim() };
  if (typeof raw === "number") return { field, value: String(raw) };
  return null;
}

/** correction 的 changes 可能是陣列或單一欄位兩種寫法，收斂成 (欄位, 值) 的排序列表 */
function correctionChanges(p: Obj): string {
  const raw = p.changes;
  const list = Array.isArray(raw)
    ? raw.filter((c): c is Obj => !!c && typeof c === "object").map((c) => [norm(c.field), norm(c.correct_value)] as const)
    : [[norm(p.field), norm(p.correct_value)] as const];
  return JSON.stringify([...list].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])));
}

/**
 * 這筆宣稱的識別鍵；兩筆的鍵相同＝在講同一件事。不適用的型別回 null。
 *
 * 刻意不看的欄位：reason／note／source_urls／date 之外的敘述。
 * 兩個代理用不同說法主張同一件事，本來就該算同一個宣稱——這正是要合併的情況。
 */
export function claimKey(contributionType: string, payload: unknown): string | null {
  if (!(DUPLICATE_ELIGIBLE_TYPES as readonly string[]).includes(contributionType)) return null;
  const target = claimTarget(contributionType, payload);
  if (!target) return null;
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  const head = `${contributionType}|${target.field}:${norm(target.value)}`;

  switch (contributionType) {
    case "candidacy":
      // 同一個人、同一屆、同一種選舉、同一個參選狀態、同一個選舉結果＝同一個宣稱
      // （帶結果的答案不能併進沒帶結果的那筆，否則結果會跟著被丟掉；2026-09-19）
      return `${head}|${norm(p.election_id)}|${norm(p.election_type)}|${norm(p.candidate_status)}|${norm(p.election_result)}`;
    case "merge_politician": {
      // 同一對人、同一個結論＝同一個宣稱（keep／remove 對調也算同一對）
      const pair = [norm(p.keep_id), norm(p.remove_id)].sort().join("~");
      return `${head}|${pair}|${norm(p.same_person)}`;
    }
    case "correction":
      // 同一列、同一組「欄位→新值」＝同一個宣稱（理由寫得不一樣不影響）
      return `${head}|${norm(p.target_table)}|${correctionChanges(p)}`;
    case "removal":
      // 「這筆該移除」就是同一個主張，理由各寫各的
      return head;
    case "policy_progress":
      // 進度要連日期一起看：同一筆政見的不同里程碑是不同的宣稱
      return `${head}|${norm(p.status)}|${norm(p.progress)}|${norm(p.date)}`;
    case "no_change":
      // 「查了，這個任務沒東西要改」——同一個任務就是同一個宣稱
      return head;
    default:
      return null;
  }
}

/** 兩筆是不是同一個宣稱（鍵拿不到就一律當作不同，不猜） */
export function sameClaim(
  a: { contribution_type: string; payload: unknown },
  b: { contribution_type: string; payload: unknown },
): boolean {
  if (a.contribution_type !== b.contribution_type) return false;
  const ka = claimKey(a.contribution_type, a.payload);
  const kb = claimKey(b.contribution_type, b.payload);
  return ka !== null && ka === kb;
}

export interface ExistingClaim {
  id: string;
  contribution_type: string;
  payload: unknown;
  agent_name: string | null;
  contributor_ip_hash: string | null;
  status: string;
}

/**
 * 在既有的待驗證貢獻裡找「同一個宣稱」的那一筆。
 *
 * 同代號或同來源 IP 一律不算——那是同一個人自己交兩次，不是兩份獨立查證
 * （跟 consensus.ts 的 isSelfVote 同一條規則；投票端也會再擋一次）。
 * 多筆命中時取最早那筆：票集中在同一筆才會達標，分散在兩筆等於沒進展。
 */
export function findMergeTarget(
  incoming: { contribution_type: string; payload: unknown },
  submitter: { agent_name: string; ip_hash: string },
  candidates: readonly ExistingClaim[],
): ExistingClaim | null {
  const key = claimKey(incoming.contribution_type, incoming.payload);
  if (!key) return null;
  const hits = candidates.filter((c) =>
    c.status === "pending" &&
    c.contribution_type === incoming.contribution_type &&
    claimKey(c.contribution_type, c.payload) === key &&
    (c.agent_name ?? "").toLowerCase() !== submitter.agent_name.toLowerCase() &&
    c.contributor_ip_hash !== submitter.ip_hash
  );
  return hits[0] ?? null;
}
