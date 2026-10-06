#!/bin/bash
# 每小時一次：取各帳號額度（gsit／cwen／acct3） → 算步調 → 寫出這一輪要跑的 agents。
#   Aegis：兩個帳號都有（各自的排程回報上去的，可能落後）
#   本機 ：目前登入那一個帳號的即時值，用 resets_at 比對去蓋掉 Aegis 的舊值
# 🔴 10-01 實際踩過兩次：
#    ① Aegis 的 gs it 停在 88%、實際 99%（回報排程指向搬走的 OneStack 舊路徑，錯誤碼 2）
#    ② quota_local.py 把帳號寫死成 gsit，但本機登入換成 cwen → 兩行都變 cwen
cd "$(dirname "$0")"
# 第三個帳號（acct3 ／ claude3）：VM metadata 有 claude3-token 這個「鍵」才派工（只列鍵名，不讀值、不印 token）。
# 查不到（gcloud 失敗）就當沒有，寧可少派。
if gcloud compute instances describe policy-verifier --zone us-central1-a --format='value(metadata.items[].key)' 2>/dev/null | tr ';' '\n' | grep -qx 'claude3-token'; then
  export ACCT3_READY=1
else
  export ACCT3_READY=0
fi
# Python：工作機是 C:/Python312，家用機用 py 啟動器找 3.12；可用 PY 環境變數覆寫
PY=${PY:-$( [ -x C:/Python312/python.exe ] && echo C:/Python312/python.exe || py -3.12 -c "import sys;print(sys.executable,end='')")}
: > quota_raw.txt
gcloud compute scp q_ascii.py aegis-tokyo:/tmp/q_ascii.py --zone asia-northeast1-a --tunnel-through-iap >/dev/null 2>&1
gcloud compute ssh aegis-tokyo --zone asia-northeast1-a --tunnel-through-iap \
  --command "sudo -u cwen0708 /home/cwen0708/onestack/aegis/venv/bin/python /tmp/q_ascii.py 2>/dev/null || sudo -u cwen0708 python3 /tmp/q_ascii.py" 2>/dev/null \
  | grep '^ACCT' >> quota_raw.txt
"$PY" quota_local.py >> quota_raw.txt 2>/dev/null
grep -q '^ACCT' quota_raw.txt || { echo "取不到任何額度，這輪不動作"; exit 1; }
"$PY" plan_round.py
