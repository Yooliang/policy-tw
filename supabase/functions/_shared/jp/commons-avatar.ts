/**
 * 日本站人物頭像（政策の系譜）的機器核對：只收 Wikimedia Commons 的自由授權照片。
 * 裁決 policy-ops docs/decisions/2026-10-30-日本站收Wikimedia自由授權頭像.md（更正 10-11「目前不做頭像收集任務」，授權限制照舊）。
 *
 * 交件型別 politician_avatar：payload = { politician_id, image_url, file_page_url, license, author }。
 * 收下之前，伺服器用 Commons API（action=query&prop=imageinfo&iiprop=url|extmetadata）讀檔案頁的
 * 圖檔網址、LicenseShortName、Artist，交件所填必須一致、而且授權在白名單，才收；核對不過整批不收（不算退件）。
 * 「照片是不是這個人」仍由同儕驗證判斷（機器只管來源與授權）。
 *
 * 白名單（SQL policy_jp.apply_politician_avatar／politicians 的 CHECK、前端 policy-jp src/lib/avatar.ts 用同一條正規式）：
 *   CC0、Public domain 類（Public domain、PD-…）、CC BY（各版本）、CC BY-SA（各版本，含 2.0 de 之類的地區版）。
 *   fair use、NC、ND、GFDL 單授權、授權不明一律拒。
 *
 * 純函式＋可注入的 fetch（試驗用偽物）；預設的 fetch 打 commons.wikimedia.org。
 */

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
/** Wikimedia 要求 API 請求帶可辨識的 User-Agent */
export const COMMONS_USER_AGENT = "HustingsJP-avatar-check/1.0 (https://jp.hustings.net/skill.md)";
/** 圖片網址：upload.wikimedia.org 的 commons 圖檔（原圖或縮圖）。SQL 的 politicians CHECK 與前端同一條 */
export const COMMONS_IMAGE_URL_RE = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/\S+$/;
/** 檔案頁：commons.wikimedia.org/wiki/File:… */
export const COMMONS_FILE_PAGE_RE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s#?]+$/;
/** 授權白名單（LicenseShortName）。SQL／前端同一條，改一邊要改全部（守門 commons-avatar.test.ts 對 SQL） */
export const AVATAR_LICENSE_RE = /^(CC0( 1\.0)?|Public domain|PD[ -].+|CC BY(-SA)? \d\.\d( [a-z]{2,3}(-[a-z]+)?)?)$/i;
export const AVATAR_AUTHOR_MAX = 300;

export interface AvatarClaim {
  image_url: string;
  file_page_url: string;
  license: string;
  author: string;
}

/** Commons API 讀到的、跟交件比對的欄位 */
export interface CommonsInfo {
  /** 原圖網址（imageinfo.url） */
  url: string;
  /** LicenseShortName（沒有＝空字串） */
  license: string;
  /** Artist 去掉 HTML 的純文字（沒有＝空字串） */
  artist: string;
  /** extmetadata.NonFree 是 true */
  nonFree: boolean;
}

/** 取不到＝null（檔案不存在）；網路／API 錯誤要丟出 CommonsUnavailable */
export type CommonsLookup = (title: string) => Promise<CommonsInfo | null>;

export class CommonsUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "CommonsUnavailable"; }
}

export const isAvatarLicense = (license: string): boolean => AVATAR_LICENSE_RE.test(license.trim());

/** 授權條款網址（畫面連結用；前端有同一支）。Public domain 類沒有統一的條款頁，回 null */
export function commonsLicenseUrl(license: string): string | null {
  const s = license.trim();
  if (/^CC0( 1\.0)?$/i.test(s)) return "https://creativecommons.org/publicdomain/zero/1.0/";
  const m = /^CC BY(-SA)? (\d\.\d)(?: ([a-z]{2,3}(?:-[a-z]+)?))?$/i.exec(s);
  if (!m) return null;
  return `https://creativecommons.org/licenses/${m[1] ? "by-sa" : "by"}/${m[2]}/${m[3] ? `${m[3].toLowerCase()}/` : ""}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** HTML 片段 → 純文字（Artist 欄是 HTML）：去標籤、解實體、壓空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** 檔案頁網址 → Commons 的檔名標題（"File:Foo bar.jpg"）；形狀不對回 null */
export function commonsTitleOf(filePageUrl: string): string | null {
  if (!COMMONS_FILE_PAGE_RE.test(filePageUrl)) return null;
  try {
    const t = decodeURIComponent(filePageUrl.slice("https://commons.wikimedia.org/wiki/".length)).replace(/_/g, " ").trim();
    return /^File:.+/.test(t) ? t : null;
  } catch {
    return null;
  }
}

const decodedPath = (u: string): string | null => {
  try { return decodeURIComponent(new URL(u).pathname); } catch { return null; }
};

/** 交件的 image_url 是不是這個檔案：原圖網址相同，或是它的縮圖（…/commons/thumb/a/ab/Foo.jpg/500px-Foo.jpg） */
export function isSameCommonsImage(infoUrl: string, imageUrl: string): boolean {
  const base = decodedPath(infoUrl);
  const given = decodedPath(imageUrl);
  if (!base || !given) return false;
  if (given === base) return true;
  const thumbBase = base.replace("/wikipedia/commons/", "/wikipedia/commons/thumb/");
  return thumbBase !== base && given.startsWith(`${thumbBase}/`);
}

export type AvatarCheck = { ok: true } | { ok: false; reason: string; path: string };

/** 交件的欄位形狀（不連網路）。回第一個問題；沒有回 null */
export function avatarShapeProblem(a: Partial<AvatarClaim>): { path: string; message: string } | null {
  if (typeof a.image_url !== "string" || !COMMONS_IMAGE_URL_RE.test(a.image_url) || a.image_url.length > 600) {
    return { path: "payload.image_url", message: "image_url は https://upload.wikimedia.org/wikipedia/commons/… の画像 URL（Wikimedia Commons のもの以外は受け付けません）" };
  }
  if (typeof a.file_page_url !== "string" || !COMMONS_FILE_PAGE_RE.test(a.file_page_url) || a.file_page_url.length > 600) {
    return { path: "payload.file_page_url", message: "file_page_url は https://commons.wikimedia.org/wiki/File:… のファイルページ（Commons 以外は受け付けません）" };
  }
  if (typeof a.license !== "string" || !isAvatarLicense(a.license)) {
    return { path: "payload.license", message: "license は Commons のファイルページの LicenseShortName のとおり（受け付けるのは CC0／Public domain 類／CC BY／CC BY-SA の各版。NC・ND・fair use・不明は不可）" };
  }
  if (typeof a.author !== "string" || a.author.trim().length < 1 || a.author.length > AVATAR_AUTHOR_MAX) {
    return { path: "payload.author", message: `author は必須（1～${AVATAR_AUTHOR_MAX} 字：撮影者・作者の表示。CC BY／BY-SA の表示義務のため省けません）` };
  }
  return null;
}

/** 交件の author と Commons の Artist が一致するか（互いの包含。短すぎる author の包含は認めない） */
export function authorMatches(submitted: string, artist: string): boolean {
  const a = norm(submitted);
  const b = norm(artist);
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

/** 機器核對：交件の欄位を Commons の実データと突き合わせる（網路錯誤丟 CommonsUnavailable） */
export async function checkCommonsAvatar(a: AvatarClaim, lookup: CommonsLookup): Promise<AvatarCheck> {
  const shape = avatarShapeProblem(a);
  if (shape) return { ok: false, reason: shape.message, path: shape.path };
  const title = commonsTitleOf(a.file_page_url);
  if (!title) return { ok: false, reason: "file_page_url からファイル名が読み取れません", path: "payload.file_page_url" };
  const info = await lookup(title);
  if (!info) return { ok: false, reason: `Commons に ${title} が見つかりません（ファイルページの URL をそのまま使ってください）`, path: "payload.file_page_url" };
  if (info.nonFree) return { ok: false, reason: "Commons が非フリー（NonFree）としているファイルは受け付けません", path: "payload.license" };
  if (!isAvatarLicense(info.license)) {
    return { ok: false, reason: `Commons 上のライセンス「${info.license || "表示なし"}」は受け付けられません（CC0／Public domain 類／CC BY／CC BY-SA の各版のみ）`, path: "payload.license" };
  }
  if (norm(info.license) !== norm(a.license)) {
    return { ok: false, reason: `license「${a.license}」が Commons の LicenseShortName「${info.license}」と一致しません（ファイルページのとおりに書いてください）`, path: "payload.license" };
  }
  if (!isSameCommonsImage(info.url, a.image_url)) {
    return { ok: false, reason: "image_url が、file_page_url のファイルの画像ではありません（ファイルページに表示されている原画像または縮小画像の URL を使ってください）", path: "payload.image_url" };
  }
  if (info.artist) {
    if (!authorMatches(a.author, info.artist)) {
      return { ok: false, reason: `author「${a.author}」が Commons の作者表示「${info.artist.slice(0, 120)}」と一致しません（ファイルページの作者欄のとおりに書いてください）`, path: "payload.author" };
    }
  } else if (/^CC BY/i.test(info.license)) {
    // CC BY／BY-SA は帰属表示が条件。作者欄が空のファイルは、表示すべき名前を機械で確かめられないので受け付けない
    return { ok: false, reason: "Commons のファイルページに作者の記載がなく、CC BY／BY-SA の帰属表示を確かめられないため受け付けられません", path: "payload.author" };
  }
  return { ok: true };
}

/** 既定の Commons 照会（commons.wikimedia.org の API）。失敗は CommonsUnavailable */
export const commonsLookupViaApi: CommonsLookup = async (title) => {
  const url = `${COMMONS_API}?${new URLSearchParams({
    action: "query", titles: title, prop: "imageinfo", iiprop: "url|extmetadata", redirects: "1", format: "json", formatversion: "2",
  })}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": COMMONS_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new CommonsUnavailable(`Commons API に接続できません: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new CommonsUnavailable(`Commons API が ${res.status} を返しました`);
  let json: unknown;
  try { json = await res.json(); } catch { throw new CommonsUnavailable("Commons API の応答が JSON ではありません"); }
  return parseCommonsResponse(json);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const metaValue = (meta: unknown, key: string): string => {
  if (!isObj(meta)) return "";
  const m = meta[key];
  return isObj(m) && typeof m.value === "string" ? m.value : "";
};

/** API 応答 → CommonsInfo（ページがない・imageinfo がない＝null） */
export function parseCommonsResponse(json: unknown): CommonsInfo | null {
  if (!isObj(json) || !isObj(json.query) || !Array.isArray(json.query.pages)) throw new CommonsUnavailable("Commons API の応答の形が想定と違います");
  const page = json.query.pages[0];
  if (!isObj(page) || page.missing === true || page.invalid === true || !Array.isArray(page.imageinfo) || !isObj(page.imageinfo[0])) return null;
  const ii = page.imageinfo[0];
  if (typeof ii.url !== "string") return null;
  const meta = ii.extmetadata;
  return {
    url: ii.url,
    license: htmlToText(metaValue(meta, "LicenseShortName")),
    artist: htmlToText(metaValue(meta, "Artist")),
    nonFree: /^true$/i.test(metaValue(meta, "NonFree").trim()),
  };
}

export interface AvatarProblem { index: number; path: string; message: string; unavailable?: boolean }

/**
 * 一批交件のうち politician_avatar を全部照合する。問題のある分の一覧を返す（空＝全部通った）。
 * 同じ檔案頁は一回しか問い合わせない。Commons に繋がらない分は unavailable:true（呼び出し側は 503 にする：交件側の誤りではない）。
 */
export async function avatarProblems(
  items: ReadonlyArray<{ contribution_type: string; payload: unknown }>,
  lookup: CommonsLookup = commonsLookupViaApi,
): Promise<AvatarProblem[]> {
  const out: AvatarProblem[] = [];
  const cache = new Map<string, Promise<CommonsInfo | null>>();
  const cached: CommonsLookup = (t) => {
    let p = cache.get(t);
    if (!p) { p = lookup(t); cache.set(t, p); }
    return p;
  };
  for (const [index, item] of items.entries()) {
    if (item.contribution_type !== "politician_avatar" || !isObj(item.payload)) continue;
    const p = item.payload;
    try {
      const r = await checkCommonsAvatar(
        { image_url: p.image_url as string, file_page_url: p.file_page_url as string, license: p.license as string, author: p.author as string },
        cached,
      );
      if (!r.ok) out.push({ index, path: r.path, message: r.reason });
    } catch (e) {
      if (e instanceof CommonsUnavailable) out.push({ index, path: "payload", message: e.message, unavailable: true });
      else throw e;
    }
  }
  return out;
}
