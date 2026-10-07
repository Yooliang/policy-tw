/**
 * 社群平台網域清單收成單一來源（盤點 #6，2026-10-07 維護者同意）。
 *
 * 以前四處各抄一份（5／9／13 個，內容不一樣）；現在 TS 只有 source-domains.ts 一份，
 * 這裡守三件事：
 *   1. **守門不放寬**：舊的三份清單（逐字寫在這支測試裡）每個網域現在都還在；新增的只有 lin.ee（收緊）
 *   2. SQL 那三個函式（career_source_readable／source_self_eligible／contribution_source_kind）與 TS 清單一字不差
 *   3. 沒有人在別處又抄一份
 * 行為（isUnreadableSocial／selfIneligibleReason／loginWalledOnly）也各測一輪。
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  hostInList,
  LOGIN_WALLED_EXTRA_HOSTS,
  LOGIN_WALLED_HOSTS,
  NON_OWN_SITE_PLATFORM_HOSTS,
  SELF_INELIGIBLE_HOSTS,
  UNREADABLE_SOCIAL_HOSTS,
} from "./source-domains.ts";
import { isUnreadableSocial } from "./lineage.ts";
import { selfIneligibleReason } from "./source-write.ts";
import { loginWalledOnly } from "./question-intake.ts";
import { SOURCE_PRIORITY } from "./source-priority.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** 某個函式「現行」的定義：掃所有 migration，取最後一次 CREATE OR REPLACE FUNCTION name( 到結尾 */
async function latestDef(name: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\(`);
  let def: string | null = null;
  for (const n of names) {
    const sql = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r/g, "");
    const i = sql.search(re);
    if (i < 0) continue;
    const rest = sql.slice(i);
    const tag = /AS (\$[a-z]*\$)/.exec(rest);
    if (!tag) continue;
    const start = rest.indexOf(tag[0]) + tag[0].length;
    def = rest.slice(0, rest.indexOf(tag[1], start) + tag[1].length);
  }
  if (!def) throw new Error(`找不到 ${name}`);
  return def;
}

// 2026-10-07 之前三份清單的原樣（拿掉任何一個＝守門變鬆）
const OLD_UNREADABLE = ["facebook.com", "fb.com", "fb.watch", "instagram.com", "threads.net"];
const OLD_SELF_INELIGIBLE = [...OLD_UNREADABLE, "youtube.com", "youtu.be", "x.com", "twitter.com", "tiktok.com", "line.me", "lin.ee", "t.me"];
const OLD_LOGIN_WALLED = [...OLD_UNREADABLE, "line.me", "x.com", "twitter.com", "tiktok.com"];

Deno.test("守門不放寬：舊的三份清單，每個網域現在都還在；新增的只有 lin.ee（提問入口，收緊）", () => {
  assertEquals([...UNREADABLE_SOCIAL_HOSTS].sort(), [...OLD_UNREADABLE].sort(), "讀不到的平台不當出處——這條一個都不能少、也不能偷加");
  assertEquals([...SELF_INELIGIBLE_HOSTS].sort(), [...OLD_SELF_INELIGIBLE].sort());
  for (const h of OLD_LOGIN_WALLED) assert((LOGIN_WALLED_HOSTS as readonly string[]).includes(h), `提問入口少了 ${h}`);
  assertEquals(LOGIN_WALLED_HOSTS.filter((h) => !OLD_LOGIN_WALLED.includes(h)), ["lin.ee"]);
});

Deno.test("清單的包含關係（用途對得上）：讀不到的＝一定要登入＝一定不能當本人來源", () => {
  const self = SELF_INELIGIBLE_HOSTS as readonly string[];
  for (const h of UNREADABLE_SOCIAL_HOSTS) assert((LOGIN_WALLED_HOSTS as readonly string[]).includes(h), `${h}：讀不到的平台提問入口也要擋`);
  for (const h of LOGIN_WALLED_HOSTS) assert(self.includes(h), `${h}：要登入才看得到的平台不能當本人來源`);
  for (const h of LOGIN_WALLED_EXTRA_HOSTS) assert(!(UNREADABLE_SOCIAL_HOSTS as readonly string[]).includes(h), `${h} 不該同時在 UNREADABLE（那份是出處守門，只放臉書家族）`);
  for (const h of NON_OWN_SITE_PLATFORM_HOSTS) assert(!(UNREADABLE_SOCIAL_HOSTS as readonly string[]).includes(h));
  // source-priority 標成 social 的（派工排序用）也全都不能當本人來源
  for (const s of SOURCE_PRIORITY.filter((x) => x.kind === "social")) assert(self.includes(s.host), s.host);
});

Deno.test("SQL 與 TS 一致：career_source_readable() 擋的網域＝UNREADABLE_SOCIAL_HOSTS", async () => {
  const def = await latestDef("career_source_readable");
  const m = /\(\^\|\\\.\)\(([^)]+)\)\$/.exec(def);
  assert(m, "抓不到 SQL 的網域正規式");
  const sqlHosts = m[1].split("|").map((s) => s.replace(/\\\./g, ".")).sort();
  assertEquals(sqlHosts, [...UNREADABLE_SOCIAL_HOSTS].sort());
});

Deno.test("SQL 與 TS 一致：source_self_eligible() 的平台清單＝SELF_INELIGIBLE_HOSTS", async () => {
  const def = await latestDef("source_self_eligible");
  const m = /ARRAY\[([^\]]+)\]/.exec(def);
  assert(m, "抓不到 SQL 的網域清單");
  const sqlHosts = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  assertEquals(sqlHosts, [...SELF_INELIGIBLE_HOSTS].sort());
});

Deno.test("SQL 與 TS 一致：contribution_source_kind() 的社群等級＝SOURCE_PRIORITY 的 social", async () => {
  const def = await latestDef("contribution_source_kind");
  const social = /ARRAY\[([^\]]+)\]\) THEN 1/.exec(def);
  assert(social, "抓不到 SQL 的社群清單");
  const sqlHosts = social[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  assertEquals(sqlHosts, SOURCE_PRIORITY.filter((s) => s.kind === "social").map((s) => s.host).sort());
});

Deno.test("沒有人在別處又抄一份：fb.watch 只出現在 source-domains.ts", async () => {
  const stray: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const path = rel + e.name;
      if (path === "_shared/source-domains.ts") continue;
      const text = (await Deno.readTextFile(new URL(e.name, dir))).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
      if (/fb\\?\.watch/.test(text)) stray.push(path);
    }
  }
  await walk(new URL("../", import.meta.url), "");
  assertEquals(stray, [], "社群平台清單請 import source-domains.ts，不要再抄一份");
});

Deno.test("hostInList：子網域算、長得像的不算", () => {
  assert(hostInList("m.facebook.com", UNREADABLE_SOCIAL_HOSTS));
  assert(hostInList("WWW.Instagram.com", UNREADABLE_SOCIAL_HOSTS));
  assertFalse(hostInList("evilfacebook.com", UNREADABLE_SOCIAL_HOSTS));
  assertFalse(hostInList("facebook.com.evil.tw", UNREADABLE_SOCIAL_HOSTS));
});

Deno.test("行為不變：isUnreadableSocial／selfIneligibleReason 對每個舊清單網域與子網域的判定", () => {
  for (const h of OLD_UNREADABLE) {
    assert(isUnreadableSocial(`https://${h}/x`), h);
    assert(isUnreadableSocial(`https://www.${h}/x`), `www.${h}`);
    assert(isUnreadableSocial(`https://m.${h}/x`), `m.${h}`);
  }
  for (const u of ["https://www.youtube.com/watch?v=1", "https://x.com/a", "https://line.me/R/ti/p/1", "https://www.cna.com.tw/n", "https://evilfacebook.com/x", "not a url", null]) {
    assertFalse(isUnreadableSocial(u), String(u));
  }
  for (const h of OLD_SELF_INELIGIBLE) {
    const r = selfIneligibleReason(`https://${h}/candidate`);
    assert(r !== null && r.includes("社群平台不能當本人來源"), `${h} 不能當本人來源`);
    assert(selfIneligibleReason(`https://www.${h}/candidate`)?.includes("社群平台"), `www.${h}`);
  }
  assertEquals(selfIneligibleReason("https://www.candidate-wang.tw/policy"), null, "本人官網照樣可以");
});

Deno.test("行為：loginWalledOnly——舊的 9 個網域只貼連結照擋，lin.ee 補上，公開平台不擋，有文字就放行", () => {
  for (const h of OLD_LOGIN_WALLED) {
    assert(loginWalledOnly(`https://${h}/post/1`), `${h} 只貼連結要擋`);
    assert(loginWalledOnly(`看這個 https://www.${h}/post/1`), `www.${h}（字數不夠）要擋`);
  }
  assert(loginWalledOnly("https://lin.ee/abc123"), "lin.ee 是 LINE 的短網址，跟 line.me 同一個服務");
  assertFalse(loginWalledOnly("https://www.youtube.com/watch?v=1"), "YouTube 公開影片讀得到");
  assertFalse(loginWalledOnly("https://t.me/s/channel"), "Telegram 公開頻道讀得到");
  assertFalse(loginWalledOnly("https://www.cna.com.tw/news/1"));
  assertFalse(loginWalledOnly("https://www.facebook.com/p/1 https://www.cna.com.tw/news/1"), "有一個讀得到的連結就放行");
  assertFalse(loginWalledOnly("市長說要蓋三座公共托育中心，這是真的嗎？https://www.facebook.com/p/1"), "有 15 字以上的內容就放行");
  assertFalse(loginWalledOnly("沒有連結的提問"));
});
