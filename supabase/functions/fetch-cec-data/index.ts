import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 選舉類型對應
const SUBJECT_MAP: Record<string, { subjectId: string; legisId: string; type: string }> = {
  President: { subjectId: "P0", legisId: "00", type: "President" },
  Legislator: { subjectId: "L0", legisId: "L1", type: "Legislator" },
  Mayor: { subjectId: "C1", legisId: "00", type: "Mayor" },
  CountyMayor: { subjectId: "C2", legisId: "00", type: "CountyMayor" },
  CouncilMember: { subjectId: "T1", legisId: "T1", type: "CouncilMember" },
  CountyCouncilMember: { subjectId: "T2", legisId: "T1", type: "CountyCouncilMember" },
  CityMayor: { subjectId: "D2", legisId: "00", type: "CityMayor" },
  DistrictExecutive: { subjectId: "D1", legisId: "00", type: "DistrictExecutive" },
  CityRepresentatives: { subjectId: "R2", legisId: "R1", type: "CityRepresentatives" },
  DistrictRepresentatives: { subjectId: "R1", legisId: "R3", type: "DistrictRepresentatives" },
  Village: { subjectId: "V0", legisId: "00", type: "Village" },
};

// 縣市代碼對應
const CITY_CODE_MAP: Record<string, string> = {
  "台北市": "63", "高雄市": "64", "新北市": "65", "台中市": "66",
  "桃園市": "67", "台南市": "68", "宜蘭縣": "10", "新竹縣": "01",
  "苗栗縣": "02", "彰化縣": "03", "南投縣": "04", "雲林縣": "05",
  "嘉義縣": "06", "屏東縣": "07", "台東縣": "08", "花蓮縣": "09",
  "澎湖縣": "11", "基隆市": "12", "新竹市": "13", "嘉義市": "14",
  "金門縣": "15", "連江縣": "16",
};

// 選舉類型中文名稱
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
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { electionType, themeId, prvCode, cityCode, deptCode, dataLevel, electionId } = await req.json();

    if (!electionType || !themeId) {
      return new Response(
        JSON.stringify({ error: "缺少必要參數 electionType 或 themeId" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const subject = SUBJECT_MAP[electionType];
    if (!subject) {
      return new Response(
        JSON.stringify({ error: `不支援的選舉類型: ${electionType}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 組成 API URL
    const apiUrl = new URL("https://db.cec.gov.tw/ElecTable/Election/ElecTickets");
    apiUrl.searchParams.set("dataType", "tickets");
    apiUrl.searchParams.set("typeId", "ELC");
    apiUrl.searchParams.set("subjectId", subject.subjectId);
    apiUrl.searchParams.set("legisId", subject.legisId);
    apiUrl.searchParams.set("themeId", themeId);
    apiUrl.searchParams.set("dataLevel", dataLevel || "N");
    apiUrl.searchParams.set("prvCode", prvCode || "00");
    apiUrl.searchParams.set("cityCode", cityCode || "000");
    apiUrl.searchParams.set("areaCode", "00");
    apiUrl.searchParams.set("deptCode", deptCode || "000");
    apiUrl.searchParams.set("liCode", "0000");

    console.log(`Fetching: ${apiUrl.toString()}`);

    const response = await fetch(apiUrl.toString(), {
      headers: {
        "Accept": "application/json, text/html, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://db.cec.gov.tw/ElecTable/Election",
        "Origin": "https://db.cec.gov.tw",
      },
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `API 請求失敗: ${response.status}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 檢查回應類型
    const contentType = response.headers.get("content-type") || "";
    const responseText = await response.text();

    if (!contentType.includes("application/json") && responseText.startsWith("<!")) {
      console.error("CEC API 回傳 HTML 而非 JSON:", responseText.substring(0, 500));
      return new Response(
        JSON.stringify({ error: "CEC API 回傳非 JSON 格式（可能被阻擋或網站維護中）", html_preview: responseText.substring(0, 200) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error("JSON 解析失敗:", responseText.substring(0, 500));
      return new Response(
        JSON.stringify({ error: "無法解析 API 回應", raw: responseText.substring(0, 200) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 解析候選人資料
    const candidates: CandidateResult[] = [];
    const electionTypeName = ELECTION_TYPE_MAP[electionType] || electionType;

    // 根據 API 回傳格式解析資料
    if (data.candTksInfo && Array.isArray(data.candTksInfo)) {
      for (const cand of data.candTksInfo) {
        // 解析政黨
        let party = cand.party || cand.partyName || "無黨籍";
        if (party === "無" || party === "無黨籍及未經政黨推薦") {
          party = "無黨籍";
        }

        // 解析出生年
        let birthYear: number | undefined;
        if (cand.birthYear) {
          birthYear = parseInt(cand.birthYear);
          if (birthYear < 1000) {
            birthYear += 1911; // 民國轉西元
          }
        }

        // 解析地區
        const region = cand.prvName || cand.cityName || "未知";
        const subRegion = cand.deptName || cand.areaName || undefined;
        const village = cand.liName || undefined;

        candidates.push({
          name: cand.name || cand.candName,
          party,
          position: `${electionTypeName}候選人`,
          region,
          subRegion,
          village,
          birthYear,
          educationLevel: cand.eduName || undefined,
          electionType: electionTypeName,
          electionId: electionId || 1,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        candidates,
        total: candidates.length,
        apiUrl: apiUrl.toString()
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
