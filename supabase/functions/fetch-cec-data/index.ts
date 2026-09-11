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

const CEC_BASE = "https://db.cec.gov.tw/static/elections";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 PolicyTracker/1.0";

// 選舉類型對應（代碼沿用舊版，與 AdminScraper 一致）
const SUBJECT_MAP: Record<string, { subjectId: string; legisId: string; defaultLevel: string }> = {
  President: { subjectId: "P0", legisId: "00", defaultLevel: "N" },
  Legislator: { subjectId: "L0", legisId: "L1", defaultLevel: "A" },
  Mayor: { subjectId: "C1", legisId: "00", defaultLevel: "C" },
  CountyMayor: { subjectId: "C2", legisId: "00", defaultLevel: "C" },
  CouncilMember: { subjectId: "T1", legisId: "T1", defaultLevel: "A" },
  CountyCouncilMember: { subjectId: "T2", legisId: "T1", defaultLevel: "A" },
  CityMayor: { subjectId: "D2", legisId: "00", defaultLevel: "D" },
  DistrictExecutive: { subjectId: "D1", legisId: "00", defaultLevel: "D" },
  CityRepresentatives: { subjectId: "R2", legisId: "R1", defaultLevel: "A" },
  DistrictRepresentatives: { subjectId: "R1", legisId: "R3", defaultLevel: "A" },
  Village: { subjectId: "V0", legisId: "00", defaultLevel: "L" },
};

// 縣市 → 新版靜態檔的 prv/city 代碼（舊版 CITY_CODE_MAP 的兩碼是舊 API 的，新路徑不能用）
const CITY_CODES: Record<string, { prv: string; city: string }> = {
  "全國": { prv: "00", city: "000" },
  "台北市": { prv: "63", city: "000" }, "新北市": { prv: "65", city: "000" }, "桃園市": { prv: "68", city: "000" },
  "台中市": { prv: "66", city: "000" }, "台南市": { prv: "67", city: "000" }, "高雄市": { prv: "64", city: "000" },
  "宜蘭縣": { prv: "10", city: "002" }, "新竹縣": { prv: "10", city: "004" }, "苗栗縣": { prv: "10", city: "005" },
  "彰化縣": { prv: "10", city: "007" }, "南投縣": { prv: "10", city: "008" }, "雲林縣": { prv: "10", city: "009" },
  "嘉義縣": { prv: "10", city: "010" }, "屏東縣": { prv: "10", city: "013" }, "台東縣": { prv: "10", city: "014" },
  "花蓮縣": { prv: "10", city: "015" }, "澎湖縣": { prv: "10", city: "016" }, "基隆市": { prv: "10", city: "017" },
  "新竹市": { prv: "10", city: "018" }, "嘉義市": { prv: "10", city: "020" },
  "金門縣": { prv: "09", city: "007" }, "連江縣": { prv: "09", city: "020" },
};
const CITY_NAME_BY_CODE = new Map(Object.entries(CITY_CODES).map(([name, c]) => [`${c.prv}_${c.city}`, name]));

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
  candNo?: number;
  gender?: string;
  birthday?: string;
  isCurrent?: boolean;
  votes?: number;
  votePercent?: number;
  elected?: boolean;
}

interface CecRow {
  cand_id?: number;
  cand_name?: string;
  cand_no?: number;
  party_name?: string;
  party_code?: number;
  cand_sex?: string;
  cand_birthday?: string;
  cand_birthyear?: string | number;
  cand_edu?: string;
  is_current?: string;
  is_victor?: string;
  is_vice?: string;
  area_name?: string;
  prv_code?: string;
  city_code?: string;
  area_code?: string;
  dept_code?: string;
  li_code?: string;
  ticket_num?: number;
  ticket_percent?: number;
}

type FetchOutcome =
  | { kind: "ok"; rows: CecRow[]; url: string }
  | { kind: "nodata"; url: string }
  | { kind: "error"; url: string; message: string; preview?: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizeCity(name: string | undefined): string | undefined {
  return name ? name.replace(/臺/g, "台").trim() : undefined;
}

/** 抓一個靜態 JSON 檔；回 HTML／非 JSON 一律當錯誤回報，不靜默。 */
async function fetchCecJson(url: string): Promise<FetchOutcome> {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "User-Agent": USER_AGENT,
      "Referer": "https://db.cec.gov.tw/ElecTable/Election",
    },
  });
  if (response.status === 404) return { kind: "nodata", url };
  const text = await response.text();
  if (!response.ok) return { kind: "error", url, message: `CEC 回應 HTTP ${response.status}`, preview: text.slice(0, 200) };
  const contentType = response.headers.get("content-type") || "";
  if (text.trimStart().startsWith("<") || (!contentType.includes("json") && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("["))) {
    console.error("CEC 回傳 HTML 而非 JSON:", url, text.slice(0, 300));
    return { kind: "error", url, message: "CEC 回傳非 JSON 格式（路徑改版、被阻擋或維護中）", preview: text.slice(0, 200) };
  }
  try {
    const data = JSON.parse(text);
    // 資料檔是 { "<scope>": [rows] }，可能多個 key；清單檔是陣列
    const rows: CecRow[] = Array.isArray(data)
      ? data
      : Object.values(data).flatMap((v) => (Array.isArray(v) ? v : []));
    return { kind: "ok", rows, url };
  } catch (e) {
    return { kind: "error", url, message: `無法解析 CEC JSON: ${(e as Error).message}`, preview: text.slice(0, 200) };
  }
}

function parseBirthYear(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let year = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(year)) return undefined;
  if (year < 1000) year += 1911; // 民國轉西元
  return year;
}

function normalizeParty(raw: string | undefined): string {
  const p = (raw || "").trim();
  if (!p || p === "無" || p === "無黨籍及未經政黨推薦" || p === "無黨籍及未經政黨推薦者") return "無黨籍";
  return p;
}

/** 依選舉層級決定 region / subRegion / village 怎麼從 area_name 與代碼取 */
function locate(
  row: CecRow,
  electionType: string,
  requestedCity: string | undefined,
  deptNames: ReadonlyMap<string, string> = new Map(),
): Pick<CandidateResult, "region" | "subRegion" | "village"> {
  const codeCity = normalizeCity(CITY_NAME_BY_CODE.get(`${row.prv_code}_${row.city_code}`));
  const areaName = normalizeCity(row.area_name);
  const isNationalScope = row.prv_code === "00" && row.city_code === "000";

  if (electionType === "President") return { region: "全國" };
  if (electionType === "Mayor" || electionType === "CountyMayor") {
    // 縣市長：area_name 就是縣市
    return { region: areaName || codeCity || requestedCity || "未知" };
  }
  const region = (isNationalScope ? undefined : codeCity) || requestedCity || (electionType === "Legislator" && areaName ? areaName.replace(/第\d+選區.*$/, "") : undefined) || "未知";
  if (electionType === "Village") {
    return { region, village: areaName, subRegion: row.dept_code ? deptNames.get(row.dept_code) : undefined };
  }
  return { region, subRegion: areaName };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, electionType, themeId, prvCode, cityCode, areaCode, deptCode, liCode, dataLevel, electionId, region } = body;

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
