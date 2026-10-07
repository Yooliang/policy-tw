/**
 * 中選會登記名冊（PDF）的逐位核對（2026-09-24，維護者選 B：只對中選會的登記名冊開放讀 PDF，系統整批逐位核對）。
 *
 * 這是 09-20「系統不解析 PDF」的例外，範圍只限 web.cec.gov.tw/api/file/*.pdf。不用 Jev：純比對。
 * 名冊是逐欄印的——有時一列一位（選舉區 日期 姓名 政黨），有時整欄姓名接著整欄政黨。
 * 解析法照 skill.md 9a：把連續的姓名與接在後面的連續政黨各當成一組，長度相等才依順序配對（不等就整組不收）。
 * 實測（09-24）：wang.shihchieh 當成台中市議員交的 181 位，名冊上 90 位是台中、86 位台南、3 位高雄，2 位找不到。
 *
 * 2026-10-08 起先試「逐列版面」（parseRowLayout）：中選會 115 年登記彙總表九份（縣市長、議員、鄉鎮市長、鄉鎮市民代表、
 * 區長、區民代表、村里長）都是一列一位、地名從縣市名起頭，九份逐份解析出的人數等於 PDF 的登記日期列數（合計 19,695）。
 * 結構對不上的才退回上面的逐欄配對（嘉義縣、宜蘭縣那種日期在前、多性別／出生年月日欄的舊版面）。
 */
import { ALL_REGIONS, normalizeCityName } from "./cec-city-codes.ts";
import { normalizeDistrict } from "./electoral-district.ts";

export const CEC_ROSTER_URL_RE = /^https:\/\/web\.cec\.gov\.tw\/api\/file\/[0-9a-f-]+\.pdf$/i;
export const ROSTER_BATCH_MODEL = "policy-tw/roster-batch-20260924";
/** 整批至少這個比例對得上，系統票才判 supported（對不上的那幾筆照舊逐筆驗） */
export const ROSTER_PASS_RATIO = 0.9;

/**
 * district：名冊那一列的選舉區，統一成「第NN選舉區」；看不出來是 null（2026-10-05 起一起核對）
 * place：縣市以後的地名（鄉鎮市區、村里；逐列版面才有，2026-10-08），例如「竹北市」「松山區莊敬里」；
 *        村里長沒有選舉區欄，鄉鎮市民代表、區民代表有 district
 */
export interface RosterRow { name: string; party: string; region: string | null; district?: string | null; place?: string | null }
/** district：交件的 electoral_district（縣市議員必填，2026-10-05）；沒有就不核選區 */
export interface BatchItem { id: string; name: string; party: string | null; region: string | null; district?: string | null }
export interface BatchCheck { passed: string[]; failed: Array<{ id: string; name: string; reason: string }> }

const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s/g, "").replace(/臺/g, "台");
const HEADER = new Set(["選舉區", "登記日期", "姓名", "推薦之政黨", "備註", "登記之選舉區", "性別", "受理登記機關", "第", "頁", "列印筆數"]);
const isDate = (x: string) => /^(\d{3}\/\d{2}\/\d{2})+$/.test(x);
const isDistrict = (x: string) => x.endsWith("選舉區");
const isParty = (x: string) => x === "無" || x.endsWith("黨") || ["時代力量", "台灣基進", "臺灣基進", "台灣團結聯盟", "綠黨"].includes(x);
// 頁首頁尾、純數字、受理機關（某某選舉委員會）都不是姓名。
// 「年」「頁」只在像頁首頁尾的樣子（115年…、頁，共）才算：姓名裡有「年」（謝昌年）、「頁」不能被當成表頭吃掉（2026-10-08，整列因此少一人）
const isHeader = (x: string) => HEADER.has(x) || /\d年|^頁|製表|選舉委員會|筆數/.test(x) || /^\d+$/.test(x) || isEducation(x) || ["出生年月日", "學歷"].includes(x);
/** 縣市議員名冊多一欄性別：夾在姓名與政黨之間，跟日期一樣略過 */
const isGender = (x: string) => x === "男" || x === "女";
/** 宜蘭縣等名冊多出生年月日（059/**／**）與學歷兩欄：出生年月日略過、學歷當表頭 */
const isBirth = (x: string) => /^\d{3}\/\*\*\/\*\*$/.test(x);
const isEducation = (x: string) => /^(博士|碩士|學士|大學|專科|高中|高職|國中|國小|初中|自修|識字|不識字|其他)$/.test(x) || x.includes("(職)");
/** 「臺中市第01選舉區」→「台中市」 */
const regionOf = (district: string) => norm(district).split("第")[0] || null;
/** 「臺中市第5選舉區」→「第05選舉區」（2026-10-05：以前只拿它推縣市，選區本身丟掉了） */
const districtOf = (district: string) => normalizeDistrict(norm(district))?.district ?? null;

const COUNTY_RE = new RegExp(`^(${ALL_REGIONS.join("|")})`);
/** 這個字串是不是從縣市名起頭（逐列版面每一列的地名都從縣市名開始；「臺」「台」都算） */
const startsWithCounty = (x: string) => COUNTY_RE.test(normalizeCityName(x) ?? x);
/** 兩個字以內的真政黨（其餘兩字以內的碎片是被換行拆開的黨名後半，例如「聯盟」「庭黨」） */
const SHORT_PARTIES = new Set(["無", "新黨", "綠黨", "台聯"]);

/** 姓名欄：中文姓名後面常接原住民族語羅馬拼音（「杜司偉Andrew Isbabanal」），只取前面的中文；整個都是拉丁字就整串留著 */
function rowName(tokens: readonly string[]): string {
  const joined = tokens.join("");
  const cn = joined.replace(/[A-Za-z].*$/s, "").replace(/[\s‧·．.'’ʼ-]+$/u, "");
  return cn || tokens.join(" ");
}

/**
 * 逐列版面（2026-10-08；中選會 115 年登記彙總表九份都是這樣）：每一列是「地名 登記日期 姓名 政黨」，地名從縣市名起頭。
 * 村里長、鄉鎮市長、區長、各種代表都沒有選舉區欄，地名是「縣市鄉鎮 [第N選舉區]」或「縣市鄉鎮 村里」。
 * 以縣市名起頭的字當一列的開頭：列內第一個日期之前都是地名，日期之後到下一列開頭是姓名與政黨。
 * 姓名可以被空白拆成好幾塊（族語姓名、英文名），政黨也可能被換行拆成兩塊（「小民參政歐巴桑 聯盟」），
 * 所以不靠「看起來像政黨」去切，而是最後一塊（或最後兩塊）當政黨、前面全是姓名。
 * 黨名的前半不是兩字以內的碎片、前一塊也不到五個字時（「X 黨」被拆成長短不一的兩塊）切不準：姓名會多吃一塊、政黨只剩後半，
 * 那一列核對不上（交給人逐筆驗），不會誤判通過。
 * 整份只要有一列結構不對（日期不只一個、政黨缺）、或列數不等於日期數，就回傳 null，交給逐欄配對。
 */
function parseRowLayout(seq: ReadonlyArray<{ k: string; x: string }>): RosterRow[] | null {
  const starts: number[] = [];
  seq.forEach((s, i) => { if (s.k !== "T" && startsWithCounty(s.x)) starts.push(i); });
  const dateCount = seq.filter((s) => s.k === "T" && isDate(s.x)).length;
  if (starts.length === 0 || starts.length !== dateCount) return null;
  const out: RosterRow[] = [];
  for (let r = 0; r < starts.length; r++) {
    const seg = seq.slice(starts[r], r + 1 < starts.length ? starts[r + 1] : seq.length);
    const dateAt = seg.findIndex((s) => s.k === "T" && isDate(s.x));
    if (dateAt < 1 || dateAt > 6 || seg.some((s, i) => i > dateAt && s.k === "T" && isDate(s.x))) return null;
    const loc = normalizeCityName(seg.slice(0, dateAt).map((s) => s.x).join("")) ?? "";
    // 日期後面是姓名與政黨；性別、出生年月日（T）與換頁時重印的欄名（「選舉區」「推薦之政黨」，後者因為以黨結尾被認成政黨）略過
    const tail = seg.slice(dateAt + 1).filter((s) => (s.k === "N" || s.k === "P") && !HEADER.has(s.x)).map((s) => s.x);
    // 姓名欄是空的（PDF 抽字漏掉罕用字，整列只剩「地名 日期 政黨」）：這一列仍是一位候選人，姓名留空、不會對上任何人
    if (tail.length === 0 || (tail.length === 1 && !isParty(tail[0]))) return null;
    // 政黨從最後一塊起算；黨名被換行拆開時，後半是兩字以內的碎片（「聯盟」「庭黨」），或前一塊是五個字以上的純中文（姓名不會這麼長）
    let pi = tail.length - 1;
    if (tail.length >= 3 && !SHORT_PARTIES.has(tail[pi]) && (tail[pi].length <= 2 || /^\p{Script=Han}{5,}$/u.test(tail[pi - 1]))) pi--;
    const region = ALL_REGIONS.find((c) => loc.startsWith(c)) ?? null;
    const place = loc.slice(region?.length ?? 0).replace(/(第\s*\d+\s*)?選舉?區$/, "") || null;
    out.push({ name: rowName(tail.slice(0, pi)), party: tail.slice(pi).join(""), region, district: districtOf(loc), place });
  }
  return out;
}

export function parseRoster(text: string): RosterRow[] {
  // 「宜蘭縣第1選舉 區」：換行把選舉區拆成兩段，先接回去
  const toks = text.replace(/選舉\s+區/g, "選舉區").split(/\s+/).filter(Boolean);
  type K = "D" | "T" | "P" | "H" | "N";
  const kind = (x: string): K => isDistrict(x) ? "D" : (isDate(x) || isGender(x) || isBirth(x)) ? "T" : isParty(x) ? "P" : isHeader(x) ? "H" : "N";
  const seq = toks.map((x) => ({ k: kind(x), x })).filter((s) => s.k !== "H");
  const byRow = parseRowLayout(seq);
  if (byRow) return byRow;
  const out: RosterRow[] = [];
  // 選舉區也可能是一整欄：記下姓名前面那一串（上一組政黨之後出現的），長度對得上就逐位配，否則整串同縣市才用、不然不判縣市
  let before: string[] = [];
  const placesFor = (n: number, pre: string[], post: string[]): Array<{ region: string | null; district: string | null }> => {
    const pick = pre.length === n ? pre : post.length === n ? post : null;
    if (pick) return pick.map((d) => ({ region: regionOf(d), district: districtOf(d) }));
    const all = [...pre, ...post];
    const regions = [...new Set(all.map(regionOf).filter(Boolean))];
    const districts = [...new Set(all.map(districtOf).filter(Boolean))];
    // 整串同一個選區才當成每一位的選區；混了好幾個選區就不判（寧可不核，也不要配錯）
    return Array.from({ length: n }, () => ({
      region: regions.length === 1 ? regions[0] : null,
      district: regions.length === 1 && districts.length === 1 ? districts[0] : null,
    }));
  };
  let i = 0;
  while (i < seq.length) {
    const { k, x } = seq[i];
    if (k === "D") { before.push(x); i++; continue; }
    if (k === "P") { before = []; i++; continue; }
    if (k !== "N") { i++; continue; }
    let j = i;
    while (j < seq.length && seq[j].k === "N") j++;
    const names = seq.slice(i, j).map((s) => s.x);
    const after: string[] = [];
    let m = j;
    while (m < seq.length && (seq[m].k === "D" || seq[m].k === "T")) { if (seq[m].k === "D") after.push(seq[m].x); m++; }
    let q = m;
    while (q < seq.length && seq[q].k === "P") q++;
    const parties = seq.slice(m, q).map((s) => s.x);
    if (parties.length === names.length) {
      const places = placesFor(names.length, before, after);
      names.forEach((n, idx) => out.push({ name: n, party: parties[idx], ...places[idx] }));
      before = [];
      i = q;
    } else if (parties.length > 0 && names.length === 1) {
      out.push({ name: names[0], party: parties[0], ...placesFor(1, before.slice(-1), after.slice(0, 1))[0] });
      before = [];
      i = m + 1;
    } else {
      i = j; // 長度對不上：這一組不配對（寧可少收，也不要配錯）
    }
  }
  return out;
}

const partyNorm = (p: string | null | undefined) => {
  const v = norm(p);
  return ["", "無", "無黨籍", "無黨籍及未經政黨推薦", "無黨"].includes(v) ? "無" : v;
};

export function checkBatch(rows: readonly RosterRow[], batch: readonly BatchItem[]): BatchCheck {
  const byName = new Map<string, RosterRow[]>();
  for (const r of rows) byName.set(norm(r.name), [...(byName.get(norm(r.name)) ?? []), r]);
  const passed: string[] = [];
  const failed: BatchCheck["failed"] = [];
  for (const b of batch) {
    const hits = byName.get(norm(b.name)) ?? [];
    if (hits.length === 0) { failed.push({ id: b.id, name: b.name, reason: "名冊上找不到這個姓名" }); continue; }
    const inRegion = b.region ? hits.filter((h) => !h.region || h.region === norm(b.region)) : hits;
    if (inRegion.length === 0) { failed.push({ id: b.id, name: b.name, reason: `名冊上的縣市是 ${hits.map((h) => h.region).join("／")}，不是 ${b.region}` }); continue; }
    if (b.party && !inRegion.some((h) => partyNorm(h.party) === partyNorm(b.party))) {
      failed.push({ id: b.id, name: b.name, reason: `名冊上的政黨是 ${inRegion.map((h) => h.party).join("／")}，不是 ${b.party}` });
      continue;
    }
    // 選舉區（2026-10-05）：交件有給、名冊那一列也看得出選區時才比；縣市議員交件 1.48.0 起必填選區，
    // 「名冊吻合一票就過」不核選區的話，抄錯的選區也會一票過關
    const given = b.district ? normalizeDistrict(b.district)?.district ?? b.district : null;
    const known = inRegion.filter((h) => h.district);
    if (given && known.length > 0 && !known.some((h) => h.district === given)) {
      failed.push({ id: b.id, name: b.name, reason: `名冊上的選舉區是 ${known.map((h) => h.district).join("／")}，不是 ${given}` });
      continue;
    }
    passed.push(b.id);
  }
  return { passed, failed };
}

/** PDF 抽字：只給中選會名冊用（見檔頭）。import 必須是字串字面值，放變數線上會 Module not found */
export async function cecRosterText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!CEC_ROSTER_URL_RE.test(url)) throw new Error("只收中選會名冊網址（web.cec.gov.tw/api/file/*.pdf）");
  const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; policy-tw-roster/1.0)" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`名冊下載失敗 HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1?no-dts") as unknown as {
    getDocumentProxy(data: Uint8Array): Promise<unknown>;
    extractText(pdf: unknown, opts: { mergePages: true }): Promise<{ text: string | string[] }>;
  };
  const { text } = await extractText(await getDocumentProxy(buf), { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}
