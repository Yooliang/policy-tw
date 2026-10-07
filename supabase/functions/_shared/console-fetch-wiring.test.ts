import { assert, assertEquals } from "jsr:@std/assert@1";

// console-fetch 的接線：函式、config.toml、migration、CI 部署清單要對得上。
// 這些各自單獨看都對，接錯一處（驗證被拿掉、排程打到別的網址、金鑰寫進 migration）才是真正會出事的地方。
const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const idx = await read("../console-fetch/index.ts");
const cfg = await read("../../config.toml");

async function cronMigration(): Promise<{ name: string; sql: string }> {
  const dir = new URL("../../migrations/", import.meta.url);
  let found: { name: string; sql: string } | undefined;
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    if (sql.includes("cron.schedule('console-fetch-hourly'")) found = { name, sql };
  }
  assert(found, "找不到排 console-fetch-hourly 的 migration");
  return found;
}

Deno.test("console-fetch：POST 才收，而且在做任何事（讀金鑰、打 Google、寫 Firestore）之前先驗呼叫者", () => {
  const verify = idx.indexOf("verifyCaller(");
  assert(verify > 0, "index.ts 要呼叫 verifyCaller");
  const reject = idx.indexOf("if (!check.ok) return json(");
  assert(reject > verify, "驗證沒過要直接回應、不能往下做（拿掉這一行等於公開）");
  for (const later of ["parseServiceAccountKey(env", "makeFirestoreStore(", "runConsoleFetch(", "makeTokenGetter("]) {
    const at = idx.indexOf(later);
    assert(at > reject, `${later} 要排在驗證之後`);
  }
  assert(idx.includes('req.method !== "POST"'), "只收 POST");
  assert(idx.includes('Deno.env.get("CONSOLE_FETCH_CRON_SECRET")') && idx.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")'), "驗證憑證來自環境變數");
});

Deno.test("console-fetch：讀的環境變數名稱與 GitHub secrets 同名（另一台機器照這些名稱設 Supabase secrets）", async () => {
  const shared = await read("./console-fetch.ts");
  assert(shared.includes('["GCP_SA_KEY", "ADSENSE_REFRESH_TOKEN", "ADSENSE_CLIENT_ID", "ADSENSE_CLIENT_SECRET"]'));
});

Deno.test("console-fetch：config.toml 有登記，verify_jwt 關（pg_cron 不帶 JWT），entrypoint 指對", () => {
  const m = /\[functions\.console-fetch\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
  assert(m, "config.toml 要有 [functions.console-fetch]");
  assert(/verify_jwt = false/.test(m[1]));
  assert(m[1].includes('entrypoint = "./functions/console-fetch/index.ts"'));
});

Deno.test("console-fetch 排程：每小時第 17 分、打 console-fetch、帶 Vault 裡的 x-cron-secret、migration 裡沒有任何金鑰值", async () => {
  const { sql } = await cronMigration();
  assert(sql.includes("cron.schedule('console-fetch-hourly', '17 * * * *'"), "每小時第 17 分");
  assert(sql.includes("https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/console-fetch'"), "網址要指向 console-fetch（不是別支）");
  assert(sql.includes("'x-cron-secret'") && sql.includes("vault.decrypted_secrets") && sql.includes("name = 'console_fetch_cron_secret'"), "標頭值要從 Vault 讀");
  assert(sql.includes("COALESCE("), "Vault 沒有值時帶空字串（函式會回 401），不是整條 cron 炸掉");
  // 不含寫死的憑證：沒有 JWT 長相（eyJ…）、沒有 Bearer、沒有 vault.create_secret 帶實際值
  assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(sql), "不得有 JWT");
  assert(!/bearer\s+[A-Za-z0-9]/i.test(sql.replace(/--.*$/gm, "")), "SQL 本體不得寫死 Bearer");
  const body = sql.replace(/--.*$/gm, "");
  assert(!/vault\.create_secret/.test(body), "建立 secret 不放在 migration（值不進版控）");
  // 重複套用安全：先 unschedule（存在才做）再 schedule
  assertEquals(sql.includes("cron.unschedule('console-fetch-hourly')"), true);
});

Deno.test("console-fetch：CI 的部署清單會包含它（affected-functions 從 index.ts 的相對 import 追到 _shared）", async () => {
  // 部署走 scripts/affected-functions.mjs：函式目錄的 index.ts 或它 import 的 _shared 檔有動就部署。
  // 這裡守「index.ts 確實 import 這兩個 _shared 檔」——import 拿掉的話，改 _shared 就不會觸發重新部署。
  assert(idx.includes('from "../_shared/console-fetch.ts"') && idx.includes('from "../_shared/console-fetch-auth.ts"'));
  const ci = await Deno.readTextFile(new URL("../../../.github/workflows/ci.yml", import.meta.url));
  assert(ci.includes("node scripts/affected-functions.mjs"), "ci.yml 要用 affected-functions 算部署清單");
});