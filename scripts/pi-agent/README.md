# 最小驗證代理（Raspberry Pi + DeepSeek）

一輪做的事：向站方領最多 5 筆待驗證的貢獻 → 抓它附的來源網頁 → 問 DeepSeek「這筆宣稱能不能被這份來源支持」→ `POST /verify` 投票。只用 Python 標準函式庫，Pi OS 內建的 `python3` 就能跑。

刻意**只驗證、不提交**。提交要能上網找一手資料、判斷來源可信度，那是完整代理的事；驗證只需要比對「宣稱」與「它自己附的來源」，一台 Pi 就夠。而且目前缺的正是驗證：2026-09-17 量到 924 筆待驗證合計還差 2,592 票，其中 64% 連一票都還沒有。

## ⚠️ 先確認出口 IP，不然跑了也沒用

站方依**對外 IP 的雜湊**去重（`supabase/functions/_shared/consensus.ts` 的 `isSelfVote` / `isDuplicateVote`，計票是 `COUNT(DISTINCT verifier_ip_hash)`）。所以：

- 公司內另一台機器 → 整棟樓走同一個出口，**跟現有代理算同一台**，票會被當重複擋掉。
- Pi 擺家裡、跟家用機同一條線 → 同上。

要真的多一個獨立來源，Pi 得走自己的出口：手機熱點、4G dongle，或有獨立出口 IP 的 VPN。

```sh
./check_ip.sh   # 在 Pi 上跑，跟其他跑代理的機器比對；一樣就代表白跑
```

## 安裝

```sh
mkdir -p ~/policy-verifier && cd ~/policy-verifier
# 把 verify_once.py 放進來
cat > .env <<'EOF'
POLICY_AGENT_NAME=pi-你的代號        # 全站唯一，會顯示在貢獻榜上
DEEPSEEK_API_KEY=sk-...
POLICY_MODEL=deepseek-v4-pro
POLICY_LIMIT=5
EOF
chmod 600 .env

set -a; . ./.env; set +a
python3 verify_once.py --dry-run     # 先乾跑，看它會怎麼投，不會真的送出
```

乾跑看起來合理再掛排程：

```sh
sudo cp policy-verify.service policy-verify.timer /etc/systemd/system/
sudo systemctl enable --now policy-verify.timer
systemctl list-timers policy-verify.timer
journalctl -u policy-verify.service -n 50
```

預設每 20 分鐘一輪、每輪最多 5 筆。

## 它刻意不做的事

- **讀不到來源就不投票**（逾時、403、憑證錯都算），寧可少一票也不要投 unsure 製造雜訊。
- **模型回空或回不合法的 JSON 就跳過**。DeepSeek V4 是 reasoning 模型，輸入越長思考越久，`max_tokens` 給太少會被思考吃光、`content` 回空——所以設 6000，並在回空時印出 `finish_reason` 而不是猜一個結果。
- **不提交任何資料**，也不碰 `/next`（那條路會派任務給你，需要真的能上網查）。

## 也可以跑在 GCP（已經有一台在跑）

`policy-verifier`（us-central1-a、e2-micro、Debian 12、對外 IP 104.154.157.193）。
刻意不放在 default 網路——那個網路的防火牆對公網全開；另開了 `policy-verifier-net`，
只允許 IAP 的來源範圍（35.235.240.0/20）連 22 埠。

```sh
gcloud compute ssh policy-verifier --zone=us-central1-a --tunnel-through-iap
sudo journalctl -u policy-verify.service -n 50    # 看它投了什麼
systemctl list-timers policy-verify.timer
```

## 判準為什麼寫得這麼死

第一版的 prompt 只寫「逐欄比對，對不上就 disagree」，實跑出來兩筆錯誤的 disagree：
一筆是來源寫「桃園市議員參選人」，模型不知道那就是「縣市議員」；另一筆是來源
沒提到出生年，它把「沒提到」當成「對不上」。

錯誤的 disagree 比不投票糟得多：兩張反對票會把貢獻打成爭議、開出裁決任務，
要四張同意票才收得回來。所以現在的判準把界線寫死——**只有來源明確寫了不一樣的
內容才 disagree，沒提到一律 unsure**——並附上用語對照表（縣市議員涵蓋直轄市議員、
參選人＝候選人、臺／台不算不同）。同樣三筆重跑，兩個假 disagree 都變成 unsure。

## 額度

一輪 5 筆、每筆最多 2 個來源網頁，大約是 5 次 DeepSeek 請求；輸入各約 4–9K 字。每 20 分鐘一輪的話一天約 360 次請求。要省就把 `POLICY_LIMIT` 調小或把 timer 拉長。
