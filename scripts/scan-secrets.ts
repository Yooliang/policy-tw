/**
 * 掃出不該進版控的金鑰。用 Deno 跑（CI 已經為 edge 測試裝了 Deno）：
 *   deno run --allow-read scripts/scan-secrets.ts
 *
 * 為什麼要解開 JWT：這個專案的 anon key 是刻意公開的（前端就是拿它讀資料），
 * 光看「eyJ...」的長相會把正常的 .env 與說明文件全部判成外洩，這種燈很快就會
 * 被人關掉。真正不能外流的是 service_role 那把——它繞過 RLS，等於全站可寫。
 * 所以這裡解開 payload 看 role 欄位，只擋 anon 以外的。
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vite", "coverage"]);
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
const SUPABASE_PAT = /\bsbp_[A-Za-z0-9]{20,}\b/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const NUL = String.fromCharCode(0);

interface Finding { file: string; line: number; what: string }

function decodeRole(payloadB64: string): string | null {
  try {
    const pad = payloadB64.length % 4 === 0 ? "" : "=".repeat(4 - (payloadB64.length % 4));
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const role = JSON.parse(json)?.role;
    return typeof role === "string" ? role : null;
  } catch {
    return null; // 解不開就不是我們認得的 Supabase JWT，當成未知處理
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(`${dir}/${entry.name}`);
    } else if (entry.isFile) {
      yield `${dir}/${entry.name}`;
    }
  }
}

const SELF = "scripts/scan-secrets.ts";
const findings: Finding[] = [];

for await (const path of walk(".")) {
  const rel = path.replace(/^\.\//, "");
  if (rel === SELF) continue;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    continue; // 二進位或讀不到的檔案跳過
  }
  if (text.includes(NUL)) continue;

  text.split("\n").forEach((line, i) => {
    const at = { file: rel, line: i + 1 };
    for (const m of line.matchAll(JWT)) {
      const role = decodeRole(m[1]);
      if (role === "anon") continue; // 公開的那把，正常
      findings.push({ ...at, what: role ? `JWT 的 role 是 ${role}` : "看不出 role 的 JWT" });
    }
    if (SUPABASE_PAT.test(line)) findings.push({ ...at, what: "Supabase 個人存取權杖（sbp_）" });
    if (PRIVATE_KEY.test(line)) findings.push({ ...at, what: "私鑰檔案內容" });
  });
}

if (findings.length > 0) {
  console.error("發現不該進版控的金鑰：");
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.what}`);
  console.error("");
  console.error("service_role 金鑰一旦進版控等於全站可寫；請改用環境變數或 GitHub Secrets，並輪替已外洩的那一把。");
  Deno.exit(1);
}
console.log("沒有發現不該進版控的金鑰（公開的 anon key 不算）");
