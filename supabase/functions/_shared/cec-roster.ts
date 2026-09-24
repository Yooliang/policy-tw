/**
 * 中選會登記名冊（PDF）的逐位核對（2026-09-24，小良哥選 B：只對中選會的登記名冊開放讀 PDF，系統整批逐位核對）。
 *
 * 這是 09-20「系統不解析 PDF」的例外，範圍只限 web.cec.gov.tw/api/file/*.pdf。不用 Jev：純比對。
 * 名冊是逐欄印的——有時一列一位（選舉區 日期 姓名 政黨），有時整欄姓名接著整欄政黨。
 * 解析法照 skill.md 9a：把連續的姓名與接在後面的連續政黨各當成一組，長度相等才依順序配對（不等就整組不收）。
 * 實測（09-24）：wang.shihchieh 當成台中市議員交的 181 位，名冊上 90 位是台中、86 位台南、3 位高雄，2 位找不到。
 */
export const CEC_ROSTER_URL_RE = /^https:\/\/web\.cec\.gov\.tw\/api\/file\/[0-9a-f-]+\.pdf$/i;
export const ROSTER_BATCH_MODEL = "policy-tw/roster-batch-20260924";
/** 整批至少這個比例對得上，系統票才判 supported（對不上的那幾筆照舊逐筆驗） */
export const ROSTER_PASS_RATIO = 0.9;

export interface RosterRow { name: string; party: string; region: string | null }
export interface BatchItem { id: string; name: string; party: string | null; region: string | null }
export interface BatchCheck { passed: string[]; failed: Array<{ id: string; name: string; reason: string }> }

const norm = (s: string | null | undefined) => String(s ?? "").replace(/\s/g, "").replace(/臺/g, "台");
const HEADER = new Set(["選舉區", "登記日期", "姓名", "推薦之政黨", "備註", "登記之選舉區", "性別", "受理登記機關", "第", "頁", "列印筆數"]);
const isDate = (x: string) => /^(\d{3}\/\d{2}\/\d{2})+$/.test(x);
const isDistrict = (x: string) => x.endsWith("選舉區");
const isParty = (x: string) => x === "無" || x.endsWith("黨") || ["時代力量", "台灣基進", "臺灣基進", "台灣團結聯盟", "綠黨"].includes(x);
// 頁首頁尾、純數字、受理機關（某某選舉委員會）都不是姓名
const isHeader = (x: string) => HEADER.has(x) || /年|製表|頁|選舉委員會|筆數/.test(x) || /^\d+$/.test(x);
/** 縣市議員名冊多一欄性別：夾在姓名與政黨之間，跟日期一樣略過 */
const isGender = (x: string) => x === "男" || x === "女";
/** 「臺中市第01選舉區」→「台中市」 */
const regionOf = (district: string) => norm(district).split("第")[0] || null;

export function parseRoster(text: string): RosterRow[] {
  const toks = text.split(/\s+/).filter(Boolean);
  type K = "D" | "T" | "P" | "H" | "N";
  const kind = (x: string): K => isDistrict(x) ? "D" : (isDate(x) || isGender(x)) ? "T" : isParty(x) ? "P" : isHeader(x) ? "H" : "N";
  const seq = toks.map((x) => ({ k: kind(x), x })).filter((s) => s.k !== "H");
  const out: RosterRow[] = [];
  // 選舉區也可能是一整欄：記下姓名前面那一串（上一組政黨之後出現的），長度對得上就逐位配，否則整串同縣市才用、不然不判縣市
  let before: string[] = [];
  const regionsFor = (n: number, pre: string[], post: string[]): Array<string | null> => {
    const pick = pre.length === n ? pre : post.length === n ? post : null;
    if (pick) return pick.map(regionOf);
    const all = [...pre, ...post].map(regionOf);
    const uniq = [...new Set(all.filter(Boolean))];
    return Array.from({ length: n }, () => (uniq.length === 1 ? uniq[0] : null));
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
      const regions = regionsFor(names.length, before, after);
      names.forEach((n, idx) => out.push({ name: n, party: parties[idx], region: regions[idx] }));
      before = [];
      i = q;
    } else if (parties.length > 0 && names.length === 1) {
      out.push({ name: names[0], party: parties[0], region: regionsFor(1, before.slice(-1), after.slice(0, 1))[0] });
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
