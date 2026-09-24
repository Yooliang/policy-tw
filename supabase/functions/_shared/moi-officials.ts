/**
 * 內政部「地方公職人員」現職名單的解析（2026-09-24）。
 * https://www.moi.gov.tw/LocalOfficial.aspx?n=573&TYP=KND0001&PageSize=500&page=N
 * 每一位是一個 .block：img（照片、alt 姓名）、.caption 姓名、.locate 縣市、.position 機關＋職稱、.group 黨籍、詳細資訊連結（_PARENT_ID）。
 */
export const MOI_BASE = "https://www.moi.gov.tw";
export const MOI_KINDS = ["KND0001", "KND0002", "KND0003", "KND0004", "KND0005", "KND0006", "KND0007", "KND0008", "KND0009", "KND0010"] as const;
export const MOI_PAGE_SIZE = 500;

export interface MoiOfficial {
  id: string;
  kind: string;
  name: string;
  name_norm: string;
  region: string | null;
  region_norm: string | null;
  org: string | null;
  title: string | null;
  party: string | null;
  photo_url: string | null;
  detail_url: string | null;
}

/** 跟 SQL 的 moi_norm() 同一套：去空白（含全形）、臺→台 */
export function moiNorm(s: string | null | undefined): string | null {
  const v = String(s ?? "").replace(/[\s　]/g, "").replace(/臺/g, "台");
  return v ? v : null;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const spans = (html: string) => [...html.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, ""))).filter(Boolean);

export function listUrl(kind: string, page: number): string {
  return `${MOI_BASE}/LocalOfficial.aspx?n=573&TYP=${kind}&PageSize=${MOI_PAGE_SIZE}&page=${page}`;
}

export function parseMoiList(html: string, kind: string): MoiOfficial[] {
  const out: MoiOfficial[] = [];
  const blocks = html.split(/<div class="block">/).slice(1);
  for (const b of blocks) {
    const cls = (c: string) => {
      const m = b.match(new RegExp(`<div class="${c}">([\\s\\S]*?)</div>`));
      return m ? spans(m[1]) : [];
    };
    const name = cls("caption")[0];
    const link = b.match(/href="(\/LocalOfficial_Content\.aspx\?[^"]*_PARENT_ID=([A-Za-z0-9]+)[^"]*)"/);
    if (!name || !link) continue;
    const img = b.match(/<img[^>]+src="([^"]+)"/);
    const pos = cls("position");
    const region = cls("locate")[0] ?? null;
    out.push({
      id: link[2],
      kind,
      name,
      name_norm: moiNorm(name)!,
      region,
      region_norm: moiNorm(region),
      org: pos[0] ?? null,
      title: pos[1] ?? null,
      party: cls("group")[0] ?? null,
      photo_url: img && /^https?:\/\//.test(img[1]) ? decode(img[1]) : null,
      detail_url: MOI_BASE + decode(link[1]),
    });
  }
  return out;
}
