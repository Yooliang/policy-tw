# 驗證 VM 腳本（policy-verifier）

一台 GCP VM（`policy-verifier`，us-central1-a）專門跑驗證代理：開機 → 起幾隻代理 → 跑 `run-hours` 小時 → 自己關機。
設定都放在 VM metadata，改設定不用 SSH。交接背景看 `docs/handoff/2026-10-05-P-工作機-to-P-主線4.md` 第四節。

| 檔案 | 做什麼 |
|---|---|
| `boot-agent.sh` | VM 的 startup-script（已部署在 metadata `startup-script`）。讀 metadata、起代理、關機 |
| `tick.sh` → `plan_round.py` | 取各帳號週額度、依步調決定這一輪每個帳號放幾隻，寫出 `agents.txt`、`decision.txt` |
| `restart_verify.sh` | 等 VM 關機後，用 `decision.txt` 的 agents 開下一輪 |
| `vreport.sh` | 一次讀出進度與額度（不印序號） |
| `q_ascii.py` | 在 Aegis 上跑，吐出各帳號額度（純 ASCII） |
| `quota_local.py` | 本機登入帳號的即時額度 |
| `gen_names.py` | 產代號 |
| `burn.txt` | 要強制燒的帳號（選用，格式見 `plan_round.py` 開頭） |

## 帳號對照

| 額度帳號（plan_round） | provider | Claude token 的 metadata 鍵 | DiTrust 序號的 metadata 鍵 |
|---|---|---|---|
| `gsit` | `claude` | `claude-token` | `ditrust-serial`／`ditrust-serial-2` 輪替 |
| `cwen` | `claude2` | `cwen-token` | 同上 |
| `acct3` | `claude3` | `claude3-token` | `ditrust-serial-3`（沒設就退回上一列的輪替） |

每個代理的格式：`<provider>:<model>=<代號>#fresh`，多隻用 `|` 接起來放在 metadata `agents`。

**代理身分序號怎麼分配**（`boot-agent.sh` 的 `write_cprompt`）

1. `claude3` 的代理：有 `ditrust-serial-3` 就一律用它。
2. 其餘代理（`claude`、`claude2`，以及沒設 `-3` 的 `claude3`）：各自編號，單數用 `ditrust-serial`、雙數用 `ditrust-serial-2`；沒設 `-2` 就全用第一組。
3. 序號都沒設：用匿名代號，額度按來源 IP 算。

走第 1 條的代理不佔輪替編號，所以有沒有第三組，都不會改變前兩組原本的輪替。
一個 DiTrust 帳號的提交與驗證額度（600／2400）是各算各的，第三個 Claude 帳號配第三個 DiTrust 帳號，才不會跟前兩組搶同一份額度。

## 加一個 Claude 帳號（以第三個、`claude3` 為例）

🔴 全程不要把 token 或序號貼到聊天、commit、檔案或終端機輸出。下面都用「靜音輸入 → 暫存檔 → 寫進 metadata → 刪暫存檔」。
也不要對 VM 跑不帶 `--format` 的 `describe`：它會把整份 metadata（含所有 token）印出來。要確認有沒有設，只列鍵名（見第 4 步）。

### 1. 取得 Claude 帳號的 token

在已經登入**新帳號**的那台機器上：

```bash
claude setup-token
```

照畫面完成授權，它會印出一串 `sk-ant-oat…`。**只在那個終端機畫面上看，不要複製到聊天或檔案**。

### 2. 寫進 VM metadata

在能連到 GCP 的機器上（Git Bash 或任何 bash）。`read -rs` 是靜音輸入，貼上時畫面不會顯示：

```bash
TMP=$(mktemp); chmod 600 "$TMP"
read -rsp "貼上 token 後按 Enter：" T; echo
printf '%s' "$T" > "$TMP"; unset T
gcloud compute instances add-metadata policy-verifier --zone us-central1-a \
  --metadata-from-file claude3-token="$TMP"
rm -f "$TMP"
```

寫 metadata 不會開機、不會動到其他設定；VM 在關機狀態也能寫。

### 3. 申請這個帳號的代理身分序號（DiTrust）

序號由 DiTrust 發，正見只是通道，**正見不存序號**（設計見 `docs/BLUEPRINT-agent-identity.md` §4）：

1. 用要擁有這個代理身分的 Google 帳號登入正見網站（https://正見.tw 或 https://policy-tw.web.app）。
   一個信箱只會對到一個 DiTrust 帳號，所以第三組要用**不同於前兩組**的信箱，否則拿到的是同一個序號。
2. 登入後前端會自動呼叫 `ditrust-agent`（`supabase/functions/ditrust-agent/index.ts`）的 `link`，它在伺服器端用 session 裡的信箱呼叫 DiTrust 的 `agents-provision`。
   **第一次會開戶，序號只在這一次直接顯示**；之後要看，到「個人頁」的「代理序號」區塊按「顯示序號」（`reveal`）。
3. 🔴 不要按「重新產生序號」（`rotate`）：舊序號會立刻失效，正在跑的代理會全部 401。
4. 序號是 64 位十六進位字元。**metadata 只放這 64 個字元，不要帶 `ditrust:` 前綴**（個人頁的「複製」鈕複製的是帶前綴的，貼進來前要刪掉；`boot-agent.sh` 會用 `^[0-9a-f]{64}$` 檢查，不合就當沒設）。

寫進 metadata，同樣靜音輸入：

```bash
TMP=$(mktemp); chmod 600 "$TMP"
read -rsp "貼上序號（64 字元、不含 ditrust:）後按 Enter：" T; echo
printf '%s' "$T" > "$TMP"; unset T
gcloud compute instances add-metadata policy-verifier --zone us-central1-a \
  --metadata-from-file ditrust-serial-3="$TMP"
rm -f "$TMP"
```

### 4. 確認鍵名都在（只列鍵名，不印值）

```bash
gcloud compute instances describe policy-verifier --zone us-central1-a \
  --format='value(metadata.items[].key)' | tr ';' '\n' | grep -E '^(claude3-token|ditrust-serial-3)$'
```

兩個都要出現。`tick.sh` 也是用同樣的方式查 `claude3-token` 這個鍵：**沒有這個鍵就不會派 acct3**。

### 5. 部署新版 `boot-agent.sh`（要 PR 合進 main 之後）

`claude3` 這個 provider 是新版腳本才認得的。在工作樹是 CRLF 的機器（Windows）上，**不要直接上傳工作樹那份**——CRLF 會讓腳本在 Linux 一開機就死、log 空白。從 git 取 LF 版：

```bash
TMP=$(mktemp); git show origin/main:scripts/verify-vm/boot-agent.sh > "$TMP"
gcloud compute instances add-metadata policy-verifier --zone us-central1-a \
  --metadata-from-file startup-script="$TMP"
rm -f "$TMP"
```

### 6. 開一輪驗證

下一輪 `restart_verify.sh`（或 `bash tick.sh` 後手動組 agents）就會出現 `claude3:claude-sonnet-5=<代號>#fresh` 兩隻。
開機後看序列埠：應該有兩筆 `AGENT-START ... provider=claude3`。
如果看到 `AGENT-SKIP-SPEC 缺 claude3-token`，是第 2 步沒寫成功。

### 7.（選用）讓額度走 Aegis

Aegis 目前沒有第三個帳號的額度，所以 `plan_round.py` 對 `acct3` 的做法是：**額度未知、照固定 2 隻**（decision 裡會寫明），不做步調判斷。
之後帳號登錄到 Aegis，就在 `q_ascii.py` 的 `ACCT3_HINTS` 加上它在 Aegis 的名稱特徵（小寫子字串）；沒加之前，它會落到後備的 `cwen`。加了之後 `acct3` 就改按步調線算（落後補 2 隻、超前停）。

## 燒法

每個帳號 2 隻 Sonnet 慢慢跑滿整週。工作機實測：2 隻約 0.8～1.3 個百分點／小時；4 隻約 3.2 個百分點／小時，而且會撞到 5 小時上限。
所以 `acct3` 平常上限鎖在 2 隻（`plan_round.py` 的 `ACCT_CAP`），重置前最後 5 小時的收尾衝刺才放寬。
`gsit`、`cwen` 的上限維持原本的 4 隻，沒有動；想一併降成 2 隻，改 `MAX_PER_ACCT` 即可。

## 再加第四個帳號要改哪裡

1. `boot-agent.sh` 開頭的 `CLAUDE_TOKEN_KEY` 表加一行，例如 `[claude4]=claude4-token`。
2. `plan_round.py`：`PROVIDER` 加對照；要鎖隻數／指定 model 就加進 `ACCT_CAP`、`ACCT_MODEL`；Aegis 沒有額度列就加進 `UNKNOWN_FIXED`、`NEEDS_READY`。
3. `tick.sh`：照 `ACCT3_READY` 那段多查一個鍵。
4. `vreport.sh`、`q_ascii.py`：把新帳號名加進去。
5. 若要專屬序號，boot-agent.sh 的 `write_cprompt` 比照 `claude3` 那一條。

## 已知限制

- `plan_round.py` 需要同目錄有 `used_names.sorted`（`gen_names.py` 讀它；不在版控裡，第一次跑要先建一個空檔）。
- `tick.sh` 寫死 Aegis 的 SSH 路徑與工作機的 Python 位置，家用機用 `PY` 環境變數覆寫。

## 金鑰改放 Secret Manager（2026-10-06，過渡中）

`boot-agent.sh` 讀金鑰的順序改成：**先讀 Secret Manager，讀不到才退回 metadata**。序列埠只會記每個鍵從哪裡讀到（`=== CRED <鍵> from secret-manager|metadata|missing ===`），不記內容。

- metadata `secret-project`：放金鑰的 GCP 專案。沒設的話維持舊行為，只讀 metadata。
- Secret 名稱＝`verify-vm-<metadata 鍵>`，共 8 個：`verify-vm-claude-token`、`verify-vm-cwen-token`、`verify-vm-claude3-token`、`verify-vm-openrouter-key`、`verify-vm-ditrust-serial`、`verify-vm-ditrust-serial-2`、`verify-vm-ditrust-serial-3`。

上線前要先做三件事，都要小良哥點頭。截至 10-06 都還沒做：
1. **決定放哪個專案**：`policy-tw` 目前沒綁帳單，要放這裡得先綁；`greenshepherdcomtw` 有帳單，Secret Manager 也已啟用。
2. **給 VM 一個專用服務帳號**：只對上面那幾個 secret 有 `roles/secretmanager.secretAccessor`。現在用的預設 compute 服務帳號權限太大，scope 也不含 `cloud-platform`，讀不到 Secret Manager。VM 關機時就能換：
   `gcloud compute instances set-service-account policy-verifier --zone us-central1-a --service-account <專用帳號> --scopes cloud-platform`
3. **搬值**：從 metadata 讀出來，直接用管線寫進 secret，不落地、不印出。確認 VM 開機後序列埠每個鍵都是 `from secret-manager`，再刪掉 metadata 裡的明文。

新的 `boot-agent.sh` 要另外上傳到 VM 的 `startup-script` 才會生效。上傳前請先確認上面三件事。
