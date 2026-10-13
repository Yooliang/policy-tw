/**
 * 日本站 新聞線の「便宜篩」（純函式、網路も資料庫も触らない）。
 * 正見 _shared/news-screen.ts（人名 → 政見の進度）の日本版だが、聞くことが違う：
 * 「団体名＋首長／議会」が隣り合っていて、近くに辞職・死去・議会解散・リコールの語がある記事だけを、団体×職の線索にする。
 * 安い規則で篩うだけで Jev は呼ばない（Jev の「この記事は選挙を要するか」は次の刀）。だから厳しめに倒す：
 *   - 団体名は左に漢字が続かない（「京都市北区長」が東京の北区に当たらない）。同名の団体は記事に出る都道府県名で 1 つに絞れなければ捨てる。
 *   - 首長は 前・元・故 が付いたら対象外。議会は「名＋議会」だけ。行政区（選挙がない）は索引に入れない。
 *   - 辞職・死去は首長だけ（議長や議員の辞職は首長選挙を要しない）。同じ文で、団体＋職のすぐ後（25 字以内）か直前（15 字以内）にあること。
 *   - 「辞職勧告」「辞職を求める」「辞職しない」「死去…の父」などは除外。
 * 実測の代わり：policy-ops#95 の設計（突発の選挙は 首長の欠け 50 日・議会解散 40 日以内）と、NHK／Yahoo の見出しの書き方に合わせた語彙。
 */

export type NewsSignal = "resignation" | "death" | "dissolution" | "recall";
export type OfficeKind = "head" | "assembly";

export interface LgEntry { lg_code: string; name: string; kind: string; pref_name: string }
export type LgIndex = Map<string, LgEntry[]>;

export interface NewsLead { lg_code: string; lg_name: string; office_kind: OfficeKind; signal: NewsSignal; matched: string }
export interface ScreenOutcome {
  result: "no_entity" | "no_signal" | "lead" | "ambiguous";
  leads: NewsLead[];
}

/** 名前 → 団体（行政区は選挙がないので入れない、1 字の名前は何にでも当たるので入れない） */
export function buildLgIndex(rows: readonly LgEntry[]): LgIndex {
  const idx: LgIndex = new Map();
  for (const r of rows) {
    if (r.kind === "admin_ward" || [...r.name].length < 2) continue;
    const list = idx.get(r.name) ?? [];
    if (!list.some((x) => x.lg_code === r.lg_code)) list.push(r);
    idx.set(r.name, list);
  }
  return idx;
}

const HAN = /\p{Script=Han}/u;
const isHan = (ch: string | undefined) => !!ch && HAN.test(ch);

/** 文に切る（見出しは丸ごと 1 文、要約は 。で切る） */
export function sentencesOf(text: string): string[] {
  return text.normalize("NFKC").split(/[。！？\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

interface Entity { entry: LgEntry; role: OfficeKind; start: number; end: number }

/** 文の中の「団体＋職」。左に漢字が続くものは別の名前の一部として捨てる（直前が所属の都道府県名ならよい） */
function entitiesIn(sentence: string, idx: LgIndex): { found: Entity[]; ambiguous: boolean } {
  const found: Entity[] = [];
  let ambiguous = false;
  for (const [name, entries] of idx) {
    let at = sentence.indexOf(name);
    while (at >= 0) {
      const before = sentence.slice(0, at);
      const prev = sentence[at - 1];
      const after = sentence.slice(at + name.length);
      // 候補の職：都道府県は 知事／議会、それ以外は 長／議会
      const roles: Array<{ role: OfficeKind; len: number; ok: (e: LgEntry) => boolean }> = [
        { role: "head", len: after.startsWith("知事") ? 2 : 1, ok: (e) => (e.kind === "prefecture" ? after.startsWith("知事") : after.startsWith("長")) },
        { role: "assembly", len: 2, ok: () => after.startsWith("議会") },
      ];
      for (const r of roles) {
        const cands = entries.filter((e) => {
          if (!r.ok(e)) return false;
          if (isHan(prev) && !(e.kind !== "prefecture" && before.endsWith(e.pref_name))) return false;
          if (r.role === "head" && (prev === "前" || prev === "元" || prev === "故")) return false;
          return true;
        });
        if (cands.length === 0) continue;
        // 同名の団体が複数：文に出る都道府県名で絞る。1 つに絞れなければ捨てる
        let pick = cands;
        if (cands.length > 1) {
          pick = cands.filter((e) => sentence.includes(e.pref_name));
          if (pick.length !== 1) { ambiguous = true; continue; }
        }
        found.push({ entry: pick[0], role: r.role, start: at, end: at + name.length + (r.role === "head" ? r.len : 2) });
      }
      at = sentence.indexOf(name, at + 1);
    }
  }
  return { found, ambiguous };
}

interface SignalHit { signal: NewsSignal; start: number; end: number; /** この語が指す職（解散請求＝議会、解職請求＝首長、リコール＝どちらでも） */ target: OfficeKind | "either" }

const NEGATIVE_AFTER = /^.{0,10}?(勧告|要求|求め|求める|促|否定|拒否|しない|せず|ない|撤回|見送|取りやめ|不信任)/;
const FAMILY_BETWEEN = /(の|\s)(父|母|妻|夫|祖父|祖母|兄|弟|姉|妹|長男|長女|次男|次女|息子|娘|親|家族|秘書|後援会|支持者)/;

function signalsIn(sentence: string): SignalHit[] {
  const out: SignalHit[] = [];
  const add = (re: RegExp, signal: NewsSignal, target: SignalHit["target"], negCheck: boolean) => {
    for (const m of sentence.matchAll(re)) {
      const start = m.index ?? 0, end = start + m[0].length;
      if (negCheck && NEGATIVE_AFTER.test(sentence.slice(end))) continue;
      out.push({ signal, start, end, target });
    }
  };
  add(/辞職|辞任|失職|退職願|辞意/g, "resignation", "head", true);
  add(/死去|死亡|急死|急逝|逝去|亡くな/g, "death", "head", false);
  add(/(?<!請求)解散(?!請求|総選挙|命令)/g, "dissolution", "assembly", true);
  add(/解散請求/g, "recall", "assembly", false);
  add(/解職請求|解職(?:の)?住民投票|解職賛成/g, "recall", "head", false);
  add(/リコール|解職(?:の)?署名/g, "recall", "either", false);
  return out;
}

const AFTER_MAX = 25;
const BEFORE_MAX = 15;

/** 1 つの文 → 線索 */
function leadsIn(sentence: string, idx: LgIndex): { leads: NewsLead[]; entity: boolean; ambiguous: boolean } {
  const { found, ambiguous } = entitiesIn(sentence, idx);
  if (found.length === 0) return { leads: [], entity: false, ambiguous };
  const sigs = signalsIn(sentence);
  const leads: NewsLead[] = [];
  const push = (e: Entity, kind: OfficeKind, signal: NewsSignal) => {
    if (leads.some((l) => l.lg_code === e.entry.lg_code && l.office_kind === kind && l.signal === signal)) return;
    leads.push({ lg_code: e.entry.lg_code, lg_name: e.entry.name, office_kind: kind, signal, matched: sentence.slice(e.start, e.end) });
  };
  for (const e of found) {
    for (const s of sigs) {
      const gapAfter = s.start - e.end, gapBefore = e.start - s.end;
      const near = (gapAfter >= 0 && gapAfter <= AFTER_MAX) || (gapBefore >= 0 && gapBefore <= BEFORE_MAX);
      if (!near) continue;
      // 辞職・死去は「その団体の首長」について書いた文だけ（議長や議員の辞職は首長選挙を要しない）
      if ((s.signal === "resignation" || s.signal === "death") && e.role !== "head") continue;
      // 「市長の父が死去」のように間に親族が入る文は対象外
      if (s.signal === "death" && gapAfter >= 0 && FAMILY_BETWEEN.test(sentence.slice(e.end, s.start))) continue;
      if (s.signal === "dissolution") {
        // 議会の解散：議会が主語か、首長が「議会」を解散する文（首長の語だけでは足りない）
        if (e.role === "head" && !sentence.includes("議会")) continue;
        push(e, "assembly", "dissolution");
        continue;
      }
      if (s.signal === "recall") {
        if (s.target === "either") push(e, e.role, "recall");
        else if (s.target === e.role || (s.target === "assembly" && sentence.includes("議会")) || (s.target === "head" && e.role === "head")) push(e, s.target, "recall");
        continue;
      }
      push(e, "head", s.signal);
    }
  }
  return { leads, entity: true, ambiguous };
}

/** 1 則（見出し＋要約）→ 篩いの結果。最大 2 件の線索 */
export function screenItem(item: { title: string; summary?: string | null }, idx: LgIndex): ScreenOutcome {
  const text = `${item.title}。${item.summary ?? ""}`;
  const leads: NewsLead[] = [];
  let entity = false, ambiguous = false;
  for (const s of sentencesOf(text)) {
    const r = leadsIn(s, idx);
    entity ||= r.entity;
    ambiguous ||= r.ambiguous;
    for (const l of r.leads) {
      if (!leads.some((x) => x.lg_code === l.lg_code && x.office_kind === l.office_kind && x.signal === l.signal)) leads.push(l);
    }
  }
  if (leads.length > 0) return { result: "lead", leads: leads.slice(0, 2) };
  if (entity) return { result: "no_signal", leads: [] };
  return { result: ambiguous ? "ambiguous" : "no_entity", leads: [] };
}

/** ISO 時刻 → 日本時間の日付（YYYY-MM-DD） */
export function jstDate(iso: string | null | undefined, fallback: Date): string {
  const d = iso && Number.isFinite(Date.parse(iso)) ? new Date(iso) : fallback;
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
