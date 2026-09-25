import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * fetch-cec-data — 從中選會選舉資料庫抓候選人（含得票）
 *
 * 2026-09 中選會改版：舊的 `ElecTable/Election/ElecTickets?...` 現在回整頁 HTML。
 * 新格式是靜態 JSON、不用認證：
 *   清單   https://db.cec.gov.tw/static/elections/list/ELC_{subjectId}.json
 *   候選人 https://db.cec.gov.tw/static/elections/data/candidates/ELC/{subjectId}/{legisId}/{themeId}/{dataLevel}/{prv}_{city}_{area}_{dept}_{li}.json
 *   得票   同路徑把 candidates 換成 tickets
 * 檔名是「查詢範圍」、dataLevel 是「回傳列的粒度」（2026-09-11 實抓驗證）：
 *   縣市長 C2  全國範圍、縣市粒度 → C/00_000_00_000_0000.json（county 範圍的 C/10_007_… 是 404）
 *   議員   T2  縣市範圍、選區粒度 → A/10_007_00_000_0000.json（彰化縣）
 *   立委   L0  縣市範圍、選區粒度 → A/10_007_00_000_0000.json；全國 N/00_000_00_000_0000.json
 *   村里長 V0  candidates 檔沒有縣市範圍的版本，只有 tickets → 自動退回只用 tickets
 * 候選人檔與得票檔用 cand_id 合併；候選人檔 404 時只用得票檔（得票檔也有姓名／政黨／出生年）。
 *
 * 請求（相容舊介面）：{ electionType, themeId, prvCode?, cityCode?, areaCode?, deptCode?, liCode?, dataLevel?, electionId?, region? }
 *   - region 給縣市名（如「彰化縣」）可代替 prvCode/cityCode
 *   - action: "list" 回該 electionType 的可用選舉（themeId、年份、投票日）
 * 回應：{ success, candidates: CandidateResult[], total, apiUrl, ticketsUrl, nodata? }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { CEC_DATA_URL, CEC_QUERY_URL, normalizeCandidacies, withoutFutureResults } from "../_shared/cec-candidate.ts";
import { CITY_CODES, CITY_NAME_BY_CODE, normalizeCityName as normalizeCity } from "../_shared/cec-city-codes.ts";
import {
  CEC_BASE,
  type CecRow,
  fetchCecJson,
  locateRow as locate,
  normalizeParty,
  parseBirthYear,
  SUBJECT_MAP,
  USER_AGENT,
} from "../_shared/cec-static-fetch.ts";


const ELECTION_TYPE_MAP: Record<string, string> = {
  President: "總統副總統",
  Legislator: "立法委員",
  Mayor: "直轄市長",
  CountyMayor: "縣市長",
  CouncilMember: "直轄市議員",
  CountyCouncilMember: "縣市議員",
  CityMayor: "鄉鎮市長",
  DistrictExecutive: "直轄市山地原住民區長",
  CityRepresentatives: "鄉鎮市民代表",
  DistrictRepresentatives: "直轄市山地原住民區民代表",
  Village: "村里長",
};

interface CandidateResult {
  name: string;
  party: string;
  position: string;
  region: string;
  subRegion?: string;
  village?: string;
  birthYear?: number;
  educationLevel?: string;
  electionType: string;
  electionId?: number;
  // 2026-09 新增（相容：舊呼叫端忽略即可）
  cecCandId?: number;
  /** cand_id 每場選舉重編，要和 themeId 一起才是識別碼 */
  cecThemeId?: string;
  candNo?: number;
  gender?: string;
  birthday?: string;
  isCurrent?: boolean;
  votes?: number;
  votePercent?: number;
  elected?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function handleList(electionType: string): Promise<Response> {
  const subject = SUBJECT_MAP[electionType];
  if (!subject) return json({ error: `不支援的選舉類型: ${electionType}` }, 400);
  const url = `${CEC_BASE}/list/ELC_${subject.subjectId}.json`;
  const outcome = await fetchCecJson(url);
  if (outcome.kind !== "ok") return json({ success: false, error: outcome.kind === "nodata" ? "找不到清單" : outcome.message, apiUrl: url });
  // deno-lint-ignore no-explicit-any
  const themes = (outcome.rows as any[]).flatMap((area) => (area.theme_items || []).map((t: any) => ({
    themeId: t.theme_id,
    themeName: t.theme_name,
    session: t.session,
    voteDate: t.vote_date,
    year: t.vote_date ? parseInt(String(t.vote_date).slice(0, 4), 10) : undefined,
    dataLevel: t.data_level,
    areaName: area.area_name,
  })));
  return json({ success: true, electionType, themes, apiUrl: url });
}


/**
 * 按姓名查中選會：回這個人歷屆的參選紀錄（含當選與否、出生年、政黨、選區）。
 * 帶 electionId 就只回那一屆，並附上該選區逐位候選人的得票（用來核對得票數與得票率）。
 */
async function handleByName(name: string, electionId?: number): Promise<Response> {
  const queryUrl = `${CEC_QUERY_URL}?${new URLSearchParams({ cand_name: name })}`;
  const res = await fetch(queryUrl, { headers: { "User-Agent": USER_AGENT, Referer: "https://db.cec.gov.tw/" } });
  if (!res.ok) return json({ error: `中選會查詢失敗（HTTP ${res.status}）`, apiUrl: queryUrl }, 502);
  const raw = await res.json();
  const all = withoutFutureResults(normalizeCandidacies(raw?.cand_data_list ?? []));
  const picked = electionId ? all.filter((c) => c.election_id === electionId) : all;

  // 指定屆別時順便把該場的得票抓回來：代理要填 votes_received／vote_percentage
  let tickets: unknown = null;
  let ticketsUrl: string | null = null;
  const one = picked[0];
  if (electionId && one?.theme_id && one?.cand_id) {
    ticketsUrl = `${CEC_DATA_URL}?theme_id=${one.theme_id}&cand_id=${one.cand_id}`;
    const tRes = await fetch(ticketsUrl, { headers: { "User-Agent": USER_AGENT, Referer: "https://db.cec.gov.tw/" } });
    if (tRes.ok) tickets = await tRes.json();
  }

  return json({
    success: true,
    name,
    total: picked.length,
    candidacies: picked,
    tickets,
    apiUrl: queryUrl,
    ticketsUrl,
    note: picked.length === 0
      ? "中選會查無此姓名；可能是尚未登記、姓名用字不同（例如「臺」與「台」），或那一屆還沒公告"
      : "同名同姓會一起回；請用選區、政黨、出生年確認是不是同一個人",
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, electionType, themeId, prvCode, cityCode, areaCode, deptCode, liCode, dataLevel, electionId, region, queryName } = body;

    // 按姓名查歷屆參選（2026-09-17 新增）。上面那條路是「某場選舉某地區的整份名單」，
    // 這條是「這個人哪幾屆選過、選上了沒有、拿幾票」——election_result_missing 與
    // candidacy_source_missing 要的就是後者，而代理原本被指去 db.cec.gov.tw 那個 SPA，
    // curl 抓不到任何東西。管理介面之後要做「中選會官方核對」也接這一支。
    if (queryName || action === "candidate") {
      const name = String(queryName ?? body.name ?? "").trim();
      if (!name) return json({ error: "缺少必要參數 queryName（候選人姓名）" }, 400);
      return await handleByName(name, electionId ? Number(electionId) : undefined);
    }

    if (action === "list") {
      if (!electionType) return json({ error: "缺少必要參數 electionType" }, 400);
      return await handleList(electionType);
    }

    if (!electionType || !themeId) {
      return json({ error: "缺少必要參數 electionType 或 themeId" }, 400);
    }
    const subject = SUBJECT_MAP[electionType];
    if (!subject) {
      return json({ error: `不支援的選舉類型: ${electionType}` }, 400);
    }

    const requestedCity = normalizeCity(region);
    const cityCodes = requestedCity ? CITY_CODES[requestedCity] : undefined;
    if (requestedCity && !cityCodes) {
      return json({ error: `不認得的縣市: ${region}` }, 400);
    }
    // 總統／縣市長只有全國範圍的檔（縣市範圍 10_007_… 是 404）：指定縣市時改抓全國檔再過濾
    const nationalOnly = electionType === "President" || electionType === "Mayor" || electionType === "CountyMayor";
    const filterCity = nationalOnly ? (requestedCity || normalizeCity(CITY_NAME_BY_CODE.get(`${prvCode}_${cityCode}`))) : undefined;
    const prv = nationalOnly ? "00" : (prvCode || cityCodes?.prv || "00");
    const city = nationalOnly ? "000" : (cityCode || cityCodes?.city || "000");
    const scope = `${prv}_${city}_${areaCode || "00"}_${deptCode || "000"}_${liCode || "0000"}`;
    const level = dataLevel || subject.defaultLevel;
    const pathTail = `ELC/${subject.subjectId}/${subject.legisId}/${themeId}/${level}/${scope}.json`;
    const candidatesUrl = `${CEC_BASE}/data/candidates/${pathTail}`;
    const ticketsUrl = `${CEC_BASE}/data/tickets/${pathTail}`;

    console.log(`Fetching CEC: ${candidatesUrl}`);
    const [candOutcome, ticketOutcome] = await Promise.all([fetchCecJson(candidatesUrl), fetchCecJson(ticketsUrl)]);

    if (candOutcome.kind === "error") return json({ success: false, error: candOutcome.message, html_preview: candOutcome.preview, apiUrl: candidatesUrl });
    if (ticketOutcome.kind === "error") return json({ success: false, error: ticketOutcome.message, html_preview: ticketOutcome.preview, apiUrl: ticketsUrl });
    if (candOutcome.kind === "nodata" && ticketOutcome.kind === "nodata") {
      return json({ success: true, candidates: [], total: 0, nodata: true, apiUrl: candidatesUrl, ticketsUrl });
    }

    // 村里長：area_name 是里名，鄉鎮市區名要另抓 areas 檔用 dept_code 對
    const deptNames = new Map<string, string>();
    if (electionType === "Village") {
      const areasUrl = `${CEC_BASE}/data/areas/ELC/${subject.subjectId}/${subject.legisId}/${themeId}/D/${prv}_${city}_00_000_0000.json`;
      const areasOutcome = await fetchCecJson(areasUrl);
      if (areasOutcome.kind === "ok") {
        for (const a of areasOutcome.rows) if (a.dept_code && a.area_name) deptNames.set(a.dept_code, a.area_name);
      } else {
        console.warn("CEC areas 檔抓不到，村里長 subRegion 會是空的:", areasUrl, areasOutcome.kind);
      }
    }

    // 以 cand_id 合併：候選人檔為主（有生日／學歷／現任），得票檔補得票；候選人檔不存在就只用得票檔
    const ticketsById = new Map<number, CecRow>();
    if (ticketOutcome.kind === "ok") {
      for (const t of ticketOutcome.rows) if (t.cand_id !== undefined) ticketsById.set(t.cand_id, t);
    }
    const baseRows = candOutcome.kind === "ok" ? candOutcome.rows : [...ticketsById.values()];

    const electionTypeName = ELECTION_TYPE_MAP[electionType] || electionType;
    const candidates: CandidateResult[] = baseRows
      .filter((row) => row.cand_name)
      .filter((row) => !filterCity || filterCity === "全國" || normalizeCity(row.area_name) === filterCity)
      .map((row) => {
        const ticket = row.cand_id !== undefined ? ticketsById.get(row.cand_id) : undefined;
        const merged: CecRow = { ...(ticket ?? {}), ...row };
        const position = electionType === "President"
          ? ((merged.is_vice || ticket?.is_vice) === "Y" ? "副總統候選人" : "總統候選人")
          : `${electionTypeName}候選人`;
        const elected = (ticket?.is_victor ?? merged.is_victor ?? "").trim() === "*";
        return {
          name: merged.cand_name!.trim(),
          party: normalizeParty(merged.party_name),
          position,
          ...locate(merged, electionType, requestedCity, deptNames),
          birthYear: parseBirthYear(merged.cand_birthyear),
          educationLevel: merged.cand_edu || undefined,
          electionType: electionTypeName,
          electionId: electionId || 1,
          cecCandId: merged.cand_id,
          cecThemeId: themeId,
          candNo: merged.cand_no,
          gender: merged.cand_sex === "1" ? "男" : merged.cand_sex === "2" ? "女" : undefined,
          birthday: merged.cand_birthday || undefined,
          isCurrent: merged.is_current === "Y",
          votes: ticket?.ticket_num,
          votePercent: ticket?.ticket_percent,
          elected,
        };
      });

    return json({
      success: true,
      candidates,
      total: candidates.length,
      apiUrl: candidatesUrl,
      ticketsUrl,
      candidatesFileMissing: candOutcome.kind === "nodata",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("fetch-cec-data error:", message);
    return json({ error: message }, 500);
  }
});
