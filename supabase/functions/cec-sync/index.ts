import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { CITY_CODES } from "../_shared/cec-city-codes.ts";
import { CEC_BASE, type CecRow, fetchCecJson, SUBJECT_MAP } from "../_shared/cec-static-fetch.ts";
import { OUR_ELECTION_TYPES, planUnits, toCecCandidateRow, votedElectionIds } from "../_shared/cec-sync.ts";

/**
 * cec-sync — 把中選會「已投票選舉」的候選人名單同步進 cec_candidates（供比對用的快照）。
 *
 * 比照 moi-sync 的寫法：不驗 JWT（讓排程打得到），函式內用 service role 連 DB；
 * 同一個同步單位（屆別×選舉別×縣市）在 MIN_INTERVAL_HOURS 內同步過就空轉，防止重複打中選會，
 * 帶 { force: true } 可以跳過這個檢查。
 *
 * 同步單位＝屆別×選舉別×縣市（見 _shared/cec-sync.ts 的 planUnits）：先把該單位的候選人＋得票
 * 抓完、確認不是抓取失敗，才在同一個單位內「先刪後寫」；抓失敗就跳過那個單位、保留舊資料，
 * 回應的 failed[] 會列出來。
 *
 * 一次呼叫可能超時（Edge Function 上限約 150 秒，村里長 2022 一屆就有約 1.3 萬人）：
 * 用 TIME_BUDGET_MS 頂住，時間到了就停在目前的同步單位，回應的 next 告訴呼叫端下次從哪個單位繼續。
 * 也可以用 { election_id, election_type } 只跑一種，通常一種類型的 22 個縣市可以在一次呼叫內跑完。
 *
 * 請求 body（都可省略）：
 *   { election_id?: number, election_type?: string, resume_from?: { election_id, election_type, region }, force?: boolean }
 * 回應：{ success, units: [{election_id, election_type, region, fetched, written, skipped?}], failed: [...], next?: {...} | null }
 */

const TIME_BUDGET_MS = 100_000;
/** 打中選會的請求間隔（含 list／candidates／tickets／areas 每一支） */
const MIN_REQUEST_INTERVAL_MS = 600;
/** 同一個同步單位在這麼多小時內同步過，預設不再重打（force 可跳過） */
const MIN_INTERVAL_HOURS = 24;
/** 寫入 cec_candidates 每批最多幾筆（PostgREST／payload 大小考量） */
const INSERT_BATCH_SIZE = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ThemeInfo {
  themeId: string;
  themeName: string;
  voteDate?: string;
  year?: number;
}

/** 中選會「該科目可用選舉」清單，同一次呼叫內用 Map 快取，同一個 cecType 的 22 個縣市不必各抓一次 */
async function listThemes(cecType: string): Promise<ThemeInfo[]> {
  const subject = SUBJECT_MAP[cecType];
  if (!subject) return [];
  const url = `${CEC_BASE}/list/ELC_${subject.subjectId}.json`;
  const outcome = await fetchCecJson(url);
  if (outcome.kind !== "ok") return [];
  // 清單檔的列是「地區＋該地區的 theme_items」，不是候選人列，型別跟 CecRow 對不上，這裡就地取用
  // deno-lint-ignore no-explicit-any
  return (outcome.rows as any[]).flatMap((area) =>
    (area.theme_items || []).map((t: Record<string, unknown>) => ({
      themeId: String(t.theme_id ?? ""),
      themeName: String(t.theme_name ?? ""),
      voteDate: t.vote_date ? String(t.vote_date) : undefined,
      year: t.vote_date ? parseInt(String(t.vote_date).slice(0, 4), 10) : undefined,
    }))
  );
}

/**
 * 挑該屆的 theme：同年可能不只一筆（如嘉義市 2022 縣市長重行選舉），優先選「不是重行選舉」的那筆，
 * 這是已知的簡化——真的只有重行選舉那筆時仍會退回去用它，但那個特例縣市的名單目前不會被這支選到。
 */
function pickTheme(themes: readonly ThemeInfo[], electionId: number): ThemeInfo | undefined {
  const matches = themes.filter((t) => t.year === electionId);
  if (matches.length === 0) return undefined;
  return matches.find((t) => !t.themeName.includes("重行選舉")) ?? matches[0];
}

/** 縣市長／總統這幾種只有全國範圍的檔（縣市範圍會 404），要抓全國檔再依縣市過濾 */
function isNationalOnly(cecType: string): boolean {
  return cecType === "President" || cecType === "Mayor" || cecType === "CountyMayor";
}

function scopeFor(cecType: string, region: string): { prv: string; city: string } {
  if (isNationalOnly(cecType)) return { prv: "00", city: "000" };
  const codes = CITY_CODES[region];
  return { prv: codes?.prv ?? "00", city: codes?.city ?? "000" };
}

interface SyncUnit {
  electionId: number;
  ourType: string;
  cecType: string;
  region: string;
}

function buildUnits(electionIds: readonly number[], ourTypes: readonly string[]): SyncUnit[] {
  const units: SyncUnit[] = [];
  for (const electionId of electionIds) {
    for (const ourType of ourTypes) {
      for (const plan of planUnits(ourType)) {
        units.push({ electionId, ourType, cecType: plan.cecType, region: plan.region });
      }
    }
  }
  return units;
}

function unitKey(u: Pick<SyncUnit, "electionId" | "ourType" | "region">): string {
  return `${u.electionId}|${u.ourType}|${u.region}`;
}

interface UnitReport {
  election_id: number;
  election_type: string;
  region: string;
  fetched: number;
  written: number;
  skipped?: string;
}

interface UnitFailure {
  election_id: number;
  election_type: string;
  region: string;
  error: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    if (req.method === "POST") {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    }
  } catch {
    return new Response(JSON.stringify({ success: false, error: "body 不是合法的 JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const url = new URL(req.url);
  const qp = (k: string) => body[k] ?? url.searchParams.get(k) ?? undefined;

  const electionIdFilter = qp("election_id") !== undefined ? Number(qp("election_id")) : undefined;
  const electionTypeFilter = qp("election_type") !== undefined ? String(qp("election_type")) : undefined;
  const force = qp("force") === true || qp("force") === "true";
  const resumeFromRaw = body.resume_from as { election_id?: number; election_type?: string; region?: string } | undefined;
  const resumeFromKey = resumeFromRaw?.election_id !== undefined && resumeFromRaw?.election_type && resumeFromRaw?.region
    ? unitKey({ electionId: Number(resumeFromRaw.election_id), ourType: String(resumeFromRaw.election_type), region: String(resumeFromRaw.region) })
    : undefined;

  if (electionTypeFilter && !(OUR_ELECTION_TYPES as readonly string[]).includes(electionTypeFilter)) {
    return new Response(JSON.stringify({ success: false, error: `不認得的 election_type: ${electionTypeFilter}` }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const electionIds = electionIdFilter !== undefined ? [electionIdFilter] : votedElectionIds();
  if (electionIdFilter !== undefined && !votedElectionIds().includes(electionIdFilter) && !force) {
    return new Response(
      JSON.stringify({ success: false, error: `election_id ${electionIdFilter} 還沒投票或不認得；已投票的屆別是 ${votedElectionIds().join("、")}（真要跑就加 force: true）` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const ourTypes = electionTypeFilter ? [electionTypeFilter] : [...OUR_ELECTION_TYPES];

  const allUnits = buildUnits(electionIds, ourTypes);
  let startIndex = 0;
  if (resumeFromKey) {
    const idx = allUnits.findIndex((u) => unitKey(u) === resumeFromKey);
    // next 給的就是「下一個要處理的單位」本身，從它開始（原本 idx+1 會把它跳過：09-26 金門縣村里長整個漏掉、回應還是 success）
    if (idx >= 0) startIndex = idx;
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const themeCache = new Map<string, ThemeInfo[]>();
  const units: UnitReport[] = [];
  const failed: UnitFailure[] = [];
  const started = Date.now();
  let next: { election_id: number; election_type: string; region: string } | null = null;

  for (let i = startIndex; i < allUnits.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      const u = allUnits[i];
      next = { election_id: u.electionId, election_type: u.ourType, region: u.region };
      break;
    }
    const unit = allUnits[i];
    const { electionId, ourType, cecType, region } = unit;

    try {
      // 防重入：這個單位最近同步過就空轉，不再打中選會（force 可以跳過）
      if (!force) {
        const { data: last } = await supabase
          .from("cec_candidates")
          .select("synced_at")
          .eq("election_id", electionId)
          .eq("election_type", ourType)
          .eq("region", region)
          .order("synced_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastSyncedAt = (last as { synced_at?: string } | null)?.synced_at;
        if (lastSyncedAt && Date.now() - Date.parse(lastSyncedAt) < MIN_INTERVAL_HOURS * 3600_000) {
          units.push({ election_id: electionId, election_type: ourType, region, fetched: 0, written: 0, skipped: `${MIN_INTERVAL_HOURS} 小時內同步過` });
          continue;
        }
      }

      if (!themeCache.has(cecType)) {
        await sleep(MIN_REQUEST_INTERVAL_MS);
        themeCache.set(cecType, await listThemes(cecType));
      }
      const theme = pickTheme(themeCache.get(cecType) ?? [], electionId);
      if (!theme) {
        failed.push({ election_id: electionId, election_type: ourType, region, error: `找不到 ${electionId} 年的 theme（cecType=${cecType}）` });
        continue;
      }

      const subject = SUBJECT_MAP[cecType];
      const { prv, city } = scopeFor(cecType, region);
      const scope = `${prv}_${city}_00_000_0000`;
      const pathTail = `ELC/${subject.subjectId}/${subject.legisId}/${theme.themeId}/${subject.defaultLevel}/${scope}.json`;
      const candidatesUrl = `${CEC_BASE}/data/candidates/${pathTail}`;
      const ticketsUrl = `${CEC_BASE}/data/tickets/${pathTail}`;

      await sleep(MIN_REQUEST_INTERVAL_MS);
      const candOutcome = await fetchCecJson(candidatesUrl);
      await sleep(MIN_REQUEST_INTERVAL_MS);
      const ticketOutcome = await fetchCecJson(ticketsUrl);

      if (candOutcome.kind === "error") throw new Error(`candidates: ${candOutcome.message}`);
      if (ticketOutcome.kind === "error") throw new Error(`tickets: ${ticketOutcome.message}`);

      // 村里長：area_name 是里名，鄉鎮市區名要另抓 areas 檔用 dept_code 對
      const deptNames = new Map<string, string>();
      if (cecType === "Village") {
        await sleep(MIN_REQUEST_INTERVAL_MS);
        const areasUrl = `${CEC_BASE}/data/areas/ELC/${subject.subjectId}/${subject.legisId}/${theme.themeId}/D/${prv}_${city}_00_000_0000.json`;
        const areasOutcome = await fetchCecJson(areasUrl);
        if (areasOutcome.kind === "ok") {
          for (const a of areasOutcome.rows) if (a.dept_code && a.area_name) deptNames.set(a.dept_code, a.area_name);
        }
        // areas 抓不到不算致命：subRegion 會是空的，候選人本身還是抓得到
      }

      const ticketsById = new Map<number, CecRow>();
      if (ticketOutcome.kind === "ok") {
        for (const t of ticketOutcome.rows) if (t.cand_id !== undefined) ticketsById.set(t.cand_id, t);
      }
      // 候選人檔為主；候選人檔不存在（404）時只用得票檔（得票檔也有姓名／政黨／出生年，村里長就是這種情況）
      const baseRows = candOutcome.kind === "ok" ? candOutcome.rows : [...ticketsById.values()];
      const requestedRegion = region === "全國" ? undefined : region;

      const rows = baseRows
        .filter((row) => row.cand_name)
        .map((row) => {
          const ticket = row.cand_id !== undefined ? ticketsById.get(row.cand_id) : undefined;
          return toCecCandidateRow(row, ticket, { electionId, ourType, cecType, themeId: theme.themeId, requestedRegion, deptNames });
        })
        // 全國範圍的檔（總統／縣市長）要再依縣市過濾；filter 用轉換後的 region 比對，跟 fetch-cec-data 邏輯一致
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .filter((r) => !isNationalOnly(cecType) || region === "全國" || r.region === region);

      // 先抓完、確認不是抓取失敗，才在同一個單位內先刪後寫
      const { error: delError } = await supabase.from("cec_candidates").delete().eq("election_id", electionId).eq("election_type", ourType).eq("region", region);
      if (delError) throw new Error(`delete: ${delError.message}`);
      for (let b = 0; b < rows.length; b += INSERT_BATCH_SIZE) {
        const { error: insError } = await supabase.from("cec_candidates").insert(rows.slice(b, b + INSERT_BATCH_SIZE));
        if (insError) throw new Error(`insert: ${insError.message}`);
      }

      units.push({ election_id: electionId, election_type: ourType, region, fetched: baseRows.length, written: rows.length });
    } catch (e) {
      failed.push({ election_id: electionId, election_type: ourType, region, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return new Response(JSON.stringify({ success: true, units, failed, next, elapsed_ms: Date.now() - started }), { headers: { "Content-Type": "application/json" } });
});
