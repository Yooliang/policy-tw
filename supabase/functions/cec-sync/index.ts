import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { CEC_BASE, fetchCecJson, SUBJECT_MAP } from "../_shared/cec-static-fetch.ts";
import {
  type CecFetchDeps,
  collectUnitRows,
  electionDistrictRows,
  HEADLINE_TURNOUT_CEC_TYPES,
  headlineTurnout,
  OUR_ELECTION_TYPES,
  planElectionUnits,
  type SyncElection,
  type SyncUnitPlan,
  type ThemeInfo,
  themesFromList,
  votedElections,
} from "../_shared/cec-sync.ts";

/**
 * cec-sync — 把中選會「已投票選舉」的候選人名單同步進 cec_candidates（供比對用的快照）。
 *
 * 比照 moi-sync 的寫法：不驗 JWT（讓排程打得到），函式內用 service role 連 DB；
 * 同一個同步單位（屆別×選舉別×縣市）在 MIN_INTERVAL_HOURS 內同步過就空轉，防止重複打中選會，
 * 帶 { force: true } 可以跳過這個檢查。
 *
 * 同步單位＝屆別×選舉別×縣市（見 _shared/cec-sync.ts 的 planUnits）：先把該單位的候選人＋得票
 * 抓完、確認不是抓取失敗，才在同一個單位內「先刪後寫」；抓失敗就跳過那個單位、保留舊資料，
 * 回應的 failed[] 會列出來。議員、鄉鎮市民代表的單位連原住民選區一起抓（同一個範圍，見 SyncUnitPlan.extraCecTypes），
 * 一個單位要打的請求變成兩三倍，2022 縣市議員一次呼叫跑不完——排程另有 19:05／19:10 的接續呼叫
 * （24 小時內同步過的單位會空轉，等於從上一次停下的地方接著跑；migration 20261005004000）。
 *
 * 一次呼叫可能超時（Edge Function 上限約 150 秒，村里長 2022 一屆就有約 1.3 萬人）：
 * 用 TIME_BUDGET_MS 頂住，時間到了就停在目前的同步單位，回應的 next 告訴呼叫端下次從哪個單位繼續。
 * 也可以用 { election_id, election_type } 只跑一種，通常一種類型的 22 個縣市可以在一次呼叫內跑完。
 *
 * 2026-10-06（#344）：每個單位寫完名單，順手把名單上的選舉區記進 election_districts（只新增、不改既有的；
 * 名額只寫法律定死的首長一席與立委席次，議員、代表的名額走 district_seats_missing 任務）；這次有跑到縣市長或總統的屆別，
 * 另抓中選會投票概況算投票率寫進 elections.turnout（直轄市長＋縣市長兩場加總；總統那一場）。
 *
 * 2026-10-06（#344 第二階段 A）：要同步哪些選舉、每場選哪些職位、場次對哪一天，都由 elections 表決定（election_date、election_types），
 * 不再寫死三屆；補選、重行選舉（election_key 最後一段是行政區代碼）只同步它的那個縣市。2022 嘉義市長重行選舉（2022-12-18）
 * 是自己的一場選舉，名單記在它自己的 election_id 底下。
 *
 * 請求 body（都可省略）：
 *   { election_id?: number, election_key?: string, election_type?: string, resume_from?: { election_id, election_type, region }, force?: boolean }
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

/** 中選會「該科目可用選舉」清單（ELC_<科目>.json）；呼叫端依科目快取，同一份清單（例如議員的區域與原住民選區）只抓一次 */
async function listThemes(subjectId: string): Promise<ThemeInfo[]> {
  const url = `${CEC_BASE}/list/ELC_${subjectId}.json`;
  const outcome = await fetchCecJson(url);
  // 抓不到就回空清單：collectPart 會因為「找不到場次」整個單位跳過、保留舊資料，不會當成沒有人去刪
  if (outcome.kind !== "ok") return [];
  return themesFromList(outcome.rows);
}

interface SyncUnit {
  election: SyncElection;
  electionId: number;
  ourType: string;
  region: string;
  /** 全國一個選區的立委要再分一層（見 _shared/cec-sync.ts 的 SyncUnitPlan.subRegion） */
  subRegion?: string;
  /** 要打哪些科目（主科目＋同範圍的原住民選區） */
  plan: SyncUnitPlan;
}

function buildUnits(elections: readonly SyncElection[], ourTypes?: readonly string[]): SyncUnit[] {
  const units: SyncUnit[] = [];
  for (const election of elections) {
    for (const { ourType, plan } of planElectionUnits(election, ourTypes)) {
      units.push({ election, electionId: election.id, ourType, region: plan.region, subRegion: plan.subRegion, plan });
    }
  }
  return units;
}

function unitKey(u: Pick<SyncUnit, "electionId" | "ourType" | "region" | "subRegion">): string {
  return `${u.electionId}|${u.ourType}|${u.region}|${u.subRegion ?? ""}`;
}

interface UnitReport {
  election_id: number;
  election_type: string;
  region: string;
  sub_region?: string;
  fetched: number;
  written: number;
  skipped?: string;
  /** 這個單位實際用了哪些場次：「科目:場次 id:寫入筆數」 */
  themes?: string[];
  /** 名單上的選舉區幾個（寫進 election_districts，既有的不動）；寫失敗時是錯誤訊息 */
  districts?: number | string;
}

interface UnitFailure {
  election_id: number;
  election_type: string;
  region: string;
  sub_region?: string;
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
  const electionKeyFilter = qp("election_key") !== undefined ? String(qp("election_key")) : undefined;
  const electionTypeFilter = qp("election_type") !== undefined ? String(qp("election_type")) : undefined;
  const force = qp("force") === true || qp("force") === "true";
  const resumeFromRaw = body.resume_from as { election_id?: number; election_type?: string; region?: string; sub_region?: string } | undefined;
  const resumeFromKey = resumeFromRaw?.election_id !== undefined && resumeFromRaw?.election_type && resumeFromRaw?.region
    ? unitKey({
      electionId: Number(resumeFromRaw.election_id),
      ourType: String(resumeFromRaw.election_type),
      region: String(resumeFromRaw.region),
      subRegion: resumeFromRaw.sub_region ? String(resumeFromRaw.sub_region) : undefined,
    })
    : undefined;

  if (electionTypeFilter && !(OUR_ELECTION_TYPES as readonly string[]).includes(electionTypeFilter)) {
    return new Response(JSON.stringify({ success: false, error: `不認得的 election_type: ${electionTypeFilter}` }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 選舉清單以 elections 表為準（#344 第二階段 A）：已投票的、每場選哪些職位、投票日
  // query-bounds: ok — elections 一共幾列（每場選舉一列）
  const { data: electionRows, error: electionsError } = await supabase
    .from("elections")
    .select("id, election_key, election_date, election_reason, election_types")
    .order("election_date", { ascending: true })
    .limit(500);
  if (electionsError || !electionRows) {
    return new Response(JSON.stringify({ success: false, error: `讀不到 elections 表：${electionsError?.message ?? "沒有資料"}` }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const allElections: SyncElection[] = (electionRows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    election_key: String(r.election_key),
    election_date: String(r.election_date).slice(0, 10),
    election_reason: String(r.election_reason ?? "regular"),
    election_types: Array.isArray(r.election_types) ? (r.election_types as unknown[]).map(String) : [],
  }));
  const voted = votedElections(allElections);
  let elections: SyncElection[] = voted;
  if (electionIdFilter !== undefined || electionKeyFilter !== undefined) {
    const picked = allElections.find((e) => (electionIdFilter === undefined || e.id === electionIdFilter) && (electionKeyFilter === undefined || e.election_key === electionKeyFilter));
    if (!picked) {
      return new Response(JSON.stringify({ success: false, error: `不認得的選舉（election_id=${electionIdFilter ?? "-"}、election_key=${electionKeyFilter ?? "-"}）；現有：${allElections.map((e) => `${e.id}=${e.election_key}`).join("、")}` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!voted.some((e) => e.id === picked.id) && !force) {
      return new Response(
        JSON.stringify({ success: false, error: `${picked.election_key}（id ${picked.id}）還沒投票；已投票的選舉是 ${voted.map((e) => `${e.id}=${e.election_key}`).join("、")}（真要跑就加 force: true）` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    elections = [picked];
  }

  const allUnits = buildUnits(elections, electionTypeFilter ? [electionTypeFilter] : undefined);
  let startIndex = 0;
  if (resumeFromKey) {
    const idx = allUnits.findIndex((u) => unitKey(u) === resumeFromKey);
    // next 給的就是「下一個要處理的單位」本身，從它開始（原本 idx+1 會把它跳過：09-26 金門縣村里長整個漏掉、回應還是 success）
    if (idx >= 0) startIndex = idx;
  }

  // 場次清單依科目快取（同一份 ELC_<科目>.json 只抓一次）；每個打中選會的請求前都先等 MIN_REQUEST_INTERVAL_MS
  const themeCache = new Map<string, ThemeInfo[]>();
  const deps: CecFetchDeps = {
    themes: async (cecType) => {
      const subjectId = SUBJECT_MAP[cecType]?.subjectId;
      if (!subjectId) return [];
      if (!themeCache.has(subjectId)) {
        await sleep(MIN_REQUEST_INTERVAL_MS);
        themeCache.set(subjectId, await listThemes(subjectId));
      }
      return themeCache.get(subjectId) ?? [];
    },
    fetchJson: async (fileUrl) => {
      await sleep(MIN_REQUEST_INTERVAL_MS);
      return await fetchCecJson(fileUrl);
    },
  };
  const units: UnitReport[] = [];
  const failed: UnitFailure[] = [];
  const started = Date.now();
  let next: { election_id: number; election_type: string; region: string; sub_region?: string } | null = null;

  for (let i = startIndex; i < allUnits.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      const u = allUnits[i];
      next = { election_id: u.electionId, election_type: u.ourType, region: u.region, ...(u.subRegion ? { sub_region: u.subRegion } : {}) };
      break;
    }
    const unit = allUnits[i];
    const { electionId, ourType, region, subRegion } = unit;
    // 同步範圍（查最近同步時間、先刪後寫都用這一個）：全國一個選區的立委三種同在 region＝全國，要再用 sub_region 分開
    // deno-lint-ignore no-explicit-any
    const scoped = (q: any) => {
      const base = q.eq("election_id", electionId).eq("election_type", ourType).eq("region", region);
      return subRegion ? base.eq("sub_region", subRegion) : base;
    };

    try {
      // 防重入：這個單位最近同步過就空轉，不再打中選會（force 可以跳過）
      if (!force) {
        // query-bounds: ok — 下面接 .limit(1).maybeSingle()；scoped() 只加 eq 條件
        const { data: last } = await scoped(supabase
          .from("cec_candidates")
          .select("synced_at"))
          .order("synced_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastSyncedAt = (last as { synced_at?: string } | null)?.synced_at;
        if (lastSyncedAt && Date.now() - Date.parse(lastSyncedAt) < MIN_INTERVAL_HOURS * 3600_000) {
          units.push({ election_id: electionId, election_type: ourType, region, ...(subRegion ? { sub_region: subRegion } : {}), fetched: 0, written: 0, skipped: `${MIN_INTERVAL_HOURS} 小時內同步過` });
          continue;
        }
      }

      // 主科目＋同範圍的原住民選區全部抓完、確認不是抓取失敗（找不到場次、檔案回非 404 的錯）才往下；
      // 縣市長這種同屆有「重行選舉」另一筆場次的，collectPart 會依序試到抓得到這個縣市的人為止（嘉義市 2022）
      const got = await collectUnitRows(unit.election, ourType, unit.plan, deps);
      const rows = got.rows;

      // 先抓完、確認不是抓取失敗，才在同一個單位內先刪後寫
      const { error: delError } = await scoped(supabase.from("cec_candidates").delete());
      if (delError) throw new Error(`delete: ${delError.message}`);
      for (let b = 0; b < rows.length; b += INSERT_BATCH_SIZE) {
        const { error: insError } = await supabase.from("cec_candidates").insert(rows.slice(b, b + INSERT_BATCH_SIZE));
        if (insError) throw new Error(`insert: ${insError.message}`);
      }

      // 選舉區（#344）：名單寫進去了才記；只新增、不改既有的列（名額、依據都不會被同步洗掉）。
      // 寫不成不影響名單本身，只在回應裡記錯誤
      let districts: number | string = 0;
      try {
        const districtRows = electionDistrictRows(electionId, ourType, got.parts);
        for (let b = 0; b < districtRows.length; b += INSERT_BATCH_SIZE) {
          const { error: dError } = await supabase.from("election_districts")
            .upsert(districtRows.slice(b, b + INSERT_BATCH_SIZE), { onConflict: "election_id,election_type,region,sub_region,village", ignoreDuplicates: true });
          if (dError) throw new Error(dError.message);
        }
        districts = districtRows.length;
      } catch (e) {
        districts = `選舉區沒寫成：${e instanceof Error ? e.message : String(e)}`;
      }

      units.push({
        election_id: electionId, election_type: ourType, region, ...(subRegion ? { sub_region: subRegion } : {}),
        fetched: got.fetched, written: rows.length,
        themes: got.parts.map((p) => `${p.cecType}:${p.themeId}:${p.rows.length}`),
        districts,
      });
    } catch (e) {
      failed.push({ election_id: electionId, election_type: ourType, region, ...(subRegion ? { sub_region: subRegion } : {}), error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 投票率（#344）：這次有跑到縣市長或總統的屆別才抓（三四個請求）；抓不到就不寫，不影響名單同步
  const turnout: Array<{ election_id: number; value?: number; election_type?: string; error?: string }> = [];
  if (electionTypeFilter === undefined ? true : electionTypeFilter in HEADLINE_TURNOUT_CEC_TYPES) {
    for (const election of elections) {
      const electionId = election.id;
      if (!election.election_types.some((t) => t in HEADLINE_TURNOUT_CEC_TYPES)) continue;
      try {
        const got = await headlineTurnout(election, deps);
        if (!got) continue;
        // 同一個值再寫一次無害（每週一次）；中選會改了數字就跟著改
        const { error: tError } = await supabase.from("elections").update({ turnout: got.value }).eq("id", electionId);
        if (tError) throw new Error(tError.message);
        turnout.push({ election_id: electionId, value: got.value, election_type: got.election_type });
      } catch (e) {
        turnout.push({ election_id: electionId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return new Response(JSON.stringify({ success: true, units, failed, next, turnout, elapsed_ms: Date.now() - started }), { headers: { "Content-Type": "application/json" } });
});
