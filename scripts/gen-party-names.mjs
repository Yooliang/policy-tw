// 從 lib/party-seed.json（內政部政黨名冊＋寫法對照）產生 supabase/functions/_shared/party-names.ts。
// Edge Function 只能 import 自己資料夾裡的檔案，讀不到 lib/，所以產一份複本；
// _shared/party-names.test.ts 比對兩邊，名冊更新了沒重產就會紅。用法：node scripts/gen-party-names.mjs
import fs from "node:fs";

const seed = JSON.parse(fs.readFileSync(new URL("../lib/party-seed.json", import.meta.url), "utf8"));
const names = [...new Set([...seed.parties.map((p) => p.name), ...seed.aliases.map((a) => a.alias)])].sort();
const out = `// 自動產生（scripts/gen-party-names.mjs，來源 lib/party-seed.json：內政部政黨名冊 ${seed.fetched_on} 的政黨名稱與寫法對照），不要手改。
// 中選會名冊 PDF 的「推薦之政黨」切欄用：只有「合起來是已知政黨」的碎片才接回同一個黨名（cec-roster.ts）。
export const ROSTER_PARTY_NAMES: readonly string[] = ${JSON.stringify(names, null, 1)};
`;
fs.writeFileSync(new URL("../supabase/functions/_shared/party-names.ts", import.meta.url), out);
console.log(`${names.length} 個政黨名稱／寫法`);
