/**
 * 日本站人物頭像の機器核對（commons-avatar.ts、policy-ops#162）：
 *   授權白名單（CC0／Public domain 類／CC BY／CC BY-SA の各版。NC・ND・fair use・GFDL・不明は拒む）、Commons 以外の網址を拒む、
 *   Commons API の応答との照合（授權不一致・作者不一致・画像が別ファイル・ファイルがない・NonFree・作者の記載なしの CC BY）、
 *   API 応答の解釈、署名（licenseUrl）、交件端（handleContribute）で 422／503／201 になること、白名單が SQL と一字違わないこと。
 * ネットワークには出ない（Commons 照会は差し替え）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AVATAR_LICENSE_RE, authorMatches, avatarProblems, avatarShapeProblem, checkCommonsAvatar, COMMONS_FILE_PAGE_RE, COMMONS_IMAGE_URL_RE,
  commonsLicenseUrl, CommonsUnavailable, commonsTitleOf, type CommonsInfo, htmlToText, isAvatarLicense, isSameCommonsImage, parseCommonsResponse,
} from "./commons-avatar.ts";
import { handleContribute } from "./contribute-handler.ts";

const FILE = "https://commons.wikimedia.org/wiki/File:Taro_Yamada_2024.jpg";
const IMG = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Taro_Yamada_2024.jpg";
const THUMB = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Taro_Yamada_2024.jpg/500px-Taro_Yamada_2024.jpg";
const CLAIM = { image_url: IMG, file_page_url: FILE, license: "CC BY-SA 4.0", author: "Hanako Suzuki" };
const INFO: CommonsInfo = { url: IMG, license: "CC BY-SA 4.0", artist: "Hanako Suzuki", nonFree: false };
const lookup = (info: CommonsInfo | null) => (_t: string) => Promise.resolve(info);

Deno.test("授權白名單：CC0／Public domain 類／CC BY／CC BY-SA の各版だけ", () => {
  for (const ok of ["CC0", "CC0 1.0", "Public domain", "PD-Japan", "PD-old-70", "CC BY 2.0", "CC BY 4.0", "CC BY-SA 3.0", "CC BY-SA 4.0", "CC BY-SA 2.0 de", "CC BY-SA 3.0 pt-br", "CC BY 2.5"]) {
    assert(isAvatarLicense(ok), ok);
  }
  for (const ng of ["CC BY-NC 4.0", "CC BY-ND 2.0", "CC BY-NC-SA 3.0", "GFDL", "GFDL 1.2", "Fair use", "Attribution", "All rights reserved", "", "CC BY", "CC BY 4", "Copyrighted free use", "CC BY-SA", "Public domain mark but NC"]) {
    // 最後の一つは PD 前置にならないので拒む
    assert(!isAvatarLicense(ng), ng);
  }
});

Deno.test("白名單は SQL（表の CHECK・落庫）と一字違わない", async () => {
  const sql = (await Deno.readTextFile(new URL("../../../migrations/20261030120000_policy_jp_avatar.sql", import.meta.url))).replace(/\r\n/g, "\n");
  // TS は [ -]・\d・\. を使い、SQL は [0-9]・\. を使う。PostgreSQL の正規式として読める形に直した TS の正規式が、SQL に現れること
  const asPg = AVATAR_LICENSE_RE.source.replaceAll("\\d", "[0-9]").replaceAll("\\.", "\\.");
  assert(sql.includes(`'${asPg}'`), `SQL に同じ正規式がない: ${asPg}`);
  assertEquals(sql.split(`'${asPg}'`).length - 1, 2, "表の CHECK と落庫の 2 か所");
  assert(sql.includes("'^https://upload\\.wikimedia\\.org/wikipedia/commons/[^[:space:]]+$'"));
  assert(sql.includes("'^https://commons\\.wikimedia\\.org/wiki/File:[^[:space:]#?]+$'"));
  // TS の網址正規式は、SQL と同じ集合を通す
  assert(COMMONS_IMAGE_URL_RE.test(IMG) && COMMONS_FILE_PAGE_RE.test(FILE));
});

Deno.test("形：Commons 以外の網址・非白名單・作者なしを拒む", () => {
  assertEquals(avatarShapeProblem(CLAIM), null);
  const bad = (o: Record<string, unknown>) => avatarShapeProblem({ ...CLAIM, ...o })?.path;
  assertEquals(bad({ image_url: "https://example.com/a.jpg" }), "payload.image_url");
  assertEquals(bad({ image_url: "https://upload.wikimedia.org/wikipedia/ja/a/ab/X.jpg" }), "payload.image_url", "ja.wikipedia の fair use 画像は commons ではない");
  assertEquals(bad({ image_url: "http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg" }), "payload.image_url");
  assertEquals(bad({ file_page_url: "https://ja.wikipedia.org/wiki/File:X.jpg" }), "payload.file_page_url");
  assertEquals(bad({ file_page_url: "https://commons.wikimedia.org/wiki/Category:X" }), "payload.file_page_url");
  assertEquals(bad({ file_page_url: "https://commons.wikimedia.org.evil.example/wiki/File:X.jpg" }), "payload.file_page_url");
  assertEquals(bad({ license: "CC BY-NC 4.0" }), "payload.license");
  assertEquals(bad({ author: "" }), "payload.author");
  assertEquals(bad({ author: "  " }), "payload.author");
  assertEquals(bad({ author: "あ".repeat(301) }), "payload.author");
  assertEquals(bad({ license: undefined }), "payload.license");
});

Deno.test("署名：授權條款の網址", () => {
  assertEquals(commonsLicenseUrl("CC BY-SA 4.0"), "https://creativecommons.org/licenses/by-sa/4.0/");
  assertEquals(commonsLicenseUrl("CC BY 2.0"), "https://creativecommons.org/licenses/by/2.0/");
  assertEquals(commonsLicenseUrl("CC BY-SA 2.0 de"), "https://creativecommons.org/licenses/by-sa/2.0/de/");
  assertEquals(commonsLicenseUrl("CC0"), "https://creativecommons.org/publicdomain/zero/1.0/");
  assertEquals(commonsLicenseUrl("Public domain"), null);
  assertEquals(commonsLicenseUrl("GFDL"), null);
});

Deno.test("ファイル名・画像の照合", () => {
  assertEquals(commonsTitleOf(FILE), "File:Taro Yamada 2024.jpg");
  assertEquals(commonsTitleOf("https://commons.wikimedia.org/wiki/File:%E5%B1%B1%E7%94%B0.jpg"), "File:山田.jpg");
  assertEquals(commonsTitleOf("https://commons.wikimedia.org/wiki/Main_Page"), null);
  assert(isSameCommonsImage(IMG, IMG));
  assert(isSameCommonsImage(IMG, THUMB), "縮小画像");
  assert(!isSameCommonsImage(IMG, "https://upload.wikimedia.org/wikipedia/commons/c/cd/Other.jpg"));
  assert(!isSameCommonsImage(IMG, "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Other.jpg/500px-Other.jpg"));
  assert(!isSameCommonsImage(IMG, "https://upload.wikimedia.org/wikipedia/commons/a/ab/Taro_Yamada_2024.jpg.evil"));
});

Deno.test("作者：HTML を落とした表示と一致（包含）。短すぎる包含は認めない", () => {
  assertEquals(htmlToText('<a href="//commons.wikimedia.org/wiki/User:Hanako" title="User:Hanako">Hanako&nbsp;Suzuki</a> &amp; Co'), "Hanako Suzuki & Co");
  assert(authorMatches("Hanako Suzuki", "Hanako Suzuki"));
  assert(authorMatches("hanako suzuki", "User:Hanako Suzuki"));
  assert(authorMatches("Hanako Suzuki (Wikimedia user)", "Hanako Suzuki"));
  assert(!authorMatches("Taro", "Hanako Suzuki"));
  assert(!authorMatches("a", "Hanako Suzuki"), "1 字は包含で通さない");
  assert(!authorMatches("", "Hanako"));
});

Deno.test("照合：全部一致で ok。授權・作者・画像・ファイルなし・NonFree・作者の記載なしの CC BY は不可", async () => {
  assertEquals(await checkCommonsAvatar(CLAIM, lookup(INFO)), { ok: true });
  assertEquals(await checkCommonsAvatar({ ...CLAIM, image_url: THUMB }, lookup(INFO)), { ok: true }, "縮小画像");
  const fail = async (claim: Record<string, string>, info: CommonsInfo | null) => {
    const r = await checkCommonsAvatar({ ...CLAIM, ...claim }, lookup(info));
    assert(!r.ok, JSON.stringify(r));
    return r.ok ? "" : r.path;
  };
  assertEquals(await fail({ license: "CC BY 4.0" }, INFO), "payload.license", "Commons と授權が違う");
  assertEquals(await fail({}, { ...INFO, license: "CC BY-NC 4.0" }), "payload.license", "Commons 側が NC（交件が CC BY-SA と偽っても）");
  assertEquals(await fail({}, { ...INFO, license: "" }), "payload.license", "授權表示なし");
  assertEquals(await fail({}, { ...INFO, nonFree: true }), "payload.license");
  assertEquals(await fail({ author: "Someone Else" }, INFO), "payload.author");
  assertEquals(await fail({ image_url: "https://upload.wikimedia.org/wikipedia/commons/c/cd/Other.jpg" }, INFO), "payload.image_url", "別ファイルの画像");
  assertEquals(await fail({}, null), "payload.file_page_url", "ファイルがない");
  assertEquals(await fail({}, { ...INFO, artist: "" }), "payload.author", "作者の記載がない CC BY-SA は帰属を確かめられない");
  // 公有領域・CC0 で作者の記載がないファイルは、交件の author（必須）を信じて通す
  assertEquals(await checkCommonsAvatar({ ...CLAIM, license: "Public domain", author: "不明（戦前の撮影）" }, lookup({ ...INFO, license: "Public domain", artist: "" })), { ok: true });
  assertEquals(await checkCommonsAvatar({ ...CLAIM, license: "CC0", author: "x y" }, lookup({ ...INFO, license: "CC0", artist: "" })), { ok: true });
});

Deno.test("Commons API の応答の解釈", () => {
  const ok = parseCommonsResponse({ query: { pages: [{ title: "File:A.jpg", imageinfo: [{ url: IMG, extmetadata: {
    LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: '<a href="x">Hanako Suzuki</a>' }, NonFree: { value: "" } } }] }] } });
  assertEquals(ok, { url: IMG, license: "CC BY-SA 4.0", artist: "Hanako Suzuki", nonFree: false });
  assertEquals(parseCommonsResponse({ query: { pages: [{ title: "File:A.jpg", missing: true }] } }), null);
  assertEquals(parseCommonsResponse({ query: { pages: [{ title: "File:A.jpg", imageinfo: [{ url: IMG, extmetadata: { NonFree: { value: "true" } } }] }] } })?.nonFree, true);
  let threw = false;
  try { parseCommonsResponse({ error: { code: "x" } }); } catch (e) { threw = e instanceof CommonsUnavailable; }
  assert(threw, "形の違う応答は一時的な不通として扱う");
});

Deno.test("一括：politician_avatar だけ照合・同じページは一回だけ問い合わせ・問題は index つき・不通は unavailable", async () => {
  let calls = 0;
  const counted = (info: CommonsInfo | null) => (_t: string) => { calls++; return Promise.resolve(info); };
  const items = [
    { contribution_type: "no_change", payload: {} },
    { contribution_type: "politician_avatar", payload: { politician_id: "p", ...CLAIM } },
    { contribution_type: "politician_avatar", payload: { politician_id: "q", ...CLAIM } },
    { contribution_type: "politician_avatar", payload: { politician_id: "r", ...CLAIM, license: "CC BY 4.0" } },
  ];
  const out = await avatarProblems(items, counted(INFO));
  assertEquals(calls, 1);
  assertEquals(out.map((p) => [p.index, p.path]), [[3, "payload.license"]]);
  const down = await avatarProblems(items.slice(1, 2), () => Promise.reject(new CommonsUnavailable("no net")));
  assertEquals(down.length, 1);
  assert(down[0].unavailable);
});

// ---- 交件端 ----
function fakeSupabase() {
  const inserted: Array<Record<string, unknown>> = [];
  const api = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: Array<Record<string, unknown>>) => {
          inserted.push(...rows);
          return { select: () => ({ data: rows.map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) };
        },
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) => res({ data: [], error: null, count: 0 }),
      };
      return chain;
    },
  };
  return { api, inserted };
}
const body = (o: Record<string, unknown> = {}) => ({
  agent_name: "tester-1", agent_tool: "test/model", contribution_type: "politician_avatar", source_urls: [FILE],
  payload: { politician_id: "p-1", ...CLAIM, ...o },
});
const noVote = () => { throw new Error("不該投票"); };

Deno.test("交件端：一致なら 201、授權が偽りなら 422（収下しない）、Commons に繋がらなければ 503（退件ではない）", async () => {
  const okFx = fakeSupabase();
  const ok = await handleContribute(okFx.api, "https://x", body(), "ip-1", noVote, "report", undefined, undefined, lookup(INFO));
  assertEquals(ok.status, 201, JSON.stringify(ok.body));
  assertEquals(okFx.inserted.length, 1);

  const fx = fakeSupabase();
  const liar = await handleContribute(fx.api, "https://x", body({ license: "CC BY 4.0" }), "ip-2", noVote, "report", undefined, undefined, lookup(INFO));
  assertEquals(liar.status, 422);
  assertEquals(liar.body.error, "avatar_check_failed");
  assertEquals(fx.inserted.length, 0);

  const nc = await handleContribute(fx.api, "https://x", body({ license: "CC BY-NC 4.0" }), "ip-3", noVote, "report", undefined, undefined, lookup({ ...INFO, license: "CC BY-NC 4.0" }));
  assertEquals(nc.status, 400, "形の段階（白名單外）で 400");

  const notCommons = await handleContribute(fx.api, "https://x", body({ image_url: "https://example.com/a.jpg" }), "ip-4", noVote, "report", undefined, undefined, lookup(INFO));
  assertEquals(notCommons.status, 400);
  assertEquals(fx.inserted.length, 0);

  const down = await handleContribute(fx.api, "https://x", body(), "ip-5", noVote, "report", undefined, undefined, () => Promise.reject(new CommonsUnavailable("down")));
  assertEquals(down.status, 503);
  assertEquals(down.body.error, "avatar_check_unavailable");
  assertEquals(fx.inserted.length, 0);

  const noSource = await handleContribute(fx.api, "https://x", { ...body(), source_urls: ["https://example.com/"] }, "ip-6", noVote, "report", undefined, undefined, lookup(INFO));
  assertEquals(noSource.status, 400, "source_urls に file_page_url が要る");
});
