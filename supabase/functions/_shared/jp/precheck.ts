/**
 * 日本站の系統票：一件の交件の出典を取って Jev に聞き、policy_jp.jev_decisions に一列書いて共識を計算し直す。
 * jp-system-one?action=precheck がこれを候選ごとに呼ぶ（正見 system-one/index.ts の precheck の one() に当たる）。
 * 庫・Jev・出典取得は差し替え可能（試験は偽物を渡す：jp/precheck.test.ts）。
 */
import { stripNulDeep, type JevAnswer, type JevQuestion, MIN_PROBABILITY } from "../system-one.ts";
import {
  aggregateJpFieldVerdicts, buildJpSourceSupportAsk, combineJpSources, type JpClaimContext, jpClaimOf, type JpFetched, jpFetchSource, JP_FETCH_ONLY_MODEL, jpNameHit,
} from "./system-one.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

/** 一件あたり見る出典の数（正見 MAX_CHECKED_SOURCES と同じ 4） */
export const JP_MAX_CHECKED_SOURCES = 4;
const CONFLICT = "subject_type,subject_id,question,model,state_hash";

export interface PrecheckCandidate { contribution_id: string; contribution_type: string; payload: Record<string, unknown>; source_urls: string[] }
export type AskFn = (state: Record<string, unknown>, questions: Record<string, JevQuestion>) => Promise<{ model: string; answers: Record<string, JevAnswer>; usage: { cost: number } }>;
export type FetchFn = (url: string) => Promise<JpFetched>;
export interface PrecheckOutcome { key: string; asked: boolean; cost: number; choice: string; probability: number }


/** 宣稱に要る「頁面に出る字」を policy_jp から引く（人名、選挙名と投票日） */
export async function loadClaimContext(sb: Sb, type: string, payload: Record<string, unknown>): Promise<JpClaimContext> {
  const ctx: JpClaimContext = {};
  let politicianId = typeof payload.politician_id === "string" ? payload.politician_id : null;
  let electionId = typeof payload.election_id === "string" ? payload.election_id : null;
  if (type === "policy" && typeof payload.politician_election_id === "string") {
    const { data: pe } = await sb.from("politician_elections").select("politician_id, election_id").eq("id", payload.politician_election_id).maybeSingle();
    if (pe) { politicianId = pe.politician_id ?? politicianId; electionId = pe.election_id ?? electionId; }
  }
  if (politicianId && !(typeof payload.name === "string" && payload.name.trim())) {
    const { data: p } = await sb.from("politicians").select("name").eq("id", politicianId).maybeSingle();
    if (p && typeof p.name === "string") ctx.politicianName = p.name;
  }
  if (electionId && type === "candidacy") {
    const { data: e } = await sb.from("elections").select("name, election_date").eq("id", electionId).maybeSingle();
    if (e) { ctx.electionName = e.name ?? null; ctx.electionDate = e.election_date ?? null; }
  }
  return ctx;
}

async function insertDecision(sb: Sb, row: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from("jev_decisions").upsert(stripNulDeep([row]), { onConflict: CONFLICT, ignoreDuplicates: true }).select("id");
  if (error) throw new Error(`jev_decisions insert: ${error.message}`);
}

export async function precheckOne(sb: Sb, c: PrecheckCandidate, ask: AskFn, fetchSrc: FetchFn = (u) => jpFetchSource(u)): Promise<PrecheckOutcome> {
  const payload = { ...(c.payload ?? {}) };
  const ctx = await loadClaimContext(sb, c.contribution_type, payload);
  const claim = jpClaimOf(c.contribution_type, payload, ctx);
  const names = [claim.name, claim.politician_name].map((v) => (typeof v === "string" ? v : null));
  const urls = (c.source_urls ?? []).slice(0, JP_MAX_CHECKED_SOURCES);
  const fetched = await Promise.all(urls.map(async (u) => ({ url: u, ...(await fetchSrc(u)) })));
  const pages = fetched.filter((p) => p.kind === "html" && p.text.trim().length >= 20);
  const combined = combineJpSources(pages, names);
  const noName = !!combined && !jpNameHit(combined, names);
  let outcome: PrecheckOutcome;
  if (!combined || noName || Object.keys(claim).length === 0) {
    // 正文が取れない・主人公の名前がない → 聞かずに棄權（cannot_tell、確率 0）。紀錄は残す（候選清單が「判過」「再取得」を数える）
    const notes = (noName ? "主人公の名前が本文にない | " : "") + fetched.map((p) => `${p.kind}:${p.note}`).join(" | ");
    await insertDecision(sb, {
      subject_type: "contribution", subject_id: c.contribution_id, question: "source_support", choice: "cannot_tell", probability: 0, confidence: null, probabilities: null,
      model: JP_FETCH_ONLY_MODEL, state: { claim, page: { url: urls[0] ?? null, urls, text: "", fetch: fetched[0]?.kind ?? "error", note: notes } }, cost_usd: 0,
    });
    outcome = { key: noName ? "fetch:noname" : `fetch:${fetched[0]?.kind ?? "error"}`, asked: false, cost: 0, choice: "cannot_tell", probability: 0 };
  } else {
    const { state, questions } = buildJpSourceSupportAsk(claim, urls[0], combined);
    (state.page as Record<string, unknown>).urls = urls;
    const res = await ask(state, questions);
    const vote = aggregateJpFieldVerdicts(c.contribution_type, claim, res.answers);
    state.sources = { checked: fetched.map((p) => ({ url: p.url, kind: p.kind, note: p.note })) };
    await insertDecision(sb, {
      subject_type: "contribution", subject_id: c.contribution_id, question: "source_support", choice: vote.choice, probability: vote.probability, confidence: null,
      probabilities: vote.fields, model: res.model, state, cost_usd: Number(res.usage.cost.toFixed(8)),
    });
    outcome = { key: `${vote.choice}${vote.probability >= MIN_PROBABILITY ? "≥" : "<"}門檻`, asked: true, cost: res.usage.cost, choice: vote.choice, probability: vote.probability };
  }
  // 票が入ったら共識を計算し直す（supported で目標に届く／not_supported で目標が上がる）
  const { error } = await sb.rpc("contribution_apply_consensus", { p_contribution_id: c.contribution_id });
  if (error) throw new Error(`apply_consensus: ${error.message}`);
  return outcome;
}
