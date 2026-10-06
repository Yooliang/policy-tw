# 每小時決定「這一輪要不要跑、每個帳號放幾隻」（小良哥 09-30~10-01 定的規則）
#
# 步調規則
#   一週額度切 192 份（＝8 天×24 小時，1 份 = 0.5208%）
#   每天預留的份數逐日遞減：第 1 天 27 份(≈1/7) … 第 7 天 14 份(≈1/14)
#   當天週目標 = 100% − 預留份數×0.5208%
#   應有進度 expected = 當天週目標 × 本週已過的比例（本週起點 = resets_at − 7 天）
#   落後 → 跑；超前 → 不跑
#   收尾衝刺：重置前 FINAL_HOURS 小時，預留那份也不要浪費 → 目標 100%、隻數上限放寬
#
# 資料來源（很重要，踩過兩次）
#   Aegis：兩個帳號都有，但是各帳號自己的排程回報上去的，會停擺或落後
#   本機 ：目前登入那個帳號的即時值，用 resets_at 比對認人後蓋掉 Aegis 的舊值
#   🔴 10-01 ① Aegis 的 gs it 凍在 88%、實際 99%（回報排程指到搬走的舊路徑）
#       ② 本機那支把帳號寫死成 gsit，但登入換成 cwen → 兩行都變 cwen
import datetime, io, math, os, subprocess, sys
NL = chr(10)   # 不在字串字面值裡寫反斜線 n：工具參數會把它變成真的換行（10-02 連踩兩次）

WEEK_UNITS = 192                                     # 一週切幾份
RESERVE_UNITS = [27, 25, 23, 20, 18, 16, 14]         # 第 1~7 天各預留幾份（要調就改這一行）
                                                     # 一週只有 7 天，沒有第 8 天
                                                     # 27/192=14.1%≈1/7 … 14/192=7.3%≈1/14
PER_AGENT = 0.35             # 點/小時/隻（從 cwen 實測估的）
STALE_MIN = 12.0             # 🔴 resets_at 距現在不到這麼多分鐘（或已過）就當資料過期、不開輪。
                             #    10-01 20:01 踩過：gs it 的重置時間剛到，hours_left≈0 讓
                             #    需要速度爆成 100 點/時，直接頂到上限算出 8 隻 —— 純粹是
                             #    除以趨近零的假訊號，而且那時 Aegis 還餵著重置前的舊數字。
MAX_PER_ACCT = 4             # 平常單一帳號上限（4 隻以上派工吃不飽，實測加成打折）
FINAL_HOURS = 5.0            # 收尾衝刺的時間窗
FINAL_TARGET = 100.0
FINAL_MAX_PER_ACCT = 8
PROVIDER = {'gsit': 'claude', 'cwen': 'claude2', 'acct3': 'claude3'}
DEFAULT_MODEL = 'haiku'

# --- 第三個帳號 acct3（2026-10-06；VM 用 provider=claude3、metadata claude3-token）---
#   燒法：2 隻 Sonnet 慢慢跑滿整週。工作機實測 2 隻約 0.8~1.3 點/小時；4 隻 3.2 點/小時而且會撞 5 小時上限，
#   所以平常上限鎖 2 隻（收尾衝刺那 FINAL_HOURS 小時照舊放寬，撞上限也無所謂）。
#   步調線照舊：落後就跑 2 隻、超前就停，所以 2 隻實際上是「落後時才補上」。
#   額度來源：Aegis 有這個帳號的列就照步調算；沒有（目前就是這樣）→ 額度未知，照固定 UNKNOWN_FIXED 隻跑，
#   不做步調判斷，decision 裡會標「額度未知、照固定 2 隻」。
#   啟用開關：只有環境變數 ACCT3_READY=1 才會派（tick.sh 查 VM metadata 有沒有 claude3-token 鍵、或 Secret Manager 有沒有 verify-vm-claude3-token 後設定；
#   token 還沒放進去時不派，免得每一輪白白產生被 AGENT-SKIP-SPEC 跳過的幾隻）。
ACCT_MODEL = {'acct3': 'claude-sonnet-5'}
ACCT_CAP = {'acct3': 2}                # 平常上限；沒列的帳號吃 MAX_PER_ACCT
UNKNOWN_FIXED = {'acct3': 2}           # Aegis 沒有該帳號的列時固定開幾隻
NEEDS_READY = {'acct3': 'ACCT3_READY'} # 帳號 → 要設成 1 才啟用的環境變數

# --- burn 模式（小良哥 10-02 交辦：gs it 有一次重置機會，要在 3 天內把額度用完）---
#   burn.txt 每行：帳號|model|隻數|目標%[|換手門檻:新model]
#   例：gsit|sonnet|4|99|30:haiku
#       → 先用 sonnet，**已用達到 30% 就自動換成 haiku**（小良哥 10-02 裁示）。
#   為什麼要換：sonnet 每 agent-小時 投 18 票／交 41 筆＝0.44 票/提交，
#   但一筆要約 3 票才上線 → 它在淨灌待驗證佇列（實測 4.5 小時 +304 筆）。
#   haiku 是 31 票／9.4 筆＝3.3 票/提交，剛好收支平衡，而且每 1% 額度 score 高 40%。
#   換手寫在這裡而不是靠人記得：這一輪沒人看著也會換。
#   有這一行的帳號 **完全不看步調線**（否則一超前就被判 0 隻、衝不起來），
#   一律開到指定隻數，直到 actual >= 目標% 才停。沒有這個檔就是原本的步調行為。
burn = {}
try:
    for ln in io.open('burn.txt', encoding='utf-8'):
        f = [x.strip() for x in ln.split('|')]
        if len(f) >= 4 and f[0] and not f[0].startswith('#'):
            switch = None
            if len(f) >= 5 and ':' in f[4]:
                at, m = f[4].split(':', 1)
                switch = (float(at), m.strip())
            burn[f[0]] = (f[1], int(f[2]), float(f[3]), switch)
except OSError:
    pass

def week_target(elapsed_days):
    day = max(1, min(len(RESERVE_UNITS), int(elapsed_days) + 1))
    u = RESERVE_UNITS[day - 1]
    return 1.0 - u / float(WEEK_UNITS), u, day

now = datetime.datetime.now(datetime.UTC)
tpe = lambda t: (t + datetime.timedelta(hours=8)).strftime('%m-%d %H:%M')
iso = lambda s: datetime.datetime.fromisoformat(s).replace(tzinfo=datetime.UTC)

# --- 讀資料：Aegis 兩列 + 本機一列，本機用重置時間認人後覆蓋 ---
rows, local = {}, None
for line in io.open('quota_raw.txt', encoding='utf-8'):
    f = line.strip().split('|')
    if len(f) == 4 and f[0] == 'ACCT':
        rows[f[1]] = (float(f[2]), iso(f[3]))
    elif len(f) == 3 and f[0] == 'LOCAL':
        local = (float(f[1]), iso(f[2]))

# 🔴 比對要「對 7 天取模」：帳號重置後，本機拿到的 resets_at 會比 Aegis 那列晚整整一週，
#    直接比絕對差會配不上（10-01 20:20 踩過：本機 gs it 重置 10-08，Aegis 還寫 10-01，
#    差 7 天 → 沒配上 → 即時的 0% 沒被採用，繼續用過期的 99%）。
def week_gap(a, b):
    d = abs((a - b).total_seconds()) % 604800.0
    return min(d, 604800.0 - d)

local_for = None
if local and rows:
    acct, (_, rst) = min(rows.items(), key=lambda kv: week_gap(kv[1][1], local[1]))
    if week_gap(rst, local[1]) <= 7200:                   # 兩小時內（同一星期幾、同一時刻）視為同帳號
        rows[acct] = local                                # 即時值優先
        local_for = acct

# --- 逐帳號算步調與隻數 ---
plans, lines, switched = [], [], []
for acct in sorted(set(rows) | set(UNKNOWN_FIXED)):
    if acct in NEEDS_READY and os.environ.get(NEEDS_READY[acct]) != '1':
        plans.append((acct, 0))
        lines.append('%-5s 未啟用（VM metadata 沒有 %s 的 token）｜→ 0 隻' % (acct, PROVIDER.get(acct)))
        continue
    if acct not in rows:
        n = UNKNOWN_FIXED[acct]
        plans.append((acct, n))
        lines.append('%-5s 額度未知（Aegis 沒有這個帳號的列）｜→ %d 隻（額度未知、照固定 %d 隻；'
                     '看 VM 實際用量或到帳號的使用量頁自己盯）' % (acct, n, n))
        continue
    actual, reset = rows[acct]
    src = '本機即時' if acct == local_for else 'Aegis  '
    start = reset - datetime.timedelta(days=7)
    elapsed = (now - start).total_seconds() / 86400.0
    hours_left = max((reset - now).total_seconds() / 3600.0, 0.01)

    if (reset - now).total_seconds() <= STALE_MIN * 60:
        plans.append((acct, 0))
        lines.append('%-5s 已用 %5.1f%%｜來源 %s｜→ 0 隻（重置時間已到／將到，資料待更新，'
                     '不以此決策）' % (acct, actual, src))
        continue

    wt, res_u, day_i = week_target(elapsed)
    expected = wt * 100.0 * min(elapsed / 7.0, 1.0)
    deficit = expected - actual
    sprint = hours_left <= FINAL_HOURS
    target = FINAL_TARGET if sprint else wt * 100.0
    cap = FINAL_MAX_PER_ACCT if sprint else ACCT_CAP.get(acct, MAX_PER_ACCT)
    need_rate = max(target - actual, 0) / hours_left

    if acct in burn:
        b_model, b_n, b_target, b_switch = burn[acct]
        # 到門檻就換 model（並把 burn.txt 改掉，之後每一輪都用新的，不靠人記得）
        if b_switch and actual >= b_switch[0] and b_model != b_switch[1]:
            b_model = b_switch[1]
            burn[acct] = (b_model, b_n, b_target, None)
            switched.append('%s 已用 %.0f%% ≥ %.0f%% → model 換成 %s' % (acct, actual, b_switch[0], b_model))
        if actual >= b_target:
            n, why = 0, 'burn 模式：已達 %.0f%%，停手' % b_target
        else:
            n = b_n
            why = 'burn 模式：%s×%d，燒到 %.0f%%（還有 %.1f 點）' % (
                b_model, b_n, b_target, b_target - actual)
    elif actual >= target:
        n, why = 0, '已達目標 %.1f%%' % target
    elif sprint:
        n = min(math.ceil(need_rate / PER_AGENT), cap)
        why = '收尾衝刺：剩 %.1fh、還有 %.1f 點沒用' % (hours_left, target - actual)
    elif deficit > 0:
        n = min(max(2, math.ceil(need_rate / PER_AGENT)), cap)
        why = '落後 %.1f 點' % deficit
    elif need_rate > 2 * PER_AGENT:
        n = min(math.ceil(need_rate / PER_AGENT), cap)
        why = '雖超前，但剩 %.1fh 要用 %.1f 點 → 防浪費加速' % (hours_left, target - actual)
    else:
        n, why = 0, '超前 %.1f 點，且剩餘時間夠用' % (-deficit)

    plans.append((acct, n))
    lines.append('%-5s 已用 %5.1f%% ／應有 %5.1f%%（%+5.1f）｜第 %d 天 預留 %d/%d→週目標 %.1f%%'
                 '｜剩 %5.1f 小時、需 %.2f 點/時｜來源 %s｜→ %d 隻（%s）'
                 % (acct, actual, expected, -deficit, day_i, res_u, WEEK_UNITS,
                    wt * 100.0, hours_left, need_rate, src, n, why))

# --- 產代號、組 agents 字串 ---
total = sum(n for _, n in plans)
names = []
if total:
    names = subprocess.run([sys.executable, 'gen_names.py', str(total)],
                           capture_output=True, text=True).stdout.split()
specs, i = [], 0
for acct, n in plans:
    for _ in range(n):
        model = burn[acct][0] if acct in burn else ACCT_MODEL.get(acct, DEFAULT_MODEL)
        specs.append('%s:%s=%s#fresh' % (PROVIDER.get(acct, 'claude2'), model, names[i])); i += 1

io.open('agents.txt', 'w', encoding='utf-8').write('|'.join(specs))
# 換過手就把 burn.txt 寫回去，下一輪直接是新 model（不依賴這支有沒有被跑第二次）
if switched:
    io.open('burn.txt', 'w', encoding='utf-8').write(
        ''.join('%s|%s|%d|%g' % (a, burn[a][0], burn[a][1], burn[a][2]) + NL for a in sorted(burn)))

hdr = ('現在台北 %s ｜ 一週 %d 份、預留逐日 %d→%d 份；重置前 %.0f 小時內改衝 %.0f%%'
       % (tpe(now), WEEK_UNITS, RESERVE_UNITS[0], RESERVE_UNITS[-1], FINAL_HOURS, FINAL_TARGET))
if burn:
    BURN_LINE = ('BURN 模式：' + ('【換手】' + '；'.join(switched) + '｜' if switched else '')) + '、'.join(
        '%s=%s x%d -> %.0f%%' % (a, v[0], v[1], v[2]) for a, v in sorted(burn.items()))
else:
    BURN_LINE = None
lines.insert(0, hdr)
if BURN_LINE:
    lines.insert(1, BURN_LINE)
lines.append('')
lines.append('本輪 agents：' + ('|'.join(specs) if specs else '（不跑）'))
io.open('decision.txt', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
