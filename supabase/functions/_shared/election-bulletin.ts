/**
 * 中選會選舉公報（eebulletin.cec.gov.tw）對到選舉單位（2026-10-06，維護者點頭）。
 *
 * 起因：a-zhen 交「查無異動」說台南安南區四草里 2022 里長吳文振查無政見；實際上
 * eebulletin.cec.gov.tw/111/06臺南市/05村里長/36安南/四草里.pdf 就列了他四條政見。
 * 公報是候選人自己登記的政見原文，每一位參選人都有——推得出公報網址，就該由系統直接派「照公報補政見」。
 *
 * ## 公報站的結構（2026-10-06 依 ?action=sitemap 全站清單盤點）
 * `/<民國年>/<序號+縣市>/<序號+選舉種類>/[鄉鎮資料夾/]<檔名>.pdf`，例如 111/06臺南市/05村里長/36安南/四草里.pdf。
 * 選舉種類資料夾：01 市長／縣長／直轄市長、02 議員、03 鄉鎮市長或原住民區長（新竹市的 03 是村里長）、
 * 04 鄉鎮市民代表或原住民區民代表、05 村里長。**各縣市的檔名沒有統一規則**：
 *   - 一里一檔（臺北、臺中、臺南、高雄、彰化、雲林…）：檔名含村里名
 *   - 一鄉鎮一檔（新竹縣、南投縣、花蓮縣…）：一份公報印整個鄉鎮的村里長
 *   - 依選區分檔（嘉義縣、屏東縣、新北市三重區…）：不知道哪個村里在哪一選區 → **推不出來**
 *   - 聯合公報（新竹市「北門聯里」、嘉義市「長榮聯合里」）：不知道包含哪些里 → **推不出來**
 *   - 議員常是幾個選區合印一份（「第1、7、14選舉區」「第5-7選區」「第一、八選區」）
 * 所以不寫路徑公式，改成拿全站檔案清單逐一對：**對得到才派，對不到的列清單回報**，寧可少派不要派錯——
 * 派錯一份公報，代理找不到人就會回「查無」，那個缺口 14 天不再派。
 *
 * 一個單位對到多份（正反面、同一選區分兩份、合印的選區）就全列，最多 4 份；候選人在其中一份上。
 * 純函式、不連網；scripts/build-election-bulletins.ts 用它產生 migration 的資料段。
 */

export const BULLETIN_BASE = "https://eebulletin.cec.gov.tw/";
/** 立委（中央）選舉的公報在另一個站：bulletin.cec.gov.tw/01選舉公報/02立法委員/113年第11屆/02區域立法委員/<縣市>/<選區>/… */
export const CENTRAL_BULLETIN_BASE = "https://bulletin.cec.gov.tw/";
const CENTRAL_PREFIX = "01選舉公報/";
/** 選舉年份 → 公報站的民國年資料夾（2024 立委在 bulletin.cec.gov.tw 的 113年第11屆） */
export const BULLETIN_YEAR_DIR: Record<number, string> = { 2014: "103", 2018: "107", 2022: "111", 2024: "113" };
/** 一個單位最多列幾份公報（多了代表規則沒對準，寧可不派） */
export const MAX_BULLETINS_PER_UNIT = 4;

export interface BulletinUnit {
  election_type: string;
  /** 縣市，cec_candidates 的寫法（台中市） */
  region: string;
  /** 鄉鎮市區、或「第01選舉區」「二林鎮第01選舉區」，跟 cec_candidates 同一套 */
  sub_region: string;
  village: string;
}

export type BulletinMatch =
  | { ok: true; paths: string[]; how: string }
  | { ok: false; reason: string };

/**
 * 公報檔案的站內路徑（未編碼）→ 存進資料庫的那一段：只把網址裡不安全的 ASCII 字元（空白、#、?、%、括號以外的
 * 保留字…）轉成 %XX，中文照原樣——「111/06臺南市/05村里長/36安南/四草里.pdf」人看得懂、瀏覽器與 fetch 都打得開。
 */
export function bulletinRelPath(path: string): string {
  return path.replace(/[\s"<>#%?{}|\^`\[\]]/g, (c) => {
    const bytes = new TextEncoder().encode(c);
    return [...bytes].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  });
}

/** 站內路徑屬於哪個公報站（SQL 視圖 politician_bulletins 用同一條規則組網址） */
export function bulletinBase(path: string): string {
  return path.startsWith(CENTRAL_PREFIX) ? CENTRAL_BULLETIN_BASE : BULLETIN_BASE;
}

/** 公報檔案路徑（未編碼）→ 可直接打開的網址 */
export function bulletinUrl(path: string): string {
  return bulletinBase(path) + bulletinRelPath(path);
}

const tw = (s: string) => s.replace(/台/g, "臺");

const ZH_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一～九十九的中文數字 → 整數；不是就 null */
export function zhNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[〇零一二三四五六七八九十]+$/.test(s)) return null;
  if (!s.includes("十")) return s.length === 1 ? ZH_DIGIT[s] ?? null : null;
  const [a, b] = s.split("十");
  const tens = a === "" ? 1 : ZH_DIGIT[a];
  const ones = b === "" ? 0 : ZH_DIGIT[b];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

const NUM = "(?:\\d+|[〇零一二三四五六七八九十]+)";

/**
 * 檔名裡的選區號：「第01選舉區」「第1、7、14選舉區」「第1.2.3.4選區」「第5-7選區」「第一、八選區」「第一選區」。
 * 只認「第…選（舉）區」這個框裡的數字，檔名開頭的排序號（01.、1桃園市…）不算。
 */
export function districtNumbers(rawName: string): number[] {
  // 全形數字（第２選舉區）、「第 01選舉區」的空白
  const name = rawName.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/第\s+/g, "第");
  const out = new Set<number>();
  const re = new RegExp(`第(${NUM}(?:\\s*[、.,，．\\-－~～]\\s*${NUM})*)選(?:舉)?區`, "g");
  for (const m of name.matchAll(re)) {
    const body = m[1];
    const range = new RegExp(`^(${NUM})\\s*[\\-－~～]\\s*(${NUM})$`).exec(body);
    if (range) {
      const a = zhNumber(range[1]), b = zhNumber(range[2]);
      if (a !== null && b !== null && b >= a && b - a < 40) for (let i = a; i <= b; i++) out.add(i);
      continue;
    }
    for (const part of body.split(/\s*[、.,，．]\s*/)) {
      const n = zhNumber(part);
      if (n !== null) out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** 選舉種類 → 公報站的種類資料夾名（去掉序號） */
const CATEGORY: Record<string, RegExp> = {
  "縣市長": /^(市長|縣長|直轄市長)$/,
  "縣市議員": /^(市議員|縣議員|直轄市議員)$/,
  "鄉鎮市長": /^鄉鎮市長$/,
  "直轄市山地原住民區長": /^原住民區長$/,
  "鄉鎮市民代表": /^鄉鎮市民代表$/,
  "直轄市山地原住民區民代表": /^原住民區民代表$/,
  "村里長": /^村里長$/,
  // bulletin.cec.gov.tw 的區域立委（不分區是政黨名單、原住民立委不在 cec_candidates，都不收）
  "立法委員": /^區域立法委員$/,
};

export const BULLETIN_ELECTION_TYPES = Object.keys(CATEGORY);

const stripOrder = (s: string) => s.replace(/^[\d\s.、_\-－]+/, "");

/** 鄉鎮市區去掉字尾（安南區 → 安南）；只剩一個字的不拿來比（東區 → 東 太短，會撞） */
function townStem(town: string): string | null {
  const stem = town.replace(/(區|鄉|鎮|市)$/, "");
  return stem.length >= 2 && stem !== town ? stem : null;
}

export interface BulletinIndex {
  /** `${年}/${縣市（臺）}/${選舉種類}` → 該種類底下的所有檔案路徑 */
  byCategory: Map<string, string[]>;
}

/** 種類資料夾之後（鄉鎮資料夾、選區資料夾、檔名）從第幾段開始：eebulletin「年/縣市/種類/…」第 3 段；立委「01選舉公報/02立法委員/113年第11屆/種類/縣市/…」第 5 段 */
const relStart = (path: string) => (path.startsWith(CENTRAL_PREFIX) ? 5 : 3);

/**
 * 全站檔案清單 → 索引。路徑都是未編碼的站內相對路徑：
 * eebulletin 的「111/06臺南市/05村里長/36安南/四草里.pdf」、bulletin.cec.gov.tw 的「01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/第1選舉區/…pdf」。
 */
export function buildBulletinIndex(paths: readonly string[]): BulletinIndex {
  const byCategory = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split("/");
    if (!/\.pdf$/i.test(p)) continue;
    let year: string, county: string, cat: string;
    if (p.startsWith(CENTRAL_PREFIX)) {
      // 01選舉公報/02立法委員/113年第11屆/02區域立法委員/06臺南市/…；投開票所一覽不是公報
      const m = /^(\d{3})年/.exec(parts[2] ?? "");
      if (!m || parts.length < 6 || /投開票所/.test(p)) continue;
      year = m[1];
      county = tw(stripOrder(parts[4]));
      cat = stripOrder(parts[3]);
    } else {
      if (parts.length < 4) continue;
      year = parts[0];
      county = tw(stripOrder(parts[1]));
      cat = stripOrder(parts[2]);
    }
    // 新竹市的村里長放在 03
    for (const [type, re] of Object.entries(CATEGORY)) {
      if (!re.test(cat)) continue;
      const key = `${year}/${county}/${type}`;
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(p);
    }
  }
  for (const l of byCategory.values()) l.sort();
  return { byCategory };
}

/** 檔案在種類資料夾之後的部分（鄉鎮資料夾＋檔名），去掉縣市字樣、排序號、括號 */
function relSegments(path: string, county: string): string[] {
  const countyHead = new RegExp(`^(${county}|${county.replace(/(市|縣)$/, "")}選舉公報[-－_]?)`);
  return path.split("/").slice(relStart(path)).map((raw) => {
    let s = tw(raw).replace(/\.pdf$/i, "").replace(/[【】\[\]]/g, "").replace(/^\d{3}年/, "");
    s = stripOrder(s).replace(countyHead, "");
    return stripOrder(s);
  });
}

/** 種類資料夾之後的那一段路徑（選區號、鄉鎮名都在這裡） */
const relPath = (path: string) => path.split("/").slice(relStart(path)).join("/");

/** 這份檔案屬於這個鄉鎮市區嗎：某一段以鄉鎮全名或字根開頭，或含有鄉鎮全名（桃園復興區的公報寫復興鄉，字根對得上） */
function inTown(path: string, county: string, rawTown: string): boolean {
  const town = tw(rawTown);
  const stem = townStem(town);
  // 只看檔名和它的上一層資料夾：宜蘭的大同鄉公報放在「南澳鄉鄉長選舉公報/大同鄉長選舉公報/」底下，不能算南澳的
  return relSegments(path, county).slice(-2).some((seg) =>
    seg.startsWith(town) || (stem !== null && seg.startsWith(stem)) || seg.includes(town)
  );
}

const partsCap = (paths: string[]): BulletinMatch =>
  paths.length === 0
    ? { ok: false, reason: "沒有對到檔案" }
    : paths.length > MAX_BULLETINS_PER_UNIT
    ? { ok: false, reason: `對到 ${paths.length} 份，超過 ${MAX_BULLETINS_PER_UNIT} 份，規則沒對準` }
    : { ok: true, paths, how: "" };

function withHow(m: BulletinMatch, how: string): BulletinMatch {
  return m.ok ? { ...m, how } : m;
}

/**
 * 檔名這一段有沒有寫到這個村里：「長安里」裡的「安里」不算——村里名前面要是開頭、非中文字（空白、-、數字），
 * 或鄉鎮市區的字尾（臺中市中區中華里、中山區下埤里里長）。
 */
function containsVillage(seg: string, village: string, town: string): boolean {
  if (!village) return false;
  const stem = townStem(town);
  for (let i = seg.indexOf(village); i >= 0; i = seg.indexOf(village, i + 1)) {
    const prefix = seg.slice(0, i);
    const before = prefix.slice(-1);
    // 前面是開頭、非中文字、鄉鎮市區字尾，或上一個村里名的「村／里」（新莊區中泰里立志里…中信里…里長 這種多里合印）
    if (!before || !/[一-鿿]/.test(before) || /[區鄉鎮市縣村里]/.test(before)) return true;
    // 「八德區里長大仁里」「元長下寮村」：前面是「村長／里長」或鄉鎮字根
    if (/(村長|里長)$/.test(prefix) || (stem !== null && prefix.endsWith(stem))) return true;
  }
  return false;
}

/** 這一段是不是某個村里（或聯合里）的檔名，而不是「某鄉村長選舉公報」這種全鄉鎮的 */
function namesVillage(seg: string, town: string): boolean {
  if (/聯(合)?里/.test(seg)) return true;
  const stem = townStem(town);
  let s = seg.split(town).join("");
  if (stem) s = s.split(stem).join("");
  s = s.replace(/村\(里\)長|村（里）長|村里長|村長|里長/g, "");
  return /[一-鿿][村里](?!長)/.test(s);
}

/** 純函式：一個選舉單位對到哪幾份公報；對不到回原因 */
export function matchBulletin(unit: BulletinUnit, index: BulletinIndex, electionId = 2022): BulletinMatch {
  const year = BULLETIN_YEAR_DIR[electionId];
  if (!year) return { ok: false, reason: `${electionId} 年不在 eebulletin 公報站` };
  const county = tw(unit.region);
  const files = index.byCategory.get(`${year}/${county}/${unit.election_type}`) ?? [];
  if (files.length === 0) return { ok: false, reason: "公報站沒有這個縣市的這種選舉" };

  switch (unit.election_type) {
    case "縣市長": {
      // 一縣市一份（少數正反面兩份）
      return withHow(partsCap(files.length <= 2 ? files : []), "縣市一份");
    }
    case "立法委員": {
      // 一縣市一選區的只有一份；其餘依選區資料夾（臺南第 5、6 選區合印一份，兩個資料夾各放一份）
      if (files.length === 1) return { ok: true, paths: files, how: "縣市一份" };
      const n = districtNumbers(unit.sub_region)[0];
      if (n === undefined) return { ok: false, reason: `選區寫法看不懂：${unit.sub_region}` };
      // 先看選區資料夾（第5選舉區/臺南市立委第5.6選舉區.pdf）；沒有資料夾的才看檔名
      const inFolder = files.filter((f) => {
        const segs = relPath(f).split("/");
        return segs.length > 1 && districtNumbers(segs[0]).includes(n);
      });
      const hit = inFolder.length > 0 ? inFolder : files.filter((f) => districtNumbers(relPath(f)).includes(n));
      return withHow(partsCap(hit), "選區");
    }
    case "縣市議員": {
      const n = districtNumbers(unit.sub_region)[0];
      if (n === undefined) return { ok: false, reason: `選區寫法看不懂：${unit.sub_region}` };
      if (files.length === 1) return { ok: true, paths: files, how: "全縣市一份" };
      const hit = files.filter((f) => districtNumbers(relPath(f)).includes(n));
      return withHow(partsCap(hit), hit.length === 1 ? "選區" : "選區（合印或分份）");
    }
    case "鄉鎮市長":
    case "直轄市山地原住民區長": {
      const town = unit.sub_region;
      const hit = files.filter((f) => inTown(f, county, town));
      if (hit.length <= 2) return withHow(partsCap(hit), "鄉鎮一份");
      // 屏東、南投仁愛、桃園復興：鄉鎮長和代表、村長合印，依代表選區分份——每一份都印著鄉鎮長，取第一選區那份（含正反面）
      const first = hit.filter((f) => {
        const ns = districtNumbers(relPath(f));
        return ns.length > 0 && ns[0] === 1;
      });
      return first.length > 0 ? withHow(partsCap(first), "合印分選區，取第一選區") : { ok: false, reason: `對到 ${hit.length} 份、看不出哪一份` };
    }
    case "鄉鎮市民代表":
    case "直轄市山地原住民區民代表": {
      const m = /^(.+?)(?:第(\d+))?選舉區$/.exec(unit.sub_region);
      const town = m ? m[1] : unit.sub_region;
      const n = m?.[2] ? Number(m[2]) : null;
      const hit = files.filter((f) => inTown(f, county, town));
      if (hit.length === 0) return { ok: false, reason: "沒有這個鄉鎮的檔案" };
      if (hit.length === 1) return { ok: true, paths: hit, how: "鄉鎮一份" };
      if (n === null) return withHow(partsCap(hit.length <= 2 ? hit : []), "鄉鎮一份（正反面）");
      const byNo = hit.filter((f) => districtNumbers(relPath(f)).includes(n));
      return withHow(partsCap(byNo), "選區");
    }
    case "村里長": {
      const town = tw(unit.sub_region);
      const v = tw(unit.village);
      const inT = files.filter((f) => inTown(f, county, town));
      if (inT.length === 0) return { ok: false, reason: "沒有這個鄉鎮的檔案" };
      const named = inT.filter((f) => relSegments(f, county).some((seg) => containsVillage(seg, v, town)));
      if (named.length > 0) return withHow(partsCap(named), "一村里一份");
      // 檔名都不含這個村里：整個鄉鎮只有一份、而且那一份不是某個村里（或聯合里）的，就是一鄉鎮一檔
      const last = relSegments(inT[0], county).slice(-1)[0] ?? "";
      if (inT.length === 1 && !namesVillage(last, town)) return { ok: true, paths: inT, how: "鄉鎮一份" };
      if (inT.some((f) => namesVillage(relSegments(f, county).slice(-1)[0] ?? "", town))) {
        return { ok: false, reason: "這個鄉鎮是一村里一檔（或聯合公報），沒有這個村里的檔名" };
      }
      return { ok: false, reason: `這個鄉鎮依選區分成 ${inT.length} 份，看不出這個村里在哪一份` };
    }
  }
  return { ok: false, reason: `不認得的選舉種類：${unit.election_type}` };
}
