/**
 * 日本站的系統票（Jev 核對提交者附的出典）：jp-system-one?action=precheck 用的純函式。
 *
 * 照搬 ../system-one.ts 的 precheck（claimOf → buildSourceSupportAsk → aggregateFieldVerdicts），換掉台灣專屬的部分：
 *   ・宣稱（claim）：日本站的 payload 形狀不同（參選用 election_id 字串、狀態六值、人物多半只帶 politician_id），
 *     而且頁面證明不了內部 id，所以先把 id 換成「頁面上看得到的字」（人名、選舉名＋投票日、狀態的日文說法）再問。
 *   ・逐欄說明（JP_FIELD_INSTRUCTIONS）：正見那段寫死台灣的政黨簡稱、九合一、中選會名冊，日本站改寫日本的同義寫法（届出＝告示・立候補者一覧…）。
 *   ・核心欄位（JP_CORE_FIELDS）：正見的 CORE_FIELDS_BY_TYPE 鍵是台灣的欄位名，日本站自己一份；politician 的核心是「這一筆要補的事實」。
 *   ・正文抓取（jpFetchSource）：日本的自治體網站很多是 Shift_JIS／EUC-JP，正見的 fetchSource 一律當 UTF-8 讀會變亂碼，這裡依 charset 解碼；
 *     PDF 照正見 cec-roster 用 unpdf 抽字（選管的立候補者一覧多是 PDF），3 MB 以上不讀。
 * 收斂規則（任一欄 contradicted ≥ 門檻 → not_supported；核心欄全 confirmed → supported，機率取核心欄最低；其他棄權）一字不改，只換核心欄清單。
 * 不搬：獨立來源逐一再問（independent-sources.ts；日本站 SQL 的系統票只有 −1，沒有「多一個獨立來源再降一分」）、票數預算（影子模式）。
 */
import { type FieldVerdict, htmlToText, type JevAnswer, type JevQuestion, MIN_PROBABILITY, type SourceSupport } from "../system-one.ts";
import { isSelfCitationUrl } from "../self-hosts.ts";

/** 系統票的交件型別（SQL policy_jp.system_one_precheck_types() と同じ。対齊は policy-jp-system-one.test.ts） */
export const JP_PRECHECK_TYPES = ["candidacy", "politician", "policy"] as const;
export type JpPrecheckType = (typeof JP_PRECHECK_TYPES)[number];
/** 正文が取れなかったときの紀錄の model（SQL の候選清單が 'policy-jp/fetch-only%' で数える） */
export const JP_FETCH_ONLY_MODEL = "policy-jp/fetch-only-00000000";

/** 參選狀態 → 頁面上的說法（Jev が原文と突き合わせる文） */
export const JP_STATUS_PHRASES: Readonly<Record<string, string>> = {
  considering: "立候補を検討している（出馬を検討中と報じられている）",
  declared: "立候補を表明した（出馬表明）",
  filed: "立候補の届出をした（告示・選管の立候補者一覧に載っている）",
  withdrawn: "立候補を取りやめた、または届出後に辞退した",
  elected: "当選した",
  not_elected: "落選した",
};

/** 宣稱を組むために庫から引く、頁面に出る字（呼ぶ側が policy_jp から読んで渡す） */
export interface JpClaimContext {
  /** 人物の名前（payload に name がなければ politician_id から引いたもの） */
  politicianName?: string | null;
  /** 選挙の表示名と投票日（candidacy：payload.election_id、policy：politician_election_id から引いたもの） */
  electionName?: string | null;
  electionDate?: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * 交件の宣稱（頁面に書かれているはずのこと）。id は入れない（頁面では証明できない）。
 *   candidacy：name・election・candidacy_status が核心；kana・district・birth_year は核心外（頁面になくてよいが、矛盾は反対）。
 *     status_date は入れない：表明日・報道日・告示日の取り違えで誤った not_supported が出やすい（検証者が見る）。
 *   politician：name は主語（核心外）、補う事実（birth_year・kana・education・career）が核心。
 *   policy：politician_name・title が核心、description（代理の要約）は核心外。category は代理の分類なので入れない。
 */
export function jpClaimOf(type: string, payload: Record<string, unknown>, ctx: JpClaimContext = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  };
  const election = [str(ctx.electionName), str(ctx.electionDate) ? `（投票日 ${ctx.electionDate}）` : null].filter(Boolean).join("");
  if (type === "candidacy") {
    put("name", str(payload.name) ?? str(ctx.politicianName));
    put("kana", str(payload.kana));
    put("election", election || null);
    const st = str(payload.candidacy_status);
    put("candidacy_status", st ? (JP_STATUS_PHRASES[st] ?? st) : null);
    put("district", str(payload.district_name));
    put("birth_year", typeof payload.birth_year === "number" ? payload.birth_year : null);
  } else if (type === "politician") {
    put("name", str(ctx.politicianName));
    put("birth_year", typeof payload.birth_year === "number" ? payload.birth_year : null);
    put("kana", str(payload.kana));
    put("education", Array.isArray(payload.education) ? payload.education.filter((s) => typeof s === "string") : null);
    put("career", Array.isArray(payload.career) ? payload.career.filter((s) => typeof s === "string") : null);
  } else if (type === "policy") {
    put("politician_name", str(ctx.politicianName));
    put("title", str(payload.title));
    put("description", str(payload.description));
  }
  return out;
}

/** 型別ごとの「出典が必ず証明すべき欄」。politician は主語の name 以外の全欄（＝補う事実）。 */
export function jpCoreFields(type: string, claim: Record<string, unknown>): string[] {
  if (type === "candidacy") return ["name", "election", "candidacy_status"].filter((k) => k in claim);
  if (type === "politician") return Object.keys(claim).filter((k) => k !== "name");
  if (type === "policy") return ["politician_name", "title"].filter((k) => k in claim);
  return [];
}

export const JP_FIELD_INSTRUCTIONS =
  "claim は日本の地方政治データベースに書き込もうとしている主張、page は提出者が添えた出典ページの本文。この問いは claim の一つの欄だけを問う：本文はそれを証明しているか？" +
  "基準：出典は「この人がそうした・そう言った・そうである」ことを示さなければならない（その出来事が存在するだけでは足りない）。同じ意味の書き方は一致とみなす：" +
  "姓と名の間の空白の有無、旧字体と新字体（髙＝高、﨑＝崎、邊・邉＝辺、齋＝斎）、ひらがなとカタカナの読み、和暦と西暦（令和8年＝2026年）、" +
  "「立候補を届け出た」「告示日に届出」「選挙管理委員会の立候補者一覧・候補者名簿に載っている」＝立候補の届出をした、「出馬を表明」「立候補を表明」＝立候補を表明した、" +
  "「無投票当選」＝当選した、選挙名は「〇〇市長選挙」「〇〇市議会議員選挙」「〇〇市議選」などの略称でもよい（同じ団体・同じ投票日なら一致）。" +
  "学歴・経歴の配列は、全項目が本文で確かめられるときだけ confirmed。" +
  "本文の内容がこの欄と合っていれば confirmed；本文がはっきり違う値を書いている、または別人・前回の選挙のことなら contradicted；本文がこの欄に触れていなければ absent。";

/** 正見 buildSourceSupportAsk の日本版（説明文だけ差し替え、形は同じ：field:<欄> ごとに一問） */
export function buildJpSourceSupportAsk(claim: Record<string, unknown>, url: string, pageText: string): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
} {
  const questions: Record<string, JevQuestion> = {};
  for (const [k, v] of Object.entries(claim)) {
    const shown = typeof v === "string" ? v : JSON.stringify(v);
    questions[`field:${k}`] = {
      type: "choice",
      instructions: `${JP_FIELD_INSTRUCTIONS} この問いの欄：${k}＝${shown}`,
      criteria: { confirmed: `本文が ${k} は ${shown} であることを証明している（同じ意味の書き方を含む）`, contradicted: "本文が違う値を書いている、またはこれは別人のこと", absent: "本文はこの欄に触れていない" },
    };
  }
  return { state: { claim, page: { url, text: pageText } }, questions };
}

export interface JpFieldResult { verdict: FieldVerdict; p: number }

/** 正見 aggregateFieldVerdicts と同じ規則、核心欄だけ jpCoreFields */
export function aggregateJpFieldVerdicts(
  type: string,
  claim: Record<string, unknown>,
  answers: Record<string, JevAnswer>,
  minProbability = MIN_PROBABILITY,
): { choice: SourceSupport; probability: number; fields: Record<string, JpFieldResult>; core_fields: string[]; contradicted_core: boolean } {
  const fields: Record<string, JpFieldResult> = {};
  for (const k of Object.keys(claim)) {
    const a = answers[`field:${k}`];
    if (!a) continue;
    fields[k] = { verdict: a.choice as FieldVerdict, p: Math.round((a.probabilities?.[a.choice] ?? 0) * 10000) / 10000 };
  }
  const core = jpCoreFields(type, claim).filter((k) => k in fields);
  const contradicted = Object.values(fields).filter((f) => f.verdict === "contradicted" && f.p >= minProbability);
  const contradictedCore = core.some((k) => fields[k]?.verdict === "contradicted" && fields[k].p >= minProbability);
  if (contradicted.length > 0) {
    return { choice: "not_supported", probability: Math.max(...contradicted.map((f) => f.p)), fields, core_fields: core, contradicted_core: contradictedCore };
  }
  if (core.length > 0 && core.every((k) => fields[k].verdict === "confirmed")) {
    return { choice: "supported", probability: Math.min(...core.map((k) => fields[k].p)), fields, core_fields: core, contradicted_core: false };
  }
  return { choice: "cannot_tell", probability: 0, fields, core_fields: core, contradicted_core: false };
}

/** 名前の照合用の正規化：空白（全角を含む）と中黒を落とし、よくある旧字体を新字体に寄せる */
const JP_VARIANTS: ReadonlyArray<[RegExp, string]> = [[/髙/g, "高"], [/﨑/g, "崎"], [/[邊邉]/g, "辺"], [/齋/g, "斎"], [/齊/g, "斉"], [/𠮷/g, "吉"], [/栁/g, "柳"]];
export function jpNormalizeName(s: string): string {
  let t = s.replace(/[\s・·．.]/g, "");
  for (const [re, to] of JP_VARIANTS) t = t.replace(re, to);
  return t;
}
/** 本文に主人公の名前があるか（なければ Jev に聞かない：別人の行で「矛盾」と判定されるのを防ぐ。正見 nameHit と同じ考え） */
export function jpNameHit(text: string, names: Array<string | null | undefined>): boolean {
  const t = jpNormalizeName(text);
  return names.some((n) => !!n && jpNormalizeName(n).length >= 2 && t.includes(jpNormalizeName(n)));
}

/**
 * いくつかの出典の本文を一つにまとめる（名前が出てくるページを先に、名前の前後を中心に切り出す）。
 * 正見 combineSources の考え方を日本語の照合（jpNameHit）で。合計 6000 字まで。
 */
export function combineJpSources(pages: Array<{ url: string; text: string }>, names: Array<string | null | undefined>, total = 6000): string {
  const usable = pages.filter((p) => p.text && p.text.trim());
  if (usable.length === 0) return "";
  const per = Math.max(400, Math.floor(total / usable.length) - 40);
  const sorted = usable.map((p) => ({ ...p, hit: jpNameHit(p.text, names) })).sort((a, b) => Number(b.hit) - Number(a.hit));
  const parts: string[] = [];
  let used = 0;
  for (const p of sorted) {
    const piece = focusJp(p.text, names, per);
    const host = (() => { try { return new URL(p.url).host; } catch { return p.url; } })();
    const block = `【出典 ${host}】\n${piece}`;
    if (used + block.length > total) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

/** 名前が最初に出てくるあたりを中心に max 字（名前がなければ先頭から） */
export function focusJp(text: string, names: Array<string | null | undefined>, max: number): string {
  if (text.length <= max) return text;
  let at = -1;
  for (const n of names) {
    if (!n || n.length < 2) continue;
    const i = text.indexOf(n);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, max);
  const start = Math.max(0, at - Math.floor(max / 3));
  return text.slice(start, start + max);
}

/** HTTP の Content-Type、なければ HTML 先頭の meta charset から文字コードを決める（既定 UTF-8） */
export function detectCharset(contentType: string, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const ascii = new TextDecoder("ascii").decode(head.slice(0, 4096));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii)?.[1];
  const raw = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  if (["shift_jis", "shift-jis", "sjis", "x-sjis", "windows-31j", "ms932", "cp932"].includes(raw)) return "shift_jis";
  if (["euc-jp", "x-euc-jp", "eucjp"].includes(raw)) return "euc-jp";
  if (raw === "iso-2022-jp") return "iso-2022-jp";
  return "utf-8";
}

export const JP_PDF_MAX_BYTES = 3_000_000;
const FETCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

export type JpFetched = { kind: "html" | "pdf" | "error"; text: string; note: string };

/**
 * 出典を取る。HTML は文字コードを見て解碼、PDF は 3 MB まで unpdf で抽字。表計算は読まない。
 * 本站・正見の網址（自引用）は取らずに error。pdfText は試験用の差し替え口。
 */
export async function jpFetchSource(
  url: string,
  fetchImpl: typeof fetch = fetch,
  pdfText: (buf: Uint8Array) => Promise<string> = unpdfText,
): Promise<JpFetched> {
  if (isSelfCitationUrl(url)) return { kind: "error", text: "", note: "self_citation：本站・正見の網址は出典にならない" };
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": FETCH_UA, "Accept-Language": "ja,en;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { await res.body?.cancel(); return { kind: "error", text: "", note: `http ${res.status}` }; }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("ms-excel") || ct.includes("spreadsheetml") || /\.(xlsx?|ods|csv)(\?|$)/i.test(url)) {
      await res.body?.cancel();
      return { kind: "error", text: "", note: "表計算は読まない" };
    }
    if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > JP_PDF_MAX_BYTES) { await res.body?.cancel(); return { kind: "pdf", text: "", note: `pdf ${declared} bytes > ${JP_PDF_MAX_BYTES}` }; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > JP_PDF_MAX_BYTES) return { kind: "pdf", text: "", note: `pdf ${buf.byteLength} bytes > ${JP_PDF_MAX_BYTES}` };
      const text = (await pdfText(buf)).replace(/\u0000/g, "");
      return { kind: text.trim() ? "html" : "pdf", text, note: `pdf:${buf.byteLength} | text:${text.length}` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const head = buf.slice(0, 1_500_000);
    const charset = detectCharset(ct, head);
    let html: string;
    try { html = new TextDecoder(charset).decode(head); } catch { html = new TextDecoder("utf-8").decode(head); }
    const text = htmlToText(html);
    return { kind: "html", text, note: `raw:${buf.byteLength} | text:${text.length} | ${charset}` };
  } catch (e) {
    return { kind: "error", text: "", note: e instanceof Error ? e.name : String(e) };
  }
}

async function unpdfText(buf: Uint8Array): Promise<string> {
  // import() は字串字面値（變數だと線上で Module not found：CLAUDE.md）。版は cec-roster と同じ
  const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1?no-dts") as unknown as {
    getDocumentProxy(data: Uint8Array): Promise<unknown>;
    extractText(pdf: unknown, opts: { mergePages: true }): Promise<{ text: string | string[] }>;
  };
  const { text } = await extractText(await getDocumentProxy(buf), { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}
