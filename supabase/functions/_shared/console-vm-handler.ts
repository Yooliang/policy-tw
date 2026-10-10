import { isConsoleOwner, verifyFirebaseIdToken } from "./firebase-id-token.ts";
import { corsPreflight, errorMessage, json } from "./console-admin-handler.ts";

/**
 * console-vm 的業務邏輯：主控台（policy-console）看驗證 VM 狀態、開一輪、關機。
 * 工作單：Yooliang/policy-ops#65（2026-10-10 小良哥「我可以將 vm 開關 狀態 進度 給做到 console 上吧」）。
 *
 * 規則跟 policy-ops scripts/verify-vm/go.sh 一致：
 *   - 三台：us＝policy-verifier（us-central1-a）、tw＝policy-verifier-tw（asia-east1-b）、jp＝policy-verifier-jp（asia-northeast1-a）
 *   - 站別只有 tw／jp，兩站都正常跑（verify-only=0）
 *   - 帳號字母：g＝gsit（provider claude）、c＝cwen（provider claude3）。y＝yooliang 不收——
 *     2026-10-10 小良哥裁：yooliang 全部留給開發（policy-ops docs/decisions/2026-10-10-yooliang帳號留給開發VM只用gsit.md）
 *   - 沒指定機器就從關著的三台隨機挑一台
 * 驗證同 console-admin：Firebase ID Token＋主控台擁有者信箱。GCP 那邊用專用服務帳號 console-vm，只對三台有 get/start/stop/setMetadata/讀序列埠。
 * 序列埠只抽 `=== AGENT-START … ===` 標記行數，不回傳原文（原文會有代理的輸出）。
 */

export const VMS = {
  us: { name: "policy-verifier", zone: "us-central1-a", region: "美國" },
  tw: { name: "policy-verifier-tw", zone: "asia-east1-b", region: "台灣" },
  jp: { name: "policy-verifier-jp", zone: "asia-northeast1-a", region: "東京" },
} as const;
export type VmKey = keyof typeof VMS;
const VM_KEYS = Object.keys(VMS) as VmKey[];

export const ACCOUNTS = { g: { account: "gsit", provider: "claude" }, c: { account: "cwen", provider: "claude3" } } as const;
const PROVIDER_ACCOUNT: Record<string, string> = { claude: "gsit", claude2: "yooliang", claude3: "cwen" };
const MODEL = "claude-sonnet-5";
const MAX_AGENTS = 8;
const MAX_HOURS = 6;

export interface MetadataItem { key: string; value: string }
export interface Instance {
  status: string;
  lastStartTimestamp?: string;
  metadata?: { fingerprint?: string; items?: MetadataItem[] };
}
/** Compute Engine 的最小介面（index.ts 實作成真的 REST 呼叫；測試注入假的） */
export interface Gce {
  get(name: string, zone: string): Promise<Instance>;
  setMetadata(name: string, zone: string, fingerprint: string | undefined, items: MetadataItem[]): Promise<void>;
  start(name: string, zone: string): Promise<void>;
  stop(name: string, zone: string): Promise<void>;
  serial(name: string, zone: string): Promise<string>;
}

export interface ConsoleVmDeps {
  gce: Gce | null;
  projectId: string;
  ownerEmail: string;
  verifyToken?: typeof verifyFirebaseIdToken;
  random?: () => number;
}

const GIVEN = "andy jason mike kevin david peter tony eric steve brian chris danny frank gary henry ian jack james jeff john ken larry mark matt nick paul ray rick rob roy sam scott sean simon tim tom victor wayne will alan andrew bruce carl craig dean derek doug gordon greg harry howard hugh jerry joe keith leon neil oscar philip ralph randy ron russell terry todd troy walter warren amy anna becky carol cathy cindy diana emily emma grace helen irene jane janet jenny jessica judy julie karen kate laura linda lisa lucy mandy mary maggie michelle nancy nicole olivia rachel rebecca ruby sally sandra sarah sharon sophie stella susan tina tracy vicky wendy betty carrie connie dana eileen fiona gloria hannah".split(" ");
const FAMILY = "smith jones brown taylor miller davis wilson moore clark lewis walker hall allen young king wright scott green baker adams nelson carter mitchell roberts turner phillips campbell parker evans edwards collins stewart morris murphy cook rogers morgan peterson cooper reed bailey bell kelly howard ward cox richardson wood watson brooks bennett gray price".split(" ");

/** 產代號：三種風格輪流（同 gen_names.py：單名／名.姓／名+兩位數），同一輪不重複 */
export function genNames(n: number, rnd: () => number): string[] {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const out: string[] = [];
  for (let i = 0; out.length < n && i < n * 50; i++) {
    const s = (out.length + Math.floor(rnd() * 3)) % 3;
    const x = s === 0 ? pick(GIVEN) : s === 1 ? `${pick(GIVEN)}.${pick(FAMILY)}` : `${pick(GIVEN)}${String(1 + Math.floor(rnd() * 99)).padStart(2, "0")}`;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** "g2c2" → [{letter,count}]；格式不對、含 y、總數超過上限都回錯誤訊息 */
export function parseSpec(spec: unknown): { parts: { letter: keyof typeof ACCOUNTS; count: number }[] } | { error: string } {
  if (typeof spec !== "string" || !/^([a-z]\d+)+$/.test(spec)) return { error: "spec 要像 g4、g2c2" };
  const parts: { letter: keyof typeof ACCOUNTS; count: number }[] = [];
  for (const m of spec.matchAll(/([a-z])(\d+)/g)) {
    if (m[1] === "y") return { error: "yooliang 留給開發，驗證 VM 不能用" };
    if (!(m[1] in ACCOUNTS)) return { error: `帳號字母只收 g（gsit）、c（cwen），不認得 ${m[1]}` };
    parts.push({ letter: m[1] as keyof typeof ACCOUNTS, count: Number(m[2]) });
  }
  const total = parts.reduce((a, p) => a + p.count, 0);
  if (total < 1) return { error: "至少要一隻代理" };
  if (total > MAX_AGENTS) return { error: `一台最多 ${MAX_AGENTS} 隻` };
  return { parts };
}

const md = (inst: Instance, key: string) => inst.metadata?.items?.find((i) => i.key === key)?.value;

export function parseAgents(agents: string | undefined) {
  return (agents ?? "").split("|").filter(Boolean).map((spec) => {
    const m = spec.match(/^([a-z0-9]+):([^=]+)=([^#]+)/);
    return m ? { account: PROVIDER_ACCOUNT[m[1]] ?? m[1], provider: m[1], name: m[3] } : null;
  }).filter((x): x is { account: string; provider: string; name: string } => x !== null);
}

export function summarize(key: VmKey, inst: Instance, serial: string) {
  const running = inst.status === "RUNNING";
  const hours = Number(md(inst, "run-hours")) || null;
  const started = running && inst.lastStartTimestamp ? new Date(inst.lastStartTimestamp) : null;
  const site = md(inst, "site");
  return {
    key,
    name: VMS[key].name,
    region: VMS[key].region,
    status: inst.status,
    site: site === "jp" ? "jp" : site === "tw" ? "tw" : null,
    hours,
    agents: parseAgents(md(inst, "agents")),
    started_at: started ? started.toISOString() : null,
    ends_at: started && hours ? new Date(started.getTime() + hours * 3600_000).toISOString() : null,
    agents_started: running ? (serial.match(/=== AGENT-START /g) ?? []).length : 0,
  };
}

function bearerOf(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

export async function handleConsoleVm(req: Request, deps: ConsoleVmDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  const token = bearerOf(req.headers);
  if (!token) return json({ success: false, error: "缺少 Authorization: Bearer <Firebase ID token>" }, 401);
  const verified = await (deps.verifyToken ?? verifyFirebaseIdToken)(token, { projectId: deps.projectId });
  if (!verified.ok) return json({ success: false, error: `驗證失敗：${verified.reason}` }, verified.reason === "jwks_unavailable" ? 503 : 401);
  if (!isConsoleOwner(verified.claims, deps.ownerEmail)) return json({ success: false, error: "此帳號沒有權限" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "body 不是合法的 JSON" }, 400);
  }
  const gce = deps.gce;
  if (!gce) return json({ success: false, error: "VM 金鑰尚未設定（CONSOLE_VM_SA_KEY）" }, 500);
  const rnd = deps.random ?? Math.random;

  try {
    if (body.action === "status") {
      const vms = await Promise.all(VM_KEYS.map(async (k) => {
        const { name, zone } = VMS[k];
        const inst = await gce.get(name, zone);
        const serial = inst.status === "RUNNING" ? await gce.serial(name, zone).catch(() => "") : "";
        return summarize(k, inst, serial);
      }));
      return json({ success: true, vms });
    }

    if (body.action === "stop") {
      const k = body.vm as VmKey;
      if (!VM_KEYS.includes(k)) return json({ success: false, error: "vm 只能是 us／tw／jp" }, 400);
      await gce.stop(VMS[k].name, VMS[k].zone);
      return json({ success: true });
    }

    if (body.action === "start") {
      const site = body.site;
      if (site !== "tw" && site !== "jp") return json({ success: false, error: "site 只能是 tw 或 jp" }, 400);
      const hours = body.hours ?? 1;
      if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > MAX_HOURS) return json({ success: false, error: `hours 要是 1～${MAX_HOURS} 的整數` }, 400);
      const parsed = parseSpec(body.spec);
      if ("error" in parsed) return json({ success: false, error: parsed.error }, 400);

      let k: VmKey;
      let inst: Instance;
      if (body.vm !== undefined && body.vm !== null && body.vm !== "") {
        if (!VM_KEYS.includes(body.vm as VmKey)) return json({ success: false, error: "vm 只能是 us／tw／jp" }, 400);
        k = body.vm as VmKey;
        inst = await gce.get(VMS[k].name, VMS[k].zone);
        if (inst.status !== "TERMINATED") return json({ success: false, error: `${VMS[k].region}那台還在跑（${inst.status}），等它關機再開` }, 409);
      } else {
        const order = [...VM_KEYS].sort(() => rnd() - 0.5);
        const found = await (async () => {
          for (const key of order) {
            const i = await gce.get(VMS[key].name, VMS[key].zone);
            if (i.status === "TERMINATED") return { key, i };
          }
          return null;
        })();
        if (!found) return json({ success: false, error: "三台都在跑，沒有關著的可以開" }, 409);
        k = found.key;
        inst = found.i;
      }

      const total = parsed.parts.reduce((a, p) => a + p.count, 0);
      const names = genNames(total, rnd);
      const specs: string[] = [];
      let n = 0;
      for (const p of parsed.parts) for (let i = 0; i < p.count; i++) specs.push(`${ACCOUNTS[p.letter].provider}:${MODEL}=${names[n++]}#fresh`);
      const agents = specs.join("|");

      // setMetadata 是整份取代：保留原本所有鍵（startup-script、secret-project…），只覆寫這四個
      const set: Record<string, string> = { "run-hours": String(hours), "verify-only": "0", site, agents };
      const items = (inst.metadata?.items ?? []).filter((i) => !(i.key in set)).concat(Object.entries(set).map(([key, value]) => ({ key, value })));
      await gce.setMetadata(VMS[k].name, VMS[k].zone, inst.metadata?.fingerprint, items);
      await gce.start(VMS[k].name, VMS[k].zone);
      return json({ success: true, vm: { key: k, name: VMS[k].name }, agents: parseAgents(agents) });
    }

    return json({ success: false, error: "action 只能是 status／start／stop" }, 400);
  } catch (e) {
    return json({ success: false, error: errorMessage(e) }, 502);
  }
}
